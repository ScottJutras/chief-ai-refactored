-- Migration: 2026_04_29_phase1_prb_grants_followup.sql
--
-- PHASE 1 PR-B FOLLOW-UP: GRANT statements for acquisition_events + landing_events.
--
-- Closes the privilege gap surfaced by the PR-B production application's
-- RLS round-trip test:
--   * acquisition_events has RLS enabled + a SELECT policy, but no base
--     GRANTs to the authenticated role. RLS policies filter rows on top
--     of base privileges; without a GRANT, the authenticated role gets
--     `permission denied for table acquisition_events` from Postgres
--     before the policy is even consulted.
--   * landing_events likewise lacks any GRANTs (intended service-role-only
--     access requires an explicit GRANT — service_role does not auto-inherit).
--
-- NOT applied to production by this PR — authoring only.
--
-- ============================================================================
-- DECISIONS LOCKED PER PR-B PRODUCTION-APPLY GAP REPORT (2026-04-29):
--
-- 1. acquisition_events grants:
--      authenticated  → SELECT only.
--                       Reads filtered by RLS policy "Tenants can read own
--                       acquisition events" (tenant_id IN portal_users
--                       membership for auth.uid()).
--                       NO INSERT / UPDATE / DELETE on authenticated. Writes
--                       happen via SECURITY DEFINER functions (e.g., future
--                       event-logging RPCs) running as their own owner with
--                       implicit service_role-equivalent privileges, OR via
--                       the service_role grant directly (cron / webhooks /
--                       background jobs).
--      service_role   → SELECT, INSERT, UPDATE, DELETE.
--                       Bypasses RLS automatically. Used by event-logging
--                       application code, lifecycle reconciler cron, and
--                       Stripe webhook handlers to write paid_conversion etc.
--
-- 2. landing_events grants:
--      authenticated  → NO GRANT. Anonymous funnel data is not user-visible.
--                       Portal users have no business reading pre-signup
--                       events (they have no tenant attribution at that
--                       stage; data shape is not RLS-shaped).
--      service_role   → SELECT, INSERT, UPDATE, DELETE.
--                       Form handler / landing page captures write here;
--                       analytics queries read here.
--
-- 3. Pattern for future RLS tables (filed as
--    `P1B-rls-grant-pattern-for-future-tables`):
--    Any future table that ENABLE ROW LEVEL SECURITY must include explicit
--    GRANT SELECT (and any other appropriate verbs) to the role(s) that
--    will hit the policy. RLS policies do NOT bypass missing base grants.
--    The PR-B precedent: schema/RLS/policy in one PR, then a follow-up to
--    add grants. Prevent that two-PR cycle by including the grant in the
--    table-creating migration directly.
--
-- ============================================================================
-- WHAT IS NOT CHANGED:
--   - Schema (columns, indexes, FK, CHECK, RLS policy): all PR-B state intact
--   - chiefos_finish_signup RPC (unchanged from P1A-14)
--   - All other tables and grants
--
-- ============================================================================
-- ROLLBACK:
--   migrations/rollbacks/2026_04_29_phase1_prb_grants_followup_rollback.sql
--   REVOKEs all grants added by this migration.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Preflight assertions
-- ----------------------------------------------------------------------------
DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='acquisition_events') THEN
    RAISE EXCEPTION 'acquisition_events missing — apply phase1 PR-B schema migration first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='landing_events') THEN
    RAISE EXCEPTION 'landing_events missing — apply phase1 PR-B schema migration first';
  END IF;

  -- Idempotency check: if grants already exist, this migration was already
  -- applied. Use the rollback first if re-running.
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name='acquisition_events'
      AND grantee IN ('authenticated','service_role')
  ) THEN
    RAISE EXCEPTION 'GRANTs already exist on acquisition_events — migration already applied? Use rollback first if re-applying.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name='landing_events'
      AND grantee IN ('authenticated','service_role')
  ) THEN
    RAISE EXCEPTION 'GRANTs already exist on landing_events — migration already applied? Use rollback first if re-applying.';
  END IF;

  RAISE NOTICE 'Preflight assertions passed.';
END
$preflight$;

-- ----------------------------------------------------------------------------
-- 1. acquisition_events: portal users can SELECT (filtered by RLS);
--    service_role does full CRUD (bypasses RLS automatically).
-- ----------------------------------------------------------------------------
GRANT SELECT ON public.acquisition_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.acquisition_events TO service_role;

-- ----------------------------------------------------------------------------
-- 2. landing_events: service_role only (anonymous funnel; not user-visible).
--    No GRANT to authenticated by design.
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.landing_events TO service_role;

-- ----------------------------------------------------------------------------
-- 3. Sanity assertion — exact grant counts per role per table
-- ----------------------------------------------------------------------------
DO $assert$
DECLARE
  v_acq_authenticated_grants     int;
  v_acq_service_grants           int;
  v_landing_service_grants       int;
  v_landing_authenticated_grants int;
BEGIN
  SELECT COUNT(*) INTO v_acq_authenticated_grants
  FROM information_schema.role_table_grants
  WHERE table_schema='public' AND table_name='acquisition_events'
    AND grantee='authenticated';

  SELECT COUNT(*) INTO v_acq_service_grants
  FROM information_schema.role_table_grants
  WHERE table_schema='public' AND table_name='acquisition_events'
    AND grantee='service_role';

  SELECT COUNT(*) INTO v_landing_service_grants
  FROM information_schema.role_table_grants
  WHERE table_schema='public' AND table_name='landing_events'
    AND grantee='service_role';

  SELECT COUNT(*) INTO v_landing_authenticated_grants
  FROM information_schema.role_table_grants
  WHERE table_schema='public' AND table_name='landing_events'
    AND grantee='authenticated';

  -- acquisition_events: 1 authenticated grant (SELECT), 4 service_role (CRUD)
  IF v_acq_authenticated_grants <> 1 THEN
    RAISE EXCEPTION 'acquisition_events authenticated grants expected 1, found %', v_acq_authenticated_grants;
  END IF;
  IF v_acq_service_grants <> 4 THEN
    RAISE EXCEPTION 'acquisition_events service_role grants expected 4, found %', v_acq_service_grants;
  END IF;

  -- landing_events: 4 service_role (CRUD), 0 authenticated (intentional)
  IF v_landing_service_grants <> 4 THEN
    RAISE EXCEPTION 'landing_events service_role grants expected 4, found %', v_landing_service_grants;
  END IF;
  IF v_landing_authenticated_grants <> 0 THEN
    RAISE EXCEPTION 'landing_events should have NO authenticated grants but found %', v_landing_authenticated_grants;
  END IF;

  RAISE NOTICE 'PR-B grants follow-up: acquisition_events (auth=1, service=4), landing_events (auth=0, service=4)';
END
$assert$;

COMMIT;
