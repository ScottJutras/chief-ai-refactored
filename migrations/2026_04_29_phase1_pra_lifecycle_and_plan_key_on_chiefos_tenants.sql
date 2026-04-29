-- Migration: 2026_04_29_phase1_pra_lifecycle_and_plan_key_on_chiefos_tenants.sql
--
-- PHASE 1 PR-A: TMTS v1.1 §5.1 lifecycle columns + §5.2 plan_key consolidation.
--
-- Closes Phase 1 PR-A scope:
--   - §5.1: 12 lifecycle/activation columns + reminders_sent JSONB on chiefos_tenants
--   - §5.2: plan_key migration from users to chiefos_tenants with v1.1 enum
--
-- NOT applied to production by this PR — authoring only.
--
-- ============================================================================
-- DECISIONS LOCKED PER PHASE 1 RECON + OWNER SIGN-OFF (2026-04-29):
--
-- 1. ALL §5.1 lifecycle columns placed on chiefos_tenants (NOT users).
--    Reason: every §5.1 column is per-business state. public.users is
--    multi-actor-per-owner (UNIQUE owner_id, user_id) — placing per-business
--    state there forces denormalization across crew rows. Same precedent
--    drove phone_e164 → chiefos_tenants in PR #9 (Amendment 2026-04-29).
--
-- 2. plan_key MOVED to chiefos_tenants (not duplicated, not left on users).
--    Path (b) per recon: drop users.plan_key entirely. Plan is per-business.
--    Cleanest model — no denormalization, no two-surface drift risk.
--    Application code reading users.plan_key tracked under
--    P1B-application-code-plan-key-source-update (post-Phase-1 cleanup).
--
-- 3. Spec amendments to §5.1, §5.2, §6, §7, §8, §9.4 ride alongside this
--    migration in the same PR (per PR #9 / PR #10 precedent — schema reality
--    and spec stay in sync).
--
-- 4. RPC amendment (P1A-14) lives in companion file
--    2026_04_29_amendment_p1a14_chiefos_finish_signup_rpc_lifecycle_and_plan.sql
--    and MUST be applied AFTER this schema migration (it drops users.plan_key
--    write and relies on chiefos_tenants column defaults to set lifecycle_state
--    and plan_key for new tenants).
--
-- ============================================================================
-- WHAT IS NOT CHANGED:
--   - Identity model: tenant_id (uuid) / owner_id (text) dual boundary intact
--   - public.users keeps user_id PK, owner_id, tenant_id, role, auth_user_id,
--     and all per-actor fields (name, email, signup_status, auto_assign_*).
--   - Existing chiefos_tenants columns untouched (phone_e164, paid_breaks_policy,
--     tax_region from Phase 0 work all preserved).
--   - RLS policies, GRANTs, foreign keys: unchanged
--
-- ============================================================================
-- ROLLBACK:
--   migrations/rollbacks/2026_04_29_phase1_pra_lifecycle_and_plan_key_on_chiefos_tenants_rollback.sql
--   restores users.plan_key with pre-Phase-1 enum ('free','starter','pro','enterprise')
--   default 'free', restores users_plan_key_chk constraint, drops chiefos_tenants
--   lifecycle/plan columns + indexes. Reversible without data loss because
--   pre-Phase-1 baseline is zero rows.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Preflight assertions
-- ----------------------------------------------------------------------------
DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_tenants') THEN
    RAISE EXCEPTION 'public.chiefos_tenants missing — Phase 0 prerequisite not met';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='users') THEN
    RAISE EXCEPTION 'public.users missing — Phase 0 prerequisite not met';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='chiefos_tenants'
               AND column_name IN (
                 'lifecycle_state','trial_started_at','trial_ends_at',
                 'read_only_started_at','read_only_ends_at','archived_at',
                 'data_deletion_eligible_at','first_whatsapp_message_at',
                 'first_portal_login_at','first_capture_at','first_job_created_at',
                 'reminders_sent','plan_key'
               )) THEN
    RAISE EXCEPTION 'One or more lifecycle/plan columns already exist on chiefos_tenants — migration is not idempotent on second apply; investigate before re-running';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='users'
                   AND column_name='plan_key') THEN
    RAISE EXCEPTION 'public.users.plan_key missing — schema unexpected; migration assumes pre-Phase-1 shape';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='users_plan_key_chk') THEN
    RAISE EXCEPTION 'users_plan_key_chk constraint missing — schema unexpected (recon confirmed actual constraint name)';
  END IF;

  IF (SELECT COUNT(*) FROM public.users) > 0 THEN
    RAISE EXCEPTION 'public.users has rows; migration assumes zero-row pre-launch baseline. Review wipe state.';
  END IF;

  IF (SELECT COUNT(*) FROM public.chiefos_tenants) > 0 THEN
    RAISE EXCEPTION 'public.chiefos_tenants has rows; migration assumes zero-row pre-launch baseline. Review wipe state.';
  END IF;

  RAISE NOTICE 'Preflight assertions passed.';
END
$preflight$;

-- ----------------------------------------------------------------------------
-- 1. Lifecycle state column (with explicit CHECK for v1.1 5-state machine)
-- ----------------------------------------------------------------------------
ALTER TABLE public.chiefos_tenants
  ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'pre_trial'
    CONSTRAINT chiefos_tenants_lifecycle_state_chk
      CHECK (lifecycle_state IN ('pre_trial', 'trial', 'paid', 'read_only', 'archived'));

-- ----------------------------------------------------------------------------
-- 2. Trial / read-only window timestamps + archive timestamps
-- ----------------------------------------------------------------------------
ALTER TABLE public.chiefos_tenants
  ADD COLUMN trial_started_at          TIMESTAMPTZ,
  ADD COLUMN trial_ends_at             TIMESTAMPTZ,
  ADD COLUMN read_only_started_at      TIMESTAMPTZ,
  ADD COLUMN read_only_ends_at         TIMESTAMPTZ,
  ADD COLUMN archived_at               TIMESTAMPTZ,
  ADD COLUMN data_deletion_eligible_at TIMESTAMPTZ;

-- ----------------------------------------------------------------------------
-- 3. Activation tracking — first-event timestamps (telemetry-grade attribution)
-- ----------------------------------------------------------------------------
ALTER TABLE public.chiefos_tenants
  ADD COLUMN first_whatsapp_message_at TIMESTAMPTZ,
  ADD COLUMN first_portal_login_at     TIMESTAMPTZ,
  ADD COLUMN first_capture_at          TIMESTAMPTZ,
  ADD COLUMN first_job_created_at      TIMESTAMPTZ;

-- ----------------------------------------------------------------------------
-- 4. Reminders sent (idempotent reminder dispatch keys)
-- ----------------------------------------------------------------------------
ALTER TABLE public.chiefos_tenants
  ADD COLUMN reminders_sent JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ----------------------------------------------------------------------------
-- 5. plan_key migration — ADD on chiefos_tenants with v1.1 enum, default 'trial'
-- ----------------------------------------------------------------------------
ALTER TABLE public.chiefos_tenants
  ADD COLUMN plan_key TEXT NOT NULL DEFAULT 'trial'
    CONSTRAINT chiefos_tenants_plan_key_chk
      CHECK (plan_key IN ('trial', 'starter', 'pro', 'enterprise', 'read_only'));

-- ----------------------------------------------------------------------------
-- 6. Drop users.plan_key + its CHECK constraint
--    NOTE: actual production constraint name is users_plan_key_chk (not
--    users_plan_key_check as v1.1 spec line 229 originally specified;
--    spec is amended in this PR to match production reality).
-- ----------------------------------------------------------------------------
ALTER TABLE public.users DROP CONSTRAINT users_plan_key_chk;
ALTER TABLE public.users DROP COLUMN plan_key;

-- ----------------------------------------------------------------------------
-- 7. Indexes (renamed from spec's idx_users_* to idx_chiefos_tenants_*)
-- ----------------------------------------------------------------------------
CREATE INDEX idx_chiefos_tenants_lifecycle_state
  ON public.chiefos_tenants(lifecycle_state);

CREATE INDEX idx_chiefos_tenants_trial_ends_at
  ON public.chiefos_tenants(trial_ends_at)
  WHERE lifecycle_state = 'trial';

CREATE INDEX idx_chiefos_tenants_read_only_ends_at
  ON public.chiefos_tenants(read_only_ends_at)
  WHERE lifecycle_state = 'read_only';

-- ----------------------------------------------------------------------------
-- 8. Column documentation
-- ----------------------------------------------------------------------------
COMMENT ON COLUMN public.chiefos_tenants.lifecycle_state IS
  'Per-business lifecycle state machine: pre_trial → trial → paid → read_only → archived. '
  'See TMTS v1.1 §7. Per-business (1:1 with chiefos_tenants), not per-actor.';
COMMENT ON COLUMN public.chiefos_tenants.trial_started_at IS
  'When the 14-day trial clock started. NULL while in pre_trial. '
  'Set by startTrialClock() on first WhatsApp msg OR first portal login (whichever first).';
COMMENT ON COLUMN public.chiefos_tenants.trial_ends_at IS
  'Trial expiry (trial_started_at + 14 days). Lifecycle reconciler transitions to read_only when this passes.';
COMMENT ON COLUMN public.chiefos_tenants.read_only_started_at IS
  'When read-only window started (after trial expiry without paid conversion, or after paid cancellation).';
COMMENT ON COLUMN public.chiefos_tenants.read_only_ends_at IS
  'Read-only expiry (read_only_started_at + 14 days). Lifecycle reconciler transitions to archived when this passes.';
COMMENT ON COLUMN public.chiefos_tenants.archived_at IS
  'When the business was archived (after read-only expiry without recovery).';
COMMENT ON COLUMN public.chiefos_tenants.data_deletion_eligible_at IS
  'When archived data becomes eligible for hard deletion (archived_at + 12 months).';
COMMENT ON COLUMN public.chiefos_tenants.first_whatsapp_message_at IS
  'Telemetry: timestamp of first inbound WhatsApp message ever for this business. Set once.';
COMMENT ON COLUMN public.chiefos_tenants.first_portal_login_at IS
  'Telemetry: timestamp of first portal login ever for this business. Set once.';
COMMENT ON COLUMN public.chiefos_tenants.first_capture_at IS
  'Telemetry: timestamp of first capture (receipt/expense/etc.) for this business. Set once.';
COMMENT ON COLUMN public.chiefos_tenants.first_job_created_at IS
  'Telemetry: timestamp of first job created for this business. Set once.';
COMMENT ON COLUMN public.chiefos_tenants.reminders_sent IS
  'Idempotent reminder dispatch ledger. Keys are reminder_id strings (e.g. email_pre_trial_24h, '
  'email_read_only_day_7); values are dispatch timestamps. JSONB chosen for flexible per-reminder '
  'idempotency keys without schema churn.';
COMMENT ON COLUMN public.chiefos_tenants.plan_key IS
  'Canonical business plan. v1.1 enum: trial | starter | pro | enterprise | read_only. '
  'Moved here from public.users in Phase 1 PR-A — plan is per-business, not per-actor. '
  'Default trial; transitions per TMTS §7.';

-- ----------------------------------------------------------------------------
-- 9. Sanity assertion — exact column counts and constraint placement
-- ----------------------------------------------------------------------------
DO $assert$
DECLARE
  v_lifecycle_count            int;
  v_plan_key_present_tenants   int;
  v_plan_key_present_users     int;
  v_users_plan_key_chk_present int;
  v_lifecycle_chk_present      int;
  v_tenants_plan_key_chk_present int;
  v_index_count                int;
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

  SELECT COUNT(*) INTO v_plan_key_present_tenants
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='chiefos_tenants' AND column_name='plan_key';

  SELECT COUNT(*) INTO v_plan_key_present_users
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='users' AND column_name='plan_key';

  SELECT COUNT(*) INTO v_users_plan_key_chk_present
  FROM pg_constraint WHERE conname='users_plan_key_chk';

  SELECT COUNT(*) INTO v_lifecycle_chk_present
  FROM pg_constraint WHERE conname='chiefos_tenants_lifecycle_state_chk';

  SELECT COUNT(*) INTO v_tenants_plan_key_chk_present
  FROM pg_constraint WHERE conname='chiefos_tenants_plan_key_chk';

  SELECT COUNT(*) INTO v_index_count
  FROM pg_indexes
  WHERE schemaname='public' AND tablename='chiefos_tenants'
    AND indexname IN (
      'idx_chiefos_tenants_lifecycle_state',
      'idx_chiefos_tenants_trial_ends_at',
      'idx_chiefos_tenants_read_only_ends_at'
    );

  IF v_lifecycle_count <> 13 THEN
    RAISE EXCEPTION 'Expected 13 lifecycle/plan columns on chiefos_tenants, found %', v_lifecycle_count;
  END IF;

  IF v_plan_key_present_tenants <> 1 THEN
    RAISE EXCEPTION 'plan_key not added to chiefos_tenants';
  END IF;

  IF v_plan_key_present_users <> 0 THEN
    RAISE EXCEPTION 'users.plan_key still present (drop failed)';
  END IF;

  IF v_users_plan_key_chk_present <> 0 THEN
    RAISE EXCEPTION 'users_plan_key_chk constraint still present (drop failed)';
  END IF;

  IF v_lifecycle_chk_present <> 1 THEN
    RAISE EXCEPTION 'chiefos_tenants_lifecycle_state_chk constraint missing';
  END IF;

  IF v_tenants_plan_key_chk_present <> 1 THEN
    RAISE EXCEPTION 'chiefos_tenants_plan_key_chk constraint missing';
  END IF;

  IF v_index_count <> 3 THEN
    RAISE EXCEPTION 'Expected 3 lifecycle indexes on chiefos_tenants, found %', v_index_count;
  END IF;

  RAISE NOTICE 'Phase 1 PR-A schema migration: 13 columns added to chiefos_tenants, users.plan_key dropped, 2 CHECK constraints + 3 partial indexes created.';
END
$assert$;

COMMIT;
