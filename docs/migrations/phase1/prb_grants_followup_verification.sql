-- Verification queries for Phase 1 PR-B grants follow-up
-- Run AFTER applying:
--   migrations/2026_04_29_phase1_prb_grants_followup.sql
--
-- All queries should return the expected ✓ result. Read-only.

-- ============================================================================
-- Q1: acquisition_events grants per role
-- Expected:
--   authenticated → SELECT (1 row)
--   service_role  → SELECT, INSERT, UPDATE, DELETE (4 rows)
-- ============================================================================
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema='public' AND table_name='acquisition_events'
  AND grantee IN ('authenticated','service_role','anon')
ORDER BY grantee, privilege_type;

-- ============================================================================
-- Q2: landing_events grants per role
-- Expected:
--   service_role → SELECT, INSERT, UPDATE, DELETE (4 rows)
--   authenticated → 0 rows (intentionally absent)
-- ============================================================================
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema='public' AND table_name='landing_events'
  AND grantee IN ('authenticated','service_role','anon')
ORDER BY grantee, privilege_type;

-- ============================================================================
-- Q3: anon role has NO grants on either table (defense in depth)
-- Expected: 0 rows
-- ============================================================================
SELECT table_name, grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema='public'
  AND table_name IN ('acquisition_events','landing_events')
  AND grantee='anon';

-- ============================================================================
-- Q4: RLS state unchanged on acquisition_events (post-grants)
-- Expected: relrowsecurity = true
-- ============================================================================
SELECT relname, relrowsecurity
FROM pg_class
WHERE oid='public.acquisition_events'::regclass;

-- ============================================================================
-- Q5: SELECT policy unchanged on acquisition_events
-- Expected: 1 row, "Tenants can read own acquisition events"
-- ============================================================================
SELECT policyname, cmd
FROM pg_policies
WHERE schemaname='public' AND tablename='acquisition_events';

-- ============================================================================
-- Q6: Compare with established precedents (chiefos_tenants, chiefos_portal_users)
-- Expected: every public table with RLS has authenticated SELECT grant
-- ============================================================================
SELECT t.table_name,
       (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t.table_name)::regclass) AS rls_enabled,
       (SELECT COUNT(*) FROM information_schema.role_table_grants g
        WHERE g.table_schema='public' AND g.table_name=t.table_name
          AND g.grantee='authenticated' AND g.privilege_type='SELECT') AS authenticated_select_grant
FROM information_schema.tables t
WHERE t.table_schema='public'
  AND t.table_name IN ('acquisition_events','landing_events','chiefos_tenants','chiefos_portal_users')
ORDER BY t.table_name;
