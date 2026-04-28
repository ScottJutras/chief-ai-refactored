-- Rollback for 2026_04_21_rebuild_jobs_spine.sql
-- Drops tables in reverse dependency order. Safe to re-run (IF EXISTS everywhere).
--
-- Also drops the deferred FKs the migration added on transactions and users,
-- so the tables survive without dangling FKs pointing at dropped jobs.
--
-- WARNING: chiefos_tenant_counters is shared infrastructure; dropping it here
-- rolls back the first migration that introduced it. If quotes/tasks counters
-- are already in use, this DROP will fail due to FK back-references or data.

BEGIN;

-- job_photo_shares
DROP POLICY IF EXISTS job_photo_shares_tenant_insert ON public.job_photo_shares;
DROP POLICY IF EXISTS job_photo_shares_tenant_select ON public.job_photo_shares;

DROP INDEX IF EXISTS public.job_photo_shares_expiry_idx;
DROP INDEX IF EXISTS public.job_photo_shares_tenant_job_idx;

DROP TABLE IF EXISTS public.job_photo_shares;

-- job_photos
DROP POLICY IF EXISTS job_photos_tenant_delete ON public.job_photos;
DROP POLICY IF EXISTS job_photos_tenant_insert ON public.job_photos;
DROP POLICY IF EXISTS job_photos_tenant_select ON public.job_photos;

DROP INDEX IF EXISTS public.job_photos_source_msg_idx;
DROP INDEX IF EXISTS public.job_photos_tenant_job_idx;

DROP TABLE IF EXISTS public.job_photos;

-- job_phases
DROP POLICY IF EXISTS job_phases_tenant_delete ON public.job_phases;
DROP POLICY IF EXISTS job_phases_tenant_update ON public.job_phases;
DROP POLICY IF EXISTS job_phases_tenant_insert ON public.job_phases;
DROP POLICY IF EXISTS job_phases_tenant_select ON public.job_phases;

DROP INDEX IF EXISTS public.job_phases_active_idx;
DROP INDEX IF EXISTS public.job_phases_tenant_job_idx;

DROP TABLE IF EXISTS public.job_phases;

-- Drop deferred FKs wired by the jobs-spine migration (on tables from Session 1)
ALTER TABLE IF EXISTS public.users
  DROP CONSTRAINT IF EXISTS users_auto_assign_active_job_fk;
ALTER TABLE IF EXISTS public.transactions
  DROP CONSTRAINT IF EXISTS transactions_job_fk;

-- jobs
DROP POLICY IF EXISTS jobs_owner_board_delete ON public.jobs;
DROP POLICY IF EXISTS jobs_tenant_update ON public.jobs;
DROP POLICY IF EXISTS jobs_tenant_insert ON public.jobs;
DROP POLICY IF EXISTS jobs_tenant_select ON public.jobs;

DROP INDEX IF EXISTS public.jobs_deleted_idx;
DROP INDEX IF EXISTS public.jobs_owner_status_idx;
DROP INDEX IF EXISTS public.jobs_tenant_status_idx;
DROP INDEX IF EXISTS public.jobs_owner_source_msg_unique_idx;

DROP TABLE IF EXISTS public.jobs;

-- chiefos_tenant_counters (shared infrastructure; rolls back only if no downstream data depends on it)
DROP POLICY IF EXISTS chiefos_tenant_counters_tenant_read ON public.chiefos_tenant_counters;

DROP TABLE IF EXISTS public.chiefos_tenant_counters;

COMMIT;
