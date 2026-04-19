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

const { handleCreateQuote, _internals } = require('./quotes');
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
  setQuoteCurrentVersion,
  emitLifecycleCreated,
  emitLifecycleVersionCreated,
} = _internals;

const {
  setupQuotePreconditions,
  seedThrowawayUser,
  seedThrowawayCustomer,
  seedThrowawayJob,
  MISSION_TENANT_UUID,
  FOREST_CITY_TENANT_UUID,
} = require('./quotes.test.helpers');

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
// Section 5: current_version_id UPDATE pointer swing (integration)
// ═══════════════════════════════════════════════════════════════════════════

describeIfDb('handleCreateQuote — Section 5: pointer UPDATE (integration)', () => {
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

  test('Pointer UPDATE: chiefos_quotes.current_version_id transitions from NULL to version.id, updated_at bumped', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);

      const header = await insertQuoteHeader(client, {
        tenantId: pre.tenantId, ownerId: pre.ownerId,
        jobId: pre.jobId, customerId: pre.customer.id,
        humanId: pre.humanId, source: 'whatsapp', sourceMsgId: pre.sourceMsgId,
      });

      // Capture the pre-UPDATE state.
      const before = await client.query(
        `SELECT current_version_id, updated_at FROM public.chiefos_quotes WHERE id = $1`,
        [header.id]
      );
      expect(before.rows[0].current_version_id).toBeNull();
      const updatedAtBefore = before.rows[0].updated_at;

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

      // Ensure there's a measurable time delta for updated_at bump.
      await new Promise((r) => setTimeout(r, 50));

      await setQuoteCurrentVersion(client, {
        quoteId: header.id,
        versionId: version.id,
        tenantId: pre.tenantId,
        ownerId: pre.ownerId,
      });

      const after = await client.query(
        `SELECT current_version_id, updated_at FROM public.chiefos_quotes WHERE id = $1`,
        [header.id]
      );
      expect(after.rows[0].current_version_id).toBe(version.id);
      // Postgres NOW() returns transaction_timestamp() — pinned for the
      // duration of the BEGIN/ROLLBACK scope. Within one transaction the
      // INSERT's default updated_at and the UPDATE's NOW() resolve to the
      // same instant. Cross-transaction callers would see strict-greater;
      // in-transaction tests see equal. Asserting >= covers both.
      expect(new Date(after.rows[0].updated_at).getTime())
        .toBeGreaterThanOrEqual(new Date(updatedAtBefore).getTime());
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 6: audit events emission (integration)
// ═══════════════════════════════════════════════════════════════════════════

describeIfDb('handleCreateQuote — Section 6: event emission (integration)', () => {
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

  // Test helper: seed a complete header + version scaffold for event tests.
  async function seedHeaderAndVersion(client, pre) {
    const header = await insertQuoteHeader(client, {
      tenantId: pre.tenantId, ownerId: pre.ownerId,
      jobId: pre.jobId, customerId: pre.customer.id,
      humanId: pre.humanId, source: 'whatsapp', sourceMsgId: pre.sourceMsgId,
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
      tenantSnapshot: { legal_name: 'Test Co', address: 'Test' },
    });
    return { header, version };
  }

  test('emitLifecycleCreated: quote-scoped event with payload={}, quote_version_id=NULL', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { header } = await seedHeaderAndVersion(client, pre);

      await emitLifecycleCreated(client, {
        quoteId: header.id,
        tenantId: pre.tenantId, ownerId: pre.ownerId,
        actorSource: 'whatsapp', actorUserId: pre.ownerId,
        emittedAt: '2026-04-19T12:00:00.000Z',
        customerId: pre.customer.id,
      });

      const rows = await client.query(
        `SELECT kind, tenant_id, owner_id, quote_id, quote_version_id,
                actor_source, actor_user_id, customer_id,
                correlation_id, payload, emitted_at
           FROM public.chiefos_quote_events
          WHERE quote_id = $1 AND kind = 'lifecycle.created'`,
        [header.id]
      );
      expect(rows.rows).toHaveLength(1);
      const ev = rows.rows[0];
      expect(ev.kind).toBe('lifecycle.created');
      expect(ev.tenant_id).toBe(pre.tenantId);
      expect(ev.owner_id).toBe(pre.ownerId);
      expect(ev.quote_id).toBe(header.id);
      expect(ev.quote_version_id).toBeNull();        // quote-scoped per schema
      expect(ev.actor_source).toBe('whatsapp');
      expect(ev.actor_user_id).toBe(pre.ownerId);
      expect(ev.customer_id).toBe(pre.customer.id);
      expect(ev.correlation_id).toBeNull();          // §17.14 clarification
      expect(ev.payload).toEqual({});                // no per-kind payload CHECK
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('emitLifecycleVersionCreated: version-scoped with payload={version_no:1, trigger_source:initial}', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { header, version } = await seedHeaderAndVersion(client, pre);

      await emitLifecycleVersionCreated(client, {
        quoteId: header.id, versionId: version.id,
        tenantId: pre.tenantId, ownerId: pre.ownerId,
        actorSource: 'whatsapp', actorUserId: pre.ownerId,
        emittedAt: '2026-04-19T12:00:00.000Z',
        customerId: pre.customer.id,
        versionNo: 1, triggerSource: 'initial',
      });

      const rows = await client.query(
        `SELECT kind, quote_version_id, payload
           FROM public.chiefos_quote_events
          WHERE quote_id = $1 AND kind = 'lifecycle.version_created'`,
        [header.id]
      );
      expect(rows.rows).toHaveLength(1);
      const ev = rows.rows[0];
      expect(ev.kind).toBe('lifecycle.version_created');
      expect(ev.quote_version_id).toBe(version.id);  // version-scoped per schema
      expect(ev.payload).toEqual({
        version_no: 1,
        trigger_source: 'initial',
      });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('Pair invariant: lifecycle.created + lifecycle.version_created share tenant/owner/quote/actor/customer/emitted_at', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { header, version } = await seedHeaderAndVersion(client, pre);

      const emittedAt = '2026-04-19T12:00:00.000Z';
      const sharedArgs = {
        tenantId: pre.tenantId, ownerId: pre.ownerId,
        actorSource: 'whatsapp', actorUserId: pre.ownerId,
        emittedAt, customerId: pre.customer.id,
      };

      await emitLifecycleCreated(client, { quoteId: header.id, ...sharedArgs });
      await emitLifecycleVersionCreated(client, {
        quoteId: header.id, versionId: version.id,
        ...sharedArgs, versionNo: 1, triggerSource: 'initial',
      });

      const rows = await client.query(
        `SELECT kind, tenant_id, owner_id, quote_id, actor_source,
                actor_user_id, customer_id, emitted_at, global_seq, created_at
           FROM public.chiefos_quote_events
          WHERE quote_id = $1
          ORDER BY global_seq ASC`,
        [header.id]
      );
      expect(rows.rows).toHaveLength(2);
      const [created, versionCreated] = rows.rows;

      // Pair invariant — every shared field matches
      for (const field of [
        'tenant_id', 'owner_id', 'quote_id', 'actor_source',
        'actor_user_id', 'customer_id',
      ]) {
        expect(created[field]).toEqual(versionCreated[field]);
      }
      expect(created.emitted_at.getTime()).toBe(versionCreated.emitted_at.getTime());

      // INSERT order: lifecycle.created first, lifecycle.version_created second
      expect(created.kind).toBe('lifecycle.created');
      expect(versionCreated.kind).toBe('lifecycle.version_created');
      expect(Number(created.global_seq)).toBeLessThan(Number(versionCreated.global_seq));
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 7: end-to-end handleCreateQuote (integration + unit)
// ═══════════════════════════════════════════════════════════════════════════
//
// Tests 1-2 (happy path + idempotent retry) run against the Forest City
// dedicated test tenant — Migration 2's event immutability trigger blocks
// DELETE on chiefos_quote_events, so event rows accumulate permanently.
// Using Forest City keeps Mission clean. Cleanup: void the quote header
// + delete line items + delete counter row. Events + versions persist.
//
// Tests 3-5 (plan/actor rejection) use BEGIN/ROLLBACK where they can; the
// plan resolution reads public.users which we seed + teardown explicitly
// because the handler's own connection is outside any test-level txn.
//
// Tests 6-8 (Zod rejection) are pure unit — Zod rejects before any DB call.

/**
 * cleanupCreatedQuote — best-effort teardown for tests that run
 * handleCreateQuote end-to-end. Deletes what can be deleted; voids what
 * can't.
 *
 * Cannot delete: chiefos_quote_events (immutability trigger blocks DELETE).
 * Cannot delete header: chiefos_qe_quote_identity_fk ON DELETE RESTRICT.
 * So header gets status='voided'; events stay as-is.
 */
async function cleanupCreatedQuote(ownerId, quoteId, sourceMsgId, monthKey) {
  const pg = require('../../services/postgres');
  await pg.query(
    `DELETE FROM public.chiefos_quote_line_items
      WHERE quote_version_id IN
            (SELECT id FROM public.chiefos_quote_versions WHERE quote_id = $1)`,
    [quoteId]
  );
  await pg.query(
    `UPDATE public.chiefos_quotes SET current_version_id = NULL WHERE id = $1`,
    [quoteId]
  );
  await pg.query(
    `UPDATE public.chiefos_quotes
        SET status = 'voided', voided_at = NOW(),
            voided_reason = 'test-cleanup', updated_at = NOW()
      WHERE id = $1`,
    [quoteId]
  );
  if (sourceMsgId && monthKey) {
    await pg.query(
      `DELETE FROM public.usage_monthly_v2
        WHERE owner_id = $1 AND month_key = $2 AND kind = 'quote_created'`,
      [ownerId, monthKey]
    );
  }
}

/** Build a minimal valid CreateQuote CIL payload for testing. */
function buildValidCreateQuoteCil({
  tenantId, sourceMsgId, actorId, occurredAt,
}) {
  return {
    cil_version: '1.0',
    type: 'CreateQuote',
    tenant_id: tenantId,
    source: 'whatsapp',
    source_msg_id: sourceMsgId,
    actor: { actor_id: actorId, role: 'owner' },
    occurred_at: occurredAt,
    job: {
      job_name: `Test Job ${Math.random().toString(36).slice(2, 8)}`,
      create_if_missing: true,
    },
    needs_job_resolution: false,
    customer: {
      name: 'ChiefOS Integration Test',
      email: 'test@chiefos.test',
      phone_e164: '+15195550100',
      address: '1 Test Way, London, ON',
    },
    project: { title: 'Integration Test Project', scope: 'Section 7 test scope.' },
    currency: 'CAD',
    tax_rate_bps: 1300,
    tax_code: 'HST-ON',
    line_items: [
      { sort_order: 0, description: 'Test labor', category: 'labour', qty: 2, unit_price_cents: 5000 },
      { sort_order: 1, description: 'Test materials', category: 'materials', qty: 1, unit_price_cents: 25000 },
    ],
    deposit_cents: 0,
    payment_terms: {},
    warranty_snapshot: {},
    clauses_snapshot: {},
  };
}

describeIfDb('handleCreateQuote — Section 7: end-to-end integration (Forest City)', () => {
  test('Happy path: creates quote + v1 + line items + 2 events; returns §17.15 shape; counter incremented', async () => {
    const pg = require('../../services/postgres');
    const ownerId = `99${Math.floor(Math.random() * 1e11).toString().padStart(11, '0')}`;
    const sourceMsgId = `test-s7-happy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const monthKey = new Date().toISOString().slice(0, 7);

    await pg.query(
      `INSERT INTO public.users (user_id, plan_key, sub_status, created_at)
       VALUES ($1, 'starter', 'active', NOW())`,
      [ownerId]
    );

    let quoteId;
    try {
      const cil = buildValidCreateQuoteCil({
        tenantId: FOREST_CITY_TENANT_UUID,
        sourceMsgId, actorId: ownerId,
        occurredAt: new Date().toISOString(),
      });
      const result = await handleCreateQuote(cil, {
        owner_id: ownerId, traceId: 'trace-s7-happy',
      });

      expect(result.ok).toBe(true);
      expect(result.quote).toBeDefined();
      quoteId = result.quote.id;

      expect(result.quote).toMatchObject({
        version_no: 1, status: 'draft', currency: 'CAD', issued_at: null,
      });
      expect(result.quote.human_id).toMatch(/^QT-\d{4}-\d{2}-\d{2}-\d{4}$/);
      // Line 1: qty=2 × unit=5000 = 10000; tax=1300 bps → 1300. Line total=11300.
      // Line 2: qty=1 × unit=25000 = 25000; tax=3250. Line total=28250.
      // Subtotal=35000, Tax=4550, Total=39550.
      expect(result.quote.total_cents).toBe(39550);
      expect(result.quote.customer.name).toBe('ChiefOS Integration Test');
      expect(result.quote.customer.phone_e164).toBe('+15195550100');

      expect(result.meta).toEqual({
        already_existed: false,
        events_emitted: ['lifecycle.created', 'lifecycle.version_created'],
        traceId: 'trace-s7-happy',
      });

      const events = await pg.query(
        `SELECT kind FROM public.chiefos_quote_events
          WHERE quote_id = $1 ORDER BY global_seq ASC`,
        [quoteId]
      );
      expect(events.rows.map((r) => r.kind)).toEqual([
        'lifecycle.created', 'lifecycle.version_created',
      ]);

      const usage = await pg.getMonthlyUsage({
        ownerId, kind: 'quote_created', monthKey,
      });
      expect(usage).toBe(1);
    } finally {
      if (quoteId) {
        await cleanupCreatedQuote(ownerId, quoteId, sourceMsgId, monthKey).catch(() => {});
      }
      await pg.query(`DELETE FROM public.users WHERE user_id = $1`, [ownerId]).catch(() => {});
    }
  }, 30000);

  test('Idempotent retry: same source_msg_id returns meta.already_existed=true; counter not double-incremented', async () => {
    const pg = require('../../services/postgres');
    const ownerId = `99${Math.floor(Math.random() * 1e11).toString().padStart(11, '0')}`;
    const sourceMsgId = `test-s7-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const monthKey = new Date().toISOString().slice(0, 7);

    await pg.query(
      `INSERT INTO public.users (user_id, plan_key, sub_status, created_at)
       VALUES ($1, 'starter', 'active', NOW())`,
      [ownerId]
    );

    let quoteId;
    try {
      const cil = buildValidCreateQuoteCil({
        tenantId: FOREST_CITY_TENANT_UUID,
        sourceMsgId, actorId: ownerId,
        occurredAt: new Date().toISOString(),
      });
      const ctx = { owner_id: ownerId, traceId: 'trace-s7-retry' };

      const first = await handleCreateQuote(cil, ctx);
      expect(first.ok).toBe(true);
      expect(first.meta.already_existed).toBe(false);
      quoteId = first.quote.id;

      const retry = await handleCreateQuote(cil, ctx);
      expect(retry.ok).toBe(true);
      expect(retry.meta.already_existed).toBe(true);
      expect(retry.meta.events_emitted).toEqual([]);
      expect(retry.quote.id).toBe(first.quote.id);
      expect(retry.quote.version_id).toBe(first.quote.version_id);
      expect(retry.quote.human_id).toBe(first.quote.human_id);

      const usage = await pg.getMonthlyUsage({
        ownerId, kind: 'quote_created', monthKey,
      });
      expect(usage).toBe(1);
    } finally {
      if (quoteId) {
        await cleanupCreatedQuote(ownerId, quoteId, sourceMsgId, monthKey).catch(() => {});
      }
      await pg.query(`DELETE FROM public.users WHERE user_id = $1`, [ownerId]).catch(() => {});
    }
  }, 30000);
});

describeIfDb('handleCreateQuote — Section 7: rejection paths (no DB writes)', () => {
  test('Plan gating (Free tier): QUOTES_REQUIRES_STARTER envelope', async () => {
    const pg = require('../../services/postgres');
    const ownerId = `99${Math.floor(Math.random() * 1e11).toString().padStart(11, '0')}`;
    await pg.query(
      `INSERT INTO public.users (user_id, plan_key, sub_status, created_at)
       VALUES ($1, 'free', 'active', NOW())`,
      [ownerId]
    );
    try {
      const cil = buildValidCreateQuoteCil({
        tenantId: MISSION_TENANT_UUID,
        sourceMsgId: `test-s7-free-${Date.now()}`,
        actorId: ownerId, occurredAt: new Date().toISOString(),
      });
      const result = await handleCreateQuote(cil, {
        owner_id: ownerId, traceId: 'trace-s7-free',
      });
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('QUOTES_REQUIRES_STARTER');
      expect(result.error.hint).toBe('Upgrade to starter');
      expect(result.error.traceId).toBe('trace-s7-free');
    } finally {
      await pg.query(`DELETE FROM public.users WHERE user_id = $1`, [ownerId]).catch(() => {});
    }
  });

  test('Plan gating (capacity reached): QUOTES_CAPACITY_REACHED envelope', async () => {
    const pg = require('../../services/postgres');
    const ownerId = `99${Math.floor(Math.random() * 1e11).toString().padStart(11, '0')}`;
    const monthKey = new Date().toISOString().slice(0, 7);
    await pg.query(
      `INSERT INTO public.users (user_id, plan_key, sub_status, created_at)
       VALUES ($1, 'starter', 'active', NOW())`,
      [ownerId]
    );
    await pg.query(
      `INSERT INTO public.usage_monthly_v2 (owner_id, month_key, kind, units)
       VALUES ($1, $2, 'quote_created', 50)`,
      [ownerId, monthKey]
    );
    try {
      const cil = buildValidCreateQuoteCil({
        tenantId: MISSION_TENANT_UUID,
        sourceMsgId: `test-s7-cap-${Date.now()}`,
        actorId: ownerId, occurredAt: new Date().toISOString(),
      });
      const result = await handleCreateQuote(cil, {
        owner_id: ownerId, traceId: 'trace-s7-cap',
      });
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('QUOTES_CAPACITY_REACHED');
      expect(result.error.hint).toBe('Upgrade to pro');
    } finally {
      await pg.query(
        `DELETE FROM public.usage_monthly_v2 WHERE owner_id = $1 AND month_key = $2 AND kind = 'quote_created'`,
        [ownerId, monthKey]
      ).catch(() => {});
      await pg.query(`DELETE FROM public.users WHERE user_id = $1`, [ownerId]).catch(() => {});
    }
  });

  test('Actor role rejection (employee): PERMISSION_DENIED envelope', async () => {
    const pg = require('../../services/postgres');
    const ownerId = `99${Math.floor(Math.random() * 1e11).toString().padStart(11, '0')}`;
    await pg.query(
      `INSERT INTO public.users (user_id, plan_key, sub_status, created_at)
       VALUES ($1, 'starter', 'active', NOW())`,
      [ownerId]
    );
    try {
      const cil = buildValidCreateQuoteCil({
        tenantId: MISSION_TENANT_UUID,
        sourceMsgId: `test-s7-emp-${Date.now()}`,
        actorId: ownerId, occurredAt: new Date().toISOString(),
      });
      cil.actor.role = 'employee';
      const result = await handleCreateQuote(cil, {
        owner_id: ownerId, traceId: 'trace-s7-emp',
      });
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('PERMISSION_DENIED');
      expect(result.error.message).toContain('owner');
    } finally {
      await pg.query(`DELETE FROM public.users WHERE user_id = $1`, [ownerId]).catch(() => {});
    }
  });
});

describe('handleCreateQuote — Section 7: Zod rejection (unit, no DB)', () => {
  const baseCtx = { owner_id: '12345', traceId: 'trace-zod' };
  const baseCil = {
    cil_version: '1.0',
    type: 'CreateQuote',
    tenant_id: MISSION_TENANT_UUID,
    source: 'whatsapp',
    source_msg_id: 'test-zod-1',
    actor: { actor_id: '12345', role: 'owner' },
    occurred_at: '2026-04-19T12:00:00.000Z',
    job: { job_name: 'Test', create_if_missing: true },
    needs_job_resolution: false,
    customer: { name: 'Test' },
    project: { title: 'T' },
    currency: 'CAD',
    tax_rate_bps: 1300,
    line_items: [{ description: 'Item', unit_price_cents: 100 }],
  };

  test('missing tax_rate_bps → CIL_SCHEMA_INVALID envelope', async () => {
    const cil = { ...baseCil };
    delete cil.tax_rate_bps;
    const result = await handleCreateQuote(cil, baseCtx);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CIL_SCHEMA_INVALID');
    expect(result.error.message).toContain('tax_rate_bps');
    expect(result.error.traceId).toBe('trace-zod');
  });

  test('empty line_items → CIL_SCHEMA_INVALID per §20 Q3', async () => {
    const cil = { ...baseCil, line_items: [] };
    const result = await handleCreateQuote(cil, baseCtx);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CIL_SCHEMA_INVALID');
    expect(result.error.message).toMatch(/line_items|at least one/i);
  });

  test('customer missing both customer_id and name → CIL_SCHEMA_INVALID per §20 Q1 refine', async () => {
    const cil = { ...baseCil, customer: {} };
    const result = await handleCreateQuote(cil, baseCtx);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CIL_SCHEMA_INVALID');
    expect(result.error.message).toMatch(/customer_id|name|customer/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SendQuote — Section 1: Zod schemas (unit, no DB)
// ═══════════════════════════════════════════════════════════════════════════

const { SendQuoteCILZ, QuoteRefInputZ } = _internals;

describe('SendQuote — Section 1: Zod schemas', () => {
  const baseSendCil = {
    cil_version: '1.0',
    type: 'SendQuote',
    tenant_id: MISSION_TENANT_UUID,
    source: 'whatsapp',
    source_msg_id: 'test-send-zod-1',
    actor: { actor_id: '12345', role: 'owner' },
    occurred_at: '2026-04-19T12:00:00.000Z',
    job: null,
    needs_job_resolution: false,
    quote_ref: { quote_id: '8430c4be-bcfd-44e7-b4e4-3603783d6b69' },
  };

  test('QuoteRefInputZ: accepts quote_id OR human_id; rejects neither', () => {
    expect(QuoteRefInputZ.safeParse({ quote_id: '8430c4be-bcfd-44e7-b4e4-3603783d6b69' }).success).toBe(true);
    expect(QuoteRefInputZ.safeParse({ human_id: 'QT-2026-04-19-0001' }).success).toBe(true);
    expect(QuoteRefInputZ.safeParse({}).success).toBe(false);
    // quote_id type check — accepts UUID only
    expect(QuoteRefInputZ.safeParse({ quote_id: 'not-a-uuid' }).success).toBe(false);
  });

  test('SendQuoteCILZ: minimum-valid payload parses; rejects upload source + missing quote_ref + bad recipient_email', () => {
    // Happy path — quote_id ref only
    expect(SendQuoteCILZ.safeParse(baseSendCil).success).toBe(true);

    // G1 narrowing: upload source rejected (inherits CreateQuote's decision)
    expect(SendQuoteCILZ.safeParse({ ...baseSendCil, source: 'upload' }).success).toBe(false);

    // Missing quote_ref → fail
    const { quote_ref: _omitted, ...noRef } = baseSendCil;
    expect(SendQuoteCILZ.safeParse(noRef).success).toBe(false);

    // Optional recipient_email rejects malformed
    expect(SendQuoteCILZ.safeParse({
      ...baseSendCil,
      recipient_email: 'not-an-email',
    }).success).toBe(false);

    // Optional recipient_email/name accepted when valid
    expect(SendQuoteCILZ.safeParse({
      ...baseSendCil,
      recipient_email: 'darlene@example.com',
      recipient_name: 'Darlene MacDonald',
    }).success).toBe(true);
  });
});
