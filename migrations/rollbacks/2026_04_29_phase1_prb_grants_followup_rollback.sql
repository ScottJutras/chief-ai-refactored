-- Rollback: 2026_04_29_phase1_prb_grants_followup_rollback.sql
--
-- Reverses 2026_04_29_phase1_prb_grants_followup.sql.
--
-- REVOKEs all grants added by the forward migration. Tables/RLS/policies
-- remain intact — only base table privileges are removed. Reapplying this
-- rollback returns the tables to the post-PR-B-schema, pre-grants state
-- (i.e., authenticated gets "permission denied" again).
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='acquisition_events') THEN
    RAISE EXCEPTION 'acquisition_events missing — schema not present?';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='landing_events') THEN
    RAISE EXCEPTION 'landing_events missing — schema not present?';
  END IF;
END
$preflight$;

REVOKE SELECT, INSERT, UPDATE, DELETE ON public.landing_events FROM service_role;

REVOKE SELECT, INSERT, UPDATE, DELETE ON public.acquisition_events FROM service_role;
REVOKE SELECT ON public.acquisition_events FROM authenticated;

DO $assert$
DECLARE
  v_acq_grants     int;
  v_landing_grants int;
BEGIN
  SELECT COUNT(*) INTO v_acq_grants
  FROM information_schema.role_table_grants
  WHERE table_schema='public' AND table_name='acquisition_events'
    AND grantee IN ('authenticated','service_role');

  SELECT COUNT(*) INTO v_landing_grants
  FROM information_schema.role_table_grants
  WHERE table_schema='public' AND table_name='landing_events'
    AND grantee IN ('authenticated','service_role');

  IF v_acq_grants <> 0 THEN
    RAISE EXCEPTION 'Rollback incomplete: acquisition_events still has % grants for authenticated/service_role', v_acq_grants;
  END IF;
  IF v_landing_grants <> 0 THEN
    RAISE EXCEPTION 'Rollback incomplete: landing_events still has % grants for authenticated/service_role', v_landing_grants;
  END IF;

  RAISE NOTICE 'PR-B grants follow-up rollback complete: zero grants on both tables for authenticated/service_role.';
END
$assert$;

COMMIT;
