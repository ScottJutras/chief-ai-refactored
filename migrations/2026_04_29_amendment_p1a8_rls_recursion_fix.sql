-- Migration: 2026_04_29_amendment_p1a8_rls_recursion_fix.sql
--
-- PHASE 1 AMENDMENT (Session P1A-8) for Foundation Rebuild V2.
--
-- ============================================================================
-- BUG CLASS: RLS policy queries the same table it protects
--            → PostgreSQL error 42P17 "infinite recursion detected in policy
--              for relation <table>"
-- ============================================================================
--
-- When an RLS policy's USING/WITH CHECK clause contains a subquery against
-- the same table the policy protects, every evaluation of the policy
-- triggers another RLS evaluation on that same table, which triggers
-- another, and so on. Postgres aborts with 42P17 the moment a real client
-- (RLS-respecting role like `authenticated`) reads or writes the table.
--
-- The bug is invisible to service-role traffic (which bypasses RLS), so
-- cutover smoke tests, backend ingestion paths, and admin SDK calls all
-- pass cleanly. The first authenticated client SELECT against an affected
-- table 42P17s.
--
-- This migration fixes two latent occurrences of the bug class introduced
-- during the Foundation Rebuild:
--   1. chiefos_portal_users — surfaced 2026-04-28 during Path α onboarding
--      end-to-end test. FinishSignupClient.tsx does a client SELECT against
--      chiefos_portal_users to detect returning users; that query 42P17'd
--      and aborted /finish-signup mid-flow.
--   2. supplier_users — discovered via comprehensive RLS audit at the same
--      time. Same recursion shape; not yet exercised by any deployed FE
--      flow, so it has been silently broken since cutover.
--
-- ============================================================================
-- BROKEN PATTERN (do not write policies like this)
-- ============================================================================
--
-- Original portal_users_tenant_read_by_owner (DROPPED by this migration):
--
--   CREATE POLICY portal_users_tenant_read_by_owner
--     ON public.chiefos_portal_users FOR SELECT
--     USING (tenant_id IN (
--       SELECT chiefos_portal_users_1.tenant_id
--       FROM chiefos_portal_users chiefos_portal_users_1
--       WHERE user_id = auth.uid() AND role = 'owner'
--     ));
--
-- The subquery `SELECT ... FROM chiefos_portal_users` is itself subject to
-- the SELECT policies on chiefos_portal_users — including this very policy
-- — which triggers another subquery, etc. 42P17.
--
-- ============================================================================
-- FIXED PATTERN (canonical for this codebase going forward)
-- ============================================================================
--
-- 1. Author a SECURITY DEFINER function that performs the lookup. The
--    function executes with the function-owner's privileges, bypassing RLS
--    on the inner query. SET search_path='' pinned for injection safety.
--    Parameterize by uuid (caller passes auth.uid() explicitly) so the
--    function returns only what the caller is already entitled to claim.
--
--      CREATE OR REPLACE FUNCTION public.chiefos_owner_tenants_for(uid uuid)
--      RETURNS SETOF uuid
--      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
--      AS $$ SELECT tenant_id FROM public.chiefos_portal_users
--             WHERE user_id = uid AND role = 'owner' AND status = 'active'; $$;
--
-- 2. Replace the recursive policy with one that calls the helper:
--
--      CREATE POLICY portal_users_tenant_read_by_owner
--        ON public.chiefos_portal_users FOR SELECT
--        USING (tenant_id IN (SELECT public.chiefos_owner_tenants_for(auth.uid())));
--
-- The helper executes once per row, returns the calling user's owned
-- tenants, and the IN check is a plain set membership — no recursion.
-- Security semantic preserved: only authenticated owners see other members
-- of their tenant; non-owners see only their own row (via the still-extant
-- portal_users_self_select policy).
--
-- ============================================================================
-- CODE-REVIEW PROMPT FOR FUTURE AUTHORS
-- ============================================================================
--
-- If you find yourself writing an RLS policy that subqueries the same
-- table the policy protects — STOP. That's the 42P17 bug class.
-- Use a SECURITY DEFINER helper instead. See chiefos_owner_tenants_for()
-- and chiefos_supplier_ids_for() in this migration as canonical patterns.
-- Both are parameterized by uid (not auth.uid() inside the function body)
-- so the function cannot leak data the caller isn't already entitled to.
--
-- ============================================================================
-- BLAST-RADIUS NOTE: downstream policies that depend on these fixes
-- ============================================================================
--
-- Several other policies cross-reference chiefos_portal_users in their
-- USING clauses. They do NOT recurse (they query a different table from
-- the one they protect) but they DO depend on chiefos_portal_users SELECT
-- working for authenticated users. Until P1A-8, those queries returned
-- zero rows for all authenticated client traffic because the upstream
-- chiefos_portal_users SELECT 42P17'd silently. Affected:
--
--   - chiefos_tenants:           chiefos_tenants_portal_select / _owner_update
--   - users (public):            users_tenant_select / _tenant_update_owner
--   - chiefos_legal_acceptances: legal_acceptances_select_by_tenant_membership
--   - tasks:                     tasks_tenant_update
--
-- These policies start working correctly once P1A-8 lands. Post-apply
-- verification confirms each via direct authenticated-context SELECT.
--
-- For supplier_users: no current downstream policies cross-reference it
-- from another table. Fixing supplier_users_co_supplier_select restores
-- co-membership reads for supplier-portal flows when those FEs ship.
--
-- ============================================================================
-- Apply-order: post-cutover P1A-N amendment. Recorded in
-- REBUILD_MIGRATION_MANIFEST.md §7. Applied directly to production via
-- mcp__claude_ai_Supabase__apply_migration.
--
-- Rollback: see migrations/rollbacks/. Drops the new policies, recreates
-- the original (broken) policies verbatim, and drops the helper functions.
-- After rollback, client-side SELECTs on chiefos_portal_users and
-- supplier_users will 42P17 again — only roll back if the helper
-- functions themselves prove problematic (no expected scenario).
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_portal_users') THEN
    RAISE EXCEPTION 'Requires public.chiefos_portal_users';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='supplier_users') THEN
    RAISE EXCEPTION 'Requires public.supplier_users (apply P1A-2 amendment_supplier_catalog_root first)';
  END IF;
END
$preflight$;

-- ============================================================================
-- 1. Helper: chiefos_owner_tenants_for(uid)
--    Returns tenant_ids where uid is an active 'owner' membership.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.chiefos_owner_tenants_for(uid uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT tenant_id
  FROM public.chiefos_portal_users
  WHERE user_id = uid
    AND role = 'owner'
    AND status = 'active';
$function$;

COMMENT ON FUNCTION public.chiefos_owner_tenants_for(uuid) IS
  'RLS-recursion-fix helper. Returns tenant_ids where uid is an active owner. '
  'SECURITY DEFINER bypasses chiefos_portal_users RLS during the inner SELECT, '
  'breaking the self-reference recursion the original policy hit. '
  'Parameterized by uid (callers pass auth.uid()) so the function returns only '
  'what the caller is already entitled to. See migration P1A-8 header.';

REVOKE ALL ON FUNCTION public.chiefos_owner_tenants_for(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chiefos_owner_tenants_for(uuid) TO authenticated;

-- ============================================================================
-- 2. Helper: chiefos_supplier_ids_for(uid)
--    Returns supplier_ids where uid is an active supplier_users membership.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.chiefos_supplier_ids_for(uid uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT supplier_id
  FROM public.supplier_users
  WHERE auth_uid = uid
    AND is_active = true;
$function$;

COMMENT ON FUNCTION public.chiefos_supplier_ids_for(uuid) IS
  'RLS-recursion-fix helper. Returns supplier_ids where uid is an active '
  'supplier_users member. SECURITY DEFINER bypasses supplier_users RLS during '
  'the inner SELECT, breaking the self-reference recursion the original policy '
  'hit. Parameterized by uid (callers pass auth.uid()). See migration P1A-8 header.';

REVOKE ALL ON FUNCTION public.chiefos_supplier_ids_for(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chiefos_supplier_ids_for(uuid) TO authenticated;

-- ============================================================================
-- 3. Replace recursive policies on chiefos_portal_users
-- ============================================================================

DROP POLICY IF EXISTS portal_users_tenant_read_by_owner ON public.chiefos_portal_users;
CREATE POLICY portal_users_tenant_read_by_owner
  ON public.chiefos_portal_users
  FOR SELECT
  USING (tenant_id IN (SELECT public.chiefos_owner_tenants_for(auth.uid())));

DROP POLICY IF EXISTS portal_users_owner_update_roles ON public.chiefos_portal_users;
CREATE POLICY portal_users_owner_update_roles
  ON public.chiefos_portal_users
  FOR UPDATE
  USING       (tenant_id IN (SELECT public.chiefos_owner_tenants_for(auth.uid())))
  WITH CHECK  (tenant_id IN (SELECT public.chiefos_owner_tenants_for(auth.uid())));

-- ============================================================================
-- 4. Replace recursive policy on supplier_users
-- ============================================================================

DROP POLICY IF EXISTS supplier_users_co_supplier_select ON public.supplier_users;
CREATE POLICY supplier_users_co_supplier_select
  ON public.supplier_users
  FOR SELECT
  USING (supplier_id IN (SELECT public.chiefos_supplier_ids_for(auth.uid())));

COMMIT;
