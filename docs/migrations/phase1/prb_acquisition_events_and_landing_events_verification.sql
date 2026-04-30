-- Verification queries for Phase 1 PR-B
-- Run AFTER applying:
--   migrations/2026_04_29_phase1_prb_acquisition_events_and_landing_events.sql
--
-- All ten queries should return the expected ✓ result. Read-only.

-- ============================================================================
-- Q1: landing_events columns present (8 expected)
-- Expected: 8 rows
-- ============================================================================
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema='public' AND table_name='landing_events'
ORDER BY ordinal_position;

-- ============================================================================
-- Q2: acquisition_events columns present (9 expected)
-- Expected: 9 rows; tenant_id is uuid NOT NULL
-- ============================================================================
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema='public' AND table_name='acquisition_events'
ORDER BY ordinal_position;

-- ============================================================================
-- Q3: landing_events indexes (PK + 3 supporting = 4)
-- Expected: 4 rows
-- ============================================================================
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname='public' AND tablename='landing_events'
ORDER BY indexname;

-- ============================================================================
-- Q4: acquisition_events indexes (PK + 4 supporting = 5)
-- Expected: 5 rows including idx_acquisition_events_tenant_event composite
-- ============================================================================
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname='public' AND tablename='acquisition_events'
ORDER BY indexname;

-- ============================================================================
-- Q5: acquisition_events RLS enabled
-- Expected: relrowsecurity = true
-- ============================================================================
SELECT relname, relrowsecurity
FROM pg_class
WHERE oid='public.acquisition_events'::regclass;

-- ============================================================================
-- Q6: acquisition_events SELECT policy
-- Expected: 1 row, USING clause references chiefos_portal_users + auth.uid()
-- ============================================================================
SELECT policyname, cmd, qual
FROM pg_policies
WHERE schemaname='public' AND tablename='acquisition_events';

-- ============================================================================
-- Q7: acquisition_events FK to chiefos_tenants(id) ON DELETE CASCADE
-- Expected: 1 FK with confdeltype='c' (CASCADE)
-- ============================================================================
SELECT con.conname,
       pg_get_constraintdef(con.oid) AS def,
       con.confdeltype
FROM pg_constraint con
WHERE con.conrelid='public.acquisition_events'::regclass
  AND con.contype='f';

-- ============================================================================
-- Q8: landing_events event_type CHECK has 3 expected values
-- Expected: definition contains all three pre-signup event names
-- ============================================================================
SELECT con.conname, pg_get_constraintdef(con.oid) AS def
FROM pg_constraint con
WHERE con.conrelid='public.landing_events'::regclass
  AND con.contype='c'
  AND pg_get_constraintdef(con.oid) ILIKE '%event_type%';

-- ============================================================================
-- Q9: acquisition_events event_type CHECK has 6 expected values
-- Expected: definition contains all six post-signup event names
-- ============================================================================
SELECT con.conname, pg_get_constraintdef(con.oid) AS def
FROM pg_constraint con
WHERE con.conrelid='public.acquisition_events'::regclass
  AND con.contype='c'
  AND pg_get_constraintdef(con.oid) ILIKE '%event_type%';

-- ============================================================================
-- Q10: Row counts (both tables = 0 at apply time)
-- Expected: 0 / 0
-- ============================================================================
SELECT 'landing_events' AS tbl, COUNT(*)::text AS rows FROM public.landing_events
UNION ALL
SELECT 'acquisition_events', COUNT(*)::text FROM public.acquisition_events;
