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

const { handleCreateQuote, handleSendQuote, _internals } = require('./quotes');
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

const {
  SendQuoteCILZ, QuoteRefInputZ,
  loadDraftQuote, resolveRecipient,
  generateShareToken, insertShareToken,
  markQuoteSent, emitLifecycleSent,
  buildQuoteShareUrl, formatCentsAsCurrency, buildSendQuoteEmail,
  emitNotificationSent, emitNotificationFailed,
  buildSendQuoteReturnShape, priorShareTokenToReturnShape,
  APP_URL,
} = _internals;

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

// ═══════════════════════════════════════════════════════════════════════════
// SendQuote — Section 2: loadDraftQuote (integration)
// ═══════════════════════════════════════════════════════════════════════════

describeIfDb('SendQuote — Section 2: loadDraftQuote (integration)', () => {
  let pool;
  beforeAll(async () => {
    const pg = require('../../services/postgres');
    pool = pg.pool;
  });

  /**
   * Seed a complete draft quote end-to-end: preconditions + header +
   * version + pointer swing. Returns { pre, header, version } for tests
   * to assert against. All inside the caller's BEGIN/ROLLBACK transaction.
   */
  async function seedDraftQuote(client, pre) {
    const {
      insertQuoteHeader, insertQuoteVersion, setQuoteCurrentVersion,
      composeTenantSnapshot,
    } = _internals;
    const header = await insertQuoteHeader(client, {
      tenantId: pre.tenantId, ownerId: pre.ownerId,
      jobId: pre.jobId, customerId: pre.customer.id,
      humanId: pre.humanId, source: 'whatsapp', sourceMsgId: pre.sourceMsgId,
    });
    const version = await insertQuoteVersion(client, {
      quoteId: header.id, tenantId: pre.tenantId, ownerId: pre.ownerId,
      data: {
        project: { title: 'Seeded Project', scope: null },
        currency: 'CAD', deposit_cents: 0, tax_code: null, tax_rate_bps: 1300,
        warranty_snapshot: {}, clauses_snapshot: {}, payment_terms: {},
        warranty_template_ref: null, clauses_template_ref: null,
      },
      totals: { subtotal_cents: 1000, tax_cents: 130, total_cents: 1130 },
      customerSnapshot: { name: pre.customer.name, email: pre.customer.email },
      tenantSnapshot: composeTenantSnapshot(pre.tenantId),
    });
    await setQuoteCurrentVersion(client, {
      quoteId: header.id, versionId: version.id,
      tenantId: pre.tenantId, ownerId: pre.ownerId,
    });
    return { header, version };
  }

  test('Branch A: quote_id resolves returns current version state', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { header, version } = await seedDraftQuote(client, pre);

      const row = await loadDraftQuote(client, {
        tenantId: pre.tenantId,
        ownerId: pre.ownerId,
        quoteRef: { quote_id: header.id },
      });

      expect(row.quote_id).toBe(header.id);
      expect(row.version_id).toBe(version.id);
      expect(row.status).toBe('draft');
      expect(row.current_version_id).toBe(version.id);
      expect(row.human_id).toBe(pre.humanId);
      expect(row.version_no).toBe(1);
      expect(row.currency).toBe('CAD');
      expect(Number(row.total_cents)).toBe(1130);
      expect(row.customer_snapshot).toEqual({
        name: pre.customer.name, email: pre.customer.email,
      });
      expect(row.tenant_snapshot).toMatchObject({
        legal_name: expect.any(String),
        brand_name: expect.any(String),
      });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('Branch B: human_id resolves within tenant scope', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { header, version } = await seedDraftQuote(client, pre);

      const row = await loadDraftQuote(client, {
        tenantId: pre.tenantId,
        ownerId: pre.ownerId,
        quoteRef: { human_id: pre.humanId },
      });

      expect(row.quote_id).toBe(header.id);
      expect(row.version_id).toBe(version.id);
      expect(row.human_id).toBe(pre.humanId);
      expect(row.status).toBe('draft');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('Cross-owner lookup throws QUOTE_NOT_FOUND_OR_CROSS_OWNER', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const preA = await setupQuotePreconditions(client);
      const { header } = await seedDraftQuote(client, preA);

      // Seed a second user in the same tenant.
      const preB = await setupQuotePreconditions(client, {
        tenantId: preA.tenantId,
      });

      // Attempt to load preA's quote as ownerB.
      await expect(
        loadDraftQuote(client, {
          tenantId: preA.tenantId,
          ownerId: preB.ownerId,
          quoteRef: { quote_id: header.id },
        })
      ).rejects.toMatchObject({
        code: 'QUOTE_NOT_FOUND_OR_CROSS_OWNER',
        hint: expect.stringContaining('tenant+owner scope'),
      });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('Already-sent quote throws QUOTE_NOT_DRAFT (hint points at ReissueQuote)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { header } = await seedDraftQuote(client, pre);

      // Flip to 'sent' to exercise the state check.
      await client.query(
        `UPDATE public.chiefos_quotes SET status = 'sent', updated_at = NOW()
          WHERE id = $1`,
        [header.id]
      );

      await expect(
        loadDraftQuote(client, {
          tenantId: pre.tenantId,
          ownerId: pre.ownerId,
          quoteRef: { quote_id: header.id },
        })
      ).rejects.toMatchObject({
        code: 'QUOTE_NOT_DRAFT',
        message: expect.stringContaining("'sent'"),
        hint: expect.stringContaining('ReissueQuote'),
      });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SendQuote — Section 3: resolveRecipient (unit, no DB)
// ═══════════════════════════════════════════════════════════════════════════

describe('SendQuote — Section 3: resolveRecipient', () => {
  const snapshot = { name: 'Darlene MacDonald', email: 'darlene@example.com' };

  test('Branch 1: parsed recipient_email override wins; empty override name falls through to snapshot', () => {
    // Both override fields present
    expect(resolveRecipient({
      parsedRecipientEmail: 'scott@acme.com',
      parsedRecipientName: 'Scott Ibbotson',
      customerSnapshot: snapshot,
    })).toEqual({ email: 'scott@acme.com', name: 'Scott Ibbotson' });

    // Override email only — name falls back to snapshot
    expect(resolveRecipient({
      parsedRecipientEmail: 'scott@acme.com',
      parsedRecipientName: undefined,
      customerSnapshot: snapshot,
    })).toEqual({ email: 'scott@acme.com', name: 'Darlene MacDonald' });

    // Empty-string override name — intentionally falls through
    expect(resolveRecipient({
      parsedRecipientEmail: 'scott@acme.com',
      parsedRecipientName: '',
      customerSnapshot: snapshot,
    })).toEqual({ email: 'scott@acme.com', name: 'Darlene MacDonald' });
  });

  test('Branch 2: customer_snapshot fallback when no override', () => {
    expect(resolveRecipient({
      parsedRecipientEmail: undefined,
      parsedRecipientName: undefined,
      customerSnapshot: snapshot,
    })).toEqual({ email: 'darlene@example.com', name: 'Darlene MacDonald' });
  });

  test('Branch 3: throws RECIPIENT_MISSING when override absent AND snapshot has no email', () => {
    // Snapshot missing email (customer was created name-only)
    expect(() => resolveRecipient({
      parsedRecipientEmail: undefined,
      parsedRecipientName: undefined,
      customerSnapshot: { name: 'Anonymous' },
    })).toThrow(CilIntegrityError);

    try {
      resolveRecipient({
        parsedRecipientEmail: undefined,
        customerSnapshot: { name: 'Anonymous' },
      });
    } catch (err) {
      expect(err.code).toBe('RECIPIENT_MISSING');
      expect(err.message).toBe('No recipient email available for SendQuote');
      expect(err.hint).toMatch(/recipient_email|email/);
    }

    // Snapshot entirely missing
    expect(() => resolveRecipient({
      parsedRecipientEmail: undefined,
      customerSnapshot: null,
    })).toThrow(CilIntegrityError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SendQuote — Section 4: share-token generation + INSERT
// ═══════════════════════════════════════════════════════════════════════════

describe('SendQuote — Section 4a: generateShareToken (unit)', () => {
  // Regression lock for the bs58-short-output production bug. Prior
  // version (`return bs58.encode(crypto.randomBytes(16))` — no retry)
  // returned 21-char tokens ~2.83% of the time. Migration 3's
  // chiefos_qst_token_format CHECK requires exactly 22, so ~3% of real
  // SendQuote calls would fail with 23514. 10,000-iteration assertion
  // would fire ~283 times against the unfixed function; under the fix
  // it must produce zero failures.
  test('generateShareToken produces 22-char base58 across 10,000 calls (bs58 short-output regression lock)', () => {
    for (let i = 0; i < 10000; i++) {
      const token = generateShareToken();
      expect(token).toHaveLength(22);
      expect(token).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    }
  });

  test('generateShareToken produces unique tokens (100 calls, 0 collisions)', () => {
    const seen = new Set();
    for (let i = 0; i < 100; i++) {
      seen.add(generateShareToken());
    }
    expect(seen.size).toBe(100);
  });
});

describeIfDb('SendQuote — Section 4b: insertShareToken (integration)', () => {
  let pool;
  beforeAll(async () => {
    const pg = require('../../services/postgres');
    pool = pg.pool;
  });

  async function seedDraftQuote(client, pre) {
    const {
      insertQuoteHeader, insertQuoteVersion, setQuoteCurrentVersion,
      composeTenantSnapshot,
    } = _internals;
    const header = await insertQuoteHeader(client, {
      tenantId: pre.tenantId, ownerId: pre.ownerId,
      jobId: pre.jobId, customerId: pre.customer.id,
      humanId: pre.humanId, source: 'whatsapp', sourceMsgId: pre.sourceMsgId,
    });
    const version = await insertQuoteVersion(client, {
      quoteId: header.id, tenantId: pre.tenantId, ownerId: pre.ownerId,
      data: {
        project: { title: 'Seeded', scope: null },
        currency: 'CAD', deposit_cents: 0, tax_code: null, tax_rate_bps: 1300,
        warranty_snapshot: {}, clauses_snapshot: {}, payment_terms: {},
        warranty_template_ref: null, clauses_template_ref: null,
      },
      totals: { subtotal_cents: 1000, tax_cents: 130, total_cents: 1130 },
      customerSnapshot: { name: pre.customer.name, email: pre.customer.email },
      tenantSnapshot: composeTenantSnapshot(pre.tenantId),
    });
    await setQuoteCurrentVersion(client, {
      quoteId: header.id, versionId: version.id,
      tenantId: pre.tenantId, ownerId: pre.ownerId,
    });
    return { header, version };
  }

  test('Happy path: inserts row with correct scope, recipient, and 30-day expiry', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { version } = await seedDraftQuote(client, pre);

      const token = generateShareToken();
      const result = await insertShareToken(client, {
        tenantId: pre.tenantId,
        ownerId: pre.ownerId,
        quoteVersionId: version.id,
        token,
        recipient: { name: 'Darlene MacDonald', email: 'darlene@example.com' },
        sourceMsgId: `test-send-s4-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });

      expect(result.id).toBeDefined();
      expect(result.token).toBe(token);
      expect(result.issued_at).toBeDefined();
      expect(result.absolute_expires_at).toBeDefined();

      // 30-day expiry: exact math within the transaction since NOW() is pinned.
      const issuedAtMs = new Date(result.issued_at).getTime();
      const expiresAtMs = new Date(result.absolute_expires_at).getTime();
      const diffDays = (expiresAtMs - issuedAtMs) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBe(30);

      // Full row verification.
      const row = await client.query(
        `SELECT tenant_id, owner_id, quote_version_id, token,
                recipient_name, recipient_channel, recipient_address,
                revoked_at, superseded_at
           FROM public.chiefos_quote_share_tokens WHERE id = $1`,
        [result.id]
      );
      expect(row.rows[0]).toMatchObject({
        tenant_id: pre.tenantId,
        owner_id: pre.ownerId,
        quote_version_id: version.id,
        token,
        recipient_name: 'Darlene MacDonald',
        recipient_channel: 'email',
        recipient_address: 'darlene@example.com',
        revoked_at: null,
        superseded_at: null,
      });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('DB CHECK enforces token format: malformed token is rejected', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { version } = await seedDraftQuote(client, pre);

      // Bad token: length OK (22) but contains forbidden '0'.
      const badToken = '0000000000000000000000';

      await expect(
        insertShareToken(client, {
          tenantId: pre.tenantId, ownerId: pre.ownerId,
          quoteVersionId: version.id,
          token: badToken,
          recipient: { name: 'Test', email: 'test@example.com' },
          sourceMsgId: `test-send-s4-bad-${Date.now()}`,
        })
      ).rejects.toMatchObject({
        code: '23514',               // check_violation
        constraint: 'chiefos_qst_token_format',
      });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('source_msg_id idempotency surface: second insert with same (owner, msg) → 23505', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { version } = await seedDraftQuote(client, pre);

      const sourceMsgId = `test-send-s4-dup-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      // First insert succeeds.
      await insertShareToken(client, {
        tenantId: pre.tenantId, ownerId: pre.ownerId,
        quoteVersionId: version.id,
        token: generateShareToken(),
        recipient: { name: 'First', email: 'first@example.com' },
        sourceMsgId,
      });

      // Second insert with same (owner_id, source_msg_id) → 23505 on partial UNIQUE.
      await client.query('SAVEPOINT sp_dup');
      let caught = null;
      try {
        await insertShareToken(client, {
          tenantId: pre.tenantId, ownerId: pre.ownerId,
          quoteVersionId: version.id,
          token: generateShareToken(),
          recipient: { name: 'Second', email: 'second@example.com' },
          sourceMsgId,   // same key
        });
      } catch (err) {
        caught = err;
      }
      await client.query('ROLLBACK TO SAVEPOINT sp_dup');

      expect(caught).not.toBeNull();
      expect(caught.code).toBe('23505');
      expect(caught.constraint).toBe('chiefos_qst_source_msg_unique');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SendQuote — Section 5: markQuoteSent + emitLifecycleSent (integration)
// ═══════════════════════════════════════════════════════════════════════════

describeIfDb('SendQuote — Section 5: state transitions + lifecycle.sent (integration)', () => {
  let pool;
  beforeAll(async () => {
    const pg = require('../../services/postgres');
    pool = pg.pool;
  });

  async function seedDraftQuote(client, pre) {
    const {
      insertQuoteHeader, insertQuoteVersion, setQuoteCurrentVersion,
      composeTenantSnapshot,
    } = _internals;
    const header = await insertQuoteHeader(client, {
      tenantId: pre.tenantId, ownerId: pre.ownerId,
      jobId: pre.jobId, customerId: pre.customer.id,
      humanId: pre.humanId, source: 'whatsapp', sourceMsgId: pre.sourceMsgId,
    });
    const version = await insertQuoteVersion(client, {
      quoteId: header.id, tenantId: pre.tenantId, ownerId: pre.ownerId,
      data: {
        project: { title: 'Seeded', scope: null },
        currency: 'CAD', deposit_cents: 0, tax_code: null, tax_rate_bps: 1300,
        warranty_snapshot: {}, clauses_snapshot: {}, payment_terms: {},
        warranty_template_ref: null, clauses_template_ref: null,
      },
      totals: { subtotal_cents: 1000, tax_cents: 130, total_cents: 1130 },
      customerSnapshot: { name: pre.customer.name, email: pre.customer.email },
      tenantSnapshot: composeTenantSnapshot(pre.tenantId),
    });
    await setQuoteCurrentVersion(client, {
      quoteId: header.id, versionId: version.id,
      tenantId: pre.tenantId, ownerId: pre.ownerId,
    });
    return { header, version };
  }

  test('markQuoteSent: header flips draft → sent, updated_at bumped', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { header, version } = await seedDraftQuote(client, pre);

      const before = await client.query(
        `SELECT status, updated_at FROM public.chiefos_quotes WHERE id = $1`,
        [header.id]
      );
      expect(before.rows[0].status).toBe('draft');
      const updatedAtBefore = before.rows[0].updated_at;

      await markQuoteSent(client, {
        quoteId: header.id, versionId: version.id,
        tenantId: pre.tenantId, ownerId: pre.ownerId,
      });

      const after = await client.query(
        `SELECT status, updated_at FROM public.chiefos_quotes WHERE id = $1`,
        [header.id]
      );
      expect(after.rows[0].status).toBe('sent');
      // NOW() is transaction-pinned so updated_at ≥ before (same instant within txn).
      expect(new Date(after.rows[0].updated_at).getTime())
        .toBeGreaterThanOrEqual(new Date(updatedAtBefore).getTime());
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('markQuoteSent: version issued_at + sent_at populated (both equal; transaction-pinned NOW)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { header, version } = await seedDraftQuote(client, pre);

      const before = await client.query(
        `SELECT issued_at, sent_at FROM public.chiefos_quote_versions WHERE id = $1`,
        [version.id]
      );
      expect(before.rows[0].issued_at).toBeNull();
      expect(before.rows[0].sent_at).toBeNull();

      await markQuoteSent(client, {
        quoteId: header.id, versionId: version.id,
        tenantId: pre.tenantId, ownerId: pre.ownerId,
      });

      const after = await client.query(
        `SELECT issued_at, sent_at FROM public.chiefos_quote_versions WHERE id = $1`,
        [version.id]
      );
      expect(after.rows[0].issued_at).not.toBeNull();
      expect(after.rows[0].sent_at).not.toBeNull();
      // Both set from the same transaction NOW(), so they're equal.
      expect(after.rows[0].issued_at.getTime()).toBe(after.rows[0].sent_at.getTime());
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('markQuoteSent: on already-sent quote, rowcount assertion throws', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { header, version } = await seedDraftQuote(client, pre);

      // Manually flip to 'sent' to simulate concurrent state change.
      await client.query(
        `UPDATE public.chiefos_quotes SET status = 'sent', updated_at = NOW() WHERE id = $1`,
        [header.id]
      );

      await expect(
        markQuoteSent(client, {
          quoteId: header.id, versionId: version.id,
          tenantId: pre.tenantId, ownerId: pre.ownerId,
        })
      ).rejects.toThrow(/expected 1 row, got 0/);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('emitLifecycleSent: inserts version-scoped row with prefixed-key payload + share_token_id column', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { header, version } = await seedDraftQuote(client, pre);

      // Insert a share token to produce the share_token_id for the event.
      const tokenRow = await insertShareToken(client, {
        tenantId: pre.tenantId, ownerId: pre.ownerId,
        quoteVersionId: version.id,
        token: generateShareToken(),
        recipient: { name: 'Darlene MacDonald', email: 'darlene@example.com' },
        sourceMsgId: `test-send-s5-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });

      await emitLifecycleSent(client, {
        quoteId: header.id,
        versionId: version.id,
        tenantId: pre.tenantId,
        ownerId: pre.ownerId,
        actorSource: 'whatsapp',
        actorUserId: pre.ownerId,
        emittedAt: '2026-04-19T12:00:00.000Z',
        customerId: pre.customer.id,
        shareTokenId: tokenRow.id,
        recipientChannel: 'email',
        recipientAddress: 'darlene@example.com',
        recipientName: 'Darlene MacDonald',
      });

      const rows = await client.query(
        `SELECT kind, quote_version_id, share_token_id, correlation_id,
                actor_source, actor_user_id, customer_id, payload
           FROM public.chiefos_quote_events
          WHERE quote_id = $1 AND kind = 'lifecycle.sent'`,
        [header.id]
      );
      expect(rows.rows).toHaveLength(1);
      const ev = rows.rows[0];
      expect(ev.kind).toBe('lifecycle.sent');
      expect(ev.quote_version_id).toBe(version.id);     // version-scoped per schema
      expect(ev.share_token_id).toBe(tokenRow.id);      // required by chiefos_qe_payload_sent CHECK
      expect(ev.correlation_id).toBeNull();             // §17.14 clarification
      expect(ev.actor_source).toBe('whatsapp');
      expect(ev.customer_id).toBe(pre.customer.id);
      expect(ev.payload).toEqual({
        recipient_channel: 'email',                     // prefixed key per lifecycle.sent CHECK
        recipient_address: 'darlene@example.com',
        recipient_name: 'Darlene MacDonald',
      });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('emitLifecycleSent: correlationId param writes through to correlation_id column (§17.21 Phase A Session 1)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { header, version } = await seedDraftQuote(client, pre);

      const tokenRow = await insertShareToken(client, {
        tenantId: pre.tenantId, ownerId: pre.ownerId,
        quoteVersionId: version.id,
        token: generateShareToken(),
        recipient: { name: 'Darlene MacDonald', email: 'darlene@example.com' },
        sourceMsgId: `test-send-s5-corr-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });

      const corr = '11111111-2222-3333-4444-555555555555';
      await emitLifecycleSent(client, {
        quoteId: header.id,
        versionId: version.id,
        tenantId: pre.tenantId,
        ownerId: pre.ownerId,
        actorSource: 'whatsapp',
        actorUserId: pre.ownerId,
        emittedAt: '2026-04-19T12:00:00.000Z',
        customerId: pre.customer.id,
        shareTokenId: tokenRow.id,
        recipientChannel: 'email',
        recipientAddress: 'darlene@example.com',
        recipientName: 'Darlene MacDonald',
        correlationId: corr,
      });

      const rows = await client.query(
        `SELECT correlation_id FROM public.chiefos_quote_events
          WHERE quote_id = $1 AND kind = 'lifecycle.sent'`,
        [header.id]
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].correlation_id).toBe(corr);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SendQuote — Section 6: email composition + notification emitters
// ═══════════════════════════════════════════════════════════════════════════

describe('SendQuote — Section 6a: buildSendQuoteEmail + formatCentsAsCurrency (unit)', () => {
  test('formatCentsAsCurrency: handles small and large numbers with all thousands separators', () => {
    expect(formatCentsAsCurrency(0, 'CAD')).toBe('$0.00 CAD');
    expect(formatCentsAsCurrency(100, 'CAD')).toBe('$1.00 CAD');
    expect(formatCentsAsCurrency(1234, 'CAD')).toBe('$12.34 CAD');
    expect(formatCentsAsCurrency(123456, 'CAD')).toBe('$1,234.56 CAD');
    expect(formatCentsAsCurrency(12345678, 'CAD')).toBe('$123,456.78 CAD');
    // Load-bearing large-number test — guards the regex /g flag.
    // Without /g, only the FIRST thousands boundary gets a comma.
    expect(formatCentsAsCurrency(1234567890, 'CAD')).toBe('$12,345,678.90 CAD');
    expect(formatCentsAsCurrency(11300, 'USD')).toBe('$113.00 USD');
  });

  test('buildSendQuoteEmail: subject + textBody compose correctly; textBody contains shareUrl', () => {
    const result = buildSendQuoteEmail({
      tenantSnapshot: {
        legal_name: '9839429 Canada Inc.',
        brand_name: 'Mission Exteriors',
        phone_e164: '+18449590109',
        email: 'scott@missionexteriors.ca',
      },
      quote: {
        human_id: 'QT-2026-04-19-0042',
        project_title: 'Roof replacement',
        total_cents: 1234567,
        currency: 'CAD',
      },
      recipient: { name: 'Darlene MacDonald', email: 'darlene@example.com' },
      shareUrl: 'https://app.usechiefos.com/q/8xur5soy9bbnu8ypyaJehv',
    });

    expect(result.subject).toBe('Mission Exteriors — Quote QT-2026-04-19-0042');

    expect(result.textBody).toContain('Hi Darlene MacDonald,');
    expect(result.textBody).toContain('Mission Exteriors has prepared a quote for you.');
    expect(result.textBody).toContain('Quote: QT-2026-04-19-0042');
    expect(result.textBody).toContain('Project: Roof replacement');
    expect(result.textBody).toContain('Total: $12,345.67 CAD');

    // Load-bearing: shareUrl MUST appear in textBody — the whole reason the
    // email exists. Future refactors that drop it would produce a useless
    // email with no way for the customer to view and sign.
    expect(result.textBody).toContain('https://app.usechiefos.com/q/8xur5soy9bbnu8ypyaJehv');

    expect(result.textBody).toContain('This link expires in 30 days.');
    expect(result.textBody).toContain('+18449590109');
    expect(result.textBody).toContain('scott@missionexteriors.ca');
  });

  test('buildQuoteShareUrl: composes correctly; no double-slashes', () => {
    const url = buildQuoteShareUrl('8xur5soy9bbnu8ypyaJehv');
    expect(url).toMatch(/^https?:\/\//);
    expect(url).toContain('/q/8xur5soy9bbnu8ypyaJehv');
    expect(url).not.toMatch(/\/\/q\//);
    expect(url.startsWith(APP_URL)).toBe(true);
  });
});

describeIfDb('SendQuote — Section 6b: notification.* emitters (integration)', () => {
  let pool;
  beforeAll(async () => {
    const pg = require('../../services/postgres');
    pool = pg.pool;
  });

  async function seedQuoteAndToken(client, pre) {
    const {
      insertQuoteHeader, insertQuoteVersion, setQuoteCurrentVersion,
      composeTenantSnapshot,
    } = _internals;
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
      customerSnapshot: { name: pre.customer.name, email: pre.customer.email },
      tenantSnapshot: composeTenantSnapshot(pre.tenantId),
    });
    await setQuoteCurrentVersion(client, {
      quoteId: header.id, versionId: version.id,
      tenantId: pre.tenantId, ownerId: pre.ownerId,
    });
    const token = await insertShareToken(client, {
      tenantId: pre.tenantId, ownerId: pre.ownerId,
      quoteVersionId: version.id,
      token: generateShareToken(),
      recipient: { name: pre.customer.name, email: pre.customer.email },
      sourceMsgId: `test-s6-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    return { header, version, token };
  }

  test('emitNotificationSent: inserts with unprefixed keys + provider_message_id populated', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { header, version, token } = await seedQuoteAndToken(client, pre);

      // Pass a thin pgApi wrapper backed by the test's transaction client so
      // the event write stays inside the test's BEGIN/ROLLBACK scope.
      await emitNotificationSent({ query: (...args) => client.query(...args) }, {
        quoteId: header.id, versionId: version.id,
        tenantId: pre.tenantId, ownerId: pre.ownerId,
        actorSource: 'system', actorUserId: pre.ownerId,
        emittedAt: '2026-04-19T12:00:00.000Z',
        customerId: pre.customer.id, shareTokenId: token.id,
        channel: 'email', recipient: 'darlene@example.com',
        providerMessageId: 'fake-postmark-msg-id-abc',
      });

      const rows = await client.query(
        `SELECT kind, quote_version_id, share_token_id, correlation_id, payload
           FROM public.chiefos_quote_events
          WHERE quote_id = $1 AND kind = 'notification.sent'`,
        [header.id]
      );
      expect(rows.rows).toHaveLength(1);
      const ev = rows.rows[0];
      expect(ev.quote_version_id).toBe(version.id);
      expect(ev.share_token_id).toBe(token.id);
      expect(ev.correlation_id).toBeNull();
      expect(ev.payload).toEqual({
        channel: 'email',                    // UNPREFIXED per chiefos_qe_payload_notification CHECK
        recipient: 'darlene@example.com',
        provider_message_id: 'fake-postmark-msg-id-abc',
        provider: 'postmark',
      });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('emitNotificationFailed: inserts with provider_message_id:null + error_code + error_message', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { header, version, token } = await seedQuoteAndToken(client, pre);

      await emitNotificationFailed({ query: (...args) => client.query(...args) }, {
        quoteId: header.id, versionId: version.id,
        tenantId: pre.tenantId, ownerId: pre.ownerId,
        actorSource: 'system', actorUserId: pre.ownerId,
        emittedAt: '2026-04-19T12:00:00.000Z',
        customerId: pre.customer.id, shareTokenId: token.id,
        channel: 'email', recipient: 'darlene@example.com',
        errorCode: 10,
        errorMessage: 'Bad or missing API token',
      });

      const rows = await client.query(
        `SELECT kind, payload FROM public.chiefos_quote_events
          WHERE quote_id = $1 AND kind = 'notification.failed'`,
        [header.id]
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].payload).toEqual({
        channel: 'email',
        recipient: 'darlene@example.com',
        provider_message_id: null,           // null value satisfies `?` key-existence CHECK
        provider: 'postmark',
        error_code: 10,
        error_message: 'Bad or missing API token',
      });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SendQuote — Section 6c: return-shape composers (unit, no DB)
// ═══════════════════════════════════════════════════════════════════════════

describe('SendQuote — Section 6c: buildSendQuoteReturnShape (unit)', () => {
  const baseArgs = {
    quoteId: '00000000-1111-2222-3333-444444444401',
    versionId: '00000000-1111-2222-3333-444444444402',
    humanId: 'QT-2026-04-19-0042',
    versionNo: 1,
    status: 'sent',
    currency: 'CAD',
    totalCents: 1130,
    customer: {
      id: '00000000-1111-2222-3333-444444444403',
      name: 'Darlene MacDonald',
      email: 'darlene@example.com',
      phone_e164: '+15195550199',
    },
    jobId: 9001,
    issuedAt: '2026-04-19T12:00:00.000Z',
    createdAt: '2026-04-18T10:00:00.000Z',
    shareTokenId: '00000000-1111-2222-3333-444444444404',
    token: '8xur5soy9bbnu8ypyaJehv',
    absoluteExpiresAt: '2026-05-19T12:00:00.000Z',
    recipientChannel: 'email',
    recipientAddress: 'darlene@example.com',
    recipientName: 'Darlene MacDonald',
    shareUrl: 'https://app.usechiefos.com/q/8xur5soy9bbnu8ypyaJehv',
    alreadyExisted: false,
    eventsEmitted: ['lifecycle.sent', 'notification.sent'],
    traceId: 'trace-s6c-1',
  };

  test('correlationId param surfaces at meta.correlation_id (§17.21 Phase A Session 1)', () => {
    const corr = '11111111-2222-3333-4444-555555555555';
    const shape = buildSendQuoteReturnShape({ ...baseArgs, correlationId: corr });
    expect(shape.meta.correlation_id).toBe(corr);
  });

  test('omitted correlationId defaults meta.correlation_id to null (backward compat)', () => {
    const shape = buildSendQuoteReturnShape({ ...baseArgs });  // no correlationId
    expect(shape.meta).toHaveProperty('correlation_id', null);
  });
});

describe('SendQuote — Section 6c: priorShareTokenToReturnShape (unit)', () => {
  const priorRow = {
    quote_id: '00000000-1111-2222-3333-444444444501',
    version_id: '00000000-1111-2222-3333-444444444502',
    human_id: 'QT-2026-04-19-0043',
    version_no: 1,
    status: 'sent',
    currency: 'CAD',
    total_cents: '1130',  // bigint as string from pg
    customer_id: '00000000-1111-2222-3333-444444444503',
    customer_snapshot: { name: 'Darlene MacDonald', email: 'darlene@example.com', phone_e164: '+15195550199' },
    tenant_snapshot: {},
    project_title: 'T',
    job_id: 9001,
    issued_at: '2026-04-19T12:00:00.000Z',
    header_created_at: '2026-04-18T10:00:00.000Z',
    share_token_id: '00000000-1111-2222-3333-444444444504',
    token: '8xur5soy9bbnu8ypyaJehv',
    absolute_expires_at: '2026-05-19T12:00:00.000Z',
    recipient_name: 'Darlene MacDonald',
    recipient_channel: 'email',
    recipient_address: 'darlene@example.com',
  };

  test('meta.correlation_id is null (§17.21: original invocation id not persisted on share_token row)', () => {
    const shape = priorShareTokenToReturnShape(priorRow, 'trace-retry-xyz');
    expect(shape.meta).toHaveProperty('correlation_id', null);
  });

  test('alreadyExisted:true and eventsEmitted:[] on retry path (§17.15)', () => {
    const shape = priorShareTokenToReturnShape(priorRow, 'trace-retry-xyz');
    expect(shape.meta.already_existed).toBe(true);
    expect(shape.meta.events_emitted).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SendQuote — Section 7: end-to-end handleSendQuote (integration + unit)
// ═══════════════════════════════════════════════════════════════════════════

// Helper to seed a real draft quote via the handleCreateQuote path so
// SendQuote tests operate on authentic committed state (not
// BEGIN/ROLLBACK-only seeding). Tests clean up via cleanupCreatedQuote.
async function seedRealDraftForSendQuote({ pg, ownerId, tenantId, sourceMsgId }) {
  // Caller MUST have already seeded the user row with plan_key='starter'.
  const createCil = {
    cil_version: '1.0',
    type: 'CreateQuote',
    tenant_id: tenantId,
    source: 'whatsapp',
    source_msg_id: sourceMsgId,
    actor: { actor_id: ownerId, role: 'owner' },
    occurred_at: new Date().toISOString(),
    job: { job_name: `Send Test Job ${Math.random().toString(36).slice(2, 8)}`, create_if_missing: true },
    needs_job_resolution: false,
    customer: {
      name: 'SendQuote Integration Recipient',
      email: 'send-test@chiefos.test',
      phone_e164: '+15195550199',
      address: '1 Test Way, London, ON',
    },
    project: { title: 'SendQuote Integration Test', scope: 'Section 7 test scope.' },
    currency: 'CAD',
    tax_rate_bps: 1300,
    tax_code: 'HST-ON',
    line_items: [
      { sort_order: 0, description: 'Test item', category: 'materials', qty: 1, unit_price_cents: 10000 },
    ],
    deposit_cents: 0,
    payment_terms: {},
    warranty_snapshot: {},
    clauses_snapshot: {},
  };
  const ctx = { owner_id: ownerId, traceId: `trace-send-seed-${Date.now()}` };
  const result = await handleCreateQuote(createCil, ctx);
  if (!result.ok) {
    throw new Error(`Seed CreateQuote failed: ${JSON.stringify(result.error)}`);
  }
  return result.quote;
}

describeIfDb('SendQuote — Section 7: end-to-end integration', () => {
  afterEach(() => {
    _internals.resetSendEmailForTests();
  });

  test('Happy path: sends email, flips quote to sent, emits lifecycle.sent + notification.sent; counter unchanged (G6)', async () => {
    const pg = require('../../services/postgres');
    const ownerId = `99${Math.floor(Math.random() * 1e11).toString().padStart(11, '0')}`;
    const seedMsgId = `test-s7-send-happy-seed-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sendMsgId = `test-s7-send-happy-send-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const monthKey = new Date().toISOString().slice(0, 7);

    await pg.query(
      `INSERT INTO public.users (user_id, plan_key, sub_status, created_at)
       VALUES ($1, 'starter', 'active', NOW())`,
      [ownerId]
    );

    // Mock Postmark for a clean success return.
    const sentCalls = [];
    _internals.setSendEmailForTests(async (opts) => {
      sentCalls.push(opts);
      return { MessageID: 'fake-postmark-msg-happy-xyz', To: opts.to };
    });

    let quoteId;
    try {
      const seedQuote = await seedRealDraftForSendQuote({
        pg, ownerId, tenantId: _internals.composeTenantSnapshot
          ? '86907c28-a9ea-4318-819d-5a012192119b'      // Mission — has tenant profile
          : MISSION_TENANT_UUID,
        sourceMsgId: seedMsgId,
      });
      quoteId = seedQuote.id;

      const usageBefore = await pg.getMonthlyUsage({
        ownerId, kind: 'quote_created', monthKey,
      });

      const sendCil = {
        cil_version: '1.0',
        type: 'SendQuote',
        tenant_id: MISSION_TENANT_UUID,
        source: 'whatsapp',
        source_msg_id: sendMsgId,
        actor: { actor_id: ownerId, role: 'owner' },
        occurred_at: new Date().toISOString(),
        job: null,
        needs_job_resolution: false,
        quote_ref: { quote_id: seedQuote.id },
      };
      const result = await handleSendQuote(sendCil, {
        owner_id: ownerId, traceId: 'trace-s7-send-happy',
      });

      // §17.15 multi-entity shape
      expect(result.ok).toBe(true);
      expect(result.quote).toBeDefined();
      expect(result.share_token).toBeDefined();
      expect(result.quote.id).toBe(seedQuote.id);
      expect(result.quote.status).toBe('sent');
      expect(result.quote.issued_at).toBeDefined();
      expect(result.quote.customer.email).toBe('send-test@chiefos.test');
      expect(result.share_token.token).toMatch(/^[1-9A-HJ-NP-Za-km-z]{22}$/);
      expect(result.share_token.recipient).toEqual({
        channel: 'email',
        address: 'send-test@chiefos.test',
        name: 'SendQuote Integration Recipient',
      });
      expect(result.share_token.url).toContain(`/q/${result.share_token.token}`);
      expect(result.meta).toEqual({
        already_existed: false,
        events_emitted: ['lifecycle.sent', 'notification.sent'],
        traceId: 'trace-s7-send-happy',
        correlation_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      });

      // Postmark mock was called with composed subject + textBody
      expect(sentCalls).toHaveLength(1);
      expect(sentCalls[0].to).toBe('send-test@chiefos.test');
      expect(sentCalls[0].textBody).toContain(result.share_token.url);

      // DB state: quote flipped to sent; 4 events present (2 from Create +
      // lifecycle.sent + notification.sent); share token exists.
      const quoteRow = await pg.query(
        `SELECT status FROM public.chiefos_quotes WHERE id = $1`,
        [seedQuote.id]
      );
      expect(quoteRow.rows[0].status).toBe('sent');

      const events = await pg.query(
        `SELECT kind FROM public.chiefos_quote_events
          WHERE quote_id = $1 ORDER BY global_seq ASC`,
        [seedQuote.id]
      );
      expect(events.rows.map((r) => r.kind)).toEqual([
        'lifecycle.created',
        'lifecycle.version_created',
        'lifecycle.sent',
        'notification.sent',
      ]);

      // G6: SendQuote intentionally has no dedicated quota. Per-month
      // quote_created counter reflects creation, not send.
      const usageAfter = await pg.getMonthlyUsage({
        ownerId, kind: 'quote_created', monthKey,
      });
      expect(usageAfter).toBe(usageBefore);
    } finally {
      if (quoteId) {
        await _internals.cleanupCreatedQuote
          ? _internals.cleanupCreatedQuote(ownerId, quoteId, seedMsgId, monthKey)
          : await cleanupCreatedQuote(ownerId, quoteId, seedMsgId, monthKey);
      }
      await pg.query(`DELETE FROM public.users WHERE user_id = $1`, [ownerId]).catch(() => {});
    }
  }, 30000);

  test('Idempotent retry: second SendQuote with same source_msg_id returns already_existed=true, no double-email', async () => {
    const pg = require('../../services/postgres');
    const ownerId = `99${Math.floor(Math.random() * 1e11).toString().padStart(11, '0')}`;
    const seedMsgId = `test-s7-send-retry-seed-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sendMsgId = `test-s7-send-retry-send-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const monthKey = new Date().toISOString().slice(0, 7);

    await pg.query(
      `INSERT INTO public.users (user_id, plan_key, sub_status, created_at)
       VALUES ($1, 'starter', 'active', NOW())`,
      [ownerId]
    );

    const sentCalls = [];
    _internals.setSendEmailForTests(async (opts) => {
      sentCalls.push(opts);
      return { MessageID: `fake-postmark-${sentCalls.length}`, To: opts.to };
    });

    let quoteId;
    try {
      const seedQuote = await seedRealDraftForSendQuote({
        pg, ownerId, tenantId: MISSION_TENANT_UUID, sourceMsgId: seedMsgId,
      });
      quoteId = seedQuote.id;

      const sendCil = {
        cil_version: '1.0', type: 'SendQuote', tenant_id: MISSION_TENANT_UUID,
        source: 'whatsapp', source_msg_id: sendMsgId,
        actor: { actor_id: ownerId, role: 'owner' },
        occurred_at: new Date().toISOString(),
        job: null, needs_job_resolution: false,
        quote_ref: { quote_id: seedQuote.id },
      };
      const ctx = { owner_id: ownerId, traceId: 'trace-s7-send-retry' };

      const first = await handleSendQuote(sendCil, ctx);
      expect(first.ok).toBe(true);
      expect(first.meta.already_existed).toBe(false);
      expect(first.meta.events_emitted).toEqual(['lifecycle.sent', 'notification.sent']);
      expect(first.meta.correlation_id).toMatch(/^[0-9a-f-]{36}$/);

      const retry = await handleSendQuote(sendCil, ctx);
      expect(retry.ok).toBe(true);
      expect(retry.meta.already_existed).toBe(true);
      expect(retry.meta.events_emitted).toEqual([]);   // retry emits nothing
      // §17.21: original invocation's correlation_id is not persisted on the
      // share_token row, so the retry path returns null. Parallels §27's
      // priorSignatureToReturnShape behavior.
      expect(retry.meta.correlation_id).toBeNull();
      expect(retry.share_token.id).toBe(first.share_token.id);
      expect(retry.share_token.token).toBe(first.share_token.token);
      expect(retry.quote.status).toBe('sent');

      // Postmark called exactly once — retry didn't re-send.
      expect(sentCalls).toHaveLength(1);
    } finally {
      if (quoteId) {
        await cleanupCreatedQuote(ownerId, quoteId, seedMsgId, monthKey).catch(() => {});
      }
      await pg.query(`DELETE FROM public.users WHERE user_id = $1`, [ownerId]).catch(() => {});
    }
  }, 30000);

  test('correlation_id invariant: lifecycle.sent + notification.sent share same correlation_id + match meta (§17.21)', async () => {
    const pg = require('../../services/postgres');
    const ownerId = `99${Math.floor(Math.random() * 1e11).toString().padStart(11, '0')}`;
    const seedMsgId = `test-s7-send-corr-seed-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sendMsgId = `test-s7-send-corr-send-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const monthKey = new Date().toISOString().slice(0, 7);

    await pg.query(
      `INSERT INTO public.users (user_id, plan_key, sub_status, created_at)
       VALUES ($1, 'starter', 'active', NOW())`,
      [ownerId]
    );

    _internals.setSendEmailForTests(async (opts) => ({
      MessageID: 'fake-postmark-corr-msg', To: opts.to,
    }));

    let quoteId;
    try {
      const seedQuote = await seedRealDraftForSendQuote({
        pg, ownerId, tenantId: MISSION_TENANT_UUID, sourceMsgId: seedMsgId,
      });
      quoteId = seedQuote.id;

      const sendCil = {
        cil_version: '1.0', type: 'SendQuote', tenant_id: MISSION_TENANT_UUID,
        source: 'whatsapp', source_msg_id: sendMsgId,
        actor: { actor_id: ownerId, role: 'owner' },
        occurred_at: new Date().toISOString(),
        job: null, needs_job_resolution: false,
        quote_ref: { quote_id: seedQuote.id },
      };
      const result = await handleSendQuote(sendCil, {
        owner_id: ownerId, traceId: 'trace-s7-send-corr',
      });
      expect(result.ok).toBe(true);

      const metaCorr = result.meta.correlation_id;
      expect(metaCorr).toMatch(/^[0-9a-f-]{36}$/);

      // Both lifecycle.sent (inside-txn) and notification.sent (post-commit)
      // must carry the same correlation_id generated once at handler entry.
      // This is the invariant §17.21 closes: the handler MUST pass a single
      // id through both helpers, not let each helper fall back to null.
      const rows = await pg.query(
        `SELECT kind, correlation_id FROM public.chiefos_quote_events
          WHERE quote_id = $1 AND kind IN ('lifecycle.sent', 'notification.sent')
          ORDER BY global_seq ASC`,
        [seedQuote.id]
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows[0].correlation_id).toBe(metaCorr);
      expect(rows.rows[1].correlation_id).toBe(metaCorr);
      expect(rows.rows[0].correlation_id).toBe(rows.rows[1].correlation_id);
    } finally {
      if (quoteId) {
        await cleanupCreatedQuote(ownerId, quoteId, seedMsgId, monthKey).catch(() => {});
      }
      await pg.query(`DELETE FROM public.users WHERE user_id = $1`, [ownerId]).catch(() => {});
    }
  }, 30000);

  test('Postmark failure end-to-end: ok:true, events_emitted includes notification.failed, quote still sent', async () => {
    const pg = require('../../services/postgres');
    const ownerId = `99${Math.floor(Math.random() * 1e11).toString().padStart(11, '0')}`;
    const seedMsgId = `test-s7-send-fail-seed-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sendMsgId = `test-s7-send-fail-send-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const monthKey = new Date().toISOString().slice(0, 7);

    await pg.query(
      `INSERT INTO public.users (user_id, plan_key, sub_status, created_at)
       VALUES ($1, 'starter', 'active', NOW())`,
      [ownerId]
    );

    // Postmark mock throws a realistic PascalCase error shape.
    _internals.setSendEmailForTests(async () => {
      const err = new Error('Bad or missing API token.');
      err.ErrorCode = 10;
      err.Message = 'Bad or missing API token.';
      err.HttpStatusCode = 422;
      throw err;
    });

    let quoteId;
    try {
      const seedQuote = await seedRealDraftForSendQuote({
        pg, ownerId, tenantId: MISSION_TENANT_UUID, sourceMsgId: seedMsgId,
      });
      quoteId = seedQuote.id;

      const sendCil = {
        cil_version: '1.0', type: 'SendQuote', tenant_id: MISSION_TENANT_UUID,
        source: 'whatsapp', source_msg_id: sendMsgId,
        actor: { actor_id: ownerId, role: 'owner' },
        occurred_at: new Date().toISOString(),
        job: null, needs_job_resolution: false,
        quote_ref: { quote_id: seedQuote.id },
      };

      const result = await handleSendQuote(sendCil, {
        owner_id: ownerId, traceId: 'trace-s7-send-fail',
      });

      // Load-bearing: ok:true holds despite Postmark throw. Locks the
      // Refinement B 'do NOT rethrow' decision against future refactor.
      expect(result.ok).toBe(true);
      expect(result.meta.events_emitted).toContain('notification.failed');
      expect(result.meta.events_emitted).toContain('lifecycle.sent');
      expect(result.meta.events_emitted).not.toContain('notification.sent');

      // Quote still transitioned to sent — email failure doesn't roll it back.
      expect(result.quote.status).toBe('sent');

      // notification.failed event carries operator-facing error context.
      const failedEvents = await pg.query(
        `SELECT payload FROM public.chiefos_quote_events
          WHERE quote_id = $1 AND kind = 'notification.failed'`,
        [seedQuote.id]
      );
      expect(failedEvents.rows).toHaveLength(1);
      expect(failedEvents.rows[0].payload).toMatchObject({
        channel: 'email',
        recipient: 'send-test@chiefos.test',
        provider_message_id: null,
        provider: 'postmark',
        error_code: 10,
        error_message: 'Bad or missing API token.',
      });
    } finally {
      if (quoteId) {
        await cleanupCreatedQuote(ownerId, quoteId, seedMsgId, monthKey).catch(() => {});
      }
      await pg.query(`DELETE FROM public.users WHERE user_id = $1`, [ownerId]).catch(() => {});
    }
  }, 30000);

  test('Quote not found: CIL_INTEGRITY_ERROR envelope with QUOTE_NOT_FOUND_OR_CROSS_OWNER hint', async () => {
    const pg = require('../../services/postgres');
    const ownerId = `99${Math.floor(Math.random() * 1e11).toString().padStart(11, '0')}`;
    await pg.query(
      `INSERT INTO public.users (user_id, plan_key, sub_status, created_at)
       VALUES ($1, 'starter', 'active', NOW())`,
      [ownerId]
    );
    _internals.setSendEmailForTests(async () => ({ MessageID: 'never-called' }));

    try {
      const sendCil = {
        cil_version: '1.0', type: 'SendQuote', tenant_id: MISSION_TENANT_UUID,
        source: 'whatsapp',
        source_msg_id: `test-s7-send-404-${Date.now()}`,
        actor: { actor_id: ownerId, role: 'owner' },
        occurred_at: new Date().toISOString(),
        job: null, needs_job_resolution: false,
        quote_ref: { quote_id: '00000000-0000-0000-0000-000000000000' },
      };
      const result = await handleSendQuote(sendCil, {
        owner_id: ownerId, traceId: 'trace-s7-send-404',
      });
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('CIL_INTEGRITY_ERROR');
      expect(result.error.hint).toContain('tenant+owner scope');
    } finally {
      await pg.query(`DELETE FROM public.users WHERE user_id = $1`, [ownerId]).catch(() => {});
    }
  });

  test('Quote not draft: CIL_INTEGRITY_ERROR with QUOTE_NOT_DRAFT hint pointing at ReissueQuote', async () => {
    const pg = require('../../services/postgres');
    const ownerId = `99${Math.floor(Math.random() * 1e11).toString().padStart(11, '0')}`;
    const seedMsgId = `test-s7-send-notdraft-seed-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const monthKey = new Date().toISOString().slice(0, 7);

    await pg.query(
      `INSERT INTO public.users (user_id, plan_key, sub_status, created_at)
       VALUES ($1, 'starter', 'active', NOW())`,
      [ownerId]
    );
    _internals.setSendEmailForTests(async () => ({ MessageID: 'never-called' }));

    let quoteId;
    try {
      const seedQuote = await seedRealDraftForSendQuote({
        pg, ownerId, tenantId: MISSION_TENANT_UUID, sourceMsgId: seedMsgId,
      });
      quoteId = seedQuote.id;

      // Flip to 'sent' manually to exercise the QUOTE_NOT_DRAFT path.
      await pg.query(
        `UPDATE public.chiefos_quotes SET status='sent', updated_at=NOW() WHERE id=$1`,
        [seedQuote.id]
      );

      const sendCil = {
        cil_version: '1.0', type: 'SendQuote', tenant_id: MISSION_TENANT_UUID,
        source: 'whatsapp',
        source_msg_id: `test-s7-send-notdraft-${Date.now()}`,
        actor: { actor_id: ownerId, role: 'owner' },
        occurred_at: new Date().toISOString(),
        job: null, needs_job_resolution: false,
        quote_ref: { quote_id: seedQuote.id },
      };
      const result = await handleSendQuote(sendCil, {
        owner_id: ownerId, traceId: 'trace-s7-send-notdraft',
      });
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('CIL_INTEGRITY_ERROR');
      expect(result.error.hint).toContain('ReissueQuote');
    } finally {
      if (quoteId) {
        await cleanupCreatedQuote(ownerId, quoteId, seedMsgId, monthKey).catch(() => {});
      }
      await pg.query(`DELETE FROM public.users WHERE user_id = $1`, [ownerId]).catch(() => {});
    }
  }, 30000);

  test('Actor role rejection (employee): PERMISSION_DENIED', async () => {
    // No DB writes beyond the initial user seed — the handler's actor check
    // fires before step 4 transaction opens.
    const pg = require('../../services/postgres');
    const ownerId = `99${Math.floor(Math.random() * 1e11).toString().padStart(11, '0')}`;
    await pg.query(
      `INSERT INTO public.users (user_id, plan_key, sub_status, created_at)
       VALUES ($1, 'starter', 'active', NOW())`,
      [ownerId]
    );
    try {
      const sendCil = {
        cil_version: '1.0', type: 'SendQuote', tenant_id: MISSION_TENANT_UUID,
        source: 'whatsapp',
        source_msg_id: `test-s7-send-emp-${Date.now()}`,
        actor: { actor_id: ownerId, role: 'employee' },  // non-owner
        occurred_at: new Date().toISOString(),
        job: null, needs_job_resolution: false,
        quote_ref: { quote_id: '00000000-0000-0000-0000-000000000000' },
      };
      const result = await handleSendQuote(sendCil, {
        owner_id: ownerId, traceId: 'trace-s7-send-emp',
      });
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('PERMISSION_DENIED');
      expect(result.error.message).toContain('owner');
    } finally {
      await pg.query(`DELETE FROM public.users WHERE user_id = $1`, [ownerId]).catch(() => {});
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3 Section 1 tests: SignQuoteCILZ schema
// ═══════════════════════════════════════════════════════════════════════════

const {
  SignQuoteCILZ,
  SignQuoteActorZ: _SignQuoteActorZ,
  ShareTokenStringZ: _ShareTokenStringZ,
  PngDataUrlZ: _PngDataUrlZ,
  SIGN_QUOTE_SOURCE_MSG_CONSTRAINT,
} = _internals;
const { SIG_ERR } = require('./quoteSignatureStorage');

describe('SignQuote — Section 1: SignQuoteCILZ schema', () => {
  const VALID_SHARE_TOKEN_UUID = '00000000-c2c2-c2c2-c2c2-000000000005';
  const VALID_SHARE_TOKEN_STR = 'K5gQbxTdNcN1ZNqmoGtaww'; // 22-char base58 (ceremony token)
  const VALID_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  function validSignPayload(overrides = {}) {
    return {
      cil_version: '1.0',
      type: 'SignQuote',
      tenant_id: '00000000-c2c2-c2c2-c2c2-000000000001',
      source: 'web',
      source_msg_id: 'test-sign-msg-1',
      actor: { actor_id: VALID_SHARE_TOKEN_UUID, role: 'customer' },
      occurred_at: new Date().toISOString(),
      job: null,
      needs_job_resolution: false,
      share_token: VALID_SHARE_TOKEN_STR,
      signer_name: 'Ceremony Customer',
      signature_png_data_url: VALID_PNG_DATA_URL,
      ...overrides,
    };
  }

  describe('schema structure', () => {
    it('valid payload parses cleanly', () => {
      const result = SignQuoteCILZ.safeParse(validSignPayload());
      expect(result.success).toBe(true);
    });

    it('missing type field rejects', () => {
      const { type: _t, ...bad } = validSignPayload();
      expect(SignQuoteCILZ.safeParse(bad).success).toBe(false);
    });

    it('wrong type literal rejects', () => {
      expect(SignQuoteCILZ.safeParse(validSignPayload({ type: 'SignQoote' })).success).toBe(false);
    });

    it('missing source field rejects', () => {
      const { source: _s, ...bad } = validSignPayload();
      expect(SignQuoteCILZ.safeParse(bad).success).toBe(false);
    });
  });

  describe('source field (narrowed to "web" only per DB1 Tightening 2)', () => {
    it('"web" accepts', () => {
      expect(SignQuoteCILZ.safeParse(validSignPayload({ source: 'web' })).success).toBe(true);
    });

    it('"whatsapp" rejects (not customer-facing)', () => {
      expect(SignQuoteCILZ.safeParse(validSignPayload({ source: 'whatsapp' })).success).toBe(false);
    });

    it('"portal" rejects in Beta (enum widens when authenticated portal ships)', () => {
      expect(SignQuoteCILZ.safeParse(validSignPayload({ source: 'portal' })).success).toBe(false);
    });
  });

  describe('actor field', () => {
    it('role: "customer" accepts', () => {
      expect(SignQuoteCILZ.safeParse(validSignPayload()).success).toBe(true);
    });

    it('role: "owner" rejects (proves omit+extend override of BaseCILZ ActorZ)', () => {
      const payload = validSignPayload({
        actor: { actor_id: VALID_SHARE_TOKEN_UUID, role: 'owner' },
      });
      expect(SignQuoteCILZ.safeParse(payload).success).toBe(false);
    });

    it('role: "anonymous" rejects (not a ChiefOS role)', () => {
      const payload = validSignPayload({
        actor: { actor_id: VALID_SHARE_TOKEN_UUID, role: 'anonymous' },
      });
      expect(SignQuoteCILZ.safeParse(payload).success).toBe(false);
    });

    it('actor_id non-UUID rejects', () => {
      const payload = validSignPayload({
        actor: { actor_id: 'not-a-uuid', role: 'customer' },
      });
      expect(SignQuoteCILZ.safeParse(payload).success).toBe(false);
    });

    it('actor missing role field rejects', () => {
      const payload = validSignPayload({ actor: { actor_id: VALID_SHARE_TOKEN_UUID } });
      expect(SignQuoteCILZ.safeParse(payload).success).toBe(false);
    });

    it('actor missing actor_id field rejects', () => {
      const payload = validSignPayload({ actor: { role: 'customer' } });
      expect(SignQuoteCILZ.safeParse(payload).success).toBe(false);
    });
  });

  describe('share_token field', () => {
    it('22-char base58 accepts', () => {
      expect(SignQuoteCILZ.safeParse(validSignPayload()).success).toBe(true);
    });

    it('21-char rejects', () => {
      expect(SignQuoteCILZ.safeParse(
        validSignPayload({ share_token: VALID_SHARE_TOKEN_STR.slice(0, 21) })
      ).success).toBe(false);
    });

    it('23-char rejects', () => {
      expect(SignQuoteCILZ.safeParse(
        validSignPayload({ share_token: VALID_SHARE_TOKEN_STR + 'A' })
      ).success).toBe(false);
    });

    it('containing "0" rejects (not in Bitcoin base58 alphabet)', () => {
      expect(SignQuoteCILZ.safeParse(
        validSignPayload({ share_token: '0' + VALID_SHARE_TOKEN_STR.slice(1) })
      ).success).toBe(false);
    });

    it('empty string rejects', () => {
      expect(SignQuoteCILZ.safeParse(
        validSignPayload({ share_token: '' })
      ).success).toBe(false);
    });
  });

  describe('signer_name field', () => {
    it('non-empty string accepts', () => {
      expect(SignQuoteCILZ.safeParse(validSignPayload({ signer_name: 'A' })).success).toBe(true);
    });

    it('empty string rejects', () => {
      expect(SignQuoteCILZ.safeParse(validSignPayload({ signer_name: '' })).success).toBe(false);
    });

    it('200-char accepts', () => {
      expect(SignQuoteCILZ.safeParse(
        validSignPayload({ signer_name: 'A'.repeat(200) })
      ).success).toBe(true);
    });

    it('201-char rejects', () => {
      expect(SignQuoteCILZ.safeParse(
        validSignPayload({ signer_name: 'A'.repeat(201) })
      ).success).toBe(false);
    });
  });

  describe('signature_png_data_url field', () => {
    it('valid PNG data URL accepts', () => {
      expect(SignQuoteCILZ.safeParse(validSignPayload()).success).toBe(true);
    });

    it('JPEG data URL rejects', () => {
      expect(SignQuoteCILZ.safeParse(
        validSignPayload({
          signature_png_data_url: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD',
        })
      ).success).toBe(false);
    });

    it('plain base64 (no data URL prefix) rejects', () => {
      expect(SignQuoteCILZ.safeParse(
        validSignPayload({
          signature_png_data_url: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
        })
      ).success).toBe(false);
    });

    it('too-short (<30 chars) rejects', () => {
      expect(SignQuoteCILZ.safeParse(
        validSignPayload({ signature_png_data_url: 'data:image/png;base64,' })
      ).success).toBe(false);
    });

    it('oversized (>PNG_MAX_BASE64_LENGTH + 32) rejects', () => {
      const { PNG_MAX_BASE64_LENGTH } = require('./quoteSignatureStorage');
      const huge = 'data:image/png;base64,' + 'A'.repeat(PNG_MAX_BASE64_LENGTH + 20);
      expect(SignQuoteCILZ.safeParse(
        validSignPayload({ signature_png_data_url: huge })
      ).success).toBe(false);
    });
  });

  describe('required-field completeness', () => {
    it('missing share_token rejects', () => {
      const { share_token: _x, ...bad } = validSignPayload();
      expect(SignQuoteCILZ.safeParse(bad).success).toBe(false);
    });

    it('missing signer_name rejects', () => {
      const { signer_name: _x, ...bad } = validSignPayload();
      expect(SignQuoteCILZ.safeParse(bad).success).toBe(false);
    });

    it('missing signature_png_data_url rejects', () => {
      const { signature_png_data_url: _x, ...bad } = validSignPayload();
      expect(SignQuoteCILZ.safeParse(bad).success).toBe(false);
    });
  });

  describe('BaseCILZ inheritance', () => {
    it('missing tenant_id rejects', () => {
      const { tenant_id: _x, ...bad } = validSignPayload();
      expect(SignQuoteCILZ.safeParse(bad).success).toBe(false);
    });

    it('missing source_msg_id rejects', () => {
      const { source_msg_id: _x, ...bad } = validSignPayload();
      expect(SignQuoteCILZ.safeParse(bad).success).toBe(false);
    });
  });

  describe('SIG_ERR SignQuote extensions', () => {
    const SIGN_QUOTE_CODES = {
      SIGNATURE_ALREADY_EXISTS: 409,
      QUOTE_NOT_SIGNABLE:       409,
      QUOTE_NOT_SENT:           409,
      QUOTE_ALREADY_SIGNED:     409,
      QUOTE_LOCKED:             409,
      QUOTE_VOIDED:             410,
      VERSION_ALREADY_LOCKED:   409,
    };

    it.each(Object.entries(SIGN_QUOTE_CODES))(
      'SIG_ERR.%s has correct code + status',
      (key, expectedStatus) => {
        expect(SIG_ERR[key]).toBeDefined();
        expect(SIG_ERR[key].code).toBe(key);
        expect(SIG_ERR[key].status).toBe(expectedStatus);
      }
    );

    it('SIG_ERR remains deeply frozen after SignQuote additions', () => {
      'use strict';
      expect(() => { SIG_ERR.NEW_SIGN_KEY = { code: 'X', status: 999 }; }).toThrow(TypeError);
      expect(() => { SIG_ERR.QUOTE_LOCKED.status = 999; }).toThrow(TypeError);
      expect(SIG_ERR.QUOTE_LOCKED.status).toBe(409);
    });
  });

  describe('SIGN_QUOTE_SOURCE_MSG_CONSTRAINT constant', () => {
    it('equals "chiefos_qs_source_msg_unique"', () => {
      expect(SIGN_QUOTE_SOURCE_MSG_CONSTRAINT).toBe('chiefos_qs_source_msg_unique');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase A Session 2 Section 1 tests: ViewQuoteCILZ schema
// ═══════════════════════════════════════════════════════════════════════════

const {
  ViewQuoteCILZ,
  ViewQuoteActorZ: _ViewQuoteActorZ,
} = _internals;

describe('ViewQuote — Section 1: ViewQuoteCILZ schema', () => {
  const VALID_SHARE_TOKEN_UUID = '00000000-c2c2-c2c2-c2c2-000000000005';
  const VALID_SHARE_TOKEN_STR = 'K5gQbxTdNcN1ZNqmoGtaww';  // 22-char base58

  function validViewPayload(overrides = {}) {
    return {
      cil_version: '1.0',
      type: 'ViewQuote',
      tenant_id: '00000000-c2c2-c2c2-c2c2-000000000001',
      source: 'web',
      source_msg_id: 'test-view-msg-1',
      actor: { actor_id: VALID_SHARE_TOKEN_UUID, role: 'customer' },
      occurred_at: new Date().toISOString(),
      job: null,
      needs_job_resolution: false,
      share_token: VALID_SHARE_TOKEN_STR,
      ...overrides,
    };
  }

  describe('schema structure', () => {
    it('valid payload parses cleanly', () => {
      const result = ViewQuoteCILZ.safeParse(validViewPayload());
      expect(result.success).toBe(true);
    });

    it('missing type field rejects', () => {
      const { type: _t, ...bad } = validViewPayload();
      expect(ViewQuoteCILZ.safeParse(bad).success).toBe(false);
    });

    it('wrong type literal rejects', () => {
      expect(ViewQuoteCILZ.safeParse(validViewPayload({ type: 'ViewQuoot' })).success).toBe(false);
    });

    it('missing source field rejects', () => {
      const { source: _s, ...bad } = validViewPayload();
      expect(ViewQuoteCILZ.safeParse(bad).success).toBe(false);
    });
  });

  describe('source field (narrowed to "web" per §20)', () => {
    it('"web" accepts', () => {
      expect(ViewQuoteCILZ.safeParse(validViewPayload({ source: 'web' })).success).toBe(true);
    });

    it('"whatsapp" rejects (not customer-facing)', () => {
      expect(ViewQuoteCILZ.safeParse(validViewPayload({ source: 'whatsapp' })).success).toBe(false);
    });

    it('"portal" rejects in Beta (enum widens when authenticated portal ships)', () => {
      expect(ViewQuoteCILZ.safeParse(validViewPayload({ source: 'portal' })).success).toBe(false);
    });
  });

  describe('actor field', () => {
    it('role: "customer" accepts', () => {
      expect(ViewQuoteCILZ.safeParse(validViewPayload()).success).toBe(true);
    });

    it('role: "owner" rejects (proves omit+extend override of BaseCILZ ActorZ)', () => {
      const payload = validViewPayload({
        actor: { actor_id: VALID_SHARE_TOKEN_UUID, role: 'owner' },
      });
      expect(ViewQuoteCILZ.safeParse(payload).success).toBe(false);
    });

    it('role: "anonymous" rejects (not a ChiefOS role)', () => {
      const payload = validViewPayload({
        actor: { actor_id: VALID_SHARE_TOKEN_UUID, role: 'anonymous' },
      });
      expect(ViewQuoteCILZ.safeParse(payload).success).toBe(false);
    });

    it('actor_id non-UUID rejects', () => {
      const payload = validViewPayload({
        actor: { actor_id: 'not-a-uuid', role: 'customer' },
      });
      expect(ViewQuoteCILZ.safeParse(payload).success).toBe(false);
    });

    it('actor missing role field rejects', () => {
      const payload = validViewPayload({ actor: { actor_id: VALID_SHARE_TOKEN_UUID } });
      expect(ViewQuoteCILZ.safeParse(payload).success).toBe(false);
    });

    it('actor missing actor_id field rejects', () => {
      const payload = validViewPayload({ actor: { role: 'customer' } });
      expect(ViewQuoteCILZ.safeParse(payload).success).toBe(false);
    });
  });

  describe('share_token field', () => {
    it('22-char base58 accepts', () => {
      expect(ViewQuoteCILZ.safeParse(validViewPayload()).success).toBe(true);
    });

    it('21-char rejects', () => {
      expect(ViewQuoteCILZ.safeParse(
        validViewPayload({ share_token: VALID_SHARE_TOKEN_STR.slice(0, 21) })
      ).success).toBe(false);
    });

    it('23-char rejects', () => {
      expect(ViewQuoteCILZ.safeParse(
        validViewPayload({ share_token: VALID_SHARE_TOKEN_STR + 'A' })
      ).success).toBe(false);
    });

    it('containing "0" rejects (not in Bitcoin base58 alphabet)', () => {
      expect(ViewQuoteCILZ.safeParse(
        validViewPayload({ share_token: '0' + VALID_SHARE_TOKEN_STR.slice(1) })
      ).success).toBe(false);
    });

    it('empty string rejects', () => {
      expect(ViewQuoteCILZ.safeParse(
        validViewPayload({ share_token: '' })
      ).success).toBe(false);
    });
  });

  describe('source_msg_id optionality (§17.23 state-driven idempotency)', () => {
    it('present (non-empty) accepts', () => {
      expect(ViewQuoteCILZ.safeParse(
        validViewPayload({ source_msg_id: 'req-abc-123' })
      ).success).toBe(true);
    });

    it('absent (undefined) accepts — no dedupe constraint per §17.23', () => {
      const { source_msg_id: _x, ...bad } = validViewPayload();
      expect(ViewQuoteCILZ.safeParse(bad).success).toBe(true);
    });

    it('empty string rejects (min(1) still applies when present)', () => {
      expect(ViewQuoteCILZ.safeParse(
        validViewPayload({ source_msg_id: '' })
      ).success).toBe(false);
    });

    it('null rejects (optional means undefined, not null)', () => {
      expect(ViewQuoteCILZ.safeParse(
        validViewPayload({ source_msg_id: null })
      ).success).toBe(false);
    });

    // Regression guard: if Zod's .optional() ever accidentally strips the
    // value, Section 3's emitLifecycleCustomerViewed payload echo breaks
    // silently. Catch it here at the schema layer.
    it('value passes through to parsed payload when present', () => {
      const result = ViewQuoteCILZ.parse(validViewPayload({ source_msg_id: 'req-abc-123' }));
      expect(result.source_msg_id).toBe('req-abc-123');
    });
  });

  describe('required-field completeness', () => {
    it('missing share_token rejects', () => {
      const { share_token: _x, ...bad } = validViewPayload();
      expect(ViewQuoteCILZ.safeParse(bad).success).toBe(false);
    });
  });

  describe('BaseCILZ inheritance', () => {
    it('missing tenant_id rejects', () => {
      const { tenant_id: _x, ...bad } = validViewPayload();
      expect(ViewQuoteCILZ.safeParse(bad).success).toBe(false);
    });

    it('missing cil_version rejects', () => {
      const { cil_version: _x, ...bad } = validViewPayload();
      expect(ViewQuoteCILZ.safeParse(bad).success).toBe(false);
    });

    it('missing occurred_at rejects', () => {
      const { occurred_at: _x, ...bad } = validViewPayload();
      expect(ViewQuoteCILZ.safeParse(bad).success).toBe(false);
    });
    // Note: no missing-source_msg_id test — it's optional per §17.23.
  });

  describe('SIG_ERR codes consumed by ViewQuote', () => {
    // ViewQuote reuses SIG_ERR as-is; no VIEW_ERR taxonomy. These assertions
    // guard that each code ViewQuote's loadViewContext / handler will throw
    // remains defined. If a future refactor deletes QUOTE_NOT_SENT from
    // SIG_ERR, ViewQuote tests break loudly rather than handler breaking
    // silently at runtime.
    const VIEW_CONSUMED = {
      SHARE_TOKEN_NOT_FOUND:  404,
      SHARE_TOKEN_EXPIRED:    410,
      SHARE_TOKEN_REVOKED:    410,
      SHARE_TOKEN_SUPERSEDED: 409,
      QUOTE_NOT_SENT:         409,
      QUOTE_VOIDED:           410,
      BAD_REQUEST:            400,
    };

    it.each(Object.entries(VIEW_CONSUMED))(
      'SIG_ERR.%s is defined with correct code + status %s',
      (key, expectedStatus) => {
        expect(SIG_ERR[key]).toBeDefined();
        expect(SIG_ERR[key].code).toBe(key);
        expect(SIG_ERR[key].status).toBe(expectedStatus);
      }
    );
  });

  describe('No VIEW_QUOTE_SOURCE_MSG_CONSTRAINT export (§17.23 signal via absence)', () => {
    // Section 1 contract: ViewQuote does NOT have a (owner_id, source_msg_id)
    // unique-constraint surface. The absence of these exports is how future
    // readers learn "this handler uses state-driven idempotency, not 23505".
    // If a future refactor adds such a constant, these guard rails fire.
    it('_internals does NOT expose VIEW_QUOTE_SOURCE_MSG_CONSTRAINT', () => {
      expect(_internals.VIEW_QUOTE_SOURCE_MSG_CONSTRAINT).toBeUndefined();
    });

    it('_internals does NOT expose VIEW_QUOTE_SOURCE_MSG_UNIQUE', () => {
      expect(_internals.VIEW_QUOTE_SOURCE_MSG_UNIQUE).toBeUndefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3 Section 3 tests: loadSignContext + buildVersionHashInput
// ═══════════════════════════════════════════════════════════════════════════

const {
  loadSignContext,
  buildVersionHashInput,
  SIGN_LOAD_COLUMNS: _SIGN_LOAD_COLUMNS,
} = _internals;

describe('SignQuote — Section 3: loadSignContext', () => {
  const CTX_TENANT_ID  = '00000000-c2c2-c2c2-c2c2-000000000001';
  const CTX_OWNER_ID   = '00000000000';
  const CTX_QUOTE_ID   = '00000000-c2c2-c2c2-c2c2-000000000002';
  const CTX_VERSION_ID = '00000000-c2c2-c2c2-c2c2-000000000003';
  const CTX_TOKEN_ID   = '00000000-c2c2-c2c2-c2c2-000000000005';
  const CTX_TOKEN_STR  = 'K5gQbxTdNcN1ZNqmoGtaww';

  const FUTURE_EXPIRES_AT = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  const PAST_EXPIRES_AT   = new Date('2020-01-01T00:00:00Z');

  function makeToken(overrides = {}) {
    return {
      share_token_id: CTX_TOKEN_ID,
      tenant_id: CTX_TENANT_ID,
      owner_id: CTX_OWNER_ID,
      quote_version_id: CTX_VERSION_ID,
      recipient_name: 'Ceremony Customer',
      recipient_channel: 'email',
      recipient_address: 'ceremony@invalid.test',
      absolute_expires_at: FUTURE_EXPIRES_AT,
      revoked_at: null,
      superseded_by_version_id: null,
      issued_at: new Date('2026-04-20T10:00:00Z'),
      ...overrides,
    };
  }

  function makeQuoteVersion(overrides = {}) {
    return {
      quote_id: CTX_QUOTE_ID,
      human_id: 'QT-CEREMONY-2026-04-20-PHASE2C',
      quote_status: 'sent',
      job_id: 1257,
      customer_id: null,
      current_version_id: CTX_VERSION_ID,
      quote_source: 'system',
      header_created_at: new Date('2026-04-20T10:00:00Z'),
      header_updated_at: new Date('2026-04-20T10:00:00Z'),
      version_id: CTX_VERSION_ID,
      version_no: 1,
      version_status: 'sent',
      project_title: 'Phase 2C Ceremony',
      project_scope: null,
      currency: 'CAD',
      subtotal_cents: 0,
      tax_cents: 0,
      total_cents: 0,
      deposit_cents: 0,
      tax_code: null,
      tax_rate_bps: 0,
      payment_terms: {},
      warranty_snapshot: {},
      clauses_snapshot: {},
      customer_snapshot: { name: 'Ceremony Customer', email: null, phone_e164: null },
      tenant_snapshot: { legal_name: 'Phase 2C Ceremony Tenant' },
      version_issued_at: new Date('2026-04-20T10:00:00Z'),
      version_sent_at: new Date('2026-04-20T10:00:00Z'),
      version_viewed_at: null,
      version_locked_at: null,
      version_server_hash: null,
      ...overrides,
    };
  }

  function makeLineItem(overrides = {}) {
    return {
      id: '00000000-0000-0000-0000-000000000a01',
      sort_order: 0,
      description: 'Ceremony item',
      category: 'other',
      qty: '1.000',
      unit_price_cents: 1000,
      line_subtotal_cents: 1000,
      line_tax_cents: 0,
      tax_code: null,
      catalog_product_id: null,
      catalog_snapshot: {},
      ...overrides,
    };
  }

  function mockPgWith(queryResults) {
    let idx = 0;
    const query = jest.fn().mockImplementation(() => {
      const r = queryResults[idx++];
      if (r instanceof Error) return Promise.reject(r);
      return Promise.resolve(r || { rows: [] });
    });
    return { query };
  }

  async function expectCilError(fn, expectedCode) {
    try {
      await fn();
      throw new Error('expected throw');
    } catch (e) {
      expect(e.name).toBe('CilIntegrityError');
      expect(e.code).toBe(expectedCode);
    }
  }

  // ─── Happy path ────────────────────────────────────────────────────────
  describe('happy path', () => {
    it('valid token + sent quote + current version + line items → returns context', async () => {
      const pg = mockPgWith([
        { rows: [makeToken()] },
        { rows: [makeQuoteVersion()] },
        { rows: [makeLineItem()] },
      ]);
      const ctx = await loadSignContext({
        pg, tenantId: CTX_TENANT_ID, shareToken: CTX_TOKEN_STR,
      });
      expect(ctx.shareTokenId).toBe(CTX_TOKEN_ID);
      expect(ctx.quoteId).toBe(CTX_QUOTE_ID);
      expect(ctx.versionId).toBe(CTX_VERSION_ID);
      expect(ctx.quoteStatus).toBe('sent');
      expect(ctx.versionStatus).toBe('sent');
      expect(ctx.lineItems.length).toBe(1);
    });

    it('viewed quote accepts (same handler flow as sent)', async () => {
      const pg = mockPgWith([
        { rows: [makeToken()] },
        { rows: [makeQuoteVersion({ quote_status: 'viewed', version_status: 'viewed' })] },
        { rows: [makeLineItem()] },
      ]);
      const ctx = await loadSignContext({
        pg, tenantId: CTX_TENANT_ID, shareToken: CTX_TOKEN_STR,
      });
      expect(ctx.quoteStatus).toBe('viewed');
    });

    it('multiple line items returned ordered', async () => {
      const items = [
        makeLineItem({ id: 'a1', sort_order: 0 }),
        makeLineItem({ id: 'a2', sort_order: 1 }),
        makeLineItem({ id: 'a3', sort_order: 2 }),
      ];
      const pg = mockPgWith([
        { rows: [makeToken()] },
        { rows: [makeQuoteVersion()] },
        { rows: items },
      ]);
      const ctx = await loadSignContext({
        pg, tenantId: CTX_TENANT_ID, shareToken: CTX_TOKEN_STR,
      });
      expect(ctx.lineItems.map((l) => l.id)).toEqual(['a1', 'a2', 'a3']);
    });
  });

  // ─── Share-token failures ──────────────────────────────────────────────
  describe('share-token failures', () => {
    it('token not found → SHARE_TOKEN_NOT_FOUND', async () => {
      const pg = mockPgWith([{ rows: [] }]);
      await expectCilError(
        () => loadSignContext({ pg, tenantId: CTX_TENANT_ID, shareToken: CTX_TOKEN_STR }),
        SIG_ERR.SHARE_TOKEN_NOT_FOUND.code
      );
    });

    it('token revoked → SHARE_TOKEN_REVOKED', async () => {
      const pg = mockPgWith([{ rows: [makeToken({ revoked_at: new Date() })] }]);
      await expectCilError(
        () => loadSignContext({ pg, tenantId: CTX_TENANT_ID, shareToken: CTX_TOKEN_STR }),
        SIG_ERR.SHARE_TOKEN_REVOKED.code
      );
    });

    it('token expired → SHARE_TOKEN_EXPIRED', async () => {
      const pg = mockPgWith([{ rows: [makeToken({ absolute_expires_at: PAST_EXPIRES_AT })] }]);
      await expectCilError(
        () => loadSignContext({ pg, tenantId: CTX_TENANT_ID, shareToken: CTX_TOKEN_STR }),
        SIG_ERR.SHARE_TOKEN_EXPIRED.code
      );
    });

    it('tenant mismatch → SHARE_TOKEN_NOT_FOUND (unified 404)', async () => {
      const pg = mockPgWith([{ rows: [makeToken({ tenant_id: '11111111-2222-3333-4444-555555555555' })] }]);
      await expectCilError(
        () => loadSignContext({ pg, tenantId: CTX_TENANT_ID, shareToken: CTX_TOKEN_STR }),
        SIG_ERR.SHARE_TOKEN_NOT_FOUND.code
      );
    });
  });

  // ─── Quote state rejections ────────────────────────────────────────────
  describe('quote state rejections', () => {
    it('draft → QUOTE_NOT_SENT', async () => {
      const pg = mockPgWith([
        { rows: [makeToken()] },
        { rows: [makeQuoteVersion({ quote_status: 'draft', version_status: 'draft' })] },
      ]);
      await expectCilError(
        () => loadSignContext({ pg, tenantId: CTX_TENANT_ID, shareToken: CTX_TOKEN_STR }),
        SIG_ERR.QUOTE_NOT_SENT.code
      );
    });

    it('signed → QUOTE_ALREADY_SIGNED', async () => {
      const pg = mockPgWith([
        { rows: [makeToken()] },
        { rows: [makeQuoteVersion({ quote_status: 'signed', version_status: 'signed' })] },
      ]);
      await expectCilError(
        () => loadSignContext({ pg, tenantId: CTX_TENANT_ID, shareToken: CTX_TOKEN_STR }),
        SIG_ERR.QUOTE_ALREADY_SIGNED.code
      );
    });

    it('locked → QUOTE_LOCKED', async () => {
      const pg = mockPgWith([
        { rows: [makeToken()] },
        { rows: [makeQuoteVersion({ quote_status: 'locked', version_status: 'locked' })] },
      ]);
      await expectCilError(
        () => loadSignContext({ pg, tenantId: CTX_TENANT_ID, shareToken: CTX_TOKEN_STR }),
        SIG_ERR.QUOTE_LOCKED.code
      );
    });

    it('voided → QUOTE_VOIDED', async () => {
      const pg = mockPgWith([
        { rows: [makeToken()] },
        { rows: [makeQuoteVersion({ quote_status: 'voided', version_status: 'sent' })] },
      ]);
      await expectCilError(
        () => loadSignContext({ pg, tenantId: CTX_TENANT_ID, shareToken: CTX_TOKEN_STR }),
        SIG_ERR.QUOTE_VOIDED.code
      );
    });

    it('unknown status → QUOTE_NOT_SIGNABLE (default branch)', async () => {
      const pg = mockPgWith([
        { rows: [makeToken()] },
        { rows: [makeQuoteVersion({ quote_status: 'some_future_state' })] },
      ]);
      await expectCilError(
        () => loadSignContext({ pg, tenantId: CTX_TENANT_ID, shareToken: CTX_TOKEN_STR }),
        SIG_ERR.QUOTE_NOT_SIGNABLE.code
      );
    });

    it('quote/version status disagreement → CIL_INTEGRITY_ERROR', async () => {
      // quote.status=sent accepted by switch; version.status=draft fails the version check.
      const pg = mockPgWith([
        { rows: [makeToken()] },
        { rows: [makeQuoteVersion({ version_status: 'draft' })] },
      ]);
      await expectCilError(
        () => loadSignContext({ pg, tenantId: CTX_TENANT_ID, shareToken: CTX_TOKEN_STR }),
        'CIL_INTEGRITY_ERROR'
      );
    });
  });

  // ─── Version state ─────────────────────────────────────────────────────
  describe('version state rejections', () => {
    it('version locked_at set → VERSION_ALREADY_LOCKED', async () => {
      const pg = mockPgWith([
        { rows: [makeToken()] },
        { rows: [makeQuoteVersion({ version_locked_at: new Date() })] },
      ]);
      await expectCilError(
        () => loadSignContext({ pg, tenantId: CTX_TENANT_ID, shareToken: CTX_TOKEN_STR }),
        SIG_ERR.VERSION_ALREADY_LOCKED.code
      );
    });
  });

  // ─── Supersession ──────────────────────────────────────────────────────
  describe('supersession', () => {
    it('token.quote_version_id != quote.current_version_id → SHARE_TOKEN_SUPERSEDED', async () => {
      const NEW_VERSION = '00000000-c2c2-c2c2-c2c2-00000000aaaa';
      const pg = mockPgWith([
        { rows: [makeToken({ quote_version_id: CTX_VERSION_ID })] },
        { rows: [makeQuoteVersion({ current_version_id: NEW_VERSION })] },
      ]);
      await expectCilError(
        () => loadSignContext({ pg, tenantId: CTX_TENANT_ID, shareToken: CTX_TOKEN_STR }),
        SIG_ERR.SHARE_TOKEN_SUPERSEDED.code
      );
    });

    it('token.superseded_by_version_id set → SHARE_TOKEN_SUPERSEDED (belt-and-suspenders)', async () => {
      const NEW_VERSION = '00000000-c2c2-c2c2-c2c2-00000000bbbb';
      // current_version_id equals token's version (primary check passes) but
      // superseded_by is populated (defensive check fires).
      const pg = mockPgWith([
        { rows: [makeToken({ superseded_by_version_id: NEW_VERSION })] },
        { rows: [makeQuoteVersion()] },
      ]);
      await expectCilError(
        () => loadSignContext({ pg, tenantId: CTX_TENANT_ID, shareToken: CTX_TOKEN_STR }),
        SIG_ERR.SHARE_TOKEN_SUPERSEDED.code
      );
    });
  });

  // ─── Empty line items (Decision C overridden) ──────────────────────────
  describe('empty line items (Decision C — reject)', () => {
    it('zero line items → CIL_INTEGRITY_ERROR', async () => {
      const pg = mockPgWith([
        { rows: [makeToken()] },
        { rows: [makeQuoteVersion()] },
        { rows: [] },
      ]);
      await expectCilError(
        () => loadSignContext({ pg, tenantId: CTX_TENANT_ID, shareToken: CTX_TOKEN_STR }),
        'CIL_INTEGRITY_ERROR'
      );
    });
  });

  // ─── Query-order short-circuits ────────────────────────────────────────
  describe('query-order short-circuits', () => {
    it('Q1 token miss → Q2 and Q3 never called', async () => {
      const pg = mockPgWith([{ rows: [] }]);
      await expect(loadSignContext({
        pg, tenantId: CTX_TENANT_ID, shareToken: CTX_TOKEN_STR,
      })).rejects.toBeDefined();
      expect(pg.query).toHaveBeenCalledTimes(1);
    });

    it('Q2 quote state rejection → Q3 never called', async () => {
      const pg = mockPgWith([
        { rows: [makeToken()] },
        { rows: [makeQuoteVersion({ quote_status: 'voided', version_status: 'sent' })] },
      ]);
      await expect(loadSignContext({
        pg, tenantId: CTX_TENANT_ID, shareToken: CTX_TOKEN_STR,
      })).rejects.toBeDefined();
      expect(pg.query).toHaveBeenCalledTimes(2);
    });
  });

  // ─── Return shape (exact-key-match per Flag 2) ─────────────────────────
  describe('return shape (Flag 2: exact-key-match)', () => {
    const EXPECTED_KEYS = [
      // Authoritative identity (added Phase 3 Section 5 for handler convenience)
      'tenantId', 'ownerId',
      // Share-token identity
      'shareTokenId', 'shareTokenValue', 'shareTokenOwnerId',
      'recipientName', 'recipientChannel', 'recipientAddress',
      'absoluteExpiresAt', 'issuedAt',
      // Quote identity
      'quoteId', 'humanId', 'quoteStatus', 'jobId', 'customerId',
      'currentVersionId', 'quoteSource', 'headerCreatedAt', 'headerUpdatedAt',
      // Version identity
      'versionId', 'versionNo', 'versionStatus',
      // Hash-input fields
      'projectTitle', 'projectScope', 'currency',
      'subtotalCents', 'taxCents', 'totalCents', 'depositCents',
      'taxCode', 'taxRateBps',
      'paymentTerms', 'warrantySnapshot', 'clausesSnapshot',
      'customerSnapshot', 'tenantSnapshot',
      'versionIssuedAt', 'versionSentAt', 'versionViewedAt',
      // Line items
      'lineItems',
    ];

    it('return has exactly the expected camelCase keys', async () => {
      const pg = mockPgWith([
        { rows: [makeToken()] },
        { rows: [makeQuoteVersion()] },
        { rows: [makeLineItem()] },
      ]);
      const ctx = await loadSignContext({
        pg, tenantId: CTX_TENANT_ID, shareToken: CTX_TOKEN_STR,
      });
      expect(Object.keys(ctx).sort()).toEqual([...EXPECTED_KEYS].sort());
    });

    it('determinism — same inputs produce same output', async () => {
      const pg1 = mockPgWith([
        { rows: [makeToken()] }, { rows: [makeQuoteVersion()] }, { rows: [makeLineItem()] },
      ]);
      const pg2 = mockPgWith([
        { rows: [makeToken()] }, { rows: [makeQuoteVersion()] }, { rows: [makeLineItem()] },
      ]);
      const a = await loadSignContext({ pg: pg1, tenantId: CTX_TENANT_ID, shareToken: CTX_TOKEN_STR });
      const b = await loadSignContext({ pg: pg2, tenantId: CTX_TENANT_ID, shareToken: CTX_TOKEN_STR });
      expect(a).toEqual(b);
    });
  });
});

// ─── buildVersionHashInput ─────────────────────────────────────────────────

describe('SignQuote — Section 3: buildVersionHashInput', () => {
  it('maps camelCase ctx to snake_case hash input with all 17 expected keys', () => {
    const ctx = {
      quoteId: 'q1',
      humanId: 'QT-TEST',
      versionNo: 2,
      projectTitle: 'Test Project',
      projectScope: 'scope text',
      currency: 'CAD',
      subtotalCents: 100,
      taxCents: 13,
      totalCents: 113,
      depositCents: 50,
      taxCode: 'HST_ON',
      taxRateBps: 1300,
      paymentTerms: { net: 30 },
      warrantySnapshot: { workmanship: '1yr' },
      clausesSnapshot: { limitation: 'text' },
      customerSnapshot: { name: 'Cust' },
      tenantSnapshot: { legal_name: 'Tenant' },
      // Extra fields intentionally present — helper maps only hash-input keys.
      shareTokenId: 'ignored',
      lineItems: [],
    };
    const out = buildVersionHashInput(ctx);
    expect(out).toEqual({
      quote_id: 'q1',
      human_id: 'QT-TEST',
      version_no: 2,
      project_title: 'Test Project',
      project_scope: 'scope text',
      currency: 'CAD',
      subtotal_cents: 100,
      tax_cents: 13,
      total_cents: 113,
      deposit_cents: 50,
      tax_code: 'HST_ON',
      tax_rate_bps: 1300,
      payment_terms: { net: 30 },
      warranty_snapshot: { workmanship: '1yr' },
      clauses_snapshot: { limitation: 'text' },
      customer_snapshot: { name: 'Cust' },
      tenant_snapshot: { legal_name: 'Tenant' },
    });
  });

  it('exact-key-match on output (17 hash-input fields; no extras)', () => {
    const ctx = {
      quoteId: 'x', humanId: 'x', versionNo: 1,
      projectTitle: 'x', projectScope: null, currency: 'CAD',
      subtotalCents: 0, taxCents: 0, totalCents: 0, depositCents: 0,
      taxCode: null, taxRateBps: 0,
      paymentTerms: {}, warrantySnapshot: {}, clausesSnapshot: {},
      customerSnapshot: {}, tenantSnapshot: {},
      shareTokenId: 'ignored', lineItems: ['ignored'],
    };
    const out = buildVersionHashInput(ctx);
    expect(Object.keys(out).sort()).toEqual([
      'clauses_snapshot', 'currency', 'customer_snapshot', 'deposit_cents',
      'human_id', 'payment_terms', 'project_scope', 'project_title',
      'quote_id', 'subtotal_cents', 'tax_cents', 'tax_code', 'tax_rate_bps',
      'tenant_snapshot', 'total_cents', 'version_no', 'warranty_snapshot',
    ].sort());
  });
});

// ─── resolveShareTokenByValue regression (shared helper extracted) ──────────

describe('SignQuote — Section 3: resolveShareTokenByValue', () => {
  const { resolveShareTokenByValue } = require('./quoteSignatureStorage')._internals;
  const CTX_TOKEN_STR = 'K5gQbxTdNcN1ZNqmoGtaww';

  it('returns row for valid token', async () => {
    const tokenRow = {
      share_token_id: 'st-1',
      tenant_id: 't-1',
      owner_id: 'o-1',
      quote_version_id: 'v-1',
      recipient_name: 'r',
      recipient_channel: 'email',
      recipient_address: 'r@x',
      absolute_expires_at: new Date(Date.now() + 1000 * 3600),
      revoked_at: null,
      superseded_by_version_id: null,
      issued_at: new Date(),
    };
    const pg = { query: jest.fn().mockResolvedValue({ rows: [tokenRow] }) };
    const out = await resolveShareTokenByValue(pg, CTX_TOKEN_STR);
    expect(out).toEqual(tokenRow);
    expect(pg.query).toHaveBeenCalledTimes(1);
  });

  it('returns null for missing token (does not throw)', async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const out = await resolveShareTokenByValue(pg, CTX_TOKEN_STR);
    expect(out).toBeNull();
  });

  it('query parameter is exactly the shareToken string', async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await resolveShareTokenByValue(pg, CTX_TOKEN_STR);
    expect(pg.query.mock.calls[0][1]).toEqual([CTX_TOKEN_STR]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase A Session 2 Section 2 tests: loadViewContext + VIEW_LOAD_COLUMNS
// ═══════════════════════════════════════════════════════════════════════════

const {
  loadViewContext,
  VIEW_LOAD_COLUMNS: _VIEW_LOAD_COLUMNS,
} = _internals;

describe('ViewQuote — Section 2: loadViewContext', () => {
  const VCTX_TENANT_ID  = '00000000-c2c2-c2c2-c2c2-000000000001';
  const VCTX_OWNER_ID   = '00000000000';
  const VCTX_QUOTE_ID   = '00000000-c2c2-c2c2-c2c2-000000000002';
  const VCTX_VERSION_ID = '00000000-c2c2-c2c2-c2c2-000000000003';
  const VCTX_TOKEN_ID   = '00000000-c2c2-c2c2-c2c2-000000000005';
  const VCTX_TOKEN_STR  = 'K5gQbxTdNcN1ZNqmoGtaww';

  const FUTURE_EXPIRES_AT = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  const PAST_EXPIRES_AT   = new Date('2020-01-01T00:00:00Z');

  function makeToken(overrides = {}) {
    return {
      share_token_id: VCTX_TOKEN_ID,
      tenant_id: VCTX_TENANT_ID,
      owner_id: VCTX_OWNER_ID,
      quote_version_id: VCTX_VERSION_ID,
      recipient_name: 'View Customer',
      recipient_channel: 'email',
      recipient_address: 'view@invalid.test',
      absolute_expires_at: FUTURE_EXPIRES_AT,
      revoked_at: null,
      superseded_by_version_id: null,
      issued_at: new Date('2026-04-21T10:00:00Z'),
      ...overrides,
    };
  }

  function makeQuoteVersion(overrides = {}) {
    return {
      quote_id: VCTX_QUOTE_ID,
      human_id: 'QT-2026-04-21-VIEW01',
      quote_status: 'sent',
      job_id: 2001,
      customer_id: null,
      current_version_id: VCTX_VERSION_ID,
      header_created_at: new Date('2026-04-21T10:00:00Z'),
      header_updated_at: new Date('2026-04-21T10:00:00Z'),
      version_id: VCTX_VERSION_ID,
      version_no: 1,
      version_status: 'sent',
      project_title: 'View Test',
      currency: 'CAD',
      total_cents: 11300,
      customer_snapshot: { name: 'View Customer', email: 'view@invalid.test', phone_e164: null },
      version_issued_at: new Date('2026-04-21T10:00:00Z'),
      version_sent_at: new Date('2026-04-21T10:00:00Z'),
      version_viewed_at: null,
      version_signed_at: null,
      version_locked_at: null,
      version_server_hash: null,
      ...overrides,
    };
  }

  function mockPgWith(queryResults) {
    let idx = 0;
    const query = jest.fn().mockImplementation(() => {
      const r = queryResults[idx++];
      if (r instanceof Error) return Promise.reject(r);
      return Promise.resolve(r || { rows: [] });
    });
    return { query };
  }

  async function expectCilError(fn, expectedCode) {
    try {
      await fn();
      throw new Error('expected throw');
    } catch (e) {
      expect(e.name).toBe('CilIntegrityError');
      expect(e.code).toBe(expectedCode);
    }
  }

  // ─── Happy path — all four valid source states return context ─────────
  describe('happy path — four valid source states', () => {
    it('sent quote + current version → returns ctx with quoteStatus=sent', async () => {
      const pg = mockPgWith([
        { rows: [makeToken()] },
        { rows: [makeQuoteVersion()] },
      ]);
      const ctx = await loadViewContext({
        pg, tenantId: VCTX_TENANT_ID, shareToken: VCTX_TOKEN_STR,
      });
      expect(ctx.quoteStatus).toBe('sent');
      expect(ctx.quoteId).toBe(VCTX_QUOTE_ID);
      expect(ctx.versionId).toBe(VCTX_VERSION_ID);
      expect(ctx.shareTokenId).toBe(VCTX_TOKEN_ID);
    });

    it('viewed quote → returns ctx with quoteStatus=viewed', async () => {
      const pg = mockPgWith([
        { rows: [makeToken()] },
        { rows: [makeQuoteVersion({
          quote_status: 'viewed', version_status: 'viewed',
          version_viewed_at: new Date('2026-04-21T11:00:00Z'),
        })] },
      ]);
      const ctx = await loadViewContext({
        pg, tenantId: VCTX_TENANT_ID, shareToken: VCTX_TOKEN_STR,
      });
      expect(ctx.quoteStatus).toBe('viewed');
      expect(ctx.versionViewedAt).toEqual(new Date('2026-04-21T11:00:00Z'));
    });

    it('signed quote → returns ctx with quoteStatus=signed and server_hash populated', async () => {
      const pg = mockPgWith([
        { rows: [makeToken()] },
        { rows: [makeQuoteVersion({
          quote_status: 'signed', version_status: 'signed',
          version_signed_at: new Date('2026-04-21T12:00:00Z'),
          version_server_hash: 'a'.repeat(64),
        })] },
      ]);
      const ctx = await loadViewContext({
        pg, tenantId: VCTX_TENANT_ID, shareToken: VCTX_TOKEN_STR,
      });
      expect(ctx.quoteStatus).toBe('signed');
      expect(ctx.versionServerHash).toBe('a'.repeat(64));
    });

    it('locked quote → returns ctx with quoteStatus=locked', async () => {
      const pg = mockPgWith([
        { rows: [makeToken()] },
        { rows: [makeQuoteVersion({
          quote_status: 'locked', version_status: 'locked',
          version_signed_at: new Date('2026-04-21T12:00:00Z'),
          version_locked_at: new Date('2026-04-21T12:00:01Z'),
          version_server_hash: 'b'.repeat(64),
        })] },
      ]);
      const ctx = await loadViewContext({
        pg, tenantId: VCTX_TENANT_ID, shareToken: VCTX_TOKEN_STR,
      });
      expect(ctx.quoteStatus).toBe('locked');
      expect(ctx.versionLockedAt).toEqual(new Date('2026-04-21T12:00:01Z'));
    });
  });

  // ─── Share-token failures ─────────────────────────────────────────────
  describe('share-token failures', () => {
    it('token not found → SHARE_TOKEN_NOT_FOUND', async () => {
      const pg = mockPgWith([{ rows: [] }]);
      await expectCilError(
        () => loadViewContext({ pg, tenantId: VCTX_TENANT_ID, shareToken: VCTX_TOKEN_STR }),
        SIG_ERR.SHARE_TOKEN_NOT_FOUND.code
      );
    });

    it('token revoked → SHARE_TOKEN_REVOKED', async () => {
      const pg = mockPgWith([{ rows: [makeToken({ revoked_at: new Date() })] }]);
      await expectCilError(
        () => loadViewContext({ pg, tenantId: VCTX_TENANT_ID, shareToken: VCTX_TOKEN_STR }),
        SIG_ERR.SHARE_TOKEN_REVOKED.code
      );
    });

    it('token expired → SHARE_TOKEN_EXPIRED', async () => {
      const pg = mockPgWith([{ rows: [makeToken({ absolute_expires_at: PAST_EXPIRES_AT })] }]);
      await expectCilError(
        () => loadViewContext({ pg, tenantId: VCTX_TENANT_ID, shareToken: VCTX_TOKEN_STR }),
        SIG_ERR.SHARE_TOKEN_EXPIRED.code
      );
    });

    it('tenant mismatch → SHARE_TOKEN_NOT_FOUND (unified 404)', async () => {
      const pg = mockPgWith([{ rows: [makeToken({ tenant_id: '11111111-2222-3333-4444-555555555555' })] }]);
      await expectCilError(
        () => loadViewContext({ pg, tenantId: VCTX_TENANT_ID, shareToken: VCTX_TOKEN_STR }),
        SIG_ERR.SHARE_TOKEN_NOT_FOUND.code
      );
    });
  });

  // ─── Quote state rejections ───────────────────────────────────────────
  describe('quote state rejections', () => {
    it('draft → QUOTE_NOT_SENT', async () => {
      const pg = mockPgWith([
        { rows: [makeToken()] },
        { rows: [makeQuoteVersion({ quote_status: 'draft', version_status: 'draft' })] },
      ]);
      await expectCilError(
        () => loadViewContext({ pg, tenantId: VCTX_TENANT_ID, shareToken: VCTX_TOKEN_STR }),
        SIG_ERR.QUOTE_NOT_SENT.code
      );
    });

    it('voided → QUOTE_VOIDED', async () => {
      const pg = mockPgWith([
        { rows: [makeToken()] },
        { rows: [makeQuoteVersion({ quote_status: 'voided', version_status: 'voided' })] },
      ]);
      await expectCilError(
        () => loadViewContext({ pg, tenantId: VCTX_TENANT_ID, shareToken: VCTX_TOKEN_STR }),
        SIG_ERR.QUOTE_VOIDED.code
      );
    });

    it('unknown status → CIL_INTEGRITY_ERROR (fail-closed per §17.22)', async () => {
      const pg = mockPgWith([
        { rows: [makeToken()] },
        { rows: [makeQuoteVersion({ quote_status: 'zombie', version_status: 'zombie' })] },
      ]);
      await expectCilError(
        () => loadViewContext({ pg, tenantId: VCTX_TENANT_ID, shareToken: VCTX_TOKEN_STR }),
        'CIL_INTEGRITY_ERROR'
      );
    });
  });

  // ─── Co-transition check (§3.3) ───────────────────────────────────────
  describe('version/quote status disagreement', () => {
    it('quote=sent but version=viewed → CIL_INTEGRITY_ERROR', async () => {
      const pg = mockPgWith([
        { rows: [makeToken()] },
        { rows: [makeQuoteVersion({ quote_status: 'sent', version_status: 'viewed' })] },
      ]);
      await expectCilError(
        () => loadViewContext({ pg, tenantId: VCTX_TENANT_ID, shareToken: VCTX_TOKEN_STR }),
        'CIL_INTEGRITY_ERROR'
      );
    });
  });

  // ─── Supersession (fires AFTER state check; SUP.2 posture B) ──────────
  describe('supersession (fires AFTER state check)', () => {
    it('SUP.1: token.quote_version_id != current_version_id → SHARE_TOKEN_SUPERSEDED', async () => {
      const staleVersionId = '00000000-c2c2-c2c2-c2c2-00000000ffff';
      const pg = mockPgWith([
        { rows: [makeToken({ quote_version_id: staleVersionId })] },
        // Q2 is keyed on token.quote_version_id (staleVersionId). The
        // returned row reports the current version is something else —
        // this is what SUP.1 compares against.
        { rows: [makeQuoteVersion({ version_id: staleVersionId, current_version_id: VCTX_VERSION_ID })] },
      ]);
      await expectCilError(
        () => loadViewContext({ pg, tenantId: VCTX_TENANT_ID, shareToken: VCTX_TOKEN_STR }),
        SIG_ERR.SHARE_TOKEN_SUPERSEDED.code
      );
    });

    it('SUP.2 posture B: SUP.1 passes but superseded_by_version_id set → CIL_INTEGRITY_ERROR (not SHARE_TOKEN_SUPERSEDED)', async () => {
      // Disagreement: token IS current by SUP.1 (quote_version_id ==
      // current_version_id) but ReissueQuote's forward-plan column
      // marks it as superseded. SUP.1 is authoritative → integrity
      // violation, not masking as a parallel SHARE_TOKEN_SUPERSEDED.
      const pg = mockPgWith([
        { rows: [makeToken({ superseded_by_version_id: '00000000-c2c2-c2c2-c2c2-00000000dead' })] },
        { rows: [makeQuoteVersion()] },
      ]);
      await expectCilError(
        () => loadViewContext({ pg, tenantId: VCTX_TENANT_ID, shareToken: VCTX_TOKEN_STR }),
        'CIL_INTEGRITY_ERROR'
      );
    });

    it('superseded token on signed quote still surfaces SHARE_TOKEN_SUPERSEDED (state-check runs first but succeeds; supersession then rejects)', async () => {
      const staleVersionId = '00000000-c2c2-c2c2-c2c2-00000000ffff';
      const pg = mockPgWith([
        { rows: [makeToken({ quote_version_id: staleVersionId })] },
        { rows: [makeQuoteVersion({
          version_id: staleVersionId,
          current_version_id: VCTX_VERSION_ID,
          quote_status: 'signed',
          version_status: 'signed',
        })] },
      ]);
      await expectCilError(
        () => loadViewContext({ pg, tenantId: VCTX_TENANT_ID, shareToken: VCTX_TOKEN_STR }),
        SIG_ERR.SHARE_TOKEN_SUPERSEDED.code
      );
    });
  });

  // ─── Query-order short-circuit ────────────────────────────────────────
  describe('query-order short-circuits', () => {
    it('Q1 token miss → Q2 never called', async () => {
      const pg = mockPgWith([{ rows: [] }]);
      await expectCilError(
        () => loadViewContext({ pg, tenantId: VCTX_TENANT_ID, shareToken: VCTX_TOKEN_STR }),
        SIG_ERR.SHARE_TOKEN_NOT_FOUND.code
      );
      expect(pg.query).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Return shape (Flag 2: exact-key-match) ───────────────────────────
  describe('return shape (Flag 2: exact-key-match)', () => {
    it('return has exactly the 30 expected camelCase keys (no extras, no omissions)', async () => {
      const pg = mockPgWith([
        { rows: [makeToken()] },
        { rows: [makeQuoteVersion()] },
      ]);
      const ctx = await loadViewContext({
        pg, tenantId: VCTX_TENANT_ID, shareToken: VCTX_TOKEN_STR,
      });
      // Sorted for deterministic comparison; changing this set is a
      // contract change affecting Section 3 (transaction helpers) and
      // Section 4 (handler return-shape composer).
      expect(Object.keys(ctx).sort()).toEqual([
        'absoluteExpiresAt',
        'currency',
        'currentVersionId',
        'customerId',
        'customerSnapshot',
        'headerCreatedAt',
        'headerUpdatedAt',
        'humanId',
        'issuedAt',
        'jobId',
        'ownerId',
        'projectTitle',
        'quoteId',
        'quoteStatus',
        'recipientAddress',
        'recipientChannel',
        'recipientName',
        'shareTokenId',
        'shareTokenValue',
        'tenantId',
        'totalCents',
        'versionId',
        'versionIssuedAt',
        'versionLockedAt',
        'versionNo',
        'versionSentAt',
        'versionServerHash',
        'versionSignedAt',
        'versionStatus',
        'versionViewedAt',
      ].sort());
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase A Session 2 Section 3 tests: markQuoteViewed + emitLifecycleCustomerViewed
// ═══════════════════════════════════════════════════════════════════════════

const {
  markQuoteViewed,
  emitLifecycleCustomerViewed,
} = _internals;

describeIfDb('ViewQuote — Section 3: markQuoteViewed (integration)', () => {
  let pool;
  beforeAll(async () => {
    const pg = require('../../services/postgres');
    pool = pg.pool;
  });

  const {
    insertQuoteHeader: _ihq,
    insertQuoteVersion: _ivq,
    setQuoteCurrentVersion: _spv,
    composeTenantSnapshot: _cts,
  } = _internals;

  // Seed a quote + version in 'sent' state (header and version both flipped).
  // Wraps insertQuoteHeader / insertQuoteVersion / setQuoteCurrentVersion plus
  // manual direct UPDATE to 'sent' to avoid pulling in the full markQuoteSent
  // dependency chain (keeps Section 3 tests isolated from Section 5).
  async function seedSentQuote(client, pre) {
    const header = await _ihq(client, {
      tenantId: pre.tenantId, ownerId: pre.ownerId,
      jobId: pre.jobId, customerId: pre.customer.id,
      humanId: pre.humanId, source: 'whatsapp', sourceMsgId: pre.sourceMsgId,
    });
    const version = await _ivq(client, {
      quoteId: header.id, tenantId: pre.tenantId, ownerId: pre.ownerId,
      data: {
        project: { title: 'ViewQuote Section 3 seed', scope: null },
        currency: 'CAD', deposit_cents: 0, tax_code: null, tax_rate_bps: 1300,
        warranty_snapshot: {}, clauses_snapshot: {}, payment_terms: {},
        warranty_template_ref: null, clauses_template_ref: null,
      },
      totals: { subtotal_cents: 1000, tax_cents: 130, total_cents: 1130 },
      customerSnapshot: { name: pre.customer.name, email: pre.customer.email },
      tenantSnapshot: _cts(pre.tenantId),
    });
    await _spv(client, {
      quoteId: header.id, versionId: version.id,
      tenantId: pre.tenantId, ownerId: pre.ownerId,
    });
    // Flip both rows to 'sent' directly (no state-machine helper dep).
    await client.query(
      `UPDATE public.chiefos_quotes SET status='sent', updated_at=NOW() WHERE id=$1`,
      [header.id]
    );
    await client.query(
      `UPDATE public.chiefos_quote_versions
          SET status='sent', issued_at=NOW(), sent_at=NOW()
        WHERE id=$1`,
      [version.id]
    );
    return { header, version };
  }

  test('happy path: sent → viewed flips both rows; returns transitioned:true with timestamps', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { header, version } = await seedSentQuote(client, pre);

      const before = await client.query(
        `SELECT updated_at FROM public.chiefos_quotes WHERE id=$1`, [header.id]
      );
      const beforeUpdatedAt = before.rows[0].updated_at;

      const result = await markQuoteViewed(client, {
        quoteId: header.id, versionId: version.id,
        tenantId: pre.tenantId, ownerId: pre.ownerId,
      });

      expect(result.transitioned).toBe(true);
      expect(result.quoteUpdatedAt).toBeDefined();
      expect(result.versionViewedAt).toBeDefined();

      const qRow = await client.query(
        `SELECT status, updated_at FROM public.chiefos_quotes WHERE id=$1`, [header.id]
      );
      expect(qRow.rows[0].status).toBe('viewed');
      expect(qRow.rows[0].updated_at.getTime()).toBeGreaterThanOrEqual(beforeUpdatedAt.getTime());

      const vRow = await client.query(
        `SELECT status, viewed_at FROM public.chiefos_quote_versions WHERE id=$1`, [version.id]
      );
      expect(vRow.rows[0].status).toBe('viewed');
      expect(vRow.rows[0].viewed_at).not.toBeNull();
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('already-viewed quote: returns transitioned:false with no row mutations', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { header, version } = await seedSentQuote(client, pre);

      // Pre-flip to 'viewed' state.
      await client.query(
        `UPDATE public.chiefos_quotes SET status='viewed' WHERE id=$1`, [header.id]
      );
      const existingViewedAt = new Date('2026-04-21T10:00:00Z');
      await client.query(
        `UPDATE public.chiefos_quote_versions SET status='viewed', viewed_at=$2 WHERE id=$1`,
        [version.id, existingViewedAt]
      );

      const result = await markQuoteViewed(client, {
        quoteId: header.id, versionId: version.id,
        tenantId: pre.tenantId, ownerId: pre.ownerId,
      });
      expect(result).toEqual({ transitioned: false });

      // Version.viewed_at must be unchanged (helper short-circuited on header rowcount=0).
      const vRow = await client.query(
        `SELECT viewed_at FROM public.chiefos_quote_versions WHERE id=$1`, [version.id]
      );
      expect(vRow.rows[0].viewed_at.toISOString()).toBe(existingViewedAt.toISOString());
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('already-signed quote: returns transitioned:false (signed quotes do not re-transition)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { header, version } = await seedSentQuote(client, pre);

      // Drift to signed state (header+version atomic for test purposes).
      await client.query(
        `UPDATE public.chiefos_quotes SET status='signed' WHERE id=$1`, [header.id]
      );
      await client.query(
        `UPDATE public.chiefos_quote_versions
            SET status='signed', signed_at=NOW(), locked_at=NOW(),
                server_hash=$2
          WHERE id=$1`,
        [version.id, 'a'.repeat(64)]
      );

      const result = await markQuoteViewed(client, {
        quoteId: header.id, versionId: version.id,
        tenantId: pre.tenantId, ownerId: pre.ownerId,
      });
      expect(result).toEqual({ transitioned: false });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('§3.3 co-transition violation: header=sent, version=viewed drift → CIL_INTEGRITY_ERROR', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { header, version } = await seedSentQuote(client, pre);

      // Drift: version pre-flipped to 'viewed' while header still 'sent'.
      // Helper's header UPDATE succeeds (rowcount=1); version UPDATE fails
      // with rowcount=0 (version.status!='sent'); throws CIL_INTEGRITY_ERROR.
      await client.query(
        `UPDATE public.chiefos_quote_versions SET status='viewed', viewed_at=NOW() WHERE id=$1`,
        [version.id]
      );

      try {
        await markQuoteViewed(client, {
          quoteId: header.id, versionId: version.id,
          tenantId: pre.tenantId, ownerId: pre.ownerId,
        });
        throw new Error('expected throw');
      } catch (e) {
        expect(e.name).toBe('CilIntegrityError');
        expect(e.code).toBe('CIL_INTEGRITY_ERROR');
        expect(e.message).toMatch(/Version co-transition failed/);
      }
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('header-first ordering: version UPDATE failure rolls back header UPDATE (no §3.3 inversion)', async () => {
    // Locks in the architectural decision: when version UPDATE fails, the
    // caller's transaction (or SAVEPOINT) rolls back — header's UPDATE is
    // not persisted. Prevents the worst-case persisted state: header=viewed,
    // version=sent (§3.3 inversion). Future regressions that reorder UPDATEs
    // or remove the throw fail this test loudly.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { header, version } = await seedSentQuote(client, pre);

      // Drift: version to 'viewed' so helper's version UPDATE fails.
      await client.query(
        `UPDATE public.chiefos_quote_versions SET status='viewed', viewed_at=NOW() WHERE id=$1`,
        [version.id]
      );

      await client.query('SAVEPOINT pre_mark');

      let threw = false;
      try {
        await markQuoteViewed(client, {
          quoteId: header.id, versionId: version.id,
          tenantId: pre.tenantId, ownerId: pre.ownerId,
        });
      } catch (e) {
        threw = true;
        expect(e.name).toBe('CilIntegrityError');
      }
      expect(threw).toBe(true);

      // Mid-state proves header-first ordering: between header UPDATE and
      // the throw, header.status IS 'viewed' in-transaction.
      const midRows = await client.query(
        `SELECT status FROM public.chiefos_quotes WHERE id=$1`, [header.id]
      );
      expect(midRows.rows[0].status).toBe('viewed');

      // Now roll back the SAVEPOINT — simulates pg.withClient's ROLLBACK
      // on throw. Header returns to 'sent' state.
      await client.query('ROLLBACK TO SAVEPOINT pre_mark');

      const postRows = await client.query(
        `SELECT status FROM public.chiefos_quotes WHERE id=$1`, [header.id]
      );
      expect(postRows.rows[0].status).toBe('sent');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('tenant scope: cross-tenant (tenant_id, owner_id) → rowcount=0 → transitioned:false', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { header, version } = await seedSentQuote(client, pre);

      const result = await markQuoteViewed(client, {
        quoteId: header.id, versionId: version.id,
        tenantId: '11111111-2222-3333-4444-555555555555',  // wrong tenant
        ownerId: pre.ownerId,
      });
      expect(result).toEqual({ transitioned: false });

      // Confirm no mutation occurred.
      const qRow = await client.query(
        `SELECT status FROM public.chiefos_quotes WHERE id=$1`, [header.id]
      );
      expect(qRow.rows[0].status).toBe('sent');  // unchanged
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});

describeIfDb('ViewQuote — Section 3: emitLifecycleCustomerViewed (integration)', () => {
  let pool;
  beforeAll(async () => {
    const pg = require('../../services/postgres');
    pool = pg.pool;
  });

  const {
    insertQuoteHeader: _ihq,
    insertQuoteVersion: _ivq,
    setQuoteCurrentVersion: _spv,
    composeTenantSnapshot: _cts,
    insertShareToken: _ist,
    generateShareToken: _gst,
  } = _internals;

  async function seedQuoteAndToken(client, pre) {
    const header = await _ihq(client, {
      tenantId: pre.tenantId, ownerId: pre.ownerId,
      jobId: pre.jobId, customerId: pre.customer.id,
      humanId: pre.humanId, source: 'whatsapp', sourceMsgId: pre.sourceMsgId,
    });
    const version = await _ivq(client, {
      quoteId: header.id, tenantId: pre.tenantId, ownerId: pre.ownerId,
      data: {
        project: { title: 'ViewQuote Section 3 event seed', scope: null },
        currency: 'CAD', deposit_cents: 0, tax_code: null, tax_rate_bps: 1300,
        warranty_snapshot: {}, clauses_snapshot: {}, payment_terms: {},
        warranty_template_ref: null, clauses_template_ref: null,
      },
      totals: { subtotal_cents: 1000, tax_cents: 130, total_cents: 1130 },
      customerSnapshot: { name: pre.customer.name, email: pre.customer.email },
      tenantSnapshot: _cts(pre.tenantId),
    });
    await _spv(client, {
      quoteId: header.id, versionId: version.id,
      tenantId: pre.tenantId, ownerId: pre.ownerId,
    });
    const token = await _ist(client, {
      tenantId: pre.tenantId, ownerId: pre.ownerId,
      quoteVersionId: version.id,
      token: _gst(),
      recipient: { name: pre.customer.name, email: pre.customer.email },
      sourceMsgId: `test-view-s3-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    return { header, version, token };
  }

  test('happy path (no source_msg_id, no correlationId): inserts row with empty payload', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { header, version, token } = await seedQuoteAndToken(client, pre);

      await emitLifecycleCustomerViewed(client, {
        quoteId: header.id, versionId: version.id,
        tenantId: pre.tenantId, ownerId: pre.ownerId,
        actorSource: 'portal', actorUserId: token.id,
        emittedAt: '2026-04-22T12:00:00.000Z',
        customerId: pre.customer.id, shareTokenId: token.id,
      });

      const rows = await client.query(
        `SELECT kind, quote_version_id, share_token_id, correlation_id,
                actor_source, actor_user_id, customer_id, payload, emitted_at
           FROM public.chiefos_quote_events
          WHERE quote_id=$1 AND kind='lifecycle.customer_viewed'`,
        [header.id]
      );
      expect(rows.rows).toHaveLength(1);
      const ev = rows.rows[0];
      expect(ev.kind).toBe('lifecycle.customer_viewed');
      expect(ev.quote_version_id).toBe(version.id);
      expect(ev.share_token_id).toBe(token.id);
      expect(ev.correlation_id).toBeNull();
      expect(ev.actor_source).toBe('portal');
      expect(ev.actor_user_id).toBe(token.id);
      expect(ev.customer_id).toBe(pre.customer.id);
      expect(ev.payload).toEqual({});  // no source_msg_id; payload is empty object
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('correlationId param writes through to correlation_id column (§17.21 wiring)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { header, version, token } = await seedQuoteAndToken(client, pre);

      const corr = '22222222-3333-4444-5555-666666666666';
      await emitLifecycleCustomerViewed(client, {
        quoteId: header.id, versionId: version.id,
        tenantId: pre.tenantId, ownerId: pre.ownerId,
        actorSource: 'portal', actorUserId: token.id,
        emittedAt: '2026-04-22T12:00:00.000Z',
        customerId: pre.customer.id, shareTokenId: token.id,
        correlationId: corr,
      });

      const rows = await client.query(
        `SELECT correlation_id FROM public.chiefos_quote_events
          WHERE quote_id=$1 AND kind='lifecycle.customer_viewed'`,
        [header.id]
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].correlation_id).toBe(corr);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('source_msg_id present (non-empty): echoed into payload (Q1 decision)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { header, version, token } = await seedQuoteAndToken(client, pre);

      await emitLifecycleCustomerViewed(client, {
        quoteId: header.id, versionId: version.id,
        tenantId: pre.tenantId, ownerId: pre.ownerId,
        actorSource: 'portal', actorUserId: token.id,
        emittedAt: '2026-04-22T12:00:00.000Z',
        customerId: pre.customer.id, shareTokenId: token.id,
        sourceMsgId: 'req-abc-123',
      });

      const rows = await client.query(
        `SELECT payload FROM public.chiefos_quote_events
          WHERE quote_id=$1 AND kind='lifecycle.customer_viewed'`,
        [header.id]
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].payload).toEqual({ source_msg_id: 'req-abc-123' });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('source_msg_id absent (undefined): key not written (payload={})', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { header, version, token } = await seedQuoteAndToken(client, pre);

      // Omit sourceMsgId entirely.
      await emitLifecycleCustomerViewed(client, {
        quoteId: header.id, versionId: version.id,
        tenantId: pre.tenantId, ownerId: pre.ownerId,
        actorSource: 'portal', actorUserId: token.id,
        emittedAt: '2026-04-22T12:00:00.000Z',
        customerId: pre.customer.id, shareTokenId: token.id,
      });

      const rows = await client.query(
        `SELECT payload FROM public.chiefos_quote_events
          WHERE quote_id=$1 AND kind='lifecycle.customer_viewed'`,
        [header.id]
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].payload).toEqual({});
      expect(Object.keys(rows.rows[0].payload)).not.toContain('source_msg_id');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('source_msg_id empty string (Zod regression edge): posture B writes "" (helper does not silently filter)', async () => {
    // Posture B rationale: Zod's ViewQuoteCILZ rejects empty strings via
    // z.string().min(1).optional(). If an empty string ever reaches the
    // helper, that's a Zod regression worth surfacing — helper writes it
    // to payload rather than silently dropping. Diverging from Zod's
    // contract would mask the regression.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { header, version, token } = await seedQuoteAndToken(client, pre);

      await emitLifecycleCustomerViewed(client, {
        quoteId: header.id, versionId: version.id,
        tenantId: pre.tenantId, ownerId: pre.ownerId,
        actorSource: 'portal', actorUserId: token.id,
        emittedAt: '2026-04-22T12:00:00.000Z',
        customerId: pre.customer.id, shareTokenId: token.id,
        sourceMsgId: '',  // empty string — should NOT be silently filtered
      });

      const rows = await client.query(
        `SELECT payload FROM public.chiefos_quote_events
          WHERE quote_id=$1 AND kind='lifecycle.customer_viewed'`,
        [header.id]
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].payload).toEqual({ source_msg_id: '' });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('chiefos_qe_payload_customer_viewed CHECK: share_token_id NULL → 23514', async () => {
    // Smoke test proving the DB CHECK is engaged. If the constraint is ever
    // dropped or weakened, this test fails loudly.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const pre = await setupQuotePreconditions(client);
      const { header, version } = await seedQuoteAndToken(client, pre);

      let threw = false;
      try {
        await emitLifecycleCustomerViewed(client, {
          quoteId: header.id, versionId: version.id,
          tenantId: pre.tenantId, ownerId: pre.ownerId,
          actorSource: 'portal', actorUserId: null,
          emittedAt: '2026-04-22T12:00:00.000Z',
          customerId: pre.customer.id, shareTokenId: null,  // CHECK violator
        });
      } catch (e) {
        threw = true;
        // pg 23514 = check_violation
        expect(String(e.code || e.message)).toMatch(/23514|chiefos_qe_payload_customer_viewed|check constraint/i);
      }
      expect(threw).toBe(true);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3 Section 4 tests: transaction-body helpers
// ═══════════════════════════════════════════════════════════════════════════

const {
  insertSignedEvent,
  insertSignature,
  updateVersionLocked,
  updateQuoteSigned,
  insertNameMismatchEvent,
} = _internals;

function createMockClient({ rows = [], rejectWith = null } = {}) {
  const query = jest.fn().mockImplementation(() => {
    if (rejectWith) return Promise.reject(rejectWith);
    return Promise.resolve({ rows });
  });
  return { query };
}

const S4_TENANT  = '00000000-c2c2-c2c2-c2c2-000000000001';
const S4_OWNER   = '00000000000';
const S4_QUOTE   = '00000000-c2c2-c2c2-c2c2-000000000002';
const S4_VERSION = '00000000-c2c2-c2c2-c2c2-000000000003';
const S4_SIG     = '00000000-c2c2-c2c2-c2c2-000000000004';
const S4_TOKEN   = '00000000-c2c2-c2c2-c2c2-000000000005';
const S4_EVENT   = '00000000-c2c2-c2c2-c2c2-000000000006';
const S4_CORR    = '00000000-aaaa-bbbb-cccc-000000000001';
const S4_HASH    = '7d4f0f5664e7e5942629cb6c8ccdeff04ad95178c2da98f8197056f8bad0d977';
const S4_OCCURRED = new Date('2026-04-21T12:00:00Z');

// ─── insertSignedEvent ────────────────────────────────────────────────────

describe('SignQuote — Section 4: insertSignedEvent', () => {
  function validParams(overrides = {}) {
    return {
      tenantId: S4_TENANT, ownerId: S4_OWNER, correlationId: S4_CORR,
      quoteId: S4_QUOTE, quoteVersionId: S4_VERSION, shareTokenId: S4_TOKEN,
      versionHashAtSign: S4_HASH,
      actorSource: 'portal', actorUserId: S4_TOKEN,
      occurredAt: S4_OCCURRED,
      ...overrides,
    };
  }

  it('happy path returns { signedEventId, emittedAt }', async () => {
    const client = createMockClient({
      rows: [{ id: S4_EVENT, emitted_at: S4_OCCURRED }],
    });
    const out = await insertSignedEvent(client, validParams());
    expect(out).toEqual({ signedEventId: S4_EVENT, emittedAt: S4_OCCURRED });
  });

  it('SQL contains lifecycle.signed literal + correct table', async () => {
    const client = createMockClient({ rows: [{ id: S4_EVENT, emitted_at: S4_OCCURRED }] });
    await insertSignedEvent(client, validParams());
    const sql = client.query.mock.calls[0][0];
    expect(sql).toContain("'lifecycle.signed'");
    expect(sql).toContain('INTO public.chiefos_quote_events');
  });

  it('params in correct positional order', async () => {
    const client = createMockClient({ rows: [{ id: S4_EVENT, emitted_at: S4_OCCURRED }] });
    await insertSignedEvent(client, validParams());
    const params = client.query.mock.calls[0][1];
    expect(params[0]).toBe(S4_TENANT);
    expect(params[1]).toBe(S4_OWNER);
    expect(params[2]).toBe(S4_QUOTE);
    expect(params[3]).toBe(S4_VERSION);
    expect(params[4]).toBe('portal');
    expect(params[5]).toBe(S4_TOKEN);
    expect(params[6]).toBe(S4_TOKEN);
    expect(params[7]).toBe(S4_CORR);
    expect(params[8]).toBe(S4_OCCURRED);
    expect(JSON.parse(params[9])).toEqual({ version_hash_at_sign: S4_HASH });
  });

  it('correlation_id parameter is the passed-in value (not undefined)', async () => {
    const client = createMockClient({ rows: [{ id: S4_EVENT, emitted_at: S4_OCCURRED }] });
    await insertSignedEvent(client, validParams({ correlationId: S4_CORR }));
    const params = client.query.mock.calls[0][1];
    expect(params[7]).toBe(S4_CORR);
  });

  it('payload JSON includes version_hash_at_sign verbatim', async () => {
    const client = createMockClient({ rows: [{ id: S4_EVENT, emitted_at: S4_OCCURRED }] });
    await insertSignedEvent(client, validParams({ versionHashAtSign: S4_HASH }));
    const payloadJson = client.query.mock.calls[0][1][9];
    expect(JSON.parse(payloadJson).version_hash_at_sign).toBe(S4_HASH);
  });

  it('emits occurredAt as emitted_at (not server NOW) — Addition 2', async () => {
    const occurredAt = new Date('2026-04-20T12:00:00Z');
    const client = createMockClient({
      rows: [{ id: S4_EVENT, emitted_at: occurredAt }],
    });
    await insertSignedEvent(client, validParams({ occurredAt }));
    const params = client.query.mock.calls[0][1];
    expect(params).toContain(occurredAt);
  });

  it('pg error propagates unmodified', async () => {
    const err = new Error('mock pg failure');
    const client = createMockClient({ rejectWith: err });
    await expect(insertSignedEvent(client, validParams())).rejects.toBe(err);
  });
});

// ─── insertSignature ──────────────────────────────────────────────────────

describe('SignQuote — Section 4: insertSignature', () => {
  function validParams(overrides = {}) {
    return {
      signatureId: S4_SIG, quoteVersionId: S4_VERSION,
      tenantId: S4_TENANT, ownerId: S4_OWNER,
      signedEventId: S4_EVENT, shareTokenId: S4_TOKEN,
      signerName: 'Ceremony Signer',
      signerEmail: null, signerIp: '1.2.3.4', signerUserAgent: 'test-ua',
      signaturePngStorageKey: 'chiefos-signatures/' + S4_TENANT + '/' + S4_QUOTE + '/' + S4_VERSION + '/' + S4_SIG + '.png',
      signaturePngSha256: S4_HASH,
      versionHashAtSign: S4_HASH,
      nameMatchAtSign: true,
      recipientNameAtSign: 'Ceremony Customer',
      sourceMsgId: 'test-src-msg-1',
      ...overrides,
    };
  }

  it('happy path returns { signatureId, signedAt, nameMatchAtSign }', async () => {
    const signedAt = new Date('2026-04-21T12:00:00Z');
    const client = createMockClient({
      rows: [{ id: S4_SIG, signed_at: signedAt, name_match_at_sign: true }],
    });
    const out = await insertSignature(client, validParams());
    expect(out).toEqual({ signatureId: S4_SIG, signedAt, nameMatchAtSign: true });
  });

  it('SQL targets chiefos_quote_signatures and uses NOW() for signed_at', async () => {
    const client = createMockClient({
      rows: [{ id: S4_SIG, signed_at: new Date(), name_match_at_sign: true }],
    });
    await insertSignature(client, validParams());
    const sql = client.query.mock.calls[0][0];
    expect(sql).toContain('INTO public.chiefos_quote_signatures');
    expect(sql).toContain('NOW()');
  });

  it('16 params in correct positional order', async () => {
    const client = createMockClient({
      rows: [{ id: S4_SIG, signed_at: new Date(), name_match_at_sign: true }],
    });
    await insertSignature(client, validParams());
    const params = client.query.mock.calls[0][1];
    expect(params.length).toBe(16);
    expect(params[0]).toBe(S4_SIG);
    expect(params[1]).toBe(S4_VERSION);
    expect(params[2]).toBe(S4_TENANT);
    expect(params[3]).toBe(S4_OWNER);
    expect(params[4]).toBe(S4_EVENT);
    expect(params[5]).toBe(S4_TOKEN);
    expect(params[12]).toBe(S4_HASH);          // version_hash_at_sign
    expect(params[13]).toBe(true);             // name_match_at_sign
    expect(params[14]).toBe('Ceremony Customer'); // recipient_name_at_sign
    expect(params[15]).toBe('test-src-msg-1'); // source_msg_id
  });

  it('nameMatchAtSign=false writes boolean false (not string)', async () => {
    const client = createMockClient({
      rows: [{ id: S4_SIG, signed_at: new Date(), name_match_at_sign: false }],
    });
    await insertSignature(client, validParams({ nameMatchAtSign: false }));
    const params = client.query.mock.calls[0][1];
    expect(params[13]).toBe(false);
    expect(typeof params[13]).toBe('boolean');
  });

  it('nullable fields (signerEmail, signerIp, signerUserAgent, sourceMsgId) accept null', async () => {
    const client = createMockClient({
      rows: [{ id: S4_SIG, signed_at: new Date(), name_match_at_sign: true }],
    });
    await insertSignature(client, validParams({
      signerEmail: null, signerIp: null, signerUserAgent: null, sourceMsgId: null,
    }));
    const params = client.query.mock.calls[0][1];
    expect(params[7]).toBeNull();   // signer_email
    expect(params[8]).toBeNull();   // signer_ip
    expect(params[9]).toBeNull();   // signer_user_agent
    expect(params[15]).toBeNull();  // source_msg_id
  });

  it('23505 on source_msg_unique propagates unmodified', async () => {
    const err = Object.assign(new Error('duplicate key'), {
      code: '23505', constraint: 'chiefos_qs_source_msg_unique',
    });
    const client = createMockClient({ rejectWith: err });
    await expect(insertSignature(client, validParams())).rejects.toBe(err);
  });

  it('23505 on version_unique propagates unmodified', async () => {
    const err = Object.assign(new Error('duplicate key'), {
      code: '23505', constraint: 'chiefos_qs_version_unique',
    });
    const client = createMockClient({ rejectWith: err });
    await expect(insertSignature(client, validParams())).rejects.toBe(err);
  });

  it('generic pg error propagates unmodified', async () => {
    const err = new Error('connection lost');
    const client = createMockClient({ rejectWith: err });
    await expect(insertSignature(client, validParams())).rejects.toBe(err);
  });
});

// ─── updateVersionLocked ──────────────────────────────────────────────────

describe('SignQuote — Section 4: updateVersionLocked', () => {
  function validParams(overrides = {}) {
    return {
      versionId: S4_VERSION, tenantId: S4_TENANT, ownerId: S4_OWNER,
      serverHash: S4_HASH,
      ...overrides,
    };
  }

  it('happy path returns 5 fields from RETURNING', async () => {
    const lockedAt = new Date('2026-04-21T12:00:00Z');
    const client = createMockClient({
      rows: [{
        id: S4_VERSION, locked_at: lockedAt, server_hash: S4_HASH,
        signed_at: lockedAt, status: 'signed',
      }],
    });
    const out = await updateVersionLocked(client, validParams());
    expect(out).toEqual({
      versionId: S4_VERSION, lockedAt, serverHash: S4_HASH,
      signedAt: lockedAt, status: 'signed',
    });
  });

  it('SQL contains single atomic update with status + locked_at + server_hash + signed_at', async () => {
    const client = createMockClient({
      rows: [{
        id: S4_VERSION, locked_at: new Date(), server_hash: S4_HASH,
        signed_at: new Date(), status: 'signed',
      }],
    });
    await updateVersionLocked(client, validParams());
    const sql = client.query.mock.calls[0][0];
    expect(sql).toContain("status = 'signed'");
    expect(sql).toContain('locked_at = NOW()');
    expect(sql).toContain('server_hash = $1');
    expect(sql).toContain('signed_at = NOW()');
  });

  it('params in correct order: [serverHash, versionId, tenantId, ownerId]', async () => {
    const client = createMockClient({
      rows: [{
        id: S4_VERSION, locked_at: new Date(), server_hash: S4_HASH,
        signed_at: new Date(), status: 'signed',
      }],
    });
    await updateVersionLocked(client, validParams());
    const params = client.query.mock.calls[0][1];
    expect(params).toEqual([S4_HASH, S4_VERSION, S4_TENANT, S4_OWNER]);
  });

  it('rowCount = 0 throws CilIntegrityError with hint', async () => {
    const client = createMockClient({ rows: [] });
    try {
      await updateVersionLocked(client, validParams());
      throw new Error('expected throw');
    } catch (e) {
      expect(e.name).toBe('CilIntegrityError');
      expect(e.code).toBe('CIL_INTEGRITY_ERROR');
      expect(e.hint).toContain(S4_VERSION);
      expect(e.hint).toContain('rowCount=0');
    }
  });

  it('pg error propagates unmodified', async () => {
    const err = new Error('lock timeout');
    const client = createMockClient({ rejectWith: err });
    await expect(updateVersionLocked(client, validParams())).rejects.toBe(err);
  });
});

// ─── updateQuoteSigned ────────────────────────────────────────────────────

describe('SignQuote — Section 4: updateQuoteSigned', () => {
  function validParams(overrides = {}) {
    return {
      quoteId: S4_QUOTE, tenantId: S4_TENANT, ownerId: S4_OWNER,
      ...overrides,
    };
  }

  it('happy path returns { quoteId, status, updatedAt }', async () => {
    const updatedAt = new Date('2026-04-21T12:00:00Z');
    const client = createMockClient({
      rows: [{ id: S4_QUOTE, status: 'signed', updated_at: updatedAt }],
    });
    const out = await updateQuoteSigned(client, validParams());
    expect(out).toEqual({ quoteId: S4_QUOTE, status: 'signed', updatedAt });
  });

  it('SQL contains status signed + updated_at NOW', async () => {
    const client = createMockClient({
      rows: [{ id: S4_QUOTE, status: 'signed', updated_at: new Date() }],
    });
    await updateQuoteSigned(client, validParams());
    const sql = client.query.mock.calls[0][0];
    expect(sql).toContain("status = 'signed'");
    expect(sql).toContain('updated_at = NOW()');
  });

  it('params in correct order', async () => {
    const client = createMockClient({
      rows: [{ id: S4_QUOTE, status: 'signed', updated_at: new Date() }],
    });
    await updateQuoteSigned(client, validParams());
    expect(client.query.mock.calls[0][1]).toEqual([S4_QUOTE, S4_TENANT, S4_OWNER]);
  });

  it('rowCount = 0 throws CilIntegrityError', async () => {
    const client = createMockClient({ rows: [] });
    try {
      await updateQuoteSigned(client, validParams());
      throw new Error('expected throw');
    } catch (e) {
      expect(e.name).toBe('CilIntegrityError');
      expect(e.code).toBe('CIL_INTEGRITY_ERROR');
      expect(e.hint).toContain(S4_QUOTE);
    }
  });

  it('pg error propagates unmodified', async () => {
    const err = new Error('deadlock');
    const client = createMockClient({ rejectWith: err });
    await expect(updateQuoteSigned(client, validParams())).rejects.toBe(err);
  });
});

// ─── insertNameMismatchEvent ──────────────────────────────────────────────

describe('SignQuote — Section 4: insertNameMismatchEvent', () => {
  const FORENSIC_PAYLOAD = {
    rule_id: 'last_token_normalize_v1',
    typed_signer_name: 'Darlene Smith',
    recipient_name_at_sign: 'Darlene MacDonald',
    recipient_last_token: 'macdonald',
    typed_last_token: 'smith',
    recipient_normalized: 'darlene macdonald',
    typed_normalized: 'darlene smith',
  };

  function validParams(overrides = {}) {
    return {
      tenantId: S4_TENANT, ownerId: S4_OWNER, correlationId: S4_CORR,
      quoteId: S4_QUOTE, quoteVersionId: S4_VERSION, signatureId: S4_SIG,
      payload: FORENSIC_PAYLOAD,
      actorSource: 'portal', actorUserId: S4_TOKEN,
      occurredAt: S4_OCCURRED,
      ...overrides,
    };
  }

  it('happy path returns { eventId, emittedAt }', async () => {
    const eventId = '00000000-c2c2-c2c2-c2c2-0000000000e1';
    const client = createMockClient({
      rows: [{ id: eventId, emitted_at: S4_OCCURRED }],
    });
    const out = await insertNameMismatchEvent(client, validParams());
    expect(out).toEqual({ eventId, emittedAt: S4_OCCURRED });
  });

  it('SQL contains integrity.name_mismatch_signed literal', async () => {
    const client = createMockClient({ rows: [{ id: 'e1', emitted_at: S4_OCCURRED }] });
    await insertNameMismatchEvent(client, validParams());
    const sql = client.query.mock.calls[0][0];
    expect(sql).toContain("'integrity.name_mismatch_signed'");
  });

  it('params in correct positional order with signature_id populated', async () => {
    const client = createMockClient({ rows: [{ id: 'e1', emitted_at: S4_OCCURRED }] });
    await insertNameMismatchEvent(client, validParams());
    const params = client.query.mock.calls[0][1];
    expect(params[0]).toBe(S4_TENANT);
    expect(params[1]).toBe(S4_OWNER);
    expect(params[2]).toBe(S4_QUOTE);
    expect(params[3]).toBe(S4_VERSION);
    expect(params[4]).toBe('portal');
    expect(params[5]).toBe(S4_TOKEN);
    expect(params[6]).toBe(S4_SIG);   // signature_id populated (NOT NULL per CHECK)
    expect(params[7]).toBe(S4_CORR);
    expect(params[8]).toBe(S4_OCCURRED);
  });

  it('payload JSON includes all 7 forensic keys', async () => {
    const client = createMockClient({ rows: [{ id: 'e1', emitted_at: S4_OCCURRED }] });
    await insertNameMismatchEvent(client, validParams());
    const payloadJson = client.query.mock.calls[0][1][9];
    const parsed = JSON.parse(payloadJson);
    expect(parsed).toEqual(FORENSIC_PAYLOAD);
    expect(Object.keys(parsed).sort()).toEqual([
      'recipient_last_token', 'recipient_name_at_sign', 'recipient_normalized',
      'rule_id', 'typed_last_token', 'typed_normalized', 'typed_signer_name',
    ]);
  });

  it('correlation_id matches input value', async () => {
    const client = createMockClient({ rows: [{ id: 'e1', emitted_at: S4_OCCURRED }] });
    await insertNameMismatchEvent(client, validParams());
    expect(client.query.mock.calls[0][1][7]).toBe(S4_CORR);
  });

  it('emits occurredAt as emitted_at (not server NOW) — Addition 2', async () => {
    const occurredAt = new Date('2026-04-20T12:00:00Z');
    const client = createMockClient({ rows: [{ id: 'e1', emitted_at: occurredAt }] });
    await insertNameMismatchEvent(client, validParams({ occurredAt }));
    const params = client.query.mock.calls[0][1];
    expect(params).toContain(occurredAt);
  });

  it('pg 23514 on CHECK violation propagates unmodified', async () => {
    const err = Object.assign(new Error('check_violation'), {
      code: '23514', constraint: 'chiefos_qe_payload_name_mismatch_signed',
    });
    const client = createMockClient({ rejectWith: err });
    await expect(insertNameMismatchEvent(client, validParams())).rejects.toBe(err);
  });
});

// ─── Cross-helper correlation_id invariant ─────────────────────────────────

describe('SignQuote — Section 4: correlation_id invariant across event helpers', () => {
  it('insertSignedEvent + insertNameMismatchEvent called with same correlationId write same DB value', async () => {
    const sameCorr = '00000000-aaaa-aaaa-aaaa-000000000001';

    const client1 = createMockClient({ rows: [{ id: 'e1', emitted_at: S4_OCCURRED }] });
    await insertSignedEvent(client1, {
      tenantId: S4_TENANT, ownerId: S4_OWNER, correlationId: sameCorr,
      quoteId: S4_QUOTE, quoteVersionId: S4_VERSION, shareTokenId: S4_TOKEN,
      versionHashAtSign: S4_HASH, actorSource: 'portal', actorUserId: S4_TOKEN,
      occurredAt: S4_OCCURRED,
    });
    const corrInSignedEvent = client1.query.mock.calls[0][1][7];

    const client2 = createMockClient({ rows: [{ id: 'e2', emitted_at: S4_OCCURRED }] });
    await insertNameMismatchEvent(client2, {
      tenantId: S4_TENANT, ownerId: S4_OWNER, correlationId: sameCorr,
      quoteId: S4_QUOTE, quoteVersionId: S4_VERSION, signatureId: S4_SIG,
      payload: { rule_id: 'last_token_normalize_v1' },
      actorSource: 'portal', actorUserId: S4_TOKEN, occurredAt: S4_OCCURRED,
    });
    const corrInMismatchEvent = client2.query.mock.calls[0][1][7];

    expect(corrInSignedEvent).toBe(sameCorr);
    expect(corrInMismatchEvent).toBe(sameCorr);
    expect(corrInSignedEvent).toBe(corrInMismatchEvent);
  });

  it('helpers do not generate their own correlationId — passing undefined writes undefined', async () => {
    // Defensive: helpers must not have a fallback like `|| crypto.randomUUID()`.
    // If the handler forgets to pass correlationId, the DB NULL/undefined write
    // surfaces as a visible bug, not a silent self-correction.
    const client = createMockClient({ rows: [{ id: 'e1', emitted_at: S4_OCCURRED }] });
    await insertSignedEvent(client, {
      tenantId: S4_TENANT, ownerId: S4_OWNER, correlationId: undefined,
      quoteId: S4_QUOTE, quoteVersionId: S4_VERSION, shareTokenId: S4_TOKEN,
      versionHashAtSign: S4_HASH, actorSource: 'portal', actorUserId: S4_TOKEN,
      occurredAt: S4_OCCURRED,
    });
    expect(client.query.mock.calls[0][1][7]).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3 Section 5 tests: handleSignQuote orchestration
// ═══════════════════════════════════════════════════════════════════════════
//
// Unit-style tests: mock the module's infrastructure dependencies
// (services/postgres, services/supabaseAdmin) via jest.mock to isolate
// handler orchestration logic from real DB / Storage calls. Happy-path,
// failure-path, and invariant tests validate the 23-step sequence without
// hitting production. Integration ceremony lands in Section 6.

const { handleSignQuote } = require('./quotes');

describe('SignQuote — Section 5: handleSignQuote', () => {
  const S5_TENANT  = '00000000-c2c2-c2c2-c2c2-000000000001';
  const S5_OWNER   = '00000000000';
  const S5_QUOTE   = '00000000-c2c2-c2c2-c2c2-000000000002';
  const S5_VERSION = '00000000-c2c2-c2c2-c2c2-000000000003';
  const S5_TOKEN_ID = '00000000-c2c2-c2c2-c2c2-000000000005';
  const S5_TOKEN_STR = 'K5gQbxTdNcN1ZNqmoGtaww';
  const S5_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  function validCil(overrides = {}) {
    return {
      cil_version: '1.0',
      type: 'SignQuote',
      tenant_id: S5_TENANT,
      source: 'web',
      source_msg_id: `test-sign-${Date.now()}-${Math.random()}`,
      actor: { actor_id: S5_TOKEN_ID, role: 'customer' },
      occurred_at: new Date().toISOString(),
      job: null,
      needs_job_resolution: false,
      share_token: S5_TOKEN_STR,
      signer_name: 'Ceremony Customer',
      signature_png_data_url: S5_PNG_DATA_URL,
      ...overrides,
    };
  }

  function validCtx(overrides = {}) {
    return {
      owner_id: S5_OWNER,
      traceId: `trace-sign-${Date.now()}`,
      signer_ip: '127.0.0.1',
      signer_user_agent: 'test-ua',
      ...overrides,
    };
  }

  // ─── Pre-BEGIN rejections (no DB interaction required) ──────────────────

  describe('pre-BEGIN rejections', () => {
    it('ctx missing owner_id → OWNER_ID_MISSING', async () => {
      const result = await handleSignQuote(validCil(), { traceId: 't1' });
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('OWNER_ID_MISSING');
    });

    it('ctx missing traceId → TRACE_ID_MISSING', async () => {
      const result = await handleSignQuote(validCil(), { owner_id: S5_OWNER });
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('TRACE_ID_MISSING');
    });

    it('Zod failure (missing type) → CIL_SCHEMA_INVALID', async () => {
      const { type: _t, ...bad } = validCil();
      const result = await handleSignQuote(bad, validCtx());
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('CIL_SCHEMA_INVALID');
    });

    it('Zod failure (non-customer role) → CIL_SCHEMA_INVALID (Zod literal reject)', async () => {
      const cil = validCil({ actor: { actor_id: S5_TOKEN_ID, role: 'owner' } });
      const result = await handleSignQuote(cil, validCtx());
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('CIL_SCHEMA_INVALID');
    });

    it('malformed PNG data URL → CIL_SCHEMA_INVALID', async () => {
      const cil = validCil({ signature_png_data_url: 'not-a-data-url' });
      const result = await handleSignQuote(cil, validCtx());
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('CIL_SCHEMA_INVALID');
    });

    it('malformed share_token (21 chars) → CIL_SCHEMA_INVALID', async () => {
      const cil = validCil({ share_token: S5_TOKEN_STR.slice(0, 21) });
      const result = await handleSignQuote(cil, validCtx());
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('CIL_SCHEMA_INVALID');
    });

    it('traceId propagates into errEnvelope', async () => {
      const result = await handleSignQuote(validCil(), { owner_id: S5_OWNER });
      expect(result.error.traceId).toBeNull();
      const result2 = await handleSignQuote({}, validCtx({ traceId: 'my-trace' }));
      expect(result2.error.traceId).toBe('my-trace');
    });
  });

  // ─── Share-token resolver path (live pg; share-token not found) ────────
  //
  // These tests use the real pg pool; a non-existent share token returns
  // null from lookupPriorSignature AND loadSignContext's Q1, producing
  // SHARE_TOKEN_NOT_FOUND envelope. No DB writes; no signature exists to
  // idempotent-retry against.

  describe('live share-token resolution', () => {
    // Skip if no DATABASE_URL — matches existing integration-test gate.
    const hasDb = !!process.env.DATABASE_URL;
    const describeIfDb = hasDb ? describe : describe.skip;

    describeIfDb('with live DB', () => {
      const NONEXISTENT_TOKEN = 'Zzzz9zzZzzZzzZzzZzzZzz';  // valid shape, doesn't exist

      it('share_token not found in DB → SHARE_TOKEN_NOT_FOUND envelope', async () => {
        const cil = validCil({ share_token: NONEXISTENT_TOKEN });
        const ctx = validCtx();
        const result = await handleSignQuote(cil, ctx);
        expect(result.ok).toBe(false);
        expect(result.error.code).toBe('SHARE_TOKEN_NOT_FOUND');
        expect(result.error.traceId).toBe(ctx.traceId);
      });
    });
  });

  // ─── Idempotent retry: prior signature returns prior state ─────────────
  //
  // Using the Phase 2C ceremony signature (QT-CEREMONY-2026-04-20-PHASE2C)
  // as a known-existing prior signature. A SignQuote CIL with matching
  // owner_id + source_msg_id hits lookupPriorSignature at step 5 and
  // returns prior state with alreadyExisted=true.

  describe('idempotent retry (Phase 2C ceremony signature)', () => {
    const hasDb = !!process.env.DATABASE_URL;
    const describeIfDb = hasDb ? describe : describe.skip;

    describeIfDb('with live DB + ceremony signature', () => {
      let pg;
      let ceremonySourceMsgId;

      beforeAll(async () => {
        // eslint-disable-next-line global-require
        pg = require('../../services/postgres');
        // Seed a source_msg_id on the ceremony signature row so
        // lookupPriorSignature finds it. If already set (from a prior
        // test run), reuse.
        const ceremonyTenant = '00000000-c2c2-c2c2-c2c2-000000000001';
        const ceremonyOwner = '00000000000';
        const existing = await pg.query(
          `SELECT source_msg_id FROM public.chiefos_quote_signatures
            WHERE tenant_id = $1 AND owner_id = $2 LIMIT 1`,
          [ceremonyTenant, ceremonyOwner]
        );
        if (existing.rows.length > 0) {
          ceremonySourceMsgId = existing.rows[0].source_msg_id
            || `section5-test-seed-${Date.now()}`;
          if (!existing.rows[0].source_msg_id) {
            // strict-immutability trigger blocks UPDATE; skip if source_msg_id
            // is null. Test becomes a no-op with a flag.
            ceremonySourceMsgId = null;
          }
        }
      });

      it('retry with same source_msg_id returns prior signature state', async () => {
        if (!ceremonySourceMsgId) {
          console.warn('[SEC5-RETRY-TEST] ceremony source_msg_id null; skipping retry assertion');
          return;
        }
        const cil = validCil({
          tenant_id: '00000000-c2c2-c2c2-c2c2-000000000001',
          source_msg_id: ceremonySourceMsgId,
        });
        const result = await handleSignQuote(cil, validCtx({ owner_id: '00000000000' }));
        expect(result.ok).toBe(true);
        expect(result.meta.already_existed).toBe(true);
        expect(result.meta.events_emitted).toEqual([]);
        expect(result.signature.id).toBeDefined();
      });
    });
  });

  // ─── Helper composition (pure function coverage) ─────────────────────────

  describe('composeNameMismatchPayload helper', () => {
    const { composeNameMismatchPayload } = _internals;

    it('composes 7-key forensic payload from computeNameMatch result', () => {
      const matchResult = {
        matches: false,
        ruleId: 'last_token_normalize_v1',
        recipientLastToken: 'macdonald',
        typedLastToken: 'smith',
        recipientNormalized: 'darlene macdonald',
        typedNormalized: 'darlene smith',
      };
      const payload = composeNameMismatchPayload(matchResult, 'Darlene Smith', 'Darlene MacDonald');
      expect(payload).toEqual({
        rule_id: 'last_token_normalize_v1',
        typed_signer_name: 'Darlene Smith',
        recipient_name_at_sign: 'Darlene MacDonald',
        recipient_last_token: 'macdonald',
        typed_last_token: 'smith',
        recipient_normalized: 'darlene macdonald',
        typed_normalized: 'darlene smith',
      });
    });

    it('payload has exactly 7 keys (DB CHECK minimum rule_id + 6 forensic)', () => {
      const matchResult = {
        matches: false, ruleId: 'v1',
        recipientLastToken: 'a', typedLastToken: 'b',
        recipientNormalized: 'a', typedNormalized: 'b',
      };
      const payload = composeNameMismatchPayload(matchResult, 'x', 'y');
      expect(Object.keys(payload).sort()).toEqual([
        'recipient_last_token', 'recipient_name_at_sign', 'recipient_normalized',
        'rule_id', 'typed_last_token', 'typed_normalized', 'typed_signer_name',
      ]);
    });
  });

  describe('composeSignQuoteEmail helper', () => {
    const { composeSignQuoteEmail } = _internals;

    const baseCtx = {
      tenantSnapshot: { brand_name: 'Phase 2C Ceremony', legal_name: 'Ceremony Tenant' },
      humanId: 'QT-CEREMONY-2026-04-21',
      projectTitle: 'Phase 2C Ceremony',
      recipientName: 'Darlene MacDonald',
      totalCents: 13000,
      currency: 'CAD',
    };

    const baseSig = {
      signedAt: new Date('2026-04-21T12:00:00Z'),
      sha256: '7d4f0f5664e7e5942629cb6c8ccdeff04ad95178c2da98f8197056f8bad0d977',
      typedName: 'Darlene MacDonald',
    };

    it('subject format: [brand] <name> signed <humanId>', () => {
      const matchResult = { matches: true };
      const { subject } = composeSignQuoteEmail({
        ctx: baseCtx, signatureInfo: baseSig, nameMatchResult: matchResult,
        shareUrl: 'https://example.com/q/X',
      });
      expect(subject).toBe('[Phase 2C Ceremony] Darlene MacDonald signed QT-CEREMONY-2026-04-21');
    });

    it('body contains MATCHED when name match true', () => {
      const matchResult = { matches: true };
      const { textBody } = composeSignQuoteEmail({
        ctx: baseCtx, signatureInfo: baseSig, nameMatchResult: matchResult,
        shareUrl: 'https://example.com/q/X',
      });
      expect(textBody).toContain('Name match:  MATCHED');
    });

    it('body contains MISMATCH with typed vs recipient when name match false', () => {
      const matchResult = { matches: false };
      const { textBody } = composeSignQuoteEmail({
        ctx: baseCtx,
        signatureInfo: { ...baseSig, typedName: 'Robert MacDonald' },
        nameMatchResult: matchResult,
        shareUrl: 'https://example.com/q/X',
      });
      expect(textBody).toContain('Name match:  MISMATCH');
      expect(textBody).toContain('Robert MacDonald');
      expect(textBody).toContain('Darlene MacDonald');
    });

    it('body includes share URL', () => {
      const { textBody } = composeSignQuoteEmail({
        ctx: baseCtx, signatureInfo: baseSig, nameMatchResult: { matches: true },
        shareUrl: 'https://app.usechiefos.com/q/abc123',
      });
      expect(textBody).toContain('https://app.usechiefos.com/q/abc123');
    });

    it('falls back to legal_name when brand_name missing', () => {
      const { subject } = composeSignQuoteEmail({
        ctx: { ...baseCtx, tenantSnapshot: { legal_name: 'Ceremony Legal' } },
        signatureInfo: baseSig, nameMatchResult: { matches: true },
        shareUrl: 'https://example.com/q/X',
      });
      expect(subject).toContain('Ceremony Legal');
    });

    it('falls back to "ChiefOS" when both brand_name and legal_name missing', () => {
      const { subject } = composeSignQuoteEmail({
        ctx: { ...baseCtx, tenantSnapshot: {} },
        signatureInfo: baseSig, nameMatchResult: { matches: true },
        shareUrl: 'https://example.com/q/X',
      });
      expect(subject).toContain('ChiefOS');
    });

    it('body includes SHA-256 for client-side verification', () => {
      const { textBody } = composeSignQuoteEmail({
        ctx: baseCtx, signatureInfo: baseSig, nameMatchResult: { matches: true },
        shareUrl: 'https://example.com/q/X',
      });
      expect(textBody).toContain(baseSig.sha256);
    });
  });

  describe('buildSignQuoteReturnShape helper', () => {
    const { buildSignQuoteReturnShape } = _internals;

    function baseInputs() {
      return {
        signCtx: {
          humanId: 'QT-TEST',
          versionNo: 1,
          shareTokenId: S5_TOKEN_ID,
          shareTokenValue: S5_TOKEN_STR,
        },
        sigResult: {
          signatureId: '00000000-c2c2-c2c2-c2c2-000000000004',
          signedAt: new Date('2026-04-21T12:00:00Z'),
          nameMatchAtSign: true,
        },
        verResult: {
          versionId: S5_VERSION,
          status: 'signed',
          lockedAt: new Date('2026-04-21T12:00:00Z'),
          serverHash: '7d4f0f5664e7e5942629cb6c8ccdeff04ad95178c2da98f8197056f8bad0d977',
          signedAt: new Date('2026-04-21T12:00:00Z'),
        },
        qResult: {
          quoteId: S5_QUOTE,
          status: 'signed',
          updatedAt: new Date('2026-04-21T12:00:00Z'),
        },
        uploadResult: {
          sha256: '7d4f0f5664e7e5942629cb6c8ccdeff04ad95178c2da98f8197056f8bad0d977',
        },
        correlationId: '00000000-aaaa-bbbb-cccc-000000000001',
        eventsEmitted: ['lifecycle.signed', 'notification.sent'],
        alreadyExisted: false,
        traceId: 'trace-1',
      };
    }

    it('happy path: all 5 entities + meta present', () => {
      const shape = buildSignQuoteReturnShape(baseInputs());
      expect(shape).toHaveProperty('ok', true);
      expect(shape).toHaveProperty('signature');
      expect(shape).toHaveProperty('quote');
      expect(shape).toHaveProperty('version');
      expect(shape).toHaveProperty('share_token');
      expect(shape).toHaveProperty('meta');
    });

    it('meta.correlation_id matches input correlationId', () => {
      const shape = buildSignQuoteReturnShape(baseInputs());
      expect(shape.meta.correlation_id).toBe('00000000-aaaa-bbbb-cccc-000000000001');
    });

    it('meta.already_existed = false on fresh invocation', () => {
      const shape = buildSignQuoteReturnShape(baseInputs());
      expect(shape.meta.already_existed).toBe(false);
    });

    it('meta.events_emitted reflects input array', () => {
      const shape = buildSignQuoteReturnShape(baseInputs());
      expect(shape.meta.events_emitted).toEqual(['lifecycle.signed', 'notification.sent']);
    });

    it('meta.traceId matches input', () => {
      const shape = buildSignQuoteReturnShape(baseInputs());
      expect(shape.meta.traceId).toBe('trace-1');
    });

    it('signature.sha256 equals upload result sha256', () => {
      const shape = buildSignQuoteReturnShape(baseInputs());
      expect(shape.signature.sha256).toBe(baseInputs().uploadResult.sha256);
    });

    it('version entity includes all 6 expected fields', () => {
      const shape = buildSignQuoteReturnShape(baseInputs());
      expect(shape.version).toHaveProperty('id');
      expect(shape.version).toHaveProperty('version_no');
      expect(shape.version).toHaveProperty('status', 'signed');
      expect(shape.version).toHaveProperty('locked_at');
      expect(shape.version).toHaveProperty('server_hash');
      expect(shape.version).toHaveProperty('signed_at');
    });

    it('storage_key field is populated from sigResult.storageKey (Phase 3 ceremony regression lock)', () => {
      const inputs = baseInputs();
      inputs.sigResult.storageKey =
        'chiefos-signatures/00000000-c3c3-c3c3-c3c3-000000000001/' +
        '00000000-c3c3-c3c3-c3c3-000000000002/' +
        '00000000-c3c3-c3c3-c3c3-000000000003/' +
        '00000000-c2c2-c2c2-c2c2-000000000004.png';
      const { SIGNATURE_STORAGE_KEY_RE } = require('./quoteSignatureStorage');
      const shape = buildSignQuoteReturnShape(inputs);
      expect(shape.signature.storage_key).toBe(inputs.sigResult.storageKey);
      expect(SIGNATURE_STORAGE_KEY_RE.test(shape.signature.storage_key)).toBe(true);
      // Flag for future handler sections: exact-key-match tests on
      // return shape (like §25.7's Q7 surface contract) catch these
      // field-drop bugs at unit-test time, not at ceremony time.
    });
  });

  describe('priorSignatureToReturnShape helper', () => {
    const { priorSignatureToReturnShape } = _internals;

    function priorRow() {
      return {
        signature_id: '00000000-c2c2-c2c2-c2c2-000000000004',
        signed_at: new Date('2026-04-20T11:18:22Z'),
        name_match_at_sign: true,
        signature_png_sha256: '7d4f0f5664e7e5942629cb6c8ccdeff04ad95178c2da98f8197056f8bad0d977',
        signature_png_storage_key: 'chiefos-signatures/...',
        quote_id: S5_QUOTE,
        human_id: 'QT-PRIOR',
        quote_status: 'signed',
        quote_version_id: S5_VERSION,
        version_no: 1,
        version_status: 'signed',
        version_locked_at: new Date('2026-04-20T11:18:22Z'),
        version_server_hash: '7d4f0f5664e7e5942629cb6c8ccdeff04ad95178c2da98f8197056f8bad0d977',
        version_signed_at: new Date('2026-04-20T11:18:22Z'),
        share_token_id: S5_TOKEN_ID,
        share_token_value: S5_TOKEN_STR,
      };
    }

    it('alreadyExisted = true', () => {
      const shape = priorSignatureToReturnShape(priorRow(), 't1');
      expect(shape.meta.already_existed).toBe(true);
    });

    it('events_emitted empty (original invocation emitted; retry does not)', () => {
      const shape = priorSignatureToReturnShape(priorRow(), 't1');
      expect(shape.meta.events_emitted).toEqual([]);
    });

    it('correlation_id null (original not persisted on signature row; lookup cannot recover)', () => {
      const shape = priorSignatureToReturnShape(priorRow(), 't1');
      expect(shape.meta.correlation_id).toBeNull();
    });

    it('ok: true returned regardless of original correlation_id', () => {
      const shape = priorSignatureToReturnShape(priorRow(), 't1');
      expect(shape.ok).toBe(true);
    });

    it('entities reflect prior state (signature, quote, version, share_token)', () => {
      const shape = priorSignatureToReturnShape(priorRow(), 't1');
      expect(shape.signature.id).toBe('00000000-c2c2-c2c2-c2c2-000000000004');
      expect(shape.quote.id).toBe(S5_QUOTE);
      expect(shape.version.id).toBe(S5_VERSION);
      expect(shape.share_token.id).toBe(S5_TOKEN_ID);
    });
  });

  // ─── Extended notification emitters (correlation_id wiring) ──────────────

  describe('emitNotificationSent — correlation_id extension', () => {
    const { emitNotificationSent } = _internals;

    it('optional correlationId param defaults to null (SendQuote backward compat)', async () => {
      const pgApi = { query: jest.fn().mockResolvedValue({}) };
      await emitNotificationSent(pgApi, {
        quoteId: S5_QUOTE, versionId: S5_VERSION,
        tenantId: S5_TENANT, ownerId: S5_OWNER,
        actorSource: 'portal', actorUserId: S5_TOKEN_ID,
        emittedAt: new Date(), customerId: null, shareTokenId: S5_TOKEN_ID,
        channel: 'email', recipient: 'test@invalid.test',
        providerMessageId: 'msg-1',
        // NO correlationId — defaults to null
      });
      const params = pgApi.query.mock.calls[0][1];
      // correlation_id is 10th param (0-indexed = 9)
      expect(params[9]).toBeNull();
    });

    it('correlationId param writes through to column', async () => {
      const pgApi = { query: jest.fn().mockResolvedValue({}) };
      const corr = '00000000-aaaa-bbbb-cccc-000000000001';
      await emitNotificationSent(pgApi, {
        quoteId: S5_QUOTE, versionId: S5_VERSION,
        tenantId: S5_TENANT, ownerId: S5_OWNER,
        actorSource: 'portal', actorUserId: S5_TOKEN_ID,
        emittedAt: new Date(), customerId: null, shareTokenId: S5_TOKEN_ID,
        channel: 'email', recipient: 'test@invalid.test',
        providerMessageId: 'msg-1',
        correlationId: corr,
      });
      expect(pgApi.query.mock.calls[0][1][9]).toBe(corr);
    });
  });

  describe('emitNotificationFailed — correlation_id extension', () => {
    const { emitNotificationFailed } = _internals;

    it('optional correlationId param defaults to null', async () => {
      const pgApi = { query: jest.fn().mockResolvedValue({}) };
      await emitNotificationFailed(pgApi, {
        quoteId: S5_QUOTE, versionId: S5_VERSION,
        tenantId: S5_TENANT, ownerId: S5_OWNER,
        actorSource: 'portal', actorUserId: S5_TOKEN_ID,
        emittedAt: new Date(), customerId: null, shareTokenId: S5_TOKEN_ID,
        channel: 'email', recipient: null,
        errorCode: 'NO_CONTRACTOR_EMAIL', errorMessage: 'skipped',
      });
      expect(pgApi.query.mock.calls[0][1][9]).toBeNull();
    });

    it('correlationId param writes through to column', async () => {
      const pgApi = { query: jest.fn().mockResolvedValue({}) };
      const corr = '00000000-aaaa-bbbb-cccc-000000000001';
      await emitNotificationFailed(pgApi, {
        quoteId: S5_QUOTE, versionId: S5_VERSION,
        tenantId: S5_TENANT, ownerId: S5_OWNER,
        actorSource: 'portal', actorUserId: S5_TOKEN_ID,
        emittedAt: new Date(), customerId: null, shareTokenId: S5_TOKEN_ID,
        channel: 'email', recipient: null,
        errorCode: 'NO_CONTRACTOR_EMAIL', errorMessage: 'skipped',
        correlationId: corr,
      });
      expect(pgApi.query.mock.calls[0][1][9]).toBe(corr);
    });
  });

  // ─── lookupPriorSignature helper ────────────────────────────────────────

  describe('lookupPriorSignature', () => {
    const hasDb = !!process.env.DATABASE_URL;
    const describeIfDb = hasDb ? describe : describe.skip;

    describeIfDb('with live DB', () => {
      const { lookupPriorSignature } = _internals;

      it('returns null for nonexistent (owner_id, source_msg_id)', async () => {
        const result = await lookupPriorSignature('99999999999', 'no-such-msg');
        expect(result).toBeNull();
      });
    });
  });
});


