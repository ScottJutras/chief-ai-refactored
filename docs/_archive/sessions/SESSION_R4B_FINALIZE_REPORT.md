# SESSION R4b-finalize — F2 Fix + Phase 5 Checklist Updates

**Date:** 2026-04-24
**Directive Version:** 1
**Scope:** Apply F2 fail-closed throw to `services/tools/rag.js`, add Phase 5 pre-cutover checklist entries. Closes R4b.
**Predecessor:** R4b audit (Classification C, founder selected Option (b) + F2 fix)

---

## 1. Executive Summary

R4b's flagged F2 (`services/tools/rag.js` `ownerId='GLOBAL'` default → cross-tenant leakage when callers omit ownerId, since the module's own `pg.Pool` bypasses RLS) is **resolved** via fail-closed throws on `searchRag`, `answer`, and `ragTool.__handler`. Caller audit confirmed the only live importer (`services/agent/index.js`) injects `args.owner_id` from request context at line 526, so the throw never fires under normal operation. `services/tools/rag.js` is the only code file modified (4 small changes across 3 functions + 1 tool spec description). `PHASE_5_PRE_CUTOVER_CHECKLIST.md` extended with the R4b subsection in §4 and a new checkbox in §5. All 9 regression checks pass.

---

## 2. V1-V4 Verification Outcomes

### V1 — F2 lines still present ✅
4 hits matching the R4b audit's lines 80, 115, 127, 182:
- `services/tools/rag.js:100` — `[ownerId || 'GLOBAL', vec, limit]` (inside `pgSearch` query bind)
- `services/tools/rag.js:115` — `async function searchRag({ ownerId = 'GLOBAL', query, k = 8 })`
- `services/tools/rag.js:127` — `async function answer({ from, query, hints = [], ownerId = 'GLOBAL' } = {})`
- `services/tools/rag.js:182` — `searchRag({ ownerId: args.ownerId || 'GLOBAL', query: args.query, k: args.k || 8 })` inside `ragTool.__handler`

(R4b audit cited line 80 — that's the `pgSearch` function signature itself, not a default. The actual literal `'GLOBAL'` lives at line 100 in the query bind. Mapping otherwise matches. No surprise — same 4 sites.)

### V2 — pg.Pool ownership confirmed ✅
Lines 14-28: module owns its own `pg.Pool` via `require('pg')`. Connection string from `DATABASE_URL` / `POSTGRES_URL` / `SUPABASE_DB_URL`. Connects as superuser → bypasses RLS. **Documented; not changed in this session** (F2 option (b) consolidate-to-`services/postgres.js` deferred per directive §9).

### V3 — Caller audit ✅

| Caller | Line | Passes ownerId? | Evidence |
|---|---|---|---|
| `services/agent/index.js:39` | `rag = require('../tools/rag')` | ✅ Indirect via tool framework | Module loaded; only `ragTool` registered as a tool spec at line 60 |
| `services/agent/index.js:526` | Tool dispatch loop | ✅ Always (snake_case `args.owner_id`) | `args.owner_id = args.owner_id \|\| ownerId;` — agent injects `owner_id` from request context into every tool call |
| `services/tools/rag.js:152` (internal) | `answer` calls `searchRag` | ✅ Yes | Passes `ownerId` parameter through |
| `services/tools/rag.js:182` (internal) | `ragTool.__handler` calls `searchRag` | ✅ After fix | Was: `args.ownerId \|\| 'GLOBAL'`. Now: `args.owner_id \|\| args.ownerId` (no fallback; throws if both missing) |

**Critical finding from V3:** the original `__handler` read `args.ownerId` (camelCase) but `services/agent/index.js:526` injects `args.owner_id` (snake_case). They didn't match. So the LLM was the only thing populating `args.ownerId`, and the schema didn't require it — meaning the GLOBAL fallback fired almost always in practice. Fix reads from both spellings (preferring the agent injection) and removes the fallback. Tool spec description updated to reflect that the agent loop auto-injects.

### V4 — Quarantine re-check ✅
Zero crew + zero actor-memory references in `services/tools/rag.js` before or after F2 fix. R3b + R4c quarantines intact.

---

## 3. F2 Fix Diff

**File:** `services/tools/rag.js`

### Change 1 — `pgSearch` query bind (line 100)

```diff
-      [ownerId || 'GLOBAL', vec, limit]
+      [ownerId, vec, limit]
```

`pgSearch` is internal-only (called by `searchRag`). Its caller now validates ownerId before invoking, so the `|| 'GLOBAL'` fallback was redundant.

### Change 2 — `searchRag` (lines 115-118 → 115-122)

```diff
-async function searchRag({ ownerId = 'GLOBAL', query, k = 8 }) {
+async function searchRag({ ownerId, query, k = 8 }) {
+  if (!ownerId || typeof ownerId !== 'string') {
+    const err = new Error('searchRag: ownerId is required (fail-closed per North Star §14)');
+    err.code = 'TENANT_BOUNDARY_MISSING';
+    throw err;
+  }
   initOnce();
```

### Change 3 — `answer` (line 127)

```diff
-async function answer({ from, query, hints = [], ownerId = 'GLOBAL' } = {}) {
+async function answer({ from, query, hints = [], ownerId } = {}) {
+  if (!ownerId || typeof ownerId !== 'string') {
+    const err = new Error('answer: ownerId is required (fail-closed per North Star §14)');
+    err.code = 'TENANT_BOUNDARY_MISSING';
+    throw err;
+  }
   const q = String(query || '');
```

### Change 4 — `ragTool.__handler` (lines 181-184)

```diff
   __handler: async (args) => {
-    const result = await searchRag({ ownerId: args.ownerId || 'GLOBAL', query: args.query, k: args.k || 8 });
+    // services/agent/index.js:526 injects args.owner_id from request context;
+    // also accept args.ownerId from LLM-emitted spec for back-compat. No
+    // 'GLOBAL' fallback — searchRag throws TENANT_BOUNDARY_MISSING which the
+    // agent loop catches and feeds back to the LLM as a tool-call error.
+    const ownerId = args.owner_id || args.ownerId;
+    const result = await searchRag({ ownerId, query: args.query, k: args.k || 8 });
     return { results: result };
   },
```

### Change 5 — Tool spec description (line 184)

```diff
-        ownerId: { type: 'string', description: 'tenant id or "GLOBAL"' },
+        ownerId: { type: 'string', description: 'owner_id digit-string for the current tenant; auto-injected by agent loop' },
```

Description was misleading post-fix (no GLOBAL fallback exists). Updated to describe actual behavior (agent injection populates this).

**Net change:** +14 lines, –4 lines across 3 functions + 1 tool spec parameter description. Function signatures preserved; arity unchanged; success-path return shapes unchanged.

---

## 4. Phase 5 Checklist Updates

**File:** `PHASE_5_PRE_CUTOVER_CHECKLIST.md`

### Addition 1 — §4 new subsection

Inserted after the existing R3a "crew cluster Phase 5 blocker" subsection, before §5. Header: `### Added from R4b (RAG schema compliance)`. Content includes:
- Schema-compliance assertion (live RAG code aligned with P1A-3)
- Pre-cutover SQL verifications (3 queries: rag_terms dupe check, baseline counts query, tenant_knowledge note)
- F2 status note (resolved in R4b-finalize)
- Post-Beta deferred items list (F1, F2 option-b, F3, F4)

### Addition 2 — §5 new checkbox

Inserted between "Review data migration recipes in §4" and "Run P1A-4 pairing-data backfill":

```markdown
- [ ] Verify `rag_terms` has no `lower(term)` duplicates per §4 "Added from R4b" subsection. Rebuild migration adds UNIQUE; duplicates would reject.
```

Checklist structure preserved; existing entries untouched.

---

## 5. Tenant Data Checklist (Engineering Constitution §6)

For the F2 fix specifically:

- [x] Every affected function throws before executing any DB query if `ownerId` is missing or non-string. Verified by regression #3 (4/4 throws fired).
- [x] The thrown error has `code: 'TENANT_BOUNDARY_MISSING'` for upstream discrimination. Verified by regression #3 (all 4 caught with expected `code`).
- [x] No query path can execute with `ownerId = 'GLOBAL'` as an implicit default. Verified by regression #5 blast-radius grep: only residual hit is in an explanatory comment (line 194).
- [x] No new cross-tenant read path introduced. The fix narrows the existing path; no widening.
- [x] No new write path introduced. Module is read-only (vector + JOIN SELECT).
- [x] Tenant boundary check happens before any side effect. Throw is the first statement after destructure in `searchRag` and `answer`.

All pass.

---

## 6. Regression Check Outcomes

| # | Check | Status | Notes |
|---|---|---|---|
| 1 | Lint + `node --check` on `services/tools/rag.js` | ✅ | Clean |
| 2 | Require-resolution | ✅ | `require('./services/tools/rag')` exports `answer, searchRag, ragTool` (unchanged) |
| 3 | Throw behavior test (4 cases) | ✅ | searchRag missing/null + answer missing + ragTool.__handler missing — all 4 throw `TENANT_BOUNDARY_MISSING` |
| 4 | Caller compatibility | ✅ | Sole live caller (`services/agent/index.js:526`) injects `args.owner_id` from request context. `__handler` reads `args.owner_id \|\| args.ownerId` — agent injection always populates. Throw never fires under normal operation. |
| 5 | Blast-radius grep (residual `'GLOBAL'` defaults) | ✅ | One hit at line 194 — inside the explanatory comment in `__handler`. No live code path uses GLOBAL as a fallback. |
| 6 | Crew quarantine preserved | ✅ | Zero refs in `services/tools/rag.js` |
| 7 | Actor-memory quarantine preserved | ✅ | Zero refs in `services/tools/rag.js` |
| 8 | R3/R3a/R4/R4b-audit regression | ✅ | Zero changes to `services/actorContext.js`, `services/activityLog.js`, `services/memory.js`, `services/reminders.js`, `workers/reminder_dispatch.js`. R4b audit report file unchanged (`SESSION_R4B_REMEDIATION_REPORT.md`). |
| 9 | Phase 5 checklist syntax clean | ✅ | New subsection follows existing `### Added from <session>` pattern; new checkbox uses standard `- [ ]` format. Header outline (grep `^## \|^### `) shows correct §4/§5 boundary. |

---

## 7. Quarantine Affirmations

**Crew cluster:** R4b-finalize touched zero quarantined files. `services/crewControl.js`, `routes/crewControl.js`, `routes/crewReview.js` unchanged. R3b boundary intact.

**Actor-memory cluster:** R4b-finalize did not touch `services/postgres.js` `getActorMemory`/`patchActorMemory` or any of their callers. R4c-investigate scope unaffected.

---

## 8. Flagged Items

**None new.** All R4b audit flags (F1, F3, F4, F2 option-b consolidate) remain deferred per their R4b §11 classifications. F2 is closed by this session.

One observation worth recording (not a flag, just context): the `ragTool` parameter spec uses camelCase (`ownerId`) while `services/agent/index.js` and other tool specs (`search_transactions`, `get_transaction`, `get_spend_summary`) use snake_case (`owner_id`). The fix's `args.owner_id || args.ownerId` reader bridges this so it works regardless. Future cleanup could harmonize the spec to snake_case for consistency — out of R4b-finalize scope.

---

## 9. Open Questions

**None.** Tight session, all decisions documented in the directive.

---

## 10. R4c-investigate Entry Point

R4c-investigate scope (per R4b directive §10 + R4 report F1) is unaffected by R4b-finalize:
- ~25+ `patchActorMemory` call sites in `services/agent/index.js`
- callers in `services/answerChief.js`, `services/orchestrator.js`
- classification of session-scoped vs persistent-cross-session usage

R4b-finalize touched none of these. R4c-investigate ready to start.

---

## 11. Files Modified

| File | Change | Lines |
|---|---|---|
| `services/tools/rag.js` | F2 fix: fail-closed throws + tool spec description | +14 / –4 |
| `PHASE_5_PRE_CUTOVER_CHECKLIST.md` | Added R4b subsection in §4 + checkbox in §5 | +43 / –1 |
| `SESSION_R4B_FINALIZE_REPORT.md` | This report (new) | +N |

Zero other files modified.

---

**End of R4b-finalize report.** R4b closed. R4c-investigate ready.
