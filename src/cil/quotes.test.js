// src/cil/quotes.test.js
// CreateQuote handler tests.
//
// Structure:
//   Section 1 (customer resolution): 3 integration tests against resolved DB
//   All other scenarios: it.todo placeholders until their sections land
//
// Integration strategy: each DB-hitting test uses `pool.connect()` → BEGIN →
// exercise → assertions → ROLLBACK → release. No real rows persist. Follows
// the Migration 5 verification pattern.
//
// Skip strategy: if DATABASE_URL / POSTGRES_URL / SUPABASE_DB_URL is not set
// in the environment, integration tests skip gracefully. .env is loaded via
// dotenv/config for local runs.

// Load .env for local runs; no-op if dotenv or .env is absent.
try { require('dotenv').config(); } catch (_) { /* dotenv optional at runtime */ }

const { _internals } = require('./quotes');
const { CilIntegrityError } = require('./utils');

const {
  resolveOrCreateCustomer,
  resolveOrCreateJob,
  computeTotals,
  formatHumanIdDatePart,
  allocateQuoteHumanId,
  composeCustomerSnapshot,
  composeTenantSnapshot,
  insertQuoteHeader,
  insertQuoteVersion,
  insertQuoteLineItems,
} = _internals;

const { setupQuotePreconditions, MISSION_TENANT_UUID } = require('./quotes.test.helpers');

const hasDb = Boolean(
  process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_DB_URL
);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb('handleCreateQuote — Section 1: customer resolution (integration)', () => {
  let pool;
  let tenantA;
  let tenantB;

  beforeAll(async () => {
    // Lazy require so the top of this file loads cleanly when DATABASE_URL
    // isn't set. When it IS set, the pg pool initializes here.
    const pg = require('../../services/postgres');
    pool = pg.pool || require('pg').Pool.prototype; // fall back to exported pool
    // Use a direct pool.connect to keep tests independent of withClient's
    // BEGIN/COMMIT wrapper — we want explicit BEGIN/ROLLBACK control.
    // If services/postgres doesn't export `pool`, fall through via require('pg')
    // with the same connection string.
    if (!pool || !pool.connect) {
      const { Pool } = require('pg');
      pool = new Pool({
        connectionString:
          process.env.DATABASE_URL ||
          process.env.POSTGRES_URL ||
          process.env.SUPABASE_DB_URL,
        ssl: { rejectUnauthorized: false },
      });
    }

    // Resolve two tenant UUIDs for cross-tenant testing. Use real tenants
    // if available; otherwise the tests will create throwaway rows inside
    // each test's BEGIN/ROLLBACK scope (done per-test below).
    const r = await pool.query(
      `SELECT id FROM public.chiefos_tenants ORDER BY created_at LIMIT 2`
    );
    tenantA = r.rows[0]?.id || null;
    tenantB = r.rows[1]?.id || null;
  });

  // No afterAll pool.end() — services/postgres.js exports a shared singleton
  // pool; ending it here would break subsequent describe blocks that reuse it.
  // Jest --forceExit handles process-level cleanup.

  test('Branch B: inline-only input creates a fresh customer row', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Use throwaway tenant if none existed at beforeAll.
      let tenantId = tenantA;
      if (!tenantId) {
        const { rows } = await client.query(
          `INSERT INTO public.chiefos_tenants (name) VALUES ('__TEST_T_S1B__') RETURNING id`
        );
        tenantId = rows[0].id;
      }

      const input = {
        name: 'Darlene MacDonald',
        email: 'darlene@example.com',
        phone_e164: '+14165551234',
        address: '123 Elm St, Toronto, ON',
      };

      const result = await resolveOrCreateCustomer(client, tenantId, input);

      expect(result.id).toBeDefined();
      expect(result.tenant_id).toBe(tenantId);
      expect(result.name).toBe('Darlene MacDonald');
      expect(result.email).toBe('darlene@example.com');
      expect(result.phone).toBe('+14165551234');
      expect(result.address).toBe('123 Elm St, Toronto, ON');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('Branch A: customer_id matching tenant returns existing row', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let tenantId = tenantA;
      if (!tenantId) {
        const { rows } = await client.query(
          `INSERT INTO public.chiefos_tenants (name) VALUES ('__TEST_T_S1A__') RETURNING id`
        );
        tenantId = rows[0].id;
      }

      // Seed: create a customer in tenantA.
      const seed = await client.query(
        `INSERT INTO public.customers (tenant_id, name, email)
         VALUES ($1, $2, $3)
         RETURNING id, tenant_id, name, email, phone, address`,
        [tenantId, 'Seeded Name', 'seed@example.com']
      );
      const seededId = seed.rows[0].id;

      // Branch A lookup by seeded UUID.
      const result = await resolveOrCreateCustomer(
        client,
        tenantId,
        { customer_id: seededId }
      );

      expect(result.id).toBe(seededId);
      expect(result.tenant_id).toBe(tenantId);
      expect(result.name).toBe('Seeded Name');
      expect(result.email).toBe('seed@example.com');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('Branch A: cross-tenant customer_id throws CilIntegrityError', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let tA = tenantA;
      let tB = tenantB;
      if (!tA || !tB) {
        const tAr = await client.query(
          `INSERT INTO public.chiefos_tenants (name) VALUES ('__TEST_T_A_S1X__') RETURNING id`
        );
        tA = tAr.rows[0].id;
        const tBr = await client.query(
          `INSERT INTO public.chiefos_tenants (name) VALUES ('__TEST_T_B_S1X__') RETURNING id`
        );
        tB = tBr.rows[0].id;
      }

      // Seed a customer in tenant A.
      const seed = await client.query(
        `INSERT INTO public.customers (tenant_id, name) VALUES ($1, $2) RETURNING id`,
        [tA, 'Tenant A Customer']
      );
      const seededId = seed.rows[0].id;

      // Attempt to look up the customer_id as tenant B. Expect throw.
      await expect(
        resolveOrCreateCustomer(client, tB, { customer_id: seededId })
      ).rejects.toThrow(CilIntegrityError);

      // Also verify the specific code (operator-facing diagnosis per §17.18).
      await expect(
        resolveOrCreateCustomer(client, tB, { customer_id: seededId })
      ).rejects.toMatchObject({
        code: 'CUSTOMER_NOT_FOUND_OR_CROSS_TENANT',
        hint: 'customer_id does not exist or belongs to a different tenant',
      });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 2: job resolution (integration)
// ═══════════════════════════════════════════════════════════════════════════

describeIfDb('handleCreateQuote — Section 2: job resolution (integration)', () => {
  let pool;

  beforeAll(async () => {
    const pg = require('../../services/postgres');
    pool = pg.pool || null;
    if (!pool || !pool.connect) {
      const { Pool } = require('pg');
      pool = new Pool({
        connectionString:
          process.env.DATABASE_URL ||
          process.env.POSTGRES_URL ||
          process.env.SUPABASE_DB_URL,
        ssl: { rejectUnauthorized: false },
      });
    }
  });

  // No afterAll pool.end() — services/postgres.js exports a shared singleton
  // pool; ending it here would break subsequent describe blocks that reuse it.
  // Jest --forceExit handles process-level cleanup.

  // public.jobs.owner_id has FK → public.users(user_id). Each test seeds a
  // throwaway user inside its BEGIN/ROLLBACK scope so jobs inserts don't
  // violate the FK. public.users requires user_id + created_at (NOT NULL,
  // no default); all other columns have defaults or are nullable.
  async function seedThrowawayUser(client, userId) {
    await client.query(
      `INSERT INTO public.users (user_id, created_at) VALUES ($1, NOW())`,
      [userId]
    );
  }

  test('Branch A: job_id matching owner returns existing id', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Seed a throwaway job for an arbitrary test owner.
      const ownerId = '99999990001';
      await seedThrowawayUser(client, ownerId);
      const seed = await client.query(
        `INSERT INTO public.jobs
           (owner_id, job_no, job_name, name, active, start_date, status, created_at, updated_at)
         VALUES ($1, 1, 'Test Job A', 'Test Job A', true, NOW(), 'active', NOW(), NOW())
         RETURNING id`,
        [ownerId]
      );
      const seededId = seed.rows[0].id;

      const result = await resolveOrCreateJob(client, ownerId, { job_id: seededId });
      expect(result).toBe(seededId);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('Branch A: cross-owner job_id throws CilIntegrityError (JOB_NOT_FOUND_OR_CROSS_OWNER)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const ownerA = '99999990002';
      const ownerB = '99999990003';
      await seedThrowawayUser(client, ownerA);
      await seedThrowawayUser(client, ownerB);
      const seed = await client.query(
        `INSERT INTO public.jobs
           (owner_id, job_no, job_name, name, active, start_date, status, created_at, updated_at)
         VALUES ($1, 1, 'Owner A Job', 'Owner A Job', true, NOW(), 'active', NOW(), NOW())
         RETURNING id`,
        [ownerA]
      );
      const seededId = seed.rows[0].id;

      // Lookup seededId as ownerB.
      await expect(
        resolveOrCreateJob(client, ownerB, { job_id: seededId })
      ).rejects.toThrow(CilIntegrityError);

      await expect(
        resolveOrCreateJob(client, ownerB, { job_id: seededId })
      ).rejects.toMatchObject({
        code: 'JOB_NOT_FOUND_OR_CROSS_OWNER',
        hint: 'job_id does not exist, belongs to a different owner, or is deleted',
      });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('Branch A: soft-deleted job fails closed (deleted_at filter)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const ownerId = '99999990004';
      await seedThrowawayUser(client, ownerId);
      const seed = await client.query(
        `INSERT INTO public.jobs
           (owner_id, job_no, job_name, name, active, start_date, status, created_at, updated_at, deleted_at)
         VALUES ($1, 1, 'Deleted Job', 'Deleted Job', false, NOW(), 'active', NOW(), NOW(), NOW())
         RETURNING id`,
        [ownerId]
      );
      const seededId = seed.rows[0].id;

      await expect(
        resolveOrCreateJob(client, ownerId, { job_id: seededId })
      ).rejects.toMatchObject({ code: 'JOB_NOT_FOUND_OR_CROSS_OWNER' });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('Branch B: job_name found returns existing id without creating', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const ownerId = '99999990005';
      await seedThrowawayUser(client, ownerId);
      const seed = await client.query(
        `INSERT INTO public.jobs
           (owner_id, job_no, job_name, name, active, start_date, status, created_at, updated_at)
         VALUES ($1, 42, 'Kitchen Reno', 'Kitchen Reno', true, NOW(), 'active', NOW(), NOW())
         RETURNING id`,
        [ownerId]
      );
      const seededId = seed.rows[0].id;

      // Case-insensitive match on the existing name.
      const result = await resolveOrCreateJob(client, ownerId, {
        job_name: 'kitchen reno',
        create_if_missing: true, // ignored because found
      });

      expect(result).toBe(seededId);

      // Verify no new row created.
      const count = await client.query(
        `SELECT COUNT(*)::int AS n FROM public.jobs WHERE owner_id = $1`,
        [ownerId]
      );
      expect(count.rows[0].n).toBe(1);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('Branch B: create_if_missing=true with unknown name creates new jobs row', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const ownerId = '99999990006';
      await seedThrowawayUser(client, ownerId);

      const result = await resolveOrCreateJob(client, ownerId, {
        job_name: 'Bathroom Reno',
        create_if_missing: true,
      });

      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThan(0);

      const row = await client.query(
        `SELECT id, owner_id, job_no, job_name, name, active, status, source_msg_id, deleted_at
           FROM public.jobs WHERE id = $1`,
        [result]
      );
      expect(row.rows[0]).toMatchObject({
        owner_id: ownerId,
        job_name: 'Bathroom Reno',
        name: 'Bathroom Reno',
        active: true,
        status: 'active',
        source_msg_id: null,   // §20 addendum — no source_msg_id on create
        deleted_at: null,
      });
      expect(row.rows[0].job_no).toBeGreaterThan(0);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('Branch B: job_name not found AND create_if_missing=false throws JOB_NOT_FOUND', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const ownerId = '99999990007';

      await expect(
        resolveOrCreateJob(client, ownerId, {
          job_name: 'Nonexistent Job',
          create_if_missing: false,
        })
      ).rejects.toThrow(CilIntegrityError);

      await expect(
        resolveOrCreateJob(client, ownerId, {
          job_name: 'Nonexistent Job',
          // create_if_missing omitted → falsy → same path
        })
      ).rejects.toMatchObject({
        code: 'JOB_NOT_FOUND',
        hint: 'Set create_if_missing: true on the job ref, or pass an existing job_id',
      });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 3: totals, human_id, snapshots
// ═══════════════════════════════════════════════════════════════════════════

describe('handleCreateQuote — Section 3a: computeTotals (unit)', () => {
  test('3 line items × known qty/price with 13% HST → expected server totals', () => {
    // Standalone spec: HST 13% = 1300 bps. Three typical line items.
    const lineItems = [
      { qty: 1, unit_price_cents: 250000 },   // $2500
      { qty: 2, unit_price_cents: 150050 },   // $1500.50 each → $3001
      { qty: 1.5, unit_price_cents: 800000 }, // qty fractional → $12000
    ];
    const result = computeTotals(lineItems, 1300);

    expect(result.line_totals).toEqual([
      { line_subtotal_cents: 250000, line_tax_cents: 32500 },    // 2500 × 0.13 = 325.00
      { line_subtotal_cents: 300100, line_tax_cents: 39013 },    // 3001.00 × 0.13 = 390.13
      { line_subtotal_cents: 1200000, line_tax_cents: 156000 },  // 12000 × 0.13 = 1560.00
    ]);

    expect(result.subtotal_cents).toBe(250000 + 300100 + 1200000);     // 1_750_100
    expect(result.tax_cents).toBe(32500 + 39013 + 156000);             // 227_513
    expect(result.total_cents).toBe(result.subtotal_cents + result.tax_cents); // 1_977_613
  });

  test('half-cent line tax rounds half-away-from-zero (Math.round semantics)', () => {
    // Construct a line where line_subtotal × rate lands exactly on .5 cents.
    // line_subtotal_cents=500, tax_rate_bps=1 → 500 × 1 / 10000 = 0.05 → rounds to 0.
    // line_subtotal_cents=500, tax_rate_bps=3 → 500 × 3 / 10000 = 0.15 → rounds to 0.
    // line_subtotal_cents=500, tax_rate_bps=11 → 500 × 11 / 10000 = 0.55 → rounds to 1.
    // line_subtotal_cents=50000, tax_rate_bps=1 → 50000 × 1 / 10000 = 5.0 → rounds to 5.
    // Construct a specific half-cent case: 100 * 5 / 10000 = 0.05 — rounds to 0.
    // Better demo: 10000 * 5 / 10000 = 5.0 (whole). Need something like
    // 1000 * 5 / 10000 = 0.5 → Math.round(0.5) = 1 (half-away-from-zero on positive).
    const resultWhole = computeTotals(
      [{ qty: 1, unit_price_cents: 1000 }],
      5
    );
    expect(resultWhole.line_totals[0].line_tax_cents).toBe(1); // 0.5 rounds up to 1

    // And the complement: 1000 * 4 / 10000 = 0.4 → rounds down to 0.
    const resultDown = computeTotals(
      [{ qty: 1, unit_price_cents: 1000 }],
      4
    );
    expect(resultDown.line_totals[0].line_tax_cents).toBe(0); // 0.4 rounds to 0
  });
});

describe('handleCreateQuote — Section 3b: human_id + tenant_snapshot (integration where needed)', () => {
  let pool;

  beforeAll(async () => {
    const pg = require('../../services/postgres');
    pool = pg.pool || null;
    if (!pool || !pool.connect) {
      const { Pool } = require('pg');
      pool = new Pool({
        connectionString:
          process.env.DATABASE_URL ||
          process.env.POSTGRES_URL ||
          process.env.SUPABASE_DB_URL,
        ssl: { rejectUnauthorized: false },
      });
    }
  });

  test('formatHumanIdDatePart (unit): UTC YYYY-MM-DD from ISO8601 string', () => {
    expect(formatHumanIdDatePart('2026-04-19T12:00:00.000Z')).toBe('2026-04-19');
    expect(formatHumanIdDatePart('2026-01-01T00:00:00.000Z')).toBe('2026-01-01');
    // 23:59 local edge case (user in America/Toronto submits at 23:59 EDT):
    // 2026-04-19T23:59:00-04:00 === 2026-04-20T03:59:00Z → date part is "2026-04-20" in UTC
    expect(formatHumanIdDatePart('2026-04-19T23:59:00-04:00')).toBe('2026-04-20');
  });

  const describeIfDb = hasDb ? describe : describe.skip;
  describeIfDb('human_id allocation (integration against live counter)', () => {
    test('allocateQuoteHumanId: format QT-YYYY-MM-DD-NNNN with 4-digit padding', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const id1 = await allocateQuoteHumanId(
          client,
          MISSION_TENANT_UUID,
          '2026-04-19T12:00:00.000Z'
        );
        expect(id1).toMatch(/^QT-2026-04-19-\d{4}$/);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });

    test('allocateQuoteHumanId: second allocation for same tenant yields next sequence number', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const id1 = await allocateQuoteHumanId(client, MISSION_TENANT_UUID, '2026-04-19T12:00:00Z');
        const id2 = await allocateQuoteHumanId(client, MISSION_TENANT_UUID, '2026-04-19T12:00:00Z');
        const seq1 = Number(id1.slice(-4));
        const seq2 = Number(id2.slice(-4));
        expect(seq2).toBe(seq1 + 1);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });
  });
});

describe('handleCreateQuote — Section 3c: snapshots (unit)', () => {
  test('composeCustomerSnapshot: DB `phone` column renamed to `phone_e164` snapshot key', () => {
    const dbRow = {
      id: 'ignored-uuid',
      tenant_id: 'ignored-tenant-uuid',
      name: 'Darlene MacDonald',
      email: 'darlene@example.com',
      phone: '+14165551234',     // DB column name
      address: '119 St Lawrence Ave, Komoka, ON',
    };
    const snap = composeCustomerSnapshot(dbRow);
    expect(snap).toEqual({
      name: 'Darlene MacDonald',
      email: 'darlene@example.com',
      phone_e164: '+14165551234',   // snapshot key name
      address: '119 St Lawrence Ave, Komoka, ON',
    });
    // Ensure DB identity columns absent from snapshot
    expect(snap.id).toBeUndefined();
    expect(snap.tenant_id).toBeUndefined();
    // Ensure source column `phone` is not carried through
    expect(snap.phone).toBeUndefined();
  });

  test('composeTenantSnapshot: Mission Exteriors profile populates TenantSnapshotZ correctly', () => {
    const snap = composeTenantSnapshot(MISSION_TENANT_UUID);
    expect(snap).toEqual({
      legal_name: '9839429 Canada Inc.',
      brand_name: 'Mission Exteriors',
      address: '1556 Medway Park Dr, London, ON, N6G 0X5',
      phone_e164: '+18449590109',
      email: 'scott@missionexteriors.ca',
      web: 'missionexteriors.ca',
      hst_registration: '759884893RT0001',
    });
  });

  test('composeTenantSnapshot: missing profile throws CilIntegrityError with TENANT_PROFILE_MISSING code', () => {
    const unknownUuid = '00000000-0000-0000-0000-000000000000';
    expect(() => composeTenantSnapshot(unknownUuid)).toThrow(CilIntegrityError);
    try {
      composeTenantSnapshot(unknownUuid);
    } catch (e) {
      expect(e.code).toBe('TENANT_PROFILE_MISSING');
      expect(e.message).toBe('Tenant profile not configured');
      expect(e.hint).toContain(unknownUuid);
      expect(e.hint).toContain('tenantProfiles.js');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 4: header + version + line-items INSERTs (integration)
// ═══════════════════════════════════════════════════════════════════════════

describeIfDb('handleCreateQuote — Section 4: INSERT chain (integration)', () => {
  let pool;

  beforeAll(async () => {
    const pg = require('../../services/postgres');
    pool = pg.pool || null;
    if (!pool || !pool.connect) {
      const { Pool } = require('pg');
      pool = new Pool({
        connectionString:
          process.env.DATABASE_URL ||
          process.env.POSTGRES_URL ||
          process.env.SUPABASE_DB_URL,
        ssl: { rejectUnauthorized: false },
      });
    }
  });

  test('Header INSERT: creates chiefos_quotes row with current_version_id=NULL, status=draft', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);

      const header = await insertQuoteHeader(client, {
        tenantId: pre.tenantId,
        ownerId: pre.ownerId,
        jobId: pre.jobId,
        customerId: pre.customer.id,
        humanId: pre.humanId,
        source: 'whatsapp',
        sourceMsgId: pre.sourceMsgId,
      });

      expect(header.id).toBeDefined();
      expect(header.created_at).toBeDefined();

      const row = await client.query(
        `SELECT tenant_id, owner_id, job_id, customer_id, human_id, status,
                current_version_id, source, source_msg_id
           FROM public.chiefos_quotes WHERE id = $1`,
        [header.id]
      );
      expect(row.rows[0]).toMatchObject({
        tenant_id: pre.tenantId,
        owner_id: pre.ownerId,
        job_id: pre.jobId,
        customer_id: pre.customer.id,
        human_id: pre.humanId,
        status: 'draft',
        current_version_id: null,           // §17.14 step 1
        source: 'whatsapp',
        source_msg_id: pre.sourceMsgId,
      });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('Version INSERT: creates v1 draft with composite FK to header; totals + snapshots populated', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);

      const header = await insertQuoteHeader(client, {
        tenantId: pre.tenantId, ownerId: pre.ownerId,
        jobId: pre.jobId, customerId: pre.customer.id,
        humanId: pre.humanId, source: 'whatsapp', sourceMsgId: pre.sourceMsgId,
      });

      const data = {
        project: { title: 'Test Project', scope: 'Test scope paragraph.' },
        currency: 'CAD',
        deposit_cents: 50000,
        tax_code: 'HST-ON',
        tax_rate_bps: 1300,
        warranty_snapshot: { coverage: 'lifetime' },
        clauses_snapshot: { terms: 'standard' },
        payment_terms: { etransfer: 'scott@example.com' },
        warranty_template_ref: null,
        clauses_template_ref: null,
      };
      const totals = { subtotal_cents: 100000, tax_cents: 13000, total_cents: 113000 };
      const customerSnapshot = { name: pre.customer.name, email: pre.customer.email };
      const tenantSnapshot = composeTenantSnapshot(pre.tenantId);

      const version = await insertQuoteVersion(client, {
        quoteId: header.id, tenantId: pre.tenantId, ownerId: pre.ownerId,
        data, totals, customerSnapshot, tenantSnapshot,
      });

      expect(version.id).toBeDefined();
      expect(version.created_at).toBeDefined();

      const row = await client.query(
        `SELECT quote_id, tenant_id, owner_id, version_no, status,
                project_title, project_scope, currency,
                subtotal_cents, tax_cents, total_cents, deposit_cents,
                tax_code, tax_rate_bps,
                customer_snapshot, tenant_snapshot, warranty_snapshot,
                clauses_snapshot, payment_terms,
                locked_at, server_hash
           FROM public.chiefos_quote_versions WHERE id = $1`,
        [version.id]
      );
      const v = row.rows[0];
      expect(v.quote_id).toBe(header.id);
      expect(v.tenant_id).toBe(pre.tenantId);
      expect(v.owner_id).toBe(pre.ownerId);
      expect(v.version_no).toBe(1);
      expect(v.status).toBe('draft');
      expect(v.project_title).toBe('Test Project');
      expect(v.currency).toBe('CAD');
      expect(Number(v.subtotal_cents)).toBe(100000);
      expect(Number(v.tax_cents)).toBe(13000);
      expect(Number(v.total_cents)).toBe(113000);
      expect(Number(v.tax_rate_bps)).toBe(1300);
      expect(v.customer_snapshot).toEqual(customerSnapshot);
      expect(v.tenant_snapshot).toEqual(tenantSnapshot);
      expect(v.warranty_snapshot).toEqual({ coverage: 'lifetime' });
      expect(v.clauses_snapshot).toEqual({ terms: 'standard' });
      expect(v.payment_terms).toEqual({ etransfer: 'scott@example.com' });
      expect(v.locked_at).toBeNull();
      expect(v.server_hash).toBeNull();
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('Line items INSERT: N rows in insertion order with per-line totals from Section 3', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);

      const header = await insertQuoteHeader(client, {
        tenantId: pre.tenantId, ownerId: pre.ownerId,
        jobId: pre.jobId, customerId: pre.customer.id,
        humanId: pre.humanId, source: 'whatsapp', sourceMsgId: pre.sourceMsgId,
      });

      const lineItems = [
        { sort_order: 0, description: 'Labor', category: 'labour', qty: 10, unit_price_cents: 5000 },
        { sort_order: 1, description: 'Materials', category: 'materials', qty: 1, unit_price_cents: 200000 },
        { sort_order: 2, description: 'Other', qty: 1, unit_price_cents: 15000 },
      ];
      const totals = computeTotals(lineItems, 1300);

      const version = await insertQuoteVersion(client, {
        quoteId: header.id, tenantId: pre.tenantId, ownerId: pre.ownerId,
        data: {
          project: { title: 'T', scope: null },
          currency: 'CAD', deposit_cents: 0, tax_code: null, tax_rate_bps: 1300,
          warranty_snapshot: {}, clauses_snapshot: {}, payment_terms: {},
          warranty_template_ref: null, clauses_template_ref: null,
        },
        totals,
        customerSnapshot: { name: 'T' },
        tenantSnapshot: composeTenantSnapshot(pre.tenantId),
      });

      await insertQuoteLineItems(client, {
        versionId: version.id, tenantId: pre.tenantId, ownerId: pre.ownerId,
        lineItems, lineTotals: totals.line_totals,
      });

      const rows = await client.query(
        `SELECT sort_order, description, category,
                qty::text AS qty, unit_price_cents, line_subtotal_cents, line_tax_cents
           FROM public.chiefos_quote_line_items
          WHERE quote_version_id = $1
          ORDER BY sort_order ASC`,
        [version.id]
      );
      expect(rows.rows).toHaveLength(3);
      expect(rows.rows[0]).toMatchObject({
        sort_order: 0, description: 'Labor', category: 'labour',
        unit_price_cents: '5000', line_subtotal_cents: '50000', line_tax_cents: '6500',
      });
      expect(rows.rows[1]).toMatchObject({
        sort_order: 1, description: 'Materials', category: 'materials',
        unit_price_cents: '200000', line_subtotal_cents: '200000', line_tax_cents: '26000',
      });
      expect(rows.rows[2]).toMatchObject({
        sort_order: 2, description: 'Other', category: null,
        unit_price_cents: '15000', line_subtotal_cents: '15000', line_tax_cents: '1950',
      });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('Header INSERT on retry (duplicate source_msg_id): throws unique_violation on chiefos_quotes_source_msg_unique', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);

      // First insert succeeds.
      await insertQuoteHeader(client, {
        tenantId: pre.tenantId, ownerId: pre.ownerId,
        jobId: pre.jobId, customerId: pre.customer.id,
        humanId: pre.humanId, source: 'whatsapp', sourceMsgId: pre.sourceMsgId,
      });

      // Second insert with same (owner_id, source_msg_id) must hit
      // chiefos_quotes_source_msg_unique.
      //
      // SAVEPOINT so the second INSERT's unique_violation doesn't kill our
      // outer transaction; the test wants to inspect the error shape after.
      await client.query('SAVEPOINT sp_retry');
      let caught = null;
      try {
        // Allocate a fresh human_id for the retry (the original is taken).
        // Retry reuses source_msg_id — that's the idempotency signal.
        const pg = require('../../services/postgres');
        const seq = await pg.allocateNextDocCounter(pre.tenantId, 'quote', client);
        const retryHumanId = `QT-2026-04-19-${String(seq).padStart(4, '0')}`;
        await insertQuoteHeader(client, {
          tenantId: pre.tenantId, ownerId: pre.ownerId,
          jobId: pre.jobId, customerId: pre.customer.id,
          humanId: retryHumanId, source: 'whatsapp', sourceMsgId: pre.sourceMsgId,
        });
      } catch (err) {
        caught = err;
      }
      await client.query('ROLLBACK TO SAVEPOINT sp_retry');

      expect(caught).not.toBeNull();
      expect(caught.code).toBe('23505');
      expect(caught.constraint).toBe('chiefos_quotes_source_msg_unique');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('Transaction rollback on line-items INSERT failure: no orphan header, version, or line-items', async () => {
    // Use withClient — the real atomicity boundary. Force failure in line
    // items; verify from a fresh query that no rows persisted.
    const pg = require('../../services/postgres');
    const uniqueMarker = `test-rollback-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    let threw = false;
    try {
      await pg.withClient(async (client) => {
        const pre = await setupQuotePreconditions(client);
        const header = await insertQuoteHeader(client, {
          tenantId: pre.tenantId, ownerId: pre.ownerId,
          jobId: pre.jobId, customerId: pre.customer.id,
          humanId: pre.humanId, source: 'whatsapp', sourceMsgId: uniqueMarker,
        });
        const version = await insertQuoteVersion(client, {
          quoteId: header.id, tenantId: pre.tenantId, ownerId: pre.ownerId,
          data: {
            project: { title: 'T', scope: null },
            currency: 'CAD', deposit_cents: 0, tax_code: null, tax_rate_bps: 1300,
            warranty_snapshot: {}, clauses_snapshot: {}, payment_terms: {},
            warranty_template_ref: null, clauses_template_ref: null,
          },
          totals: { subtotal_cents: 1000, tax_cents: 130, total_cents: 1130 },
          customerSnapshot: { name: 'T' },
          tenantSnapshot: composeTenantSnapshot(pre.tenantId),
        });
        // Force line-items failure via a CHECK violation on line_subtotal_cents (must be >= 0).
        await insertQuoteLineItems(client, {
          versionId: version.id, tenantId: pre.tenantId, ownerId: pre.ownerId,
          lineItems: [{ sort_order: 0, description: 'Bad', qty: 1, unit_price_cents: 100 }],
          lineTotals: [{ line_subtotal_cents: -1, line_tax_cents: 0 }], // violates CHECK
        });
      });
    } catch (_) {
      threw = true;
    }
    expect(threw).toBe(true);

    // From a fresh query, confirm no orphan header for our unique marker.
    const q = await pg.query(
      `SELECT id FROM public.chiefos_quotes WHERE source_msg_id = $1`,
      [uniqueMarker]
    );
    expect(q.rows).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Remaining scenarios from session brief — todos until their sections land.
// ═══════════════════════════════════════════════════════════════════════════

describe('handleCreateQuote — remaining coverage (todos)', () => {

  // Section 5 (pointer UPDATE) + Section 6 (events) + Section 7 (happy path)
  it.todo('Happy path: header + v1 + line items + 2 events emitted; return shape matches §17.15');
  // Transaction rollback is covered by Section 4's fifth test (line-items
  // INSERT failure → no orphan rows). Additional rollback scenarios covered
  // by Section 5/6/7 tests will land with those sections.

  // Section 6 (events)
  // Events are covered inline in the happy path assertion — no standalone todo.

  // Section 7 (catch branches + counter + return)
  it.todo('Idempotent retry: same source_msg_id returns prior quote with meta.already_existed:true; counter not double-incremented');

  // Plan gating + actor gating (already wired in handler but tested end-to-end)
  it.todo('Plan gating rejection (Free tier): QUOTES_REQUIRES_STARTER envelope, no DB writes, no counter burn');
  it.todo('Plan gating rejection (capacity reached): QUOTES_CAPACITY_REACHED envelope, no DB writes');
  it.todo('Actor role rejection (employee): PERMISSION_DENIED envelope, no DB writes');

  // Zod rejection cases
  it.todo('Zod rejection: missing tax_rate_bps → CIL_SCHEMA_INVALID envelope');
  it.todo('Zod rejection: empty line_items → schema rejection per §20 Q3');
  it.todo('Zod rejection: customer missing both customer_id and inline fields → schema rejection per §20 Q1 refine');
});
