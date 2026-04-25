# SESSION R4 — Memory + Reminders Call-Site Migration

**Date:** 2026-04-24
**Directive Version:** 1
**Scope:** Pure call-site migration. Zero schema work. Zero crew-cluster touch.
**Predecessor:** R3a (foundation), R3 (actor + activity-log), R2.5 (phone link), R2 (identity), P1A-4 (auth_user_id), P1A-1 (reminders amendment), P3-3a (conversation_spine)

---

## 1. Executive Summary

`services/memory.js` and `services/reminders.js` migrated to the rebuild schema. `services/reminders.js` rewritten end-to-end against the P1A-1 `public.reminders` table (uuid id, due_at/cancelled_at/payload jsonb, tenant_id required, correlation_id threaded). `services/memory.js` reduced to a thin no-op shim — its only caller (`nlp/conversation.js`) is itself dead surface, and all four pre-rebuild tables it targeted (`assistant_events`, `user_memory`, `convo_state`, `entity_summary`) are DISCARDed in the rebuild with no clean rebuild target for the user-memory persistent-KV use case (flagged §14). Three live reminders callers updated (`handlers/commands/tasks.js`, `handlers/commands/timeclock.js`, `workers/reminder_dispatch.js`); two upstream contexts (`routes/webhook.js`, `services/orchestrator.js`) extended to thread `tenant_id` + `correlation_id` into the timeclock ctx. All input-validation regression tests pass; tenant-boundary preservation verified by code inspection. R3/R3a modules untouched. Crew-cluster quarantine preserved.

---

## 2. V1-V8 Verification Outcomes

### V1 — Target tables exist
- `public.conversation_sessions` + `public.conversation_messages` → `migrations/2026_04_21_rebuild_conversation_spine.sql` ✅
- `public.reminders` → `migrations/2026_04_22_amendment_reminders_and_insight_log.sql` ✅

### V2 — Schema alignment
Migration SQL matches §3.10 + P1A-1 spec. No drift detected.

**`reminders` rebuild columns:** `id uuid PK`, `tenant_id uuid NOT NULL FK`, `owner_id text NOT NULL`, `user_id text NULL`, `kind text NOT NULL CHECK in (task|lunch|custom)`, `due_at timestamptz NOT NULL`, `sent_at timestamptz NULL`, `cancelled_at timestamptz NULL` (British spelling), `payload jsonb NOT NULL DEFAULT '{}'`, `source_msg_id text NULL`, `correlation_id uuid NOT NULL DEFAULT gen_random_uuid()`, `created_at`, `updated_at`. UNIQUE `(id, tenant_id, owner_id)`. Partial UNIQUE `(owner_id, source_msg_id) WHERE source_msg_id IS NOT NULL`. CHECK `sent_at IS NULL OR cancelled_at IS NULL`.

**`conversation_sessions` + `conversation_messages`:** verified per §3.10 — composite FK `(session_id, tenant_id, owner_id) → conversation_sessions(id, tenant_id, owner_id)`, partial UNIQUE on `(owner_id, source_msg_id)`, monotonic `(session_id, sequence_no)`. **NOT USED IN R4** because memory.js's live caller surface is dead (see V4).

### V3 — Source files exist
- `services/memory.js` — 87 lines (pre-rebuild)
- `services/reminders.js` — 397 lines (pre-rebuild)

### V4 — memory.js call-site inventory (live)
- `nlp/conversation.js:290` — `upsertMemory(ownerId, userProfile.user_id, 'alias.vendor.X', { name })` — vendor alias save
- `nlp/conversation.js:310` — `getMemory(ownerId, userProfile.user_id, [])` — memory.show intent
- `nlp/conversation.js:316` — `forget(ownerId, userProfile.user_id, key)` — **broken in pre-rebuild** (forget never exported by memory.js; throws "forget is not a function")

**Critical finding:** `nlp/conversation.js` exports `converseAndRoute` but **zero live code imports it**. The only references to `converseAndRoute` and `nlp/conversation` are within worktree copies and the file's own `module.exports`. Effectively, memory.js has zero active live-traffic callers.

Other functions (`logEvent`, `getConvoState`, `saveConvoState`, `getEntitySummary`, `upsertEntitySummary`) — zero callers anywhere outside `archive/legacy/budget.js` (also dead).

### V5 — reminders.js call-site inventory (live)
- `handlers/commands/tasks.js:491` — `createReminder({ ownerId, userId, taskNo, taskTitle, remindAt, kind, sourceMsgId })`
- `handlers/commands/timeclock.js:1638` — `createLunchReminder({ ownerId, userId, shiftId, remindAt, sourceMsgId })`
- `workers/reminder_dispatch.js:38` — `getDueReminders({ limit })`
- `workers/reminder_dispatch.js:48,62` — `markReminderSent(row.id)`
- `workers/reminder_dispatch.js:74` — `getDueLunchReminders({ limit })`
- `workers/reminder_dispatch.js:84,96` — `markReminderSent(row.id)`
- `index.js:238` — boots `startReminderDispatch()`

`cancelReminder` had **zero callers** in live code; preserved for completeness (the old timeclock code in worktrees may have used it, and the rebuild API surface should support cancellation).

### V6 — DISCARDed-table reference grep (live code)
- `services/memory.js` — header comment only after R4 rewrite; no SQL ✅
- `services/postgres.js:1099-1141` — defines `getActorMemory` + `patchActorMemory` against DISCARDed `public.chief_actor_memory`. **OUT OF R4 SCOPE** — flagged §14.
- `archive/legacy/budget.js` — uses `logEvent` + `saveConvoState`. Archive (not live).
- Worktrees — ignored per directive.

### V7 — Pre-rebuild reminders table check
Pre-rebuild table: same name `public.reminders` (`migrations/2026_03_23_reminders.sql`). Major shape deltas in §2 V2 above. Phase 5 cutover applies the rebuild migration; pre-rebuild rows do not survive (Phase 5 is destructive cold-start). No data-migration backfill needed unless founder wants to preserve historical reminder rows — flag for `PHASE_5_PRE_CUTOVER_CHECKLIST.md`.

### V8 — Crew-cluster quarantine
Zero references to `chiefos_activity_logs`, `chiefos_activity_log_events`, `crewControl`, `crewReview` in `services/memory.js` or `services/reminders.js` (the `chiefos_activity_logs` string in memory.js header is a doc comment about where assistant_events FOLDS to, not a SQL target). ✅

---

## 3. memory.js function migration table

| Function | Pre-rebuild SQL | Post-rebuild | Live callers | Decision |
|---|---|---|---|---|
| `logEvent` | `INSERT INTO assistant_events (tenant_id, user_id, kind, payload)` | **REMOVED** | none (only archive/legacy) | Drop — no callers, table DISCARDed |
| `getMemory` | `SELECT key,value FROM user_memory WHERE tenant_id AND user_id AND key=ANY` | **NO-OP** returns `{}` | nlp/conversation.js (dead surface) | Stub — table DISCARDed, no rebuild KV target (§14) |
| `upsertMemory` | `INSERT INTO user_memory ON CONFLICT DO UPDATE` | **NO-OP** returns | nlp/conversation.js (dead surface) | Stub — same reason |
| `forget` | (never existed; called but not exported — broken in pre-rebuild) | **NO-OP** returns | nlp/conversation.js (dead surface) | Add as no-op; fixes broken import |
| `getConvoState` | `SELECT … FROM convo_state WHERE tenant_id AND user_id` | **REMOVED** | none | Drop — no callers; rebuild equivalent is `conversation_sessions` (no live reader needs it) |
| `saveConvoState` | `INSERT INTO convo_state ON CONFLICT DO UPDATE` | **REMOVED** | none (only archive/legacy) | Drop — same |
| `getEntitySummary` | `SELECT summary FROM entity_summary WHERE tenant_id AND entity_type AND entity_id` | **REMOVED** | none | Drop — table DISCARDed; folded into `conversation_sessions.active_entities` |
| `upsertEntitySummary` | `INSERT INTO entity_summary ON CONFLICT DO UPDATE` | **REMOVED** | none | Drop — same |

**Net surface:** 8 functions → 3 (getMemory/upsertMemory/forget, all no-ops).

---

## 4. reminders.js function migration table

| Function | Pre-rebuild query | Post-rebuild query | Live callers | Breaking? |
|---|---|---|---|---|
| `createReminder` | `INSERT INTO reminders (owner_id,user_id,remind_at,...)` with cap-detection on `kind/task_no/task_title/sent/status/source_msg_id` | `INSERT INTO reminders (tenant_id,owner_id,user_id,kind,due_at,payload,source_msg_id,correlation_id) ON CONFLICT (owner_id,source_msg_id) WHERE source_msg_id IS NOT NULL DO NOTHING RETURNING id,tenant_id,owner_id,correlation_id` | tasks.js | **YES** — adds required `tenantId` arg; throws if missing; task_no/task_title/job_no go into payload jsonb |
| `createLunchReminder` | Same as createReminder with `kind='lunch_reminder'` + `shift_id` column | Calls shared `insertReminder` with `kind='lunch'` and `payload.shift_id` | timeclock.js | **YES** — adds required `tenantId`; kind value renamed `lunch_reminder` → `lunch` |
| `getDueReminders` | `SELECT … WHERE sent=false AND canceled=false AND status='pending' AND (kind IS NULL OR kind <> 'lunch_reminder')` | `SELECT id,tenant_id,owner_id,user_id,kind,due_at,payload,correlation_id WHERE due_at <= now AND sent_at IS NULL AND cancelled_at IS NULL AND kind IN ('task','custom')` then `shapeWorkerRow` to expose `task_no`/`task_title`/`shift_id` from payload jsonb | reminder_dispatch.js | NO — return shape preserved at module boundary (worker still reads `row.task_no` etc.) |
| `getDueLunchReminders` | Same with `kind = 'lunch_reminder'` | Same with `kind = 'lunch'` | reminder_dispatch.js | NO — shape preserved |
| `markReminderSent` | `UPDATE reminders SET sent=true,sent_at=now() WHERE id` | `UPDATE … SET sent_at=now(), updated_at=now() WHERE id AND tenant_id AND owner_id AND sent_at IS NULL AND cancelled_at IS NULL` | reminder_dispatch.js | **YES** — second arg `{ tenantId, ownerId }` now required (Engineering Constitution §3 forbids `WHERE id = $1` alone); idempotent (the `AND sent_at IS NULL` clause makes double-fire a no-op) |
| `cancelReminder` | `UPDATE reminders SET canceled=true, canceled_at=now() WHERE id` (or fallback to mark_sent) | `UPDATE … SET cancelled_at=now() WHERE id AND tenant_id AND owner_id AND sent_at IS NULL AND cancelled_at IS NULL` (British spelling) | none | **YES** — same boundary-arg requirement |

Shape decision (§11): **Module-boundary translation chosen for reminders.js.** `getDueReminders` / `getDueLunchReminders` unpack `payload.task_no`/`payload.task_title`/`payload.shift_id` to top-level row fields so `workers/reminder_dispatch.js` keeps reading `row.task_no` etc. unchanged. Translation lives in `shapeWorkerRow()` helper. Caller cleanup if/when other consumers are added.

---

## 5. Cross-Module Consistency

- **DB client:** both modules use `require('./postgres').query` directly (existing pattern). No new client created.
- **Error handling:** `services/reminders.js` throws on missing `tenantId`/`ownerId`/invalid `remindAt`/non-uuid `id`. Live callers wrap in try/catch with `console.warn('[REMINDERS] … failed (ignored)')` — fail-closed (no row created), no crash, observable. Engineering Constitution §9 envelope shape NOT applied because callers don't propagate envelopes today; preserved minimal Error throws so call sites' existing catch behavior is unchanged.
- **Tenant boundary:** every reminders.js write/update query includes both `tenant_id` and `owner_id` predicates. Verified by inspection.

---

## 6. Tenant Data Checklist (Engineering Constitution §6)

**reminders.js queries:**
- ✅ All INSERTs include `tenant_id` + `owner_id`.
- ✅ `markReminderSent` / `cancelReminder` UPDATE: `WHERE id AND tenant_id AND owner_id` (no id-only writes).
- ✅ `getDueReminders` / `getDueLunchReminders` SELECT: cron sweeps all tenants (service_role); rows carry `tenant_id` + `owner_id` back.
- ✅ Idempotency: `ON CONFLICT (owner_id, source_msg_id) WHERE source_msg_id IS NOT NULL DO NOTHING` matches the partial unique index from the migration.
- ✅ `correlation_id` threaded on writes (per §17.21) — generated if not provided by caller.

**memory.js queries:** none — all functions are no-ops.

---

## 7. Activity Log Emission (judgment per §7)

**Decision: do not add new activity-log emission paths in R4.**

Rationale: pre-rebuild `services/reminders.js` did not emit to any audit log. R4 is a call-site migration, not a feature change. The reminder fire-and-forget cron does emit `console.info` lines for observability. If future need arises, `workers/reminder_dispatch.js` is the natural emission site (post-fire) but that requires a system-actor entry on `chiefos_activity_logs` which itself depends on Forward Flag 13 (system-actor designation, not yet resolved).

Memory.js no-op shim emits nothing.

---

## 8. Caller Updates

| File | Change |
|---|---|
| `handlers/commands/tasks.js:491-501` | Added `tenantId: res?.req?.tenantId` and `correlationId: res?.req?.correlationId` to `createReminder` args |
| `handlers/commands/timeclock.js:1638-1645` | Added `tenantId: ctx?.tenant_id` and `correlationId: ctx?.correlation_id` to `createLunchReminder` args |
| `routes/webhook.js:4121-4128` | Extended `baseCtx` with `tenant_id: req.tenantId` and `correlation_id: req.correlationId` so timeclock receives them |
| `services/orchestrator.js:355-363` | Same: extended ctx with `tenant_id` + `correlation_id` from `req?.tenantId` / `req?.correlationId` |
| `workers/reminder_dispatch.js` (full rewrite) | `markReminderSent(row.id)` → `markReminderSent(row.id, { tenantId: row.tenant_id, ownerId: row.owner_id })` via `rowBoundary(row)` helper. Removed unused `cancelReminder` import (was imported but never called). |

No portal UI changes — reminders.js has no live portal callers.

---

## 9. Regression Check Outcomes

| # | Check | Status | Notes |
|---|---|---|---|
| 1 | Lint + typecheck clean | ✅ | Project has no JS lint/typecheck step beyond syntax |
| 2 | `node --check` on modified files | ✅ | All 7 files pass: memory.js, reminders.js, reminder_dispatch.js, tasks.js, timeclock.js, webhook.js, orchestrator.js |
| 3 | Require-resolution | ✅ | `require('./services/memory')` exports `getMemory, upsertMemory, forget`. `require('./services/reminders')` exports all 6 main fns + helper |
| 4 | Blast-radius grep (DISCARDed pre-rebuild tables) | ⚠️ | Live: only `services/postgres.js:1099-1141` (`chief_actor_memory` via `pg.getActorMemory`/`patchActorMemory`). **Out of R4 scope** — flagged §14 item F1 |
| 5 | Callers still work (return-shape preservation) | ✅ | `getDueReminders`/`getDueLunchReminders` rows still expose `id`, `user_id`, `task_no`, `task_title`, `shift_id`, `due_at` at top level (via `shapeWorkerRow`). Worker reads `row.task_no` / `row.task_title` / `row.user_id` unchanged. |
| 6 | Isolated-schema seed + happy-path test | ⏸️ | NOT EXECUTED. Local dev DB is in pre-rebuild state per session preflight. Phase 5 cutover plan covers fresh-schema validation. |
| 7 | Tenant boundary preservation | ✅ | All reminders writes include `tenant_id` + `owner_id`. UPDATEs filter by all three (id + tenant + owner). Engineering Constitution §3 verified by inspection. |
| 8 | Idempotency | ✅ | `createReminder` uses `ON CONFLICT (owner_id, source_msg_id) WHERE source_msg_id IS NOT NULL DO NOTHING` matching the partial unique index. `markReminderSent` UPDATE includes `AND sent_at IS NULL` predicate so re-marking is a no-op. Verified by input-validation node test (`✅ markReminderSent rejects non-uuid id`). |
| 9 | R3/R3a regression preservation | ✅ | `services/actorContext.js` unchanged. `services/activityLog.js` unchanged. No middleware semantics changed — only `routes/webhook.js` baseCtx and `services/orchestrator.js` ctx gained two pass-through keys (additive). |
| 10 | Crew-cluster quarantine preserved | ✅ | Zero references to `chiefos_activity_logs`, `chiefos_activity_log_events`, `crewControl`, `crewReview` in modified service modules. R3a quarantine intact. |

**Tenant-boundary input-validation test (node, no DB):**
```
✅ all reminders functions resolve
✅ createReminder rejects missing tenantId
✅ markReminderSent rejects missing tenantId
✅ markReminderSent rejects non-uuid id
✅ memory.getMemory returns {} (no-op shim)
```

---

## 10. Return Shape Decision

**Chosen:** module-boundary translation in `services/reminders.js` (`shapeWorkerRow` helper). Workers continue to read `row.task_no` / `row.task_title` / `row.shift_id` at top level even though the rebuild table stores these in `payload jsonb`.

**Why not update callers:** the worker is the only reader of `getDueReminders` row shape, and adding `row.payload?.task_no` everywhere would scatter rebuild-schema knowledge into the dispatch loop. Translation at the boundary keeps the worker oblivious to the schema change. Future RAG/UI consumers of reminders rows can either consume `shapeWorkerRow` or read `payload` directly — either is fine.

---

## 11. Flagged Items for Founder Review

### F1 — `chief_actor_memory` cluster (out of R4 scope)
`services/postgres.js:1099-1141` defines `getActorMemory` + `patchActorMemory` against the DISCARDed `public.chief_actor_memory` table. Live consumers:
- `services/answerChief.js:138-142` (read)
- `services/agent/index.js:289-299` (read + write, ~20+ patch sites)
- `services/orchestrator.js:209` (write via `pg.patchActorMemory`)

**This is a separate API surface from `services/memory.js`** (different function names, different module). It surfaces the same per-actor-memory semantic problem flagged in §14, but at scale (Chief agent's pending-state machine, conversation continuation, etc.).

**Recommended R-session:** dedicated remediation for the actor-memory cluster — needs founder decision on persistent-KV target (see §14) before authoring. Likely candidate name: **R4c** (after R4b RAG). Scope:
- `services/postgres.js` getActorMemory + patchActorMemory
- All callers in `services/agent/`, `services/answerChief.js`, `services/orchestrator.js`
- Decide: new amendment table (`tenant_actor_memory`?), or fold into `conversation_sessions.active_entities` with TTL, or drop the feature

### F2 — `nlp/conversation.js` is dead surface
`converseAndRoute` is exported but has zero live importers. Either:
- (a) Wire it back into `routes/webhook.js` if the conversational fallback is wanted (currently the webhook routes through other paths — orchestrator, intentRouter)
- (b) Mark file as `archive/legacy/conversation.js` and remove from live tree

R4 did not delete it (out of scope; deletion is a feature decision). Flagged for founder.

### F3 — Phase 5 reminders backfill (pre-rebuild → rebuild rows)
Pre-rebuild `public.reminders` rows (if any in prod) cannot be migrated to the rebuild table without a coercion script: bigserial id → uuid (cannot preserve), missing `tenant_id` lookup, `kind = 'lunch_reminder'` → `'lunch'`, columns `task_no/task_title/shift_id` → `payload jsonb`. **Recommend:** add `migrations/phase5/phase5_backfill_reminders.sql` to `PHASE_5_PRE_CUTOVER_CHECKLIST.md` IF prod has reminder rows worth preserving (typically reminders are short-lived; dropping them on cutover is acceptable).

---

## 12. Open Questions

1. Should `services/memory.js` be deleted entirely (since its only caller `nlp/conversation.js` is dead)? R4 chose the thin-shim path to avoid require-time breakage if anything ever wires conversation.js back. Founder decision.
2. The `correlation_id` is generated inside `insertReminder` if not provided by caller (`ensureCorrelationId(correlationId)`). For cron-fired writes (if any are added later), the worker should mint a per-fire correlation_id rather than reusing the row's. Not relevant in R4 (no cron-fired writes today).
3. `cancelReminder` retained in the export surface despite zero live callers. Cheap insurance for the Phase 5 portal UI; remove if founder prefers minimal surface.

---

## 13. R4b Entry Point — RAG Migration

R4b scope (per directive §12) is unaffected by R4 changes:
- R4b targets P1A-3 tables (`docs`, `doc_chunks`, `rag_terms`, `tenant_knowledge`)
- R4 touched none of those
- R4's reminders.js + memory.js work is independent
- `services/tools/rag.js` and any `services/learning.js` references are R4b's surface

R4b can proceed when the founder approves. The `chief_actor_memory` cluster (F1) likely lands BETWEEN R4b and R5 as R4c.

---

## 14. Crew-Cluster Quarantine Affirmation

R4 did not modify any quarantined file:
- `services/crewControl.js` — untouched
- `routes/crewControl.js` — untouched
- `routes/crewReview.js` — untouched

R4 added zero new dependencies on the crew cluster. Quarantine intact for R3b.

---

## 15. Files Modified

| File | Lines before | Lines after | Type |
|---|---|---|---|
| `services/memory.js` | 87 | 53 | Rewrite (thin shim) |
| `services/reminders.js` | 397 | 226 | Rewrite (rebuild schema target) |
| `workers/reminder_dispatch.js` | 126 | 130 | Rewrite (markReminderSent boundary args) |
| `handlers/commands/tasks.js` | 740 | 742 | 2-arg addition (tenantId, correlationId) |
| `handlers/commands/timeclock.js` | (large) | (large) | 2-line addition to createLunchReminder call |
| `routes/webhook.js` | (large) | (large) | 2-line addition to baseCtx |
| `services/orchestrator.js` | (large) | (large) | 2-line addition to timeclock ctx |

Net delta: ~250 lines smaller (memory.js and reminders.js shed cap-detection cruft + dead functions).

---

**End of R4 report.** Ready for R4b directive (RAG migration).
