# Phase 4 App Code Audit Report

**Date:** 2026-04-22
**Scope:** Audit the ChiefOS app code (root Express backend + `chiefos-site/` Next.js portal) for dependencies that conflict with the Foundation Rebuild. Investigative only — no fixes in this session (except trivial inline cleanups, none found necessary).
**Authority:** `FOUNDATION_REBUILD_PLAN_V2.md §4 Phase 4`; Phase 3 session reports; `PHASE_4_DISCARD_REGISTRY.md` (produced this session).

---

## Executive Summary

**Total findings: ~290+ individual call sites across app code.**

| Classification | Count (approx.) | Meaning |
|---|---|---|
| **BLOCKING** | ~270 | Will break at Phase 5 cutover; must be remediated before applying rebuild migrations |
| **NON-BLOCKING** | ~15 | Type defs, comments, schema docs — won't break runtime but should update |
| **TRIVIAL** | ~10 | Comments / log strings / variable names |

**Severity: HIGH.** This is the "100+ blockers" scenario anticipated by the work order. The rebuild's DISCARD scope was more aggressive than the current app code's decoupling. Remediation will require multiple focused sessions, not a single pass.

**Entire-file removal candidates:** 25+ files are built end-to-end on DISCARDed concepts. Many can be deleted; some need rebuild into a reduced-functionality replacement.

**Architectural findings:** 4 of 4 architectural audits surfaced BLOCKING issues:
- mileage + overhead confirms do NOT emit parallel `transactions` rows (Audit 6)
- Only 1 canonical-write lane (crewControl) emits activity logs, and it uses pre-rebuild shape (Audit 7)
- `jobs.job_no` uses race-prone `MAX+1` instead of `chiefos_tenant_counters` (Audit 8)
- Only the expense lane stages through `cil_drafts`, and all call sites use the pre-rebuild column shape (Audit 9)

**Recommended remediation cadence: 4-6 dedicated sessions** (details in §6 below) before Phase 5 cutover can proceed.

---

## 1. DISCARD Registry (Reference)

See the companion document `PHASE_4_DISCARD_REGISTRY.md` for the full enumeration of:
- 63 DISCARDed tables
- 17 DISCARDed views (+ 2 renamed)
- 39 DISCARDed functions (20 SECDEF + 19 INVOKER)
- Column-level changes on 22 KEEP-WITH-REDESIGN tables

---

## 2. Grep Pass 1 — DISCARDed Table References

### 2.1 Actor cluster (Decision 12) — **40+ BLOCKING**

The actor cluster is the single largest source of BLOCKING findings. Four discarded tables touched by ~20 files.

| Table | BLOCKING call sites |
|---|---|
| `chiefos_tenant_actor_profiles` | 18+ hits — `services/anomalyDetector.js:295`; `handlers/commands/timesheetApproval.js:138,149,394`; `handlers/commands/rates.js:94`; `services/agentTools/jobPatternTrends.js:123`; `services/agentTools/compareQuoteVsActual.js:64,83`; `routes/crewReview.js:189`; `routes/crewAdmin.js:250,263,297,440,652,677,835,892`; `routes/employee.js:34`; `routes/timeclock.js:71,163,250,894,905`; `handlers/askChief/employeeSupport.js:53`; `chiefos-site/app/employee/mileage/page.tsx:127`; `chiefos-site/app/employee/tasks/page.tsx:112`; `chiefos-site/app/api/log/route.ts:40`; `chiefos-site/app/app/jobs/[jobId]/page.tsx:1985`; `chiefos-site/app/app/activity/mileage/page.tsx:115` |
| `chiefos_tenant_actors` | 12+ hits — `middleware/requirePortalUser.js:148`; `routes/crewReview.js:31,55`; `routes/crewControl.js:28,125,148`; `routes/crewAdmin.js:122,152,257,431,482,542,555,803,844,963`; `routes/crew.js:29`; `services/crewControl.js:31`; `routes/webhook.js:1838`; `routes/timeclock.js:70,162,904` |
| `chiefos_actor_identities` | 6 hits — `routes/crewReview.js:99`; `routes/crewAdmin.js:213,229,454,469,709,720,737,746` |
| `chiefos_actors` | 4 hits — `routes/crewAdmin.js:258,420,423,690`; `routes/crew.js:103,104` |

**Entire-file removal candidates:** `routes/crewAdmin.js`, `routes/crewReview.js`, `routes/crewControl.js`, `services/crewControl.js`, `routes/crew.js`.
**Heavy-refactor candidates:** `middleware/requirePortalUser.js`, `routes/timeclock.js`, `routes/employee.js`, `routes/webhook.js`, `handlers/commands/timesheetApproval.js`, `handlers/commands/rates.js`, `services/agentTools/jobPatternTrends.js`, `services/agentTools/compareQuoteVsActual.js`.

### 2.2 Legacy financial tables — 5 BLOCKING

- `chiefos_expenses` — `services/postgres.js:460` (SELECT); `chiefos-site/app/app/activity/expenses/trash/page.tsx:61` (`.from()`)
- `expenses` — `services/computeFinanceKpis.js:33` (fallback-list probe)
- `bills` — `services/computeFinanceKpis.js:35`
- `revenue` — `services/kpis.js:232` (likely CTE alias — needs manual confirmation)

### 2.3 Legacy activity/audit — 8 BLOCKING

- `chiefos_activity_log_events` — 8 hits in `routes/crewReview.js:336,376,416,448`; `routes/crewControl.js:48`; `routes/crew.js:184,249`; `services/crewControl.js:254` (parent/child activity log split; DISCARDed, flattened into `chiefos_activity_logs`)

### 2.4 Legacy identity — 20+ BLOCKING

- `chiefos_link_codes` — 3 hits (`routes/webhook.js:335`; `chiefos-site/app/app/welcome/WelcomeClient.tsx:336,353`; `chiefos-site/app/app/connect-whatsapp/page.tsx:74`)
- `chiefos_user_identities` — 6 hits (`middleware/userProfile.js:225,248,444,454`; `handlers/media.js:307,319,328`; `routes/portal.js:147`; `routes/account.js:59,137`)
- `chiefos_identity_map` — 1 hit (`routes/webhook.js:358`)
- `chiefos_phone_active_tenant` — 2 hits (`middleware/userProfile.js:116`; `routes/webhook.js:2570`)
- `chiefos_pending_signups` — 4 hits (`chiefos-site/app/api/auth/signup/route.ts:161`; `chiefos-site/app/api/auth/pending-signup/route.ts:62,120,184`)
- `chiefos_board_assignments` — 5 hits (`services/crewControl.js:15`; `routes/crewAdmin.js:360,573,825,993`)
- `user_memory` — 2 hits (`services/memory.js:14,23`)
- `user_auth_links` — 1 hit (`chiefos-site/app/api/tester-access/activate/route.ts:107`)

### 2.5 Legacy time — MANY BLOCKING

- `time_entries` (v1, not `_v2`) — extensive coupling:
  - `services/postgres.js:2027, 4237, 4253, 4277, 4303, 4321, 4339, 4426, 4432, 4446, 4469, 4472` — legacy `logTimeEntry` dual-write path
  - `services/kpiWorker.js:85,100`; `services/ai_confirm.js:84`
  - `scripts/bootstrap-local-db.sql:35` — CREATE TABLE (dev seed)
  - `routes/employee.js:437,442` — calls `logTimeEntry` dual-write
  - `chiefos-site/app/api/log/route.ts:94`
  - `chiefos-site/app/app/jobs/page.tsx:395`; `chiefos-site/app/app/components/DashboardDataPanel.tsx:131`; `chiefos-site/app/app/components/LabourSummaryWidget.tsx:84,90`
  - `chiefos-site/app/app/activity/time/page.tsx:324,542,566` (UPDATE by `id` alone — dual-boundary violation)
  - `handlers/commands/timeclock.js:187,188,189,1050,2109`
  - `__tests__/timeclock.e2e.test.js:10` (BLOCKING-IF-TEST-RUNS)
- `timesheet_rollups` — 0 hits (clean)

### 2.6 Legacy counters — 0 BLOCKING

`job_counters`, `task_counters`, `task_counters_user` — clean in app code. Safe to DROP at cutover.

### 2.7 Legacy KPI — 9 BLOCKING

- `kpi_touches` — 4 hits (`handlers/commands/timeclock.js:669`; `services/postgres.js:4485`; `services/kpiWorker.js:53,56`; `scripts/demoKpi.js:10`)
- `job_kpis_daily` — 5 hits (`services/kpiWorker.js:198,241,257,322`; `services/agentTools/getJobKpis.js:14`; `scripts/demoKpi.js:16`)

### 2.8 Supplier catalog — 60+ BLOCKING

All 8 discarded supplier tables are heavily used:
- `suppliers` (10+), `supplier_users` (3), `supplier_categories` (7), `tenant_supplier_preferences` (2), `catalog_products` (many), `catalog_ingestion_log` (5), `catalog_price_history` (4), `pricing_items` (4)
- Full entire-file removals: `routes/supplierPortal.js`, `routes/catalog.js`, `middleware/requireSupplierUser.js`, `services/catalogIngest.js`, `services/agentTools/supplierSpend.js`, `services/agentTools/catalogLookup.js`, `domain/pricing.js`
- Portal removals: `chiefos-site/app/supplier/**`, `chiefos-site/app/app/catalogs/**`, `chiefos-site/app/app/admin/suppliers/**`, `chiefos-site/app/api/catalog/**`, `chiefos-site/app/api/admin/suppliers/**`

### 2.9 Docs / RAG — 6 BLOCKING

- `rag_terms` (`scripts/ingestRAG.js:29`; `services/ragTerms.js:8`)
- `doc_chunks` (`services/rag_search.js:25,77`; `services/tools/rag.js:95`)
- `tenant_knowledge` (`services/learning.js:55,58`)
- Entire-file removals: `services/rag_search.js`, `services/ragTerms.js`, `services/tools/rag.js`, `scripts/ingestRAG.js`

### 2.10 Conversation predecessors — 8 BLOCKING

All 4 discarded tables used by `services/memory.js` (entire file built on them) + `services/postgres.js:1130,1151,1157,1161` (`chief_actor_memory` extensive upsert).
- `assistant_events`, `chief_actor_memory`, `convo_state`, `entity_summary`

### 2.11 Legacy intake/jobs — 15 BLOCKING

- `job_documents` — 10+ hits (widespread in portal jobs page + documents page + intake confirm route)
- `job_document_files` — 7 hits (portal + API signing pages)
- `intake_processing_jobs` — 0 hits

### 2.12 Misc — ~30 BLOCKING

- `change_orders` (5) — `domain/changeOrder.js`; portal pages
- `fact_events` (3) — `services/postgres.js:2271, 2392, 2401`
- `insight_log` (8) — `services/anomalyDetector.js`; `routes/alerts.js`; `chiefos-site/app/app/dashboard/page.tsx:688`
- `category_rules` (7) — `services/postgres.js:4014,4079,4091,4105,4129,4151,4168`
- `user_active_job` (8) — `services/postgres.js` extensive
- `usage_monthly` (6) — `services/postgres.js` quota counter path
- `usage_monthly_v2` (4) — `services/postgres.js`; `scripts/real_create_quote_mission.js:140`
- `reminders` (9) — `services/reminders.js` (entire file); `chiefos-site/app/api/log/route.ts:143`

### 2.13 Zero-hit tables (safe to DROP without app changes)

`chiefos_ingestion_identities`, `chiefos_txn_delete_batches`, `chiefos_vendor_aliases`, `chiefos_saved_views` (table — functions still called), `users_legacy_archive`, `timesheet_rollups`, `job_counters`, `task_counters`, `task_counters_user`, `chiefos_expense_audit`, `budgets`, `receivables`, `owner_nudges`, `knowledge_cards`, `intake_processing_jobs`, `team_member_assignments`, `capability_denials`, `uploads` (storage bucket references only).

---

## 3. Grep Pass 2 — DISCARDed Functions & Views

### 3.1 All 19 `supabase.rpc(` call sites invoke DISCARDed functions — BLOCKING

Every single Supabase RPC call in the app points at a discarded function. Post-cutover, ALL must be removed or replaced:

| File | Line | RPC |
|---|---|---|
| `chiefos-site/app/finish-signup/FinishSignupClient.tsx` | 648 | `chiefos_finish_signup` |
| `chiefos-site/app/app/welcome/WelcomeClient.tsx` | 350 | `chiefos_create_link_code` |
| `chiefos-site/app/app/connect-whatsapp/page.tsx` | 101 | `chiefos_create_link_code` |
| `chiefos-site/app/app/activity/expenses/page.tsx` | 299, 735, 798, 837, 869, 915, 924, 952 | `list_saved_views`, `update_expense`, `bulk_assign_expense_job`, `delete_expenses`, `undo_delete_expenses`, `list_saved_views`, `upsert_saved_view`, `delete_saved_view` |
| `chiefos-site/app/app/activity/expenses/vendors/page.tsx` | 44, 120, 131 | `list_vendors`, `normalize_vendor`, `list_vendors` |
| `chiefos-site/app/app/activity/expenses/audit/page.tsx` | 44, 120, 131 | `list_vendors`, `normalize_vendor`, `list_vendors` |
| `chiefos-site/app/app/activity/expenses/trash/page.tsx` | 134, 168 | `restore_expense`, `restore_expenses_bulk` |

**None of the 19 RPCs has a rebuild replacement** (the only surviving RPC is `chiefos_next_tenant_counter`, which is server-side only).

### 3.2 DISCARDed view references — 13 BLOCKING

| View | Hits |
|---|---|
| `v_actor_identity_resolver` | 3 BLOCKING — `middleware/userProfile.js:176`; `middleware/requirePortalUser.js:127`; `services/postgres.js:195` (on hot path — every authenticated request) |
| `v_identity_resolver` | 1 BLOCKING — `services/postgres.js:216` (fallback) |
| `v_cashflow_daily` | 1 BLOCKING — `services/postgres.js:2322` (renamed to `chiefos_portal_cashflow_daily`) |
| `v_job_profit_simple_fixed` | 2 BLOCKING — `services/postgres.js:2350,2362` |
| `company_balance_kpis` | 1 BLOCKING — `services/kpis.js:246` |
| `job_kpis_summary` | 1 BLOCKING — `services/jobsKpis.js:101` |
| `job_kpis_weekly`, `job_kpis_monthly`, `company_kpis_weekly`, `company_kpis_monthly` | 4 BLOCKING — `workers/forecast_refresh.js:11-14` (`REFRESH MATERIALIZED VIEW`) |

**Clean views:** `open_shifts` (successor is `chiefos_portal_open_shifts` — zero app callers on old name).

### 3.3 INVOKER functions — 0 BLOCKING

All 19 discarded INVOKER functions (triggers + utility helpers) have ZERO app-code callers. Safe to DROP without app changes.

---

## 4. Column-Level Audit

### 4.1 `users` — 33 dropped columns; real-runtime risk

| Dropped column | BLOCKING sites |
|---|---|
| `trial_end` | 7 — `services/agent/index.js:22`; `chiefos-site/app/api/intake/process/route.ts:120,132`; `routes/askChief.js:244,278`; `routes/askChiefStream.js:244,255`; `routes/chiefQuota.js:63` |
| `subscription_tier` | 13 — `services/postgres.js:3382, 4610, 4661, 4687, 4689, 4711`; `middleware/requirePortalUser.js:192, 199`; `routes/portal.js:50, 62`; `routes/jobsPortal.js:60`; `routes/askChiefStream.js:244, 251`; `routes/askChief.js:244, 273`; `routes/chiefQuota.js:63`; `handlers/commands/job.js:1358, 1378`; `chiefos-site/app/api/tester-access/activate/route.ts:135`; `chiefos-site/app/api/intake/process/route.ts:120, 127` |
| `paid_tier` | 7 — paired with `subscription_tier` at same sites |
| `dashboard_token` | 6 — `services/postgres.js:3370, 3385, 4593`; `routes/dashboard.js:33`; `routes/api.dashboard.js:33` + cookie-name strings (NON-BLOCKING for those) |
| `otp`, `otp_expiry` | 4 — `services/postgres.js:3350, 3356, 3359, 3386` |
| `is_team_member` | 4 — `services/users.js:11, 14, 26`; `routes/webhook.js:188`; `handlers/commands/timeclock.js:2434` |
| `timezone` | Many — mostly `obj.tz || obj.timezone` fallback reads (graceful degradation on drop). Hard references at `middleware/userProfile.js:322, 615`; `services/postgres.js:3382` |
| `country`/`province` | 1 BLOCKING — `handlers/commands/index.js:599` (`ownerProfile?.country`). Other `country`/`province` hits read from tenants table (fine). |
| `onboarding_in_progress` | 4 — `services/postgres.js:3370, 3372, 3385`; `services/owners.js:124`; `handlers/commands/index.js:157` |

**Clean (zero app-code hits):** `business_country`, `business_province`, `spreadsheet_id`, `token_usage`, `trial_start`, `current_stage`, `training_completed`, `historical_data_years`, `historical_parsing_purchased`, `team_members`, `team`, `last_otp`, `last_otp_time`, `fiscal_year_start`, `fiscal_year_end`, `recap_time_pref`, `reminder_needed`, `goal`, `goal_progress`, `goal_context`, `industry`, all four `*_upgrade_prompt_shown` columns.

### 4.2 `transactions` — 1 BLOCKING

- `payment_status` — `services/agentTools/cashFlowForecast.js:165` (`COALESCE(payment_status, 'pending') = 'pending'`)
- `amount` (numeric duplicate), `payment_confirmed_at` — 0 BLOCKING

### 4.3 `media_assets.ocr_text` / `ocr_fields` — 2 BLOCKING

- `handlers/media.js:209, 226-230, 232` — UPSERTs write `ocr_text` + `ocr_fields` directly into `media_assets` (discarded per Decision 13)

### 4.4 `tasks.type` (renamed to `kind`) — 4 BLOCKING

- `handlers/commands/tasks.js:207, 219, 251` — INSERT with `type` column
- `services/postgres.js:3422` — INSERT column list includes `type`

### 4.5 `cil_drafts` — FULL REBUILT (many BLOCKING)

Every call site uses pre-rebuild shape:
- `services/postgres.js:1258-1283` — INSERT with `kind`, `status`, `actor_user_id`, `actor_phone`, `job_id::uuid`
- `services/postgres.js:1316-1333, 1346-1358, 1373-1383, 1396-1404, 1430-1446, 1465-1478` — 6 UPDATE sites using `status`, `kind`, `actor_phone`
- `handlers/commands/expense.js:594, 4972, 5010, 7282` — call sites

### 4.6 `llm_cost_log` — 1 BLOCKING

- `services/llm/costLogger.js:60-62` — INSERT uses `query_kind` + `cost_usd` (renamed to `feature_kind`, `cost_cents`)

### 4.7 `intake_item_reviews.reviewed_by_auth_user_id` — 15+ BLOCKING

- `chiefos-site/lib/intake/types.ts:177`
- `chiefos-site/app/api/intake/upload/route.ts:363, 368`
- `chiefos-site/app/api/intake/items/[id]/skip/route.ts:171, 176`
- `chiefos-site/app/api/intake/items/[id]/route.ts:250`
- `chiefos-site/app/api/intake/items/[id]/confirm/route.ts:271, 322, 366, 416, 457, 503, 567, 779, 784`
- `chiefos-site/app/api/intake/items/[id]/delete/route.ts:200, 205`
- `chiefos-site/app/api/intake/items/[id]/duplicate/route.ts:208, 213`

All must rename to `reviewed_by_portal_user_id`.

### 4.8 `integrity_verification_log` — 1 BLOCKING

- `services/integrity.js:251-254` — INSERT column list uses every pre-rebuild column (`table_name`, `verification_type`, `total_records_checked`, `records_valid`, `records_invalid`, `records_unhashed`, `first_invalid_record_id`, `invalid_details`) — all DROPPED in rebuild (§3.11).

### 4.9 `time_entries_v2.job_id` type uuid→int — BLOCKING if any caller passes uuid

- `handlers/commands/timeclock.js:523, 536, 558, 563, 655, 2871, 2938`
- `routes/timeclock.js:426, 595, 612`

All callers must pass integer `job_id`, not uuid.

### 4.10 Clean (zero app hits)

`locks.lock_key`, `chiefos_role_audit` column renames, `chiefos_deletion_batches` column renames, `tasks.related_entry_id`/`acceptance_status`/`completed_by`, `transactions.amount`/`payment_confirmed_at`.

---

## 5. Dual-Boundary Identity Audit

### 5.1 Deviation A (portal code using `auth.uid()` on tenant-scoped tables) — 0 hits

**Clean.**

### 5.2 Deviation B (WhatsApp handlers omitting `owner_id` on writes) — 0 hits

All backend INSERTs on tenant-scoped tables include `owner_id`. **Clean.**

### 5.3 Deviation C (writes on tenant-scoped tables without tenant boundary) — 6 BLOCKING

All in portal client code (`chiefos-site/app/app/`):
- `chiefos-site/app/app/jobs/[jobId]/page.tsx:474` — `.from("customers").update().eq("id", custId)` — no tenant filter
- `chiefos-site/app/app/jobs/[jobId]/page.tsx:591` — `.from("jobs").update({contract_value_cents}).eq("id", job.id)`
- `chiefos-site/app/app/jobs/[jobId]/page.tsx:1123` — customers update by id alone
- `chiefos-site/app/app/jobs/[jobId]/page.tsx:1375` — `.from("jobs").update({[fieldType]: dbVal}).eq("id", jobId)`
- `chiefos-site/app/app/overhead/page.tsx:227, 511, 516` — `.from("overhead_items").update().eq("id", ...)` — no tenant filter

Per Constitution §4, relying on RLS alone for write gates is fragile. Explicit `eq("tenant_id", ...)` required.

### 5.4 Deviation D (legacy JWT claim / owner-in-tenant patterns) — 0 hits

**Clean.** The `chiefos_phone_active_tenant` references (already counted in Pass 1) are the only legacy-identity-surface hits.

---

## 6. Architectural Audits (Steps 6–9)

### 6.1 Audit 6 — Parallel-transactions emission — **BOTH MISSING, BLOCKING**

**Finding:** Neither `mileage_logs` nor `overhead_payments` confirm handlers emit the parallel `transactions` row required by rebuild design §3.12.

**Evidence:**
- `handlers/commands/mileage.js:134-144` (insertMileageLog) — single INSERT, no tx emission. Caller sites `:201-214`, `routes/timeclock.js:734`, `routes/employee.js:640` also omit.
- `chiefos-site/app/api/overhead/mark-paid/route.ts:62-72`, `chiefos-site/app/api/overhead/confirm-reminder/route.ts:69-79` — only `overhead_payments` upsert, no tx INSERT.

**Impact:** Rebuild views `chiefos_portal_job_summary`, `chiefos_portal_cashflow_daily` sum from `transactions`. Without the parallel rows, mileage + overhead expenses vanish from P&L.

**Recommendation (per-lane):**
1. **Mileage:** Wrap `insertMileageLog` in a transaction that also INSERTs `transactions (kind='expense', category='mileage', source_msg_id=<same>, amount_cents=deductibleCents, source='mileage')` with `ON CONFLICT (owner_id, source_msg_id) DO NOTHING`.
2. **Overhead:** Same pattern. Define `source_msg_id = 'overhead:'||item_id||':'||YYYYMM` as the deterministic idempotency key.
3. Add symmetric edit/void propagation.

### 6.2 Audit 7 — Activity-logs emission coverage — **GAP: 1 of ~10 lanes; uses pre-rebuild shape**

**Finding 1:** Only the crew-review lane emits `chiefos_activity_logs`. No other canonical write emits logs.

**Evidence of the one-lane emitter:** `services/crewControl.js:178, 215` (INSERTs). All other `chiefos_activity_logs` references in the codebase are UPDATEs (status transitions) or SELECTs. No emission from: `transactions` writes, `jobs`, `tasks`, `time_entries_v2`, `customers`, `chiefos_quotes`, `mileage_logs`, `overhead_items`, `overhead_payments`, `intake_items`.

**Finding 2:** No system-actor convention exists.

**Finding 3:** The one existing emitter uses pre-rebuild shape — columns `created_by_actor_id` (FK to discarded `chiefos_actors`), with a paired INSERT into `chiefos_activity_log_events` (flattened / DISCARDed in rebuild).

**Impact:** Rebuild's audit surface has near-zero coverage at cutover. Any UI/feature depending on `chiefos_activity_logs` (portal audit view, row-history drill-down) will show empty results.

**Recommendation:** Centralize a `emitActivityLog({tenantId, ownerId, actionKind, targetTable, targetId, correlationId, actorUserId | portalUserId})` helper in `services/postgres.js`. Call from every canonical INSERT/UPDATE/DELETE. Designate a system-user row in `public.users` (user_id='system') for cron/background writes.

### 6.3 Audit 8 — Counter allocation — **TWO BROKEN ALLOCATORS**

**Finding 1:** `jobs.job_no` uses legacy `MAX(job_no)+1` scan (race-prone, wrong boundary).
- **Evidence:** `services/postgres.js:2042-2050` (`allocateNextJobNo`) — `SELECT COALESCE(MAX(job_no),0)+1 FROM public.jobs WHERE owner_id=$1`.
- Scoped by `owner_id` (should be `tenant_id`). Not using `chiefos_tenant_counters`.

**Finding 2:** `tasks.task_no` has NO app-level allocator.
- `services/postgres.js:3422` INSERT omits `task_no` entirely. Either a DB trigger/default supplies it (but rebuild DROPs those triggers) or rows get NULL `task_no`.
- **At cutover, task creates will fail** (the rebuild's `tasks.task_no NOT NULL` CHECK will reject NULL).

**Finding 3:** `chiefos_quotes.human_id` is correctly wired via `allocateNextDocCounter(tenantId, COUNTER_KINDS.QUOTE)` at `src/cil/quotes.js:1975`. ✓

**Finding 4:** `chiefos_activity_logs.log_no` correctly uses `allocateNextDocCounter` with `COUNTER_KINDS.ACTIVITY_LOG` at `services/crewControl.js:170`. ✓

**Finding 5:** No in-app references to legacy `job_counters` / `task_counters` DB objects. ✓

**Recommendation:** Rewrite `allocateNextJobNo` to call `chiefos_next_tenant_counter(tenantId, 'job')`. Add `JOB: 'job'` and `TASK: 'task'` to `src/cil/counterKinds.js`. Add an explicit `allocateNextDocCounter(tenantId, 'task', client)` call to every `tasks` INSERT path.

### 6.4 Audit 9 — CIL handler audit — **ONLY EXPENSE LANE STAGES; PRE-REBUILD SHAPE; NO correlation_id THREADING**

**Finding 1:** Only the expense WhatsApp lane writes to `cil_drafts` (`services/postgres.js:1258` via `createCilDraft`, called from `handlers/commands/expense.js:640, 817, 8529, 9107`).

**Finding 2:** Every call site uses pre-rebuild shape: `kind` (→ rebuild's `cil_type`), `status='draft'` (column DROPPED), `actor_phone`/`actor_user_id` (DROPPED), `confirmed_transaction_id` (DROPPED). 5 UPDATE sites target `status`; `cancelBySourceMsg` uses `actor_phone`.

**Finding 3:** All non-expense confirm paths BYPASS `cil_drafts` entirely.
- `chiefos-site/app/api/intake/items/[id]/confirm/route.ts:306` — direct `transactions` INSERT, no draft staging.
- `services/postgres.js:2181` (jobs), `:3422` (tasks), `handlers/commands/mileage.js:134`, `chiefos-site/app/api/overhead/mark-paid/route.ts:62` — all bypass `cil_drafts`.

**Finding 4:** `correlation_id`/`trace_id` NOT threaded. `services/postgres.js:1258-1283` insert list lacks both. Quotes lane has `correlation_id` on `chiefos_quote_events` only, never propagated back to `cil_drafts`.

**Finding 5:** Pre-rebuild-shape call sites that will break at cutover:
- `services/postgres.js:1258, 1316, 1346, 1373, 1430, 1465` — 6 helpers
- `handlers/commands/expense.js:640, 817, 7320, 7840, 8529, 9107` — callers
- `services/crewControl.js:178, 215` — pre-rebuild activity-log shape (related audit)

**Recommendation:** Rewrite CIL helpers in `services/postgres.js` to rebuild shape (uuid id, `cil_type`, `validated_at`/`committed_at`, dropped actor columns, composite idempotency by `(owner_id, source_msg_id, cil_type)`). Thread `correlation_id` from ingress through every canonical write.

---

## 7. Remediation Plan

Given the scale (~270 BLOCKING), single-session remediation is infeasible. Recommended **6-session remediation cadence**:

### Session R1 — Entire-file deletions (low risk, high volume)
Delete files built wholly on DISCARDed concepts. No replacement logic required; just gate the features off.

**Backend deletions:**
- `routes/crewAdmin.js`, `routes/crewReview.js`, `routes/crewControl.js`, `routes/crew.js`, `services/crewControl.js`
- `routes/supplierPortal.js`, `routes/catalog.js`, `middleware/requireSupplierUser.js`, `services/catalogIngest.js`, `services/agentTools/supplierSpend.js`, `services/agentTools/catalogLookup.js`, `domain/pricing.js`
- `services/memory.js`, `services/reminders.js`
- `services/rag_search.js`, `services/ragTerms.js`, `services/tools/rag.js`, `scripts/ingestRAG.js`
- `domain/changeOrder.js`
- `services/anomalyDetector.js`, `routes/alerts.js`
- `workers/forecast_refresh.js`, `scripts/demoKpi.js`, `services/agentTools/getJobKpis.js`

**Portal deletions:**
- `chiefos-site/app/supplier/**`, `chiefos-site/app/app/catalogs/**`, `chiefos-site/app/app/admin/suppliers/**`, `chiefos-site/app/api/catalog/**`, `chiefos-site/app/api/admin/suppliers/**`
- `chiefos-site/app/app/documents/**`, `chiefos-site/app/api/documents/**`, `chiefos-site/app/sign/[token]/page.tsx` (job_documents/files)
- `chiefos-site/app/app/activity/expenses/audit/page.tsx` (duplicate of vendors page; delete)

Update route-registrations in `index.js` / `cil.js` to remove references. Update package.json scripts if any refer to deleted workers.

### Session R2 — Identity resolver migration (highest-risk hot path)
Replace `v_actor_identity_resolver` + `v_identity_resolver` + `chiefos_phone_active_tenant` + `chiefos_user_identities` + `chiefos_identity_map` usage with direct `chiefos_portal_users` / `users` queries.

Files: `middleware/userProfile.js`, `middleware/requirePortalUser.js`, `services/postgres.js` (getTenantIdForOwnerDigits + callers), `routes/webhook.js`, `routes/portal.js`, `routes/account.js`, `handlers/media.js`.

### Session R3 — cil_drafts + activity_logs shape migration
Rewrite `services/postgres.js` CIL helpers to rebuild shape. Introduce `emitActivityLog` helper and call from every canonical write. Designate `'system'` user for background writes. Migrate `services/crewControl.js` activity-log writes.

### Session R4 — Counter + tasks + mileage/overhead parallel-tx
Fix `allocateNextJobNo` to use `chiefos_tenant_counters`. Add `task_no` allocator. Add parallel-`transactions` emission to mileage + overhead confirm handlers. Add `TASK` / `JOB` to `counterKinds.js`.

### Session R5 — Portal RPC replacement
Delete all 19 `supabase.rpc(` call sites. Replace with RLS-gated table operations:
- `chiefos_finish_signup` → app-code INSERT into `chiefos_tenants` + `chiefos_portal_users` under RLS
- `chiefos_create_link_code` → INSERT `portal_phone_link_otp`
- All expense/vendor/trash RPCs → direct table operations on `transactions` / `vendor_aliases` / `chiefos_deletion_batches`
- Saved-views feature: decide delete vs rebuild-client-side

### Session R6 — Column renames + cleanups + tenant-boundary tightening
- Rename `intake_item_reviews.reviewed_by_auth_user_id` → `reviewed_by_portal_user_id` (15+ sites)
- Rename `tasks.type` → `kind` (4 sites)
- Fix `llm_cost_log` column names + unit (USD→cents) in costLogger.js
- Rewrite `services/integrity.js` INSERT to rebuild `integrity_verification_log` shape
- Remove OCR columns from `media_assets` write in `handlers/media.js` — move OCR to `parse_jobs` flow
- Add tenant-boundary filters to 6 portal UPDATEs in `chiefos-site/app/app/jobs/[jobId]/page.tsx` + `overhead/page.tsx`
- Drop references to removed `users` columns (`subscription_tier`, `paid_tier`, `trial_end`, `dashboard_token`, `otp*`, `is_team_member`, `onboarding_in_progress`) — replace with equivalent fields or remove features
- Fix `time_entries_v2.job_id` uuid→integer call sites
- Remove legacy `time_entries` (v1) dual-write from `services/postgres.js::logTimeEntry`
- Remove `kpi_touches`, `job_kpis_daily`, `usage_monthly*`, `user_active_job`, `category_rules`, `fact_events`, `chief_actor_memory` service-code references
- Fix the legacy `services/ai_confirm.js` + `services/postgres.js:460` reads on `chiefos_expenses`

### Total effort estimate: ~2-3 weeks of focused remediation work before Phase 5 cutover is safe.

---

## 8. Blocking List (Condensed, Priority-Ordered)

1. **Identity resolver hot-path** (every authenticated request): `v_actor_identity_resolver` in `middleware/userProfile.js:176` + `middleware/requirePortalUser.js:127` + `services/postgres.js:195`
2. **19 portal RPC calls** in `chiefos-site/app/` — all invoke DISCARDed SECDEF functions
3. **cil_drafts pre-rebuild shape** — 6 helpers in `services/postgres.js:1258-1478`
4. **Activity-logs emission coverage** — 1 of 10 lanes emits; uses pre-rebuild shape
5. **`jobs.job_no` allocator** uses legacy `MAX+1` scan in `services/postgres.js:2042`
6. **`tasks.task_no` has no allocator** — inserts will fail
7. **Mileage + overhead parallel-tx emission missing** — financial totals broken at cutover
8. **Supplier catalog** — ~60 BLOCKING sites across 15+ files (mostly deletable)
9. **Actor cluster** — ~40 BLOCKING across crew/timeclock/webhook/middleware/portal
10. **Legacy `time_entries` v1 dual-write** in `services/postgres.js::logTimeEntry` — 12+ sites
11. **KPI cluster** — `services/kpis.js`, `services/jobsKpis.js`, `workers/forecast_refresh.js`, `services/kpiWorker.js`, `handlers/commands/job_kpis.js`
12. **`intake_item_reviews.reviewed_by_auth_user_id`** — 15+ portal API sites
13. **`integrity_verification_log` shape** — `services/integrity.js:251`
14. **`users` dropped columns** — 50+ sites across service modules + portal
15. **`media_assets` OCR writes** — `handlers/media.js:209-232`
16. **Portal deviation C** — 6 UPDATEs without tenant boundary in jobs/overhead pages
17. **Chief_actor_memory** — `services/postgres.js:1130-1161`
18. **Signup flow** — `chiefos_finish_signup`, `chiefos_pending_signups`, `chiefos_create_link_code`
19. **`chiefos_link_codes`** — pairing codes (3 portal sites + webhook)
20. **`chiefos_expenses`** — legacy read in `services/postgres.js:460` + portal trash page

---

## 9. Non-Blocking & Trivial List

**NON-BLOCKING (~15):**
- `services/brain_v0.js` evidence-metadata label strings referencing `v_cashflow_daily`, `v_job_profit_simple_fixed`
- `services/insights_v0.js` user-facing strings mentioning discarded views
- Cookie-name strings using `dashboard_token` in `middleware/requireDashboardOwner.js`, `routes/receipts.js`, `routes/askChief.js`, `routes/askChiefStream.js`, `chiefos-site/lib/apiAuth.js` (cookie name can stay even if column drops)
- Comment at `routes/employee.js:390` re: `time_entries_v2.job_id` type — will go stale at cutover
- `chiefos-site/lib/intake/types.ts:177` TypeScript type mirroring `reviewed_by_auth_user_id` — update alongside API routes
- `services/brain_v0.js:181` evidence label string mentioning `fact_events`

**TRIVIAL (~10):**
- User-facing / log-message strings in `services/insights_v0.js:937`, `services/postgres.js:207, 228`
- Comment-only references in `services/kpis.js:4, 14, 243`, `services/jobsKpis.js:5, 20, 76`
- `scripts/bootstrap-local-db.sql:35` CREATE TABLE `time_entries` for local dev — update or delete

---

## 10. Open Design Questions (Need Founder Decisions Before Remediation)

1. **System-actor convention for activity_logs** (Audit 7 Finding 2). Three options:
   - (a) Synthetic `users` row with `user_id='system'` — ChiefOS-native
   - (b) Relax the CHECK constraint to allow both-NULL with a new `system_reason text` column — schema change
   - (c) Route system writes through owner's user_id when available — ambiguous provenance
   **Recommendation: (a).** Cleanest, preserves CHECK. Requires a one-row seed migration.

2. **Saved-views feature** (RPC set discarded). Does the portal keep this UX? If yes, rebuild client-side against a new `user_saved_views` table. If no, delete the feature (remove ~200 lines in `chiefos-site/app/app/activity/expenses/page.tsx`).

3. **KPI views feature scope.** The 7 DISCARDed KPI views feed portal dashboards. Rebuild's `chiefos_portal_job_summary` replaces per-job views. What replaces company_balance_kpis / company_kpis_{weekly,monthly}? If the portal KPI dashboard is kept, new views must be authored. If deferred/deleted, the dashboard UI needs removal.

4. **Supplier catalog scope.** Decision 6 says "out of scope." But the portal has `/supplier/**` routes and suppliers on `/admin/suppliers/**`. Confirm these are delete-not-defer.

5. **Documents/job_documents scope.** Decision 8 DISCARDs the documents cluster. The portal has `/documents/**`, `/sign/[token]/page.tsx`, and intake confirm handlers integrate with them. Confirm delete-not-defer.

6. **Reminders feature scope** (`services/reminders.js`, 9 call sites). `reminders` table DISCARDed per §6.1 "REVIEW" stance. Delete the feature entirely, or replace with a simpler app-side cron? Overhead reminders are separate (KEEP).

7. **Chief_actor_memory + entity_summary data.** Pre-rebuild stored conversational memory; rebuild moves to `conversation_sessions.active_entities` jsonb. Does prior memory data need backfill-migration into the jsonb shape, or is starting fresh acceptable?

8. **Dashboard_token cookie identity.** Rebuild drops `users.dashboard_token`. What replaces the dashboard auth path? Options:
   - (a) Migrate dashboard users to Supabase Auth with JWT
   - (b) Keep the cookie but store token in a new `dashboard_sessions` table
   - (c) Delete the dashboard surface (if no longer used)

---

## 11. File Inventory

**Created in Phase 4:**
- `PHASE_4_DISCARD_REGISTRY.md` — working reference list of DISCARDed objects
- `PHASE_4_APP_CODE_AUDIT_REPORT.md` — this document

**Untouched:**
- All migrations and rebuild artifacts.
- All app code (no remediation happened this session).
- All design documents.

---

Phase 4 App Code Audit complete. Remediation list produced: ~270 BLOCKING, ~15 NON-BLOCKING, ~10 TRIVIAL. Ready for Founder Checkpoint 4 review before remediation session.
