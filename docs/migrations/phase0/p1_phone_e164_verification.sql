-- Post-application verification for:
--   2026_04_29_phase0_p1_phone_e164_on_chiefos_tenants.sql
--   2026_04_29_amendment_p1a13_chiefos_finish_signup_rpc_phone_e164.sql
--
-- Run via Supabase MCP execute_sql AFTER both migrations are applied to
-- production. All 6 queries should return the documented expected shape.
-- If any query deviates → STOP, investigate before proceeding to Phase 0
-- blocker #2 (paid_breaks_policy).
-- ============================================================================

-- Q1: Column exists, correct type, nullable
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'chiefos_tenants'
  AND column_name = 'phone_e164';
-- Expect: 1 row → ('phone_e164', 'text', 'YES')

-- Q2: CHECK constraint applied with E.164 regex
SELECT con.conname, pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
WHERE rel.relname = 'chiefos_tenants'
  AND con.contype = 'c'
  AND con.conname = 'chiefos_tenants_phone_e164_format_chk';
-- Expect: 1 row → definition contains '^\+[1-9]\d{6,14}$'

-- Q3: Partial UNIQUE INDEX applied
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'chiefos_tenants'
  AND indexname = 'chiefos_tenants_phone_e164_unique_idx';
-- Expect: 1 row → indexdef contains 'UNIQUE INDEX' and 'WHERE (phone_e164 IS NOT NULL)'

-- Q4: Backfill complete (production currently has 2 tenants)
SELECT
  COUNT(*) AS total,
  COUNT(phone_e164) AS populated,
  COUNT(*) - COUNT(phone_e164) AS null_count
FROM public.chiefos_tenants;
-- Expect: total=2, populated=2, null_count=0

-- Q5: Backfilled values match expected E.164 form (deterministic '+' || owner_id)
SELECT id, owner_id, phone_e164,
       ('+' || owner_id) = phone_e164 AS matches_expected
FROM public.chiefos_tenants
ORDER BY id;
-- Expect: 2 rows → matches_expected = true for both

-- Q6: Cross-check phone_e164 against auth.users.raw_user_meta_data.owner_phone
--     for the 1 real user (Scott). The 3 chiefos.test fixtures lack metadata.
--     Backfill is digit-strip + '+' prefix; metadata has digits-only form;
--     adding '+' to metadata digits should equal phone_e164.
SELECT
  ct.owner_id,
  ct.phone_e164,
  au.raw_user_meta_data ->> 'owner_phone' AS metadata_phone_digits,
  ('+' || (au.raw_user_meta_data ->> 'owner_phone')) = ct.phone_e164 AS cross_check_passes
FROM public.chiefos_tenants ct
JOIN public.users u ON u.owner_id = ct.owner_id AND u.user_id = ct.owner_id
JOIN auth.users au ON au.id = u.auth_user_id
WHERE au.raw_user_meta_data ->> 'owner_phone' IS NOT NULL;
-- Expect: 1 row (Scott) → cross_check_passes = true

-- Q7 (RPC verification, optional): confirm chiefos_finish_signup function
--    body now references phone_e164. Read-only inspection.
SELECT pg_get_functiondef(p.oid) ILIKE '%phone_e164%' AS rpc_persists_phone_e164
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'chiefos_finish_signup';
-- Expect: 1 row → rpc_persists_phone_e164 = true
