-- Rollback for 2026_04_21_rebuild_receipt_pipeline.sql
-- Drops policies, tables in reverse dependency order.
-- Safe to re-run (IF EXISTS everywhere).

BEGIN;

-- parse_corrections
DROP POLICY IF EXISTS parse_corrections_tenant_write ON public.parse_corrections;
DROP POLICY IF EXISTS parse_corrections_tenant_read  ON public.parse_corrections;

DROP INDEX IF EXISTS public.parse_corrections_job_idx;
DROP INDEX IF EXISTS public.parse_corrections_tenant_idx;

DROP TABLE IF EXISTS public.parse_corrections;

-- vendor_aliases
DROP POLICY IF EXISTS vendor_aliases_tenant_update ON public.vendor_aliases;
DROP POLICY IF EXISTS vendor_aliases_tenant_write  ON public.vendor_aliases;
DROP POLICY IF EXISTS vendor_aliases_tenant_read   ON public.vendor_aliases;

DROP INDEX IF EXISTS public.vendor_aliases_lookup_idx;
DROP INDEX IF EXISTS public.vendor_aliases_tenant_idx;

DROP TABLE IF EXISTS public.vendor_aliases;

-- parse_jobs
DROP POLICY IF EXISTS parse_jobs_tenant_update ON public.parse_jobs;
DROP POLICY IF EXISTS parse_jobs_tenant_write  ON public.parse_jobs;
DROP POLICY IF EXISTS parse_jobs_tenant_read   ON public.parse_jobs;

DROP INDEX IF EXISTS public.parse_jobs_hash_idx;
DROP INDEX IF EXISTS public.parse_jobs_routing_idx;
DROP INDEX IF EXISTS public.parse_jobs_status_idx;
DROP INDEX IF EXISTS public.parse_jobs_owner_idx;
DROP INDEX IF EXISTS public.parse_jobs_tenant_idx;

DROP TABLE IF EXISTS public.parse_jobs;

COMMIT;
