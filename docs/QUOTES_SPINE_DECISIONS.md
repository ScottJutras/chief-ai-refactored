# ChiefOS Quotes Spine — Architecture Decisions Log

Durable record of the "why" behind the schema, trigger model, and identity design of
the Quotes spine. Plan files describe what is being done; this file describes why.
Future sessions add entries as new decisions are made.

## Governing Principles (cross-cutting)

These principles govern every new audit-bearing migration across the spine
(invoices, change orders, receipts, future doc types). They are written to
be independently applicable — a future session looking for "how should I
decide RLS on a new table" or "should this field be a DB CHECK or a CIL
contract" should find the rule directly without needing the surrounding
migration context.

- **§11.0 — RLS governing principle.** Every chiefos_* table gets one of two
  RLS patterns: **tight** (tenant SELECT only) for audit-terminal tables
  whose rows become legal evidence, or **broad** (tenant SELECT/INSERT/UPDATE)
  for working-state tables that are routinely edited through the portal.
  Test: "would a legitimately-written row be legal evidence in a dispute?"
- **§11c — Atomicity pattern for state-transitioning CIL flows.** Every CIL
  flow that transitions state wraps `event row → domain-specific row →
  parent-state update` in one PG transaction. All three succeed or all three
  roll back. Canonical for SignQuote; expected for every future
  state-transitioning CIL.
- **§14.10 — Structural invariants vs ceremonial obligations.** Field-level
  requirements on CIL-written rows live at the DB `CHECK` layer when the
  field is required by the nature of the kind (any emission must carry it);
  they live at the CIL handler contract + decisions-log documentation layer
  when the field is required by the current ceremony (future code paths may
  legitimately omit it). Test: "is this field required by the kind, or by
  the ceremony?"
- **§17 — CIL Architecture Principles.** Eleven rules governing the CIL
  layer, grouped in three bands:
  - **Idiom direction (§17.1–§17.3).** `BaseCILZ` is the forward idiom;
    legacy `baseCIL` is frozen. Legacy handlers migrate per non-trivial
    change. Visible tracking in `CHIEFOS_EXECUTION_PLAN.md`; `cil.js`
    deletion is a logged event.
  - **Routing (§17.4–§17.7, §17.12).** New handlers in `src/cil/*.js`;
    `src/cil/router.js` is the forward entry point. Facade pattern delegates
    legacy via runtime `require` (laziness is load-bearing). Standard
    Constitution §9 error envelope across both routers. Caller migration is
    one mechanical pass. Handler registration is a static `Object.freeze`d
    map — no runtime registration API; imports + map entries are the two
    explicit steps to add a new handler (§17.12).
  - **Handler write pattern (§17.14).** Version-creating handlers
    (CreateQuote, EditDraft, ReissueQuote) use the NULL-then-UPDATE
    pointer sequence: insert header with `current_version_id = NULL`,
    insert version, insert line items, UPDATE header pointer, emit audit
    events — all in one transaction. No orphan rows possible; no reliance
    on `DEFERRABLE` FK.
  - **Return shape (§17.15).** Every new-idiom handler success response
    has shape `{ ok: true, <entity_key>: {...}, meta: { already_existed,
    events_emitted, traceId } }`. `meta` is the success-side parallel to
    `error` on the failure side. Multi-entity handlers add sibling
    entity keys; `meta` stays one key. `traceId` is always a string
    (never null). `meta.already_existed: true` is source_msg_id-granular
    idempotency, NOT payload equivalence.
  - **Plan gating (§17.16).** All gated new-idiom handlers resolve plan
    and monthly usage via shared `gateNewIdiomHandler(ctx, checkFn,
    kindLiteral)` in `src/cil/utils.js`. Gating runs after schema
    validation and before the §17.14 transaction opens; counter
    increments only after successful commit. `errEnvelope` lives in
    `utils.js` as the single source of Constitution §9 shape. Legacy
    caller-resolves pattern unchanged; principle governs new-idiom only.
  - **Actor role gating (§17.17).** Role restrictions enforced in
    handler logic, not in CIL schema. Canonical pre-transaction
    sequence (§17.17 addenda): (0) ctx preflight — OWNER_ID_MISSING
    / TRACE_ID_MISSING fail-loud before Zod → (1) Zod schema → (2)
    plan gating via §17.16 → (3) actor role check (read from
    parsed.actor.role, not ctx.actor) → (4) transaction. Each failure
    returns a Constitution §9 envelope. Pairs with §17.16.
  - **Error code naming (§17.18).** Three prefix categories:
    `CIL_`-prefix for CIL-layer enforcement
    (CIL_SCHEMA_INVALID, CIL_INTEGRITY_ERROR, etc.); capability-name
    prefix for plan gating (QUOTES_REQUIRES_STARTER, etc.); bare
    condition name for cross-cutting runtime checks
    (PERMISSION_DENIED, OWNER_ID_MISSING, TRACE_ID_MISSING).
    SCREAMING_SNAKE_CASE throughout.
  - **Dedup (§17.8–§17.11).** Entity-table `(owner_id, source_msg_id) UNIQUE`
    is canonical for CIL-retry dedup on root entities; events' `external_event_id`
    partial UNIQUE is a distinct webhook-retry dedup surface — do not conflate.
    Optimistic INSERT-and-catch, not SELECT-then-INSERT. Shared
    `classifyCilError` helper in `src/cil/utils.js` (renamed from
    `classifyUniqueViolation` 2026-04-20; now handles both DB-level 23505
    cases and semantic errors via `CilIntegrityError` class). Dedup scopes
    to `(owner_id, source_msg_id)`, not `tenant_id`. **Idempotent_retry
    returns current entity state, not original-call state** (§17.10
    clarification 2026-04-20) — input- and version-equivalence are both
    not checked; the retry signals "exists at source_msg_id granularity."
    Outer catch is a single switch over four kinds: `semantic_error`,
    `idempotent_retry`, `integrity_error`, `not_unique_violation`.
  - **Sequential IDs (§17.13).** Financial/contractual doc types (quotes,
    invoices, change orders, receipts) use **per-tenant** counters in
    `chiefos_tenant_counters` with a `counter_kind` discriminator. Format
    `<PREFIX>-YYYY-MMDD-NNNN`. Operational entities (jobs, tasks) retain
    per-owner `allocateNextJobNo` pattern. Asymmetry intentional.
  Section is platform-level infrastructure; future doc-type sessions
  (invoices, change orders, receipts) reference it directly.
- **§18 — Migration 5: counter table restructure (APPLIED 2026-04-20).**
  Added `counter_kind` discriminator to `chiefos_tenant_counters`,
  renamed `next_activity_log_no` → `next_no`, restructured PK to
  `(tenant_id, counter_kind)`, added format-only CHECK. Replaced
  `allocateNextActivityLogNo` with generic
  `allocateNextDocCounter(tenantId, counterKind, client)`. Added
  `COUNTER_KINDS` frozen constant at `src/cil/counterKinds.js`. 10/10
  SQL verification tests passed + T12 correctness-fix verification. See
  §18.1-§18.5 for applied-record details.
- **§19 — Plan gating for CreateQuote.** Adapts `canUseOCR` pattern.
  New capability block `quotes` (Starter 50/mo, Pro 500/mo, Free
  disabled) at top level of each tier. Denial codes
  `QUOTES_REQUIRES_STARTER`, `QUOTES_CAPACITY_REACHED`. Counter kind
  `'quote_created'` on `usage_monthly_v2`, increments after commit.
  Call via §17.16 helper.
- **§20 — CreateQuote input contract.** Extends BaseCILZ. Customer
  either/or (UUID OR inline; no auto-match). Job required, resolved
  in-transaction. Line items min 1. Title required, scope optional.
  `tax_rate_bps` required (no default); totals server-computed.
  Payment terms caller-supplied. `customer_snapshot` + `tenant_snapshot`
  handler-computed against defined Zod shapes; warranty/clauses
  caller-supplied inline JSONB. Actor gated to owner-only per §17.17.

## §0. Source of truth
- Handoff: `C:\Users\scott\Documents\mission-quote-standalone\QUOTES_HANDOFF_TO_CHIEFOS.md`
- Execution plan: `CHIEFOS_EXECUTION_PLAN.md` §1.2 (re-opened 2026-04-18)
- Engineering Constitution: dual-boundary identity, fail-closed plan gating, immutable signed documents.
- First migration: `migrations/2026_04_18_chiefos_quotes_spine.sql`

## §1. Line items: drop and create fresh (2026-04-18)
Decision: drop legacy `public.quote_line_items` and `public.quotes`, create new
`public.chiefos_quote_line_items` with `owner_id` NOT NULL from day 1.
Reasoning: zero production rows; only one known caller (`compare_quote_vs_actual`);
establishing the `chiefos_*` naming convention at first opportunity beats the
marginal defensive cover of a compat view.

## §2. Versioning: header + immutable versions table (2026-04-18)
Decision: `chiefos_quotes` (mutable header) + `chiefos_quote_versions` (append-only,
immutable on lock). Immutability enforced by DB triggers, not by application code.
Reasoning: the Engineering Constitution's "Fail Closed" rule means uncertainty must
block the action. Application-level immutability is "fail-closed only if the app
remembers to check" — apps forget. DB-level triggers hold when human attention
slips. Option 3 (inline JSONB snapshot) was eliminated on product grounds: it
buries line items in JSONB, breaking `compare_quote_vs_actual` on exactly the
quotes that matter most (signed ones).

## §3. Line-item immutability: cross-table trigger (2026-04-18)
Decision: a BEFORE INSERT/UPDATE/DELETE trigger on `chiefos_quote_line_items` reads
the parent version's `locked_at`. Mutation is rejected if parent is locked.
Reasoning: FK alone doesn't enforce mutation rules; line items need their own
guard. Single trigger handles all three events; consistent error message.
Sign-time ordering: line items inserted first (parent still unlocked), then
`locked_at` set on parent in the same transaction. From that moment on, both
triggers deny further mutation.

## §4. Server hash: full SHA-256 over canonical serialization (2026-04-18)
Decision: `chiefos_quote_versions.server_hash` is full SHA-256 hex (64 chars),
never truncated, computed server-side at lock time over a canonical serialization
of the entire version (line items in order, tenant snapshot, customer snapshot,
warranty snapshot, clauses snapshot, totals in integer cents, ISO UTC timestamps,
Unicode NFC, lexicographic JSON key order).
Reasoning: the standalone's 16-char truncated client-side hash was a visual
tamper-evident signal, not real integrity. The Constitution requires real
integrity on signed documents. Full hash stored, truncated display only.

Canonical serialization rules:
- JSON keys sorted lexicographically (recursively).
- No whitespace between tokens.
- All monetary values as integer cents; never floats.
- All timestamps as ISO-8601 UTC with millisecond precision and `Z` suffix.
- All phone numbers as E.164.
- All emails lowercased and trimmed.
- Unicode NFC normalization on all text fields.
- Line items ordered by `(sort_order ASC, id ASC)`.
- `qty_thousandths` (integer = qty × 1000) used in hash input, not `qty` numeric,
  to avoid floating-point ambiguity.

Storage constraint: `CHECK (server_hash IS NULL OR server_hash ~ '^[0-9a-f]{64}$')`.
Null only while version is draft.

## §5. Header immutability: per-column trigger (2026-04-18)
Decision: all identity columns on `chiefos_quotes` (id, tenant_id, owner_id, job_id,
customer_id, human_id, source, source_msg_id, created_at) are immutable after
insert. Only `status`, `current_version_id`, `updated_at`, `voided_at`,
`voided_reason` may change.
Reasoning: `customer_id` on the header is the quote's long-lived customer identity.
Letting it drift over the life of a quote creates audit ambiguity. Void-and-reissue
is the explicit path for major changes.

## §6. Templates: structured JSONB snapshots inline, soft text refs for future FK (2026-04-18)

**Decision.** `chiefos_quote_versions` stores warranty and clauses content as two
structured JSONB columns — `warranty_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb`
and `clauses_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb`. Snapshot shapes are
structured, not opaque HTML blobs; e.g.:

```json
{
  "blocks": [
    { "term": 55, "term_unit": "year", "title": "Panel warranty", "body": "…" }
  ],
  "intro": "…",
  "workmanship_paragraph": "…",
  "exclusions": ["…"]
}
```

Alongside the snapshots, each version carries two free-text forward-reference
columns — `warranty_template_ref text NULL` and `clauses_template_ref text
NULL` — holding identifiers like `"default.mission-exteriors.v1"`. These are
**not** FKs. The referenced table (`chiefos_quote_templates`) does not yet
exist. No template editor, no catalog of per-tenant templates, no seed data
ships with this migration.

**Why structured JSONB, not inline HTML.** The single highest-value analytics
path in ChiefOS is the quote-to-actual loop and its successors (pattern
detection, owner benchmarks, margin alerts). These depend on SQL-level
queryability of signed quotes — exactly the rows we most want to analyze. HTML
blobs foreclose on queries like "show all signed quotes that included a
55-year panel warranty" or "what fraction of signed quotes carry an arbitration
clause". JSONB preserves that queryability (via `->` / `@>` / jsonb_path_ops)
without sacrificing audit fidelity: the snapshot is still a byte-for-byte
immutable record of what was signed.

**Why soft text refs instead of the template FK now.** Two reasons. First,
`chiefos_quote_templates` has not been designed yet — its shape (per-tenant,
per-jurisdiction, per-product-family?) is an open product question that
shouldn't be prematurely committed to in schema. Second, storing the ref as
opaque text is zero-cost: no FK validation, no orphan concerns, no migration
pain when the templates table later changes name or identity column type.

**Why the snapshot must win, even after templates ship.** The snapshot is the
legally-signed content. If the template is edited post-sign, v1's signature
still covers the exact text the customer agreed to. This is the Constitution's
immutability rule applied to content, not just structure.

**Forward path — when `chiefos_quote_templates` ships.** A later migration
will (in order):
  1. Create `chiefos_quote_templates(id uuid PRIMARY KEY, tenant_id uuid
     NOT NULL, owner_id text NOT NULL, kind text CHECK ('warranty' |
     'clauses'), ref text NOT NULL, body jsonb NOT NULL, created_at, updated_at,
     archived_at, UNIQUE(tenant_id, ref, kind))`. The `ref` column holds
     the same identifier currently stored in `*_template_ref`.
  2. Add `warranty_template_id uuid NULL REFERENCES
     chiefos_quote_templates(id)` and `clauses_template_id uuid NULL
     REFERENCES chiefos_quote_templates(id)` alongside the existing text refs.
     The existing `warranty_template_ref` and `clauses_template_ref` columns
     stay — they remain the cheap lookup for "which template was this version
     sourced from", unaffected by template rename/delete.
  3. Backfill `*_template_id` by looking up templates whose
     `(tenant_id, ref)` matches the existing `*_template_ref` text.
  4. The template editor UI writes new templates and drives the
     CreateQuote / ReissueAfterSign CIL flow to populate the snapshot from
     the latest template version. The snapshot is frozen; the template may
     be edited freely afterward without affecting the signed version.

**Out of scope for this migration.** `chiefos_quote_templates` table, seed
data for any default templates (Mission Exteriors boilerplate), template
editor UI, the "apply template to new version" CIL path. Each lands in its
own round.

## §7. Version lifecycle (2026-04-18)
- Every `chiefos_quotes` row has ≥1 version, created in the same transaction.
- Draft versions are deletable; locked versions are never deletable.
- Voiding a signed quote sets header `status = 'voided'`, leaves the locked
  version intact, blocks further versions on that quote. A replacement is a new
  `chiefos_quotes` row, not a new version of the voided one.
- `current_version_id` points to the version the portal should render. Swings
  only on version creation (not on status transitions).
- `CreateQuote` → insert v1 (draft), pointer = v1.id.
- Edits to a draft version → in-place update to v1; pointer unchanged.
- `SignQuote` → locks the pointed-to version; pointer unchanged.
- `ReissueAfterSign` → insert v2 draft; pointer swings to v2.id. v1 stays locked.
- Admin view of a prior locked version: explicit `?version=N` URL param,
  not a pointer swing.

## §8. RLS model (2026-04-18)
Tenant-scoped via `chiefos_portal_users` membership, following the `job_photos`
idiom. SELECT/INSERT/UPDATE exposed; DELETE is service-role only (forces
deletes through application code paths that can emit audit events and respect
state-machine rules).

Pre-apply verification: the migration includes a `DO $verify_portal_users$`
block that asserts `public.chiefos_portal_users` exists with `user_id uuid`
and `tenant_id uuid`, raising an exception before any destructive DDL if the
shape has drifted. This prevents the silent failure mode where RLS policies
ship against a non-matching resolver table.

## §9. Cross-table dual-boundary via composite FKs (2026-04-18)
Decision: tenant_id and owner_id consistency between parent and child rows
in the Quotes spine is enforced by **composite foreign keys**, not by
constraint triggers.
- `chiefos_quote_versions (quote_id, tenant_id, owner_id)` composite FK →
  `chiefos_quotes (id, tenant_id, owner_id)`.
- `chiefos_quote_line_items (quote_version_id, tenant_id, owner_id)` composite FK →
  `chiefos_quote_versions (id, tenant_id, owner_id)`.
- `chiefos_quotes (current_version_id, tenant_id, owner_id)` composite FK →
  `chiefos_quote_versions (id, tenant_id, owner_id)`, DEFERRABLE INITIALLY
  DEFERRED so CreateQuote can insert header then v1 in one transaction.

Each parent table gains a matching `UNIQUE (id, tenant_id, owner_id)`
constraint (redundant for row identity since `id` is PK, but required by
Postgres as a composite-FK target and useful as a covering index).

Reasoning: composite FKs are declarative and checked by the DB engine. They
can't be bypassed by a trigger-disable (`SET session_replication_role =
replica` only disables replica triggers, not FK checks). Constraint triggers
were the alternative; we rejected them because they're procedural PL/pgSQL
that future maintainers might "optimize away" without realizing they hold a
load-bearing invariant. A composite FK is self-documenting in `\d`.

Scope note: cross-quote pointer bugs (a header's current_version_id pointing
at a version of a different quote within the same tenant) are out of scope
for this round. They're not a dual-boundary violation (both sides share
tenant). A later migration may add a 4-column composite FK
`(current_version_id, id, tenant_id, owner_id) → versions(id, quote_id,
tenant_id, owner_id)` to close that gap.

## §10. Migration 1 applied (2026-04-18)

Migration `chiefos_quotes_spine_20260418` landed to Chief production (Supabase
project `xnmsjdummnnistzcxrtj`, version `20260418190457`).

**What landed:**
- 3 tables: `chiefos_quotes`, `chiefos_quote_versions`, `chiefos_quote_line_items`
- 3 immutability triggers: versions locked-row (UPDATE + DELETE), line-items
  parent-lock (cross-table, INSERT + UPDATE + DELETE), header identity-columns
  (UPDATE per-column check)
- 3 composite dual-boundary FKs:
  - `chiefos_qv_parent_identity_fk`: versions `(quote_id, tenant_id, owner_id)`
    → quotes `(id, tenant_id, owner_id)` ON DELETE RESTRICT
  - `chiefos_qli_parent_identity_fk`: line items
    `(quote_version_id, tenant_id, owner_id)` → versions
    `(id, tenant_id, owner_id)` ON DELETE RESTRICT
  - `chiefos_quotes_current_version_fk`: header
    `(current_version_id, tenant_id, owner_id)` → versions
    `(id, tenant_id, owner_id)` DEFERRABLE INITIALLY DEFERRED
- 3 conventional FKs on header: `tenant_id → chiefos_tenants`,
  `job_id → jobs`, `customer_id → customers`
- 9 RLS policies: 3 SELECT + 3 INSERT + 3 UPDATE, tenant-scoped via
  `chiefos_portal_users`. DELETE is service-role only by design.
- RLS enabled on all 3 tables.
- 21 explicit indexes plus PK and UNIQUE indexes generated from constraints.

**What was dropped (verified empty by preflight):**
- `public.quote_line_items` (pre-sprint, empty, narrow coupling)
- `public.quotes` (legacy PocketCFO ghost, empty, broken write path)

**Why composite FK, not constraint trigger** (for cross-table dual-boundary
enforcement): composite FKs are declarative and checked by the DB engine on
every mutation. They cannot be disabled or bypassed without disabling ALL FK
checks, which no legitimate path does. Constraint triggers were the rejected
alternative — they require PL/pgSQL that future maintainers might "optimize
away" without realising it held a load-bearing invariant. Every parent table
carries `UNIQUE (id, tenant_id, owner_id)` as the composite-FK target. The
"redundant" unique index is the mechanism, not overhead.

**Verification results** (12/12 passed, DO-block-with-RAISE-EXCEPTION rollback
pattern, live tenant `86907c28-a9ea-4318-819d-5a012192119b`, job 80, owner
`19053279955`):
- T1: cross-tenant version INSERT rejected by composite FK ✓
- T2: cross-owner line-item INSERT rejected by composite FK ✓
- T3: valid draft-stage line-item INSERT allowed ✓
- T4: draft→locked transition with `server_hash` allowed ✓
- T5: UPDATE on locked version rejected (`check_violation` — "constitutional
  immutability") ✓
- T6: DELETE on locked version rejected ✓
- T7: INSERT line item on locked parent rejected by cross-table trigger ✓
- T8: UPDATE `header.tenant_id` rejected (`chiefos_quotes.tenant_id is
  immutable`) ✓
- T9: UPDATE `header.job_id` rejected ✓
- T10: `header.status → voided` transition allowed ✓
- T11: `current_version_id → nonexistent` rejected (with `SET CONSTRAINTS
  chiefos_quotes_current_version_fk IMMEDIATE` to force the deferred FK to
  check mid-transaction) ✓

Zero rows persisted; the verification pattern was `RAISE EXCEPTION` at end of
DO block, which rolled back all test inserts inside the MCP-wrapped
transaction. Confirmed post-test via `SELECT COUNT(*)` on all three tables.

**Preflight behaviour:** both `DO $preflight$` (empty-table assertion on the
legacy `quote_line_items` and `quotes`) and `DO $verify_portal_users$`
(column-shape assertion on `public.chiefos_portal_users`) ran without
exception — confirmed the destructive DROPs were safe and RLS would bind
correctly. The two blocks run BEFORE any DDL, so a shape drift in
`chiefos_portal_users` would have aborted before destruction.

**Status:** Quotes spine FOUNDATION shipped. Feature NOT complete. Remaining
work for Phase 1.2 gate: signatures table, events table, share-tokens table,
CIL layer (`src/cil/quotes.js`), portal UI, server PDF render on sign,
Postmark wiring (contractor + customer), plan gating in
`planCapabilities.js`.

## §11.0. RLS governing principle: audit-terminal vs working-state tables (2026-04-18)

**Rule.** Every chiefos_* table gets exactly one of two RLS patterns, chosen
by the nature of its rows:

- **Tight pattern** — `tenant SELECT` only; no `INSERT`/`UPDATE`/`DELETE`
  policies for portal users; all writes flow through backend CIL handlers
  under service-role auth (which bypasses RLS). Applied to tables whose rows
  are legally-consequential audit artifacts.
- **Broad pattern** — `tenant SELECT` + `tenant INSERT` + `tenant UPDATE`;
  `DELETE` is service-role only. Applied to tables whose rows are working
  state — routinely edited through the portal during normal product use.

**The test.** If a legitimately-written row on this table becomes evidence
in a legal dispute about what happened and when, the table is audit-terminal
and gets the tight pattern. If rows are routinely edited or deleted through
normal product use, the table is working state and gets the broad pattern.

**Current classification across the Quotes spine:**

| Table | Classification | RLS pattern | Current state |
|---|---|---|---|
| `chiefos_quotes` (header) | Working state (status transitions, `current_version_id` pointer, draft edits) | Broad | ✓ Matches |
| `chiefos_quote_versions` | Audit-terminal (immutable on lock; signed versions are legal evidence) | Tight | **DRIFT — currently broad from migration 1; harmonize in migration 4** |
| `chiefos_quote_line_items` | Audit-terminal (inherits version immutability via parent-lock trigger; signed line items are legal evidence) | Tight | **DRIFT — currently broad from migration 1; harmonize in migration 4** |
| `chiefos_quote_events` | Audit-terminal (append-only audit stream) | Tight | ✓ Matches (migration 2) |
| `chiefos_quote_share_tokens` | Audit-terminal (bearer-token audit record; legal basis for signature) | Tight | ✓ Matches (migration 3) |
| `chiefos_quote_signatures` | Audit-terminal (the signature itself) | Tight | Pending migration 4 |

**Why the draft-period broadness on versions/line_items isn't a
justification for the broad pattern.** Even during the draft stage, the
version and its line items are *provisional audit artifacts* — if a dispute
arises over "what was the scope/price as of day X of the draft process,"
the rows on this table are the answer. The parent-lock trigger already
protects post-sign immutability at the DB layer; RLS tightening adds
defense-in-depth against forgery from a compromised portal session
(specifically: attacker can't INSERT a line item on a draft version to
inflate the quote right before the customer signs).

**Implication for portal UIs.** All write paths for audit-terminal tables
go through service-role CIL handlers. Portal gets SELECT only. This is
already the design for events and share tokens; extending to versions and
line items means the quote builder UI (still to be built) calls service-role
APIs for every draft-level line-item edit. Clean consistency; no special
cases.

## §11. Signature table design locked (2026-04-18 — not yet applied)

**Scope.** Quote-specific `chiefos_quote_signatures`. Not a generic
`chiefos_document_signatures`. Different doc types have different legal
semantics (quote = authorize scope + price; change order = authorize scope
delta; invoice = acknowledge receipt). Shared structure is solved by a
consistent schema pattern (below); distinct semantics is solved by distinct
tables.

**Cardinality.** One signature per version. `UNIQUE (quote_version_id)`. Multi-
party signatures are not a Beta requirement; adding them later is a v2 schema
change (drop unique, add `signer_role`), not a today speculation.

**PNG storage.** Bytes go to Supabase Storage in a tenant-scoped bucket. Row
stores `signature_png_storage_key text NOT NULL` and `signature_png_sha256
text NOT NULL CHECK (~ '^[0-9a-f]{64}$')`. Small rows; SHA-256 guards against
bucket tampering.

**Version-hash belt-and-suspenders.** `version_hash_at_sign text NOT NULL
CHECK (~ '^[0-9a-f]{64}$')`. Captures the parent version's `server_hash` at
the moment of sign, independently of the FK. If anything ever bypassed the
immutability triggers and tampered with the version, the signature still
records what the customer actually signed against.

**Signer identity.** `signer_name text NOT NULL`, `signer_email text`,
`signer_ip text`, `signer_user_agent text`. Not resolved to a ChiefOS user —
customers aren't ChiefOS users and never will be. Pure audit metadata.

**Event binding.** `signed_event_id uuid NOT NULL REFERENCES
chiefos_quote_events(id)`. Required FK — every signature has an associated
event row capturing the signing transition. Ships with integrity from day one
(see sequencing note below).

**Composite dual-boundary FK.** `(quote_version_id, tenant_id, owner_id) →
chiefos_quote_versions(id, tenant_id, owner_id) ON DELETE RESTRICT`. Same
pattern as migration 1, targeting the parent's `chiefos_qv_identity_unique`
index.

**Idempotency.** `UNIQUE (owner_id, source_msg_id)`. A retry from WhatsApp or
portal produces the same `source_msg_id` and is rejected by the unique
constraint with a handled 409-style error, not a 500.

**RLS — harmonized to the tight pattern (§11.0) 2026-04-18.** One policy:
`tenant SELECT` via `chiefos_portal_users`. No `INSERT`/`UPDATE`/`DELETE`
policies; SignQuote handler uses service role (bypasses RLS). Signatures are
audit-terminal artifacts — zero portal-side write paths by design. Closes
the forgery surface completely: a compromised portal session cannot
fabricate signature rows. (Earlier spec said SELECT/INSERT/UPDATE; that was
written before §12 tightened events to SELECT-only, and §11.0 generalized
the principle.)

**Immutability trigger.** `BEFORE UPDATE` trigger rejects any mutation of a
signature row. Signatures are born immutable. No post-insert state changes.

**Sequencing — events migration first, signatures second.** Events table
ships before signatures so the `signed_event_id uuid NOT NULL REFERENCES
chiefos_quote_events(id)` FK is a real FK from day one, not a forward-
reference-upgraded-later. Events have value independent of signatures
(capturing `quote.sent`, `quote.viewed`, `quote.voided`, etc. transitions),
so building them standalone is not speculative work. Reject direction (b)
with forward-ref uuid.

## §11a. Signature table template (canonical pattern for all doc-type signature tables)

**Updated 2026-04-18 per share-tokens round 8 (soft step-up):** every signature
table now carries two additional columns and one associated app-layer rule.

- `name_match_at_sign boolean NOT NULL DEFAULT false` — captured at sign time,
  immutable thereafter. `true` iff the typed signer name matched the token's
  recipient name under the normalized-last-name rule (below).
- `recipient_name_at_sign text NOT NULL CHECK (char_length(recipient_name_at_sign) > 0)` —
  the `recipient_name` from the share token at the moment of sign, denormalized
  onto the signature row for dispute forensics (so dispute queries don't need
  to join back to the token table, which may itself be in a terminal state).

**Name-match rule (app-layer, TypeScript in the SignQuote CIL handler):**
1. Normalize both `recipient_name` and typed `signer_name`:
   - lowercase, strip non-alphanumeric, collapse spaces, trim
2. Split on whitespace; take last token as last-name candidate.
3. `name_match_at_sign := (both non-null AND last_name_typed = last_name_recipient)`.

Rationale: last names are more stable than first names. Nicknames and initials
("Dar" for "Darlene", "J.R." for "John Robert") don't break match. Spouse
signing ("Robert MacDonald" for "Darlene MacDonald") still matches. No
diacritic handling, no nickname tables, no phonetic matching.

**SignQuote CIL obligation — recipient_name_at_sign is always populated.** The
handler reads `recipient_name` from the token (single query at the
`SELECT ... FOR UPDATE` step) and passes it through to the signature INSERT.
If any code path can reach signature creation without a valid
`recipient_name_at_sign`, the NOT NULL constraint breaks that path at the DB
layer — fail-closed by design. Review migration 4's handler design before it
lands to confirm no such path exists.

**New event kind — `integrity.name_mismatch_signed`.** Fires from the SignQuote
CIL handler when `name_match_at_sign = false`. Requires extending the
`chiefos_qe_kind_enum` CHECK in migration 4 (ALTER TABLE DROP CONSTRAINT /
ADD CONSTRAINT with the extended list). No auto-action on the event — purely
forensic metadata for the contractor, alertable via the per-tenant alert
channel established in §14.

Template below is the canonical SQL skeleton with the additions:

Every future `chiefos_<doctype>_signatures` table uses this column set,
index set, RLS set, and trigger set. When invoice / change order / contract
signatures ship, they apply the template, not rediscover the pattern.

```sql
CREATE TABLE public.chiefos_<doctype>_signatures (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  <doctype>_version_id        uuid NOT NULL,
  tenant_id                   uuid NOT NULL,
  owner_id                    text NOT NULL,
  signed_event_id             uuid NOT NULL REFERENCES public.chiefos_<doctype>_events(id),
  signer_name                 text NOT NULL CHECK (char_length(signer_name) > 0),
  signer_email                text,
  signer_ip                   text,
  signer_user_agent           text,
  signed_at                   timestamptz NOT NULL DEFAULT now(),
  signature_png_storage_key   text NOT NULL,
  signature_png_sha256        text NOT NULL CHECK (signature_png_sha256 ~ '^[0-9a-f]{64}$'),
  version_hash_at_sign        text NOT NULL CHECK (version_hash_at_sign ~ '^[0-9a-f]{64}$'),
  -- Name-match step-up (app-layer rule; DB stores the result flag + snapshot):
  name_match_at_sign          boolean NOT NULL DEFAULT false,
  recipient_name_at_sign      text NOT NULL CHECK (char_length(recipient_name_at_sign) > 0),
  -- Share-token binding (added 2026-04-18 per Q on sig→token linkage):
  -- every signature in the Beta architecture comes from a customer token
  -- sign ceremony. NOT NULL forces any future direct-portal-sign path to
  -- explicitly confront the schema, not silently allow null-token signatures.
  share_token_id              uuid NOT NULL,
  source_msg_id               text,
  created_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chiefos_<dt>_sig_version_unique UNIQUE (<doctype>_version_id),
  CONSTRAINT chiefos_<dt>_sig_source_msg_unique UNIQUE (owner_id, source_msg_id),
  CONSTRAINT chiefos_<dt>_sig_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT chiefos_<dt>_sig_parent_identity_fk
    FOREIGN KEY (<doctype>_version_id, tenant_id, owner_id)
    REFERENCES public.chiefos_<doctype>_versions(id, tenant_id, owner_id)
    ON DELETE RESTRICT,
  -- Composite dual-boundary FK on share_token_id. Enforces at schema layer
  -- that signature.tenant_id / owner_id match the share token's. Same
  -- idiom as every composite FK elsewhere in the spine.
  CONSTRAINT chiefos_<dt>_sig_share_token_identity_fk
    FOREIGN KEY (share_token_id, tenant_id, owner_id)
    REFERENCES public.chiefos_quote_share_tokens(id, tenant_id, owner_id)
    ON DELETE RESTRICT
);

CREATE INDEX chiefos_<dt>_sig_tenant_idx       ON ... (tenant_id, signed_at DESC);
CREATE INDEX chiefos_<dt>_sig_owner_idx        ON ... (owner_id, signed_at DESC);
CREATE INDEX chiefos_<dt>_sig_version_idx      ON ... (<doctype>_version_id);
CREATE INDEX chiefos_<dt>_sig_event_idx        ON ... (signed_event_id);
CREATE INDEX chiefos_<dt>_sig_share_token_idx  ON ... (tenant_id, share_token_id);

ALTER TABLE ... ENABLE ROW LEVEL SECURITY;
-- One RLS policy: tenant SELECT via chiefos_portal_users.
-- No INSERT/UPDATE/DELETE policies. All writes via service-role CIL handlers
-- (tight pattern per §11.0; audit-terminal table).

-- BEFORE UPDATE trigger: reject any column mutation; signatures are immutable.
```

## §11b. Cross-doc analytics view

The signatures migration ships `chiefos_all_signatures_v` with just the quote
arm; each future signature-bearing doc type's migration adds a `UNION ALL`
branch. Cross-doc-type analytics without polymorphism in the base tables.

```sql
CREATE VIEW public.chiefos_all_signatures_v AS
SELECT
  'quote'::text AS doc_kind,
  id, tenant_id, owner_id, signed_at,
  signer_name, signer_email, signed_event_id
FROM public.chiefos_quote_signatures;
-- future: UNION ALL SELECT 'change_order', ... FROM chiefos_change_order_signatures
-- future: UNION ALL SELECT 'invoice', ...      FROM chiefos_invoice_signatures
```

## §11c. Atomicity pattern for state-transitioning CIL flows (locked 2026-04-18)

The SignQuote CIL domain handler wraps three writes in a single PG transaction:

1. `INSERT INTO chiefos_quote_events (..., kind='quote.signed') RETURNING id`
2. `INSERT INTO chiefos_quote_signatures (..., signed_event_id = <event_id>)`
3. `UPDATE chiefos_quote_versions SET locked_at=now(), server_hash=<hash>, status='locked' WHERE id = <version_id>`

All three succeed or all three roll back. The `UNIQUE (quote_version_id)` on
signatures cleanly rejects retries with a handled error (409-style), not a 500.
`source_msg_id` idempotency fires a second layer of retry rejection.

**This pattern is canonical for every state-transitioning CIL flow in the
Quotes spine:** event row → domain-specific row → parent-state update. One
transaction. Any variance is a design flag.

## §12. Events table design locked (2026-04-18 — applied; see §13)

**Scope.** Quote-specific `chiefos_quote_events`. Same reasoning as §11 for
signatures: even though event *verbs* appear uniform across doc types
(`sent`, `signed`, `voided` all make structural sense on any document), the
*operational meaning* differs per doc type, and the dual-boundary composite
FK cannot target a different parent table per row without partial-firing FK
fragility. Per-doc-type tables preserve both type safety and the constitutional
FK idiom. When invoice / change-order / receipt events land, each gets a
mirror table following §12a below.

**Sequencing — events ships BEFORE signatures.** Signatures'
`signed_event_id` FK to `chiefos_quote_events(id)` is a real FK from day one,
not a forward-ref upgraded later.

**Ordering — global Postgres sequence + gaps.** `global_seq bigint NOT NULL
DEFAULT nextval('chiefos_events_global_seq')`. Contention-free (sequence
advance doesn't take transaction locks) — critical at Pro-tier crew-scale
concurrent clock-ins. Gaps from rolled-back transactions carry audit signal
and preserve naturally. Hash-chain verification works over ordering, not
density: "predecessor of event E in tenant T is the row with the next-lower
`global_seq` where `tenant_id = T`", which is well-defined under gaps.
Partitioning compatibility: global values are independent of partition key;
local indexes work per partition if we partition by tenant_id or emitted_at.

**Rejected: per-tenant `MAX(seq)+1` trigger.** Serializes concurrent inserts
on a row lock against the tenant's last event row. Visible latency at
synchronized clock-in bursts. Gap-free integers are a false benefit — they
don't make hash-chain verification easier, they just hide rollback signal.

**Scoped immutability.** `BEFORE UPDATE OR DELETE` trigger. DELETE always
rejected. UPDATE: every column rejected except `prev_event_hash` and
`triggered_by_event_id`, and those may only transition NULL→value once. No
disable-trigger/enable-trigger windows. Same column-by-column pattern as
migration 1's header-immutability trigger.

**Dual-boundary FKs — two separate composite FKs.** Because MATCH SIMPLE
skips a composite FK when ANY referencing column is NULL, a single FK on
`(quote_version_id, quote_id, tenant_id, owner_id)` would skip the
tenant/owner integrity check too when `quote_version_id IS NULL`. Splitting
into two FKs — one on `(quote_id, tenant_id, owner_id)` that always fires,
one on `(quote_version_id, tenant_id, owner_id)` that fires only when
version_id is present — preserves tenant/owner integrity on every row
regardless of scope.

**Scope enforcement.** Version-scoped kinds (16) require
`quote_version_id IS NOT NULL`; quote-scoped kinds (3) require
`quote_version_id IS NULL`. Two CHECK constraints, mutually exhaustive over
the 19-kind enum. Future kinds must be added to one of the two lists or the
scope guarantee breaks — flagged in inline SQL comments.

**Kind taxonomy — dotted `{category}.{action}` with generated `category`
column for indexing.** Single source of truth is `kind text CHECK IN (...)`.
`category text GENERATED ALWAYS AS (split_part(kind, '.', 1)) STORED`
materializes at write time for direct indexing; zero runtime cost for
analytics queries like `WHERE category = 'notification'`. Postgres 17 (Supabase
current) supports generated STORED columns natively.

**19 kinds, 4 categories.**

| # | Kind | Scope | Fires when | Inserter | Required payload / promoted FK |
|---|---|---|---|---|---|
| 1 | `lifecycle.created` | Q | Header row inserted into `chiefos_quotes` | CreateQuote CIL | — |
| 2 | `lifecycle.version_created` | V | Row inserted into `chiefos_quote_versions` (initial/edit/reissue) | CreateQuote / EditDraft / ReissueQuote | `payload.version_no`; `payload.trigger_source` ∈ ('initial','edit','reissue') |
| 3 | `lifecycle.sent` | V | Contractor sends share link | SendQuote CIL | `payload.recipient_channel`; `payload.recipient_address`; `share_token_id` |
| 4 | `lifecycle.customer_viewed` | V | Customer GETs share-token URL | Share-token GET handler (service role) | `share_token_id`; `payload.client_ip`; `payload.user_agent` |
| 5 | `lifecycle.signed` | V | Customer completes signature capture | SignQuote CIL | `signature_id`; `payload.version_hash_at_sign` (sha256) |
| 6 | `lifecycle.locked` | V | Version `locked_at` set (usually same tx as `signed`) | SignQuote CIL | — |
| 7 | `lifecycle.voided` | Q | Header status → voided | VoidQuote CIL | `payload.voided_reason` |
| 8 | `notification.queued` | V | Notification enqueued to provider | SendQuote / NotifyQuote | `payload.channel`; `payload.recipient` |
| 9 | `notification.sent` | V | Handed to provider (Postmark/Twilio) | Notification worker | above + `payload.provider_message_id` |
| 10 | `notification.delivered` | V | Provider webhook confirms delivery | Webhook handler | above + `triggered_by_event_id` (of the `sent` event) |
| 11 | `notification.opened` | V | Provider webhook confirms open | Webhook handler | above |
| 12 | `notification.bounced` | V | Recipient-side failure | Webhook handler | above + `payload.bounce_reason` |
| 13 | `notification.failed` | V | Provider-side failure | Worker / webhook | above + `payload.failure_reason` |
| 14 | `share_token.issued` | V | Token inserted into `chiefos_quote_share_tokens` | SendQuote CIL | `share_token_id` |
| 15 | `share_token.accessed` | V | Token GET succeeded (first or nth) | Share-token GET handler | `share_token_id`; `payload.access_ordinal`; `payload.client_ip`; `payload.user_agent` |
| 16 | `share_token.revoked` | V | Contractor invalidated token | RevokeShareToken CIL | `share_token_id`; `payload.revoked_reason` |
| 17 | `share_token.expired` | V | Expiry worker observed past-expiry token | Expiry cron | `share_token_id` |
| 18 | `integrity.sign_attempt_failed` | V | SignQuote rejected (expired token, hash mismatch, duplicate) | SignQuote CIL (catch path) | `payload.failure_reason`; `payload.client_ip`; `payload.user_agent` |
| 19 | `integrity.admin_corrected` | Q | Support/engineering intervention on the quote | Admin console (service role) | `payload.admin_user_id`; `payload.correction_description` |

Design notes:
- `lifecycle.reissued` is NOT a separate kind — a reissue fires
  `lifecycle.version_created` with `trigger_source='reissue'`.
- `lifecycle.viewed` is split: customer share-link views
  (`lifecycle.customer_viewed`) are audited; portal-side owner views are
  ephemeral UI telemetry and don't become events. A later migration can
  add `lifecycle.portal_viewed` if portal audit becomes a requirement.
- `share_token.accessed` fires on every GET; `payload.access_ordinal`
  disambiguates. "First access" analytics: `WHERE access_ordinal = '1'`.

**Promoted FK columns (the only references lifted out of payload).**
Principle: any stable reference to a row in a constitutional table becomes a
typed column with a real FK. Everything else goes to payload.

- `signature_id uuid` — FK to `chiefos_quote_signatures(id)` added by
  migration 3 (ALTER TABLE once target exists). Populated only on
  `lifecycle.signed` events.
- `share_token_id uuid` — FK to `chiefos_quote_share_tokens(id)` added by
  migration 4. Populated on all `share_token.*` events and on
  `lifecycle.sent` / `lifecycle.customer_viewed`.
- `triggered_by_event_id uuid` — self-FK to `chiefos_quote_events(id)` ON
  DELETE RESTRICT. Immediate FK. NULL permitted for root events and out-of-
  order webhooks (backfilled later by a worker; trigger allows NULL→value
  fill-once).
- `customer_id uuid` — FK to `customers(id)` ON DELETE RESTRICT. Populated
  where the customer is the actor (e.g. `lifecycle.customer_viewed`).

**Payload JSONB + per-kind CHECK constraints at migration time.** Structure
enforcement, not content validation. Every kind shipping gets its required-
fields CHECK now. Lazy constraints are a myth — they never get added.

**CASCADE on every FK is RESTRICT.** Audit events must never be silently
dropped by cascading a parent delete. If someone tries to delete a signature
that events reference, the delete fails — forcing the application to make
the right call (void vs. hard-delete, with audit event for the void).

**`actor_source` semantics.**

| value | When to use | Who initiates |
|---|---|---|
| `portal` | User action in the ChiefOS web portal | Authenticated portal user |
| `whatsapp` | WhatsApp command processed by webhook | Owner or employee via Twilio webhook |
| `email` | Email ingress processed by Postmark inbound | External sender via Postmark inbound |
| `system` | ChiefOS internal logic (same-transaction side effects, backend triggers) | Backend code (e.g. SignQuote atomic cascade emits `lifecycle.locked`) |
| `webhook` | Third-party delivery receipts (Postmark, Twilio) | External service |
| `cron` | Scheduled job (expiry worker, hash-chain backfill, digest runners) | Scheduler |
| `admin` | **Reserved for `integrity.admin_corrected` only.** Human support engineer running a one-off correction via admin console. | Support staff |

DB-enforced: `CHECK (actor_source <> 'admin' OR kind = 'integrity.admin_corrected')`.
A cron job that voids expired quotes is `cron`, not `admin`. A backend-
emitted locked event is `system`, not `admin`.

**No portal INSERT/UPDATE/DELETE policies.** All writes go through backend
CIL handlers under service-role auth (bypasses RLS). Portal users get
SELECT only. This closes the audit-forgery attack surface completely — a
compromised portal session cannot fabricate lifecycle transitions.

**Idempotency for webhooks.** `external_event_id text` with a partial
UNIQUE index `(owner_id, external_event_id) WHERE external_event_id IS NOT
NULL`. Internal events don't collide on the partial index. Webhook retries
from Postmark / Twilio are deduped on `(owner_id, provider_message_id)`.

**Timestamp bounds.** `emitted_at > '2024-01-01'::timestamptz` (lower bound
catches obvious garbage) and `emitted_at < created_at + interval '7 days'`
(upper bound allows clock skew, rejects far-future poison). Cheap insurance;
aligns with fail-closed ethos.

## §12a. Events table template (for all future `chiefos_<doctype>_events`)

```sql
CREATE TABLE public.chiefos_<doctype>_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_seq            bigint NOT NULL DEFAULT nextval('public.chiefos_events_global_seq'),
  tenant_id             uuid NOT NULL,
  owner_id              text NOT NULL,
  <doctype>_id          uuid NOT NULL,
  <doctype>_version_id  uuid,  -- NULL for doc-level events
  kind                  text NOT NULL CHECK (kind IN (...)),
  category              text GENERATED ALWAYS AS (split_part(kind, '.', 1)) STORED,
  signature_id          uuid,
  share_token_id        uuid,
  triggered_by_event_id uuid,
  customer_id           uuid REFERENCES public.customers(id) ON DELETE RESTRICT,
  payload               jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id         text,
  actor_source          text NOT NULL CHECK (actor_source IN ('portal','whatsapp','email','system','webhook','cron','admin')),
  correlation_id        uuid,
  external_event_id     text,
  emitted_at            timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  prev_event_hash       text,

  CONSTRAINT ... UNIQUE (global_seq),
  CONSTRAINT ... CHECK (category IN (...)),
  CONSTRAINT ... CHECK (actor_source <> 'admin' OR kind = '<doctype>.admin_corrected'),
  CONSTRAINT ... CHECK (emitted_at > '2024-01-01'::timestamptz AND emitted_at < created_at + interval '7 days'),
  CONSTRAINT ... CHECK (prev_event_hash IS NULL OR prev_event_hash ~ '^[0-9a-f]{64}$'),
  FOREIGN KEY (<doctype>_id, tenant_id, owner_id)
    REFERENCES public.chiefos_<doctype>s(id, tenant_id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (<doctype>_version_id, tenant_id, owner_id)
    REFERENCES public.chiefos_<doctype>_versions(id, tenant_id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (triggered_by_event_id)
    REFERENCES public.chiefos_<doctype>_events(id) ON DELETE RESTRICT,
  -- Per-kind scope CHECKs (version-scoped vs doc-scoped)
  -- Per-kind payload CHECKs
);

-- Partial UNIQUE for webhook idempotency
CREATE UNIQUE INDEX ... ON public.chiefos_<doctype>_events (owner_id, external_event_id)
  WHERE external_event_id IS NOT NULL;

-- Query indexes: (tenant_id, global_seq DESC), (owner_id, global_seq DESC),
-- (<doctype>_id, global_seq DESC), partial (version_id, global_seq DESC),
-- (tenant_id, category), (tenant_id, kind), (emitted_at DESC),
-- partial on promoted FKs, GIN on payload.

-- Scoped-immutability trigger (template identical to chiefos_quote_events).

-- RLS: tenant SELECT only via chiefos_portal_users. Service-role only for writes.

-- Extend chiefos_all_events_v with a UNION ALL arm for this doc type.
```

The global sequence `chiefos_events_global_seq` is SHARED across all doc
types — one sequence, all events tables pull from it, giving a
system-wide monotonic audit order if we ever need cross-doc replay.

## §12b. `chiefos_all_events_v` extension pattern

Ships with one arm (quote) in migration 2. Every future signature-bearing
doc type's migration adds a `UNION ALL` branch extending the view.

**Forward-plan: payload surface area in the cross-doc view.** The `payload`
column exposed through `chiefos_all_events_v` may contain sensitive fields
across future doc types: customer IPs, email addresses, potential PII in
signer_name, signed document hashes, provider message IDs. Current state:
payload is exposed raw; no sensitive fields shipped yet. Before the first
sensitive payload field lands in any doc-type's events, decide whether the
view should (a) omit `payload` entirely and require consumers to join back
to source tables for sensitive data, or (b) expose a computed
`redacted_payload` column that strips known-sensitive keys. Not a migration
change — a deferred decision tracked here so future-you doesn't surface
PII through the cross-doc view by accident.

## §12c. Forward plan: hash-chained audit verification

Hash-chained audit trail is a committed upgrade before public monetized
launch. `prev_event_hash text` column exists on `chiefos_quote_events` now
(NULL, no trigger populating it). A future migration will:

1. Backfill `prev_event_hash` per tenant by iterating events in
   `global_seq` order, computing SHA-256 over the previous row's canonical
   serialization, updating into the new column. (UPDATEs permitted because
   the immutability trigger allows NULL→value transitions on this column.)
2. Add a `BEFORE INSERT` trigger on `chiefos_quote_events` that computes
   `NEW.prev_event_hash` from the previous event in the same tenant
   (ordered by `global_seq`).
3. Change the immutability trigger to reject UPDATEs on `prev_event_hash`
   once populated (already the case — NULL→value is a one-time transition).
4. Ship a verification endpoint: input `(tenant_id, optional date range)`,
   output `(chain integrity verdict, position of any broken link)`. This
   is how we answer "can I trust this" to a customer, auditor, or lawyer.
5. Document the canonical serialization spec for event rows (which columns
   contribute, in what order, with what encoding). Same discipline as
   `chiefos_quote_versions.server_hash` serialization in §4.

The backfill + trigger + verifier ship together in one migration so no
tenant's chain is in a half-populated state.

## §12d. Emission vs persistence semantics

Two timestamps, deliberately independent:

| Column | Meaning |
|---|---|
| `emitted_at` | When the event semantically happened. For internal events this is `now()` at insert. For webhook events this is provided by the third party (Postmark delivery time, Twilio delivery time) and may precede our `created_at` by seconds to minutes. |
| `created_at` | When ChiefOS persisted the row. Uses `DEFAULT now()`. |

**Audit chain ordering uses `global_seq`, not `emitted_at`.** A
`notification.delivered` event for a notification sent an hour ago will have
its `emitted_at` reflecting the third-party delivery time (an hour ago) but
its `global_seq` reflecting insert order (now). Consumers asking "what's the
chronological lifecycle of this quote from the product's perspective?" join
on `global_seq`. Consumers asking "when did Postmark actually deliver this?"
read `emitted_at`. Different questions, different columns. Document this
distinction to consumers of the event stream.

## §12e. Performance thresholds to watch

Event writes are fast — global sequence advance is lockless and single
INSERTs have no read-before-write. Expected Beta volume (100 tenants × 10
quotes/week × 10 events each) is trivial.

**Metric to watch, not "monitor":** If a single tenant's events table
exceeds **5,000 rows per month** OR **10 events per second peak**, revisit:
(a) whether `chiefos_quote_events` should be partitioned (by `tenant_id`
hash, or by `emitted_at` monthly); (b) whether the GIN index on `payload`
should be swapped for targeted B-tree indexes on known hot-path keys;
(c) whether per-kind archival to cold storage is warranted for kinds that
don't participate in real-time analytics (notification opens, for instance).

Threshold trigger: add a query to the weekly digest infrastructure that
alerts when any tenant's monthly event count exceeds the threshold. Don't
wait for slowness to manifest.

## §13. Migration 2 applied (2026-04-18)

Migration `chiefos_quote_events_20260418` landed to Chief production (Supabase
project `xnmsjdummnnistzcxrtj`, version `20260418201205`).

**What landed:**
- 1 table: `chiefos_quote_events` (append-only audit stream)
- 1 global sequence: `chiefos_events_global_seq` (shared across all future
  `chiefos_<doctype>_events` tables)
- 1 view: `chiefos_all_events_v` with one arm (`'quote'`). Future doc types
  extend via `UNION ALL`.
- 1 scoped-immutability trigger: rejects DELETE and all UPDATEs except
  NULL→value fill-once on `prev_event_hash` and `triggered_by_event_id`.
- 4 foreign keys:
  - `chiefos_qe_quote_identity_fk` composite `(quote_id, tenant_id, owner_id)`
    → `chiefos_quotes(id, tenant_id, owner_id)` ON DELETE RESTRICT
  - `chiefos_qe_version_identity_fk` composite `(quote_version_id, tenant_id,
    owner_id)` → `chiefos_quote_versions(id, tenant_id, owner_id)` ON DELETE
    RESTRICT (fires only when `quote_version_id IS NOT NULL`)
  - `chiefos_qe_triggered_by_fk` self-reference `(triggered_by_event_id)` →
    `chiefos_quote_events(id)` ON DELETE RESTRICT
  - `customer_id` → `customers(id)` ON DELETE RESTRICT
- 30 check constraints (kind enum, category enum, admin-source scope,
  emitted_at bounds, hash format, owner-nonempty, version/quote scope
  partition, 11 per-kind payload structure CHECKs, plus implicit NOT NULLs)
- 16 indexes (primary key + composite unique on `global_seq` + 12 explicit
  query indexes + GIN on payload + partial unique on `(owner_id,
  external_event_id)`)
- 1 RLS policy: tenant SELECT only. No INSERT/UPDATE/DELETE policies — all
  writes go through backend CIL handlers under service-role auth.

**Deferred FK ALTERs** (columns exist with correct types; FKs added by
follow-up migrations once targets exist):
- `signature_id` → `chiefos_quote_signatures(id)` ON DELETE RESTRICT (migration 3)
- `share_token_id` → `chiefos_quote_share_tokens(id)` ON DELETE RESTRICT (migration 4)

**Verification results** (10/10 tests passed + 1 setup, 0 failed, via DO-block-
with-RAISE-EXCEPTION rollback pattern against live tenant
`86907c28-a9ea-4318-819d-5a012192119b`, job 80, owner `19053279955`):
- T1: quote-scoped event (`lifecycle.created`) with `quote_version_id NULL`
  INSERT allowed ✓
- T2: version-scoped event (`lifecycle.signed`) with `quote_version_id NULL`
  rejected by `chiefos_qe_version_scoped_kinds` CHECK ✓
- T3: `lifecycle.voided` without `payload.voided_reason` rejected by
  `chiefos_qe_payload_voided` CHECK ✓
- T4: UPDATE immutable column (`kind`) rejected by scoped-immutability
  trigger (`chiefos_quote_events.kind is immutable`) ✓
- T5: UPDATE `prev_event_hash` NULL→value allowed (fill-once) ✓
- T6: UPDATE `prev_event_hash` value→different value rejected (`can be set
  once (NULL->value); further changes forbidden`) ✓
- T7: DELETE rejected by append-only trigger ✓
- T8: cross-tenant INSERT rejected by composite FK
  (`foreign_key_violation`) ✓
- T9: self-referential `triggered_by_event_id` (event B → event A) allowed
  via immediate FK ✓
- T10: duplicate `(owner_id, external_event_id)` rejected by partial unique
  index ✓

Zero rows persisted; RAISE EXCEPTION at end of DO block rolled back all
test inserts. Confirmed post-test via `SELECT COUNT(*) = 0`.

**Preflight behaviour:** `DO $preflight$` verified `chiefos_quote_versions`
and `chiefos_portal_users` both exist before any DDL. Would have aborted
before table creation if either was missing.

**Status:** Events spine shipped. Signatures (migration 3) can now be
authored with a real `signed_event_id uuid NOT NULL REFERENCES
chiefos_quote_events(id)` FK from day one. Cross-doc `chiefos_all_events_v`
view ready for UNION extension when additional doc types ship.

## §14. Share-tokens design locked (2026-04-18 — not yet applied)

Beta Delta Appendix: single public endpoint in the system, designed as a
security-protocol problem first, DB schema second. 12 decisions across 8
design questions. Bearer-token access model with DB-authoritative state,
absolute expiry, explicit supersession cascade on version edits, and
soft-step-up identity binding via name-match.

### §14.1 — Twelve decisions, compressed

| # | Decision | Rationale capsule |
|---|---|---|
| 1 | **Opaque random token, DB-authoritative** (not JWT, not HMAC) | URL reveals nothing; DB is the source of truth; matches ChiefOS's overall posture. |
| 2 | **128-bit entropy, base58 (Bitcoin alphabet)**, 22 chars | Rate-limited endpoint + 128 bits is astronomically infeasible to brute-force. Base58 is URL-safe through lossy channels (SMS, print, phone transcription). |
| 3 | **Application-side generation** (Node `crypto.randomBytes(16)` + `bs58`) | CSPRNG primitive visible in code reviews; DB-level CHECK guards against bypass. |
| 4 | **Absolute expiry, 30-day default** (no sliding window) | Matches physical quote validity norms; bounded leak exposure; forces reconnect on stale quotes (a feature). |
| 5 | **2-hour grace on sign POST** | Covers realistic browser sessions without cookie/session infrastructure. |
| 6 | **Post-sign viewing computed at read time** (no stored `post_sign_expires_at` column) | Effective expiry: `LEAST(absolute_expires_at, signed_at + 7 days)`. One column less; policy configurable via code change. |
| 7 | **Timestamp-derived state** (no status enum): `issued_at`, `absolute_expires_at`, `revoked_at`, `superseded_at` | Timestamps carry more info than enums; can't drift out of sync with themselves. |
| 8 | **Supersession auto-fires on ANY new version insert for the same `quote_id`** | Strong consistency; no "keep the old link alive" attack surface. Implemented by the version-creating CIL in the same transaction as the INSERT. |
| 9 | **Dead-token UX = generic HTTP 404**, identical body for all dead states (superseded, revoked, expired, unknown) | Adversary can't distinguish "token exists but dead" from "token never existed". |
| 10 | **Sign on dead token = HTTP 409**, early-reject before body parse | `SELECT ... FOR UPDATE` on token row as first step; prevents large-PNG uploads from reaching the parser on dead tokens. |
| 11 | **Bearer-token posture; URL forwarding is a property, not an exploit** | Spouse-sign, advisor-review, etc. are legitimate. Identity binding is the step-up layer's job, not the token algorithm's. |
| 12 | **Soft step-up via name-match** (app-layer rule, not DB trigger) | Last-name exact compare after normalization. Mismatch captured on signature row + emitted as `integrity.name_mismatch_signed` event + alertable to contractor. No auto-action. |

### §14.2 — Schema additions to `chiefos_quote_share_tokens`

**Recipient columns on the token row** (not in a separate table, not JSONB-only):

```sql
recipient_name text NOT NULL CHECK (char_length(recipient_name) > 0),
recipient_channel text NOT NULL CHECK (recipient_channel IN ('email','whatsapp','sms')),
recipient_address text NOT NULL CHECK (char_length(recipient_address) > 0),
recipient_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

CONSTRAINT recipient_email_format CHECK (
  recipient_channel <> 'email'
  OR recipient_address ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
),
CONSTRAINT recipient_phone_format CHECK (
  recipient_channel NOT IN ('whatsapp','sms')
  OR recipient_address ~ '^\+[1-9][0-9]{6,14}$'
)
```

Snapshot discipline: `recipient_metadata` is strictly immutable post-insert
(no merge-only semantics; the row captures what was intended at the moment of
`SendQuote` and never changes). This matches the versions table's
`customer_snapshot` / `tenant_snapshot` pattern from migration 1.

### §14.3 — State machine derived from timestamps

Effective state computed at query time:

| Condition | State |
|---|---|
| `revoked_at IS NOT NULL` | `revoked` (terminal) |
| `superseded_at IS NOT NULL` | `superseded` (terminal) |
| `now() >= absolute_expires_at` | `expired` (terminal) |
| Everything else | `active` |

Terminal-exclusivity CHECK: `NOT (revoked_at IS NOT NULL AND superseded_at IS NOT NULL)`.
Fill-once via immutability trigger: `revoked_at`+`revoked_reason` move together
NULL→value once; `superseded_at`+`superseded_by_version_id` move together NULL→value
once. No further transitions.

### §14.4 — Supersession cascade

Every version-creating CIL (`CreateQuote` draft path, `EditDraft`,
`ReissueQuote`) calls, in the same transaction as the version INSERT:

```sql
UPDATE chiefos_quote_share_tokens
   SET superseded_at = now(),
       superseded_by_version_id = $new_version_id
 WHERE quote_version_id IN (
         SELECT id FROM chiefos_quote_versions WHERE quote_id = $quote_id
       )
   AND revoked_at IS NULL
   AND superseded_at IS NULL;
```

Emits `share_token.revoked` (or a future `share_token.superseded`) event per
row updated. Enforcement lives at the CIL handler layer, not as a DB trigger
— keeps behavior visible at the call site, follows the decision-log pattern
of preferring declarative CIL cascades over hidden triggers.

### §14.5 — Dead-token response UX + timing-oracle floor

Generic HTTP 404. Body: "This link is no longer active. Please contact the
sender to receive an updated link." No tenant branding, no quote ID, no
customer name, no dates, no totals. Same body for revoked / superseded /
expired / unknown.

**Audit asymmetry:** customer-facing UX is uniform; contractor audit is
specific. Known-but-dead tokens emit a `share_token.*` event with a specific
reason in the payload; unknown tokens emit nothing (no tenant to scope to).

**Timing-oracle floor (app-layer, non-optional):** every request to
`/q/{anything}` has a response-time floor of **50ms**. Enforced by wrapping
the handler in a `max(handler_time, 50ms)` delay. This prevents an attacker
from using ~1ms event-write differentials to distinguish known-but-dead
tokens from unknown tokens over the network. Below human-perceptible latency,
above network-jitter resolution. Don't remove; document the reason.

No "contact sender" form on the dead-token page — adversary-usable abuse
vector.

### §14.6 — Sign-on-dead-token response

HTTP 409 Conflict. Body:
```json
{ "ok": false, "error": { "code": "QUOTE_UPDATED", "message": "This quote has been updated since you opened it. Please contact the sender to receive the current version before signing." } }
```

The customer's browser renders the error inline on the sign page. Different
from GET's 404 because the customer has already invested action (typed name,
drew signature); a minimal acknowledgment that something didn't go through
is appropriate.

**Failed-sign event captures metadata but NOT the signature PNG.** Emit
`integrity.sign_attempt_failed` with `payload.failure_reason`
(`token_superseded` | `token_revoked` | `token_expired` | `token_unknown` |
`version_locked` | `hash_mismatch`), `payload.attempted_version_id`,
`payload.attempted_version_hash`, `payload.typed_name`, plus the standard
event envelope (IP, UA, timestamp). The PNG is deliberately NOT captured —
successful signatures persist PNGs; failed attempts do not. This asymmetry
avoids PIPEDA-exposed biometric-adjacent capture on non-customers in the
leaked-URL case.

### §14.7 — Operational parameters (Beta-starting, 60-day tuning window)

All values below are **starting opinions subject to revision** after 60 days
of production traffic. Documented explicitly so future sessions don't treat
them as architectural constants.

**Timing-oracle floor:** 50ms minimum response time on `/q/*` routes. Non-optional.

**Rate limits (two-layer, per Q6 Option 2):**
- **Vercel Edge (per-IP):** 120 req/min per IP, generous burst. Handles bulk scraper patterns at the edge before reaching the Node handler.
- **App-layer per-token (Upstash Redis, keyed by token string):**
  - GET `/q/:token`: **50 requests per hour per token**. Captures the "single URL under sustained attack" signal while accommodating legitimate customer behavior (reload, spouse review, screenshot flow).
  - POST `/q/:token/sign`: **3 requests per hour per token**. One legitimate sign + one or two retries is the expected distribution; >3 is abuse.
- **Fail response:** HTTP 429 + `Retry-After: 60`, generic body.

**Alert triggers (three signals, all Beta-starting thresholds):**

1. **Per-token hammering** — fires on `>50 GETs per hour per token` OR `>10 GETs per minute per token`. Routes to the owning contractor via email + WhatsApp. Payload: token-identifier (tenant-scoped), recent IPs, recent request shapes.

2. **Cross-token scraping** — fires on `>20 distinct tokens attempted per hour per IP` with `>80% of those returning 404`. Routes to the **ChiefOS platform operator**, NOT individual tenants (cross-tenant enumeration is platform-level signal). Payload: IP, ASN, time window, sample of attempted tokens.

3. **Terminal-state sign attempt** — fires on any `integrity.sign_attempt_failed` event with a terminal `failure_reason` (`token_revoked` / `token_superseded` / `token_expired`). Throttled: first occurrence per day per token. Routes to the owning contractor via email + WhatsApp. Payload includes the specific `failure_reason` so the action is self-describing (superseded → resend current link; revoked → alert confirms; expired → decide whether to reissue).

**Rejected alert (documented so future sessions don't revive it):** "same token accessed from 3+ distinct IPs in 1 hour" — rejected because URL sharing by customers is an explicit feature of the bearer-token model. Legitimate customers show quotes to spouses, advisors, and sounding-board contacts; the false-positive rate would exceed the true-positive rate and train the recipient to ignore the alert, killing the signal across all triggers.

**Sequencing commitment:** rate limits + 429 response + 50ms floor ship with
migration 3's app-layer handler work. Alert triggers ship as a follow-up once
there's enough production traffic to calibrate thresholds against real signal.
60-day soft deadline. Don't guess thresholds cold — revise after data.

### §14.8 — Forward-reference items (deferred to migration 4)

- **`integrity.name_mismatch_signed` event kind.** Fires from SignQuote CIL
  when `name_match_at_sign = false`. Requires extending
  `chiefos_qe_kind_enum` via ALTER TABLE DROP CONSTRAINT / ADD CONSTRAINT.
- **`chiefos_quote_signatures` schema additions** already baked into §11a's
  template: `name_match_at_sign boolean NOT NULL DEFAULT false` +
  `recipient_name_at_sign text NOT NULL CHECK (char_length > 0)`.
- **Name-match rule** implementation in TypeScript (not DB trigger) —
  specified in §11a.

### §14.9 — Explicitly rejected designs

Recording the rejections so future sessions have the analysis:

- **JWT (signed payload) tokens.** URL reveals claims to anyone who copy-pastes
  into `jwt.io`. Fingerprints the product, reveals `quote_version_id`,
  expiration, recipient hash. Rejected on product-surface grounds.
- **HMAC-signed opaque payload.** Security benefit real but not proportionate
  to operational cost at Beta (key rotation, key-ID versioning). Upgrade
  path preserved via keyed token-format prefix if threat warrants.
- **Sliding expiry.** Quote documents aren't re-engaged repeatedly; sliding
  behavior solves a workflow that doesn't exist. Also: leaked URL with
  scraper hitting once a week stays alive forever.
- **Hard step-up (one-time code via email/SMS).** Beta abandonment risk;
  spouse-sign breakage; hard-couples sign availability to external
  notification availability (Twilio/Postmark outage → sign outage).
- **Dollar-threshold tiered step-up.** Dollar thresholds are a proxy for
  fraud risk but don't track the actual risk axis (customer-contractor
  relationship freshness, customer vulnerability). Two-code-path cost high.
- **Polymorphic token UX (auto-redirect superseded → current).** Silent
  redirect makes customer mental model diverge from audit log; leaked-URL
  auto-bridge is anti-bearer-token. Not the move.
- **Per-recipient access control.** Contradicts bearer-token commitment.
  Recipient metadata is for audit, not access control.

## §15. Migration 3 applied (2026-04-18)

Migration `chiefos_quote_share_tokens_20260418` landed to Chief production
(Supabase project `xnmsjdummnnistzcxrtj`).

**What landed:**
- 1 table: `chiefos_quote_share_tokens` with recipient snapshot columns, base58
  token format CHECK, dual-boundary composite FKs, timestamp-derived state,
  terminal-exclusivity CHECK, fill-once lifecycle columns.
- 1 scoped-immutability trigger: reject DELETE; immutable columns post-insert
  including all recipient fields; `revoked_at`+`revoked_reason` and
  `superseded_at`+`superseded_by_version_id` fill-once.
- 2 composite dual-boundary FKs:
  - `chiefos_qst_version_identity_fk` `(quote_version_id, tenant_id, owner_id)`
    → `chiefos_quote_versions(id, tenant_id, owner_id)` ON DELETE RESTRICT
  - `chiefos_qst_superseded_by_identity_fk`
    `(superseded_by_version_id, tenant_id, owner_id)` →
    `chiefos_quote_versions(id, tenant_id, owner_id)` ON DELETE RESTRICT
    (MATCH SIMPLE: fires only when superseded_by_version_id is populated)
- 24 check constraints (token format, enum, 2 recipient format CHECKs, 7
  lifecycle/terminal/pair CHECKs, composite-unique, plus implicit NOT NULLs)
- 8 indexes: PK + UNIQUE on token + composite UNIQUE on identity + 4 query
  indexes + partial unique on `(owner_id, source_msg_id)`
- 1 RLS policy: tenant SELECT only; writes via service role
- Backfilled FK: `chiefos_qe_share_token_fk` on `chiefos_quote_events`
  (migration 2 forward-reference column → real FK)

**Verification results** (16/16 passed, 0 failed, via DO-block-with-RAISE-
EXCEPTION rollback pattern, live tenant `86907c28-…`, job 80, owner
`19053279955`):

| # | Test | Result |
|---|---|---|
| Setup | Insert quote + v1 scaffold | ✓ |
| T1 | Valid token with email recipient insert | allowed |
| T2 | 21-char token rejected by format CHECK | ✓ |
| T3 | `absolute_expires_at <= issued_at` rejected by `chiefos_qst_expiry_after_issue` | ✓ |
| T4 | Cross-tenant insert rejected by composite FK | ✓ |
| T5 | Duplicate `token` value rejected by UNIQUE | ✓ |
| T6 | Duplicate `(owner_id, source_msg_id)` rejected by partial unique | ✓ |
| T7 | UPDATE immutable `token` rejected by trigger | ✓ |
| T8a | UPDATE `revoked_at` NULL→value allowed (fill-once) | ✓ |
| T8b | UPDATE `revoked_at` value→different rejected by trigger | ✓ |
| T9 | Terminal exclusivity (revoked + superseded simultaneously) rejected by `chiefos_qst_terminal_exclusive` | ✓ |
| T10 | DELETE rejected by append-only trigger | ✓ |
| T11 | Missing `recipient_name` rejected by NOT NULL | ✓ |
| T12 | `recipient_channel='email'` with `recipient_address='notanemail'` rejected by email format CHECK | ✓ |
| T13 | `recipient_channel='whatsapp'` with `'5551234'` rejected by E.164 format CHECK | ✓ |
| T-BONUS | Event with nonexistent `share_token_id` rejected by backfilled FK `chiefos_qe_share_token_fk` | ✓ |

Zero rows persisted; all test inserts rolled back via intentional
`RAISE EXCEPTION` at end of DO block.

**Status:** Share-tokens spine shipped. Events table's `share_token_id` FK is
now a real FK (was forward-reference in migration 2). Migration 4
(signatures) can now be authored with the composite FK to tokens available
as a real reference from day one. The `integrity.name_mismatch_signed` event
kind ALTER (CHECK enum extension) ships with migration 4.

## §14.10. Governing principle: structural invariants vs ceremonial obligations (2026-04-18)

**Rule.** Field-level requirements on audit events (and other CIL-written
rows) live at one of two layers, chosen by the nature of the requirement:

- **Structural invariant** → DB `CHECK` constraint. Fields that any emission
  of this kind must carry regardless of which code path emitted it.
  Examples: `version_hash_at_sign` on `lifecycle.signed` (every sign event
  binds to a specific version's hash, by definition). Shipped at migration
  time, never lazily.
- **Ceremonial requirement** → CIL handler contract + decisions-log
  documentation. Fields that the current product ceremony populates, but
  which future code paths (admin corrections, future doc-type ceremonies,
  data imports) may legitimately not populate. Examples: `payload.name_match`,
  `payload.typed_name`, `payload.recipient_name_snapshot` on
  `lifecycle.signed` — these come from the customer sign ceremony; an
  admin-corrected signature row has no customer ceremony and no meaningful
  name-match.

**The test.** Ask: is this field required by the nature of this event kind,
or by the nature of the current ceremony that emits it? Structural → CHECK.
Ceremonial → CIL contract + documentation.

**Why not "always tighten at the DB layer".** DB CHECKs are near-permanent
once shipped — tightening later requires ALTER DROP/ADD and backfill
coordination. Overfitting a CHECK to one ceremony's field set blocks future
legitimate emissions that don't share the ceremony. The `lifecycle.signed`
kind is available to invoices, change orders, and receipts via the
cross-doc pattern; not every signed document has identity-verified ceremony
semantics. Keep the CHECK lean on structural invariants; let the ceremony
obligation live where it can evolve.

**Why not "everything at the CIL layer".** CIL-layer contracts are
written agreements between humans; they can be forgotten, especially across
future sessions or future doc types. Structural invariants at the DB layer
are architectural commitments that survive developer turnover.

**Applied in migration 4:** name-match fields are documented as a SignQuote
CIL handler obligation in §11a, not enforced at DB layer.

**Correction applied in migration 4b (worked-example of this principle):**
Migration 2's `chiefos_qe_payload_signed` CHECK required `signature_id IS
NOT NULL` on `lifecycle.signed` events. Migration 4 verification exposed
this as over-committed: the §11c atomicity pattern creates events FIRST and
signatures SECOND within the SignQuote transaction, so requiring
`signature_id NOT NULL` at event-insert time breaks the pattern (chicken-
and-egg: event needs signature_id; signature needs signed_event_id).
Migration 4b relaxed the CHECK to require only `payload ?
'version_hash_at_sign'` with format. `signature_id` on this kind is now
ceremonial per the test ("is this required by the kind's nature or by the
ceremony?"): the kind's nature is "a version was signed with hash X" —
carried by `payload.version_hash_at_sign`. The back-pointer to the
signature row is a convenience for reverse lookups, not a semantic
requirement; consumers who need the signature query
`chiefos_quote_signatures.signed_event_id = event.id`.

This correction is the canonical example of why the principle matters:
a field committed as "structural" in one migration can break a later
migration's atomicity pattern. When in doubt, lean ceremonial; tightening
the CHECK later is a forward-safe ALTER, relaxing it to unblock atomicity
is retroactive damage control.

## §16. Migration 4 applied (2026-04-18)

Migration `chiefos_quote_signatures_20260418` + follow-up correction
`chiefos_qe_payload_signed_relax_20260418` landed to Chief production
(Supabase project `xnmsjdummnnistzcxrtj`).

**What landed (migration 4):**
- 1 table: `chiefos_quote_signatures` (strict-immutable audit-terminal rows).
- 1 strict-immutability trigger: reject DELETE; every column rejects UPDATE.
  No fill-once columns.
- 3 composite dual-boundary FKs on signatures:
  - `chiefos_qs_version_identity_fk` → `chiefos_quote_versions`
  - `chiefos_qs_signed_event_identity_fk` → `chiefos_quote_events`
  - `chiefos_qs_share_token_identity_fk` → `chiefos_quote_share_tokens`
  All `ON DELETE RESTRICT`.
- 1 UNIQUE per version (`chiefos_qs_version_unique UNIQUE (quote_version_id)`);
  multi-party sign is future v2 work per §11.
- `UNIQUE (id, tenant_id, owner_id)` added to `chiefos_quote_events` as a
  composite-FK target for signatures → events.
- Backfilled composite FK `chiefos_qe_signature_identity_fk` on events
  (migration 2's forward-reference column → real dual-boundary FK).
- Extended `chiefos_qe_kind_enum` with `integrity.name_mismatch_signed`.
- Extended `chiefos_qe_version_scoped_kinds` CHECK to include the new kind.
- Added `chiefos_qe_payload_name_mismatch_signed` CHECK requiring
  `signature_id IS NOT NULL AND payload ? 'rule_id'` (structural minimum
  per §14.10; typed_name/recipient_name_snapshot stay ceremonial).
- RLS harmonization: dropped 4 policies from migrations 1/2 on versions and
  line_items (INSERT + UPDATE each), matching the §11.0 tight pattern.
- Created `chiefos_all_signatures_v` view (quote arm only; excludes
  `signature_png_storage_key`, `signature_png_sha256`, `source_msg_id` per
  Q-list agreed in round 3).
- 1 RLS policy on signatures: tenant SELECT only (tight pattern per §11.0).
- 6 indexes (PK, version UNIQUE, composite identity UNIQUE, 4 query + partial
  unique on source_msg_id).

**What landed (migration 4b correction):**
Relaxed `chiefos_qe_payload_signed` CHECK to remove `signature_id IS NOT NULL`
requirement on `lifecycle.signed` events. Migration 2 committed this as
structural but it conflicts with the §11c atomicity pattern (event-first,
signature-second). Per §14.10, `signature_id` is ceremonial on this kind
(the event's semantic meaning is carried by `payload.version_hash_at_sign`;
consumers find the signature via `chiefos_quote_signatures.signed_event_id`).
CHECK now requires only `payload ? 'version_hash_at_sign'` with format.
See §14.10 worked-example note.

**Verification results** (20/20 passed, 0 failed, DO-block-with-RAISE rollback):

| # | Test | Result |
|---|---|---|
| Setup | quote + v1 + token + lifecycle.signed (NULL sig_id per 4b) | ✓ |
| T1 | Valid signature insert (all composite FKs, hash formats) | allowed |
| T2 | Malformed `version_hash_at_sign` | rejected by format CHECK |
| T3 | Malformed `signature_png_sha256` | rejected by format CHECK |
| T4 | Composite FK to nonexistent `(quote_version_id, tenant, owner)` triple | rejected by FK |
| T5 | Cross-tenant covered transitively by T4 composite FK | ✓ |
| T6 | Duplicate `quote_version_id` | rejected by UNIQUE |
| T7 | UPDATE any column | rejected by strict-immutability trigger |
| T8 | DELETE | rejected by trigger |
| T9 | `chiefos_quote_versions` INSERT policy removed | confirmed via pg_policies |
| T10 | `chiefos_quote_versions` UPDATE policy removed | confirmed |
| T11 | `chiefos_quote_line_items` INSERT policy removed | confirmed |
| T12 | `chiefos_quote_line_items` UPDATE policy removed | confirmed |
| T13 | Event with nonexistent `signature_id` | rejected by backfilled FK |
| T14 | Event with real `signature_id` referencing valid signature | allowed |
| T15 | `integrity.name_mismatch_signed` accepted by extended kind_enum | ✓ |
| T16 | `integrity.name_mismatch_signed` with `quote_version_id=NULL` | rejected by version-scope CHECK |
| T17 | `integrity.name_mismatch_signed` missing `signature_id` | rejected by per-kind CHECK |
| T18 | `integrity.name_mismatch_signed` missing `payload.rule_id` | rejected by per-kind CHECK |
| T19 | `chiefos_all_signatures_v` excludes PNG refs + source_msg_id | confirmed via information_schema |

Zero rows persisted; all rolled back via `RAISE EXCEPTION`.

**Status.** Quotes spine schema foundation complete. Five migrations in sequence
(1-4 + 4b correction); every verification suite clean; no rollbacks needed.
Next work is application-layer: CIL types in `src/cil/quotes.js`, portal UI,
server PDF render on sign, Postmark wiring, plan-gating in `planCapabilities.js`.

## §17. CIL Architecture Principles (2026-04-18)

**Context.** After the Quotes spine schema foundation landed (migrations 1-4),
two CIL idioms coexist in the repo: legacy `cil.js::baseCIL` (predates
dual-boundary, no `tenant_id`, no `cil_version`, no structured actor) and
new `src/cil/schema.js::BaseCILZ` (requires `tenant_id`, `cil_version: '1.0'`,
structured `actor`, ISO `occurred_at`, E.164 phones, enumerated `source`
channels). The new idiom maps cleanly to the dual-boundary identity model
(§11.0) and the audit-chain model (§12d's `emitted_at` vs `created_at`
semantics). The legacy idiom predates those principles and is not
forward-compatible without hardening that would carry regression risk on
working code.

**§17.1 — CIL idiom forward direction.** All new CIL handlers, and all
handlers for new-spine (`chiefos_*`) tables, extend
`src/cil/schema.js::BaseCILZ`. The legacy `cil.js::baseCIL` idiom is frozen
— **no new handlers**, **no new extensions to `BaseCIL`'s shape**, **no new
schema types added to `cilSchemas`**. Existing legacy handlers continue to
function until they migrate or until `cil.js` is deleted (§17.3).

The Quote CIL types (CreateQuote, SendQuote, SignQuote, LockQuote,
VoidQuote, ReissueQuote) extend `BaseCILZ`. When input-contract discovery
for CreateQuote opens (next session), proposals start from `BaseCILZ`'s
shape (`cil_version: '1.0'`, `tenant_id`, `source`, `source_msg_id`,
`actor`, `occurred_at`, `job`, `needs_job_resolution`) and add
CreateQuote-specific fields. Not invented from scratch.

**§17.2 — Legacy migration trigger.** Any legacy handler modified for
non-trivial reasons — bug fixes, feature changes, or schema changes on the
tables it writes — migrates to `BaseCILZ` as part of the same change.
"Non-trivial" excludes typo fixes, comment changes, and log message tweaks.
The migration tax is paid per-change, not deferred to a separate session.

This rule turns the broader option ("consolidate on `BaseCILZ`; retire
legacy gradually") from aspiration into mechanism. Without §17.2, gradual
opportunistic migration becomes "never migrate" within six months —
observed pattern in every codebase with dual idioms and no enforcement.

**§17.3 — Migration tracking.** `CHIEFOS_EXECUTION_PLAN.md §1.2` contains a
CIL migration tracking sub-section that enumerates every legacy handler
still extending `cil.js::baseCIL`. The list is a **reality indicator, not a
deadline** — the point is visibility, not a schedule. When the count reaches
zero, `cil.js` is deleted and the removal is recorded as a decisions-log
event in this file.

**Seed list as of 2026-04-18 (six files, ten CIL types):**

| File | Legacy CIL types | Audit pattern |
|---|---|---|
| `domain/lead.js` | `CreateLead` | `public.audit` via `ensureNotDuplicate` + `recordAudit` |
| `domain/agreement.js` | `CreateAgreement` | `public.audit` (partially stubbed on `cil.quote_id`) |
| `domain/invoice.js` | `CreateInvoice` | TBD (verify when touched) |
| `domain/changeOrder.js` | `CreateChangeOrder` | `public.audit` |
| `domain/transactions.js` | `LogExpense`, `LogRevenue` | internal dedup in `insertTransaction` |
| `domain/pricing.js` | `AddPricingItem`, `UpdatePricingItem`, `DeletePricingItem` | `ON CONFLICT DO NOTHING` |

Retired (not counted): `domain/quote.js` (stub, throws `NOT_IMPLEMENTED`).
Orphan (not dispatched through `cilRouter.js`): `domain/receipt.js`.

**§17.4 — Handler registry location.** `src/cil/router.js` maintains its own
handler registry for new-idiom types, importing handlers from `src/cil/*.js`
(e.g., `src/cil/quotes.js` exports `CreateQuote`, `SendQuote`, etc.). Legacy
handlers remain imported by `services/cilRouter.js` from `domain/*.js` until
legacy retirement. When a legacy handler migrates per §17.2, its import
moves from `services/cilRouter.js` to `src/cil/router.js` in the same
change. **New Quote handlers live exclusively in `src/cil/quotes.js`, never
in `domain/quote.js`.** The stubbed `domain/quote.js` (throws
`NOT_IMPLEMENTED`) stays as a retirement marker until `cil.js` is deleted;
at that point `domain/quote.js` is deleted in the same PR.

**§17.5 — Facade delegation pattern.** `src/cil/router.js::applyCIL` is the
single public entry point. It validates new-idiom payloads directly via
`BaseCILZ.extend(...)` and dispatches to handlers in its own registry. For
legacy types, it delegates to `services/cilRouter.js::applyCIL` via a
**runtime `require`** (NOT a top-of-file import). This laziness is
load-bearing — it avoids module-load-time circularity if legacy routes ever
import anything from `src/cil/`, and it isolates legacy as a delegate
rather than a dependency. Future sessions must not "helpfully" convert
this to a top-of-file import. Pattern:

```js
// src/cil/router.js
const NEW_IDIOM_TYPES = new Set(['CreateQuote','SendQuote',/* ... */]);

async function applyCIL(rawCil, ctx) {
  // ... shared ctx normalization ...

  if (NEW_IDIOM_TYPES.has(rawCil.type)) {
    return dispatchNewHandler(rawCil, ctx);
  }

  // Legacy delegation — runtime require, not top-of-file import.
  // This laziness is load-bearing (see §17.5). Do not lift.
  const legacyRouter = require('../../services/cilRouter');
  return legacyRouter.applyCIL(rawCil, ctx);
}
```

When §17.3 fires (legacy-handler count hits zero, `cil.js` deleted), this
facade loses its delegation branch in the same PR. `services/cilRouter.js`
is deleted. Mechanical, testable, low-risk retirement path.

**§17.6 — Unknown-type error shape.** Both the facade and the legacy
router, when `cil.type` matches no registered handler, return the standard
error envelope from the Engineering Constitution §9 — consistent across
both idioms so upstream callers handle one error shape:

```js
{
  ok: false,
  error: {
    code: 'CIL_TYPE_UNKNOWN',
    message: `No handler registered for type '${cil.type}'`,
    hint: 'Verify the CIL type name; check src/cil/router.js registrations',
    traceId: ctx.traceId,
  }
}
```

Applied at both routers. Legacy router gets this shape in the same change
that adds the facade (small ALTER to the existing error path).

**§17.7 — Caller migration is one mechanical pass, not gradual.** Existing
callers of `services/cilRouter` (currently: `routes/webhook.js`,
`services/orchestrator.js`, any portal API that calls CIL) update their
`require('../services/cilRouter')` → `require('../src/cil/router')` in a
**single pre-CreateQuote session task**, tested together. From that point,
both idioms flow through the new facade; the facade delegates legacy
types internally. Gradual migration of caller imports is forbidden — it
reintroduces the "which router does this caller use?" fragmentation that
§17.1's whole point was to eliminate. Document the migration as an
explicit task in the pre-CreateQuote handoff.

**§17.8 — Dedup mechanism for new-idiom handlers.** Entity-table
`(owner_id, source_msg_id) UNIQUE` is the canonical CIL-retry dedup
mechanism for new-idiom handlers. **No writes to `public.audit` from any
new-idiom handler.** The audit chain lives in
`chiefos_<doctype>_events`, not in a flat operation log. Legacy handlers
continue writing to `public.audit` until they migrate per §17.2.

**Two distinct dedup surfaces — do not conflate.** The new spine has two
dedup concepts that use different columns and different constraints:

| Surface | Column | Purpose | Who inserts |
|---|---|---|---|
| **CIL-retry dedup** | `source_msg_id` on root entities (`chiefos_quotes`, `chiefos_quote_share_tokens`, `chiefos_quote_signatures`) | Dedupes repeated CIL invocations from the same originating message (WhatsApp SID, portal idempotency key) | CIL handlers inside their root-entity INSERT |
| **Webhook-retry dedup** | `external_event_id` on `chiefos_quote_events` | Dedupes webhook retries from third parties (Postmark delivery confirmations re-sent, Twilio SID re-delivery) | Webhook handlers inserting status-update events |

Events rows emitted by CIL handlers (e.g., `lifecycle.created` during
CreateQuote) do NOT dedup at the event layer. They are part of the root
transaction's atomicity; if the root entity's `source_msg_id` UNIQUE
catches the retry, the whole transaction rolls back and no event is
inserted.

**§17.9 — Optimistic-insert dedup pattern.** New-idiom handlers do NOT
perform pre-transaction dedup SELECT queries. The handler opens its
transaction (via `withClient` from `services/postgres.js`), attempts the
canonical first write (typically the root entity's INSERT), and catches
`unique_violation` on `(owner_id, source_msg_id)`. On catch, the handler
returns an idempotent success response with `already_existed: true` and
looks up the existing entity's id to return alongside. The lookup
`SELECT id FROM <table> WHERE owner_id = $1 AND source_msg_id = $2` runs
after the rolled-back INSERT attempt, outside the failed transaction, to
find the prior row.

**Why INSERT-and-catch over SELECT-then-INSERT.** One round-trip vs two;
no time-of-check-to-time-of-use race between the SELECT and the INSERT
(which can happen under concurrent retries); aligns with Postgres
idiomatic use of unique constraints as the source of truth.

**§17.10 — Constraint-name classification.** When `unique_violation`
(SQLSTATE `23505`) fires inside a CIL transaction, the handler inspects
`err.constraint` (Postgres returns the violated constraint's name) to
classify the cause:

- Constraint name matches the expected `source_msg_id` dedup constraint →
  idempotent retry, return existing entity with `already_existed: true`.
- Any other `unique_violation` → genuine integrity error (human_id
  collision, FK target collision via composite UNIQUE, etc.) → rethrow
  with standard error envelope.

Implement a shared helper at `src/cil/utils.js` that encapsulates the
classification, so handlers don't re-implement the switch and drift on
behavior:

```js
// src/cil/utils.js
function classifyUniqueViolation(err, { expectedSourceMsgConstraint }) {
  if (err.code !== '23505') return { kind: 'not_unique_violation' };
  if (err.constraint === expectedSourceMsgConstraint) {
    return { kind: 'idempotent_retry' };
  }
  return { kind: 'integrity_error', constraint: err.constraint };
}
```

Handlers pass the exact expected constraint name (e.g.,
`'chiefos_quotes_source_msg_unique'` for CreateQuote,
`'chiefos_qst_source_msg_unique'` for SendQuote). Exact-match API;
tolerates the current naming inconsistency (the `chiefos_quotes` table's
constraint name uses the full form `chiefos_quotes_*` while other
tables use the abbreviation `chiefos_<abbrev>_*` — handler passes whatever
string its target table uses; no regex required).

**§17.10 clarification (2026-04-20) — idempotent_retry returns current
entity state, not original-call state.** When `classifyUniqueViolation`
returns `idempotent_retry`, the handler's post-rollback lookup reads
the entity's **current** state and returns it as the retry response.
For CreateQuote specifically, the quote entity is populated from
`chiefos_quotes` joined to `chiefos_quote_versions` via
`current_version_id` (not via `version_no = 1`).

Three alternatives considered and rejected:

- **"Return v1 specifically"** (strict original-call semantics via
  `WHERE version_no = 1`). Rejected because rows mutate: after
  `SignQuote` or `ReissueQuote`, v1's state at retry-time differs
  from v1's state at original-call-time. The strict-semantics
  premise is unachievable under mutable schema — even this option
  would return a stale, mutated view, not the response bytes of the
  original call. The strictness is a mirage.

- **"Error on stale retry"** (new `CIL_IDEMPOTENT_RETRY_STALE` code
  when the quote has been edited post-creation). Rejected because
  transport retries — the 95% case, a client that lost the original
  response — genuinely don't care about v1 vs v2; they care about
  "did my write land." Forcing every retrying caller to handle a
  new error case they'd treat as "try again later" is friction
  without matching value.

- **"Return v1, but error if mutated past v1"** hybrid. Rejected as
  over-engineered combination of the first two.

Option (a) — current state — aligns with §17.15's committed
`meta.already_existed` semantic: "the handler's canonical first write
caught a unique_violation on `(owner_id, source_msg_id)`; the entity
exists; here is its current renderable state." Input-equivalence is
explicitly not checked; by the same logic, version-equivalence isn't
a guarantee either. Callers needing v1 specifically use a detail
endpoint with `?version=1` — outside CreateQuote's contract.

**This clarification applies to every new-idiom handler's
idempotent_retry path, not just CreateQuote.**

**§17.10 clarification 2 (2026-04-20) — classifier renamed and
extended to handle semantic errors.** The shared helper in
`src/cil/utils.js` is renamed from `classifyUniqueViolation` to
`classifyCilError` to reflect broader scope: it now classifies both
DB-level (Postgres 23505) and semantic (application-level) errors in
a single switch.

A new `CilIntegrityError` class is exported from `src/cil/utils.js`.
Handlers throw this from within a transaction to surface a semantic
integrity condition (e.g., customer UUID not found in tenant, job UUID
doesn't belong to owner) that should render as a clean CIL envelope
rather than a 500-class failure.

```js
class CilIntegrityError extends Error {
  constructor({ code, message, hint } = {}) {
    super(message || 'CIL integrity error');
    this.name = 'CilIntegrityError';
    this.code = code;
    this.hint = hint || null;
  }
}
```

The classifier's return shape expands to four kinds:

- `{ kind: 'semantic_error', error }` — `err instanceof
  CilIntegrityError`. Caller composes envelope from `error.code`,
  `error.message`, `error.hint`. The rendered envelope **code** is
  `CIL_INTEGRITY_ERROR` per §17.18; the `CilIntegrityError.code` is
  operator-facing diagnosis surfaced in `hint`.
- `{ kind: 'idempotent_retry' }` — unchanged from prior contract.
- `{ kind: 'integrity_error', constraint }` — unchanged.
- `{ kind: 'not_unique_violation' }` — unchanged; caller rethrows.

**Instanceof check precedence**. The classifier checks
`err instanceof CilIntegrityError` **first**, before the Postgres
`23505` branch. A `CilIntegrityError` does not have `err.code =
'23505'` (it has our own `code` string); without this ordering it
would fall through to `not_unique_violation`, which is not the
handler's intent. Documented in the function's implementation order.

**Rejected alternative: sentinel property on plain Error.** An earlier
sketch used `err._cil_code = 'X'` and checked `err._cil_code` in the
outer catch. Rejected because JavaScript's lack of type enforcement
means every section that might throw has to remember to set the
property; misses don't surface until runtime 500s, and over 5+
handlers this accumulates. The typed `CilIntegrityError` class makes
semantic throws impossible without a code — contract over
convention.

**Internal code vs. envelope code layering (per §17.18).**
`CilIntegrityError.code` is operator-facing (specific, e.g.
`CUSTOMER_NOT_FOUND_OR_CROSS_TENANT`) — useful in logs and for
diagnostic tooling. The envelope `code` rendered to external callers
is `CIL_INTEGRITY_ERROR` (the §17.18 CIL_-prefixed category code).
The specific condition goes in the envelope's `hint`. Callers don't
need to branch on every possible semantic error; operators do.

**Outer catch contract** (single switch over four kinds):

```js
const c = classifyCilError(err, { expectedSourceMsgConstraint });
if (c.kind === 'semantic_error') {
  return errEnvelope({
    code: 'CIL_INTEGRITY_ERROR',
    message: c.error.message,
    hint: c.error.hint,
    traceId: ctx.traceId,
  });
}
if (c.kind === 'idempotent_retry') { /* post-rollback lookup ... */ }
if (c.kind === 'integrity_error') {
  return errEnvelope({
    code: 'CIL_INTEGRITY_ERROR',
    message: `Unique constraint violation on ${c.constraint}`,
    hint: 'Verify tenant/owner FK consistency',
    traceId: ctx.traceId,
  });
}
throw err;  // not_unique_violation — rethrow
```

**§17.11 — Dedup scope.** The dedup check scopes to `(owner_id,
source_msg_id)`, NOT `(tenant_id, source_msg_id)`. Reasoning:
`source_msg_id` originates from ingestion identity — WhatsApp Message
SID, email `Message-ID`, portal request nonce — which maps to `owner_id`
in the dual-boundary model (ingestion boundary). Retries from the same
`source_msg_id` always represent the same intent by the same owner.
`tenant_id` doesn't add classification value at the dedup layer; it's
carried on the row for RLS / audit, but not for idempotency.

All four root-entity constraints currently use `(owner_id, source_msg_id)`
— verified 2026-04-18 by direct query:

- `chiefos_quotes.chiefos_quotes_source_msg_unique` — non-partial `UNIQUE (owner_id, source_msg_id)`
- `chiefos_quote_share_tokens.chiefos_qst_source_msg_unique` — partial `WHERE source_msg_id IS NOT NULL`
- `chiefos_quote_signatures.chiefos_qs_source_msg_unique` — partial `WHERE source_msg_id IS NOT NULL`

Events uses a different column (`external_event_id`) for a distinct
webhook-dedup surface per §17.8.

**§17.12 — Handler registration pattern.** New-idiom CIL handlers are
registered in `src/cil/router.js` via a **static, `Object.freeze`-sealed
handler map** that explicitly imports each handler at the top of the file.
**No runtime registration API exists.** Handler files export pure functions
with no module-load side effects.

Adding a new handler requires two explicit steps:
  (a) write the handler function in its module (e.g., `src/cil/quotes.js`
      exports `handleCreateQuote`);
  (b) add the import and map entry in `src/cil/router.js`.

When step (b) is forgotten, the facade falls through to legacy and returns
`CIL_TYPE_UNKNOWN` on first call — loud, immediate, no silent drop. The
missing router.js diff is the audit trail; code review catches the
omission.

Rejected alternatives:
- **Side-effect registration at handler module load.** Handler file calls
  `registerNewIdiomHandler(...)` at load; router requires each file to
  trigger the side effect. Fails silently when the router-level `require`
  is forgotten; complicates testing (must load the handler module to
  trigger registration); breaks symmetry with the legacy router (which is
  explicit-map).
- **Glob-require auto-discovery.** Router enumerates `src/cil/*.js` and
  requires each. Opaque failure modes (bug in a handler file prevents
  registration silently; infrastructure files accidentally loaded as
  handlers; test files slip through exclude-lists); tooling overhead
  without payoff at current scale (6 handlers). Reconsider only at
  50+ handlers, if ever.

This pattern is the canonical new-idiom router-handler interface for the
lifetime of the facade. §17.3 retirement of legacy `cil.js` does not
change this decision — the facade's explicit map remains after legacy
delegation is removed; the same Object.frozen shape persists.

Tightening committed in the implementation:
- `NEW_IDIOM_HANDLERS` is `Object.freeze({...})` — runtime mutation
  attempts raise (or silently fail, depending on strict mode). Future
  sessions cannot add handlers by mutating the object.
- The scaffolding's `registerNewIdiomHandler` function is removed from
  `src/cil/router.js`. Keeping the registration mechanism and this
  principle mutually exclusive — the map IS the API.

**§17.12 committed 2026-04-18. Scaffolding in commit d87c59b9 used runtime
registration; that approach was reversed in the following commit per this
principle.**

**§17.13 — Sequential-ID strategy for new-idiom entities.** Financial and
contractual doc types (quotes, invoices, change orders, receipts, future
equivalents) use **per-tenant** sequential counters stored in
`chiefos_tenant_counters` with a `counter_kind` discriminator. Allocation
via UPSERT idiom (RETURNING allocated number), concurrency-safe without
advisory locks. Human-readable IDs follow `<PREFIX>-YYYY-MMDD-NNNN` format
where NNNN is the per-tenant per-kind sequence.

Operational entities (jobs, tasks, time entries, future equivalents) retain
**per-owner** counters via the existing `allocateNextJobNo` pattern. The
asymmetry is intentional: financial documents are company-level
identifiers ("Mission Exteriors has issued 119 quotes" — the story a
customer, accountant, or auditor sees); operational entities are
individual-owner identifiers that don't need tenant-level aggregation.

Rejected alternatives:
- **Per-owner scope for financial documents.** Fragments the company-level
  numbering story when multi-owner tenants become real. A customer
  referencing "quote 119" by phone should get the same quote regardless of
  which owner they spoke to.
- **Separate isolated counter tables per doc type.** Structural
  inconsistency without purpose. Two counter tables with identical
  semantics.
- **Random slug IDs.** Abandons product-useful signal in the sequence
  (activity volume, issuance date, customer-recallable reference).

**Future counter additions.** To add a new per-tenant per-kind counter
after Migration 5 ships: no schema change required. Insert a row template
`(tenant_id, counter_kind, next_no=1)` and consume via the shared UPSERT
allocation function (spec in §18). The generic shape is the point.

**§17.13 committed 2026-04-18.**

**§17.14 — Canonical INSERT sequence for version-creating handlers.** All
handlers that insert new `chiefos_quote_versions` rows (CreateQuote,
EditDraft, ReissueQuote, any future equivalent) follow the
**NULL-then-UPDATE pointer pattern**:

1. **(CreateQuote only)** INSERT header (`chiefos_quotes`) with
   `current_version_id = NULL`.
2. **INSERT new version row** (`chiefos_quote_versions`). Composite FK to
   `chiefos_quotes` validates immediately; parent row exists.
3. **INSERT line items** (`chiefos_quote_line_items`). Parent-lock trigger
   is inert because new version is draft (`locked_at IS NULL`).
4. **UPDATE header** (`chiefos_quotes`) to `SET current_version_id =
   <new_version_id>`. Header immutability trigger permits
   `current_version_id` changes.
5. **INSERT audit events** (`chiefos_quote_events`) for
   `lifecycle.created` (CreateQuote only) and `lifecycle.version_created`
   (all three handlers). Payloads per §14.10 structural requirements.

All statements execute within a single transaction via `withClient`. Any
failure triggers full rollback at the transaction boundary. No orphan
rows possible at any point.

Rejected alternative: **pre-generate UUIDs and rely on `DEFERRABLE` FK on
`current_version_id`.** Rejected because (a) it ties the handler pattern
to a schema exception that exists solely for this purpose, (b) the
`DEFERRABLE` modifier becomes dead weight once handlers use
NULL-then-UPDATE, and (c) it creates structural asymmetry between
CreateQuote (no UPDATE) and EditDraft/ReissueQuote (UPDATE required).

**§17.14 committed 2026-04-18.**

**§17.14 addendum (2026-04-19) — one helper per event kind.** Event
emission helpers are defined per-kind, not generic. Each kind has
distinct DB CHECK requirements (payload keys, scope constraints), and
generic helpers grow into conditional blocks as handlers add kinds.
Specific helpers enforce scope at the call site (quote-scoped-kind
helpers never accept `versionId`) and bind payload shape to the kind.
Naming convention: `emit<EventKind>` matching the event kind in
PascalCase — e.g., `emitLifecycleCreated`, `emitLifecycleVersionCreated`,
`emitLifecycleSent`, `emitLifecycleSigned`.

Scaling argument: with 5+ event kinds per handler family (Quote's
lifecycle.created, sent, customer_viewed, signed, locked, voided) plus
notification and share_token kinds, a generic `insertQuoteEvent` would
carry `if (kind === 'X') check Y` conditionals for every
per-kind payload CHECK. Specific helpers keep each handler's
emission surface small, type-bound, and reviewable.

**§17.14 correlation_id clarification (2026-04-19).** The
`chiefos_quote_events.correlation_id` column chains causally-related
events (e.g., `lifecycle.signed` correlates to the `lifecycle.sent`
that preceded it) — not CIL trace_ids. Overloading it with
`ctx.traceId` conflates two unrelated concepts. CreateQuote's events
have no upstream event cause; handlers pass NULL. The CIL trace_id
lives in the return envelope's `meta.traceId` per §17.15.

**§17.15 — Return shape for new-idiom handlers.** All new-idiom CIL
handlers return a success envelope with the shape:

```js
{
  ok: true,
  <entity_key>: { /* entity fields */ },
  [<entity_key_2>: { ... }],             // multi-entity handlers (SignQuote, SendQuote)
  meta: {
    already_existed: boolean,
    events_emitted: string[],
    traceId: string,
  }
}
```

Each top-level `<entity_key>` is the canonical entity name (singular,
lowercase) the handler affected — e.g. `quote`, `signature`,
`share_token`. Handlers surface one or more entities based on what was
mutated. Entity objects carry enough fields for the portal to render a
result card without a follow-up query and for the next handler in a
workflow chain to accept the entity as input.

`meta` is the single well-known object carrying operation-level
metadata — parallel in position to `error` on the failure side.

**Why this shape — axis analysis:**

1. **Transport separation.** Handler returns typed data; WhatsApp /
   portal / worker transports compose presentation. Handler never
   pre-composes summary strings. A contractor-facing phrasing change
   in one transport never touches the handler.
2. **Portal render.** Entity carries enough for a result card
   without re-query.
3. **§9 symmetry.** `{ok:false, error:{code,message,hint,traceId}}`
   pairs cleanly with `{ok:true, <entity>:{...}, meta:{...}}`. Both
   success and failure have one well-known sub-object (`error` vs.
   `meta`) carrying operation metadata, with `traceId` in the same
   relative position on both sides.
4. **Idempotent retry.** `meta.already_existed` has a clean home that
   doesn't pollute the entity. See semantics below.
5. **Composability.** Multi-entity handlers (SignQuote: quote +
   signature; SendQuote: quote + share_token) add sibling entity keys;
   `meta` stays one key. No prefix-namespace explosion.
6. **Testing.** Entity assertions separate from operation-metadata
   assertions. `expect(r.quote.id)` vs. `expect(r.meta.already_existed)`
   — tests read clearly.

**Rejected alternatives:**
- **Flat summary with handler-composed string** (legacy shape).
  Couples handler to one transport's phrasing; portal must re-query;
  multi-entity handlers degenerate into prefix-namespacing
  (`signature_id`, `quote_id`, `share_token_id` at top level).
- **Rich nested entity without `meta`.** Forces operation metadata
  (`events_emitted`, `already_existed`) into top-level siblings of
  entities, muddling "what was affected" vs. "how the operation went."

**`meta.traceId` is always a string, never null.** Every CIL
invocation carries a traceId per Constitution §9. If `ctx.traceId` is
missing at handler entry, that is an upstream bug worth surfacing —
handler returns a `TRACE_ID_MISSING` error envelope before any other
logic runs. The type of `meta.traceId` is `string`, not `string |
null`; silently tolerating null would hide the upstream defect.

**Idempotent-retry semantics (`meta.already_existed`).** The flag
means: "the handler's canonical first write caught a
`unique_violation` on `(owner_id, source_msg_id)` and we returned the
prior entity via §17.9's optimistic-insert-and-catch pattern."

**It does NOT mean: "the current input payload matches the prior
input."**

If a caller retries with a matching `source_msg_id` but semantically
different input (different customer, different line items), the
handler still returns the prior entity with `already_existed: true`.
The retry is honored at the source_msg_id granularity; payload
equivalence is not checked. Future handlers and future debug sessions
must not misread the flag as "the input matches the prior."

If stricter semantics are ever needed ("error if retry payload
differs from prior"), that is a new field or a distinct code path —
not a redefinition of this flag. The contract committed here is
source_msg_id-granular idempotency.

**Per-handler entity inventory (preliminary; each handler confirms
when it lands):**

| Handler | Entity keys returned |
|---|---|
| CreateQuote | `quote` |
| SendQuote | `quote`, `share_token` |
| SignQuote | `quote`, `signature` |
| LockQuote | `quote` |
| VoidQuote | `quote` |
| ReissueQuote | `quote` (with new `version_id`) |

Fields beyond what the result-card + chain-to-next-handler use cases
need (full line items, full snapshots, server_hash) are reachable via
a detail endpoint, not returned on write.

**§17.15 committed 2026-04-19.** Family-wide contract for every
new-idiom Quote-spine handler and every future doc-type handler
family.

**§17.16 — Plan gating for new-idiom handlers.** All new-idiom CIL
handlers subject to plan gating resolve plan and monthly usage via the
shared `gateNewIdiomHandler(ctx, checkFn, kindLiteral)` helper in
`src/cil/utils.js`. Handlers do not resolve plan directly and do not
trust a pre-resolved `ctx.plan` field. The helper centralizes plan
resolution, usage lookup, and denial envelope composition so every
gated handler produces an identical denial envelope shape.

Gating runs **after** BaseCILZ schema validation and **before** the
§17.14 transaction opens. Failure returns the denial envelope directly;
no DB writes, no events emitted.

Counter increment happens **after** successful transaction commit, not
before. Rationale: (a) rolled-back transactions don't burn counter,
(b) idempotent retries catch at `classifyUniqueViolation` before counter
call, (c) matches established pattern in `services/answerChief.js`.

Legacy caller-resolves pattern (e.g., `handlers/media.js:1225`) remains
for legacy handlers. This principle governs new-idiom only. Legacy
handlers migrate to this pattern only if §17.2 trigger fires on them for
other reasons.

Tightening committed in the implementation:
- `errEnvelope` is also exported from `src/cil/utils.js` (moved from
  `src/cil/router.js`). Single source of truth for the §9 shape across
  the facade and every gated handler.
- `resolvePlanForOwner(ownerId)` in utils.js is the canonical plan
  resolver for new-idiom handlers: queries `public.users(plan_key,
  sub_status)` and runs the row through `getEffectivePlanKey` so
  entitlement status (active/trialing) is honored. Fail-closed — any
  lookup failure resolves to `'free'` per CLAUDE.md.
- `gateNewIdiomHandler` accepts optional dependency overrides
  (`deps.resolvePlan`, `deps.getMonthlyUsage`) for unit testing. Live
  callers never pass deps; tests do.

**§17.16 committed 2026-04-19.** (§17.15 reserved for the return-shape
decision landing in C6 this same session.)

**§17.17 — Actor role gating at handler level.** Role-based access
restrictions (owner-only reasoning, employee-only capture, board-only
approval, etc.) are enforced in handler logic, not in the CIL schema.
Schema validates payload shape; handler validates semantic constraints
(role, plan entitlement, business-state preconditions). These two
concerns — "is this payload structurally valid" vs. "is this actor
allowed to perform this action" — are distinct and should not be
conflated in a single validation surface.

**Canonical pre-transaction validation sequence for gated new-idiom
handlers:**

1. **Schema validation** via Zod (e.g. `CreateQuoteCILZ.safeParse`).
   Failure → `CIL_SCHEMA_INVALID` envelope.
2. **Plan gating** via `gateNewIdiomHandler` per §17.16. Failure →
   plan-specific envelope (`QUOTES_REQUIRES_STARTER`,
   `QUOTES_CAPACITY_REACHED`, etc.).
3. **Actor role check** per this principle. Failure →
   `PERMISSION_DENIED` envelope with a hint describing the required
   role.
4. **Transaction** per §17.14 (version-creating handlers) or
   handler-specific pattern.

Each failure short-circuits the sequence and returns the standard
Constitution §9 envelope via the shared `errEnvelope` in
`src/cil/utils.js`. No DB writes occur before step 4 passes.

Why runtime check, not schema refinement: `.refine((payload) =>
payload.actor.role === 'owner')` couples shape validation to semantic
authorization. A caller submitting a technically-valid payload with
`actor.role: 'employee'` gets a schema error ("actor.role must be
owner"), which is a misleading framing — the *shape* was valid, the
*action* was not authorized. `PERMISSION_DENIED` is the honest code.

**§17.17 committed 2026-04-19.** Pairs with §17.16 to define the full
pre-transaction validation sequence for gated new-idiom handlers.

**§17.17 addendum (2026-04-20) — handler reads actor from validated CIL
payload, not from ctx.** The handler reads `actor.role` (and any other
actor sub-fields) from the Zod-parsed CIL payload (`parsed.actor.role`),
not from a duplicated `ctx.actor` field. Payload-layer fields are
validated at the schema step and consumed from the parsed result. `ctx`
carries infrastructure state only (traceId, request-scoped metadata).
Do not lift payload fields into ctx — it creates two sources of truth
and invites drift. Applies to every new-idiom handler, not just
CreateQuote.

**§17.17 addendum 3 (2026-04-19) — unified not-found-or-wrong-scope
errors.** Lookups against tenant-scoped or owner-scoped identifiers
return identical errors for "does not exist" and "exists but belongs
to a different scope." No information disclosure about which
identifiers exist across scopes. Specific internal code describes the
condition; envelope code stays `CIL_INTEGRITY_ERROR`; hint conveys
the combined condition. Same principle as share-token 404
unification (§14).

Applied in CreateQuote:

- Branch A customer lookup (§20 Q1): unified
  `CUSTOMER_NOT_FOUND_OR_CROSS_TENANT` for Section 1's
  customer_id-by-tenant query.
- Branch A job lookup (§20 Q2): unified
  `JOB_NOT_FOUND_OR_CROSS_OWNER` for Section 2's
  job_id-by-owner query.

Principle applies to every future handler doing tenant- or
owner-scoped lookups. Probing for "does this ID exist in my scope?"
is not a permitted observational path.

**§17.17 addendum 2 (2026-04-20) — required ctx preflight before Zod
validation.** New-idiom handlers preflight required `ctx` fields
before Zod validation. Missing `ctx.owner_id` returns
`OWNER_ID_MISSING`; missing `ctx.traceId` returns `TRACE_ID_MISSING`.
Both indicate upstream resolution bugs; surfacing as explicit error
envelopes fails loud rather than degrading silently. Preflight runs
**before** Zod validation because schema-validation error envelopes
reference `ctx.traceId` — without traceId, the schema-failure envelope
would carry `traceId: null`, masking the upstream bug. Locks the
pattern for SendQuote and the four handlers after.

**§17.18 — Error code naming convention for new-idiom handlers.**
SCREAMING_SNAKE_CASE throughout. Three prefix categories:

- **CIL-layer enforcement uses `CIL_` prefix**: `CIL_PAYLOAD_INVALID`,
  `CIL_TYPE_MISSING`, `CIL_TYPE_UNKNOWN`, `CIL_SCHEMA_INVALID`,
  `CIL_INTEGRITY_ERROR`. These codes fire at schema validation, router
  dispatch, or DB-integrity boundaries — all CIL-layer concerns.

- **Capability enforcement uses capability-name prefix**:
  `QUOTES_REQUIRES_STARTER`, `QUOTES_CAPACITY_REACHED`,
  `OCR_REQUIRES_STARTER`, etc. The prefix names the feature surface
  being gated. Populated by `gateNewIdiomHandler` via
  `planMessages.js`.

- **Runtime semantic checks use condition name directly** (no prefix):
  `PERMISSION_DENIED`, `OWNER_ID_MISSING`, `TRACE_ID_MISSING`. These
  are cross-cutting conditions that aren't feature-specific.

Future sessions proposing a new error code: pick the category first,
then name. No `CHIEFOS_` prefix (that's a table namespace, not an
error taxonomy). No mixed cases.

**§17.18 committed 2026-04-20.**

---

## §18. Migration 5 — counter table restructure (APPLIED 2026-04-20)

**Status.** Applied to live Supabase 2026-04-20. 10/10 SQL verification
tests passed. T12 `bumpTenantCounterToMax` correctness fix verified.
Service code commit `94516acb` ready to push; push pending user action
per session policy. Pre-CreateQuote dependency satisfied.

**Scope.** Generalize `chiefos_tenant_counters` from its single-purpose
shape (`tenant_id`, `next_activity_log_no`, `updated_at`) to per-tenant
per-kind shape serving quotes, invoices, change orders, receipts, and
future doc-type counters per §17.13.

### Applied schema

Before:
```
tenant_id uuid NOT NULL (PK)
next_activity_log_no int NOT NULL DEFAULT 1
updated_at timestamptz NOT NULL DEFAULT now()
```

After:
```
tenant_id uuid NOT NULL
counter_kind text NOT NULL           -- no default; format CHECK'd
next_no int NOT NULL DEFAULT 1        -- renamed from next_activity_log_no
updated_at timestamptz NOT NULL DEFAULT now()
PRIMARY KEY (tenant_id, counter_kind)
FK tenant_id → chiefos_tenants(id) ON DELETE CASCADE
CHECK counter_kind ~ '^[a-z][a-z_]*$' AND char_length(counter_kind) BETWEEN 1 AND 64
```

### §18.1 — Backfill strategy (applied: DEFAULT-then-DROP-DEFAULT)

Chose Option (a) `DEFAULT-then-DROP-DEFAULT`. DEFAULT `'activity_log'`
during ADD COLUMN is a migration-step race-defense convenience; DROP
DEFAULT immediately after is the principle-enforcing step (future
INSERTs without explicit `counter_kind` fail loud). Table was empty at
discovery and at apply time — no actual backfill needed, but the
DEFAULT pathway was preserved for safety against any race window.

Rejected: explicit UPDATE (same outcome, more verbose), NOT NULL
DEFAULT forever (silent coercion is the exact failure mode Migration 5
exists to prevent).

### §18.2 — In-flight allocation safety (applied: no special handling)

Empty table at discovery and apply time; no historical production
allocations. ALTER TABLE's implicit `ACCESS EXCLUSIVE` covers the
theoretical concurrent-allocation case via standard Postgres MVCC; no
explicit `LOCK TABLE` needed, no deploy window required.

Service-deploy ordering handled via Option A (coordinated push):
migration applies first, service code push immediately after. Brief
failure window (~2-5 min during Vercel deploy) acceptable on a surface
with zero historical traffic. Worst-case observable outcome: one
server-log error on a `createCrewActivityLog` submission during the
window; self-resolves on the next submission.

**No crew activity log failures observed during the actual apply
window (zero crew activity logs exist in production — confirmed via
`chiefos_activity_logs` row count = 0).**

### §18.3 — PK transition (applied: single ALTER TABLE, atomic)

Composite PK `DROP CONSTRAINT + ADD CONSTRAINT` executed atomically in
one `ALTER TABLE` statement. Backing index auto-managed. FK from
`chiefos_tenant_counters.tenant_id → chiefos_tenants(id)` survived
unchanged (FK only cares about `tenant_id` column existence, not PK
shape). No inbound FKs to the table (confirmed during discovery). No
secondary indexes to rebuild (only the PK-backing index, which the
constraint transition auto-replaces).

Composite PK index serves legacy `WHERE tenant_id = $1` queries via
btree leading-column prefix — no performance regression for the
updated `allocateNextDocCounter('activity_log')` path.

**Step-order dependency:** Step 3 (PK) must follow Step 1 (ADD COLUMN
counter_kind); Step 2 (RENAME) can happen in either order relative to
Step 1. Not a style preference — a real dependency.

### §18.4 — Function update approach (applied: Option B direct migration)

Deleted `allocateNextActivityLogNo` entirely. Added generic
`allocateNextDocCounter(tenantId, counterKind, client)` as the single
allocator for every counter_kind. One live caller updated:
`services/crewControl.js:166` now calls
`pg.allocateNextDocCounter(tid, COUNTER_KINDS.ACTIVITY_LOG, client)`.

Decisive reason: §17.12 consistency. Per-kind wrapper functions are the
side-channel convenience layer that §17.12 was written to prevent. With
5+ future counter kinds, uniform explicit-at-call-site treatment is the
pattern to establish now.

**`COUNTER_KINDS` constant added at `src/cil/counterKinds.js`**
(Object.freeze'd; parallels §17.12's frozen-map pattern). Source of
truth for allowed `counter_kind` values app-side. DB-layer format CHECK
enforces shape only, not the product-concept whitelist.

**`bumpTenantCounterToMax` correctness fix (required, not cosmetic).**
Under the new composite PK, `WHERE c.tenant_id = $1::uuid` alone matches
every counter row for the tenant. Without the `AND c.counter_kind =
'activity_log'` predicate added in this commit, `bumpTenantCounterToMax`
would smash the quote/invoice/etc. counter rows for the tenant with the
activity_log max. Fix applied at `services/crewControl.js:53-54`.

### §18.5 — MCP parse-time limitation (discovered at apply)

**New finding worth documenting for future schema migrations on this
infrastructure.**

Both `apply_migration` and `execute_sql` MCP tools do parse-time column
resolution across statement boundaries. The following forms **failed**
when submitted as a single SQL blob:

- `ALTER TABLE ... ADD COLUMN counter_kind ..., ALTER COLUMN counter_kind DROP DEFAULT` (single ALTER with combined sub-clauses referencing the newly-added column)
- Multi-statement SQL where later `ALTER TABLE ... ADD CONSTRAINT ... PRIMARY KEY (tenant_id, counter_kind)` references a column added in an earlier `ALTER TABLE ... ADD COLUMN` within the same submitted blob

Both failed with `42703: column "counter_kind" ... does not exist` at
parse time, even though standard Postgres transactional DDL supports
this pattern (ADD COLUMN is visible to subsequent statements in the
same transaction).

**Workaround applied for Migration 5:** split the DDL into 7 discrete
`execute_sql` calls, each fully resolving against the committed schema
state. Atomic per-statement, not atomic across statements.

**Risk accepted:** table had zero rows at apply time, so no partial-
state data corruption was possible. Each individual ALTER was
independently valid; if any mid-sequence step had failed, manual
rollback of prior completed ALTERs would have been trivial against an
empty table.

**Implication for future migrations on this infrastructure:** migrations
that add a column AND reference it in the same SQL blob must either
(a) split into multiple `execute_sql` calls with verification between,
or (b) explore alternative tooling (direct psql via `supabase db push`
from CLI, for example). Prior migrations 1–4 did not hit this because
they created fresh tables rather than referencing newly-added columns
on existing tables.

The source-of-truth SQL file at
`migrations/2026_04_20_chiefos_tenant_counters_generalize.sql`
retains the combined-form SQL with `BEGIN/COMMIT` wrapper — it's
correct Postgres and would apply cleanly against a psql-compatible
tooling chain. The split form was purely an MCP workaround.

### Verification

**10/10 SQL tests passed (T1-T10)** via execute_sql with
`BEGIN; DO ...; ROLLBACK;` pattern:
- T1: post-migration schema shape correct
- T2: sequential allocation 1, 2, 3 via UPSERT pattern
- T3: independent sequences per counter_kind (same tenant)
- T4: same-session sequential allocation (covered by T2)
- T5: composite PK rejects duplicate (tenant_id, counter_kind)
- T6: CHECK rejects empty string
- T7: CHECK rejects Capitalized / trailing-space / digit-leading
- T8: CHECK accepts all 5 canonical COUNTER_KINDS values
  (activity_log, quote, invoice, change_order, receipt)
- T9: NOT NULL enforced; DEFAULT dropped (explicit NULL and omitted
  counter_kind both fail)
- T10: cross-tenant isolation (tenant A's allocations don't affect
  tenant B's)

**T12 PASSED.** `bumpTenantCounterToMax` correctness-fix SQL pattern
verified: inserted counter rows with `activity_log` + `quote` kinds
for one tenant, ran the fixed UPDATE with `AND c.counter_kind =
'activity_log'` predicate, confirmed only the activity_log row
changed; quote row's `next_no` stayed at 10.

**T11 pending post-deploy:** runtime check that
`allocateNextActivityLogNo` is no longer exported from
`services/postgres.js`. Run after Vercel deploys commit `94516acb`:
```
node -e "const pg = require('./services/postgres'); if (pg.allocateNextActivityLogNo !== undefined) process.exit(1); console.log('T11 PASSED');"
```

### Discovered bug in initial test data (for transparency)

First verification run failed at T2 because my test kind names
(`test_t2`, `test_t3`, `test_t10`) contained digits, which the format
CHECK correctly rejects. This was a bug in the test data, not the
constraint. Re-run with compliant names (`test_alpha`, `test_beta`,
`test_gamma`) passed cleanly. The CHECK's rejection of digits in kind
names is correct behavior and is now documented as part of the
whitelist rationale.

**§18 completed 2026-04-20.** Pre-CreateQuote dependency satisfied.
Next session: CreateQuote handler code in `src/cil/quotes.js` per
§20 input contract, §19/§17.16 plan gating, §17.15 return shape,
§17.17 actor gating, §17.14 write sequence, §17.12 handler
registration.

## §19. Plan gating for CreateQuote — adaptation of canUseOCR pattern (2026-04-19)

**Decision.** CreateQuote plan gating mirrors the `canUseOCR` pattern
structurally. New capability block `quotes: { enabled, monthly_capacity,
behavior }` at the top level of each tier (sibling to `capture`, `reasoning`
— not nested, because quotes are document-lifecycle not capture). New
function `canCreateQuote(plan, usedQuotesThisMonth)` in `checkCapability.js`.
Denial codes `QUOTES_REQUIRES_STARTER` and `QUOTES_CAPACITY_REACHED` in
`planMessages.js`. Counter `kind='quote_created'` on `usage_monthly_v2`,
incremented **after** successful transaction commit (§17.16).

**Tier table.**

| Plan | Enabled | Monthly capacity |
|---|---|---|
| free | ❌ | 0 |
| starter | ✅ | 50 |
| pro | ✅ | 500 |

**Starter capacity reasoning (50/mo).** Quotes are low-volume effortful
creation (typical contractor 5–15/mo, busy 30–50/mo), unlike OCR high-
volume reactive capture. 50/mo aligns with voice-minutes Starter (the
other effortful-creation activity on the plan). 10× Pro scaling matches
voice (50→500). Upgrade pressure triggers at commercial-sales-team scale
where tooling needs genuinely diverge (multi-estimator workflows, shared
templates). Rejected: 30 (matches OCR — wrong volume class), 25
(independent round number — no principled justification).

**Counter-kind literal (`'quote_created'`).** Singular, past tense.
Rationale: matches the per-event counting semantic (each increment
corresponds to one `lifecycle.created` emission in
`chiefos_quote_events`). Existing v2 kinds are inconsistent
(`ask_chief_questions` plural, `ocr_receipts_count` count-suffix,
`voice_minutes` unit-of-measure) so no established convention to match —
setting new-idiom convention here.

**Denial copy choices.**
- `QUOTES_REQUIRES_STARTER` carves out the unaffected Free-tier surface
  ("you can still log jobs, time, and expenses") so Free users don't
  feel globally blocked.
- `QUOTES_CAPACITY_REACHED` explicitly notes existing quotes stay
  visible/signable so mid-pipeline quotes don't feel orphaned when the
  monthly limit trips.

**Counter-increment timing.** After successful transaction commit, not
before. See §17.16 for full rationale.

**Call site.** Via `gateNewIdiomHandler(ctx, canCreateQuote,
'quote_created')` per §17.16. Gating runs after BaseCILZ schema
validation and before the §17.14 transaction opens.

**§19 committed 2026-04-19.**

## §20. CreateQuote input contract — Zod schema decisions (2026-04-19)

Six open design questions from the reading pass, locked. Schema lives
in `src/cil/quotes.js` (lands with handler code next session). Extends
BaseCILZ from `src/cil/schema.js`.

### Q1 — Customer identity: either/or, no auto-match

Caller supplies `customer_id` (UUID) **OR** inline fields
(`{name, email, phone_e164, address}`). Handler resolution:
- `customer_id` present → link; validate it exists in tenant.
- Only inline → INSERT new `public.customers` row with inline fields,
  then link the new id.

**CreateQuote never performs automatic customer deduplication.** Inline-
only input always creates a new customer row. Explicit `customer_id`
input is the only path to linking existing customers. Silent name/email/
phone matching is wrong at this surface: a wrong match silently binds
the quote to the wrong historical customer, and the contractor has no
visibility into the match. Dedup of near-duplicate customers is a
separate explicit flow (future `MergeCustomer` CIL, or a portal
"similar customers exist" warning at entry time).

### Q2 — Job linkage: required JobRef, resolved in-transaction

Matches DB (`chiefos_quotes.job_id integer NOT NULL`). Uses BaseCILZ's
existing `JobRefZ` (`job_id` or `job_name` + optional
`create_if_missing`). CreateQuote extends BaseCILZ and **overrides**
`job` to non-nullable (BaseCILZ declares it `JobRefZ.nullable()`;
quotes tighten to non-null).

**Transaction boundary.** If `create_if_missing: true` resolves to
"create," job creation happens **inside CreateQuote's §17.14
transaction**, not as a separate CIL call. Orphan job rows are
prevented by transaction rollback at any §17.14 step failure.

Autoresolution from customer's open jobs is a transport-layer concern
(WhatsApp intent interpreter), not CIL-layer.

### Q3 — Line items: minimum 1 at create

Schema enforces `.min(1)`. Empty-shell quotes forbidden: semantically
broken (total=0) and create orphan-cleanup burden. Multi-step flows
(portal form, WhatsApp draft state) assemble line items at the
transport layer and submit one complete CreateQuote. EditDraft handles
post-create iteration.

### Q4 — Project info: title required, scope optional

Matches DB (`project_title NOT NULL`, `project_scope` nullable). No
defaults — caller is explicit. Title is NOT defaulted to job name:
internal job names and customer-facing project titles are distinct
concepts that should not be collapsed.

### Q5 — Tax: caller supplies rate, handler computes totals

**Totals are server-computed, not caller-supplied.** The CIL input
contract carries `tax_rate_bps` (basis points) + optional `tax_code`
(e.g., `'HST-ON'`) at the header, `unit_price_cents` + `qty` + optional
per-line `tax_code` on line items. `subtotal_cents`, `tax_cents`,
`total_cents`, `line_subtotal_cents`, `line_tax_cents` are **not in
the input schema** — the handler computes them. DB `total = subtotal +
tax` CHECK is always satisfied by construction. Client-trust on money
is eliminated.

**Override on default behavior: `tax_rate_bps` has no default.** The
original proposal set `default(0)`. Rejected because "no default" is
the safer posture:
- An Ontario contractor submitting a CreateQuote without explicit
  tax rate would silently produce a zero-HST quote; the contractor
  might not catch this until the customer questions missing HST on
  the invoice. That's a revenue leak.
- Hardcoding a locale default in the CIL layer is wrong — ChiefOS is
  not Ontario-specific.
- Tenant-profile-resolved default is the right long-term answer but
  requires the tenant-settings table to ship first (rejected for this
  round to avoid coupling).

**Schema shape:** `tax_rate_bps: z.number().int().nonnegative()` with
no `.default()`. Every CreateQuote must supply it explicitly. Caller
(WhatsApp transport or portal form) supplies the rate — for Mission
Exteriors today the caller hardcodes `1300` (13% HST ON); for future
US contractors the caller supplies per-state rates. When tenant
settings ship, the caller reads tenant default and supplies it.

### Q6 — Payment terms: caller-supplied at create

Caller sends `deposit_cents` + `payment_terms` JSONB. No tenant-profile
coupling. Portal form pre-fills from tenant profile client-side; user
can override; handler trusts the resolved values. Matches §17.16
caller-brings-resolved-context idiom.

**Rendering-layer note.** `payment_terms: {}` (empty object, the
default) is a valid CIL input state. The customer-facing rendering
must handle "no payment terms specified" gracefully — empty sections,
not runtime errors, not missing-field warnings on the customer's page.

### Snapshots: split by who knows the content

- **`customer_snapshot`** — handler-computed from customer input (and
  existing customer row if `customer_id` given). **Not in input schema.**
- **`tenant_snapshot`** — handler-computed from tenant row. **Not in
  input schema.** Avoids caller duplication + drift risk.
- **`warranty_snapshot`, `clauses_snapshot`** — caller-supplied inline
  structured JSONB per §6. Default `{}`. Mission Exteriors populates
  from config at the caller layer today; future tenants supply their
  own content; template-resolved content lands when template
  management ships.
- **`warranty_template_ref`, `clauses_template_ref`** — optional text
  pointers for future template backref (soft reference, no FK).

**Snapshot shapes are contractual, not arbitrary JSONB.**
`customer_snapshot` and `tenant_snapshot` — handler-computed — still
validate against defined Zod schemas before persistence. Leaving them
as `z.record(z.any())` would let silent shape drift into signed quote
payloads, which is incompatible with the canonical-serialization
server-hash guarantee in §4.

```js
// Defined alongside CreateQuoteCILZ in src/cil/quotes.js
const TenantSnapshotZ = z.object({
  legal_name: z.string(),
  brand_name: z.string().optional(),
  address: z.string(),
  phone_e164: PhoneE164Z.optional(),
  email: z.string().email().optional(),
  web: z.string().optional(),
  hst_registration: z.string().optional(),
});

const CustomerSnapshotZ = z.object({
  name: z.string(),
  email: z.string().email().optional(),
  phone_e164: PhoneE164Z.optional(),
  address: z.string().optional(),
});
```

`catalog_snapshot` on line items keeps `z.record(z.any()).optional()`
for now — the supplier-catalog integration schema is not yet locked.
When Gentek/Kaycan integration ships, migrate `catalog_snapshot` to a
typed Zod schema matching the catalog spine. Flagged as temporary
looseness.

`warranty_snapshot` and `clauses_snapshot` remain
`z.record(z.any()).default({})` — these are genuinely flexible
structured content today. Reconsider shape lock when template
management ships.

### Actor gating

CreateQuote restricts to `actor.role === 'owner'`. Enforcement is in
handler logic per §17.17, not in schema `.refine()`. Runs after plan
gating (§17.16) and before the §17.14 transaction opens. Non-owner
callers receive `PERMISSION_DENIED` envelope with hint "Ask the owner
to create quotes."

### Canonical Zod schema (reference)

```js
// src/cil/quotes.js (lands with handler code in next session)
const { z } = require('zod');
const {
  BaseCILZ, JobRefZ, UUIDZ, CurrencyZ, PhoneE164Z,
} = require('./schema');

const CustomerInputZ = z.object({
  customer_id: UUIDZ.optional(),
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone_e164: PhoneE164Z.optional(),
  address: z.string().optional(),
}).refine(
  (c) => !!c.customer_id || !!c.name,
  'customer must include customer_id or name'
);

const LineItemInputZ = z.object({
  sort_order: z.number().int().nonnegative().default(0),
  description: z.string().min(1),
  category: z.enum(['labour', 'materials', 'other']).optional(),
  qty: z.number().positive().default(1),
  unit_price_cents: z.number().int().nonnegative(),
  tax_code: z.string().min(1).optional(),        // per-line override; null inherits header
  catalog_product_id: UUIDZ.optional(),
  catalog_snapshot: z.record(z.any()).optional(),// temporary: tighten when catalog ships
});

const CreateQuoteCILZ = BaseCILZ.extend({
  type: z.literal('CreateQuote'),

  job: JobRefZ,                                  // override BaseCILZ nullable → required

  customer: CustomerInputZ,

  project: z.object({
    title: z.string().min(1),
    scope: z.string().optional(),
  }),

  currency: CurrencyZ.default('CAD'),
  tax_rate_bps: z.number().int().nonnegative(),  // NO default — must be explicit (§20 Q5)
  tax_code: z.string().min(1).optional(),

  line_items: z.array(LineItemInputZ).min(1, 'CreateQuote requires at least one line item'),

  deposit_cents: z.number().int().nonnegative().default(0),
  payment_terms: z.record(z.any()).default({}),

  warranty_snapshot: z.record(z.any()).default({}),
  clauses_snapshot: z.record(z.any()).default({}),
  warranty_template_ref: z.string().min(1).optional(),
  clauses_template_ref: z.string().min(1).optional(),
});

// Handler-computed output schemas (validated before persistence).
const TenantSnapshotZ = z.object({
  legal_name: z.string(),
  brand_name: z.string().optional(),
  address: z.string(),
  phone_e164: PhoneE164Z.optional(),
  email: z.string().email().optional(),
  web: z.string().optional(),
  hst_registration: z.string().optional(),
});

const CustomerSnapshotZ = z.object({
  name: z.string(),
  email: z.string().email().optional(),
  phone_e164: PhoneE164Z.optional(),
  address: z.string().optional(),
});
```

**Fields intentionally absent from the input:** `subtotal_cents`,
`tax_cents`, `total_cents`, `line_subtotal_cents`, `line_tax_cents`,
`human_id`, `customer_snapshot`, `tenant_snapshot`, `version_no`,
`issued_at`, `server_hash`. All handler-computed or handler-allocated.

**§20 committed 2026-04-19.** Schema file `src/cil/quotes.js` lands
with handler code in the next session (post-Migration 5).

**§20 addendum (2026-04-20) — source enum narrowed for CreateQuote.**
`CreateQuoteCILZ.source` is narrowed to `z.enum(['whatsapp', 'web'])`.
BaseCILZ's wider `SourceZ = z.enum(['whatsapp','upload','web'])` remains
for capture-oriented CIL types (Expense, Payment) where `upload` is
meaningful (e.g., receipt OCR from uploaded image). `upload` has no
natural target in quote authoring — rejected at the schema layer rather
than silently coerced to a quote source column value. `email`-initiated
quote creation is a future path that will require a coordinated
extension of BaseCILZ.SourceZ. No-silent-coercion posture per the
Engineering Constitution's fail-closed rule.

**§20 addendum (2026-04-20) — CreateQuote overrides JobRef with
integer-typed job_id.** BaseCILZ's `JobRefZ.job_id: UUIDZ.optional()`
is inconsistent with `public.jobs.id` which is `integer`
(sequence-backed, non-UUID). `chiefos_quotes.job_id integer REFERENCES
public.jobs(id)` also uses integer. The BaseCILZ-wide UUID declaration
is a pre-existing latent bug — existing callers (Expense, Payment) work
around it by passing `job_name` only. For CreateQuote the schema is
narrowed to match reality:

```js
const CreateQuoteJobRefZ = z.object({
  job_id: z.number().int().positive().optional(),
  job_name: z.string().min(1).optional(),
  create_if_missing: z.boolean().optional(),
}).refine((j) => !!j.job_id || !!j.job_name, 'JobRef must include job_id or job_name')
  .refine((j) => (j.create_if_missing ? !!j.job_name : true), 'create_if_missing requires job_name');

CreateQuoteCILZ.extend({ job: CreateQuoteJobRefZ, ... })
```

Broader fix (normalizing BaseCILZ's `JobRefZ.job_id` to integer or an
accept-either union) is a coordinated change affecting Expense and
Payment handlers — out of scope here. Parked as a known issue for the
session that touches those handlers (per §17.2 non-trivial-change
trigger). When that session lands, delete the CreateQuote-specific
`CreateQuoteJobRefZ` and use the corrected BaseCILZ `JobRefZ`.

**§20 addendum (2026-04-19) — tenant_snapshot source.** `TenantSnapshotZ`
is populated from `src/config/tenantProfiles.js`, a frozen lookup by
tenant_id. Bootstrap pattern until a tenant-profile DB table ships.
When DB-backed source is built, the handler's `composeTenantSnapshot`
function swaps the config-file read for a DB query returning the same
`TenantSnapshotZ` shape. Contract stable; source is detail.

Missing profiles surface as `CIL_INTEGRITY_ERROR` envelope with
`TENANT_PROFILE_MISSING` internal code — fails closed rather than
producing an empty snapshot. Rationale: snapshots are immutable per §6;
a version created with an empty `tenant_snapshot` locks permanently
with no branding and cannot be backfilled when the tenant-profile data
later exists. Better to refuse the quote than ship an unfillable
placeholder.

Rejected alternative: soften `TenantSnapshotZ` to all-optional fields
and permit empty `{}` snapshots. Rejected because it trades immediate
quote-creation for permanent historical-record degradation. The
config-file bootstrap accepts a small per-tenant onboarding cost
(adding an entry to `TENANT_PROFILES`) in exchange for snapshot
durability.

Rejected alternative: hardcode single-tenant branding inline in the
handler. Rejected because it embeds tenant identity into shared source
code. The config file is no cleaner than hardcoding for one tenant,
but scales trivially as tenants onboard and provides a clean
swap-for-DB migration path.

**§20 addendum (2026-04-20) — create_if_missing jobs do not set
source_msg_id.** CreateQuote's inline find-or-create job path inserts
a new job row without a `source_msg_id` value (leaves it NULL). Job-
layer idempotency via `jobs_owner_source_msg_uidx` is not exercised by
this handler. Idempotency for CreateQuote retries happens at the
**quote** layer via `chiefos_quotes_source_msg_unique (owner_id,
source_msg_id)` and §17.10 classifier — the retry's job find-step
returns the existing job by `(owner_id, lower(job_name))` match before
reaching create-if-missing. No orphan job rows possible: if the quote
INSERT rolls back, the job INSERT in the same transaction rolls back
with it.

## Next entries (to be added as decisions land)
- §21. Template table schema (when tenant template editor is designed)
- §22. Cross-quote pointer enforcement (the 4-column composite FK, if needed)
