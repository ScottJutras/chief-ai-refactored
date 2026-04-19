// src/cil/quotes.test.helpers.js
// Shared integration-test primitives for CreateQuote and future new-idiom
// handler tests (SendQuote, SignQuote, etc.).
//
// All helpers assume the caller is inside a BEGIN/ROLLBACK transaction so
// seeded rows are discarded at test teardown.

const { randomUUID } = require('crypto');

// Mission Exteriors tenant UUID. Real tenant — used for tests that need a
// tenant profile in src/config/tenantProfiles.js to resolve. BEGIN/ROLLBACK
// in each test ensures no real data persists.
const MISSION_TENANT_UUID = '86907c28-a9ea-4318-819d-5a012192119b';

// Forest City tenant UUID. Dedicated integration-test tenant. Has an entry
// in tenantProfiles.js but no production activity. Used for Section 7
// end-to-end tests that leave residue (event rows can't be deleted per
// Migration 2's immutability trigger).
const FOREST_CITY_TENANT_UUID = 'c1336df0-5267-4c42-955d-9bf20e7e1d28';

/**
 * Seed a throwaway user row in public.users for tests that will insert
 * into public.jobs (jobs.owner_id has FK → users.user_id).
 *
 * @param {pg.PoolClient} client
 * @param {string} [ownerId] - caller's choice or auto-generated 13-digit
 * @param {Object} [opts]
 * @param {string} [opts.planKey] - override default 'free' plan_key column
 * @returns {Promise<string>} the ownerId string
 */
async function seedThrowawayUser(client, ownerId, opts = {}) {
  const id = ownerId || `99${Math.floor(Math.random() * 1e11).toString().padStart(11, '0')}`;
  const planKey = opts.planKey || 'free';
  // sub_status='active' required for getEffectivePlanKey to honor non-free plans.
  // For 'free' the status doesn't matter (default resolve to free anyway).
  await client.query(
    `INSERT INTO public.users (user_id, plan_key, sub_status, created_at)
     VALUES ($1, $2, 'active', NOW())`,
    [id, planKey]
  );
  return id;
}

/**
 * Seed a throwaway customer row in public.customers for the given tenant.
 */
async function seedThrowawayCustomer(client, tenantId, overrides = {}) {
  const fields = {
    name: overrides.name || 'Test Customer',
    email: overrides.email || 'test@example.com',
    phone: overrides.phone || '+14165550000',
    address: overrides.address || '123 Test St, Test City, ON',
  };
  const { rows } = await client.query(
    `INSERT INTO public.customers (tenant_id, name, email, phone, address)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, tenant_id, name, email, phone, address`,
    [tenantId, fields.name, fields.email, fields.phone, fields.address]
  );
  return rows[0];
}

/**
 * Seed a throwaway job row in public.jobs for the given owner.
 * Caller is responsible for seeding the user first (FK target).
 */
async function seedThrowawayJob(client, ownerId, overrides = {}) {
  const name = overrides.name || 'Test Job';
  const jobNo = overrides.job_no || 1;
  const { rows } = await client.query(
    `INSERT INTO public.jobs
       (owner_id, job_no, job_name, name, active, start_date, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, true, NOW(), 'active', NOW(), NOW())
     RETURNING id`,
    [ownerId, jobNo, name, name]
  );
  return rows[0].id;
}

/**
 * setupQuotePreconditions — one-stop seeding for tests that exercise the
 * chiefos_quotes/_versions/_line_items INSERT chain (Sections 4, 5, 6, 7
 * tests and future version-creating handler tests).
 *
 * Seeds: throwaway user, customer, job; allocates a real human_id via the
 * live counter (rolled back with the transaction). Returns a preconditions
 * bag the caller can consume directly for header/version INSERTs.
 *
 * Options:
 *   - tenantId: override (default: Mission Exteriors)
 *   - ownerId: override (default: auto-generated)
 *
 * @param {pg.PoolClient} client - inside a BEGIN transaction.
 * @returns {Promise<{
 *   tenantId: string,
 *   ownerId: string,
 *   customer: Object,
 *   jobId: number,
 *   humanId: string,
 *   sourceMsgId: string,
 * }>}
 */
async function setupQuotePreconditions(client, opts = {}) {
  // eslint-disable-next-line global-require
  const pg = require('../../services/postgres');
  const tenantId = opts.tenantId || MISSION_TENANT_UUID;

  const ownerId = await seedThrowawayUser(client, opts.ownerId);
  const customer = await seedThrowawayCustomer(client, tenantId);
  const jobId = await seedThrowawayJob(client, ownerId);

  // Allocate a real human_id via the live counter. Transaction rollback
  // undoes the counter advance.
  const seq = await pg.allocateNextDocCounter(tenantId, 'quote', client);
  const humanId = `QT-2026-04-19-${String(seq).padStart(4, '0')}`;

  return {
    tenantId,
    ownerId,
    customer,
    jobId,
    humanId,
    sourceMsgId: `test-source-${randomUUID()}`,
  };
}

module.exports = {
  MISSION_TENANT_UUID,
  FOREST_CITY_TENANT_UUID,
  seedThrowawayUser,
  seedThrowawayCustomer,
  seedThrowawayJob,
  setupQuotePreconditions,
};
