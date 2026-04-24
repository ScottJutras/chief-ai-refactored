# Phase A Session 3 — LockQuote Mid-Session Checkpoint

## §1. Purpose & Lifecycle

This document bootstraps a fresh Claude Code session into LockQuote §2 work mid-session after a `/clear` event. Read in full before accepting any §2 directive. Obsolete once LockQuote §3 close-out commits — delete in the same commit that lands §3 or in the next housekeeping pass.

This is **not** a session-closure handoff. Session 3 is mid-arc; this checkpoint exists solely to preserve architectural decisions and implementation-time nuances across the `/clear` boundary so the post-`/clear` Claude does not have to rediscover them. Between-session handoffs use the `_HANDOFF.md` suffix; mid-session checkpoints use `_CHECKPOINT.md` per the `PHASE_X_SESSION_Y_<HANDLER>_CHECKPOINT.md` convention.

---

## §2. What §1 Landed (SHA `050372f7`)

**Commit:** `050372f7` — "Phase A Session 3 Section 1: LockQuoteCILZ + loadLockContext + markQuoteLocked + emitLifecycleLocked"

**Test baseline:** 317 → **367 passing** (+50 tests).

**Four components landed:**

1. **`LockQuoteCILZ`** — Zod schema for the LockQuote CIL envelope. Discriminated union over `actor.role ∈ { 'owner', 'system' }`. `source: z.literal('system')` in Phase A (will widen to `z.enum(['portal', 'whatsapp', 'system'])` in Phase A.5 — note the form change from literal to enum, not just a values change).
2. **`loadLockContext`** — Pre-transaction loader. Resolves the quote header + signed version. Actor-oblivious (no branching on `actor.role` inside the loader). Consumes upstream-resolved `ctx.owner_id` and `ctx.tenant_id` per Posture A.
3. **`markQuoteLocked`** — Header-only state mutation. Updates `chiefos_quotes` header to `status='locked'`. Does **not** touch the version row (constitutionally immutable post-sign).
4. **`emitLifecycleLocked`** — Lifecycle event emitter. Emits the `quote.locked` lifecycle event with the resolved actor/source through `CIL_TO_EVENT_ACTOR_SOURCE`.

**Two approved extensions landed in the same commit:**

- `CIL_TO_EVENT_ACTOR_SOURCE` gained a `system: 'system'` entry so system-actor invocations resolve to the `system` event source.
- `SIG_ERR.QUOTE_NOT_SIGNED` added — surfaces when LockQuote is invoked against a quote whose latest version is not in `signed` status (wrong-state fail-closed path).

---

## §3. Architectural Decisions Locked Earlier This Session

These were resolved through lengthy planning and are **not** obvious from code inspection. Preserve them.

### §3.1. Phase Plan Amendment (commit `f52e7888`)

Phase A closes as **handler-spine-only**. **Phase A.5** added as the "Quote Surface Parity Sprint": fuzzy resolver, WhatsApp commands, portal quote detail view, and portal action API. LockQuote ships in Phase A with a **system-only** surface; portal/WhatsApp widen to LockQuote in A.5.

### §3.2. Actor Model

Dual via Zod **discriminated union** over `'owner' | 'system'`. Both paths reach the same state-transition logic but diverge on:
- **Identity resolution:** Both upstream-resolved per Posture A — see §3.4.
- **Plan-gating:** Conditional on `actor.role === 'owner'` — see §3.3.

### §3.3. Plan-Gating Posture

Plan-gating applies **iff** `actor.role === 'owner'`. System actors are not plan-holders; gating their automated transitions would require synthetic plan state. Inline rationale comment in the handler references **§14.12's customer-actor exemption** as a parallel precedent and points to "next-free §17.N slot" for future formalization. The comment does **NOT** specifically claim §17.27 — keep it slot-agnostic until §3 close-out resolves the §17.N question.

### §3.4. Identity Resolution — Posture A

`ctx.owner_id` and `ctx.tenant_id` come from the **upstream resolver** (portal session, WhatsApp ingestion, cron config for system actor). The loader is **actor-oblivious** — no `if (actor.role === 'system')` branching inside `loadLockContext`. Preserves the CLAUDE.md dual-boundary invariant (tenant_id for portal, owner_id for ingestion/audit; both fail-closed if ambiguous upstream).

### §3.5. Source Enum Posture

Phase A: `source: z.literal('system')`. Phase A.5 widens to `z.enum(['portal', 'whatsapp', 'system'])`. The form change from `z.literal` to `z.enum` is itself a contract change — any downstream consumer that pattern-matches on the literal type will need updating in A.5.

### §3.6. §3A Header-Only Asymmetry

LockQuote is **header-only**. The version row is constitutionally immutable post-sign (`trg_chiefos_quote_versions_guard_immutable`). `markQuoteLocked` updates the `chiefos_quotes` header **only**; the version row is never touched.

Post-lock state:
- `chiefos_quotes.status` → `'locked'`
- `chiefos_quote_versions.status` remains `'signed'` (unchanged)
- `chiefos_quote_versions.locked_at` remains unchanged (whatever it was at sign-time)

This is **the** key asymmetry between LockQuote and SignQuote/ViewQuote. §2 composers must encode this explicitly via inline comments — see §5 below.

### §3.7. §17.N Assessment

No new §17.N is expected. LockQuote is the **second §17.23 exerciser** (concurrent-transition retry). If §2 implementation surfaces a genuinely new invariant, use **§17.27** (§17.26 is reserved for ReissueQuote). Do **not** silently claim §17.26.

---

## §4. Implementation-Time Nuances from §1 That §2 Must Not Rediscover

### §4.1. `QuoteRefInputZ` Contract Is At-Least-One, NOT Exactly-One

The original Investigation 2.5 proposal said "exactly-one." Reality is **at-least-one** — `loadDraftQuote` branches on `quote_id` first, then falls back to other identifiers. §1 test assertions were corrected to document the actual contract.

**If §2's handler or composers assume exactly-one semantics, they will drift from reality.** Preserve at-least-one. Tests on `QuoteRefInputZ` already assert at-least-one — do not weaken them.

### §4.2. Mock-Based Invariant Tests Pattern

Three §3A/§17.22 invariant-violation states are **DB-unreachable by design** (CHECK constraints + immutability triggers prevent the violating rows from existing). These were covered in §1 via **mock-based unit tests** using the `mockPgWith` pattern (precedent: `loadViewContext`).

§2's integration tests should use the same pattern if any new invariants are DB-unreachable. Do not attempt to construct violating rows in test fixtures — the DB will reject them, and the test will fail for the wrong reason.

### §4.3. `CIL_TO_EVENT_ACTOR_SOURCE` Already Includes `system: 'system'`

Landed in §1. §2 handler invocations with `source='system'` resolve correctly via the existing mapping. **Do not re-extend** the constant.

---

## §5. §2 Approved Scope (Per Session Directive — To Be Implemented)

### Production code

- **`handleLockQuote` orchestration:**
  - Pre-transaction loader call (`loadLockContext`).
  - Pre-transaction state routing: `signed` → happy path; `locked` → idempotency routing via `alreadyLockedReturnShape` composer.
  - Conditional plan-gating: `if (actor.role === 'owner') { … }`. Inline rationale comment per §3.3.
  - `withClient` transaction calling `markQuoteLocked` + `emitLifecycleLocked`.
  - Post-rollback re-read path (the §17.23 recovery half — second loader call after retryable rollback to confirm transition landed via concurrent writer).

- **`buildLockQuoteReturnShape` composer:** 3-entity shape:
  - `quote` with `status='locked'`
  - `version` with `status='signed'` **UNCHANGED**
  - `meta`
  - **Inline comment required:** *"version.status intentionally remains 'signed' post-lock — §3A header-only asymmetry. The version row is constitutionally immutable post-sign (trg_chiefos_quote_versions_guard_immutable). LockQuote is a header-only state flip; version.status and version.locked_at are unchanged."*

- **`alreadyLockedReturnShape` composer:** 3-entity shape from pre-existing locked state. `meta` with:
  - `correlation_id: null`
  - `events_emitted: []`
  - `already_existed: true`
  - `traceId` passthrough

### Tests

- **Handler integration tests:**
  - Happy path (signed → locked).
  - Already-locked idempotency (locked → locked, no event emit).
  - Concurrent-transition retry (§17.23 — rollback then re-read confirms transition).
  - Cross-tenant fail-closed.
  - Wrong-state fail-closed (e.g., draft → lock attempt surfaces `SIG_ERR.QUOTE_NOT_SIGNED`).
  - Owner-actor: gating applies.
  - System-actor: gating skips.
  - §3A assertion coverage (version row untouched).
  - §17.22 assertion coverage.

- **Composer unit tests:** Parallel to ViewQuote Section 5 structure. Exact-key-match regression locks, meta field discipline, hardcoded-vs-ctx field sourcing. ~13 per composer (`buildLockQuoteReturnShape` + `alreadyLockedReturnShape`).

### Sizing

- **Expected test count added:** ~22 (post-§2 baseline ~389/389). If over ~30, consider §2a/§2b split.
- **Expected production size:** ~150–200 lines.
- **Commit posture:** single commit.

---

## §6. §3 Close-Out Scope (Future — After §2 Lands)

Listed for §2's awareness so it does **not** absorb §3 work prematurely:

1. Router registration in `src/cil/router.js` `NEW_IDIOM_HANDLERS`: `LockQuote: handleLockQuote`.
2. §30 ceremony scripts (c5c5 namespace, SQL-INSERT seed extending §28 with signature row, real production exercise).
3. §30 decisions-log entry in `docs/QUOTES_SPINE_DECISIONS.md`.
4. §17.24 forward-applicability correction: strike "LockQuote — dual-row" bullet; replace with header-only per §3A rationale.
5. `CHIEFOS_EXECUTION_PLAN.md` status line for LockQuote.
6. Handoff document update (Session 2 handoff or new session close handoff).
7. Three tech-debt flags to land in §10 discipline notes:
   - (a) schema-verify forward-applicability bullets,
   - (b) surface-enum product-level vs technical,
   - (c) `SIG_ERR` rename to `QUOTE_ERR` post-Phase-A.
8. **Checkpoint document deletion** — this file, in the same commit that lands §3, or in the next housekeeping pass.

---

## §7. Reading Order for Fresh Claude Code

1. **Read this checkpoint document in full** before any other action.
2. **Confirm understanding** by summarizing §3 architectural decisions back to the founder (demonstrate context reconstitution).
3. **Await §2 scope directive** (the founder will paste).
4. Do **NOT** open §2 implementation without §2 scope directive approved in-session.
