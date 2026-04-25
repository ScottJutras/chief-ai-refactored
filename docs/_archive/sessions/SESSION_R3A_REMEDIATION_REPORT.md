# Session R3a — Crew Cluster Activity Log Emission Migration

**Date:** 2026-04-24
**Status:** **PARTIAL — STOP invoked per directive §10.4 + §10.8.** Safe additives shipped (correlation_id threading, scope-conflict documentation, Phase 5 checklist). Crew cluster route rewrite carved out as **R3b** — requires founder-aligned architectural redesign before implementation.

---

## 0. Executive Summary

R3a entered with the assumption that the crew cluster was medium-complexity plumbing: migrate ~40 INSERT/UPDATE sites to `emitActivityLog(buildActorContext(req), event)`. V1–V8 verification revealed a deeper misfit:

1. **Pre-rebuild `chiefos_activity_logs` is a stateful inbox** (rows mutate through review states — submitted/approved/rejected/needs_clarification/edited — with columns `type`, `content_text`, `structured`, `status`, `log_no`, `reviewed_by_actor_id`, etc.).
2. **Rebuild §3.11 is a pure audit log** (one row per event, correlated via `correlation_id`, with columns `action_kind`, `target_table`, `target_id`, `payload`). NONE of the pre-rebuild mutation columns exist.
3. **Crew submissions have no `target_table`/`target_id`** — they're freeform submissions awaiting review, not audits of canonical writes. The §3.11 schema assumes the inverse.
4. **`needs_clarification` has no spec `action_kind` mapping** (§10.4 STOP). `reopen` is close but not semantically identical.
5. **DISCARDed child table** `chiefos_activity_log_events` is still referenced by 4 INSERT sites in `routes/crewReview.js` and 1 in `services/crewControl.js` — eliminated per §3.11 ("flat log replaces parent/child split").

Migrating the crew cluster to the rebuild schema is **semantic redesign, not plumbing** — directive §10.8 STOP. It requires founder decisions:
- Dedicated `chiefos_crew_submissions` table, or pending-state on canonical rows (`time_entries_v2.submission_status`)?
- `needs_clarification` mapping (reopen semantics vs. a 10th enum value amendment)?
- `log_no` derivation (query-time window function, payload field, or external counter)?

R3a delivered the **non-blocking additives** and wrote a thorough scope analysis to unblock R3b authoring. Phase 5 checklist now flags R3b as a **hard pre-cutover blocker**.

**Scope delivered:** 1 additive module patch (correlation_id in actorContext), 2 modified middleware entry points, 3 scope-conflict doc headers in crew files, 2 new Phase 5 checklist subsections. 0 crew route rewrites. 0 schema changes.

---

## 1. Verification Outcomes (V1–V8)

| Check | Observed | Result |
|---|---|---|
| V1 — `services/activityLog.js` vs §3.11 | Column list, action_kind enum (9 values), CHECK constraints, target_table regex, NO_ACTOR_ATTRIBUTION guard, non-throwing contract ALL match spec exactly. | **PASS — no patch needed.** |
| V2 — crew emission inventory | 21 total hits (not 40 as R3 estimated; R3 conflated `chiefos_tenant_actors` reads with activity-log emissions). Distribution: `routes/crewControl.js`=7, `routes/crewReview.js`=9, `services/crewControl.js`=5. `routes/crewAdmin.js`=0, `routes/timeclock.js`=0 (those hit `chiefos_tenant_actors` only). | See §2 inventory table. Under STOP-60. |
| V2b — `chiefos_activity_log_events` refs | 5 live-code hits (4 in `routes/crewReview.js`, 1 in `services/crewControl.js`). DISCARDed child table — must migrate to `correlation_id` grouping. | **Contributes to §10.8 STOP** — migration to flat model is semantic redesign. |
| V3 — `chiefos_role_audit` inventory | **Zero hits** in live code. | §5 migration section skipped. Spec row 1694 preserved for future use. |
| V4 — `chiefos_tenant_actors` row | 1 row: `tenant_id=86907c28-a9ea-4318-819d-5a012192119b` (Mission Exteriors, owner_id=19053279955), `actor_id=f2a98850-34be-4cc1-b02e-b85d77352f0a` (**orphan** — not in auth.users), `role='employee'`. No FK references from other tables. Classification: **test data**. | §6.1 path applies, but auto-mode has no founder sign-off. **Deferred deletion** — documented in Phase 5 checklist. |
| V5 — correlation_id threading | `buildActorContext` did NOT include `correlationId`. `req.correlationId` not set anywhere pre-R3a. | **Drift** — patched. See §3. |
| V6 — target_table inventory | Crew cluster has **no clean `target_table`/`target_id`** values. Submissions are freeform text stored in `content_text`; there's no canonical row being audited. | **Contributes to §10.8 STOP** — schema misfit. |
| V7 — cache invalidation | Crew cluster does not mutate `public.users.role` or `chiefos_portal_users.role`, so no cache-invalidation gap. | PASS. |
| V8 — regression-test seeding | Isolated schema seed works (verified in R3). | PASS. |

---

## 2. V2 Complete Emission Inventory

| File | Line | Handler | Pre-R3a shape | Expected post-R3 action_kind | Migration status |
|---|---|---|---|---|---|
| `services/crewControl.js` | 62 | `bumpTenantCounterToMax` | `SELECT log_no FROM chiefos_activity_logs` | n/a (column doesn't exist) | **R3b — dead code; log_no gone** |
| `services/crewControl.js` | 150 | `createCrewActivityLog` pre-check | `SELECT id, log_no FROM chiefos_activity_logs WHERE source_msg_id = …` | n/a (column doesn't exist; source_msg_id folds into payload) | **R3b — idempotency pattern needs redesign** |
| `services/crewControl.js` | 178 | `createCrewActivityLog` idempotent INSERT | `INSERT chiefos_activity_logs (log_no, created_by_actor_id, reviewer_actor_id, type, source, content_text, structured, status, source_msg_id)` | `create` with payload wrapping old columns | **R3b** |
| `services/crewControl.js` | 215 | `createCrewActivityLog` non-idempotent INSERT | same as 178 | same | **R3b** |
| `services/crewControl.js` | 254 | `createCrewActivityLog` event | `INSERT chiefos_activity_log_events (log_id, event_type='created', actor_id, payload)` | n/a (table DISCARDed) | **R3b** |
| `routes/crewControl.js` | 48 | `insertEvent` | `INSERT chiefos_activity_log_events` | n/a | **R3b** |
| `routes/crewControl.js` | 69 | `assertCanReview` | `SELECT id, reviewer_actor_id FROM chiefos_activity_logs` | n/a (reviewer_actor_id gone) | **R3b** |
| `routes/crewControl.js` | 124 | inbox (owner/admin) | `SELECT log_no, type, source, content_text, structured, status, ..., reviewed_by_actor_id FROM chiefos_activity_logs JOIN chiefos_tenant_actors` | n/a | **R3b** |
| `routes/crewControl.js` | 147 | inbox (non-admin) | same as 124 | n/a | **R3b** |
| `routes/crewControl.js` | 194 | approve | `UPDATE chiefos_activity_logs SET status='approved', reviewed_by_actor_id, reviewed_at, updated_at` | INSERT new row with `action_kind='confirm'` + `correlation_id` linking back | **R3b** |
| `routes/crewControl.js` | 256 | reject | `UPDATE ... status='rejected', structured \|\| jsonb_build_object('rejection_reason', ...)` | INSERT `action_kind='reject'` | **R3b** |
| `routes/crewControl.js` | 320 | needs_clarification | `UPDATE ... status='needs_clarification'` | **No spec mapping** (§10.4 STOP) | **R3b — amendment or semantic decision needed** |
| `routes/crewReview.js` | 188 | review inbox | same select shape as crewControl inbox | n/a | **R3b** |
| `routes/crewReview.js` | 270 | load log | `SELECT id, tenant_id, owner_id, log_no, status, content_text, reviewer_actor_id, created_by_actor_id FROM chiefos_activity_logs` | n/a | **R3b** |
| `routes/crewReview.js` | 315 | approve UPDATE | same UPDATE shape | INSERT `action_kind='confirm'` | **R3b** |
| `routes/crewReview.js` | 336 | approve event | `INSERT chiefos_activity_log_events (event_type='approved')` | merged into the `confirm` row's payload | **R3b** |
| `routes/crewReview.js` | 355 | reject UPDATE | same UPDATE shape | INSERT `action_kind='reject'` | **R3b** |
| `routes/crewReview.js` | 376 | reject event | `INSERT chiefos_activity_log_events (event_type='rejected')` | merged | **R3b** |
| `routes/crewReview.js` | 395 | needs_clarification UPDATE | same UPDATE shape | **No spec mapping** (§10.4 STOP) | **R3b** |
| `routes/crewReview.js` | 416 | needs_clarification event | `INSERT chiefos_activity_log_events (event_type='needs_clarification')` | merged | **R3b** |
| `routes/crewReview.js` | 437 | edit UPDATE | `UPDATE ... SET content_text = $edited` (in-place mutation of submission text) | INSERT `action_kind='update'` with payload `{prior_text, edited_text}` | **R3b** |
| `routes/crewReview.js` | 448 | edit event | `INSERT chiefos_activity_log_events (event_type='edited')` | merged into update row | **R3b** |

**Total: 21 sites — zero migrated in R3a.** All deferred to R3b.

---

## 3. Files Modified

| File | Δ summary |
|---|---|
| `services/actorContext.js` | +18 lines. Added `ensureCorrelationId(req)` (idempotent per-request UUID generator). Extended `buildActorContext(req)` shape with `correlationId` field. Added crypto import. Exports updated. |
| `middleware/requirePortalUser.js` | +4 lines. Imports `ensureCorrelationId`; calls it at the top of the auth middleware so every portal request has a correlation_id by the time downstream code runs. |
| `middleware/userProfile.js` | +6 lines. Imports `ensureCorrelationId`; calls it at the top of `userProfileMiddleware` so every WhatsApp webhook hit has a correlation_id before identity resolution. |
| `services/crewControl.js` | +40 lines header comment. Documents the R3a scope conflict and R3b open questions. **No code change** — the file still writes pre-rebuild shape. Broken at Phase 5 cutover. |
| `routes/crewControl.js` | +11 lines header comment. Same scope-conflict documentation pointing at services/crewControl.js. No code change. |
| `routes/crewReview.js` | +10 lines header comment. Same. No code change. |
| `PHASE_5_PRE_CUTOVER_CHECKLIST.md` | +70 lines. Added "Added from R3a (chiefos_tenant_actors disposition)" subsection with DELETE SQL + approval process; added "Added from R3a (crew cluster Phase 5 blocker)" subsection documenting R3b as hard blocker; added 2 new checkboxes in §5 General cutover checks. |

---

## 4. Files Created

None.

---

## 5. Files Deleted

None.

---

## 6. chiefos_tenant_actors Resolution

**V4 result:** 1 row, orphan actor_id, no FK dependencies, `chiefos_activity_logs` is 0-row so no historical attribution depends on it.

**Classification:** test data (high confidence; actor_id doesn't match any auth.users and no tables reference it).

**Action in-session:** deferred deletion per directive §6.1 "If founder sign-off cannot be obtained in-session: DO NOT delete."

**Documentation shipped:** Phase 5 checklist §4 "Added from R3a" subsection with:
- Full V4 query output
- Classification rationale
- Exact DELETE statement for pre-cutover execution
- Re-verification query

**Remaining action:** founder approves the one-row DELETE at pre-cutover (1-minute task). Table drop happens implicitly — the rebuild schema does not create `chiefos_tenant_actors`.

---

## 7. chiefos_role_audit Migration

**V3 result:** Zero live-code hits. §5 migration section skipped entirely.

**Spec status:** §3.11 row 1694 preserved for future role-change audit use. No code currently depends on or writes to `chiefos_role_audit`. When role-change code eventually ships (post-R8 likely), it must:
- Write to `acted_by_portal_user_id uuid NOT NULL FK chiefos_portal_users(user_id)` (not the DISCARDed actor FK).
- Include `correlation_id uuid NOT NULL` per §17.21.
- NOT route through `emitActivityLog()` — role audit is intentionally a separate table per §3.11.

---

## 8. Regression Check Outcomes

| # | Check | Result |
|---|---|---|
| 1 | Lint/`node --check` on all modified files | PASS — SYNTAX_OK |
| 2 | Require-resolution (`ensureCorrelationId` export present) | PASS — exports: `buildActorContext,ensureCorrelationId,resolvePortalActor,resolveWhatsAppActor` |
| 3 | Blast-radius grep: `chiefos_activity_log_events` in live code | **DEFERRED to R3b** — 5 hits remain in crew files (expected; R3a did not migrate them). |
| 4 | Residual ad-hoc INSERT grep: `insert into public.chiefos_activity_logs` outside helper | **DEFERRED to R3b** — 2 live-file hits (services/crewControl.js + services/activityLog.js). The activityLog.js hit IS the canonical helper INSERT. The crewControl.js hit is R3b-deferred. |
| 5 | Pre-R3 helper removal grep (`createCrewActivityLog`) | **DEFERRED to R3b** — helper still present in services/crewControl.js; webhook.js still calls it. Not deleted because the pre-rebuild shape is still what dev DB expects. |
| 6 | End-to-end crew flow test | **NOT APPLICABLE** — no code migrated. Would require rewriting crew routes first (R3b scope). |
| 7 | Cross-tenant isolation | **Inherited from R3** — R3's cross-tenant test (0 rows on A-auth/B-tenant) still valid; R3a didn't change the resolvers. |
| 8 | action_kind CHECK enforcement | **Inherited from R3** — R3 verified CHECK via isolated schema. |
| 9 | Actor CHECK enforcement (`NO_ACTOR_ATTRIBUTION`) | **Inherited from R3** — helper validated. |
| 10 | correlation_id threading | **PASS** — isolated schema test: 3 emissions with same correlation_id returned `{correlation_id: <uuid>, event_count: 3}`. |
| 11 | chiefos_tenant_actors resolution verification | **DEFERRED** — row still exists by design (no sign-off). Pre-cutover DELETE authored in checklist. |
| 12 | R3 regression preservation | **PASS** — no R3 code paths touched; `resolvePortalActor` / `resolveWhatsAppActor` unchanged. |

**4 PASS, 1 inferred-valid, 2 inherited, 5 deferred-to-R3b.**

---

## 9. action_kind Mapping Table (as would be used in R3b)

Recorded here as the authoritative mapping for R3b to use (per directive §4.2):

| Pre-R3a semantic | Post-R3b action_kind | Notes |
|---|---|---|
| Submission (`INSERT` with `status='submitted'`) | `create` | target_table depends on type: `'time_entries_v2'` for time, `'tasks'` for task, `'transactions'` for expense/revenue |
| Edit on pending submission | `update` | payload `{prior_text, edited_text}` |
| Approve | `confirm` | payload `{note, prior_status}` |
| Approve after edit | `edit_confirm` | same as confirm; distinguished for audit trail |
| Reject | `reject` | payload `{reason, prior_status}` |
| Delete | `delete` | Soft-delete via `deleted_at` column on target row + `action_kind='delete'` on log |
| Void (for transactions) | `void` | Same as delete but with intent marker |
| Export | `export` | When crew data leaves the system (report download) |
| Reopen closed submission | `reopen` | **Best available mapping for `needs_clarification`** — spec enum has no exact match; `reopen` means "send back for another round" which is semantically equivalent to "please clarify and resubmit." **Flag for founder confirmation in R3b.** |

---

## 10. Tenant Boundary Preservation Analysis

New code (correlation_id additive) adds no queries. Existing queries unchanged:

- `resolvePortalActor` — filters by `(auth_user_id, tenant_id)` — PASS.
- `resolveWhatsAppActor` — filters by `(user_id, owner_id)` — PASS.
- `emitActivityLog` INSERT — includes `tenant_id` + `owner_id` — PASS.
- `buildActorContext` — read-only request-shape inspection — no SQL, no boundary risk.
- `ensureCorrelationId` — pure Node (crypto.randomUUID), no DB access.

Crew cluster queries NOT migrated — per-query boundary preservation is R3b's concern. The existing pre-rebuild code does scope by tenant_id + owner_id correctly (verified during V2 inventory reading); R3b must preserve this during rewrite.

---

## 11. Flagged Items for Founder Review

### F1 — R3b is a hard Phase 5 pre-cutover blocker

The crew cluster's current code writes to columns and tables that don't exist in the rebuild schema. At cutover:
- Every `createCrewActivityLog` call fails (column not exists).
- Every review-flow UPDATE fails.
- Every `chiefos_activity_log_events` INSERT fails.
- Every `chiefos_tenant_actors` lookup fails.

Scope: rewriting 3 files (services/crewControl.js, routes/crewControl.js, routes/crewReview.js) + 1 webhook.js call site + documentation.

Estimated effort: comparable to R3's original estimate for the full crew rewrite (which R3 also deferred). Budget: 1 dedicated session with founder alignment.

### F2 — `needs_clarification` has no spec action_kind

Spec enum is fixed at 9 values. Closest semantic match is `reopen` ("send back for another round"). Alternative: amend spec to add 10th value (`clarify` or `return_for_clarification`). 

**Founder decision needed in R3b:** (a) use `reopen` with payload note, (b) author §3.11 amendment to add a 10th action_kind, or (c) redesign workflow to avoid the `needs_clarification` state entirely.

### F3 — Crew submissions don't fit §3.11 audit-of-canonical-write model

§3.11 assumes every activity_log row audits a write on a canonical table (`target_table` + `target_id`). Crew submissions are currently freeform text in `chiefos_activity_logs.content_text` with no corresponding canonical row until after approval.

**Founder decision needed in R3b:** Which architectural path?
- **Option A:** New `chiefos_crew_submissions` table (tenant-scoped, holds freeform submission text, status column, reviewer FK). Activity log rows audit state transitions on this table. Mirrors the inbox pattern natively.
- **Option B:** Canonical rows inserted in pending state immediately (`time_entries_v2.submission_status='pending_review'`). Activity log rows audit state transitions on the canonical table. Requires adding `submission_status` / `reviewer_portal_user_id` / `reviewed_at` columns to time_entries_v2, tasks, etc. — which `transactions` already has (`submission_status = 'pending_review'` per crewReview.js:550).
- **Option C:** Hybrid — freeform submissions go to Option A's new table; structured submissions (where fields are parseable) go to Option B's canonical tables.

Option B is closest to the existing `transactions.submission_status` pattern and minimizes new table surface.

### F4 — `log_no` sequential numbering is gone

The pre-rebuild `log_no` column gave crew UI display numbers like "#42" per submission. The rebuild schema has no such column. Options:
- (a) Derive at query time: `ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY created_at)` — slow on large tables.
- (b) Store in `payload.log_no` and compute on write via `MAX(payload->>'log_no')+1` — concurrency-safe only with an allocator function.
- (c) Use `chiefos_tenant_counters` to allocate `submission_no` on the new submissions table (if Option A or Hybrid).
- (d) Drop display numbering entirely and use timestamp-based scrolling.

**Founder decision in R3b.**

### F5 — `chiefos_tenant_actors` single row still present

Per §6 above. Deferred to pre-cutover. 1 test-data row; DELETE statement authored in checklist.

---

## 12. Open Questions

All five F1–F5 items are open questions. Additionally:

6. **Should R3b proceed before R4?** The crew cluster is a hard pre-cutover blocker, but R4 (memory/reminders/RAG migration) is orthogonal and may be easier to ship first while R3b scope is aligned with founder. Recommendation: R4 first, R3b second — R3b needs founder input that R4 doesn't.

7. **Should `createCrewActivityLog` be broken into R3b-scope and webhook-scope?** The webhook path (`routes/webhook.js:1747`) calls `createCrewActivityLog` — rewriting that call site could land in R3b as a sub-scope. Alternatively, the webhook call could be wrapped in a feature flag so crew capture can be disabled until R3b ships.

---

## 13. R4 Entry Point

R4's scope per handoff §5 — **memory + reminders + RAG migration** — is unaffected by R3a's partial delivery:

- `services/memory.js` → `conversation_sessions/messages` — no crew dependency.
- `services/reminders.js` → new `reminders` table from P1A-1 — no crew dependency.
- RAG migration → new `docs/doc_chunks/rag_terms/tenant_knowledge` tables from P1A-3 — no crew dependency.

R4 can proceed in parallel with R3b. Recommend R4 first (lower founder-input demand).

---

## 14. Completion Criteria

- [x] V1–V8 verification outcomes documented (V1 PASS, V2 inventory, V3 zero-hits, V4 row inspected, V5 drift + patch, V6 schema misfit, V7 PASS, V8 deferred)
- [x] V1 drift findings — none; `services/activityLog.js` matches §3.11
- [x] V2 complete emission inventory — 21 sites table with pre/post shapes
- [x] V3 role_audit findings — zero
- [x] V4 chiefos_tenant_actors resolution — test-data classification, DELETE statement authored for checklist
- [x] Files modified — 7 (4 source + 3 header-only comments + 1 doc)
- [x] Files deleted — 0 (pre-R3 helpers preserved pending R3b)
- [x] §5 role_audit migration — N/A (zero sites)
- [x] §6 chiefos_tenant_actors + Phase 5 checklist update — delivered
- [x] Regression check outcomes (1–12) — 4 PASS, 1 valid, 2 inherited, 5 R3b-deferred
- [x] action_kind mapping table — authored in §9 for R3b reference
- [x] Tenant boundary preservation — analyzed
- [x] Flagged items for founder review (F1–F5)
- [x] Open questions listed (7)
- [x] R4 entry point confirmed unaffected
- [x] No schema changes
- [x] No commits

---

**R3a partial complete.** Safe additives shipped (correlation_id threading, scope-conflict docs, Phase 5 checklist blocker). Crew cluster rewrite carved out as R3b with 5 founder-input questions enumerated. R4 unblocked and should proceed first.
