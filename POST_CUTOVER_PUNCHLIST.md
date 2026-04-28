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

## P1 — services/integrity.js field-set alignment (V6.B)

**Status:** verify endpoints currently return 503 (`routes/integrity.js`, commit `73321bfb`). On-disk integrity chain stamped by trigger `chiefos_integrity_chain_stamp` is intact and continues stamping new INSERTs correctly. JS verifier in `services/integrity.js` references stale field set, would mark every row invalid if called.

**Drift surfaces:**

`buildTransactionHashInput` (services/integrity.js:22): currently uses pre-rebuild field set. Update to match trigger:
```
amount_cents, created_at, currency, date, id, kind, owner_id,
previous_hash, source, source_msg_id, tenant_id
```
Drop: `description`, `job_id`, `user_id`. Add: `currency`, `date`, `id`.

`buildTimeEntryHashInput` (services/integrity.js:45): currently uses pre-rebuild field set. Update to match trigger:
```
created_at, end_at_utc, id, kind, owner_id, previous_hash,
source_msg_id, start_at_utc, tenant_id, user_id
```
Drop: `clock_in`, `clock_out`, `job_id`, `total_work_minutes`. Add: `end_at_utc`, `id`, `kind`, `source_msg_id`, `start_at_utc`, `tenant_id`.

**Hash algorithm note:** trigger uses `encode(sha256(jsonb_value::text::bytea), 'hex')`. JS uses `crypto.createHash('sha256').update(JSON.stringify(fields, sortedKeys), 'utf8').digest('hex')`. To match, the JS side must serialize the same key→value pairs with the same canonical form Postgres `jsonb::text` produces (jsonb sorts keys by length-then-alphabetical and emits without trailing whitespace). Verify byte-equivalence with a small fixture before shipping.

**Required tasks:**

1. Update `buildTransactionHashInput` and `buildTimeEntryHashInput` to align field sets.
2. Adjust `verifyRecord` callers and snapshot-comparison logic for the new field shape.
3. Add a regression test (`test/integrity.fieldsets.test.js` or similar) asserting JS hash-input field sets exactly match the trigger's `jsonb_build_object` field sets — parse the trigger SQL or store expected sets as a fixture, and fail the test if either side drifts.
4. Verify the JS-recomputed hash matches the trigger-stamped hash on a sample row pulled from production (proves canonical serialization aligns).
5. Remove the 503 gate from `routes/integrity.js` once verifier alignment ships.

**Reference:** Phase 5 V6 verification finding, 2026-04-26.

---

## P2 — Other deferred items

- **Admin role build** — `chiefos_portal_users.role` enum is `{owner, board_member, employee}`. No `admin` value. When admin tier is needed post-Beta, add a P1A-7-style amendment migration extending the role enum + adding any needed `chiefos_role_audit.action` value (`admin_grant`/`admin_revoke`).
- **GitGuardian secret leaks (3)** — founder is identifying secrets in parallel to cutover. Track resolution separately.
- **Untracked documentation artifacts at repo root** — `01_*` through `06_*` strategy docs, `FOUNDATION_P*_*` reports, `PHASE_*_*` checkpoints. Sweep and commit (or move to `docs/_archive/`) in a dedicated docs-housekeeping commit after cutover settles.
- **Board assignment re-implementation** — post-cutover feature work, not in scope for this session.
- **Voice response sequence** — F2 voice work, post-cutover.

---

**This punchlist closes when every P1 item is resolved.** P2 items are tracked individually with their own owners/timelines.
