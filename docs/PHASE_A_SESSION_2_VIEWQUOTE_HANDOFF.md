# Phase A Session 2 — ViewQuote Handoff

**Written:** 2026-04-22 (before `/clear` of the implementing session)
**Purpose:** Single-document context transfer for the cleared session to resume
ViewQuote at Section 4 without re-deriving architectural decisions from commit
archaeology.

This document is load-bearing. Read it **first** after `/clear`, before any
other action, before proposing Section 4.

---

## 1. Current state and recent commits

Git-durable artifacts. Commits listed in chronological order (oldest first):

| SHA | One-line summary |
|---|---|
| `fd49f702` | Foundation Rebuild §3.5: Quotes spine documented (Phase 1 Session 2) |
| `0beb6327` | Phase A Session 1: SendQuote `correlation_id` backfill — closes §17.21 asymmetry |
| `367d4895` | ViewQuote Section 1: `ViewQuoteCILZ` schema + 36 Zod tests |
| `58c5d30f` | ViewQuote Section 2: `VIEW_LOAD_COLUMNS` + `loadViewContext` + 17 tests; SUP.2 posture B |
| `92fef9e0` | `generateShareToken` short-output production bug fix (10k-iteration regression test) |
| `056d61aa` | ViewQuote Section 3: `markQuoteViewed` + `emitLifecycleCustomerViewed` + 12 tests; `source_msg_id` posture B |

**Current test baseline:** 271/271 passing on `src/cil/quotes.test.js`.

**Current branch:** `main`. 58 commits ahead of `origin/main` (nothing pushed;
Phase A development is local). Operating in pre-push territory; `git commit --amend`
is safe when needed.

---

## 2. ViewQuote Section-by-Section status

| Section | Status | SHA | Notes |
|---|---|---|---|
| **Section 1** | ✅ LANDED | `367d4895` | `ViewQuoteCILZ` schema. BaseCILZ.omit({actor, source_msg_id}).extend(...). `source` narrowed to `z.literal('web')`. `source_msg_id` optional per §17.23. Reuses `ShareTokenStringZ`. 36 tests. |
| **Section 2** | ✅ LANDED | `58c5d30f` | `VIEW_LOAD_COLUMNS` (21 cols, includes `v.server_hash` for future signature-verification display). `loadViewContext` — two-query helper (token resolve + quote/version JOIN). State-validation posture: draft→QUOTE_NOT_SENT, voided→QUOTE_VOIDED, sent/viewed/signed/locked → return ctx. Supersession check AFTER state-validation. SUP.2 posture B: SUP.1 authoritative, SUP.1-pass + superseded_by_version_id set → CIL_INTEGRITY_ERROR. 17 tests. |
| **Section 3** | ✅ LANDED | `056d61aa` | `markQuoteViewed` — single helper, sequential header→version UPDATEs, both predicated on `status='sent'`. Header-first ordering. §17.23 rowcount=0 returns `{transitioned: false}`. §3.3 co-transition: version rowcount≠1 after header flipped → `CIL_INTEGRITY_ERROR`. `emitLifecycleCustomerViewed` — INSERT with correlation_id wired from day one (§17.21). `source_msg_id` posture B (strict `!== undefined`). 12 tests including SAVEPOINT-based header-first-rollback regression lock. |
| **Section 4** | ⏳ OPEN (NEXT) | — | `handleViewQuote` orchestration + `buildViewQuoteReturnShape` (happy path) + `alreadyViewedReturnShape` (prior-state). Full scope in §4 below. |
| **Section 5** | ⏳ OPEN | — | Remaining tests + edge cases. Includes composer unit tests for `buildViewQuoteReturnShape` + `alreadyViewedReturnShape` (matching SignQuote's Section 5 precedent of ~13 composer unit tests). Potentially includes §17.21 cross-event correlation_id invariant integration test mirroring SendQuote's. |
| **Section 6** | ⏳ OPEN | — | Router registration in `src/cil/router.js` `NEW_IDIOM_HANDLERS` frozen map. Ceremony script artifact (§28 per sequential numbering). §17.23 formalization in `docs/QUOTES_SPINE_DECISIONS.md`. Supersession-after-state ordering discipline formalization. §17.24 (if adopted) post-rollback re-read discipline. Update `CHIEFOS_EXECUTION_PLAN.md` Phase A Session 2 status. |

---

## 3. Committed architectural decisions NOT obvious from code

These are the reasoning threads behind the code — the "why" that a
code-reader can't reconstruct from the "what."

### 3.1 `source_msg_id` posture B (strict `!== undefined`) — landed in `056d61aa`

`emitLifecycleCustomerViewed` uses `if (sourceMsgId !== undefined)` rather
than truthiness. An empty string — which Zod rejects via `.min(1).optional()`
— would be written to `payload.source_msg_id` as `""` if it ever reached the
helper.

**Rationale:** the helper does not silently diverge from Zod's contract. If
an empty string reaches the helper, that's a Zod regression worth surfacing
in the event stream rather than masking at the payload layer. Truthiness
check would quietly drop the empty string and hide the regression.

**Affects:** Any future handler-to-helper input contract where the helper
should surface regressions rather than defend against them. Echo-if-present
pattern (as opposed to defensive filter-empty-strings pattern) is the
precedent established here.

### 3.2 SUP.2 posture B in `loadViewContext` — landed in `58c5d30f`

Two supersession checks in loadViewContext:
- **SUP.1:** `token.quote_version_id != quote.current_version_id` →
  `SHARE_TOKEN_SUPERSEDED`.
- **SUP.2:** `token.superseded_by_version_id IS NOT NULL` (with SUP.1
  passing — token IS current) → `CIL_INTEGRITY_ERROR` (NOT
  `SHARE_TOKEN_SUPERSEDED`).

**Rationale:** SUP.1 is the authoritative "is this token current?" check.
`superseded_by_version_id` is a forward-plan column populated explicitly by a
future `ReissueQuote` handler. If SUP.1 passes (token IS current) AND
`superseded_by_version_id` is set, those two facts disagree — that's
internal state corruption, not a "stale token" user error. Surface loudly as
integrity violation; don't mask as a parallel `SHARE_TOKEN_SUPERSEDED`.

Per §17.22 invariant-assertion discipline: loud fail beats silent fallback.

**Rejected posture A:** defense-in-depth (both SUP.1 and SUP.2 fire
`SHARE_TOKEN_SUPERSEDED`). Rejected because it would mask the disagreement
rather than expose it.

### 3.3 Header-first ordering in `markQuoteViewed` — landed in `056d61aa`

Sequential UPDATEs in this order:
1. `UPDATE chiefos_quotes SET status='viewed' WHERE id=$1 AND status='sent'` — header first.
2. If header rowcount=0 → return `{transitioned: false}`.
3. `UPDATE chiefos_quote_versions SET status='viewed', viewed_at=NOW() WHERE id=$1 AND status='sent'` — version second.
4. If version rowcount≠1 → throw `CilIntegrityError`.

**Rationale:** when version UPDATE throws, the caller's transaction rolls
back. Header's UPDATE is NOT committed. Failure mode: transient — no
persisted state. The worst case (persisted header=viewed + version=sent —
§3.3 inversion) cannot occur because the throw precedes COMMIT.

Inverted ordering (version first, header second) would create the opposite
worst case: persisted version=viewed + header=sent, with no easy recovery
path. Header-first makes the failure recoverable via pure retry.

**Regression-locked by test:** `ViewQuote — Section 3 › markQuoteViewed › header-first ordering: version UPDATE failure rolls back header UPDATE (no §3.3 inversion)`. Uses SAVEPOINT-based test to prove mid-state
header-flipped then ROLLBACK TO SAVEPOINT restores sent.

### 3.4 Single helper for `markQuoteViewed` (not two-helper split) — landed in `056d61aa`

SignQuote's Section 4 split into `updateVersionLocked` + `updateQuoteSigned`
because their input contracts differed (serverHash + locked_at + signed_at
vs. status + updated_at). ViewQuote's dual-row update is symmetric — both
UPDATEs have the same predicate shape (`status='sent'`) and record a
timestamp. A single helper encapsulates the state-transition semantic as
**one atomic unit**, matching the `markQuoteSent` precedent in SendQuote.

**Rationale:** splitting would have produced two helpers that are structurally
near-identical — premature abstraction with no current consumer benefiting
from the separation.

### 3.5 §17.23 state-driven idempotency — NOT YET FORMALIZED (Section 6 scope)

First-exerciser: ViewQuote. Pattern:

> When a CIL handler transitions state on an existing row but does not
> INSERT a row with a natural `(owner_id, source_msg_id)` unique constraint,
> idempotency is enforced at the state-read layer rather than at
> 23505-classification. Pre-txn SELECT reads the target row's current state;
> branch on that state. Concurrent retry protection comes from conditional
> `UPDATE ... WHERE status = 'expected_prior_state'` — rowcount=0 indicates
> another invocation already transitioned, at which point re-read state and
> return `already_existed: true`. No `classifyCilError` branch needed.

**Status:** Pattern is implemented (Section 3 `markQuoteViewed`). Formalization
in `docs/QUOTES_SPINE_DECISIONS.md` deferred to Section 6 close. LockQuote and
VoidQuote are expected second/third exercisers (reinforcing the pattern
before it's documented).

### 3.6 Supersession-after-state check ordering — landed in `58c5d30f` (to be formalized in Section 6)

In `loadViewContext`, state-validation runs BEFORE supersession check. A
`voided` quote with a stale token returns `QUOTE_VOIDED`, not
`SHARE_TOKEN_SUPERSEDED`.

**Rationale:** customer actionability. "Quote is voided" is more informative
than "your link is stale" when the underlying state is terminal. If both
checks must fire, prefer the error that describes the user's actual
situation, not the narrowest technical one.

**To formalize at Section 6 alongside §17.23.**

### 3.7 `generateShareToken` production bug fix — landed in `92fef9e0`

Prior to this fix, `bs58.encode(crypto.randomBytes(16))` returned 21-char
strings ~2.83% of the time (when the random 128-bit integer happened to fit
in `58^21 ≈ 5.2×10^36`). Migration 3's `chiefos_qst_token_format` CHECK
requires exactly 22 chars. ~3% of real SendQuote invocations would have
failed with 23514. Fix: bounded retry loop (20 iterations, throws on
exhaustion); regression-locked with 10k-iteration unit test.

**Misidentification lesson:** originally observed as a ~20% test-suite flake
rate, hypothesized as "pool consistency race" or "emitter ordering." Both
rejected during investigation. Actual root cause was a generator-side
invariant violation — the emitter's input was invalid ~3% of the time. The
flake was a masking symptom, not the bug.

**For future flake investigations:** before applying a test-fixture
workaround (e.g., readback-retry helper), verify the hypothesis with failure-
output diagnostics. The diagnostic approach saved us from shipping a
workaround that would have masked the production bug.

---

## 4. Section 4 scope (NEXT UP)

Three deliverables:
- `handleViewQuote` — handler orchestration
- `buildViewQuoteReturnShape` — happy-path multi-entity composer (§17.15)
- `alreadyViewedReturnShape` — prior-state composer (called by three paths)

### 4.1 Handler sequence

```
Step 1: Ctx preflight (owner_id, traceId required)
Step 2: Zod validation (ViewQuoteCILZ.safeParse)
Step 3: No plan gating (§14.12 customer-action exemption)
Step 4: Actor role check (customer literal; defense-in-depth)
Step 5: correlation_id = crypto.randomUUID() (§17.21 wired from day one)
Step 6: loadViewContext → catches CilIntegrityError, maps to errEnvelope
Step 7: Pre-txn status routing:
        - viewed/signed/locked → alreadyViewedReturnShape, return (no txn)
        - sent → proceed to Step 8
Step 8: pg.withClient BEGIN:
        - markQuoteViewed(client, ...)
          - transitioned=false → return { concurrentTransition: true }
          - transitioned=true → emitLifecycleCustomerViewed(client, ...)
            → return { markResult, concurrentTransition: false }
        - COMMIT (withClient handles)
        - Catch: CilIntegrityError → errEnvelope; other → propagate 500
Step 9a: If concurrentTransition, posture A re-read:
         - loadViewContext again (wrapped in try/catch — a concurrent
           VoidQuote between Step 7 load and Step 8 txn would make the
           re-read throw QUOTE_VOIDED; route to errEnvelope)
         - Return alreadyViewedReturnShape from fresh ctx
Step 9b: Happy path — buildViewQuoteReturnShape({ ctx, markResult,
         correlationId, eventsEmitted: ['lifecycle.customer_viewed'],
         alreadyExisted: false, traceId })
```

### 4.2 Concurrent-transition posture — **A (decided)**

Re-read via `loadViewContext` after rowcount=0 on markQuoteViewed's header
UPDATE. Composes `alreadyViewedReturnShape` from actual current state.
Two SELECTs in the edge case — acceptable cost for correctness. Precedent
propagates to LockQuote / VoidQuote / ReissueQuote.

Rejected posture B (narrow `lookupCurrentViewState` helper specialized for
the re-read): consistency wins over micro-optimization; the re-read path is
rarely hit.

**Subtle but load-bearing:** the re-read needs its own try/catch. A
concurrent `VoidQuote` between Step 7's load and Step 8's markQuoteViewed
rowcount=0 would mean the re-read sees a voided quote — `loadViewContext`
throws `QUOTE_VOIDED`. Handler must wrap the re-read and route to
`errEnvelope`; unwrapped, it becomes 500-class.

### 4.3 `events_emitted` convention — ARRAY not number

Per SignQuote (line 1627) and SendQuote (line 3519) precedent:
- Happy path: `events_emitted: ['lifecycle.customer_viewed']`
- Already-viewed / concurrent-transition: `events_emitted: []`

User's initial Section 4 framing used `events_emitted: 1` (numeric) — that
was incorrect; the convention is an array of event-kind strings.

### 4.4 Return-shape composers

**`buildViewQuoteReturnShape`** — 4 entities (quote, version, share_token,
meta). Version entity includes 12 keys including `viewed_at` (freshly
populated from markResult), `signed_at`, `locked_at`, `server_hash` (all
null in happy path; populated if the path ever serves signed/locked via
alreadyViewed). Share_token entity includes 7 keys (id, token,
recipient_channel/address/name, absolute_expires_at, issued_at).

**`alreadyViewedReturnShape`** — identical entity shape to
`buildViewQuoteReturnShape` modulo:
- `meta.already_existed: true`
- `meta.events_emitted: []`
- `meta.correlation_id: null` (§17.21 retry-path limitation; the original
  invocation's correlation_id is not persisted on any ViewQuote-owned row)
- `quote.status` / `version.status` from actual current state (not
  hardcoded to 'viewed')
- `version.viewed_at` / `signed_at` / `locked_at` / `server_hash` populated
  from ctx based on actual state
- `quote.updated_at` NOT freshly bumped (no write occurred this call)

Kept as **separate composers** per §17.15 Q2 (parameterizing grows into
conditional blocks over time).

### 4.5 Pre-implementation verifications (already done; findings below)

- **`buildSignQuoteReturnShape` (line 1288):** 5 entities — signature, quote, version, share_token, meta. `events_emitted` is array. `meta.correlation_id` present.
- **`buildSendQuoteReturnShape` (line 3286):** 4 entities — quote, share_token, meta. `events_emitted` is array.
- **`priorSignatureToReturnShape` (line 1334):** retry-path composer; `events_emitted: []`; `meta.correlation_id: null`.
- **`errEnvelope`:** imported from `./utils` at line 67. Shape: `{ ok: false, error: { code, message, hint, traceId } }`.
- **`pg.withClient`** (services/postgres.js line 118): acquires pool connection, BEGIN, runs body, COMMIT on success / ROLLBACK on throw, releases. Exactly the pattern Section 4 needs.
- **`CIL_TO_EVENT_ACTOR_SOURCE`** (line 105): `{ whatsapp: 'whatsapp', web: 'portal' }`. ViewQuote's source='web' → actor_source='portal'.

### 4.6 Test taxonomy — 11 tests

**Pre-BEGIN rejections (unit, no DB):**
1. Ctx missing `owner_id` → `OWNER_ID_MISSING` envelope
2. Ctx missing `traceId` → `TRACE_ID_MISSING` envelope
3. Zod failure (missing type) → `CIL_SCHEMA_INVALID`
4. Actor role=owner → `PERMISSION_DENIED`

**End-to-end (integration, DB-gated):**
5. Happy path: sent → viewed; full shape; `meta.correlation_id` populated;
   `meta.events_emitted=['lifecycle.customer_viewed']`;
   `lifecycle.customer_viewed` event carries same correlation_id (SELECT
   to prove invariant)
6. `source_msg_id` pass-through: present in CIL → event payload includes
   it via readback
7. Already-viewed: `alreadyViewed` shape, `meta.correlation_id: null`,
   `events_emitted: []`
8. Already-signed: `alreadyViewed` shape (legitimate post-sign review)
9. Already-locked: `alreadyViewed` shape
10. Concurrent-transition (posture A regression lock): mock `pg.withClient`
    to pre-flip header status between handler's load and markQuoteViewed
    call. Handler returns `alreadyViewed` from re-read.
11. Draft quote → `QUOTE_NOT_SENT` errEnvelope
12. Voided quote → `QUOTE_VOIDED` errEnvelope
13. Share-token not-found → `SHARE_TOKEN_NOT_FOUND` errEnvelope
14. Version-shape regression guard: happy-path `return.version` has exactly
    12 expected keys (Flag 2 — locks entity contract against drift)

**Update:** 14 tests (4 pre-BEGIN + 10 end-to-end). Proposal mentioned 8-10
but the end-to-end set expanded during verification. Acceptable.

### 4.7 Commit posture

Single commit: `Phase A Session 2 Section 4: handleViewQuote orchestration + return shapes`

- `src/cil/quotes.js`: +~200 lines (handler + 2 composers + `_internals` exports)
- `src/cil/quotes.test.js`: +~400 lines (14 tests + fixtures)
- No decisions-log edit (§17.23 and post-rollback re-read discipline land in Section 6)
- No router registration (Section 6)

### 4.8 Composer unit tests — **deferred to Section 5**

`buildViewQuoteReturnShape` + `alreadyViewedReturnShape` unit tests
(exact-key-match, meta discipline, timestamp presence) go in Section 5 —
matching SignQuote's Section 5 precedent of ~13 composer unit tests.
Section 4 stays focused on handler orchestration + end-to-end.

---

## 5. Broader phase context

### 5.1 Phase A sequence — Quote-spine completion

Five CIL handlers close the Quote state machine:

1. **SendQuote** — backfill (`correlation_id` wiring). ✅ Done `0beb6327`.
2. **ViewQuote** — sent→viewed. 🔄 In progress, Section 3 of ~6 landed.
3. **LockQuote** — likely auto-lock after cooling period or signed→locked on external event. Scope TBD.
4. **VoidQuote** — sent/viewed/signed/locked → voided. Soft-terminal state.
5. **ReissueQuote** — voided → new quote with prior version reference. Populates `superseded_by_version_id` on old share-tokens.

LockQuote/VoidQuote are second/third exercisers of §17.23 state-driven
idempotency — they reinforce the pattern before formalization.

### 5.2 Broader plan — Path B locked

Phase sequence decided: **Path B** — change orders deferred to Phase E
post-cutover. Order:

- **Phase A:** Quote spine (current).
- **Phase B:** Quote editing + logos + templates + warranty/payment schedule + line-item polymorphic source_type.
- **Phase C:** Leads spine.
- **Phase D:** Deposit receipts + payment tracking (first wiring to `public.transactions`).
- **Phase E:** Change Orders spine (separate 6-table spine; not fold-in).
- **Phase F:** Invoices spine (generates from signed quote + accepted change orders).
- **Phase G:** Final receipts + polish.

**Option 1 locked:** signed quote IS the contract. No separate Contracts
spine. `chiefos_quote_signatures` + signed-status quote = legal artifact.

---

## 6. Cross-session routing decisions (Foundation Rebuild session)

From `fd49f702` work and subsequent cross-session discussion:

### 6.1 Q3: Polymorphic line-item source_type

`pricing_items` table preserved. Three line-item source types:
- `supplier_catalog` — from `catalog_products`
- `pricing_item` — from `pricing_items` (tenant-customizable markup table)
- `free_text` — contractor-typed one-off

Wired into `chiefos_quote_line_items` via:
- `source_type text CHECK (source_type IN (...))`
- `source_ref_id uuid` (nullable; points at pricing_item / catalog_product)
- `source_snapshot jsonb` (preserves source state at line-item creation)

**Migration lands in Phase B**, not Phase A. Section 6 of ViewQuote does NOT
touch this — it's a forward-plan column set documented in the handoff.

### 6.2 Q4: Separate `chiefos_change_orders` spine

Not fold-in to Quotes. 6-table architecture mirrors Quote spine:
- `chiefos_change_orders` (header)
- `chiefos_change_order_versions` (append-only)
- `chiefos_change_order_line_items`
- `chiefos_change_order_signatures`
- `chiefos_change_order_events`
- `chiefos_change_order_share_tokens`

**Phase E scope.** Not part of Phase A or B.

---

## 7. Open patterns worth preserving for future handlers

Patterns established in Phase A that will repeat in LockQuote / VoidQuote /
ReissueQuote and beyond:

### 7.1 §17.23 state-driven idempotency (pending formalization)

See §3.5 above. Formalize at Section 6 close alongside supersession-after-state ordering. Expected content in `docs/QUOTES_SPINE_DECISIONS.md`:

> When a CIL handler transitions state on an existing row but does not
> INSERT a row with a natural `(owner_id, source_msg_id)` unique constraint,
> idempotency is enforced at the state-read layer rather than at
> 23505-classification. Pre-txn SELECT reads the target row's current state;
> branch on that state. Concurrent retry protection comes from conditional
> `UPDATE ... WHERE status = 'expected_prior_state'` — rowcount=0 indicates
> another invocation already transitioned, at which point re-read state and
> return `already_existed: true`. No `classifyCilError` branch needed. First
> exercised by ViewQuote (§28). Second/third exercisers: LockQuote,
> VoidQuote.

### 7.2 §17.24 (proposed): post-rollback re-read discipline

If Section 4 ships cleanly with posture A, formalize:

> When a state-driven-idempotency handler's transaction body returns
> `{ transitioned: false }` (concurrent-transition signal), the handler
> MUST re-read the target state via the same context loader used pre-txn
> — not a specialized lookup. Consistency: the re-read path surfaces the
> same error classes as the pre-txn load (including terminal states like
> voided that may have arisen between the two reads). Wrap the re-read in
> its own try/catch: CilIntegrityError from the re-read routes to
> `errEnvelope`, matching the pre-txn load's error discipline.

### 7.3 Source_msg_id posture B (echo-if-present)

When a CIL field is optional at Zod (`z.string().min(1).optional()`) and
audit-only at the helper layer, write using strict `!== undefined` check:
- Present with value → write to payload.
- Absent (undefined) → key not written.
- Empty string (Zod regression) → write `""` through; do not silently drop.

The helper does not defend against Zod contract violations; it surfaces
them.

### 7.4 Header-first ordering for dual-row state transitions

Dual-row UPDATEs in state-transition helpers: always update the
authoritative state-machine row first (header), then the dependent row
(version). The throw on rowcount mismatch happens AFTER the header flip but
BEFORE commit, so the caller's transaction rollback restores pre-call
state. Inverted order creates a §3.3 inversion worst-case (persisted
version=new + header=old).

---

## 8. Reading order for cleared session

After `/clear`:

1. **Read this handoff** (`docs/PHASE_A_SESSION_2_VIEWQUOTE_HANDOFF.md`) in full.
2. **Confirm git state** — `git log --oneline -20` — verify SHAs in §1 match HEAD lineage.
3. **Inspect Section 3 surface** — `git show 056d61aa --stat` to see the 2-file, +634-line footprint.
4. **Run test baseline** — `npx jest src/cil/quotes.test.js` — expect 271/271 passing. Flaky >1/5? Regression in the share-token fix; halt and investigate before coding.
5. **Skim Foundation Rebuild §3.5** — `FOUNDATION_P1_SCHEMA_DESIGN.md` §3.5 — Quote-spine architecture refresher (line 979 area, ~140 lines).
6. **Skim ViewQuote Section 1/2/3 code** — `src/cil/quotes.js`:
   - Section 1: search for `ViewQuoteCILZ`
   - Section 2: search for `VIEW_LOAD_COLUMNS` / `loadViewContext`
   - Section 3: search for `markQuoteViewed` / `emitLifecycleCustomerViewed`
7. **Propose Section 4** per §4 of this handoff. Pre-implementation
   verifications already done (§4.5); proceed directly to proposal.

Expected first user action after `/clear`: "Proceed with Section 4."
Agent's first action: produce Section 4 proposal referencing this handoff;
await approval; implement + commit.

---

## 9. Handoff document maintenance rule

If decisions evolve between handoff write and `/clear` execution, update
this document in place and commit — do not rely on chat context.

If the cleared session discovers the handoff is incomplete or wrong,
surface that to the user as "handoff gap detected: [what's missing]"
before proceeding. Don't paper over gaps; fill them before Section 4.
