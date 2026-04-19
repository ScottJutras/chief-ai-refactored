// src/cil/quotes.js
// CreateQuote handler and related Zod schemas for the new-idiom Quote spine.
//
// SECTION STATUS (as of this commit):
//   Section 1 (customer resolution): IMPLEMENTED
//   Section 2 (job resolution): IMPLEMENTED
//   Section 3 (human_id + totals + snapshots): IMPLEMENTED
//   Section 4 (header + version + line items INSERTs): IMPLEMENTED
//   Section 5 (current_version_id UPDATE): IMPLEMENTED
//   Section 6 (event emission): IMPLEMENTED
//   Section 7 (classifyCilError handler branches + counter increment + return): TODO
//
// See docs/QUOTES_SPINE_DECISIONS.md:
//   §17.10 — classifyCilError + CilIntegrityError (4-kind classification)
//   §17.12 — frozen handler map registration (src/cil/router.js)
//   §17.13 — per-tenant sequential IDs via allocateNextDocCounter
//   §17.14 — canonical INSERT sequence for version-creating handlers
//   §17.15 — { ok, <entity>, meta } return shape (family-wide)
//   §17.16 — gateNewIdiomHandler pre-transaction plan gating
//   §17.17 — actor role check at handler runtime (read parsed.actor.role);
//            §17.17 addendum 2 — ctx preflight before Zod validation
//   §17.18 — error code naming convention (CIL_ prefix, capability prefix,
//            bare runtime-check names)
//   §19    — plan gating (canCreateQuote + 'quote_created' counter kind)
//   §20    — CreateQuoteCILZ input contract + four 2026-04-20 addenda
//            (G1 source narrowing, G7 integer job_id override, no-default
//            tax_rate_bps, create_if_missing jobs don't set source_msg_id)
//
// NOTE on `human_id` date source (§17.13 / §20):
//   The YYYY-MMDD portion of human_id (e.g., QT-2026-04-19-0001) is derived
//   from `data.occurred_at` — the contractor's semantic truth — NOT from
//   server `now()`. Do not "helpfully" change this. The DB CHECK on event
//   `emitted_at` (2024+ / <7d future skew) is about event emission, not
//   human_id construction. Historical-import paths (if ever built) are a
//   separate handler, not CreateQuote.

// ═══════════════════════════════════════════════════════════════════════════
// IMPORTS
// ═══════════════════════════════════════════════════════════════════════════

const { z } = require('zod');
const { BaseCILZ, UUIDZ, CurrencyZ, PhoneE164Z } = require('./schema');
const {
  CilIntegrityError,
  classifyCilError,
  errEnvelope,
  gateNewIdiomHandler,
} = require('./utils');
const { canCreateQuote } = require('../config/checkCapability');
const { COUNTER_KINDS } = require('./counterKinds');
const { getTenantProfile } = require('../config/tenantProfiles');

// services/postgres is required LAZILY inside handleCreateQuote — keeps this
// module loadable in unit tests that don't have DATABASE_URL. Same idiom as
// src/cil/utils.js::resolvePlanForOwner and src/cil/router.js's legacy
// delegation.

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

// Exact constraint name per Migration 1. classifyCilError returns
// 'idempotent_retry' only when err.constraint matches this exactly.
const SOURCE_MSG_CONSTRAINT = 'chiefos_quotes_source_msg_unique';

// Maps §20-narrowed CIL source → chiefos_quotes.source enum value
// (Migration 1: source ∈ {portal, whatsapp, email, system}).
const CIL_TO_QUOTE_SOURCE = Object.freeze({
  whatsapp: 'whatsapp',
  web: 'portal',
});

// Maps §20-narrowed CIL source → chiefos_quote_events.actor_source enum
// (Migration 2: actor_source ∈ {portal, whatsapp, email, system, webhook,
// cron, admin}).
const CIL_TO_EVENT_ACTOR_SOURCE = Object.freeze({
  whatsapp: 'whatsapp',
  web: 'portal',
});

// ═══════════════════════════════════════════════════════════════════════════
// ZOD SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

// CreateQuoteJobRefZ — overrides BaseCILZ.JobRefZ for integer job_id (§20 G7).
// BaseCILZ declares job_id as UUID but public.jobs.id is sequence-backed
// integer. BaseCILZ-wide fix is parked as a coordinated change affecting
// Expense and Payment handlers; narrowing here matches reality today.
const CreateQuoteJobRefZ = z
  .object({
    job_id: z.number().int().positive().optional(),
    job_name: z.string().min(1).optional(),
    create_if_missing: z.boolean().optional(),
  })
  .refine((j) => !!j.job_id || !!j.job_name, 'JobRef must include job_id or job_name')
  .refine(
    (j) => (j.create_if_missing ? !!j.job_name : true),
    'create_if_missing requires job_name'
  );

// CustomerInputZ — either/or customer_id XOR inline fields (§20 Q1).
// No auto-match on email/phone per §20 addendum. Handler either links
// an existing customer_id within the same tenant OR creates a fresh row.
const CustomerInputZ = z
  .object({
    customer_id: UUIDZ.optional(),
    name: z.string().min(1).optional(),
    email: z.string().email().optional(),
    phone_e164: PhoneE164Z.optional(),
    address: z.string().optional(),
  })
  .refine(
    (c) => !!c.customer_id || !!c.name,
    'customer must include customer_id or name'
  );

// LineItemInputZ — per-item shape per §20.
const LineItemInputZ = z.object({
  sort_order: z.number().int().nonnegative().default(0),
  description: z.string().min(1),
  category: z.enum(['labour', 'materials', 'other']).optional(),
  qty: z.number().positive().default(1),
  unit_price_cents: z.number().int().nonnegative(),
  tax_code: z.string().min(1).optional(),
  catalog_product_id: UUIDZ.optional(),
  // catalog_snapshot stays loose (z.record) pending supplier-catalog schema
  // per §20 addendum. Tighten when Gentek/Kaycan catalog integration ships.
  catalog_snapshot: z.record(z.any()).optional(),
});

// TenantSnapshotZ — handler-computed output schema (§20). Composed from
// the tenant row plus extended tenant-profile data, validated before
// persistence. Keeps the §4 server-hash canonical-serialization guarantee
// honest — snapshots are contractual, not arbitrary JSONB.
const TenantSnapshotZ = z.object({
  legal_name: z.string(),
  brand_name: z.string().optional(),
  address: z.string(),
  phone_e164: PhoneE164Z.optional(),
  email: z.string().email().optional(),
  web: z.string().optional(),
  hst_registration: z.string().optional(),
});

// CustomerSnapshotZ — handler-computed output schema (§20). Composed from
// the resolved/created customer row at CreateQuote time and frozen.
const CustomerSnapshotZ = z.object({
  name: z.string(),
  email: z.string().email().optional(),
  phone_e164: PhoneE164Z.optional(),
  address: z.string().optional(),
});

// CreateQuoteCILZ — extends BaseCILZ with all CreateQuote-specific fields.
// Overrides `source` (G1 narrowing) and `job` (G7 integer job_id).
const CreateQuoteCILZ = BaseCILZ.extend({
  type: z.literal('CreateQuote'),
  // §20 addendum G1: reject 'upload' at schema layer (media-capture source,
  // not document authoring). Email-initiated creation is a future path.
  source: z.enum(['whatsapp', 'web']),
  // §20 addendum G7: override BaseCILZ.JobRefZ with integer job_id.
  job: CreateQuoteJobRefZ,
  customer: CustomerInputZ,
  project: z.object({
    title: z.string().min(1),
    scope: z.string().optional(),
  }),
  currency: CurrencyZ.default('CAD'),
  // §20 Q5: NO default — every CreateQuote must supply tax_rate_bps
  // explicitly. Prevents silent zero-HST quotes for Ontario contractors.
  tax_rate_bps: z.number().int().nonnegative(),
  tax_code: z.string().min(1).optional(),
  line_items: z.array(LineItemInputZ).min(1, 'CreateQuote requires at least one line item'),
  deposit_cents: z.number().int().nonnegative().default(0),
  payment_terms: z.record(z.any()).default({}),
  warranty_snapshot: z.record(z.any()).default({}),
  clauses_snapshot: z.record(z.any()).default({}),
  warranty_template_ref: z.string().min(1).optional(),
  clauses_template_ref: z.string().min(1).optional(),
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION HELPERS
// ═══════════════════════════════════════════════════════════════════════════
//
// All section helpers run INSIDE the caller's transaction (take a pg client).
// Throw CilIntegrityError on semantic failures; caller's outer catch routes
// to CIL_INTEGRITY_ERROR envelope via classifyCilError.
//
// Module-scope (not nested in handleCreateQuote) for readability and to
// avoid per-call function recreation. Not exported on the public surface
// (see `_internals` at bottom for test-only access).

// ─── Section 1: resolveOrCreateCustomer ─────────────────────────────────────

async function resolveOrCreateCustomer(client, tenantId, customerInput) {
  if (customerInput.customer_id) {
    // Branch A: UUID link. Verify existence AND tenant membership in one SELECT.
    //
    // Cross-tenant and not-found produce identical error by design; no
    // information disclosure about customer UUID existence across tenants.
    // Same principle as share-token 404 unification (§14).
    const { rows } = await client.query(
      `SELECT id, tenant_id, name, email, phone, address
         FROM public.customers
        WHERE id = $1 AND tenant_id = $2`,
      [customerInput.customer_id, tenantId]
    );
    if (rows.length === 0) {
      throw new CilIntegrityError({
        code: 'CUSTOMER_NOT_FOUND_OR_CROSS_TENANT',
        message: 'Customer lookup failed',
        hint: 'customer_id does not exist or belongs to a different tenant',
      });
    }
    return rows[0];
  }

  // Branch B: inline create.
  //
  // public.customers has no unique constraint on email or phone; no
  // auto-match per §20 addendum. INSERT always succeeds at the constraint
  // layer. Column name drift: input field is `phone_e164`; DB column is
  // `phone` (text). The input→DB boundary is this line; snapshot layer
  // (CustomerSnapshotZ) renames it back to phone_e164.
  const { rows } = await client.query(
    `INSERT INTO public.customers (tenant_id, name, email, phone, address)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, tenant_id, name, email, phone, address`,
    [
      tenantId,
      customerInput.name,
      customerInput.email || null,
      customerInput.phone_e164 || null,
      customerInput.address || null,
    ]
  );
  return rows[0];
}

// ─── Section 2: resolveOrCreateJob ──────────────────────────────────────────

async function resolveOrCreateJob(client, ownerId, jobInput) {
  if (jobInput.job_id) {
    // Branch A: integer link — verify existence, owner membership, not deleted.
    //
    // Cross-owner and not-found produce identical error by design per
    // §17.17 addendum 3 — no information disclosure about integer job IDs
    // across owners. Same no-info-disclosure principle as Section 1's
    // cross-tenant customer lookup and §14 share-token 404 unification.
    // Soft-deleted rows also fail closed (creating a quote against a
    // deleted job is a product-level bug; the soft-delete was intentional).
    const { rows } = await client.query(
      `SELECT id FROM public.jobs
        WHERE id = $1
          AND owner_id = $2
          AND deleted_at IS NULL`,
      [jobInput.job_id, ownerId]
    );
    if (rows.length === 0) {
      throw new CilIntegrityError({
        code: 'JOB_NOT_FOUND_OR_CROSS_OWNER',
        message: 'Job lookup failed',
        hint: 'job_id does not exist, belongs to a different owner, or is deleted',
      });
    }
    return rows[0].id;
  }

  // Branch B: name-based find-or-create.
  //
  // Inline find-or-create SQL — cannot call pg.ensureJobByName because it
  // wraps its own withClient (would nest transactions and break atomicity).
  //
  // Schema carries both `name` and `job_name` columns from legacy drift.
  // Write both, read both, keep them synchronized. Future: migration to
  // collapse into one column is possible but out of scope here.
  const jobName = String(jobInput.job_name).trim();

  // ORDER BY id ASC + LIMIT 1: deterministic earliest-created wins if legacy
  // drift produced multiple matching rows. New writes keep name+job_name in
  // sync, but prior data may not — guard with explicit ordering.
  const found = await client.query(
    `SELECT id FROM public.jobs
      WHERE owner_id = $1
        AND (lower(name) = lower($2) OR lower(job_name) = lower($2))
        AND deleted_at IS NULL
      ORDER BY id ASC
      LIMIT 1`,
    [ownerId, jobName]
  );
  if (found.rows.length > 0) return found.rows[0].id;

  // Not found. create_if_missing gated at Zod schema's JobRef refinement;
  // here we respect the caller's explicit opt-in (or absence thereof).
  if (!jobInput.create_if_missing) {
    throw new CilIntegrityError({
      code: 'JOB_NOT_FOUND',
      message: `No existing job matches name: ${jobName}`,
      hint: 'Set create_if_missing: true on the job ref, or pass an existing job_id',
    });
  }

  // Allocate per-owner job_no via existing pg helper (takes client — safe
  // inside txn). §17.13: operational entities keep per-owner counters via
  // allocateNextJobNo; quote/invoice use per-tenant allocateNextDocCounter.
  // eslint-disable-next-line global-require
  const pg = require('../../services/postgres');
  const nextNo = await pg.allocateNextJobNo(ownerId, client);

  // INSERT job WITHOUT source_msg_id per §20 addendum: idempotency for
  // CreateQuote retries happens at the quote layer via
  // chiefos_quotes_source_msg_unique. On retry, the find-step above returns
  // the existing job before this INSERT runs. Orphan job rows impossible:
  // if the quote INSERT rolls back, this INSERT rolls back with it (same
  // transaction).
  const ins = await client.query(
    `INSERT INTO public.jobs
       (owner_id, job_no, job_name, name, active, start_date, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, true, NOW(), 'active', NOW(), NOW())
     RETURNING id`,
    [ownerId, nextNo, jobName, jobName]
  );
  return ins.rows[0].id;
}

// ─── Section 3: totals, human_id, snapshots ────────────────────────────────

/**
 * computeTotals — pure function. Server-authoritative per §20 Q5: caller
 * supplies per-line `qty` + `unit_price_cents` + header `tax_rate_bps`;
 * handler computes all line + header totals. Totals are NEVER in the CIL
 * input schema.
 *
 * Returns:
 *   {
 *     line_totals: [{ line_subtotal_cents, line_tax_cents }, ...],
 *     subtotal_cents,
 *     tax_cents,
 *     total_cents,
 *   }
 *
 * Per-line rounding produces header tax as the sum of rounded line tax
 * values. A theoretical ±1¢ difference vs. `subtotal × tax_rate_bps / 10000`
 * is intentional — the customer-facing quote shows per-line tax and must
 * sum to header tax exactly. The subtotal × rate calculation would produce
 * a different header tax that doesn't match visible line-tax values.
 *
 * Math.round is half-away-from-zero for positive integers — standard
 * accounting rounding.
 */
function computeTotals(lineItems, taxRateBps) {
  const line_totals = lineItems.map((li) => {
    // qty is numeric(18,3) in DB; input is positive number. Multiplication
    // produces a float; Math.round collapses to integer cents. Lossy only
    // at sub-cent precision, which is acceptable.
    const line_subtotal_cents = Math.round(li.qty * li.unit_price_cents);
    const line_tax_cents = Math.round((line_subtotal_cents * taxRateBps) / 10000);
    return { line_subtotal_cents, line_tax_cents };
  });

  const subtotal_cents = line_totals.reduce((s, l) => s + l.line_subtotal_cents, 0);
  const tax_cents = line_totals.reduce((s, l) => s + l.line_tax_cents, 0);
  const total_cents = subtotal_cents + tax_cents;

  return { line_totals, subtotal_cents, tax_cents, total_cents };
}

/**
 * formatHumanIdDatePart — UTC YYYY-MM-DD from ISO8601 occurred_at string.
 *
 * UTC-not-tenant-tz decision: date part is an identifier label, not a
 * calendar date the contractor sees as "my local day." Cross-tenant
 * consistency and zero-tenant-profile-reads are worth the edge case at
 * UTC/local midnight.
 *
 * Edge case: a contractor submitting at 23:59 local could see a human_id
 * dated "tomorrow UTC." Acceptable trade-off vs. reading tenant tz every
 * allocation. Future: if contractors complain, add a tenant_tz resolution
 * path — schema and format unchanged.
 */
function formatHumanIdDatePart(occurredAtIso) {
  const d = new Date(occurredAtIso);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * allocateQuoteHumanId — allocates the per-tenant quote counter and
 * formats the customer-facing human_id. Format: `QT-YYYY-MM-DD-NNNN`.
 *
 * Counter is monotonic per-tenant per-kind (§17.13). Cross-day resets
 * are NOT a thing — `QT-2026-04-19-0142` and `QT-2026-04-20-0143` are
 * adjacent in the sequence. Padding is 4 digits; overflow at 9999 is
 * a future concern (contractor issuing 10000+ quotes/year hits it;
 * counter holds the real value past 9999, format just displays wider).
 */
async function allocateQuoteHumanId(client, tenantId, occurredAtIso) {
  // eslint-disable-next-line global-require
  const pg = require('../../services/postgres');
  const seq = await pg.allocateNextDocCounter(tenantId, COUNTER_KINDS.QUOTE, client);
  const datePart = formatHumanIdDatePart(occurredAtIso);
  return `QT-${datePart}-${String(seq).padStart(4, '0')}`;
}

/**
 * composeCustomerSnapshot — maps Section 1's resolvedCustomer (DB row) to
 * the CustomerSnapshotZ-validated output shape. Renames DB column `phone`
 * (legacy, free-form) → snapshot key `phone_e164` (E.164 per schema).
 *
 * CustomerInputZ already validates phone_e164 at the CIL boundary, so the
 * DB row's `phone` column holds an E.164 value on freshly-created
 * customers. Pre-existing customers from other ingestion paths may have
 * non-E.164 phone values; PhoneE164Z.parse below will reject those with a
 * schema error, surfacing as CIL_INTEGRITY_ERROR — correct fail-closed
 * posture.
 */
function composeCustomerSnapshot(resolvedCustomer) {
  const snap = { name: resolvedCustomer.name };
  if (resolvedCustomer.email) snap.email = resolvedCustomer.email;
  if (resolvedCustomer.phone) snap.phone_e164 = resolvedCustomer.phone;
  if (resolvedCustomer.address) snap.address = resolvedCustomer.address;
  return CustomerSnapshotZ.parse(snap);
}

/**
 * composeTenantSnapshot — reads tenant profile from bootstrap config
 * (src/config/tenantProfiles.js) and validates against TenantSnapshotZ.
 *
 * Fail-closed on missing profile per §17.17 addendum 3 philosophy: better
 * to refuse the quote than ship one with empty branding that cannot be
 * fixed post-lock. Throws CilIntegrityError with TENANT_PROFILE_MISSING
 * internal code; outer catch surfaces as CIL_INTEGRITY_ERROR envelope.
 *
 * Source-swap plan: when tenant-profile DB table ships, swap this
 * function's body for a SELECT against that table. TenantSnapshotZ
 * contract unchanged.
 */
function composeTenantSnapshot(tenantId) {
  const profile = getTenantProfile(tenantId);
  if (!profile) {
    throw new CilIntegrityError({
      code: 'TENANT_PROFILE_MISSING',
      message: 'Tenant profile not configured',
      hint: `Add tenant ${tenantId} to src/config/tenantProfiles.js until tenant-profile table ships`,
    });
  }
  return TenantSnapshotZ.parse(profile);
}

// ─── Section 4: header, version, line-items INSERTs (§17.14 core) ──────────

/**
 * insertQuoteHeader — §17.14 step 1. INSERTs chiefos_quotes with
 * current_version_id = NULL. The DEFERRABLE FK
 * chiefos_quotes_current_version_fk permits the NULL within the
 * transaction; the UPDATE to non-NULL happens at Section 5.
 *
 * Idempotency surface: chiefos_quotes_source_msg_unique
 * (owner_id, source_msg_id) fires here on retry. classifyCilError at
 * the outer catch routes to idempotent_retry per §17.10.
 */
async function insertQuoteHeader(client, {
  tenantId, ownerId, jobId, customerId, humanId, source, sourceMsgId,
}) {
  const { rows } = await client.query(
    `INSERT INTO public.chiefos_quotes (
        tenant_id, owner_id, job_id, customer_id, human_id,
        status, current_version_id, source, source_msg_id,
        created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, 'draft', NULL, $6, $7, NOW(), NOW())
      RETURNING id, created_at`,
    [tenantId, ownerId, jobId, customerId, humanId, source, sourceMsgId]
  );
  return rows[0];
}

/**
 * insertQuoteVersion — §17.14 step 2. INSERTs chiefos_quote_versions
 * with version_no=1, status='draft', locked_at=NULL, server_hash=NULL.
 * Composite FK chiefos_qv_parent_identity_fk validates
 * (quote_id, tenant_id, owner_id) matches the header.
 *
 * JSONB columns rely on node-postgres auto-serialization of JS objects.
 * Zod schemas (CustomerSnapshotZ, TenantSnapshotZ) produce objects with
 * explicit null or absent keys, never undefined — so auto-serialization
 * is deterministic here.
 */
async function insertQuoteVersion(client, {
  quoteId, tenantId, ownerId, data, totals, customerSnapshot, tenantSnapshot,
}) {
  // Composite FK failure here indicates a handler bug (mismatched
  // tenant_id/owner_id between header and version), not user input.
  // Bubble to outer catch for 500-class surfacing.
  const { rows } = await client.query(
    `INSERT INTO public.chiefos_quote_versions (
        quote_id, tenant_id, owner_id, version_no, status,
        project_title, project_scope,
        currency, subtotal_cents, tax_cents, total_cents,
        deposit_cents, tax_code, tax_rate_bps,
        warranty_snapshot, clauses_snapshot, tenant_snapshot,
        customer_snapshot, payment_terms,
        warranty_template_ref, clauses_template_ref,
        created_at
      )
      VALUES ($1, $2, $3, 1, 'draft',
              $4, $5,
              $6, $7, $8, $9,
              $10, $11, $12,
              $13, $14, $15,
              $16, $17,
              $18, $19,
              NOW())
      RETURNING id, created_at`,
    [
      quoteId, tenantId, ownerId,
      data.project.title, data.project.scope || null,
      data.currency, totals.subtotal_cents, totals.tax_cents, totals.total_cents,
      data.deposit_cents, data.tax_code || null, data.tax_rate_bps,
      data.warranty_snapshot, data.clauses_snapshot, tenantSnapshot,
      customerSnapshot, data.payment_terms,
      data.warranty_template_ref || null, data.clauses_template_ref || null,
    ]
  );
  return rows[0];
}

/**
 * insertQuoteLineItems — §17.14 step 3. INSERTs chiefos_quote_line_items
 * one row per input line item. Parent-lock trigger is inert because
 * parent version's locked_at IS NULL (draft state).
 *
 * Sequential INSERTs (not Promise.all) — parent-lock trigger fires per
 * row regardless, and sequential guarantees deterministic sort_order
 * matches insertion order for reproducible test output.
 */
async function insertQuoteLineItems(client, {
  versionId, tenantId, ownerId, lineItems, lineTotals,
}) {
  // Alignment contract: lineItems[i] corresponds to lineTotals[i].
  // Section 3's computeTotals preserves input order without filtering.
  // Assert length match to fail loud if that ever changes.
  if (lineItems.length !== lineTotals.length) {
    throw new Error(
      `Line item alignment drift: ${lineItems.length} items vs ${lineTotals.length} totals`
    );
  }

  for (let i = 0; i < lineItems.length; i++) {
    const li = lineItems[i];
    const lt = lineTotals[i];
    await client.query(
      `INSERT INTO public.chiefos_quote_line_items (
          quote_version_id, tenant_id, owner_id,
          sort_order, description, category,
          qty, unit_price_cents, line_subtotal_cents, line_tax_cents,
          tax_code, catalog_product_id, catalog_snapshot,
          created_at
        )
        VALUES ($1, $2, $3,
                $4, $5, $6,
                $7, $8, $9, $10,
                $11, $12, $13,
                NOW())`,
      [
        versionId, tenantId, ownerId,
        li.sort_order != null ? li.sort_order : i,
        li.description, li.category || null,
        li.qty, li.unit_price_cents, lt.line_subtotal_cents, lt.line_tax_cents,
        li.tax_code || null, li.catalog_product_id || null,
        li.catalog_snapshot || {},
      ]
    );
  }
}

// ─── Section 5: current_version_id UPDATE pointer swing ────────────────────

/**
 * setQuoteCurrentVersion — §17.14 step 4. UPDATEs chiefos_quotes to point
 * at the newly-inserted version. Header immutability trigger
 * (trg_chiefos_quotes_guard_header_immutable) permits current_version_id
 * transitions — it's one of five mutable columns (alongside status,
 * updated_at, voided_at, voided_reason).
 *
 * Composite FK chiefos_quotes_current_version_fk (DEFERRABLE INITIALLY
 * DEFERRED) validates (current_version_id, tenant_id, owner_id) matches
 * the pointed-to version. The FK's deferred mode is what enabled the
 * header INSERT with current_version_id=NULL earlier; this UPDATE
 * resolves the NULL to a real identity-matched id.
 *
 * WHERE clause includes tenant_id + owner_id predicates per Engineering
 * Constitution §3 — belt-and-suspenders even though quote_id came from
 * the same transaction's INSERT RETURNING. Removes the "is this trusted
 * context?" reasoning from future readers.
 *
 * Rowcount assertion fails loud if the defensive predicates ever miss.
 * Shouldn't happen in practice (quote_id + tenant_id + owner_id all came
 * from Section 4's header INSERT result); asserting costs nothing.
 */
async function setQuoteCurrentVersion(client, { quoteId, versionId, tenantId, ownerId }) {
  const result = await client.query(
    `UPDATE public.chiefos_quotes
        SET current_version_id = $1, updated_at = NOW()
      WHERE id = $2 AND tenant_id = $3 AND owner_id = $4`,
    [versionId, quoteId, tenantId, ownerId]
  );
  if (result.rowCount !== 1) {
    throw new Error(
      `setQuoteCurrentVersion expected 1 row updated, got ${result.rowCount}`
    );
  }
}

// ─── Section 6: audit events emission (§17.14 step 5) ──────────────────────
//
// Per §17.14 addendum (2026-04-19): one helper per event kind. Each handler's
// emission surface is specific, type-bound, and enforces scope at the call
// site. emit<EventKind> naming convention.
//
// CreateQuote emits exactly two events, always as a pair:
//   1. lifecycle.created        — quote-scoped (quote_version_id NULL)
//   2. lifecycle.version_created — version-scoped with
//                                  {version_no, trigger_source} payload
//
// Both events share emitted_at (same semantic moment — "quote was created"
// and "version 1 was created" happen simultaneously at creation time).
// Chronological queries tiebreak by created_at (INSERT order), which places
// lifecycle.created before lifecycle.version_created per §17.14 step 5's
// documented emission order.
//
// correlation_id intentionally NULL on both. This column chains causally-
// related events (e.g., lifecycle.signed → lifecycle.sent); CreateQuote's
// events have no upstream event cause. The CIL ctx.traceId lives in the
// return envelope's meta.traceId per §17.15; it is not the same concept
// as event correlation. See §17.14 correlation_id clarification.
//
// emitted_at derives from data.occurred_at (contractor's semantic truth),
// not server now(). DB CHECK enforces 2024+ and <7d future skew; extreme
// values surface as integrity error via classifyCilError. Same principle
// as Section 3 human_id date derivation — the contractor's moment, not the
// server's.

async function emitLifecycleCreated(client, {
  quoteId, tenantId, ownerId,
  actorSource, actorUserId, emittedAt,
  customerId,
}) {
  await client.query(
    `INSERT INTO public.chiefos_quote_events (
        tenant_id, owner_id, quote_id, quote_version_id,
        kind, actor_source, actor_user_id, emitted_at,
        customer_id, correlation_id, payload
      )
      VALUES ($1, $2, $3, NULL,
              'lifecycle.created', $4, $5, $6,
              $7, NULL, '{}'::jsonb)`,
    [
      tenantId, ownerId, quoteId,
      actorSource, actorUserId || null, emittedAt,
      customerId || null,
    ]
  );
}

async function emitLifecycleVersionCreated(client, {
  quoteId, versionId, tenantId, ownerId,
  actorSource, actorUserId, emittedAt,
  customerId, versionNo, triggerSource,
}) {
  // Payload structure required by Migration 2's chiefos_qe_payload_version_created
  // CHECK: must have 'version_no' + 'trigger_source' ∈ {initial,edit,reissue}.
  const payload = { version_no: versionNo, trigger_source: triggerSource };
  await client.query(
    `INSERT INTO public.chiefos_quote_events (
        tenant_id, owner_id, quote_id, quote_version_id,
        kind, actor_source, actor_user_id, emitted_at,
        customer_id, correlation_id, payload
      )
      VALUES ($1, $2, $3, $4,
              'lifecycle.version_created', $5, $6, $7,
              $8, NULL, $9)`,
    [
      tenantId, ownerId, quoteId, versionId,
      actorSource, actorUserId || null, emittedAt,
      customerId || null, payload,
    ]
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// handleCreateQuote
// ═══════════════════════════════════════════════════════════════════════════

async function handleCreateQuote(rawCil, ctx) {
  // ─── Ctx preflight (§17.17 addendum 2) ────────────────────────────────────
  // Runs BEFORE Zod validation because schema-validation error envelopes
  // reference ctx.traceId; without traceId the envelope would carry
  // traceId:null, masking the upstream resolution bug.
  if (!ctx || !ctx.owner_id) {
    return errEnvelope({
      code: 'OWNER_ID_MISSING',
      message: 'ctx.owner_id is required',
      hint: 'Upstream identity resolver must populate ctx.owner_id before applyCIL',
      traceId: (ctx && ctx.traceId) || null,
    });
  }
  if (!ctx.traceId) {
    return errEnvelope({
      code: 'TRACE_ID_MISSING',
      message: 'ctx.traceId is required',
      hint: 'Upstream request handler must populate ctx.traceId before applyCIL',
      traceId: null,
    });
  }

  // ─── Step 1 (§17.17 step 1): Zod schema validation ────────────────────────
  const parsed = CreateQuoteCILZ.safeParse(rawCil);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const pathStr = issue && issue.path && issue.path.length ? issue.path.join('.') : '<root>';
    return errEnvelope({
      code: 'CIL_SCHEMA_INVALID',
      message: issue ? `${pathStr}: ${issue.message}` : 'CreateQuote input failed validation',
      hint: 'See docs/QUOTES_SPINE_DECISIONS.md §20 for the CreateQuoteCILZ input contract',
      traceId: ctx.traceId,
    });
  }
  const data = parsed.data;

  // ─── Step 2 (§17.17 step 2 / §17.16 / §19): plan gating ───────────────────
  const gate = await gateNewIdiomHandler(ctx, canCreateQuote, 'quote_created');
  if (gate.gated) return gate.envelope;

  // ─── Step 3 (§17.17 step 3 + addendum): actor role check ──────────────────
  // §17.17 addendum: read from parsed.actor.role, NOT from ctx.actor.
  // Payload fields live in parsed; ctx carries infrastructure state only.
  if (data.actor.role !== 'owner') {
    return errEnvelope({
      code: 'PERMISSION_DENIED',
      message: 'CreateQuote is owner-only',
      hint: 'Ask the owner to create quotes (One Mind, Many Senses)',
      traceId: ctx.traceId,
    });
  }

  // ─── Step 4 (§17.17 step 4 / §17.14): transaction ─────────────────────────
  // Lazy-require pg so that module load doesn't touch DATABASE_URL during
  // unit tests that only exercise schemas. See imports note above.
  // eslint-disable-next-line global-require
  const pg = require('../../services/postgres');

  let txnResult;
  try {
    txnResult = await pg.withClient(async (client) => {
      // ─── i. Resolve or create customer (§20 Q1) ─── IMPLEMENTED ─────────
      const resolvedCustomer = await resolveOrCreateCustomer(
        client,
        data.tenant_id,
        data.customer
      );

      // ─── ii. Resolve or create job (§20 Q2) ─── IMPLEMENTED ─────────────
      const resolvedJobId = await resolveOrCreateJob(
        client,
        ctx.owner_id,
        data.job
      );

      // ─── iii. Compute totals server-side (§20 Q5) ─── IMPLEMENTED ───────
      const totals = computeTotals(data.line_items, data.tax_rate_bps);

      // ─── iv. Allocate human_id (§17.13 / COUNTER_KINDS.QUOTE) ── IMPLEMENTED
      const human_id = await allocateQuoteHumanId(
        client,
        data.tenant_id,
        data.occurred_at
      );

      // ─── v. Compose + validate snapshots (§20) ─── IMPLEMENTED ──────────
      const customer_snapshot = composeCustomerSnapshot(resolvedCustomer);
      const tenant_snapshot = composeTenantSnapshot(data.tenant_id);

      // ─── vi. INSERT chiefos_quotes, current_version_id=NULL ── IMPLEMENTED
      // Idempotency surface: chiefos_quotes_source_msg_unique fires here on
      // retry; classifyCilError routes to idempotent_retry per §17.10.
      const header = await insertQuoteHeader(client, {
        tenantId: data.tenant_id,
        ownerId: ctx.owner_id,
        jobId: resolvedJobId,
        customerId: resolvedCustomer.id,
        humanId: human_id,
        source: CIL_TO_QUOTE_SOURCE[data.source],
        sourceMsgId: data.source_msg_id,
      });

      // ─── vii. INSERT chiefos_quote_versions (v1, draft) ─── IMPLEMENTED ──
      const version = await insertQuoteVersion(client, {
        quoteId: header.id,
        tenantId: data.tenant_id,
        ownerId: ctx.owner_id,
        data,
        totals,
        customerSnapshot: customer_snapshot,
        tenantSnapshot: tenant_snapshot,
      });

      // ─── viii. INSERT chiefos_quote_line_items × N ─── IMPLEMENTED ───────
      await insertQuoteLineItems(client, {
        versionId: version.id,
        tenantId: data.tenant_id,
        ownerId: ctx.owner_id,
        lineItems: data.line_items,
        lineTotals: totals.line_totals,
      });

      // ─── ix. UPDATE chiefos_quotes SET current_version_id ─── IMPLEMENTED
      await setQuoteCurrentVersion(client, {
        quoteId: header.id,
        versionId: version.id,
        tenantId: data.tenant_id,
        ownerId: ctx.owner_id,
      });

      // ─── x. INSERT chiefos_quote_events × 2 (§17.14 step 5) ── IMPLEMENTED
      // Pair emission: lifecycle.created (quote-scoped) then
      // lifecycle.version_created (version-scoped with required payload).
      // INSERT order matters for chronological queries that tiebreak on
      // created_at when emitted_at is identical.
      const actorSource = CIL_TO_EVENT_ACTOR_SOURCE[data.source];
      const actorUserId = data.actor.actor_id;
      const emittedAt = data.occurred_at;
      const customerId = resolvedCustomer.id;

      await emitLifecycleCreated(client, {
        quoteId: header.id,
        tenantId: data.tenant_id,
        ownerId: ctx.owner_id,
        actorSource, actorUserId, emittedAt, customerId,
      });

      await emitLifecycleVersionCreated(client, {
        quoteId: header.id,
        versionId: version.id,
        tenantId: data.tenant_id,
        ownerId: ctx.owner_id,
        actorSource, actorUserId, emittedAt, customerId,
        versionNo: 1,
        triggerSource: 'initial',
      });

      // Temporary partial return while sections ii-x are stubbed. Section 7
      // will populate all fields for the final §17.15 return shape. Section 1
      // tests exercise resolveOrCreateCustomer directly via _internals and do
      // not invoke handleCreateQuote end-to-end yet.
      return {
        quote_id: header.id,
        version_id: version.id,
        header_created_at: header.created_at,
        customer: resolvedCustomer,
        job_id: resolvedJobId,
        human_id,
        totals,
        customer_snapshot,
        tenant_snapshot,
      };
    });
  } catch (err) {
    // ─── Outer catch per §17.10 clarification 2 — four-kind switch ────────
    const c = classifyCilError(err, { expectedSourceMsgConstraint: SOURCE_MSG_CONSTRAINT });

    if (c.kind === 'semantic_error') {
      return errEnvelope({
        code: 'CIL_INTEGRITY_ERROR',
        message: c.error.message,
        hint: c.error.hint,
        traceId: ctx.traceId,
      });
    }

    if (c.kind === 'idempotent_retry') {
      // TODO Section 7: post-rollback prior-quote lookup via
      // (owner_id, source_msg_id). Return §17.15 shape with
      // meta.already_existed: true.
      throw new Error(
        '[TODO Section 7] idempotent_retry branch not yet implemented'
      );
    }

    if (c.kind === 'integrity_error') {
      return errEnvelope({
        code: 'CIL_INTEGRITY_ERROR',
        message: `Unique constraint violation on ${c.constraint}`,
        hint: 'Verify tenant/owner FK consistency; check allocateNextDocCounter is advancing',
        traceId: ctx.traceId,
      });
    }

    // not_unique_violation — rethrow; upstream renders as 500-class failure.
    throw err;
  }

  // ─── Step 5 (§17.16 / §19): post-commit counter increment ── TODO S7 ────
  // Happy path only. Idempotent_retry + semantic_error + integrity_error
  // branches returned from within the catch. If we reach here, the write
  // succeeded and we consume counter capacity.
  // await pg.incrementMonthlyUsage({
  //   ownerId: ctx.owner_id,
  //   kind: 'quote_created',
  //   amount: 1,
  // });

  // ─── Step 6 (§17.15): compose return shape ─── TODO Section 7 ──────────
  // Final shape:
  //   { ok: true, quote: {...}, meta: { already_existed:false,
  //     events_emitted: ['lifecycle.created','lifecycle.version_created'],
  //     traceId } }
  //
  // For now: throw explicitly so no one treats a partial Section 1 handler
  // as a working end-to-end CreateQuote. Section 1 tests invoke
  // _internals.resolveOrCreateCustomer directly and don't hit this path.
  throw new Error(
    '[TODO Section 7] handleCreateQuote end-to-end return shape not yet implemented; ' +
      'invoke _internals.resolveOrCreateCustomer directly for Section 1 testing'
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  handleCreateQuote,
  CreateQuoteCILZ,
  // Test-only internals. Not part of the handler's public contract. External
  // callers should not reach through _internals — if genuine reuse need
  // emerges, hoist to a dedicated module rather than expand this surface.
  _internals: {
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
    TenantSnapshotZ,
    CustomerSnapshotZ,
    CreateQuoteJobRefZ,
    CustomerInputZ,
    LineItemInputZ,
    SOURCE_MSG_CONSTRAINT,
    CIL_TO_QUOTE_SOURCE,
    CIL_TO_EVENT_ACTOR_SOURCE,
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// ROUTER REGISTRATION — DEFERRED
// ═══════════════════════════════════════════════════════════════════════════
//
// Registration in src/cil/router.js lands when Section 7 compiles — all
// branches return a valid §17.15 shape. Per §17.12's two-step explicit
// registration:
//
//   1. Uncomment in router.js:
//        const { handleCreateQuote } = require('./quotes');
//   2. Add to Object.freeze({...}):
//        CreateQuote: handleCreateQuote,
//
// Until registration lands, applyCIL({ type: 'CreateQuote', ... }) falls
// through to the legacy router, which returns CIL_TYPE_UNKNOWN per §17.6.
// Intentional — prevents partial handler from serving traffic.
