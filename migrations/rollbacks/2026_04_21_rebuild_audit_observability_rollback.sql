-- Rollback for 2026_04_21_rebuild_audit_observability.sql
-- Drops tables in reverse dependency order. Safe to re-run (IF EXISTS everywhere).

BEGIN;

-- chiefos_role_audit
DROP POLICY IF EXISTS chiefos_role_audit_owner_select ON public.chiefos_role_audit;

DROP INDEX IF EXISTS public.chiefos_role_audit_correlation_idx;
DROP INDEX IF EXISTS public.chiefos_role_audit_target_idx;
DROP INDEX IF EXISTS public.chiefos_role_audit_tenant_created_idx;

DROP TABLE IF EXISTS public.chiefos_role_audit;

-- integrity_verification_log
DROP POLICY IF EXISTS integrity_verification_log_tenant_select ON public.integrity_verification_log;

DROP INDEX IF EXISTS public.integrity_verification_log_failed_idx;
DROP INDEX IF EXISTS public.integrity_verification_log_tenant_created_idx;

DROP TABLE IF EXISTS public.integrity_verification_log;

-- email_ingest_events
DROP POLICY IF EXISTS email_ingest_events_tenant_update ON public.email_ingest_events;
DROP POLICY IF EXISTS email_ingest_events_tenant_select ON public.email_ingest_events;

DROP INDEX IF EXISTS public.email_ingest_events_processing_idx;
DROP INDEX IF EXISTS public.email_ingest_events_owner_created_idx;
DROP INDEX IF EXISTS public.email_ingest_events_tenant_created_idx;

DROP TABLE IF EXISTS public.email_ingest_events;

-- chiefos_deletion_batches
DROP POLICY IF EXISTS chiefos_deletion_batches_tenant_update ON public.chiefos_deletion_batches;
DROP POLICY IF EXISTS chiefos_deletion_batches_tenant_insert ON public.chiefos_deletion_batches;
DROP POLICY IF EXISTS chiefos_deletion_batches_tenant_select ON public.chiefos_deletion_batches;

DROP INDEX IF EXISTS public.chiefos_deletion_batches_correlation_idx;
DROP INDEX IF EXISTS public.chiefos_deletion_batches_undo_expiry_idx;
DROP INDEX IF EXISTS public.chiefos_deletion_batches_tenant_created_idx;

DROP TABLE IF EXISTS public.chiefos_deletion_batches;

-- chiefos_activity_logs
DROP POLICY IF EXISTS chiefos_activity_logs_tenant_select ON public.chiefos_activity_logs;

DROP INDEX IF EXISTS public.chiefos_activity_logs_actor_user_idx;
DROP INDEX IF EXISTS public.chiefos_activity_logs_portal_user_idx;
DROP INDEX IF EXISTS public.chiefos_activity_logs_correlation_idx;
DROP INDEX IF EXISTS public.chiefos_activity_logs_target_idx;
DROP INDEX IF EXISTS public.chiefos_activity_logs_tenant_time_idx;

DROP TABLE IF EXISTS public.chiefos_activity_logs;

COMMIT;
