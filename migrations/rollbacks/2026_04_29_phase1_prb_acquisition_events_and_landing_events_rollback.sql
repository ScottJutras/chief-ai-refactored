-- Rollback: 2026_04_29_phase1_prb_acquisition_events_and_landing_events_rollback.sql
--
-- Reverses 2026_04_29_phase1_prb_acquisition_events_and_landing_events.sql.
--
-- Drops both tables. CASCADE removes:
--   - All indexes (PK + supporting)
--   - acquisition_events RLS policy
--   - acquisition_events FK to chiefos_tenants(id)
--   - All COMMENTs
--
-- Reversible without data loss only at zero-row baseline (or if event data
-- is acceptable to discard — these are telemetry, not financial truth).
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='acquisition_events') THEN
    RAISE EXCEPTION 'acquisition_events missing — forward migration not applied?';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='landing_events') THEN
    RAISE EXCEPTION 'landing_events missing — forward migration not applied?';
  END IF;
END
$preflight$;

-- Drop policy first (DROP TABLE CASCADE would handle this, but explicit
-- is clearer for audit trail).
DROP POLICY IF EXISTS "Tenants can read own acquisition events"
  ON public.acquisition_events;

-- Drop tables in reverse-dependency order. acquisition_events first
-- (it has the FK), landing_events second.
DROP TABLE IF EXISTS public.acquisition_events CASCADE;
DROP TABLE IF EXISTS public.landing_events CASCADE;

DO $assert$
DECLARE
  v_landing_present int;
  v_acq_present int;
BEGIN
  SELECT COUNT(*) INTO v_landing_present
  FROM information_schema.tables
  WHERE table_schema='public' AND table_name='landing_events';

  SELECT COUNT(*) INTO v_acq_present
  FROM information_schema.tables
  WHERE table_schema='public' AND table_name='acquisition_events';

  IF v_landing_present <> 0 THEN
    RAISE EXCEPTION 'Rollback incomplete: landing_events still present';
  END IF;
  IF v_acq_present <> 0 THEN
    RAISE EXCEPTION 'Rollback incomplete: acquisition_events still present';
  END IF;

  RAISE NOTICE 'Phase 1 PR-B rollback complete: both tables dropped.';
END
$assert$;

COMMIT;
