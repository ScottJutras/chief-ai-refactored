# Session R1 — Remediation Report

**Date:** 2026-04-23
**Scope:** First remediation session per `PHASE_4_5_DECISIONS_AND_HANDOFF.md` §5 — feature-safe deletions only. No refactoring, no architectural decisions.
**Authority:** R1 directive; `PHASE_4_5_FEATURE_CLASSIFICATION_REPORT.md` §1 DELETE-SAFELY + Q1 founder decision; `PHASE_4_5B_SUB_AUDIT_REPORT.md` Q6 KPI-cluster findings.

---

## 1. Executive Summary

- **10 files deleted** (R1 directive expected 14; directive's count sums Phase 4.5 list + Phase 4.5b Q6 list without deduplication — the distinct union across both lists is 11 DELETE-SAFELY files; 10 deleted this session with 1 deferred).
- **1 file deferred from deletion**: `chiefos-site/app/app/activity/expenses/audit/page.tsx`. Confirmed DELETE-SAFELY in Phase 4.5 §1 but 4 portal pages navigate to `/app/activity/expenses/audit` — deletion would produce 404s. Deferred per directive's STOP rule on chiefos-site discovery findings.
- **3 live-code references cleaned up**: `index.js:97` (dashboardRouter require), `index.js:212` (mount at `/api/dashboard`), `package.json:14` (`worker:kpi` script).
- **1 new migration + 1 rollback** authored: `2026_04_22_remediation_drop_users_dashboard_token.sql` drops orphaned `users.dashboard_token` column.
- **Manifest updated** with R1 session-history entry, apply-order step 24, forward flags 22 + 23 (app-side cleanup + audit-page navigation), and rollback listing.
- **Regression checks pass**: `node --check index.js` exits clean; `require('./index.js')` resolves all modules (only runtime API-key init errors, which are environment-related, not module-related); `handlers/commands/job_kpis.js` still loads.
- **No changes to `chiefos-site/app/**`** (verified via `git status chiefos-site/` returning empty).

---

## 2. Files Deleted

| # | Path | Classification Source | Lines | Rationale |
|---|---|---|---|---|
| 1 | `routes/crew.js` | Phase 4.5 Q1 founder decision | 270 | Not mounted in `index.js`; superseded by `routes/crewReview.js` |
| 2 | `workers/forecast_refresh.js` | Phase 4.5 §1 (confirmed Q6) | 17 | Refreshes 4 DISCARDed KPI views; no importers |
| 3 | `workers/kpi_refresh.js` | Phase 4.5 §1 (confirmed Q6) | 97 | Orphaned; reads DISCARDed `time_entries`, writes DISCARDed `timesheet_rollups` |
| 4 | `scripts/demoKpi.js` | Phase 4.5 §1 (confirmed Q6) | 23 | Demo script; hardcoded owner_id; references 3 DISCARDed tables |
| 5 | `services/agentTools/getJobKpis.js` | Phase 4.5 §1 (confirmed Q6) | 40 | Not in live Ask Chief agent registry; only referenced from archive/legacy/ |
| 6 | `services/kpis.js` | Phase 4.5b Q6 (new) | — | Only consumers were `routes/dashboard.js` + `routes/api.dashboard.js` (both deleted here) |
| 7 | `services/jobsKpis.js` | Phase 4.5b Q6 (new) | — | Same consumers as above |
| 8 | `services/kpiWorker.js` | Phase 4.5b Q6 (new) | — | Only consumer was `scripts/demoKpi.js` (deleted); writes DISCARDed `job_kpis_daily` |
| 9 | `routes/dashboard.js` | Phase 4.5b Q6 (new) | — | Legacy HTML dashboard; auth via DISCARDed `dashboard_token`; superseded by Next.js portal |
| 10 | `routes/api.dashboard.js` | Phase 4.5b Q6 (new) | — | Same disposition; not registered in `index.js` (discovery — see §5.2) |

Deletion method: `git rm` (staged as `D` in git status).

---

## 3. File Deferred from R1

### `chiefos-site/app/app/activity/expenses/audit/page.tsx`

**Classification:** DELETE-SAFELY (confirmed duplicate per Phase 4.5 §1 line 509-511).

**Reason for deferral:** 4 portal pages + 1 redirect land on `/app/activity/expenses/audit`:

| File | Line | Navigation |
|---|---|---|
| `chiefos-site/app/app/expenses/audit/page.tsx` | 3 | `redirect("/app/activity/expenses/audit")` |
| `chiefos-site/app/app/activity/expenses/page.tsx` | 1107 | `router.push("/app/activity/expenses/audit")` — "Change log" button |
| `chiefos-site/app/app/activity/expenses/vendors/page.tsx` | 178 | `router.push("/app/activity/expenses/audit")` |
| `chiefos-site/app/app/activity/expenses/trash/page.tsx` | 224 | `router.push("/app/activity/expenses/audit")` |
| `chiefos-site/app/app/activity/expenses/audit/page.tsx` | 178 | `router.push("/app/activity/expenses/audit")` — self-link |

Phase 4.5b Q6's investigation was scoped to KPI cluster; these navigation targets were not audited at the time. Deleting the page without redirecting the navigation targets would break the "Change log" button + related UI flows.

**Per R1 directive boundary** ("No changes to chiefos-site/app/**"), this session cannot rewrite the navigation targets. Following the directive's STOP rule for chiefos-site discovery findings: deferred.

**Founder decision requested:** see manifest §5 Forward Flag 23. Options:
- (a) Redirect the 4 navigation targets to `/app/activity/expenses/vendors` (true semantic replacement — both pages are byte-near-duplicate, same RPCs, same table) then delete.
- (b) Retain the audit page until the DISCARDed RPCs (`chiefos_list_vendors`, `chiefos_normalize_vendor`) are replaced with app-code normalization per §5.2; at that point both pages consume the same path and deletion is trivial.

Recommendation (non-binding): option (a) — the audit page literally starts with `// app/app/expenses/vendors/page.tsx` as a comment (copy-paste artifact), confirming it's a drift duplicate. One-line change in 4 files plus the redirect collapses to the canonical vendors route.

---

## 4. References Removed

### `index.js`

- **Line 97 (removed):** `const dashboardRouter = require("./routes/dashboard");`
- **Line 212 (removed):** `app.use("/api/dashboard", dashboardRouter);`
- Adjacent comment `// Account + Dashboard` collapsed to `// Account`.

### `package.json`

- **Line 14 (removed):** `"worker:kpi": "node services/kpiWorker.js",`

### Not present (verified via grep)

- No `app.use` mount for `routes/api.dashboard.js` — the file had never been registered in `index.js` (discovery finding, non-blocking; file was pure legacy code not actually reachable).
- No cron / orchestration configs for the workers. Phase 4.5b Q6 already noted this (`"grepped kpi_refresh and forecast_refresh across all cron/worker files and nothing imports processBatch or kpiWorker at runtime"`).
- No Ask Chief agent registry entry for `services/agentTools/getJobKpis.js` (Phase 4.5 §1 confirmed absence at `services/agent/index.js`).

### Deferred cleanup (out of R1 scope)

- `services/postgres.js:3370, 3385, 4593` — live references to `dashboard_token` (INSERT, column list, SELECT WHERE). These will error after the column-drop migration applies at cutover. **Scheduled for R9** per `PHASE_4_5_DECISIONS_AND_HANDOFF.md` §5 "Column renames, tenant-boundary tightening, users dropped columns". Tracked in manifest §5 Forward Flag 22.
- Cookie-name string references in `middleware/requireDashboardOwner.js`, `routes/receipts.js`, `routes/askChief.js`, `routes/askChiefStream.js`, `chiefos-site/lib/apiAuth.js` — NON-BLOCKING per Phase 4 audit (string literals `"chiefos_dashboard_token"` / `"dashboard_token"`; no column access).

---

## 5. Migration Authored

### `migrations/2026_04_22_remediation_drop_users_dashboard_token.sql`

```sql
BEGIN;

ALTER TABLE public.users
  DROP COLUMN IF EXISTS dashboard_token;

COMMIT;
```

**Apply-order placement:** step 24 in manifest §3. Runs after all Phase 3 + amendment + P3-4c migrations. The column-drop is safe-at-cutover provided `services/postgres.js` references have been cleaned in R9 by then.

### `migrations/rollbacks/2026_04_22_remediation_drop_users_dashboard_token_rollback.sql`

Restores `dashboard_token text NULL`. Pre-drop values are NOT preserved (shape-only rollback).

---

## 6. Manifest Updates (`REBUILD_MIGRATION_MANIFEST.md`)

- **Session history (§header):** added R1 entry summarizing deletions + deferred audit page + `dashboard_token` migration.
- **Apply Order §3:** added step 24 (`remediation_drop_users_dashboard_token`).
- **Forward Flags §5:** added flag 22 (`users.dashboard_token` app-side cleanup deferred to R9) and flag 23 (audit-page navigation pending founder decision).
- **Rollback Posture §6:** added rollback entry for step 24.

No modifications to existing Phase 3, P1A-1/2/3, or P3-4c entries.

---

## 7. Regression Check Outcomes

| Check | Result |
|---|---|
| `npm run lint` | Not configured — no lint script in `package.json`. Skipped per directive fallback. |
| `npm run typecheck` | Not configured — project is plain JavaScript. Skipped. |
| `node --check index.js` | PASS — exit 0, no syntax errors. |
| `node -e "require('./index.js')"` module resolution | PASS — zero `Cannot find module` errors. Only failure is runtime API-key init (`Neither apiKey nor config.authenticator provided` from Twilio/OpenAI SDK), which is environment-dependent, not a missing-module issue. |
| `node -e "require('./handlers/commands/job_kpis.js')"` | PASS — file loads cleanly despite its `job_kpis` name echoing the deleted KPI cluster (file is not classified DELETE-SAFELY; out of R1 scope). |
| `grep routes/(crew\|dashboard\|api\.dashboard)\|workers/...\|services/kpis...` across live `.js` | PASS — only remaining hits are `routes/crewAdmin`, `routes/crewControl`, `routes/crewReview` (all preserved files) + `.md` documentation references (expected). |
| `git diff --stat chiefos-site/` | PASS — zero changes. |
| `git status` includes the 10 `D` entries | PASS. |

---

## 8. Surprises Surfaced

### 8.1 Directive file count (14) vs actual distinct count (11)

The R1 directive stated "14 files identified as DELETE-SAFELY across Phase 4.5 and Phase 4.5b". The actual distinct union across the two reports is 11 files:

- Phase 4.5 §1 DELETE-SAFELY: 5 files (4 KPI + 1 audit page)
- Phase 4.5 Q1 founder promotion: 1 file (`routes/crew.js`) — total Phase 4.5 = 6
- Phase 4.5b Q6 DELETE-SAFELY: 9 files (4 overlap with Phase 4.5, 5 new)
- Distinct union: 5 (Phase 4.5 unique) + 5 (Q6 unique) + 1 (Q1) = 11

Proceeded with the 11 distinct files; deferred the audit page; deleted 10.

### 8.2 `routes/api.dashboard.js` never registered in `index.js`

Phase 4.5b Q6 line 121 stated "Both `routes/dashboard.js` and `routes/api.dashboard.js` are mounted (`index.js:212` — `app.use("/api/dashboard", dashboardRouter)`)". Only `routes/dashboard.js` is actually registered at that line. `routes/api.dashboard.js` had no `app.use` or `require` in `index.js` — it was pure legacy code with no reach. Not blocking (file is deleted; the confusion is just in Q6's phrasing of "both mounted").

### 8.3 Audit-page inbound navigation gap

The Phase 4.5 classification of `chiefos-site/app/app/activity/expenses/audit/page.tsx` as DELETE-SAFELY correctly identified it as a byte-near-duplicate of `.../vendors/page.tsx` but did not audit inbound navigation. 4 portal pages link to the audit route. Flagged (§3 above + manifest §5 Forward Flag 23).

### 8.4 `handlers/commands/job_kpis.js` exists, uncategorized

`PHASE_4_APP_CODE_AUDIT_REPORT.md:423` lists this file in the "KPI cluster" group, but Phase 4.5 and Phase 4.5b did not explicitly classify it. It loads cleanly (no broken imports) so R1 doesn't touch it. Likely destined for DELETE-SAFELY at a later remediation session once its registration / reach is audited.

---

## 9. Readiness for R2

**R2 scope per `PHASE_4_5_DECISIONS_AND_HANDOFF.md` §5 (revised cadence):** Identity resolver migration — replace `v_actor_identity_resolver`, `v_identity_resolver`, `chiefos_phone_active_tenant`, `chiefos_user_identities`, `chiefos_identity_map` with direct `chiefos_portal_users` / `users` queries. Hot path, high priority.

**R1 prerequisites for R2:** none — R1 was scope-isolated (pure deletion). The identity-resolver refactor is independent of the KPI-cluster cleanup.

**Environment state for R2:**
- 10 files deleted, live code compiles + resolves cleanly.
- `dashboard_token` migration authored (applies at cutover; not yet applied).
- `services/postgres.js` dashboard_token references remain (R9 scope — not a blocker for R2).
- All Phase 3 + amendment + P3-4c migrations unchanged.
- Manifest current.

R2 can begin cleanly from this state.

---

## 10. Flagged Items for Founder Review

1. **Audit-page navigation decision (manifest §5 Forward Flag 23)** — before the audit-page deletion can proceed safely, one of: (a) redirect 4 portal navigations to `/app/activity/expenses/vendors` and delete the page; (b) retain until the DISCARDed RPCs are replaced with app-code. Recommend (a).

2. **Directive file-count reconciliation** — future remediation directives should quote distinct-union counts to avoid the "14 vs 11" confusion. Non-actionable, informational.

3. **`handlers/commands/job_kpis.js` future disposition** — file exists, loads, but was grouped with the KPI cluster in Phase 4 audit without a classification in Phase 4.5 / 4.5b. Likely DELETE-SAFELY pending a confirmation audit. Consider folding into a later R-session's scope.

---

## 11. No Commits

Per R1 directive: no git commits made in this session. All changes staged / working-tree only.

---

**End of R1 remediation report.**
