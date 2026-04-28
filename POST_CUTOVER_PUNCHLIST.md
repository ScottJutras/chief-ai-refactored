# Post-Cutover Punchlist

Items deferred from the Phase 5 cutover session (2026-04-26 / 2026-04-27). All non-blocking but must land before downstream feature work assumes a clean baseline.

---

## P0 — Schema-integration parity discipline (NEW — adopt forever)

**Origin:** 2026-04-27 cutover. Six integration drift bugs surfaced post-redeploy because the rebuild schema landed without a paired audit of integration code (services/, routes/, middleware/, chiefos-site portal).

**Rule:** Any schema rebuild, migration, or amendment MUST include a paired integration audit pass before merge. "Schema PR + integration audit PR" land together or not at all.

**Audit checklist (run before merging any schema-changing PR):**

1. **Grep code repos for DISCARDed/renamed identifiers.** Both `chief-ai-refactored` and `chiefos-site`:
   - `services/**/*.js`, `routes/**/*.js`, `middleware/**/*.js`, `scripts/**/*.js`
   - `app/api/**/*.ts`, `lib/**/*.ts` (chiefos-site)
   - For each table, view, column, or function the migration drops/renames: grep for the pre-change name and replace or remove the reference.
2. **Untracked-file check.** `git status --short` after a rebuild — if any service file shows `??`, verify it isn't required by tracked code via `grep -r "require.*<filename>"`. Untracked-but-required files cause Vercel boot crashes.
3. **Identity resolution smoke test.** Run a fresh-DB end-to-end: phone → tenant resolve, signup → tenant create, expense capture → record_hash stamped, portal whoami → 200.
4. **Schema-side verification queries.** All checklist items in `PHASE_5_PRE_CUTOVER_CHECKLIST.md` §1-§6 must pass against the post-migration DB.

**Time cost vs. saved:** ~30-60 min audit pass per schema PR; saves 4-8 hours of post-deploy diagnose-fix cycles per missed reference.

**Add to:** `03_CHIEFOS_ENGINEERING_CONSTITUTION.md` (when committed) under a "Schema-integration parity" rule.

**Reference:** 2026-04-27 cutover. Six bugs caught: missing services files (boot crash), services/integrity.js stale field set (V6.B), services/userProfile.js v_actor_identity_resolver + chiefos_user_identities references, chiefos-site/app/api/auth/* using DISCARDed chiefos_pending_signups.

---

## P1 — Onboarding refactor (post-rebuild Path α)

**Status:** 4 onboarding routes return 503 with `issue: post-rebuild-onboarding-refactor-p1` (chiefos-site commit `a063416`). Five surfaces are broken; Path α is the architecturally correct target but doesn't fit the audit-fix PR scope.

### Schema amendment first (P1A-7 pattern)

1. **Decide column placement for country/province** — they live on `chiefos_tenants` post-rebuild. `public.users` does NOT have these columns. Confirm no caller writes them to users; if any does, it's drift to clean up.
2. **Author `chiefos_finish_signup` PG RPC** with full design:
   - Reads `auth.uid()` and metadata from `auth.users.raw_user_meta_data`.
   - Resolves `owner_id` digits — decision: phone-based if metadata.phone is present, else generated (need decision from founder before authoring).
   - Creates `chiefos_tenants` row (`id`, `owner_id`, `name=company`, `country`, `province` from metadata).
   - Creates `chiefos_portal_users` row (`user_id=auth.uid()`, `tenant_id`, `role='owner'`, `can_insert_financials=true`, `status='active'`).
   - Creates `public.users` owner row (`user_id=owner_id`, `owner_id`, `tenant_id`, `name`, `email`, `role='owner'`, `signup_status='complete'`, `auth_user_id=auth.uid()`).
   - All within a single PG function = transactional by default.
   - Returns `{ tenant_id, owner_id, portal_user_id }`.
3. **Migration file**: `migrations/2026_04_NN_amendment_chiefos_finish_signup_rpc.sql`.
4. **Manifest update + rollback file**.

### Code refactor (6 chiefos-site files)

- `app/api/auth/signup/route.ts`: pass metadata via Supabase Auth `options.data` → `auth.users.raw_user_meta_data` (not a separate `chiefos_pending_signups` upsert).
- `app/api/auth/pending-signup/route.ts` (GET): read from `admin.auth.getUser().user_metadata`.
- `app/api/auth/pending-signup/route.ts` (POST `set-tenant-meta`): UPDATE `chiefos_tenants` country/province only; remove `public.users` country/province writes (those columns don't exist).
- `app/api/auth/pending-signup/route.ts` (POST `consume`): replace with `email_confirmed_at` check + `users.signup_status` flip to `'complete'`.
- `app/api/tester-access/activate/route.ts`: replace `user_auth_links` lookup with `chiefos_portal_users` + `users.auth_user_id`; remove `users.subscription_tier`/`users.paid_tier` writes (use `plan_key`).
- `app/finish-signup/FinishSignupClient.tsx`: update RPC call to new `chiefos_finish_signup` signature + handle new return shape.

### End-to-end retest acceptance criteria

1. Fresh signup from clean DB state.
2. Email confirm via Supabase Auth flow.
3. Tenant + owner creation completes via RPC (atomic — no partial state on error).
4. Phone link via OTP (`portal_phone_link_otp` flow).
5. WhatsApp test logs an expense to the new tenant.
6. Portal whoami returns 200 with correct `tenant_id`, `owner_id`, `role`.
7. All writes verified to land in `tctohnzqxzrfijdufrss` (production DB).
8. Stranded auth.users rows cleaned up post-test.

### Estimated scope

4-6 hours including RPC authoring + migration + 6-file refactor + end-to-end retest. **Dedicated focused session** — do not bundle with other work.

### Reference

2026-04-28 cutover-integration-parity audit, Bundle 3 deferral (chiefos-site commit `a063416`). Stranded `auth.users` row `c32509fa-40d2-4f93-abf9-11ab2c4f728d` (`scott@missionexteriors.ca`) needs deletion before retest.

---

## P1 — chiefos-site/app/api/log/route.ts full rewrite

**Status:** route returns 503 with `issue: post-rebuild-log-route-rewrite` (commit `<this-PR-merge>`). 5 owner job-detail forms (expense / revenue / hours / task / reminder) hit this endpoint from `chiefos-site/app/app/jobs/[jobId]/page.tsx`. WhatsApp capture is unaffected.

**Drift to fix in rewrite:**

1. **Identity resolution** — already covered by Bundle 1 audit pattern: read tenant_id + owner_id + display_name via `chiefos_portal_users` JOIN `public.users`. (Removed in this PR's gate.)
2. **transactions insert** — current code inserts `amount`, `payee_name`, `expense_category`, `user_name`, `job_name` columns. Post-rebuild canonical:
   - `amount` (numeric dollars) → DROPPED; use `amount_cents` (bigint) only.
   - `payee_name` → likely renamed to `merchant`.
   - `expense_category` → renamed to `category`.
   - `user_name` → DROPPED; user attribution via `submitted_by` (digits user_id).
   - `job_name` → DROPPED; job attribution via `job_id` (FK to jobs.id) + optional `job_no` for display.
3. **time_entries insert** — uses legacy `time_entries` table (DISCARDed in rebuild). Post-rebuild canonical: `time_entries_v2` with `kind` (e.g., `'shift'`), `start_at_utc`, `end_at_utc`, `meta` jsonb (job_name lives in meta).
4. **tasks insert** — uses dropped `created_by` column and sets `status: 'pending'` which is NOT in the post-rebuild 4-value enum `{open, in_progress, done, cancelled}`. Use `created_by_portal_user_id` (uuid) or `created_by_user_id` (digits) per CHECK constraint, and `status: 'open'`.
5. **reminders insert** — verify column names against rebuild schema before writing.

**Required tasks:**

1. Verify rebuild schema for `transactions`, `time_entries_v2`, `tasks`, `reminders` (pull via `mcp__claude_ai_Supabase__list_tables`).
2. Rewrite `POST /api/log` to use post-rebuild canonical writes.
3. Re-resolve identity via the `chiefos_portal_users` JOIN `public.users` pattern from Bundle 1 of the audit (drop the deleted `chiefos_tenant_actor_profiles` lookup).
4. Test all 5 owner job-detail forms end-to-end against `chiefos-site/app/app/jobs/[jobId]/page.tsx`.
5. Remove the 503 gate.

**Estimated scope:** 2-4 hours when properly scoped (pull schema → rewrite → test against fresh portal).

**Reference:** 2026-04-27 cutover-integration-parity audit (this branch).

---

## P1 — Job-picker pending-state rewrite

**Status:** 3 functions in `services/postgres.js` are STUBBED with warn logs (commit `8023234e`). Live job picker uses HMAC-signed `jp:` row IDs in `handlers/commands/expense.js` with inline state — these stubs are dead-path under normal traffic but guard against legacy `jobpick::` token replay.

**Drift:** `confirm_flow_pending` and `confirm_flows` tables are DROPPED post-rebuild. Replacements:
- `pending_actions` (9 cols, jsonb payload, no soft-mark — consume via DELETE or expires_at)
- `cil_drafts` (15 cols, replaces confirm_flows for staged-payload mutation)

**Required tasks:**

1. Verify `cil_drafts` shape supports the staged-payload mutation pattern (`UPDATE ... SET draft = jsonb_set(...)`). Pull schema from `mcp__claude_ai_Supabase__list_tables`.
2. Rewrite `getPendingJobPick`: SELECT from `pending_actions WHERE kind='JOB_PICK' AND owner_id=$1 AND user_id=$2 AND expires_at > NOW()`. Return `id` (instead of `confirm_flow_id`), `payload->'context'`, `payload->>'resume_key'`.
3. Rewrite `applyJobToPendingDraft`: write to `cil_drafts` instead of `confirm_flows`. Update the staged payload's `job_id` field via `jsonb_set`.
4. Rewrite `clearPendingJobPick`: `DELETE FROM pending_actions WHERE id=$1` (drop the soft-mark `used_at` semantic).
5. Update caller in `handlers/system/jobPickRouter.js`:18-26 to use `id` instead of `confirm_flow_id`.
6. End-to-end retest: WhatsApp expense → job picker → selection → confirmation flow.

**Estimated scope:** 1-2 hours focused work + ~30 min `cil_drafts` shape verification.

**Reference:** 2026-04-27 cutover-integration-parity audit (commit `8023234e`).

---

## P1 — Active-job-memory rewrite

**Status:** 4 functions in `services/postgres.js` are STUBBED with warn logs (commit `8023234e`). Active-job memory has been silently broken in production since the cutover (the dual-write to `user_active_job` table errored in try/catches; the fallback path queried dropped `jobs.active` column).

**Drift:** Multi-table fan-out across DROPPED schemas:
- `user_active_job` table (DROPPED)
- `users.active_job_id` column (DROPPED — rebuild's canonical column is `auto_assign_active_job_id`)
- `memberships.active_job_id` (DROPPED)
- `user_profiles.active_job_id` (DROPPED)
- `jobs.active` boolean column (DROPPED — rebuild uses `jobs.status` enum)

**Canonical replacement:** `public.users.auto_assign_active_job_id` (integer NULL, FK to `jobs.id`). Single column, no fan-out.

**Required tasks:**

1. Confirm shape: `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='auto_assign_active_job_id'`. Expected: integer / YES / FK to jobs.id.
2. Rewrite `setActiveJob` / `setActiveJobForIdentity`: resolve job_no → jobs.id via single SELECT, then `UPDATE users SET auto_assign_active_job_id = $jobid, auto_assign_activated_at = now() WHERE owner_id=$1 AND user_id=$2`. Drop the multi-target fan-out, drop the "owner-wide active job" fallback (no longer exists post-rebuild).
3. Rewrite `getActiveJob` / `getActiveJobForIdentity`: `SELECT u.auto_assign_active_job_id, j.name, j.job_no FROM public.users u LEFT JOIN public.jobs j ON j.id = u.auto_assign_active_job_id WHERE u.owner_id=$1 AND u.user_id=$2`.
4. Caller audit: grep `setActiveJob`/`getActiveJob`/`setActiveJobForIdentity`/`getActiveJobForIdentity`/`setActiveJobForUser`/`setActiveJobForPhone`/`setUserActiveJob`/`updateUserActiveJob`/`saveActiveJob` to confirm callers handle the simpler return shape.
5. End-to-end retest: WhatsApp expense capture WITHOUT explicit job-picker → does it correctly recall and use the active job?

**Estimated scope:** 1.5-2 hours focused work.

**Reference:** 2026-04-27 cutover-integration-parity audit (commit `8023234e`).

---

## P1 — Legacy-time_entries dual-write removal + caller migration to time_entries_v2

**Status:** 5 functions in `services/postgres.js` are STUBBED with warn logs (commit `8023234e`). The legacy table `public.time_entries` is DROPPED post-rebuild.

**Drift:** `getLatestTimeEvent`, `logTimeEntry`, `logTimeEntryWithJob`, `checkTimeEntryLimit`, `moveLastLogToJob` all targeted the legacy table with pre-rebuild columns (`type`, `timestamp`, `employee_name`, `local_time`, `tz`).

**Canonical replacement:** `public.time_entries_v2` with `kind` (e.g., `'shift'`), `start_at_utc`, `end_at_utc`, `meta` jsonb (job_name lives in meta).

**Required tasks:**

1. Audit callers (`routes/timeclock.js`, `routes/employee.js`, `handlers/commands/timeclock.js`, `middleware/pendingAction.js`, `services/ai_confirm.js`). Most already write to `time_entries_v2` directly — the legacy dual-write was for the owner-side views which now read v2 too.
2. Remove the legacy dual-write call sites (each `logTimeEntry(...)` invocation in callers becomes either a no-op deletion or a v2 INSERT).
3. Re-implement `checkTimeEntryLimit` against `time_entries_v2` (use `kind`, `start_at_utc`, `created_at` as appropriate).
4. Either rewrite the 5 functions against `time_entries_v2` OR delete them entirely and remove from exports + caller imports.
5. End-to-end retest: WhatsApp clock-in/out, portal clock-in/out, owner-side activity views all read consistent data.

**Estimated scope:** 2-3 hours focused work (caller audit dominates).

**Reference:** 2026-04-27 cutover-integration-parity audit (commit `8023234e`).

---

## ✅ P1 — services/integrity.js field-set alignment (V6.B) — RESOLVED

**Resolved 2026-04-28** in cutover-integration-parity Bundle 4. JS verifier now byte-equivalent with the `chiefos_integrity_chain_stamp` trigger; production-row regression test (`__tests__/integrity.fieldsets.test.js`) reproduces stored `record_hash` for both transactions and time_entries_v2 samples. 503 gate removed from `routes/integrity.js`. Field-set contract locked by `services/integrity.fixtures.js`.

---

## P2 — Other deferred items

- **Admin role build** — `chiefos_portal_users.role` enum is `{owner, board_member, employee}`. No `admin` value. When admin tier is needed post-Beta, add a P1A-7-style amendment migration extending the role enum + adding any needed `chiefos_role_audit.action` value (`admin_grant`/`admin_revoke`).
- **GitGuardian secret leaks (3)** — founder is identifying secrets in parallel to cutover. Track resolution separately.
- **Untracked documentation artifacts at repo root** — `01_*` through `06_*` strategy docs, `FOUNDATION_P*_*` reports, `PHASE_*_*` checkpoints. Sweep and commit (or move to `docs/_archive/`) in a dedicated docs-housekeeping commit after cutover settles.
- **Board assignment re-implementation** — post-cutover feature work, not in scope for this session.
- **Voice response sequence** — F2 voice work, post-cutover.

---

**This punchlist closes when every P1 item is resolved.** P2 items are tracked individually with their own owners/timelines.
