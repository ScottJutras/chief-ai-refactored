-- Rollback for 2026_04_22_rebuild_mileage_logs.sql
-- Safe to re-run (IF EXISTS everywhere).

BEGIN;

DROP POLICY IF EXISTS mileage_logs_tenant_update ON public.mileage_logs;
DROP POLICY IF EXISTS mileage_logs_tenant_insert ON public.mileage_logs;
DROP POLICY IF EXISTS mileage_logs_tenant_select ON public.mileage_logs;

DROP INDEX IF EXISTS public.mileage_logs_employee_idx;
DROP INDEX IF EXISTS public.mileage_logs_job_idx;
DROP INDEX IF EXISTS public.mileage_logs_owner_date_idx;
DROP INDEX IF EXISTS public.mileage_logs_tenant_date_idx;
DROP INDEX IF EXISTS public.mileage_logs_owner_source_msg_unique_idx;

DROP TABLE IF EXISTS public.mileage_logs;

COMMIT;
