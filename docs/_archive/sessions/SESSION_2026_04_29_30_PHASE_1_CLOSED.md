# Session Summary — 2026-04-29/30 — Phase 1 Closed

**Session bookends:** Started ~13:00 UTC 2026-04-29 with Phase 1 §5.1/§5.2/§5.4 recon directive; closed ~00:42 UTC 2026-04-30 with RLS round-trip verified and PR #14 production-applied.

## What landed

| PR | Type | Commit on main | Purpose |
|---|---|---|---|
| #12 | feat | fa45da1e | Phase 1 PR-A — chiefos_tenants lifecycle (§5.1) + plan_key (§5.2) consolidation + RPC P1A-14 + spec amendments to §5.1/§5.2/§6/§7/§8/§9.3/§9.4 |
| #13 | feat | 884fdd65 | Phase 1 PR-B — acquisition_events + landing_events (§5.4) two-table funnel telemetry; FK target corrected (chiefos_tenants(id), not nonexistent users(id)); RLS policy on acquisition_events |
| #14 | feat | b0fced8e | Phase 1 PR-B follow-up — GRANT statements missed in PR-B; closes RLS reachability gap surfaced by production-apply round-trip test |

## Production state

- Schema: v1.1-compliant for §5.1, §5.2, §5.4. All 4 production migrations applied successfully:
  - `2026_04_29_phase1_pra_lifecycle_and_plan_key_on_chiefos_tenants.sql` (12 lifecycle cols + plan_key on chiefos_tenants; users.plan_key dropped)
  - `2026_04_29_amendment_p1a14_chiefos_finish_signup_rpc_lifecycle_and_plan.sql` (RPC body delta from P1A-13: drops users.plan_key write; relies on column DEFAULTs)
  - `2026_04_29_phase1_prb_acquisition_events_and_landing_events.sql` (two tables, FK, RLS, SELECT policy)
  - `2026_04_29_phase1_prb_grants_followup.sql` (3 GRANT statements; RLS reachability restored)
- chiefos_tenants column count: 14 → 27 (+13: 12 lifecycle + plan_key)
- users column count: 26 → 25 (−1: plan_key dropped)
- chiefos_finish_signup body_md5: 9168466d… (P1A-13) → 0c5d4247… (P1A-14)
- New tables: acquisition_events (RLS enabled, 1 SELECT policy, FK to chiefos_tenants ON DELETE CASCADE, 5 indexes), landing_events (no RLS, 4 indexes)
- Grants now consistent with precedent: acquisition_events (auth=1 SELECT, service=4 CRUD), landing_events (auth=0, service=4 CRUD)
- Data: zero-row baseline preserved across all migrations and RLS round-trip tests
- Auth: 0 users; clean canvas for first-signup integration test

## RLS round-trip verification (deterministic, 4-scenario, rolled back)

| # | Scenario | Expected | Actual | Pass |
|---|---|---|---|---|
| 1 | Tenant A user (auth.uid `1111…`) | 2 rows of Tenant A | 2; tenant_ids = {aaaa…} | ✓ |
| 2 | Tenant B user (auth.uid `2222…`) | 1 row of Tenant B | 1; tenant_ids = {bbbb…} | ✓ |
| 3 | Unmapped user (auth.uid `9999…`) | 0 rows | 0 | ✓ |
| 4 | Service role (RLS bypass) | 3 rows | 3 | ✓ |

End-to-end tenant isolation verified. RLS policy works under real authenticated contexts.

## Tomorrow's queue

1. **Live integration test of v1.1 onboarding spine end-to-end:** Scott's re-signup. Exercise auth signup → `chiefos_finish_signup` RPC → chiefos_tenants row populated with `lifecycle_state='pre_trial'`, `plan_key='trial'`, `phone_e164` from owner_phone, `paid_breaks_policy='unpaid'` default, `tax_region` GENERATED from country/province → chiefos_portal_users mapping (auth.uid → tenant_id) → public.users actor row (no plan_key column).
2. After signup: verify all expected row shapes via Supabase MCP execute_sql.
3. Phase 2 scoping (lifecycle reconciliation cron, lifecycle transition functions, event-emitting application code for acquisition_events / landing_events).

## P1B trackers carried forward

From Phase 0 (6):
- P1B-whoami-test-coverage (PR #8)
- P1B-finish-signup-rpc-test-coverage (PR #9)
- P1B-employer-policies-policy-jsonb-column-missing (PR #10)
- P1B-tenant-debug-command-broken-columns (PR #10)
- P1B-systematic-stale-query-audit (PR #10) — codebase-wide audit for the stale-query bug pattern
- users.tz LOW deferred finding

New from Phase 1 (2):
- P1B-application-code-plan-key-source-update (PR #12) — application code reads of users.plan_key (handlers, services, routes) need to migrate to chiefos_tenants.plan_key via tenant_id JOIN
- P1B-rls-grant-pattern-for-future-tables (PR #14) — every ENABLE ROW LEVEL SECURITY table must include explicit GRANT statements in the same migration; documented as binding pattern in TMTS_v1.1.md §5.4

Total open: 8 trackers. None blocking Phase 2.

## Patterns established that Phase 2 reuses

- Recon → author → review → merge → production-apply → verify cycle scales cleanly across 3+ PRs in a session
- RLS round-trip test as deterministic verification: synthetic transaction with ROLLBACK proves end-to-end tenant isolation without leaving production state
- Hard gates between schema apply and RPC apply (PR-A) and between schema apply and verification (PR-B) caught the GRANT gap before it surfaced as a production runtime error
- Spec amendments ride alongside the migration that requires them (consistent with PR #9 / PR #10 / PR #12 / PR #13 / PR #14)
- "Spec literal" doesn't override "schema reality" — when they conflict, recon decides and amends spec. Phase 1 caught two spec defects (§5.4 FK to users(id) which doesn't exist; §5.2 constraint name `_check` vs `_chk`)
- PR-B's gap-then-followup precedent now codified: any new RLS table must include schema + RLS + policy + GRANT in the same migration. Two-PR cycles for RLS+GRANT are explicitly anti-pattern going forward.
- Worktree pattern protects in-flight work in primary tree (~49 untracked/modified files; normal state)

## Numbers

- 3 PRs merged (#12, #13, #14)
- 4 production migrations applied
- 0 rollbacks needed
- 0 partial states or production crashes
- 1 production gap surfaced + closed within session (RLS reachability — caught by round-trip test, fixed by PR #14)
- 4/4 RLS round-trip scenarios passed
- Row counts unchanged through entire session (synthetic test data rolled back deterministically)
- 8 P1B trackers open at session close (6 carried + 2 new); none blocking

## Opening move next session

1. Confirm production health (curl checks against app.usechiefos.com)
2. Confirm git state (main at b0fced8e, no leftover branches/worktrees)
3. Read this file + docs/migrations/phase1/ verification SQL files if needed
4. Begin live integration test signup; verify all row shapes post-signup match v1.1 expectations

---

*End of session — 2026-04-29/30 — PHASE 1 COMPLETE*
