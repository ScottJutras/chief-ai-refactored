# SESSION R4c-investigate — Actor Memory Classification + Bug Surfacing

**Date:** 2026-04-24
**Directive Version:** 1
**Scope:** Investigation only. Zero code modifications.
**Predecessor:** R4b-finalize (F2 fix shipped)

---

## 1. Executive Summary

**Total live actor-memory call sites: 36** (29 in `services/agent/index.js`, 5 in `services/orchestrator.js`, 1 in `services/answerChief.js`, 1 in `routes/webhook.js`) plus 2 wrapper definitions (`loadActorMemorySafe`, `patchActorMemorySafe` in `services/agent/index.js`) and 1 producer of `memory_patch` shapes (`services/insights_v0.js` — 5 emission sites all consumed via orchestrator.js:593).

**Headline finding: 100% of call sites are SESSION-scoped.** Every read consumes session-only fields (`pending_choice`, `pending_intent`, `intake_draft`, `last_job_*`, `last_date_*`, `conversation_history`, `last_intent`, `last_topic`); every write patches the same. The `chief_actor_memory` row stores a single `memory` jsonb that — in practice — contains only conversational state. **Zero PERSISTENT writes exist in live code.**

**Container decision: Option X vs Y is moot.** All sites map to `conversation_sessions.active_entities` (jsonb) with the natural exception of `conversation_history` (2 sites) which maps to `conversation_messages` (the dedicated append-only table designed for that purpose).

**Bug count: 2 MEDIUM.** Both in the `services/postgres.js` function definitions (silent fallback patterns identical to F2's pre-fix shape, but for a different reason — see §6). No CRITICAL or HIGH bugs surfaced.

**Recommended next step:** R4c-migrate authored against a single SESSION container (`conversation_sessions.active_entities` for non-history; `conversation_messages` for history). No P1A-5 amendment session needed. No bug-fix-only session needed. The 2 MEDIUM bugs can be addressed in R4c-migrate as part of removing the legacy functions.

---

## 2. V1-V3 Call-Site Inventory

### V1 — Full grep results
38 hits in live code (excluding `migrations/`, `archive/`, worktrees, node_modules). Split:
- 8 hits in `services/postgres.js` (definitions + 1 export reference)
- 5 hits in `services/orchestrator.js` (5 call sites, all `patchActorMemory`)
- 3 hits in `services/answerChief.js` (1 call site + 2 surrounding `if`/`catch` lines)
- 35 hits in `services/agent/index.js` (29 call sites + 5 wrapper-internal lines + 1 wrapper definition signature line)
- 5 hits in `routes/webhook.js` (1 call site + 4 surrounding lines)

### V2 — Definitions found
| Item | Location | Description |
|---|---|---|
| Definition: `getActorMemory` | `services/postgres.js:1099-1115` | `(ownerId, actorKey)` → SELECT `memory` FROM `chief_actor_memory` WHERE owner_id+actor_key. Returns `memory` jsonb or `{}`. |
| Definition: `patchActorMemory` | `services/postgres.js:1117-1146` | `(ownerId, actorKey, patch)` → UPSERT with deep-merge of `memory.conversation` jsonb subkey, shallow merge of other top-level keys. |
| Wrapper: `loadActorMemorySafe` | `services/agent/index.js:287-294` | try/catch + `safeJson` around `getActorMemory`. |
| Wrapper: `patchActorMemorySafe` | `services/agent/index.js:296-303` | try/catch + `safeJson` around `patchActorMemory`. Fire-and-forget pattern (never blocks user reply). |
| Module export | `services/postgres.js:5176-5177` | `getActorMemory, patchActorMemory` exposed as `pg.*` API surface. |

### V3 — Caller-file inventory

| File | Reads | Writes | Import pattern | Description |
|---|---|---|---|---|
| `services/agent/index.js` | 1 (line 290 inside wrapper) | 28 (lines 743, 780, 906, 912, 920, 928, 936, 944, 952, 969, 978, 988, 1008, 1014, 1029, 1040, 1048, 1058, 1075, 1087, 1099, 1110, 1122, 1192, 1199, 1207, 1260, 1268, 1280) | `const pg = require('../postgres')` (top of file) | Chief agent's `ask()` flow — pending-state machine, intake-draft tracking, entity-ref substitution, rolling chat history. |
| `services/orchestrator.js` | 0 (consumes `context.actorMemory` from caller — see §3 O5/AC1 thread) | 5 (lines 209, 222, 241, 244, 593) | `const pg = require('./postgres')` | "log / question" follow-up flow + insights memory_patch passthrough. |
| `services/answerChief.js` | 1 (line 139) | 0 | `const pg = require('./postgres')` | Loads full memory at start of conversation; passes through `context.actorMemory` to orchestrator. |
| `routes/webhook.js` | 1 (line 2916) | 0 | `const pg = require('../services/postgres')` | Loads memory pre-routing to check `pending_choice` for bare-intent follow-ups. |

**Total call sites: 36** (1 read in agent + 28 writes in agent + 0 reads + 5 writes in orchestrator + 1 read in answerChief + 1 read in webhook + 0 unattributed). Plus 5 indirect emission sites in `services/insights_v0.js` (all returned to orchestrator.js:593 as `out.memory_patch`).

---

## 3. Per-Site Classification

All sites use `(ownerDigits, actorKey)` where `actorKey` resolves to a phone digit-string (the WhatsApp sender's number). This maps cleanly to rebuild's `(tenant_id, owner_id, user_id)` triple — `actor_key` ≡ `user_id`.

### Agent ask() — flow patches (29 sites)

| # | Line | Patch keys | Classification | Target |
|---|---|---|---|---|
| A0 | 290 (read) | full memory blob | **SESSION** | `conversation_sessions` row + `conversation_messages` history |
| A1 | 743-749 | `conversation_history: [...]` | **SESSION** | `conversation_messages` (dedicated table) |
| A2 | 780 | `pending_choice: null, pending_intent: null` (help-intent reset) | **SESSION** | `active_entities` |
| A3 | 906 | `pending_choice: 'log', pending_intent: null` | **SESSION** | `active_entities` |
| A4 | 912 | `pending_choice: 'question', pending_intent: null` | **SESSION** | `active_entities` |
| A5 | 920-923 | `pending_intent: 'expense', intake_draft: {...}` | **SESSION** | `active_entities` |
| A6 | 928-931 | `pending_intent: 'revenue', intake_draft: {...}` | **SESSION** | `active_entities` |
| A7 | 936-939 | `pending_intent: 'task', intake_draft: {...}` | **SESSION** | `active_entities` |
| A8 | 944-947 | `pending_intent: 'time', intake_draft: {...}` | **SESSION** | `active_entities` |
| A9 | 952-955 | `pending_intent: 'job', intake_draft: {...}` | **SESSION** | `active_entities` |
| A10 | 969-971 | `intake_draft: { kind: 'expense', ... }` | **SESSION** | `active_entities` |
| A11 | 978-980 | `intake_draft: { dateIso }` | **SESSION** | `active_entities` |
| A12 | 988-990 | `intake_draft: { amountText }` | **SESSION** | `active_entities` |
| A13 | 1008-1010 | `intake_draft: { vendor, dateIso }` | **SESSION** | `active_entities` |
| A14 | 1014-1018 | clear (`pending_choice/intent/intake_draft = null`) | **SESSION** | `active_entities` |
| A15 | 1029-1033 | clear (same) | **SESSION** | `active_entities` |
| A16 | 1040-1042 | `intake_draft: { kind: 'revenue', ... }` | **SESSION** | `active_entities` |
| A17 | 1048-1050 | `intake_draft: { dateIso }` | **SESSION** | `active_entities` |
| A18 | 1058-1060 | `intake_draft: { amountText }` | **SESSION** | `active_entities` |
| A19 | 1075-1079 | clear | **SESSION** | `active_entities` |
| A20 | 1087-1089 | `intake_draft: { kind: 'task', ... }` | **SESSION** | `active_entities` |
| A21 | 1099-1103 | clear | **SESSION** | `active_entities` |
| A22 | 1110-1114 | clear | **SESSION** | `active_entities` |
| A23 | 1122-1126 | clear (time) | **SESSION** | `active_entities` |
| A24 | 1192 | `last_job_no, last_job_name: null` | **SESSION** | `active_entities` |
| A25 | 1199 | `last_job_name: <name>` (DB-resolved) | **SESSION** | `active_entities` |
| A26 | 1207-1210 | `last_date_from, last_date_to` | **SESSION** | `active_entities` |
| A27 | 1260 | `last_job_no` (post-tools-loop) | **SESSION** | `active_entities` |
| A28 | 1268 | `last_job_name: <name>` (post-tools-loop, DB-resolved) | **SESSION** | `active_entities` |
| A29 | 1280 | `conversation_history: newHistory` (post-tools-loop) | **SESSION** | `conversation_messages` |

### Orchestrator + insights_v0 (5 sites + 5 emissions)

| # | Line | Patch keys | Classification | Target |
|---|---|---|---|---|
| O1 | orchestrator.js:209 | `pending_choice: 'log_which', last_topic: 'log_menu'` | **SESSION** | `active_entities` |
| O2 | orchestrator.js:222 | `pending_choice: '', last_topic: 'question'` | **SESSION** | `active_entities` |
| O3 | orchestrator.js:241 | `pending_choice: ''` | **SESSION** | `active_entities` |
| O4 | orchestrator.js:244 | `pending_choice: ''` | **SESSION** | `active_entities` |
| O5 | orchestrator.js:593 | `out.memory_patch` from `answerInsight` (all 5 emissions in `insights_v0.js` use shape `{ conversation: { active_job_id, active_job_no, active_job_name, last_intent, last_topic, last_totals_mode } }`) | **SESSION** | `active_entities` |

Insights_v0 emission sites (informational — these flow through O5):
- `insights_v0.js:602-610` (job profit ranged)
- `insights_v0.js:639-647` (job profit all-time fallback)
- `insights_v0.js:745-752` (range-only follow-up: profit)
- `insights_v0.js:768-775` (range-only follow-up: profit fallback)
- `insights_v0.js:831-848 / 920-940 / 961` (totals + variants — `last_totals_mode` tracking)

All five emit under the `conversation` namespace — **all SESSION**.

### Reads (3 sites)

| # | Line | What's read | Classification | Notes |
|---|---|---|---|---|
| R1 | answerChief.js:139 | full memory blob | **SESSION** (consumer) | Passed through to orchestrator + agent as `context.actorMemory` |
| R2 | webhook.js:2916 | `pending_choice` only | **SESSION** | Pre-routing: bare-intent follow-up detection |
| R3 | agent/index.js:290 (inside `loadActorMemorySafe`) | full memory blob | **SESSION** | All consumers (`pending_choice`, `pending_intent`, `intake_draft`, `last_job_*`, `last_date_*`, `conversation_history`) are session-scoped |

---

## 4. Classification Summary

| Classification | Count | Target container |
|---|---|---|
| **SESSION** | 36 | `conversation_sessions.active_entities` (34) + `conversation_messages` (2: A1 + A29 — `conversation_history` writes) |
| PERSISTENT | **0** | n/a |
| AMBIGUOUS | 0 | n/a |
| BUG | 2 | (counted separately — both in `services/postgres.js` definitions, see §6) |

**Net:** 100% session-scoped. R4c-migrate is a single-container migration plus the `conversation_history` → `conversation_messages` redirect.

---

## 5. Container Analysis

### 5.1 SESSION container: `conversation_sessions.active_entities` (34 sites)

Per `migrations/2026_04_21_rebuild_conversation_spine.sql:60` and `FOUNDATION_P1_SCHEMA_DESIGN.md` §3.10:

```sql
active_entities  jsonb  NOT NULL DEFAULT '{}'::jsonb
```

Column comment (migration:128-129): *"Tracked entities for reference resolution ('active job', 'date range', etc.) per North Star §14. Subsumes the DISCARDed entity_summary table."*

**Fit assessment:** All 34 patch sites write keys that fit the spec's intent — pending state, active job, date ranges, intake-draft. The current pre-rebuild jsonb shape collapses cleanly:

```jsonc
// Pre-rebuild (chief_actor_memory.memory):
{
  "pending_choice": "log",
  "pending_intent": "expense",
  "intake_draft": { ... },
  "last_job_no": 47,
  "last_job_name": "Mission Exteriors",
  "last_date_from": "2026-04-01",
  "last_date_to": "2026-04-30",
  "last_intent": "profit",
  "last_topic": "job_profit",
  "last_totals_mode": "spend",
  "conversation": { "active_job_id": 47, "active_job_no": 47, ... }   // insights_v0 nested namespace
  // conversation_history was here too (now redirected to conversation_messages)
}

// Post-rebuild (conversation_sessions.active_entities) — same shape, minus conversation_history:
// Identical jsonb structure; the deep-merge of `conversation` subkey can stay
// or flatten into top-level (R4c-migrate decision; both work).
```

**No size concerns.** Largest blob is `intake_draft` + `conversation_history` (last N pairs of trimmed messages). After redirecting history to `conversation_messages`, the active_entities blob is tiny (<2KB typical).

**No write contention concerns.** Writes are per-session-row UPDATEs; current per-`(owner_id, actor_key)` UPSERT becomes per-`(id, tenant_id, owner_id)` UPDATE on the active session. Same access pattern.

**No schema gaps.** The migration's RLS, GRANTs, and composite UNIQUE all align with the rebuild's identity model.

### 5.2 PERSISTENT container: NOT NEEDED

Both options (X = fold into `tenant_knowledge`, Y = new amendment table) are **moot** because zero call sites are PERSISTENT.

For completeness: `tenant_knowledge` PK is `(owner_id, kind, key)` per `migrations/2026_04_22_amendment_tenant_knowledge.sql:75` — NO `user_id` column. So Option X would have required a P1A-5 amendment (PK change is invasive). Option Y would have required authoring a new table. Neither is needed.

If founder later identifies a persistent-fact use case (e.g., a future "remember my favorite vendors" feature), a separate amendment session designs the right container. **R4c-migrate does NOT need to anticipate that.**

### 5.3 History container: `conversation_messages` (2 sites)

A1 (agent/index.js:743-749) and A29 (agent/index.js:1280) write `conversation_history: [...]` — a rolling array of `{role, content}` pairs trimmed to the last N pairs.

Per migration `2026_04_21_rebuild_conversation_spine.sql:139-183`, `conversation_messages` stores per-message rows with `role`, `content`, `sequence_no`, `created_at`. This is the natural target — append a row per turn instead of mutating a jsonb array.

**R4c-migrate semantic:** at A1 and A29, do TWO inserts per turn (one for `role: 'user'`, one for `role: 'chief'`) into `conversation_messages` instead of patching the jsonb. Reads (history slice for LLM seed) become a SELECT with `ORDER BY sequence_no DESC LIMIT N`.

The "rolling" trim behavior (last `MAX_WA_HISTORY_PAIRS * 2`) becomes a query-time concern, not a storage concern. `conversation_messages` is append-only (P3-3a §3.10) so old rows accumulate; trim happens at read time.

---

## 6. Bug Inventory

### Bug B1 — Silent fallback on missing identity in `getActorMemory`

```
Bug ID: B1
File: services/postgres.js
Line: 1099-1115
Severity: MEDIUM
Description: When ownerId or actorKey resolves to empty digit-string after
  `.replace(/\D/g,'')`, function returns {} silently rather than throwing or
  signaling an error.
Impact: A buggy upstream caller (e.g., one that loses ownerId during request
  resolution) will see "fresh memory" — no pending_choice, no last_job — and
  the user gets routed to a new flow as if they were starting over. UX
  confusion; potentially weeks-long bug-hunt to discover the upstream resolution
  failure.
Reproduces in: any flow where req.ownerId is null/empty (would only happen on
  unpaired/unknown WhatsApp senders, who shouldn't be reaching this code anyway —
  the userProfile middleware sets req.ownerId before the agent runs).
Similar to: F2 pattern (silent default rather than fail-closed). Different in
  that F2 caused cross-tenant leakage; B1 only causes UX confusion. Same root
  philosophical issue: silent fallback hides upstream bugs.
Recommended handling: Fix in R4c-migrate as part of removing the legacy
  function. The replacement (a `loadConversationSession` against the rebuild)
  should throw `TENANT_BOUNDARY_MISSING` / `ACTOR_BOUNDARY_MISSING` codes if
  required identity is empty. Existing wrapper `loadActorMemorySafe` already
  catches and returns `{}` on error — preserving the safe-default UX while
  surfacing the underlying bug to logs.
```

### Bug B2 — Silent NO-OP on missing identity in `patchActorMemory`

```
Bug ID: B2
File: services/postgres.js
Line: 1117-1146
Severity: MEDIUM
Description: When ownerId or actorKey resolves to empty after digit-strip,
  function returns silently without writing.
Impact: Patches are silently dropped. The 28 agent call sites + 5 orchestrator
  sites write fire-and-forget patches — a silently-dropped patch means the
  next turn's pending_choice / intake_draft state is missing → flow rebooted
  → user gets re-asked the same question, looks like a confused bot.
Reproduces in: same scenario as B1.
Similar to: B1 (same silent-failure pattern in the partner function).
Recommended handling: Same as B1. The replacement (a `patchConversationSession`)
  should throw on empty boundary keys. Wrapper `patchActorMemorySafe` already
  catches and ignores — surfacing to logs is the win.
```

### Bugs NOT found

- **No F2-style camelCase/snake_case mismatch.** All call sites use `(ownerDigits, actorKey)` matching the function signature `(ownerId, actorKey)`. The function internally renames to `owner_id, actor_key` for SQL — clean.
- **No tenant-boundary holes.** Pre-rebuild `chief_actor_memory` has no tenant_id column at all, so there's nothing to leak. Post-migration, every write must thread `tenant_id` (consequence of migration, not a current bug).
- **No identity-layer mix-up.** Every caller uses owner_id (digit) + actor_key (digit) consistently.
- **No undefined-behavior return shapes.** `getActorMemory` always returns `{}` or a real jsonb; consumers handle both.
- **No CRITICAL or HIGH bugs.** The two MEDIUM bugs are silent-fallback patterns, not active leakage or corruption.

---

## 7. Quarantine + Cross-Service Checks

**Crew quarantine:** zero hits for `chiefos_activity_logs|crewControl|crewReview` in `services/agent/index.js`, `services/answerChief.js`, `services/orchestrator.js`. R3b boundary intact.

**RAG cross-service:** zero hits for `services/tools/rag|services/rag_search|services/answerSupport` in those three files. (The orchestrator imports `ragAnswer` and `answerSupport` for OTHER routes, but those imports are not in actor-memory-calling functions. No tangle.)

---

## 8. Founder Decisions Needed for R4c-migrate

Given the all-SESSION classification, the decision matrix is small:

### D1 — `conversation` jsonb subkey: preserve or flatten?
The current `chief_actor_memory.memory` jsonb has a top-level `conversation: { active_job_*, last_intent, last_topic, ... }` subkey (insights_v0 emits there) AND top-level keys (`pending_choice`, `intake_draft`, `last_job_no`, etc., from agent/orchestrator). The deep-merge logic in `patchActorMemory:1132-1141` specifically merges `conversation` subkey deeply.

For R4c-migrate's `active_entities`:
- **Option A** — preserve the `conversation` subkey nesting. Pros: minimal call-site rewrite. Cons: future readers see two layers for what is logically one concept.
- **Option B** — flatten everything to top-level keys in `active_entities`. Pros: cleaner final shape. Cons: rewrite the 5 insights_v0 emission sites + the readers that destructure `memory.conversation.*`.

**Recommended: Option A (preserve).** Less churn, semantically equivalent. Can flatten in a future cleanup once the migration is stable.

### D2 — `conversation_history` migration: in-jsonb or in conversation_messages?
A1 + A29 write `conversation_history: [{role, content}, ...]` to the jsonb. The rebuild's `conversation_messages` table is the dedicated target.

- **Option A** — leave `conversation_history` in `active_entities` as a jsonb array (mirrors current behavior).
- **Option B** — redirect to `conversation_messages` (one row per `{role, content}` pair, with sequence_no, created_at).

**Recommended: Option B (redirect).** This is the spec-intended path. It also unlocks proper observability (per-message RLS, append-only auditability per §3.10). R4c-migrate cost is small: ~2 new INSERTs per turn instead of 1 jsonb patch, and a SELECT for history-slice on read.

### D3 — Session lifecycle: how to map `(owner_id, actor_key)` to `conversation_sessions(id, tenant_id, owner_id, user_id)`?
Pre-rebuild, the row is keyed by `(owner_id, actor_key)` — one row per actor per owner, lives forever. The rebuild's `conversation_sessions` adds `id uuid PK` and supports session lifecycle (`started_at`, `last_activity_at`, `ended_at`, `end_reason`).

Two valid models:
- **Option A** — single long-lived session per `(tenant_id, owner_id, user_id)` triple, never closes. Behaviorally identical to pre-rebuild.
- **Option B** — multiple sessions per actor with TTL (e.g., close after 30 min idle, open new on next message). Matches the spec's intent (`end_reason CHECK ('timeout', 'user_reset', 'context_limit')`).

**Recommended: Option B (TTL sessions).** This is what `conversation_sessions` was designed for. Implementation: on every `loadActorMemorySafe`, check for an open session newer than TTL; if expired, close (set `ended_at`, `end_reason='timeout'`) and start a new one. The active_entities jsonb resets per session — which is *correct* behavior for pending state (a 6-hour-old `pending_choice='log'` shouldn't carry into a new conversation).

But this is a behavior change. Founder confirmation needed before R4c-migrate adopts Option B.

### D4 — Bug fix scope: in R4c-migrate or separate?
B1 + B2 are MEDIUM. Fixing them in R4c-migrate is natural (the replacement functions get the throw guards baked in from the start). Confirming: fix in R4c-migrate, no separate session.

---

## 9. Open Questions

1. **Is `services/insights_v0.js` SESSION-only forever?** Today its `memory_patch` emissions are all SESSION. If a future "remember my preferred totals_mode across sessions" feature lands, this would shift to PERSISTENT. Not a current concern. R4c-migrate doesn't need to plan for it.

2. **Does any post-Beta feature need the silent-NO-OP behavior of B2?** I.e., does anything rely on patches being silently dropped when identity is missing? Doesn't appear so — all callers wrap in try/catch and continue. Confirming: throw + log is strictly better.

3. **Is there a planned `actorKey ≠ user_id` use case?** Today they're equivalent (both phone digits). If a future portal-side actor (e.g., browser session id) needed to write actor memory, `actorKey` would diverge from `user_id`. Not a current concern.

---

## 10. R4c-migrate Entry Readiness

**Ready when founder decides:**
- D1 (preserve vs flatten `conversation` subkey) — recommend preserve
- D2 (history → conversation_messages) — recommend redirect
- D3 (TTL sessions vs forever-session) — recommend TTL with founder confirmation
- D4 (bugs in R4c-migrate or separate) — recommend in R4c-migrate

**No prerequisite blockers:**
- No P1A-5 amendment needed (no PERSISTENT container).
- No bug-fix-only session needed.
- No crew/RAG/actor-memory cross-cluster surprises surfaced.

**R4c-migrate scope (preview, founder-decision-pending):**
- Migrate 36 call sites: 34 → `conversation_sessions.active_entities`, 2 → `conversation_messages` writes.
- Migrate 3 read sites: 2 stay simple (load active session row), 1 (history-slice for agent LLM seed) becomes a SELECT against `conversation_messages`.
- Add session-resolution helper (`getOrCreateActiveSession({ tenantId, ownerId, userId, ttlMs })`) that's called by `loadActorMemorySafe`'s replacement.
- Wire `tenant_id` through all writers (caller audit at R4c-migrate time — most callers already have `req.tenantId` available).
- Replace `getActorMemory` / `patchActorMemory` exports in `services/postgres.js` with deprecation stubs that throw `DEPRECATED` (briefly, so any missed call site surfaces in logs); remove entirely after one Beta cycle.
- Fix B1 + B2 by making replacement functions fail-closed throw on empty identity.

Estimated: 1 substantial session (~150-200 line changes across 4 files), no schema work.

---

## 11. Files Modified

**Zero.** Per directive scope, R4c-investigate is investigation-only.

---

**End of R4c-investigate report.** Awaiting founder decisions D1-D4 to author R4c-migrate directive.
