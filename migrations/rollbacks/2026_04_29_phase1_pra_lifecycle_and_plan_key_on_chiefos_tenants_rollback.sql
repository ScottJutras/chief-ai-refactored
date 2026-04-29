-- Rollback: 2026_04_29_phase1_pra_lifecycle_and_plan_key_on_chiefos_tenants_rollback.sql
--
-- Reverses 2026_04_29_phase1_pra_lifecycle_and_plan_key_on_chiefos_tenants.sql.
--
-- Restores pre-Phase-1 schema shape:
--   - users.plan_key column with CHECK ('free','starter','pro','enterprise')
--     DEFAULT 'free' NOT NULL (the pre-Phase-1 production shape per recon)
--   - users_plan_key_chk constraint (original name)
--   - Drops chiefos_tenants lifecycle indexes
--   - Drops chiefos_tenants.plan_key + its CHECK
--   - Drops 12 chiefos_tenants lifecycle/activation/reminders columns
--
-- Reversible without data loss only at zero-row pre-launch baseline.
-- If any chiefos_tenants row has been created post-migration with non-default
-- lifecycle_state or plan_key, that information is destroyed by this rollback.
--
-- Apply order if both schema + RPC have been applied:
--   1. Apply rollbacks/2026_04_29_amendment_p1a14_*_rollback.sql FIRST
--      (restores P1A-13 RPC body, which writes users.plan_key='free').
--   2. Apply this rollback (drops chiefos_tenants.plan_key, restores users.plan_key).
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='chiefos_tenants'
                   AND column_name='lifecycle_state') THEN
    RAISE EXCEPTION 'chiefos_tenants.lifecycle_state missing — forward migration not applied?';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='users' AND column_name='plan_key') THEN
    RAISE EXCEPTION 'users.plan_key already present — forward migration not applied or partially rolled back?';
  END IF;
END
$preflight$;

-- 1. Drop indexes first
DROP INDEX IF EXISTS public.idx_chiefos_tenants_read_only_ends_at;
DROP INDEX IF EXISTS public.idx_chiefos_tenants_trial_ends_at;
DROP INDEX IF EXISTS public.idx_chiefos_tenants_lifecycle_state;

-- 2. Drop chiefos_tenants.plan_key
ALTER TABLE public.chiefos_tenants
  DROP CONSTRAINT IF EXISTS chiefos_tenants_plan_key_chk;
ALTER TABLE public.chiefos_tenants DROP COLUMN IF EXISTS plan_key;

-- 3. Drop chiefos_tenants lifecycle/activation/reminders columns
ALTER TABLE public.chiefos_tenants DROP COLUMN IF EXISTS reminders_sent;
ALTER TABLE public.chiefos_tenants DROP COLUMN IF EXISTS first_job_created_at;
ALTER TABLE public.chiefos_tenants DROP COLUMN IF EXISTS first_capture_at;
ALTER TABLE public.chiefos_tenants DROP COLUMN IF EXISTS first_portal_login_at;
ALTER TABLE public.chiefos_tenants DROP COLUMN IF EXISTS first_whatsapp_message_at;
ALTER TABLE public.chiefos_tenants DROP COLUMN IF EXISTS data_deletion_eligible_at;
ALTER TABLE public.chiefos_tenants DROP COLUMN IF EXISTS archived_at;
ALTER TABLE public.chiefos_tenants DROP COLUMN IF EXISTS read_only_ends_at;
ALTER TABLE public.chiefos_tenants DROP COLUMN IF EXISTS read_only_started_at;
ALTER TABLE public.chiefos_tenants DROP COLUMN IF EXISTS trial_ends_at;
ALTER TABLE public.chiefos_tenants DROP COLUMN IF EXISTS trial_started_at;
ALTER TABLE public.chiefos_tenants
  DROP CONSTRAINT IF EXISTS chiefos_tenants_lifecycle_state_chk;
ALTER TABLE public.chiefos_tenants DROP COLUMN IF EXISTS lifecycle_state;

-- 4. Restore users.plan_key with original pre-Phase-1 shape + constraint
ALTER TABLE public.users
  ADD COLUMN plan_key TEXT NOT NULL DEFAULT 'free';

ALTER TABLE public.users
  ADD CONSTRAINT users_plan_key_chk
    CHECK (plan_key IN ('free', 'starter', 'pro', 'enterprise'));

-- 5. Sanity assertion
DO $assert$
DECLARE
  v_lifecycle_count int;
  v_users_plan_key int;
  v_users_plan_key_chk int;
BEGIN
  SELECT COUNT(*) INTO v_lifecycle_count
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='chiefos_tenants'
    AND column_name IN (
      'lifecycle_state','trial_started_at','trial_ends_at',
      'read_only_started_at','read_only_ends_at','archived_at',
      'data_deletion_eligible_at','first_whatsapp_message_at',
      'first_portal_login_at','first_capture_at','first_job_created_at',
      'reminders_sent','plan_key'
    );

  SELECT COUNT(*) INTO v_users_plan_key
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='users' AND column_name='plan_key';

  SELECT COUNT(*) INTO v_users_plan_key_chk
  FROM pg_constraint WHERE conname='users_plan_key_chk';

  IF v_lifecycle_count <> 0 THEN
    RAISE EXCEPTION 'Rollback incomplete: % lifecycle/plan columns still present on chiefos_tenants', v_lifecycle_count;
  END IF;
  IF v_users_plan_key <> 1 THEN
    RAISE EXCEPTION 'Rollback incomplete: users.plan_key not restored';
  END IF;
  IF v_users_plan_key_chk <> 1 THEN
    RAISE EXCEPTION 'Rollback incomplete: users_plan_key_chk constraint not restored';
  END IF;

  RAISE NOTICE 'Phase 1 PR-A rollback complete: chiefos_tenants restored to pre-Phase-1 shape; users.plan_key restored.';
END
$assert$;

COMMIT;
