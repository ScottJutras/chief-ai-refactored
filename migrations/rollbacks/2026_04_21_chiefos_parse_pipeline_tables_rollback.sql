-- ============================================================================
-- ROLLBACK for 2026_04_21_chiefos_parse_pipeline_tables.sql
--
-- Drops parse_corrections → vendor_aliases → parse_jobs (reverse of FK order).
-- Drops RLS policies and indexes explicitly before DROP TABLE for clarity
-- (Postgres cascades, but explicit is auditable).
--
-- Idempotent: uses IF EXISTS for every drop.
--
-- Safe to run when: no other migrations or code depend on these tables.
-- NEVER run in production without an explicit deploy-gate approval.
-- ============================================================================

BEGIN;

-- ── Preflight: warn if any of the tables have non-trivial row counts ───────
DO $rollback_preflight$
DECLARE
  pj_count  bigint := 0;
  va_count  bigint := 0;
  pc_count  bigint := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='parse_jobs') THEN
    SELECT COUNT(*) INTO pj_count FROM public.parse_jobs;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='vendor_aliases') THEN
    SELECT COUNT(*) INTO va_count FROM public.vendor_aliases;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='parse_corrections') THEN
    SELECT COUNT(*) INTO pc_count FROM public.parse_corrections;
  END IF;
  RAISE NOTICE 'Rollback preflight: parse_jobs=% vendor_aliases=% parse_corrections=% rows (dropping regardless)',
    pj_count, va_count, pc_count;
END
$rollback_preflight$;

-- ── Drop policies (explicit) ────────────────────────────────────────────────
DROP POLICY IF EXISTS parse_corrections_tenant_write ON public.parse_corrections;
DROP POLICY IF EXISTS parse_corrections_tenant_read  ON public.parse_corrections;

DROP POLICY IF EXISTS vendor_aliases_tenant_update ON public.vendor_aliases;
DROP POLICY IF EXISTS vendor_aliases_tenant_write  ON public.vendor_aliases;
DROP POLICY IF EXISTS vendor_aliases_tenant_read   ON public.vendor_aliases;

DROP POLICY IF EXISTS parse_jobs_tenant_update ON public.parse_jobs;
DROP POLICY IF EXISTS parse_jobs_tenant_write  ON public.parse_jobs;
DROP POLICY IF EXISTS parse_jobs_tenant_read   ON public.parse_jobs;

-- ── Drop indexes (explicit; DROP TABLE would cascade, but this is auditable) ─
DROP INDEX IF EXISTS public.parse_corrections_job_idx;
DROP INDEX IF EXISTS public.parse_corrections_tenant_idx;

DROP INDEX IF EXISTS public.vendor_aliases_lookup_idx;
DROP INDEX IF EXISTS public.vendor_aliases_tenant_idx;

DROP INDEX IF EXISTS public.parse_jobs_hash_idx;
DROP INDEX IF EXISTS public.parse_jobs_routing_idx;
DROP INDEX IF EXISTS public.parse_jobs_status_idx;
DROP INDEX IF EXISTS public.parse_jobs_owner_idx;
DROP INDEX IF EXISTS public.parse_jobs_tenant_idx;

-- ── Drop tables (reverse FK order) ──────────────────────────────────────────
DROP TABLE IF EXISTS public.parse_corrections;
DROP TABLE IF EXISTS public.vendor_aliases;
DROP TABLE IF EXISTS public.parse_jobs;

COMMIT;
