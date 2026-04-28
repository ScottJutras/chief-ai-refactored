# Phase 5 Cutover — COMPLETE

**Cutover completed**: 2026-04-28 13:39 UTC (live WhatsApp test webhook traffic served against the new database, fail-closed identity resolution returned the canonical post-rebuild "not linked" prompt, webhook responded HTTP 200, no crashes).

**Production database**: `tctohnzqxzrfijdufrss` (Supabase project name: CHiefOS, region: us-west-2, PG 17.6).

**Production deployment**: SHA `facffe8f` (merge of PR #2 `cutover-integration-parity`), promoted to production at Vercel deployment `dpl_62DhrVgLY9v2egs8gkvbQpLQCnfP`.

## Schema state at cutover (frozen)

| Surface | Count |
|---|---|
| Tables (public schema) | 77 |
| Views | 8 |
| Functions | 133 |
| Triggers (non-internal) | 61 |
| RLS policies | 170 |
| Migrations recorded | 37 / 37 |
| Sentinel rebuild migrations applied | 26 / 26 |

## Live state at cutover

| Surface | Count |
|---|---|
| auth.users | 3 (V3 synthetic seed) |
| chiefos_tenants | 1 (Acme Renovations Inc, owner_id `14165550100`) |
| transactions | 20 (V3 seed) |
| time_entries_v2 | 10 (V3 seed) |
| Per-tenant integrity chain (transactions) | INTACT — every row's stored `record_hash` matches `sha256(hash_input_snapshot::text)` |

## Cutover-completion criteria — verified

1. ✅ Production webhook responds HTTP 200 (Vercel runtime logs at 13:39:38 UTC).
2. ✅ Identity resolution fail-closes correctly when phone has no tenant — returns post-rebuild "not linked" prompt, no data leakage, no orphan rows persisted.
3. ✅ Integrity chain trigger-stamped + JS-verifier-aligned (V6.B resolved). 16/16 byte-equivalence tests pass against production samples.
4. ✅ All 503 gates verified live by founder against production: `/api/auth/signup`, `/api/auth/pending-signup`, `/api/tester-access/activate` (POST), `/api/log` (chiefos-site).
5. ✅ Stranded `auth.users` row from the 2026-04-27 broken signup attempt deleted; `auth.users` count is back to clean V3-seed state of 3.
6. ✅ No `[STUB]` warn logs surfaced in webhook traffic — stubbed code paths (job-picker, active-job memory, legacy time_entries) are dead-path under normal traffic as designed.

## V6.B integrity verifier — RESOLVED

Cutover-integration-parity Bundle 4 (commit `ef3e4008`) realigned `services/integrity.js` with the `chiefos_integrity_chain_stamp` trigger byte-for-byte. Field-set contract locked by `services/integrity.fixtures.js`. Regression test (`__tests__/integrity.fieldsets.test.js`) reproduces production-row `record_hash` values for both `transactions` and `time_entries_v2` samples; runs in CI on every commit. The 503 gate on `routes/integrity.js` is removed; `/api/integrity/verify` and `/api/integrity/record/:id` endpoints are real handlers again, plan-gated to Starter/Pro.

## Known incomplete surfaces at cutover

The following surfaces are 503-gated or stubbed pending dedicated focused PRs. Each has a P1 entry in `POST_CUTOVER_PUNCHLIST.md` with full schema verification prerequisites, canonical replacement queries, caller audit checklist, end-to-end retest acceptance criteria, and time estimate.

- **Portal onboarding** (signup, finish-signup, tester-access) — 503-gated. New portal users cannot self-onboard until P1 "Onboarding refactor (post-rebuild Path α)" ships. Path α requires a new PG RPC (`chiefos_finish_signup`) + 6-file refactor + migration. WhatsApp capture flows are unaffected.
- **chiefos-site `/api/log`** (owner job-detail expense / revenue / hours / task / reminder forms) — 503-gated. P1: full schema-drift rewrite covering 4 layers (identity + transactions + time_entries + tasks).
- **Active-job memory** — `getActiveJob` / `setActiveJob` / `setActiveJobForIdentity` / `getActiveJobForIdentity` stubbed with `[STUB]` warn logs. Was already silently broken in production pre-audit; now visibly so. P1: rewrite to `users.auto_assign_active_job_id`.
- **Job-picker pending state** — `getPendingJobPick` / `applyJobToPendingDraft` / `clearPendingJobPick` stubbed. Live picker uses HMAC `jp:` row IDs in `handlers/commands/expense.js` (NOT the stubbed functions); stubs are dead-path under normal traffic. P1: rewrite to `pending_actions` + `cil_drafts` shape verification.
- **Legacy `time_entries` dual-write** — 5 functions stubbed. Authoritative writes go to `time_entries_v2` directly from callers. P1: caller migration + remove stubs.
- **Parser improvements (P2/P3)** — tax handling and payment method capture. Affect financial accuracy but are not Beta blockers; close before broader Beta acquisition.

## Cutover-integration-parity audit — closing summary

PR #2 audited and remediated integration drift across the chief-ai-refactored monorepo + chiefos-site submodule. **22 files** touched in chief-ai-refactored, **3 files** in chiefos-site submodule, net diff −295 lines (1545 deletions, 1250 insertions including the new fixture + test files). Eight DISCARDed/renamed schema entities (`v_actor_identity_resolver`, `chiefos_user_identities`, `chiefos_tenant_actor*`, `chiefos_phone_active_tenant`, `chiefos_link_codes`, `chiefos_pending_signups`, `chiefos_expenses`, `user_active_job`) replaced or stubbed with canonical post-rebuild equivalents. Role-enum modernization (`admin` removed, `board` → `board_member`) applied to all consumers. P0 "Schema-integration parity discipline" added to `POST_CUTOVER_PUNCHLIST.md` to prevent recurrence.

## Sentinel declaration

The MVP spine is migrated. Cutover routing is live and fail-closes correctly. The integrity chain on disk is intact and JS-verifier-aligned. The post-rebuild schema is frozen at cutover; future schema changes follow the P1A-N amendment pattern (timestamped migration, rollback file, manifest update, **paired integration audit pass per the P0 discipline**).

Phase 5 closed.
