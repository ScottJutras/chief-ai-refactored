-- Verification queries for Phase 1 PR-A
-- Run AFTER applying:
--   1. migrations/2026_04_29_phase1_pra_lifecycle_and_plan_key_on_chiefos_tenants.sql
--   2. migrations/2026_04_29_amendment_p1a14_chiefos_finish_signup_rpc_lifecycle_and_plan.sql
--
-- All ten queries should return the expected ✓ marker. Read-only.

-- ============================================================================
-- Q1: All 13 lifecycle/plan columns present on chiefos_tenants with correct types
-- Expected: 13 rows, types/defaults as listed.
-- ============================================================================
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema='public' AND table_name='chiefos_tenants'
  AND column_name IN (
    'lifecycle_state','trial_started_at','trial_ends_at',
    'read_only_started_at','read_only_ends_at','archived_at',
    'data_deletion_eligible_at','first_whatsapp_message_at',
    'first_portal_login_at','first_capture_at','first_job_created_at',
    'reminders_sent','plan_key'
  )
ORDER BY column_name;

-- ============================================================================
-- Q2: lifecycle_state CHECK constraint allows exactly the 5 expected values
-- Expected: chiefos_tenants_lifecycle_state_chk with definition listing
--           pre_trial, trial, paid, read_only, archived
-- ============================================================================
SELECT conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE conname = 'chiefos_tenants_lifecycle_state_chk';

-- ============================================================================
-- Q3: plan_key CHECK constraint on chiefos_tenants allows v1.1 5-value enum
-- Expected: chiefos_tenants_plan_key_chk with definition listing
--           trial, starter, pro, enterprise, read_only
-- ============================================================================
SELECT conname, pg_get_constraintdef(oid) AS def
FROM pg_constraint
WHERE conname = 'chiefos_tenants_plan_key_chk';

-- ============================================================================
-- Q4: 3 partial indexes present
-- Expected: idx_chiefos_tenants_lifecycle_state (full),
--           idx_chiefos_tenants_trial_ends_at (partial WHERE trial),
--           idx_chiefos_tenants_read_only_ends_at (partial WHERE read_only)
-- ============================================================================
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname='public' AND tablename='chiefos_tenants'
  AND indexname IN (
    'idx_chiefos_tenants_lifecycle_state',
    'idx_chiefos_tenants_trial_ends_at',
    'idx_chiefos_tenants_read_only_ends_at'
  )
ORDER BY indexname;

-- ============================================================================
-- Q5: users.plan_key column ABSENT (drop succeeded)
-- Expected: 0 rows
-- ============================================================================
SELECT column_name
FROM information_schema.columns
WHERE table_schema='public' AND table_name='users' AND column_name='plan_key';

-- ============================================================================
-- Q6: users_plan_key_chk constraint ABSENT (drop succeeded)
-- Expected: 0 rows
-- ============================================================================
SELECT conname
FROM pg_constraint
WHERE conname = 'users_plan_key_chk';

-- ============================================================================
-- Q7: chiefos_tenants row count unchanged (zero post-wipe)
-- Expected: 0
-- ============================================================================
SELECT COUNT(*) AS chiefos_tenants_row_count FROM public.chiefos_tenants;

-- ============================================================================
-- Q8: users row count unchanged (zero post-wipe)
-- Expected: 0
-- ============================================================================
SELECT COUNT(*) AS users_row_count FROM public.users;

-- ============================================================================
-- Q9: RPC body changed since P1A-13 (P1A-14 amendment applied)
-- Expected: COMMENT references P1A-14 / "lifecycle + plan_key on chiefos_tenants"
-- ============================================================================
SELECT obj_description(p.oid, 'pg_proc') AS rpc_comment
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname='public' AND p.proname='chiefos_finish_signup';

-- ============================================================================
-- Q10: RPC body INSERT no longer references plan_key on users
-- Expected: 0 occurrences of `plan_key` inside the chiefos_finish_signup body
-- ============================================================================
SELECT (
  CASE
    WHEN pg_get_functiondef(p.oid) ~ E'INSERT INTO public\\.users[^;]*plan_key'
      THEN 'FAIL: users INSERT still writes plan_key'
    ELSE 'OK: users INSERT does not write plan_key'
  END
) AS rpc_users_plan_key_check
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname='public' AND p.proname='chiefos_finish_signup';
