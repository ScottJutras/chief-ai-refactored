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

## P1B — Post-cutover audit trackers (from 2026-04-28 audit cycle)

### P1B-jobs-fe-stale-schema-references

**Source:** Surfaced 2026-04-28 during /api/log preview testing (P1 punchlist item #7). **11th instance** of the stale-schema-reference pattern caught today.

**Symptom:** Both `/app/jobs` (list) and `/app/jobs/[jobId]` (detail) pages 400 against PostgREST. Network log:

```
GET /rest/v1/jobs?select=id,job_no,job_name,name,status,active,start_date,end_date,
                          created_at,material_budget_cents,labour_hours_budget,
                          contract_value_cents
                  &id=eq.6&deleted_at=is.null
→ 400 Bad Request
```

**Drift:** the SELECT requests two columns that don't exist post-rebuild:
- `job_name` — DROPPED; current schema has `name` only.
- `active` — DROPPED; current schema uses `status` enum (`active` / `paused` / `done` / `archived` or similar).

**Affected files (likely):**
- `chiefos-site/app/app/jobs/page.tsx` (list view)
- `chiefos-site/app/app/jobs/[jobId]/page.tsx` (detail view)

There may be additional call sites (job pickers, dashboards, etc.) that grep for `.from("jobs").select(...job_name|active)`.

**Fix:** rewrite the SELECT clause to use post-rebuild canonical columns:
- Remove `job_name` from select; references to `job.job_name` in the FE pivot to `job.name`.
- Remove `active` from select; references pivot to `job.status === 'active'`.

**Caller verification before fix:** grep all chiefos-site files for `.from("jobs")` and audit each SELECT against current `public.jobs` schema. Same audit pattern as the comprehensive-working-tree-audit methodology.

**Sized:** 1-2 hours (refactor 1-2 SELECT statements + audit other potential call sites + retest).

**Bundle posture:** independent small PR, not bundled with /api/log or the cleanup PR. Ships before Beta launch.

**Cross-reference:** Surfaced via /api/log preview testing — couldn't reach the entry forms because the parent page 400'd loading job data. The /api/log route itself is functional independent of this bug; the bug just blocks the human-friendly test path. Console-fetch testing bypasses it.

---

### P1B-source-msg-id-unique-on-task-time-reminder

**Source:** Surfaced 2026-04-28 during /api/log rewrite pre-write schema verification (P1 punchlist item #7).

**Finding:** Only `public.transactions` has a `source_msg_id`-based UNIQUE constraint (`transactions_owner_msg_kind_unique UNIQUE (owner_id, source_msg_id, kind) DEFERRABLE`). `public.tasks`, `public.time_entries_v2`, and `public.reminders` lack equivalent constraints despite all four being targets of idempotent ingestion paths (WhatsApp + portal + email).

**Current workaround:** /api/log handlers for tasks/time/reminders use SELECT-then-INSERT manual dedup (filter by `tenant_id` + `source_msg_id`, skip INSERT if row found). Functional but race-prone under concurrent writes (theoretically — portal-direct entries are user-initiated so concurrency risk is low).

**Resolution:** P1A-N amendment migration adding `UNIQUE (owner_id, source_msg_id)` (or `(tenant_id, source_msg_id)`) to:
- `tasks`
- `time_entries_v2`
- `reminders`

Standardize the idempotency arbiter so all four ingestion targets use the same `INSERT ... ON CONFLICT (owner_id, source_msg_id, ...) DO NOTHING` pattern.

**Sized:** 1-2 hours (single migration + rollback + manifest entry + handler simplification).

**Bundle posture:** belongs in the `P1B-comprehensive-rls-grant-check-unique-audit` consolidation (4th bug class: missing UNIQUE for ON CONFLICT), not a standalone PR. File pre-Beta.

---

### P1B-submission-status-vocabulary-normalization

**Source:** Surfaced 2026-04-28 during /api/log rewrite pre-write schema verification (P1 punchlist item #7).

**Finding:** `submission_status` enum vocabulary diverges across canonical financial/work tables:

| Table | Allowed values |
|---|---|
| `transactions` | `confirmed`, `pending_review`, `voided` |
| `tasks` | `approved`, `pending_review`, `needs_clarification`, `rejected` |
| `time_entries_v2` | `approved`, `pending_review`, `needs_clarification`, `rejected` |

The `confirmed` (transactions) vs `approved` (tasks/time) divergence is **the same drift class** as the `accepted_via='signup'` channel/lifecycle confusion that surfaced during Path α (resolved by mapping to `'portal'` channel). Two non-equivalent vocabularies for "owner has approved this entry" creates application-layer branching that's easy to mis-handle.

**Current state:** /api/log uses `approvedFor(table, role)` helper that returns the right per-table string. Functional but documents the divergence as a known footgun.

**Resolution options:**

1. **(a) Normalize to `approved`** across all three tables. Migrate transactions: `UPDATE transactions SET submission_status='approved' WHERE submission_status='confirmed'`; ALTER TABLE adjust CHECK constraint. Backfill is a one-time UPDATE; CHECK rewrite is straightforward.
2. **(b) Normalize to `confirmed`** across all three. Rename approved→confirmed on tasks + time_entries_v2.
3. **(c) Document the divergence as deliberate** (transactions has special `voided` state for reverse-revenue scenarios that doesn't fit the workflow-status semantic). Keep helper function as the abstraction layer.

**Recommendation:** Option (a) or (c). Vocabulary normalization is correct architecturally but requires careful caller-grep + integrity-chain consideration (transactions has `submission_status` in `hash_input_snapshot` — changing the value rewrites the hash unless we filter it out of the snapshot).

**Sized:** 2-4 hours including caller audit + integrity-chain review + migration + rollback.

**Bundle posture:** belongs in the `P1B-comprehensive-rls-grant-check-unique-audit` consolidation (4th bug class: CHECK constraint values vs application code writes). File pre-Beta.

---

### P1B-beta-delta-appendix-quote-spine-cleanup

**Source:** Surfaced 2026-04-28 during working-tree characterization (post-cutover-stale-work-cleanup PR). Comment in `cil.js` dates the work to 2026-04-18: *"CreateQuote schema was removed 2026-04-18 as part of the Quotes spine rebuild (Beta Delta Appendix)."*

**Scope:** removes pre-rebuild legacy Quote-spine code that's been latent post-cutover (writes to dropped `public.quotes` table; uses removed helpers).

**Files (all in chief-ai-refactored, working tree):**
- `cil.js` (+4/-7) — removes legacy `createQuoteSchema` block; replaces with cross-reference comment to `src/cil/quotes.js` (the new spine).
- `domain/quote.js` (+13/-44) — guts legacy `createQuote(cil, ctx)` (drops uuidv4, ensureNotDuplicate, insertOneReturning).
- `domain/agreement.js` (+9/-11) — replaces `public.quotes` existence check with fail-loud error (table dropped in rebuild).
- `handlers/commands/quote.js` (+1/-22) — removes legacy `pg.createQuoteRecord` + catalog-line-items writes.

**Resolution:** caller-grep + commit. Pattern matches the R3b/R4 cleanup PRs. Caller-grep target: `pg.createQuoteRecord`, `domain/quote.createQuote`, any reference to `public.quotes` table writes. If zero callers, ship as small commit/PR.

**Sized:** 1-2 hours (caller verify + 4-file commit + small focused PR).

**Cross-reference:** comment in cil.js cites `docs/QUOTES_SPINE_DECISIONS.md` §1–§2 as authoritative for the rebuild rationale.

---

### P1B-r4c-migrate-actor-memory-conversation-sessions

**Source:** Surfaced 2026-04-28 during working-tree characterization (post-cutover-stale-work-cleanup PR). Comments in working-tree diffs explicitly say *"R4c-migrate: read active session's active_entities..."* and *"R4c-migrate: build actor context once for conversation_sessions writes."*

**This is the 9th instance** of the uncommitted-but-claimed-shipped pattern caught today. The session-reports audit identified `R4c-investigate` as investigation-only (0 files modified), but R4c-migrate is a follow-up workstream that authored these files and never committed. Quarantined-zone status in `CLAUDE.md` ("Actor-memory cluster pending R4c") is consistent with R4c-migrate being the resolution.

**Files (all in chief-ai-refactored, working tree):**
- `services/agent/index.js` (~360 lines changed) — adds `conversationState` requires (`getSessionStateSafe`, `patchSessionStateSafe`, `appendMessageSafe`, `getRecentMessagesSafe`); replaces `actorMemory` lookup against DISCARDed `chief_actor_memory`.
- `services/answerChief.js` (+18/-18) — replaces `pg.getActorMemory` with `getSessionStateSafe` (R4c-migrate explicit comment).
- `services/orchestrator.js` (+25) — adds `patchSessionStateSafe` require; builds `actorCtx` for conversation_sessions writes.
- `routes/askChief.js` (+2) — adds `tenantId` + `traceId` to `runAgent({...})` call (caller-side update).
- `handlers/commands/index.js` (+2) — adds `tenantId` + `traceId` to `ask({...})` call (caller-side update).

**Production-impact:** Same R2.5-class pattern. Live actor-memory reads/writes hit the DISCARDed `chief_actor_memory` table → silent failure paths (try/catch returns `{}` on error). Latent-broken since cutover.

**Resolution:** schema-drift verify (confirm `services/conversationState` module exists at expected path; confirm `conversation_sessions` table shape matches; confirm `active_entities jsonb` column accepts the session-state shape) + commit + small focused PR. Mirror of R3b/R4 cleanup pattern.

**Sized:** 2-4 hours (verify + commit + retest authenticated client load).

---

### P1B-email-ingest-defensive-fixes

**Source:** Surfaced 2026-04-28 during working-tree characterization (post-cutover-stale-work-cleanup PR). Defensive collateral, not session-tagged — likely from someone debugging email ingestion locally and never committing.

**Files (chief-ai-refactored, working tree):**
- `api/inbound/email.js` (+9) — early dedup query against `email_ingest_events` to prevent duplicate WhatsApp notifications on Postmark retries.
- `services/emailIngest.js` (+7/-1) — wraps `pdf-parse` require in try/catch so absent module doesn't crash module load (env-portability fix).

**Verdict:** Both are pure defense-in-depth additions, low-risk. Could commit immediately or defer.

**Sized:** 30 min (review diff substance + commit + small focused PR).

---

### P1B-claude-md-discipline-doc-rewrite

**Source:** Surfaced 2026-04-28 during working-tree characterization (post-cutover-stale-work-cleanup PR). **This is the 10th instance** of the uncommitted-but-claimed-shipped pattern caught today.

**Substance of the rewrite (all in `CLAUDE.md`, working tree):**

NEW sections added:
- **Identity-column cross-reference** — points at `FOUNDATION_CURRENT.md` for specific column documentation (e.g., `users.auth_user_id` reverse pointer).
- **Session reports section** — rules: *write directly to `docs/_archive/sessions/SESSION_<NAME>.md`*, 30-50 line max, 1-line bullets, architectural decisions go in decisions-log, schema rationale goes in migration file comment.
- **Manifest discipline** — *replacement, not narrative append*; resolved forward-flags removed, not crossed out; session history lives in `docs/_archive/sessions/`.
- **Handoff discipline** — phase-arc handoffs are rewritten state-reflection per session; latest replaces prior; prior moves to `docs/_archive/handoffs/`.
- **Documentation lifecycle** — explicit aging-out posture per artifact type (migrations + decisions-log + ceremony archives persist; manifest + handoffs + FOUNDATION_CURRENT.md rewrite-replacement; mid-session checkpoints deleted at arc close; session reports written directly, never auto-loaded).

Intentional consolidations:
- "Active Execution Plan" section removed (replaced by Context Budget cross-reference).
- "Identity Addendum (P1A-4)" details removed; replaced by cross-reference to `FOUNDATION_CURRENT.md` at top of file.
- Canonical Helpers list compressed; specific file paths moved to a planned `REBUILD_CANONICAL_HELPERS.md` (separate file, not yet authored).

Reference Docs list updates:
- Adds `QUOTES_SPINE_CEREMONIES.md` to the speculatively-skip list.
- Refines load conditions for several entries.

Introspection Discipline language updated to reference R-session findings ("F2/F3, B1/B2, amendment-column-shape drift") rather than the prior single example.

**Note:** the SQL `<TABLE>` placeholder fix was extracted as a tiny surgical commit on the cleanup-PR branch (commit `f5caed11`). The rewrite content here stays in working tree with the surgical fix preserved (no re-revert).

**Resolution:** review the rewrite content, ensure `REBUILD_CANONICAL_HELPERS.md` is authored before merge (it's referenced but not yet created), commit + small focused PR.

**Sized:** 1-2 hours (review + author REBUILD_CANONICAL_HELPERS.md + commit + small PR).

---

### P1B-comprehensive-working-tree-audit

**Source:** Meta-finding, 2026-04-28. Today's session-reports audit caught 6 of 10 uncommitted-but-claimed-shipped instances. The other 4 surfaced via adjacent-work discovery:
- R2.5 chiefos-site (caught via Path α step-6 production bug investigation)
- chief-ai-refactored identity rewrites (caught via link-phone/start 504 diagnosis)
- schema-drift-check script (caught during R1 prep when package.json scope-split surfaced new entries)
- R4c-migrate, email-ingest, CLAUDE.md (caught during working-tree characterization for the cleanup PR push)

**Pattern indicates session-reports audit alone is insufficient.** Working-tree characterization catches everything the session-reports audit misses, but is more labor-intensive.

**Recommended methodology:**

1. **Run `git diff HEAD` across all repos** (chief-ai-refactored, chiefos-site, any others). Each modified file gets a diff-substance summary.
2. **Run `git status -s` across all repos.** Untracked files get classified: belongs to known workstream, P2 deferred docs, or unknown.
3. **Characterize every modified/untracked file by origin** — author intent, session source, defer/commit/discard.
4. **Cross-reference against documented-as-shipped work** — manifests, session reports, FOUNDATION_CURRENT.md, decisions logs.
5. **Surface findings as candidates** — commit/discard/tracker per file.
6. **Grep all chiefos-site `supabase.from()` and `supabase.rpc()` call sites** and cross-reference each table/RPC name + each SELECTed column against current `public.*` schema. Catches the structural bug class that surfaced with `chiefos_link_codes` (P1B-r2.5 fix), `chiefos_user_identities` (chief-ai-refactored R-rewrites fix), and now `jobs.job_name`/`jobs.active` (`P1B-jobs-fe-stale-schema-references`). All three are the same class: FE direct-PostgREST call → schema drift → 400/404 at runtime.

**Sized:** half-day focused work.

**When to run:**
- Pre-Beta launch (catches latent broken code before user traffic exposes it).
- Pre-merge for any major release (PR review surface verification).
- Quarterly thereafter as a standing hygiene discipline.

**Cross-reference:** today's audit-PR cycle established the pattern; this tracker formalizes it as a repeatable process.

---

### P1B-schema-drift-check-script-commit

**Source:** Surfaced 2026-04-28 during R1 commit prep (post-cutover-stale-work-cleanup PR). The `drift_detection_script` work is documented as **shipped** in `REBUILD_MIGRATION_MANIFEST.md` apply-order entry (between `2026_04_25_chiefos_quote_versions_source_msg_id` and `2026_04_21_drop_unsafe_signup_test_user_function`), but the actual files are uncommitted:

- `scripts/schema_drift_check.js` — **untracked** (working tree only).
- `package.json` 3 script entries (`schema:drift-check`, `schema:drift-check:verbose`, `schema:drift-check:baseline`) — **uncommitted** (working-tree modification).

This is the **8th occurrence** of the uncommitted-but-claimed-shipped pattern (after R2.5, identity rewrites, R4, R3b, R4b, Phase A 5 partial, R1 partial). Surfaced during R1 prep rather than the session-reports audit because the manifest documents this work in apply-order discipline (not in a session report).

**Current state:** R1 commit deliberately left the schema-drift-check additions OUT of scope (they're additions, not deletions; mixing them into R1's dead-code-removal commit would muddle the discipline). Untracked + uncommitted state preserved for separate ship.

**Resolution:** separate commit on a separate branch, separate PR. Not bundled with `post-cutover-stale-work-cleanup` PR.

- Branch suggestion: `schema-drift-check-script-commit`
- Files: `scripts/schema_drift_check.js` (commit) + `package.json` (3 script-entry additions)
- Sized: small (single commit, no schema impact, no DB changes).

**Priority:** should ship before Beta launch — the script is the canonical pre-merge schema-drift gate documented in the manifest. Not strictly blocking the cleanup PR or trial migration.

---

### P1B-phase-a-5-reissuequote-deferred

**Source:** Phase A Session 5 ReissueQuote handler (`src/cil/quotes.js` +716, `src/cil/quotes.test.js` +599 with 16 unit + 9 integration tests, `src/cil/router.js` registration uncomment, ceremony scripts) — work authored but NOT committed in the post-cutover-stale-work-cleanup PR (2026-04-28) because integration tests fail.

**Migration is already shipped:** `2026_04_25_chiefos_quote_versions_source_msg_id.sql` is in production via commit `971ca0ea` (per audit). Schema side is clean. Only application-layer wire-up remains.

**Test failure root cause:** `seedThrowawayUser` in `src/cil/quotes.test.helpers.js:32` 42501s on `users_pkey` UNIQUE collision. Helper generates per-call random `99XXXXXXXXXXX` ids, so the collision is most likely either (a) a deterministic `ownerId` passed by a caller in `setupQuotePreconditions` (line 108), or (b) stale DB rows from prior unconfigured-cleanup runs. **Not a schema-drift issue, not a regression in Phase A 5 handler code** — all 16 ReissueQuote unit tests pass; only the 9 integration tests cascade-fail starting from the first fixture-bootstrap failure.

**Three options for resolution:**

1. **(a) Fix the test helper** — change `setupQuotePreconditions` to always pass a fresh `ownerId`, OR add `DELETE FROM users WHERE user_id = $1` before each test's INSERT, OR wrap the INSERT in `ON CONFLICT (user_id) DO NOTHING`. Sized: 30-60 min.
2. **(b) Reset local test DB state** — verify the test runs against a clean fixture state. Sized: depends on test harness setup.
3. **(c) Skip integration tests temporarily** — `xdescribe` the ReissueQuote integration block, ship the handler + unit tests, file integration tests as separate follow-up. Sized: 5 min change but loses the BLOCKING regression locks the integration tests are designed to enforce.

**Currently no live caller of ReissueQuote.** The CIL ingestion path doesn't emit `ReissueQuote` actions until a portal/WhatsApp UI surface generates them. Migration shipped + handler uncommitted = the action would route to nowhere if emitted today, but nothing is emitting.

**Urgency:** not urgent — no live emission. But Phase A is documented as closed in production, and ReissueQuote is named in the closure surface; failing to wire the handler eventually surfaces as "ReissueQuote returns CIL_ACTION_UNKNOWN" the first time a quote-edit flow tries it.

**Decision needed before:** any UI work that would emit `ReissueQuote` CIL actions.

---

### P1B-user-memory-kv-rebuild-target-decision

**Source:** `services/memory.js` header comment (committed in R4 cleanup, SHA `f58f6a33`).

The pre-rebuild target tables for per-user persistent KV (`assistant_events`, `user_memory`, `convo_state`, `entity_summary`) were DISCARDed by the rebuild. `services/memory.js` is now a no-op shim — module exports preserved so `require('../services/memory')` doesn't throw, but every function returns benign defaults.

**Three options for resolution:**

1. **(a) Phase 1 amendment table** — author `chiefos_user_memory` or similar, with RLS policies + service_role grants + integration with conversation flow. Sized: 3-5 days.
2. **(b) Repurpose `conversation_sessions.active_entities`** for KV-like semantics. The column already exists; cardinality may not match (session-scoped, not long-lived). Sized: 1-2 days.
3. **(c) Drop the user-memory feature entirely** — accept that Chief doesn't carry context across sessions; document as design choice. Sized: zero work.

**Currently no live caller.** Only `nlp/conversation.js` imports the shim, and its exported `converseAndRoute` has zero call sites in live code (per R4's V4 grep).

**Urgency:** not urgent today; deferred indefinitely is also not great. At some point Chief's lack of cross-session memory becomes a UX issue, especially for power users (vendor aliases, default expense bucket recall, etc.).

**Decision needed before:** any feature work that wants to surface "Chief remembers X about you across conversations."

---



- **Admin role build** — `chiefos_portal_users.role` enum is `{owner, board_member, employee}`. No `admin` value. When admin tier is needed post-Beta, add a P1A-7-style amendment migration extending the role enum + adding any needed `chiefos_role_audit.action` value (`admin_grant`/`admin_revoke`).
- **GitGuardian secret leaks (3)** — founder is identifying secrets in parallel to cutover. Track resolution separately.
- **Untracked documentation artifacts at repo root** — `01_*` through `06_*` strategy docs, `FOUNDATION_P*_*` reports, `PHASE_*_*` checkpoints. Sweep and commit (or move to `docs/_archive/`) in a dedicated docs-housekeeping commit after cutover settles.
- **Board assignment re-implementation** — post-cutover feature work, not in scope for this session.
- **Voice response sequence** — F2 voice work, post-cutover.

---

**This punchlist closes when every P1 item is resolved.** P2 items are tracked individually with their own owners/timelines.
