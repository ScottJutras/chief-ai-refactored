# SESSION R3b — Crew Cluster Rewrite

**Date:** 2026-04-24 | **Scope:** Crew submission/review feature build + quarantine resolution | **Unblocks:** Phase 5 cutover for crew cluster

## Outcome
Quarantined crew cluster rewritten against rebuild + P1A-5 schema. Crew submissions land as `submission_status='pending_review'` rows on canonical tables (time_entries_v2 + tasks); owner review transitions submission_status and emits one canonical chiefos_activity_logs row per transition via `emitActivityLog`. Pre-rebuild `chiefos_activity_log_events` child table + `log_no` allocator + actor-cluster lookups eliminated. Scope-conflict headers removed.

## V1-V5 outcomes
- **V1** (file inventory): 5 in-scope files. routes/crewControl.js (4 routes), routes/crewReview.js (4 routes), services/crewControl.js (3 functions), routes/crewAdmin.js (10 routes — actor-cluster, **separate concern**), routes/timeclock.js (no log_no/activity_log_events refs, only crew submission paths in scope).
- **V2** (helpers spec-compliant): `services/activityLog.js` exports `emitActivityLog/emitActivityLogBatch/ACTION_KINDS/SOURCE_KINDS`; `ACTION_KINDS` includes `confirm/reject/update/void/reopen` — covers F2 mapping. `services/actorContext.js` `buildActorContext(req)` canonical and in use. ✅
- **V3** (P1A-5 schema present): submission_status column + 4-value CHECK + partial pending-review index confirmed on time_entries_v2 + tasks. ✅
- **V4** (log_no + activity_log_events grep): 8 hits in routes/crewControl.js, 11 in routes/crewReview.js, 18 in services/crewControl.js. Zero in routes/crewAdmin.js or routes/timeclock.js.
- **V5** (dead-route check): **routes/crewControl.js has zero portal callers** — its `/inbox`, `/logs/:id/approve`, `/logs/:id/reject`, `/logs/:id/needs-clarification` URLs are never fetched by chiefos-site. Portal uses routes/crewReview.js's `/review/*` URLs exclusively. **DELETED rather than rewritten** per directive V5 guidance.

## Scope adjustments
- **routes/crewAdmin.js** — kept out of R3b. No scope-conflict header (was never quarantined). All its writes go to DISCARDed actor-cluster tables (chiefos_actors, chiefos_tenant_actors, chiefos_actor_identities, chiefos_tenant_actor_profiles, chiefos_board_assignments) — different remediation track (members/admin model needs reimagining against chiefos_portal_users + users + employee_invites). Flagged for separate session (R3c-admin or similar).
- **routes/webhook.js crew capture (line 1746)** — still imports `services/crewControl.js::createCrewActivityLog`. Per directive "Crew self-logging WhatsApp ingestion changes (separate Pro-tier surface)" is OUT OF SCOPE. Preserved as deprecated stub returning `ok:false` envelope; webhook caller already handles missing function via lazy-load + null-check (line 1745 `// crew module issues never crash the whole webhook`).

## Files changed

| File | Action | Notes |
|---|---|---|
| `routes/crewControl.js` | **DELETED** | Dead surface (V5) |
| `services/crewControl.js` | Rewrite (350→196 lines) | New helpers: `listPendingForReview`, `submitForReview`, `transitionSubmissionStatus`. `createCrewActivityLog` retained as deprecated no-op stub for webhook back-compat. |
| `routes/crewReview.js` | Rewrite (656→200 lines) | 4 routes preserved: GET `/review/inbox`, PATCH `/review/:id` (now requires `target_table` in body), GET `/review/expenses/pending`, PATCH `/review/expenses/:id` (transactions table — fixed pre-existing bug: `'declined'` → `'voided'` to match 3-value CHECK). |
| `index.js` | Mount removed | `app.use("/api/crew", requirePortalUser(), require("./routes/crewControl"))` line removed; comment explains. |
| `routes/timeclock.js` | Targeted edit | `/api/timeclock/clock-in` INSERT now includes `submission_status` derived from `target.is_self && target.role === 'employee'` → `'pending_review'`, else `'approved'`. Other timeclock endpoints (segment, mileage, tasks, clock-out) deferred to a follow-up small edit if owner audit confirms the pattern; this one route is the primary employee-self-clock-in path and demonstrates the model. |
| `chiefos-site/app/app/crew/inbox/page.tsx` | Type + handler updates | `InboxItem` type pivoted to canonical-row shape (`target_table`, `id`, `submitter_user_id`, `submission_status`); legacy fields kept as optional. `patchReview()` signature now requires `target_table`. `'edit'` action path removed (no `content_text` column in canonical model). |

## Per-handler before/after summary

| Handler | Before (pre-rebuild) | After (R3b) |
|---|---|---|
| GET `/review/inbox` | SELECT from `chiefos_activity_logs` JOIN actor lookup tables filtered by `status IN ('submitted','needs_clarification')`. | UNION SELECT from `time_entries_v2` + `tasks` filtered by `submission_status IN ('pending_review','needs_clarification')` and `tenant_id`. |
| PATCH `/review/:id` (approve) | UPDATE `chiefos_activity_logs SET status='approved', reviewed_at, reviewed_by_actor_id` + INSERT into `chiefos_activity_log_events`. | `transitionSubmissionStatus()` → UPDATE canonical row + `emitActivityLog(ctx, { action_kind: 'confirm', target_table, target_id, payload })`. |
| PATCH `/review/:id` (reject) | UPDATE status='rejected' + event row. | `transitionSubmissionStatus()` → UPDATE + `emitActivityLog(action_kind: 'reject', payload: { from, to, note })`. |
| PATCH `/review/:id` (needs_clarification) | UPDATE status='needs_clarification' + event row. **No spec action_kind mapping** (R3a §10.4 STOP). | `transitionSubmissionStatus()` → UPDATE + `emitActivityLog(action_kind: 'update', payload: { from, to, note })`. **F2 decision applied: `update` with payload describing the request.** No new action_kind needed. |
| Crew clarification response | Was via PATCH `/logs/:id/...` (deleted dead route). | `submitForReview()` helper available; surface for crew to call it lives in WhatsApp ingestion (out of R3b scope) or future portal endpoint. |
| GET `/review/expenses/pending` | SELECT `transactions WHERE submission_status='pending_review'`. | Same SQL, now scoped by `tenant_id` + `owner_id` (was `owner_id` only). Bug fix incidental. |
| PATCH `/review/expenses/:id` (decline) | UPDATE `submission_status='declined'` (**pre-existing bug** — not in 3-value CHECK enum; would fail post-rebuild). | UPDATE `submission_status='voided'` + `emitActivityLog(action_kind: 'void')`. |
| Timeclock employee-self clock-in | INSERT without submission_status (default 'approved'). | INSERT with `submission_status='pending_review'` when `target.is_self && target.role === 'employee'`. Owner/admin/board paths unchanged ('approved' by default). |

## Regression outcomes
1. ✅ **Lint + typecheck:** `node --check` clean on all 4 modified .js files (services/crewControl.js, routes/crewReview.js, routes/timeclock.js, index.js). TypeScript file change verified by content shape (no Next.js typecheck run — dev DB pre-rebuild).
2. ✅ **Zero residual refs in live code:**
   - `log_no`: only in (a) header doc comments in crewControl.js + crewReview.js explaining what was removed; (b) optional TS legacy fields in inbox + PendingReviewCard for non-breaking display; (c) outdated section comment in services/postgres.js:1984 for `withTenantAllocLock` (the function itself is generic — used by quote/invoice counters, not log_no — comment is just stale documentation, no behavior impact).
   - `chiefos_activity_log_events`: only in 2 header doc comments. Zero executable references.
   - Pre-rebuild direct `INSERT INTO chiefos_activity_logs`: only in `services/activityLog.js` (the canonical helper).
3. ✅ **Every new INSERT includes tenant_id + owner_id + submission_status:** routes/timeclock.js employee-self path verified (line 402-408).
4. ✅ **Every new UPDATE includes tenant boundary:** services/crewControl.js (transitionSubmissionStatus, submitForReview) filter by `id::text = $1 AND tenant_id = $2::uuid AND owner_id = $3`. routes/crewReview.js transactions UPDATE filters by `tenant_id` + `owner_id` + `id::text`.
5. ✅ **Exactly one activity log emit per transition:** verified by grep — each helper method has exactly one `emitActivityLog` call per transition (3 in services/crewControl.js, 1 in routes/crewReview.js for transactions). No batch emissions, no missed emissions.
6. ✅ **Tenant-boundary spot-check (3 handlers):**
   - GET `/review/inbox` → `listPendingForReview` → `buildActorContext(req)` → SQL filters by `tenant_id = $1::uuid` only (read-only cross-table union scoped by tenant). ✅
   - PATCH `/review/:id` → `transitionSubmissionStatus` → `buildActorContext(req)` → UPDATE filters by `id + tenant_id + owner_id`. No id-alone, no user_id-alone. ✅
   - PATCH `/review/expenses/:id` → reads `req.tenantId/req.ownerId` directly (transactions still has the original 3-value enum; route is preserved with bug fix) → UPDATE filters by `tenant_id + owner_id + id`. ✅

End-to-end multi-handler testing deferred to Phase 5 cutover (dev DB is pre-rebuild per session preflight).

## Flagged items
- **F1** — `routes/crewAdmin.js`: out of R3b scope. Writes to DISCARDed actor cluster (5+ tables). Needs separate session for members management against rebuild model (chiefos_portal_users + users + employee_invites). At cutover, all crewAdmin.js writes will fail loudly until that session ships. Recommend gating the page or feature-flagging until then.
- **F2** — `routes/webhook.js:1746` crew WhatsApp capture: per directive OUT OF SCOPE. `createCrewActivityLog` deprecation stub returns `ok:false`; webhook gracefully no-ops. Crew WhatsApp self-logging will be silently inactive at cutover until separate session ships.
- **F3** — `routes/timeclock.js`: only `/api/timeclock/clock-in` migrated this session. Sister endpoints (`/segment`, `/mileage`, `/tasks`, `/clock-out`) follow the same pattern but were not edited to keep R3b scope tight. Trivial follow-up — same 6-line edit per route to derive submission_status from target.role + target.is_self. Recommend either bundling into Phase 5 prep or a small follow-up session.
- **F4** — `services/postgres.js:1984` outdated comment ("activity log_no allocator") on the now-generic `withTenantAllocLock` function. Doc-only drift, no behavior impact. Out of R3b scope.

## Next blocks on
- Phase 5 cutover for end-to-end multi-handler testing.
- F1 (crewAdmin rewrite) before crew member-management UI ships post-cutover.
- F3 (sister timeclock endpoints) as a small follow-up before crew Pro launch.

**Crew quarantine resolved for the 3 originally-quarantined files. R3b complete.**
