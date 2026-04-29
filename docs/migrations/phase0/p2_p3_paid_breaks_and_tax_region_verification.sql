-- Verification for 2026_04_29_phase0_p2_p3 — Phase 0 blockers #2 + #3
-- Run via Supabase MCP execute_sql AFTER migration is applied.
-- All 9 queries should return the documented expected shape. If any deviates
-- → STOP, investigate before re-running Phase 0 audit.
-- ============================================================================

-- Q1: paid_breaks_policy column exists with correct shape
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema='public' AND table_name='chiefos_tenants'
  AND column_name='paid_breaks_policy';
-- Expect: 1 row → ('paid_breaks_policy', 'text', 'NO', '''unpaid''::text')

-- Q2: paid_breaks_policy CHECK constraint applied
SELECT con.conname, pg_get_constraintdef(con.oid) AS def
FROM pg_constraint con
JOIN pg_class rel ON rel.oid=con.conrelid
JOIN pg_namespace n ON n.oid=rel.relnamespace
WHERE n.nspname='public' AND rel.relname='chiefos_tenants' AND con.contype='c'
  AND pg_get_constraintdef(con.oid) ILIKE '%paid_breaks_policy%';
-- Expect: 1 row, definition includes ANY (ARRAY['paid', 'unpaid'])

-- Q3: region column dropped
SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='chiefos_tenants'
  AND column_name='region';
-- Expect: 0 rows

-- Q4: province format CHECK applied
SELECT con.conname, pg_get_constraintdef(con.oid) AS def
FROM pg_constraint con
JOIN pg_class rel ON rel.oid=con.conrelid
JOIN pg_namespace n ON n.oid=rel.relnamespace
WHERE n.nspname='public' AND rel.relname='chiefos_tenants'
  AND con.conname='chiefos_tenants_province_format_chk';
-- Expect: 1 row, definition contains '^[A-Z]{2}$'

-- Q5: province is NOT NULL
SELECT column_name, is_nullable FROM information_schema.columns
WHERE table_schema='public' AND table_name='chiefos_tenants'
  AND column_name='province';
-- Expect: 1 row → ('province', 'NO')

-- Q6: tax_region exists as generated column
SELECT column_name, data_type, is_generated, generation_expression
FROM information_schema.columns
WHERE table_schema='public' AND table_name='chiefos_tenants'
  AND column_name='tax_region';
-- Expect: 1 row → ('tax_region', 'text', 'ALWAYS', expression includes 'country' and 'province')

-- Q7: tax_region values populated correctly
SELECT id, country, province, tax_region,
       (country || '-' || province) = tax_region AS matches_expected
FROM public.chiefos_tenants ORDER BY id;
-- Expect: 2 rows → both matches_expected=true; both should show tax_region='CA-ON'

-- Q8: paid_breaks_policy default applied to existing rows
SELECT id, paid_breaks_policy FROM public.chiefos_tenants ORDER BY id;
-- Expect: 2 rows, both 'unpaid'

-- Q9: Row count unchanged
SELECT COUNT(*) AS total FROM public.chiefos_tenants;
-- Expect: 2
