-- Rollback for 2026_04_22_amendment_reminders_and_insight_log.sql
-- Safe to re-run (IF EXISTS everywhere).

BEGIN;

-- insight_log
DROP POLICY IF EXISTS insight_log_tenant_update ON public.insight_log;
DROP POLICY IF EXISTS insight_log_tenant_select ON public.insight_log;

DROP INDEX IF EXISTS public.insight_log_unack_critical_idx;
DROP INDEX IF EXISTS public.insight_log_tenant_created_idx;

DROP TABLE IF EXISTS public.insight_log;

-- reminders
DROP POLICY IF EXISTS reminders_tenant_update ON public.reminders;
DROP POLICY IF EXISTS reminders_tenant_select ON public.reminders;

DROP INDEX IF EXISTS public.reminders_correlation_idx;
DROP INDEX IF EXISTS public.reminders_owner_user_due_idx;
DROP INDEX IF EXISTS public.reminders_due_pending_idx;
DROP INDEX IF EXISTS public.reminders_owner_source_msg_unique_idx;

DROP TABLE IF EXISTS public.reminders;

COMMIT;
