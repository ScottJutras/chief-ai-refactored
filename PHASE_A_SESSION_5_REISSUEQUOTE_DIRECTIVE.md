# Phase A Session 5 — ReissueQuote — Implementation Directive

**Authority:** Project Instructions v4.0 (Tier 6), Execution Playbook v4.0 (Tier 3), Engineering Constitution v4.0 (Tier 1), CLAUDE.md, `docs/QUOTES_SPINE_DECISIONS.md` §3A / §14.4 / §17.8–§17.11 / §17.20 / §17.23 / §17.26 (reservation), `docs/PHASE_A_SESSION_3_LOCKQUOTE_HANDOFF.md`.
**Anchored at commit:** 662d0347 (Phase A surface unchanged from f4b54fe4 / Session 4 close).
**Closes:** Phase A.
**Unblocks:** PHASE_A5_INVESTIGATION.md GATED marker → Slice 1 (Session 6) and Slice 2 (Session 7).

---

## 1. Role of this session

Implement `handleReissueQuote` per the contract documented across `docs/QUOTES_SPINE_DECISIONS.md`. Make it the seventh and final Phase A Quote-spine CIL handler. Wire it into the router. Produce §32 ceremony. Re-run close verification.

**Do not** implement A.5 surfaces in this session. They are Sessions 6–7.

---

## 2. Pre-flight reference (load only what each step needs)

Targeted reads, not full files (per CLAUDE.md context budget):

| Need | Source | Lines |
|---|---|---|
| Prior session pattern (handler shape, ordering discipline) | `src/cil/quotes.js` — VoidQuote sections | §1: ~4600-4935 (schema, loader, primitive, emitter); §2: ~4937-5120 (handler + composers) |
| Decisions log §17.8–§17.11 (dedup) | `docs/QUOTES_SPINE_DECISIONS.md` | ~1910-2230 |
| Decisions log §17.20 (pre-BEGIN external write for strict-immutable INSERT) | `docs/QUOTES_SPINE_DECISIONS.md` | ~4115-4170 |
| Decisions log §14.4 (supersession UPDATE pattern) | `docs/QUOTES_SPINE_DECISIONS.md` | ~1440-1605 |
| ReissueQuote caveat + §17.26 reservation | `docs/QUOTES_SPINE_DECISIONS.md` | 4365-4372 |
| Schema (chiefos_quotes header + versions) | `migrations/2026_04_18_chiefos_quotes_spine.sql` | 70-160 (header), 200-340 (versions + immutability triggers) |
| Lifecycle event taxonomy | `docs/QUOTES_SPINE_DECISIONS.md` | ~1080-1100 (`lifecycle.version_created` row) |
| Session 3 handoff (closure ceremony pattern) | `docs/PHASE_A_SESSION_3_LOCKQUOTE_HANDOFF.md` | full |

**Do not** load FOUNDATION_CURRENT.md, REBUILD_MIGRATION_MANIFEST.md, archived sessions, or the full QUOTES_SPINE_DECISIONS.md file. Targeted reads only.

---

## 3. ReissueQuote contract (synthesized from decisions log)

### 3.1 Behavioral contract

ReissueQuote takes a **voided** quote and creates a **new draft version** on the same `chiefos_quotes` header. The prior signed/locked/voided versions remain immutable. The newly inserted version becomes `chiefos_quotes.current_version_id`. The prior `current_version_id` (now superseded) gets `superseded_at = $now` and `superseded_by_version_id = $new_version_id` set atomically with the new INSERT.

State precondition: **prior `chiefos_quotes.status = 'voided'`** (§3A). Reissuing a non-voided quote is illegal — handler returns `ILLEGAL_STATE` with a hint pointing the caller to VoidQuote first (mirror the pattern at `quotes.test.js:2927` where LockQuote on non-draft hints at ReissueQuote).

State postcondition: `chiefos_quotes.status = 'draft'` (back to the start of the lifecycle for the new version). The header is mutated; the prior version row is mutated only on its supersession pointer columns; the new version row is freshly INSERTed.

### 3.2 Immutability invariants (preserved)

- Prior signed `chiefos_quote_versions` rows: untouched except for `superseded_at` + `superseded_by_version_id` fill-once columns (§14.4).
- Prior `chiefos_quote_signatures` rows: untouched.
- Prior `chiefos_quote_share_tokens` rows: untouched (share token created during the original SendQuote flow continues to point at the now-superseded version; it is not invalidated by Reissue per §14.4 — the share token row's `superseded_at`/`superseded_by_version_id` move with the version).
- New version inherits `version_no = prior_version_no + 1`; never reuses a prior `version_no`.

### 3.3 Idempotency strategy (Session 5 schema decision required)

`chiefos_quote_versions` does not currently carry `source_msg_id` — only the header (`chiefos_quotes`) does, and the header is not re-created by Reissue. Three options:

| Option | Mechanism | Tradeoff |
|---|---|---|
| **A (recommended)** | Add `source_msg_id text` column + partial UNIQUE `(owner_id, source_msg_id) WHERE source_msg_id IS NOT NULL` to `chiefos_quote_versions`. Handler does §17.8 `lookupPrior*` at entry; UNIQUE-violation on INSERT triggers retry-replay. | Matches §17.8 entity-table dedup; adds one column + one index. Migration is additive, idempotent, reversible. |
| B | Use `chiefos_quote_events.external_event_id` UNIQUE per `(owner_id, kind)`; handler reads back resulting version_id from event row on replay. | Splits dedup state across two tables; complicates retry path; rejected. |
| C | Hash-derived dedup (no source_msg_id): `(owner_id, parent_version_id, hash_of_inputs)` UNIQUE. | Loses caller-supplied dedup-key semantics; user-confusing on intentional same-input reissue; rejected. |

**Recommendation: Option A.** New migration `migrations/2026_04_25_chiefos_quote_versions_source_msg_id.sql`:

```sql
ALTER TABLE public.chiefos_quote_versions
  ADD COLUMN IF NOT EXISTS source_msg_id text;

CREATE UNIQUE INDEX IF NOT EXISTS chiefos_quote_versions_source_msg_unique
  ON public.chiefos_quote_versions (owner_id, source_msg_id)
  WHERE source_msg_id IS NOT NULL;

-- Immutability: source_msg_id is fill-once (set on INSERT, never UPDATE)
CREATE OR REPLACE FUNCTION chiefos_quote_versions_source_msg_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_msg_id IS DISTINCT FROM OLD.source_msg_id THEN
    RAISE EXCEPTION 'chiefos_quote_versions.source_msg_id is immutable';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS chiefos_quote_versions_source_msg_immutable
  ON public.chiefos_quote_versions;
CREATE TRIGGER chiefos_quote_versions_source_msg_immutable
  BEFORE UPDATE ON public.chiefos_quote_versions
  FOR EACH ROW EXECUTE FUNCTION chiefos_quote_versions_source_msg_immutable();
```

CreateQuote's existing version INSERT path should backfill `source_msg_id` (passing through the header's `source_msg_id`) in the same PR — symmetry for replay safety on the initial-version case. Confirm this isn't already happening via grep before authoring; if it is, no CreateQuote change needed.

### 3.4 §17.20 applicability check

§17.20 (pre-BEGIN external write for strict-immutable INSERT) is the Session 5 governing pattern if Reissue triggers any external-system write that must not roll back (e.g., emitting a webhook notification, generating a PDF artifact). **Default expectation: no §17.20 trigger for ReissueQuote** — the new version is just a draft; nothing externally observable is published until the owner runs SendQuote again on the new version. Confirm during implementation; if an external write is introduced, follow §17.20 ordering.

### 3.5 §17.26 sub-amendment trigger criteria

Per the §17.23 caveat at decisions-log line 4365-4372: if supersession-specific behavior (`superseded_at` / `superseded_by_version_id` write semantics) does NOT cleanly fit the `loadCtx → mutation → re-read` discipline of §17.23, **draft a §17.26 sub-amendment in `docs/QUOTES_SPINE_DECISIONS.md`**. Do not force-fit. Specifically watch for:

- Race conditions between the new INSERT and the prior-version supersession UPDATE (FK `chiefos_qst_superseded_by_identity_fk` MATCH SIMPLE means the FK fires only when the column is populated — confirm txn ordering)
- Replay safety when Reissue retries against an already-reissued quote (the new version exists; the prior version's supersession columns are populated; what does the load-context reader return?)

If §17.26 is needed, author it during this session before the handler ships. The investigation note (§5 of this directive) already documents the §17.26 reservation. Do not skip past it.

---

## 4. CIL handler signature + Zod schema

### 4.1 `ReissueQuoteCILZ` (in `src/cil/quotes.js`, alongside other CIL schemas)

```js
const ReissueQuoteCILZ = BaseCILZ
  .extend({
    type: z.literal('ReissueQuote'),
    source: z.enum(['portal', 'whatsapp', 'system']),  // Phase A.5 widening parity
    quote_ref: z.object({
      quote_id: z.string().uuid(),
    }).strict(),
    // No reissue-specific payload fields. Reissue carries the prior quote's
    // version content forward by default; line-item edits live in EditDraft
    // (separate handler, future phase). If founder wants line-item edits at
    // Reissue time, that is a separate feature decision — flag it during
    // implementation and do NOT silently extend.
  })
  .strict();
```

### 4.2 `handleReissueQuote(rawCil, ctx)` signature

Mirrors `handleVoidQuote` shape:

```js
async function handleReissueQuote(rawCil, ctx) {
  // Step 1: Zod validation (ReissueQuoteCILZ.safeParse) → INVALID_INPUT envelope
  // Step 2: §17.8 lookupPrior — query chiefos_quote_versions WHERE owner_id=$1 AND source_msg_id=$2
  //         If found: return reissuedReturnShape (replay-safe early exit)
  // Step 3: loadReissueContext (pre-txn) — see §5 below
  //         CilIntegrityError → errEnvelope per existing pattern
  //         If prior status != 'voided' → ILLEGAL_STATE envelope with VoidQuote hint
  // Step 4: BEGIN
  //         Step 4a. INSERT new chiefos_quote_versions row (version_no = prior + 1, status='draft', source_msg_id=$ctx.source_msg_id)
  //         Step 4b. UPDATE prior chiefos_quote_versions SET superseded_at=NOW(), superseded_by_version_id=$new_id WHERE id=$prior_id AND superseded_at IS NULL
  //                  rowcount=0 means concurrent reissue race → ROLLBACK, re-invoke loadReissueContext, return reissuedReturnShape
  //         Step 4c. UPDATE chiefos_quotes SET current_version_id=$new_id, status='draft', updated_at=NOW() WHERE id=$quote_id AND status='voided'
  //                  rowcount=0 means concurrent transition (status moved off voided) → ROLLBACK, ILLEGAL_STATE
  //         Step 4d. emitLifecycleVersionCreated with payload.trigger_source='reissue', payload.version_no, parent_version_id=$prior_id
  //         COMMIT
  // Step 5: Compose successReturnShape — quote header + new version + line items (per §17.15 multi-entity return shape; ReissueQuote returns 'quote' with new version_id per decisions-log line 2353)
}
```

`BaseCILZ` is shared base in `quotes.js`; do not redefine.

### 4.3 Return-shape composers

- `reissuedReturnShape({ quote, newVersion, priorVersion, lineItems, alreadyExisted })` — used by both Step 2 early-exit and Step 4 success path. `meta.already_existed = true` on replay; `false` on first-call.
- No "alreadyReissuedReturnShape" needed beyond replay; multiple distinct reissues of the same source quote are legitimate (each carries a distinct `source_msg_id`) — the §17.23 idiom doesn't apply here because Reissue isn't a state-machine end-state, it's a re-creation event.

---

## 5. DB primitive layer

### 5.1 `loadReissueContext`

Pre-txn loader (mirrors `loadVoidContext` shape at `quotes.js:4670-4750`). Returns:

```js
{
  quote: { id, tenant_id, owner_id, status, current_version_id, ... },
  priorVersion: { id, version_no, project_title, total_cents, tax_rate_bps, ... },
  priorLineItems: [{ id, position, description, quantity, unit_price_cents, line_total_cents, ... }],
  customerSnapshot: { ... },  // from priorVersion.customer_snapshot JSONB
}
```

Throws `CilIntegrityError` if the quote_id doesn't resolve under (tenant_id, owner_id). Enforces the dual-boundary check.

Tenant filter: `WHERE q.tenant_id = $1 AND q.owner_id = $2 AND q.id = $3` (CLAUDE.md). RLS is belt; explicit filter is suspenders.

### 5.2 `insertReissuedVersion`

```sql
INSERT INTO public.chiefos_quote_versions (
  id, tenant_id, owner_id, quote_id, version_no,
  status, project_title, total_cents, tax_rate_bps,
  customer_snapshot, source_msg_id, created_at
) VALUES (
  $1, $tenant_id, $owner_id, $quote_id, $prior_version_no + 1,
  'draft', $prior_project_title, $prior_total_cents, $prior_tax_rate_bps,
  $prior_customer_snapshot, $source_msg_id, NOW()
)
RETURNING id, version_no, created_at;
```

Plus line items copy:

```sql
INSERT INTO public.chiefos_quote_line_items (
  id, tenant_id, owner_id, quote_id, version_id,
  position, description, quantity, unit_price_cents, line_total_cents
)
SELECT
  gen_random_uuid(), tenant_id, owner_id, quote_id, $new_version_id,
  position, description, quantity, unit_price_cents, line_total_cents
FROM public.chiefos_quote_line_items
WHERE version_id = $prior_version_id;
```

UNIQUE-violation on `(owner_id, source_msg_id)` is the dedup signal — bubble up; handler catches at Step 2 lookup OR at Step 4a INSERT (race window between lookup and INSERT). Both paths return `reissuedReturnShape` with `meta.already_existed = true`.

### 5.3 `markPriorVersionSuperseded`

```sql
UPDATE public.chiefos_quote_versions
SET superseded_at = NOW(),
    superseded_by_version_id = $new_version_id
WHERE id = $prior_version_id
  AND tenant_id = $tenant_id
  AND owner_id = $owner_id
  AND superseded_at IS NULL
RETURNING id;
```

Rowcount 0 = concurrent reissue race (§17.23-style detection). Caller ROLLBACKs and re-invokes `loadReissueContext`, returns `reissuedReturnShape` with `meta.already_existed = true` from the post-rollback re-read.

### 5.4 `markQuoteHeaderReissued`

```sql
UPDATE public.chiefos_quotes
SET current_version_id = $new_version_id,
    status = 'draft',
    updated_at = NOW()
WHERE id = $quote_id
  AND tenant_id = $tenant_id
  AND owner_id = $owner_id
  AND status = 'voided'
RETURNING id;
```

Rowcount 0 = concurrent state transition (status moved off voided, or quote deleted) → ROLLBACK, return ILLEGAL_STATE envelope.

### 5.5 `emitLifecycleVersionCreated`

Reuse if it already exists (CreateQuote and EditDraft per decisions-log line 1089 should already call into a shared emitter); otherwise extract a new shared helper. Payload:

```js
{
  payload: {
    version_no: $new_version_no,
    trigger_source: 'reissue',
    parent_version_id: $prior_version_id,
  },
  actor_user_id: ctx.actor.actor_id,
  actor_source: rawCil.source,
  correlation_id: ctx.correlationId,
  external_event_id: ctx.source_msg_id,
}
```

---

## 6. Router wiring

`src/cil/router.js`:

```diff
 const {
   handleCreateQuote, handleSendQuote, handleSignQuote, handleViewQuote, handleLockQuote,
-  handleVoidQuote,
+  handleVoidQuote, handleReissueQuote,
 } = require('./quotes');

 const NEW_IDIOM_HANDLERS = Object.freeze({
   CreateQuote: handleCreateQuote,
   SendQuote: handleSendQuote,
   SignQuote: handleSignQuote,
   ViewQuote: handleViewQuote,
   LockQuote: handleLockQuote,
   VoidQuote: handleVoidQuote,
-  // ReissueQuote: handleReissueQuote,
+  ReissueQuote: handleReissueQuote,
 });
```

Single-line uncomment + import addition. No other router changes.

---

## 7. Test plan

### 7.1 Unit tests (no DB required)

In `src/cil/quotes.test.js`, new section paralleling the VoidQuote sections:

- `ReissueQuoteCILZ` schema: accepts all three source enum values; rejects extra fields (strict); rejects non-UUID quote_id; rejects empty quote_ref.
- Return-shape composer (`reissuedReturnShape`): produces correct `{ quote, version, line_items, signatures, share_tokens, meta }` shape per §17.15 multi-entity convention.

### 7.2 Integration tests (DATABASE_URL required; BEGIN/ROLLBACK isolation)

Wrap in `describeIfDb` per existing pattern.

**Happy path:**
- Setup: tenant fixture, create quote → send → sign → lock → void.
- Action: invoke `handleReissueQuote` with the voided quote.
- Assertions: new version_no = prior + 1; new version.status = 'draft'; quote.current_version_id = new_id; quote.status = 'draft'; prior version.superseded_at populated; prior version.superseded_by_version_id = new_id; line items copied count matches; lifecycle.version_created event row inserted with trigger_source='reissue'.

**Idempotency replay:**
- First call: succeeds, `meta.already_existed = false`.
- Second call with same source_msg_id: succeeds, `meta.already_existed = true`, no new version created (count still equals prior + 1), no new event row emitted.
- Third call with new source_msg_id: succeeds, `meta.already_existed = false`, version_no = prior + 2 (multiple distinct reissues are legal).

**Cross-tenant isolation (BLOCKING):**
- Tenant MISSION creates a quote → voids it. Tenant FOREST_CITY attempts to reissue MISSION's quote_id with FOREST_CITY's owner_id. Expect: `CilIntegrityError` from `loadReissueContext` → handler returns errEnvelope. No row inserted on either tenant. (Match the cross-tenant assertion pattern at `quotes.test.js:167`.)

**Illegal state:**
- Reissue a quote in status='draft' / 'sent' / 'viewed' / 'signed' / 'locked' → `ILLEGAL_STATE` envelope with hint pointing at VoidQuote.
- Reissue a quote that doesn't exist → `CilIntegrityError`.

**Race recovery (§17.23 lineage):**
- Simulate `markPriorVersionSuperseded` returning rowcount 0 (e.g., via a sibling-txn UPDATE between loadReissueContext and the BEGIN). Assert ROLLBACK + re-read returns `reissuedReturnShape` with `meta.already_existed = true`.

**Supersession chain integrity:**
- Reissue twice (two distinct source_msg_ids; first reissue creates v2, void v2, then reissue creates v3). Assert: v1.superseded_by = v2, v2.superseded_by = v3, v3.superseded_by IS NULL, current_version_id = v3, status = 'draft'.

### 7.3 Test count target

Mirror VoidQuote density: ~20-30 new test cases. The cross-tenant isolation test and the idempotency replay test are both BLOCKING per Phase A close gate.

---

## 8. §32 ceremony

Mirror §31 (VoidQuote) ceremony in `docs/QUOTES_SPINE_CEREMONIES.md`. Required artifacts:

- Ceremony script: `scripts/real_reissue_quote_ceremony.js` mirroring `scripts/real_void_quote_ceremony.js`. Takes a tenant + quote_id (assumed already voided), calls handler, asserts new version exists and prior is superseded.
- Add §32 entry to `docs/QUOTES_SPINE_CEREMONIES.md` with: pre-conditions, run command, expected output snippet (anonymized), post-condition verification queries, idempotency replay command (re-run script, assert `meta.already_existed = true`).
- Run the ceremony BEFORE writing the §32 doc text (per Session 3 handoff §10.3 discipline: "Ceremony runs BEFORE decisions-log text").

---

## 9. Post-implementation checklist

In order:

1. **Run regression harness.** `npx jest --testPathPattern="src/cil/(quotes|quoteSignatureStorage|quoteHash|router)\.test\.js"`. All green required (unit + integration with `DATABASE_URL` set). Cross-tenant + idempotency tests must pass.
2. **Run §32 ceremony** against staging or the local dev DB. Capture transcript.
3. **Re-run `PHASE_A_CLOSE_VERIFICATION.md`** harness items 1-4. Item 2 (ReissueQuote handler implemented + wired + emits new version + idempotent + audited) must now PASS.
4. **Lift GATED marker on `PHASE_A5_INVESTIGATION.md`.** Replace the STATUS block at the top with `STATUS: ACTIVE — Phase A closed at commit <new-sha>`. Append the reserved Addendum section: if zero deltas surfaced during ReissueQuote implementation, write "No deltas; investigation findings remain stable." If deltas surfaced (e.g., a §17.26 sub-amendment landed, or the schema-widening shape changed), document them.
5. **Update `CHIEFOS_EXECUTION_PLAN.md`:** Check VoidQuote box (Session 4 close-out) AND ReissueQuote box (Session 5 close-out).
6. **Author Phase A close handoff:** new file `docs/PHASE_A_CLOSE_HANDOFF.md` summarizing all seven handlers (Create/Send/Sign/View/Lock/Void/Reissue), each with: file:line ref, ceremony §, idempotency mechanism, test coverage. Per CLAUDE.md handoff discipline: rewrite state-reflection, don't append narrative. Move `docs/PHASE_A_SESSION_3_LOCKQUOTE_HANDOFF.md` to `docs/_archive/handoffs/` in the same commit.
7. **Session report:** terse, ≤50 lines, written directly to `docs/_archive/sessions/SESSION_PHASE_A_5_REISSUEQUOTE.md` (per CLAUDE.md session report discipline). Outcomes + bugs flagged + next blocks on. Architectural decisions go in QUOTES_SPINE_DECISIONS.md (e.g., §17.26 if it landed), NOT the session report.
8. **Commit message format:** `Phase A Session 5 §N: <step>` matching prior session commit style.

---

## 10. STOP conditions

Halt and report to founder if:

- §17.26 sub-amendment becomes necessary AND its scope exceeds a single decisions-log section (i.e., touches multiple §17.x patterns or introduces a new state-machine concept). Author the amendment, but pause before handler ships for founder review.
- The schema-widening migration (§3.3 Option A) reveals that an existing version row has a non-null `source_msg_id` somewhere we didn't expect (i.e., CreateQuote already writes one and the constraint we add would conflict with existing data). Re-plan dedup approach.
- Cross-tenant isolation test fails. BLOCKING per Phase A close gate. Do not proceed to ceremony or close-out until resolved.
- Idempotency replay test fails. BLOCKING per Phase A close gate.
- Existing handler regression: any of the six prior Phase A handlers' tests fail after Reissue lands. The schema migration (§3.3) is additive but may interact with existing `customer_snapshot` reads or version-row triggers in unexpected ways. Investigate before proceeding.
- The Pro-gate regex at `handlers/commands/index.js:330` interferes with any test path. (Should not happen — Session 5 doesn't touch the WhatsApp command surface — but flag if encountered.)
- Founder approval on Decision A (schema widening LockQuoteCILZ.source / VoidQuoteCILZ.source) blocks Session 6+; this directive does NOT include that widening because it's Session 6 territory. ReissueQuote's source enum is a fresh schema (not a widening) and does not require Decision A approval.

---

## 11. Out of scope (do NOT do in this session)

- A.5 surfaces (resolver, WhatsApp commands, portal detail, portal action API) — Sessions 6–7.
- LockQuote / VoidQuote source-enum widening — Session 6 (Decision A pending).
- `chiefos_portal_quotes` view — Session 7 (Decision D pending).
- EditDraft handler — out of Phase A scope entirely (see decisions-log §17.20 future-exerciser list).
- Rewriting prior session handoff docs except as noted in §9.6 (archive Session 3 handoff during close handoff).
- Touching quarantined zones (Crew cluster pending R3b; Actor-memory cluster pending R4c — per CLAUDE.md).

---

## 12. Success criteria (definition of done)

- [ ] Migration `migrations/2026_04_25_chiefos_quote_versions_source_msg_id.sql` applied + listed in `REBUILD_MIGRATION_MANIFEST.md` apply order
- [ ] `ReissueQuoteCILZ` schema in `src/cil/quotes.js`; strict; tested
- [ ] `loadReissueContext`, `insertReissuedVersion`, `markPriorVersionSuperseded`, `markQuoteHeaderReissued`, `emitLifecycleVersionCreated` (or shared emitter call) implemented
- [ ] `handleReissueQuote` implemented per §4.2 step list
- [ ] `src/cil/router.js:40` stub replaced with live `ReissueQuote: handleReissueQuote` registration
- [ ] Unit + integration tests added, all green
- [ ] Cross-tenant isolation test + idempotency replay test green (BLOCKING)
- [ ] §32 ceremony script + decisions-log entry landed
- [ ] §17.26 sub-amendment authored if needed (else explicit note: "§17.26 not needed; ReissueQuote fits §17.23 + §14.4")
- [ ] `PHASE_A_CLOSE_VERIFICATION.md` re-run, all four items PASS
- [ ] `PHASE_A5_INVESTIGATION.md` GATED marker lifted; addendum written
- [ ] `CHIEFOS_EXECUTION_PLAN.md` checkboxes updated (VoidQuote + ReissueQuote)
- [ ] `docs/PHASE_A_CLOSE_HANDOFF.md` authored; `docs/PHASE_A_SESSION_3_LOCKQUOTE_HANDOFF.md` archived
- [ ] Session report at `docs/_archive/sessions/SESSION_PHASE_A_5_REISSUEQUOTE.md`
