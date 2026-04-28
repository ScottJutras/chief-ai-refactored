-- Rollback for 2026_04_22_rebuild_financial_observability.sql
-- Safe to re-run (IF EXISTS everywhere).

BEGIN;

-- error_logs
DROP POLICY IF EXISTS error_logs_tenant_select ON public.error_logs;

DROP INDEX IF EXISTS public.error_logs_trace_idx;
DROP INDEX IF EXISTS public.error_logs_code_time_idx;
DROP INDEX IF EXISTS public.error_logs_tenant_time_idx;

DROP TABLE IF EXISTS public.error_logs;

-- llm_cost_log
DROP POLICY IF EXISTS llm_cost_log_tenant_select ON public.llm_cost_log;

DROP INDEX IF EXISTS public.llm_cost_log_provider_model_idx;
DROP INDEX IF EXISTS public.llm_cost_log_feature_kind_idx;
DROP INDEX IF EXISTS public.llm_cost_log_tenant_month_idx;

DROP TABLE IF EXISTS public.llm_cost_log;

-- stripe_events (no policies; no authenticated grants)
DROP INDEX IF EXISTS public.stripe_events_status_idx;
DROP INDEX IF EXISTS public.stripe_events_tenant_received_idx;
DROP INDEX IF EXISTS public.stripe_events_received_idx;

DROP TABLE IF EXISTS public.stripe_events;

COMMIT;
