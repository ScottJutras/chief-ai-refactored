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
//   Section 7 (classifyCilError handler branches + counter increment + return): IMPLEMENTED
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

const crypto = require('crypto');

// bs58 v6+ is ESM-first; under CommonJS, `require('bs58')` returns the
// namespace object, so .default exposes the actual encode/decode API.
// Future readers (including future Claude Code sessions) will thank us
// when they hit undefined on their first bs58.encode(...) attempt and
// can't figure out why.
const bs58 = require('bs58').default;

const { z } = require('zod');
const { BaseCILZ, UUIDZ, CurrencyZ, PhoneE164Z } = require('./schema');
const { PNG_MAX_BASE64_LENGTH } = require('./quoteSignatureStorage');
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

// SendQuote's dedup surface (Migration 3 partial UNIQUE).
const SEND_QUOTE_SOURCE_MSG_CONSTRAINT = 'chiefos_qst_source_msg_unique';

// Public base URL for customer-facing /q/<token> share links. Env-driven
// with fallback. Trailing-slash strip so `${APP_URL}/q/${token}` never
// double-slashes.
const APP_URL = String(process.env.APP_URL || 'https://app.usechiefos.com').replace(/\/$/, '');

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

// ─── SendQuote column list — shared by Section 2 branches ──────────────────
//
// Extracted to a constant so adding a column to the handler's read surface
// becomes a single-place edit. Avoids the silent-drift failure mode where
// one branch of the quote_id/human_id lookup gets updated and the other
// doesn't. All callers of this constant run the query against
// chiefos_quotes q JOIN chiefos_quote_versions v ON v.id = q.current_version_id.
const LOAD_QUOTE_COLUMNS = `
  q.id             AS quote_id,
  q.human_id,
  q.status,
  q.job_id,
  q.current_version_id,
  q.created_at     AS header_created_at,
  q.customer_id,
  v.id             AS version_id,
  v.version_no,
  v.project_title,
  v.currency,
  v.total_cents,
  v.customer_snapshot,
  v.tenant_snapshot,
  v.issued_at
`;

// ─── SendQuote schemas (§14 / §22) ──────────────────────────────────────────
//
// Second new-idiom handler in the Quote spine. Operates on an existing
// draft quote: creates chiefos_quote_share_tokens row (§14), flips quote
// status draft→sent, emits lifecycle.sent (inside txn) + notification.sent
// or notification.failed (post-commit). Reuses every §17 principle
// validated by CreateQuote.

// QuoteRefInputZ — either/or reference to an existing quote. Tenant scope
// supplied separately at the CIL root (tenant_id); owner scope comes from
// ctx.owner_id at handler time. Per §17.17 addendum 3, cross-tenant or
// cross-owner lookups surface as unified QUOTE_NOT_FOUND_OR_CROSS_OWNER.
const QuoteRefInputZ = z.object({
  quote_id: UUIDZ.optional(),
  human_id: z.string().min(1).optional(),
}).refine(
  (r) => !!r.quote_id || !!r.human_id,
  'quote_ref must include quote_id or human_id'
);

// SendQuoteCILZ — extends BaseCILZ with SendQuote-specific fields. No
// plan gate per G6 (sending is follow-through to creation; §19 gates
// creation transitively gate sending). Source narrowed to ['whatsapp','web']
// matching CreateQuote per §20 G1 addendum.
const SendQuoteCILZ = BaseCILZ.extend({
  type: z.literal('SendQuote'),
  source: z.enum(['whatsapp', 'web']),
  quote_ref: QuoteRefInputZ,
  // Optional recipient overrides. customer_snapshot on the quote version is
  // the canonical "who the quote is for"; share_token.recipient_address is
  // tactical "who we sent this transmission to" (§14.2). An override here
  // does NOT rewrite the customer snapshot — only the share-token row.
  recipient_email: z.string().email().optional(),
  recipient_name: z.string().min(1).optional(),
});

// ─── SignQuote schemas (§11a / §14.12 / §17.17 / §25) ──────────────────────
//
// Third new-idiom handler. First CIL type with actor.role = 'customer'
// (non-owner actor; bearer-authenticated via share_token_id in the
// audit chain per §14 customer-actor addendum). Composes Phase 1's
// computeVersionHash + Phase 2's uploadSignaturePng + §11a name-match
// rule into the sent/viewed → signed transition.
//
// Per §17.20 (Pre-BEGIN external write for strict-immutable INSERT):
// Migration 4's signature-row strict-immutability forbids post-INSERT
// UPDATE, so the PNG upload must happen before the transaction opens.
// Orphan cleanup on transaction failure per §25.6 Direction A.
//
// SignQuote dedup constraint: chiefos_qs_source_msg_unique (partial
// UNIQUE WHERE source_msg_id IS NOT NULL). On retry with same
// source_msg_id, INSERT hits 23505 → classifyCilError returns
// idempotent_retry → post-rollback lookup returns prior state.

const SIGN_QUOTE_SOURCE_MSG_CONSTRAINT = 'chiefos_qs_source_msg_unique';

// SignQuoteActorZ — BaseCILZ's ActorZ uses ActorRoleZ enum which
// doesn't include 'customer'. This local override replaces actor
// entirely via BaseCILZ.omit({ actor: true }).extend(...).
//
// Per §14 customer-actor addendum: role identifies the contractual
// party, not the auth mechanism. actor_id carries the share_token_id
// UUID (resolved by route-layer Query 1 before applyCIL); share_token
// value itself is passed in the top-level CIL field for handler re-
// validation. Dual carry: actor_id is the audit identity; share_token
// string is the bearer credential.
const SignQuoteActorZ = z.object({
  actor_id: UUIDZ,
  role: z.literal('customer'),
});

// Share-token literal regex — mirrors Migration 3's
// chiefos_qst_token_format CHECK and Phase 2's SHARE_TOKEN_RE.
// Bitcoin base58 alphabet, exactly 22 chars.
const ShareTokenStringZ = z.string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{22}$/,
    'share_token must be 22-char base58 (Bitcoin alphabet)');

// PngDataUrlZ — data URL shape gate at Zod layer. Magic-bytes / size
// bounds are re-validated at upload time via extractAndNormalizeBase64
// + validatePngBuffer (§25.4 invariant 1 + 2). Zod-side just refuses
// obvious non-PNG inputs and applies a transport-size ceiling.
const PngDataUrlZ = z.string()
  .min(30, 'signature_png_data_url is too short to be a PNG data URL')
  // Math: 22-char prefix "data:image/png;base64," + PNG_MAX_BASE64_LENGTH
  // base64 body + 10-char slack. Actual size is re-validated at upload
  // time via extractAndNormalizeBase64 (§25.4 invariant 2).
  .max(PNG_MAX_BASE64_LENGTH + 32, 'signature_png_data_url exceeds max size')
  .refine(
    (s) => s.startsWith('data:image/png;base64,'),
    'signature_png_data_url must start with "data:image/png;base64,"'
  );

// SignQuoteCILZ — extends BaseCILZ with SignQuote-specific fields.
// Uses .omit({ actor: true }) to replace BaseCILZ's ActorZ (which
// doesn't know about 'customer' role) with SignQuoteActorZ.
//
// Source narrowed to z.literal('web') — only customer-facing path
// today is public /q/:token. 'portal' may widen in the future when
// an authenticated customer portal exists; enum widening is cheap.
//
// signer_ip + signer_user_agent are intentionally NOT in the Zod
// schema — those are ctx-sourced from route middleware per DB1 Q4
// (infrastructure metadata, not customer input).
const SignQuoteCILZ = BaseCILZ.omit({ actor: true }).extend({
  type: z.literal('SignQuote'),
  source: z.literal('web'),
  actor: SignQuoteActorZ,

  // Bearer credential — 22-char base58. Resolves to quote_version_id
  // + tenant_id via shared token-resolve helper (Section 3).
  share_token: ShareTokenStringZ,

  // Typed customer name — compared to share_token.recipient_name via
  // §11a computeNameMatch. 200-char cap prevents payload bloat; names
  // rarely exceed 60 in practice.
  signer_name: z.string().min(1, 'signer_name must be non-empty').max(200),

  // PNG from signature pad, base64-encoded data URL. Structural
  // validation + SHA-256 + bucket upload happen at upload time
  // (Phase 2's uploadSignaturePng).
  signature_png_data_url: PngDataUrlZ,
});

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

// ─── Section 7: idempotent-retry lookup + return-shape composer ────────────

/**
 * lookupPriorQuote — post-rollback recovery for the idempotent_retry branch.
 *
 * When classifyCilError returns idempotent_retry (23505 on
 * chiefos_quotes_source_msg_unique), the transaction is already rolled
 * back. This function runs a fresh query via pg.query (not the aborted
 * client) to fetch the prior quote's current state.
 *
 * Per §17.10 clarification: returns CURRENT entity state via JOIN through
 * current_version_id, NOT v1-specifically. Input-equivalence and version-
 * equivalence are both explicitly not guaranteed; the retry signals
 * "exists at source_msg_id granularity; here's current renderable state."
 */
async function lookupPriorQuote(ownerId, sourceMsgId) {
  // eslint-disable-next-line global-require
  const pg = require('../../services/postgres');
  const { rows } = await pg.query(
    `SELECT q.id          AS quote_id,
            q.human_id,
            q.status,
            q.job_id,
            q.created_at  AS header_created_at,
            q.customer_id,
            v.id          AS version_id,
            v.version_no,
            v.currency,
            v.total_cents,
            v.issued_at,
            c.id    AS c_id,
            c.name  AS c_name,
            c.email AS c_email,
            c.phone AS c_phone
       FROM public.chiefos_quotes q
       JOIN public.chiefos_quote_versions v ON v.id = q.current_version_id
       LEFT JOIN public.customers c ON c.id = q.customer_id
      WHERE q.owner_id = $1 AND q.source_msg_id = $2
      LIMIT 1`,
    [ownerId, sourceMsgId]
  );
  if (rows.length === 0) {
    // Shouldn't happen — the unique_violation that triggered this lookup
    // means a prior row exists. If it doesn't, the DB is in an inconsistent
    // state or an RLS policy is blocking the read. Throw to surface as
    // 500-class (the handler's outer caller treats unknowns as 500).
    throw new Error(
      `Idempotent retry lookup missed for (${ownerId}, ${sourceMsgId})`
    );
  }
  return rows[0];
}

/**
 * buildCreateQuoteReturnShape — composes the §17.15 family-wide success envelope
 * from a normalized input shape. Used by both the happy-path return (from
 * txnResult) and the idempotent-retry return (from lookupPriorQuote).
 *
 * meta.events_emitted describes events emitted by THIS invocation, not
 * events present in the entity's history. On idempotent retry
 * (alreadyExisted=true) returns [] because this call emitted no events.
 * Callers wanting entity event history query a dedicated events endpoint.
 */
function buildCreateQuoteReturnShape({
  quoteId, versionId, humanId, versionNo, status, currency, totalCents,
  customer, jobId, issuedAt, createdAt,
  alreadyExisted, traceId,
}) {
  return {
    ok: true,
    quote: {
      id: quoteId,
      version_id: versionId,
      human_id: humanId,
      version_no: versionNo,
      status,
      currency,
      total_cents: Number(totalCents),
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email || null,
        // DB column `phone` → envelope key `phone_e164` (same rename as
        // CustomerSnapshotZ per Section 3).
        phone_e164: customer.phone || null,
      },
      job_id: jobId,
      issued_at: issuedAt,  // null until SendQuote runs
      created_at: createdAt,
    },
    meta: {
      already_existed: alreadyExisted,
      events_emitted: alreadyExisted
        ? []  // retry emitted no events this call; original did
        : ['lifecycle.created', 'lifecycle.version_created'],
      traceId,
    },
  };
}

// ─── SendQuote Section 2: loadDraftQuote ───────────────────────────────────
//
// SELECTs an existing draft quote scoped to (tenant_id, owner_id). Returns
// a bag of fields SendQuote's downstream steps consume: header id, current
// version id, version_no, totals, customer + tenant snapshots.
//
// Three error surfaces (§17.18 naming, surfaced as CIL_INTEGRITY_ERROR
// envelope via outer catch):
//   - QUOTE_NOT_FOUND_OR_CROSS_OWNER — unified per §17.17 addendum 3
//     (not found / wrong owner / wrong tenant all collapse into one
//     error to prevent information disclosure about which quote IDs
//     exist across scopes).
//   - QUOTE_NOT_DRAFT — quote exists in scope but status ≠ 'draft'.
//     SendQuote operates only on drafts. Already-sent quotes use
//     ReissueQuote; signed/locked quotes can't be re-sent.
//
// Two branches (quote_id UUID vs. human_id string); Zod's QuoteRefInputZ
// refine enforces exactly-one input. Branch A scopes by (id, tenant, owner);
// Branch B scopes by (human_id, tenant, owner). human_id is tenant-unique
// per chiefos_quotes_human_id_unique; owner_id predicate is
// belt-and-suspenders (matches the CLAUDE.md §3 "every UPDATE includes
// tenant+owner" pattern for SELECTs too).
//
// Returns CURRENT version state via JOIN through current_version_id — same
// principle as §17.10 clarification. If the quote was created at v1, then
// edited to v2 via EditDraft, SendQuote sends v2.

async function loadDraftQuote(client, { tenantId, ownerId, quoteRef }) {
  let rows;
  if (quoteRef.quote_id) {
    const result = await client.query(
      `SELECT ${LOAD_QUOTE_COLUMNS}
         FROM public.chiefos_quotes q
         JOIN public.chiefos_quote_versions v ON v.id = q.current_version_id
        WHERE q.id = $1 AND q.tenant_id = $2 AND q.owner_id = $3
        LIMIT 1`,
      [quoteRef.quote_id, tenantId, ownerId]
    );
    rows = result.rows;
  } else {
    // human_id branch — human_id is tenant-unique per
    // chiefos_quotes_human_id_unique (tenant_id, human_id).
    const result = await client.query(
      `SELECT ${LOAD_QUOTE_COLUMNS}
         FROM public.chiefos_quotes q
         JOIN public.chiefos_quote_versions v ON v.id = q.current_version_id
        WHERE q.human_id = $1 AND q.tenant_id = $2 AND q.owner_id = $3
        LIMIT 1`,
      [quoteRef.human_id, tenantId, ownerId]
    );
    rows = result.rows;
  }

  if (rows.length === 0) {
    throw new CilIntegrityError({
      code: 'QUOTE_NOT_FOUND_OR_CROSS_OWNER',
      message: 'Quote lookup failed',
      hint: 'quote_ref does not match a quote in this tenant+owner scope, or quote does not exist',
    });
  }

  const row = rows[0];
  if (row.status !== 'draft') {
    throw new CilIntegrityError({
      code: 'QUOTE_NOT_DRAFT',
      message: `Cannot send quote in '${row.status}' status`,
      hint: "SendQuote operates on draft quotes only; for an already-sent quote use ReissueQuote",
    });
  }
  return row;
}

// ─── SendQuote Section 3: resolveRecipient ─────────────────────────────────
//
// Pure function. Determines who this specific SendQuote transmission goes
// to. Priority order per §14.2 + G4:
//
//   1. Explicit override on the SendQuote CIL payload (parsed.recipient_email
//      + optional parsed.recipient_name). Contractor can redirect to a
//      different address than the customer's primary — common when a spouse,
//      accountant, or different contact is the actual decision-maker.
//   2. Fallback to customer_snapshot.email + .name captured at CreateQuote
//      time. Canonical "who the quote is for" per §14.2.
//   3. Neither → CilIntegrityError RECIPIENT_MISSING.
//
// The override does NOT rewrite the quote's customer_snapshot (captured-at-
// creation and immutable per §6). It only sets the share-token row's
// recipient_address + recipient_name columns (tactical "who we sent this
// transmission to" vs. "who the quote is for").
//
// Returns { email, name } for downstream share-token INSERT + email dispatch.

function resolveRecipient({ parsedRecipientEmail, parsedRecipientName, customerSnapshot }) {
  // Branch 1: override present
  if (parsedRecipientEmail) {
    return {
      email: parsedRecipientEmail,
      // Override name is optional; fall back to customer snapshot name if
      // only email was overridden. Real-world case: "send this to
      // scott@acme.com" where scott is a different address but the quote
      // is still for Darlene — the email header reads "Dear Darlene".
      //
      // Empty-string parsedRecipientName falls through to snapshot —
      // intentional: empty string isn't a valid recipient name.
      name: parsedRecipientName || (customerSnapshot && customerSnapshot.name),
    };
  }

  // Branch 2: customer snapshot fallback
  if (customerSnapshot && customerSnapshot.email) {
    return {
      email: customerSnapshot.email,
      name: customerSnapshot.name,
    };
  }

  // Branch 3: nothing to send to
  throw new CilIntegrityError({
    code: 'RECIPIENT_MISSING',
    message: 'No recipient email available for SendQuote',
    hint: 'Customer was created without an email; pass recipient_email on the SendQuote CIL payload',
  });
}

// ─── SendQuote Section 4: generateShareToken + insertShareToken ────────────
//
// §14 decision 3: 22-character base58 (Bitcoin alphabet) opaque bearer
// token. crypto.randomBytes(16) → 128 bits → bs58.encode → 22 chars of
// [1-9A-HJ-NP-Za-km-z]. Migration 3's chiefos_qst_token_format CHECK
// enforces both length and alphabet at the DB layer — any token that
// somehow doesn't meet spec is rejected.
//
// §14 decision 4: 30-day absolute expiry. Set by the handler (not a
// column default) so future contractor-configurable-expiry roadmap
// changes only touch this helper.

function generateShareToken() {
  return bs58.encode(crypto.randomBytes(16));
}

async function insertShareToken(client, {
  tenantId, ownerId, quoteVersionId, token, recipient, sourceMsgId,
}) {
  // NOW() evaluations inside a single statement share the transaction
  // start timestamp (Postgres semantics), so issued_at == created_at
  // and absolute_expires_at is exactly 30 days from that same moment.
  //
  // Idempotency surface: chiefos_qst_source_msg_unique (owner_id,
  // source_msg_id) — partial UNIQUE WHERE source_msg_id IS NOT NULL.
  // On SendQuote retry with same source_msg_id, this INSERT hits 23505
  // → classifyCilError returns idempotent_retry → Section 7 catch does
  // post-rollback lookup.
  //
  // recipient_channel='email' hardcoded — this session supports email
  // only. Migration 3 accepts whatsapp/sms; future channels add
  // branches here and a channel parameter to this helper.
  const { rows } = await client.query(
    `INSERT INTO public.chiefos_quote_share_tokens (
        tenant_id, owner_id, quote_version_id, token,
        recipient_name, recipient_channel, recipient_address,
        issued_at, absolute_expires_at, source_msg_id, created_at
      )
      VALUES ($1, $2, $3, $4,
              $5, 'email', $6,
              NOW(), NOW() + INTERVAL '30 days', $7, NOW())
      RETURNING id, token, issued_at, absolute_expires_at`,
    [
      tenantId, ownerId, quoteVersionId, token,
      recipient.name, recipient.email,
      sourceMsgId,
    ]
  );
  return rows[0];
}

// ─── SendQuote Section 5: state transitions + lifecycle.sent ───────────────
//
// Per Refinement A: state UPDATEs precede the lifecycle.sent event INSERT.
// The event represents the fact of state transition and must be written
// AFTER the transition is recorded. If either UPDATE fails, the transaction
// aborts before the event INSERT fires — no phantom events for
// un-transitioned quotes.

/**
 * markQuoteSent — Section 5. Two UPDATEs flipping a draft quote to
 * 'sent' state, treated as one semantic operation. Both MUST succeed
 * or the transaction rolls back — splitting into separate helpers
 * would invite call-site sequencing mistakes. Call as a unit.
 *
 * Header transition (chiefos_quotes): status 'draft' → 'sent',
 * updated_at = NOW(). Header immutability trigger permits status +
 * updated_at transitions.
 *
 * Version transition (chiefos_quote_versions): issued_at = NOW(),
 * sent_at = NOW(). Version immutability trigger permits timestamp
 * updates while locked_at IS NULL (draft).
 *
 * Both UPDATEs include tenant_id + owner_id predicates per CLAUDE.md
 * §3 + Section 5 (CreateQuote)'s setQuoteCurrentVersion pattern.
 * Rowcount assertions: rowcount !== 1 is a handler bug.
 *
 * Status predicate on header UPDATE (`AND status = 'draft'`) is
 * belt-and-suspenders against concurrent state change between
 * loadDraftQuote and this UPDATE. locked_at predicate on version
 * UPDATE defends against an edge case where current_version_id
 * somehow points to a locked version (shouldn't happen given correct
 * ReissueQuote design; if it ever fires, investigation starts with
 * 'why does current_version_id point to a locked version?').
 */
async function markQuoteSent(client, { quoteId, versionId, tenantId, ownerId }) {
  const headerResult = await client.query(
    `UPDATE public.chiefos_quotes
        SET status = 'sent', updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2 AND owner_id = $3 AND status = 'draft'`,
    [quoteId, tenantId, ownerId]
  );
  if (headerResult.rowCount !== 1) {
    throw new Error(
      `markQuoteSent header UPDATE expected 1 row, got ${headerResult.rowCount}`
    );
  }

  const versionResult = await client.query(
    `UPDATE public.chiefos_quote_versions
        SET issued_at = NOW(), sent_at = NOW()
      WHERE id = $1 AND tenant_id = $2 AND owner_id = $3 AND locked_at IS NULL`,
    [versionId, tenantId, ownerId]
  );
  if (versionResult.rowCount !== 1) {
    throw new Error(
      `markQuoteSent version UPDATE expected 1 row, got ${versionResult.rowCount}`
    );
  }
}

/**
 * emitLifecycleSent — INSERTs a chiefos_quote_events row for the
 * state transition draft→sent. Runs AFTER markQuoteSent per
 * Refinement A's ordering requirement.
 *
 * Per Migration 2:
 *   - lifecycle.sent is VERSION-scoped (chiefos_qe_version_scoped_kinds)
 *     — quote_version_id NOT NULL.
 *   - chiefos_qe_payload_sent CHECK requires payload ? 'recipient_channel'
 *     AND payload ? 'recipient_address' AND recipient_channel IN
 *     {email,whatsapp,sms} AND share_token_id IS NOT NULL.
 *
 * Payload uses `recipient_channel` / `recipient_address` (prefixed)
 * matching the lifecycle.sent CHECK. Note this differs from
 * notification.* kinds which use `channel` / `recipient` (unprefixed)
 * — inherited schema drift from Migration 2 (to be documented in §22).
 * In-handler mapping handles both.
 *
 * share_token_id COLUMN populated (distinct from the payload keys) —
 * required by the CHECK. The event links bidirectionally to the
 * share-token row inserted in Section 4.
 */
async function emitLifecycleSent(client, {
  quoteId, versionId, tenantId, ownerId,
  actorSource, actorUserId, emittedAt,
  customerId, shareTokenId,
  recipientChannel, recipientAddress, recipientName,
}) {
  const payload = {
    recipient_channel: recipientChannel,
    recipient_address: recipientAddress,
    recipient_name: recipientName,  // extra audit field, not required by CHECK
  };
  await client.query(
    `INSERT INTO public.chiefos_quote_events (
        tenant_id, owner_id, quote_id, quote_version_id,
        kind, actor_source, actor_user_id, emitted_at,
        customer_id, share_token_id, correlation_id, payload
      )
      VALUES ($1, $2, $3, $4,
              'lifecycle.sent', $5, $6, $7,
              $8, $9, NULL, $10)`,
    [
      tenantId, ownerId, quoteId, versionId,
      actorSource, actorUserId || null, emittedAt,
      customerId || null, shareTokenId, payload,
    ]
  );
}

// ─── SendQuote Section 6: Postmark dispatch + paired notification events ──
//
// Post-commit external call. Distinct from Sections 2-5 which run inside
// withClient's transaction. The state transition (Section 5) commits
// regardless of Postmark's outcome per Refinement B:
//   - Postmark success → emit notification.sent with provider_message_id
//   - Postmark failure → emit notification.failed with error_code/message
// Either way, the quote IS sent from Chief's perspective. Email
// deliverability is a separate fact surfaced via meta.events_emitted.

// ─── 6a. URL builder ────────────────────────────────────────────────────────
function buildQuoteShareUrl(token) {
  return `${APP_URL}/q/${token}`;
}

// ─── 6b. Currency formatter — module-level; reused by email + future PDF ──
//
// $12,345,678.90 CAD shape. Tests cover large numbers to guard the regex's
// global flag (without /g, only the first thousands boundary gets a comma —
// Mission's $10K-$100K quotes would surface the bug in production).
function formatCentsAsCurrency(cents, currency) {
  const dollars = (Number(cents) / 100).toFixed(2);
  // Global flag — matches every thousands boundary, not just the first.
  const withCommas = dollars.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${withCommas} ${currency}`;
}

// ─── 6c. Email body composer — pure ─────────────────────────────────────────
function buildSendQuoteEmail({ tenantSnapshot, quote, recipient, shareUrl }) {
  const brand = tenantSnapshot.brand_name || tenantSnapshot.legal_name || 'ChiefOS';
  const subject = `${brand} — Quote ${quote.human_id}`;
  const totalDisplay = formatCentsAsCurrency(quote.total_cents, quote.currency);

  const lines = [
    `Hi ${recipient.name},`,
    '',
    `${brand} has prepared a quote for you.`,
    '',
    `Quote: ${quote.human_id}`,
    `Project: ${quote.project_title}`,
    `Total: ${totalDisplay}`,
    '',
    'View and sign your quote here:',
    shareUrl,
    '',
    'This link expires in 30 days.',
    '',
    'If you have questions, reply to this email.',
    '',
    brand,
  ];
  if (tenantSnapshot.phone_e164) lines.push(tenantSnapshot.phone_e164);
  if (tenantSnapshot.email)      lines.push(tenantSnapshot.email);
  return { subject, textBody: lines.join('\n') };
}

// ─── 6d. notification.sent + notification.failed emitters ─────────────────
//
// Per §17.14 addendum — one helper per event kind. Both emit POST-commit
// via pg.query (fresh connection), NOT via the transaction client (which
// is already released). correlation_id NULL per §17.14 clarification (not
// the CIL trace); future session may link notification.* → lifecycle.sent
// via correlation_id=lifecycle.sent.id — flagged for SignQuote session
// (if the pattern recurs, formalize as §17 principle).
//
// Payload uses UNPREFIXED `channel` / `recipient` per Migration 2's
// chiefos_qe_payload_notification + chiefos_qe_payload_notification_with_provider
// CHECKs. Distinct from lifecycle.sent's prefixed form — schema drift.

async function emitNotificationSent(pgApi, {
  quoteId, versionId, tenantId, ownerId,
  actorSource, actorUserId, emittedAt,
  customerId, shareTokenId,
  channel, recipient, providerMessageId,
}) {
  const payload = {
    channel,
    recipient,
    provider_message_id: providerMessageId,
    provider: 'postmark',
  };
  await pgApi.query(
    `INSERT INTO public.chiefos_quote_events (
        tenant_id, owner_id, quote_id, quote_version_id,
        kind, actor_source, actor_user_id, emitted_at,
        customer_id, share_token_id, correlation_id, payload
      )
      VALUES ($1, $2, $3, $4,
              'notification.sent', $5, $6, $7,
              $8, $9, NULL, $10)`,
    [
      tenantId, ownerId, quoteId, versionId,
      actorSource, actorUserId || null, emittedAt,
      customerId || null, shareTokenId, payload,
    ]
  );
}

async function emitNotificationFailed(pgApi, {
  quoteId, versionId, tenantId, ownerId,
  actorSource, actorUserId, emittedAt,
  customerId, shareTokenId,
  channel, recipient, errorCode, errorMessage,
}) {
  // provider_message_id: null — no Postmark ID on failure. The `?` JSONB
  // operator tests key existence, not value; null satisfies the CHECK.
  const payload = {
    channel,
    recipient,
    provider_message_id: null,
    provider: 'postmark',
    error_code: errorCode || 'unknown',
    error_message: errorMessage || 'unknown',
  };
  await pgApi.query(
    `INSERT INTO public.chiefos_quote_events (
        tenant_id, owner_id, quote_id, quote_version_id,
        kind, actor_source, actor_user_id, emitted_at,
        customer_id, share_token_id, correlation_id, payload
      )
      VALUES ($1, $2, $3, $4,
              'notification.failed', $5, $6, $7,
              $8, $9, NULL, $10)`,
    [
      tenantId, ownerId, quoteId, versionId,
      actorSource, actorUserId || null, emittedAt,
      customerId || null, shareTokenId, payload,
    ]
  );
}

// ─── 6e. sendEmail dependency injection for tests ──────────────────────────
//
// Tests override via setSendEmailForTests() and reset via
// resetSendEmailForTests() in afterEach/afterAll. Pattern matches
// gateNewIdiomHandler(deps) — production callers never pass deps; tests do.
let _sendEmailOverride = null;
function setSendEmailForTests(fn) { _sendEmailOverride = fn; }
function resetSendEmailForTests() { _sendEmailOverride = null; }
function getSendEmail() {
  if (_sendEmailOverride) return _sendEmailOverride;
  // eslint-disable-next-line global-require
  return require('../../services/postmark').sendEmail;
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
      // Post-rollback lookup via (owner_id, source_msg_id). The transaction
      // is already rolled back by withClient's catch; lookupPriorQuote
      // issues a fresh pg.query. Return §17.15 shape with
      // meta.already_existed: true. NO counter increment on retry — the
      // original call's counter consumption stands (source_msg_id-granular
      // idempotency per §17.10 clarification 2026-04-20).
      const prior = await lookupPriorQuote(ctx.owner_id, data.source_msg_id);
      return buildCreateQuoteReturnShape({
        quoteId: prior.quote_id,
        versionId: prior.version_id,
        humanId: prior.human_id,
        versionNo: prior.version_no,
        status: prior.status,
        currency: prior.currency,
        totalCents: prior.total_cents,
        customer: {
          id: prior.c_id,
          name: prior.c_name,
          email: prior.c_email,
          phone: prior.c_phone,
        },
        jobId: prior.job_id,
        issuedAt: prior.issued_at,
        createdAt: prior.header_created_at,
        alreadyExisted: true,
        traceId: ctx.traceId,
      });
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

  // ─── Step 5 (§17.16 / §19): post-commit counter increment ── IMPLEMENTED
  // Happy path only. Idempotent_retry + semantic_error + integrity_error
  // branches returned from within the catch above. If we reach here, the
  // write succeeded and we consume counter capacity.
  await pg.incrementMonthlyUsage({
    ownerId: ctx.owner_id,
    kind: 'quote_created',
    amount: 1,
  });

  // ─── Step 6 (§17.15): compose return shape ─── IMPLEMENTED ──────────────
  return buildCreateQuoteReturnShape({
    quoteId: txnResult.quote_id,
    versionId: txnResult.version_id,
    humanId: txnResult.human_id,
    versionNo: 1,
    status: 'draft',
    currency: data.currency,
    totalCents: txnResult.totals.total_cents,
    customer: txnResult.customer,
    jobId: txnResult.job_id,
    issuedAt: null,  // populates on SendQuote
    createdAt: txnResult.header_created_at,
    alreadyExisted: false,
    traceId: ctx.traceId,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// handleSendQuote (Section 7 — orchestration + outer catch + return shape)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * lookupPriorShareToken — lookup by (owner_id, source_msg_id). Returns
 * the row or null (caller decides whether null is an error).
 *
 * Serves two call sites:
 *   (a) Pre-transaction retry detection at handler entry. Sequential
 *       retry case: first call transitioned the quote to 'sent'; second
 *       call's loadDraftQuote would hit QUOTE_NOT_DRAFT before the
 *       share_token INSERT can raise unique_violation. This pre-check
 *       returns the prior share token before entering the transaction.
 *   (b) Post-rollback recovery in the classifyCilError idempotent_retry
 *       branch. Concurrent retry case: both calls start while quote is
 *       draft; first commits; second's share_token INSERT hits 23505.
 *       After withClient rolls back, this lookup finds the first's row.
 *
 * Joins share_token → quote → current version for full multi-entity
 * state. Returns CURRENT state per §17.10 clarification.
 */
async function lookupPriorShareToken(ownerId, sourceMsgId) {
  // eslint-disable-next-line global-require
  const pg = require('../../services/postgres');
  const { rows } = await pg.query(
    `SELECT s.id              AS share_token_id,
            s.token,
            s.absolute_expires_at,
            s.recipient_name,
            s.recipient_channel,
            s.recipient_address,
            ${LOAD_QUOTE_COLUMNS}
       FROM public.chiefos_quote_share_tokens s
       JOIN public.chiefos_quote_versions sv ON sv.id = s.quote_version_id
       JOIN public.chiefos_quotes q ON q.id = sv.quote_id
       JOIN public.chiefos_quote_versions v ON v.id = q.current_version_id
      WHERE s.owner_id = $1 AND s.source_msg_id = $2
      LIMIT 1`,
    [ownerId, sourceMsgId]
  );
  return rows[0] || null;
}

/**
 * priorShareTokenToReturnShape — composes §17.15 shape from a prior
 * share_token lookup row. Shared by pre-transaction retry detection
 * and post-rollback idempotent_retry recovery. Both branches produce
 * identical output.
 */
function priorShareTokenToReturnShape(prior, traceId) {
  return buildSendQuoteReturnShape({
    quoteId: prior.quote_id,
    versionId: prior.version_id,
    humanId: prior.human_id,
    versionNo: prior.version_no,
    status: prior.status,
    currency: prior.currency,
    totalCents: prior.total_cents,
    customer: {
      id: prior.customer_id,
      name: prior.customer_snapshot.name,
      email: prior.customer_snapshot.email,
      phone_e164: prior.customer_snapshot.phone_e164,
    },
    jobId: prior.job_id,
    issuedAt: prior.issued_at,
    createdAt: prior.header_created_at,
    shareTokenId: prior.share_token_id,
    token: prior.token,
    absoluteExpiresAt: prior.absolute_expires_at,
    recipientChannel: prior.recipient_channel,
    recipientAddress: prior.recipient_address,
    recipientName: prior.recipient_name,
    shareUrl: buildQuoteShareUrl(prior.token),
    alreadyExisted: true,
    eventsEmitted: [],  // §17.15 clarification: retry emitted no events
    traceId,
  });
}

/**
 * buildSendQuoteReturnShape — §17.15 multi-entity composer. First handler
 * to surface two entity keys: `quote` + `share_token`. Used by both the
 * happy-path return and the idempotent-retry return.
 *
 * meta.events_emitted semantics per §17.15 clarification: describes events
 * THIS invocation emitted. Retry returns [] because the original call
 * emitted; this call did not.
 *
 * Intentionally separate from buildCreateQuoteReturnShape per approved
 * Q2: one composer per handler stays at 15-25 lines; parameterizing
 * across handlers grows into 40-line conditional blocks as the family
 * accumulates entity shapes.
 */
function buildSendQuoteReturnShape({
  // quote entity
  quoteId, versionId, humanId, versionNo, status, currency, totalCents,
  customer, jobId, issuedAt, createdAt,
  // share_token entity
  shareTokenId, token, absoluteExpiresAt,
  recipientChannel, recipientAddress, recipientName, shareUrl,
  // meta
  alreadyExisted, eventsEmitted, traceId,
}) {
  return {
    ok: true,
    quote: {
      id: quoteId,
      version_id: versionId,
      human_id: humanId,
      version_no: versionNo,
      status,
      currency,
      total_cents: Number(totalCents),
      customer: {
        id: customer.id,
        name: customer.name,
        email: customer.email || null,
        phone_e164: customer.phone_e164 || null,
      },
      job_id: jobId,
      issued_at: issuedAt,
      created_at: createdAt,
    },
    share_token: {
      id: shareTokenId,
      token,
      absolute_expires_at: absoluteExpiresAt,
      recipient: {
        channel: recipientChannel,
        address: recipientAddress,
        name: recipientName,
      },
      url: shareUrl,
    },
    meta: {
      already_existed: alreadyExisted,
      events_emitted: eventsEmitted,
      traceId,
    },
  };
}

async function handleSendQuote(rawCil, ctx) {
  // ─── Ctx preflight (§17.17 addendum 2) ────────────────────────────────────
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

  // ─── Step 1 (§17.17 step 1): Zod validation ───────────────────────────────
  const parsed = SendQuoteCILZ.safeParse(rawCil);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const pathStr = issue && issue.path && issue.path.length ? issue.path.join('.') : '<root>';
    return errEnvelope({
      code: 'CIL_SCHEMA_INVALID',
      message: issue ? `${pathStr}: ${issue.message}` : 'SendQuote input failed validation',
      hint: 'See docs/QUOTES_SPINE_DECISIONS.md §22 for the SendQuoteCILZ input contract',
      traceId: ctx.traceId,
    });
  }
  const data = parsed.data;

  // ─── Step 2: Plan gating — NONE per G6 ────────────────────────────────────
  // SendQuote is follow-through to CreateQuote. §19 gates creation; Free-tier
  // can't create → can't send. No dedicated quote_sent counter.

  // ─── Step 3 (§17.17 step 3 + addendum): actor role check ──────────────────
  if (data.actor.role !== 'owner') {
    return errEnvelope({
      code: 'PERMISSION_DENIED',
      message: 'SendQuote is owner-only',
      hint: 'Ask the owner to send quotes (One Mind, Many Senses)',
      traceId: ctx.traceId,
    });
  }

  // ─── Step 4 (§17.17 step 4 / §17.14): transaction ─────────────────────────
  // eslint-disable-next-line global-require
  const pg = require('../../services/postgres');

  // ─── Pre-transaction idempotent-retry check ───────────────────────────────
  // Handles the sequential retry case: first call already transitioned the
  // quote to 'sent'; without this check, the second call's loadDraftQuote
  // would surface QUOTE_NOT_DRAFT (semantic_error) instead of recognizing
  // the retry. The concurrent retry case still flows through classifyCilError
  // via 23505 on chiefos_qst_source_msg_unique.
  const preTxnPrior = await lookupPriorShareToken(ctx.owner_id, data.source_msg_id);
  if (preTxnPrior) {
    return priorShareTokenToReturnShape(preTxnPrior, ctx.traceId);
  }

  let txnResult;
  try {
    txnResult = await pg.withClient(async (client) => {
      // Section 2 — load draft quote
      const loaded = await loadDraftQuote(client, {
        tenantId: data.tenant_id,
        ownerId: ctx.owner_id,
        quoteRef: data.quote_ref,
      });

      // Section 3 — resolve recipient (override > snapshot > RECIPIENT_MISSING)
      const recipient = resolveRecipient({
        parsedRecipientEmail: data.recipient_email,
        parsedRecipientName: data.recipient_name,
        customerSnapshot: loaded.customer_snapshot,
      });

      // Section 4 — generate + insert share token
      const tokenValue = generateShareToken();
      const tokenRow = await insertShareToken(client, {
        tenantId: data.tenant_id,
        ownerId: ctx.owner_id,
        quoteVersionId: loaded.version_id,
        token: tokenValue,
        recipient,
        sourceMsgId: data.source_msg_id,
      });

      // Section 5a — state transitions (draft → sent; issued_at, sent_at)
      await markQuoteSent(client, {
        quoteId: loaded.quote_id,
        versionId: loaded.version_id,
        tenantId: data.tenant_id,
        ownerId: ctx.owner_id,
      });

      // Section 5b — lifecycle.sent event emission
      await emitLifecycleSent(client, {
        quoteId: loaded.quote_id,
        versionId: loaded.version_id,
        tenantId: data.tenant_id,
        ownerId: ctx.owner_id,
        actorSource: CIL_TO_EVENT_ACTOR_SOURCE[data.source],
        actorUserId: data.actor.actor_id,
        emittedAt: data.occurred_at,
        customerId: loaded.customer_id,
        shareTokenId: tokenRow.id,
        recipientChannel: 'email',
        recipientAddress: recipient.email,
        recipientName: recipient.name,
      });

      return { loaded, recipient, tokenRow };
    });
  } catch (err) {
    const c = classifyCilError(err, {
      expectedSourceMsgConstraint: SEND_QUOTE_SOURCE_MSG_CONSTRAINT,
    });

    if (c.kind === 'semantic_error') {
      return errEnvelope({
        code: 'CIL_INTEGRITY_ERROR',
        message: c.error.message,
        hint: c.error.hint,
        traceId: ctx.traceId,
      });
    }

    if (c.kind === 'idempotent_retry') {
      const prior = await lookupPriorShareToken(ctx.owner_id, data.source_msg_id);
      if (!prior) {
        // Unexpected — 23505 on chiefos_qst_source_msg_unique fired, so a
        // row with this (owner_id, source_msg_id) must exist. Missing means
        // the DB is in an inconsistent state. Rethrow as 500-class.
        throw new Error(
          `Idempotent retry lookup missed for SendQuote (${ctx.owner_id}, ${data.source_msg_id})`
        );
      }
      return priorShareTokenToReturnShape(prior, ctx.traceId);
    }

    if (c.kind === 'integrity_error') {
      return errEnvelope({
        code: 'CIL_INTEGRITY_ERROR',
        message: `Unique constraint violation on ${c.constraint}`,
        hint: 'Verify tenant/owner FK consistency for the target quote or share token',
        traceId: ctx.traceId,
      });
    }

    throw err;  // not_unique_violation
  }

  // ─── Step 5 (§17.16 / §19): NO counter increment per G6 ───────────────────
  // SendQuote is not a monetizable event. Creation is gated (§19); sending is
  // follow-through. meta.events_emitted below distinguishes notification
  // outcomes.

  // ─── Post-commit Postmark dispatch + paired notification events ───────────
  const { loaded, recipient, tokenRow } = txnResult;
  const shareUrl = buildQuoteShareUrl(tokenRow.token);
  const { subject, textBody } = buildSendQuoteEmail({
    tenantSnapshot: loaded.tenant_snapshot,
    quote: {
      human_id: loaded.human_id,
      project_title: loaded.project_title,  // Refactor 2 — from loaded, not side query
      total_cents: loaded.total_cents,
      currency: loaded.currency,
    },
    recipient,
    shareUrl,
  });

  const eventsEmitted = ['lifecycle.sent'];  // emitted inside txn; committed

  const sharedEventArgs = {
    quoteId: loaded.quote_id,
    versionId: loaded.version_id,
    tenantId: data.tenant_id,
    ownerId: ctx.owner_id,
    actorSource: CIL_TO_EVENT_ACTOR_SOURCE[data.source],
    actorUserId: data.actor.actor_id,
    emittedAt: data.occurred_at,
    customerId: loaded.customer_id,
    shareTokenId: tokenRow.id,
    channel: 'email',
    recipient: recipient.email,
  };

  const sendEmail = getSendEmail();
  try {
    const postmarkResult = await sendEmail({
      to: recipient.email,
      subject,
      textBody,
    });
    await emitNotificationSent(pg, {
      ...sharedEventArgs,
      providerMessageId: (postmarkResult && postmarkResult.MessageID) || 'unknown',
    });
    eventsEmitted.push('notification.sent');
  } catch (postmarkErr) {
    await emitNotificationFailed(pg, {
      ...sharedEventArgs,
      errorCode: postmarkErr.ErrorCode || postmarkErr.errorCode || postmarkErr.code || 'unknown',
      errorMessage: postmarkErr.Message || postmarkErr.message || 'unknown',
    });
    eventsEmitted.push('notification.failed');
    // Do NOT rethrow per Refinement B: quote is committed as 'sent'; email
    // failure is a separate notification facet, not a state-transition
    // rollback trigger. Handler returns ok:true regardless.
  }

  // ─── §17.15 multi-entity return shape ─────────────────────────────────────
  // Customer sub-object built from snapshot (Refactor 1) — reflects the
  // captured-at-send-time contract, not a later customer-row edit.
  return buildSendQuoteReturnShape({
    quoteId: loaded.quote_id,
    versionId: loaded.version_id,
    humanId: loaded.human_id,
    versionNo: loaded.version_no,
    status: 'sent',  // just transitioned in Section 5
    currency: loaded.currency,
    totalCents: loaded.total_cents,
    customer: {
      id: loaded.customer_id,
      name: loaded.customer_snapshot.name,
      email: loaded.customer_snapshot.email,
      phone_e164: loaded.customer_snapshot.phone_e164,
    },
    jobId: loaded.job_id,
    issuedAt: data.occurred_at,  // just populated in markQuoteSent
    createdAt: loaded.header_created_at,
    shareTokenId: tokenRow.id,
    token: tokenRow.token,
    absoluteExpiresAt: tokenRow.absolute_expires_at,
    recipientChannel: 'email',
    recipientAddress: recipient.email,
    recipientName: recipient.name,
    shareUrl,
    alreadyExisted: false,
    eventsEmitted,
    traceId: ctx.traceId,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  handleCreateQuote,
  handleSendQuote,
  CreateQuoteCILZ,
  SendQuoteCILZ,
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
    lookupPriorQuote,
    buildCreateQuoteReturnShape,
    // SendQuote schemas (Section 1)
    SendQuoteCILZ,
    QuoteRefInputZ,
    // SendQuote Section 2
    loadDraftQuote,
    // SendQuote Section 3
    resolveRecipient,
    // SendQuote Section 4
    generateShareToken,
    insertShareToken,
    // SendQuote Section 5
    markQuoteSent,
    emitLifecycleSent,
    // SendQuote Section 6
    buildQuoteShareUrl,
    formatCentsAsCurrency,
    buildSendQuoteEmail,
    emitNotificationSent,
    emitNotificationFailed,
    setSendEmailForTests,
    resetSendEmailForTests,
    APP_URL,
    SEND_QUOTE_SOURCE_MSG_CONSTRAINT,
    // SendQuote Section 7
    lookupPriorShareToken,
    buildSendQuoteReturnShape,
    priorShareTokenToReturnShape,
    TenantSnapshotZ,
    CustomerSnapshotZ,
    CreateQuoteJobRefZ,
    CustomerInputZ,
    LineItemInputZ,
    SOURCE_MSG_CONSTRAINT,
    CIL_TO_QUOTE_SOURCE,
    CIL_TO_EVENT_ACTOR_SOURCE,
    // SignQuote Section 1 (schema + constraint constant)
    SignQuoteCILZ,
    SignQuoteActorZ,
    ShareTokenStringZ,
    PngDataUrlZ,
    SIGN_QUOTE_SOURCE_MSG_CONSTRAINT,
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// ROUTER REGISTRATION — COMPLETE (§17.12)
// ═══════════════════════════════════════════════════════════════════════════
//
// handleCreateQuote is registered in src/cil/router.js's
// NEW_IDIOM_HANDLERS frozen map. applyCIL({ type: 'CreateQuote', ... })
// now routes to this handler instead of falling through to the legacy
// router's CIL_TYPE_UNKNOWN response.
//
// Future handlers (SendQuote, SignQuote, LockQuote, VoidQuote,
// ReissueQuote) follow the same two-step registration pattern per §17.12.
