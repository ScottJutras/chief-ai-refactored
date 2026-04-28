-- Rollback for 2026_04_22_rebuild_tasks.sql
-- Safe to re-run (IF EXISTS everywhere).

BEGIN;

DROP POLICY IF EXISTS tasks_tenant_update ON public.tasks;
DROP POLICY IF EXISTS tasks_tenant_insert ON public.tasks;
DROP POLICY IF EXISTS tasks_tenant_select ON public.tasks;

DROP INDEX IF EXISTS public.tasks_deleted_idx;
DROP INDEX IF EXISTS public.tasks_correlation_idx;
DROP INDEX IF EXISTS public.tasks_job_idx;
DROP INDEX IF EXISTS public.tasks_assignee_ingestion_idx;
DROP INDEX IF EXISTS public.tasks_assignee_due_idx;
DROP INDEX IF EXISTS public.tasks_tenant_status_idx;
DROP INDEX IF EXISTS public.tasks_owner_source_msg_unique_idx;

DROP TABLE IF EXISTS public.tasks;

COMMIT;
