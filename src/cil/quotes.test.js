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

const { resolveOrCreateCustomer, resolveOrCreateJob } = _internals;

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
// Remaining scenarios from session brief — todos until their sections land.
// ═══════════════════════════════════════════════════════════════════════════

describe('handleCreateQuote — remaining coverage (todos)', () => {
  // Section 3 (totals + human_id format)
  it.todo('human_id format matches QT-YYYY-MMDD-NNNN derived from occurred_at');
  it.todo('Counter increments: second CreateQuote in same tenant yields NNNN=0002');
  it.todo('Totals computed correctly: 3 line items × qty/price + tax_rate_bps → expected subtotal/tax/total');

  // Section 4 + 5 (INSERTs + pointer UPDATE)
  it.todo('Happy path: header + v1 + line items + 2 events emitted; return shape matches §17.15');
  it.todo('Transaction rollback on mid-INSERT failure: no orphan rows in any of the four tables');

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
