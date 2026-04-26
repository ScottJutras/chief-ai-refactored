-- ============================================================================
-- Foundation Rebuild — Session P3-3b, Part 4: Financial observability
--
-- Section 3.12 of FOUNDATION_P1_SCHEMA_DESIGN.md.
--
-- Creates:
--   1. stripe_events   — Stripe webhook idempotency + audit log (service-role only)
--   2. llm_cost_log    — per-LLM-call cost/usage tracking (append-only)
--   3. error_logs      — backend error log (append-only; tenant-scoped reads)
--
-- Append-only enforcement:
--   - stripe_events: UPDATE restricted to status/processed_at/error_message
--     transitions; trigger in Session P3-4.
--   - llm_cost_log: UPDATE + DELETE blocked; trigger in Session P3-4.
--   - error_logs: UPDATE + DELETE blocked; trigger in Session P3-4.
--
-- This migration ships the tables + GRANT posture; hard triggers are P3-4.
--
-- Dependencies:
--   - public.chiefos_tenants (Session P3-1)
--   - public.chiefos_portal_users (Session P3-1) — for RLS
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_tenants') THEN
    RAISE EXCEPTION 'Requires public.chiefos_tenants';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_portal_users') THEN
    RAISE EXCEPTION 'Requires public.chiefos_portal_users';
  END IF;
END
$preflight$;

-- ============================================================================
-- 1. stripe_events — Stripe webhook log (service-role only)
--
-- PK is the Stripe event id itself (evt_*) — natural key gives idempotency
-- for free. No FKs (Stripe may arrive before our mirrored rows).
-- tenant_id + owner_id nullable (account-level events don't resolve).
-- No authenticated GRANTs — portal should not read Stripe payloads directly.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.stripe_events (
  stripe_event_id   text         PRIMARY KEY,
  event_type        text         NOT NULL,
  tenant_id         uuid,
  owner_id          text,
  payload           jsonb        NOT NULL,
  signature         text         NOT NULL,
  received_at       timestamptz  NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  status            text         NOT NULL DEFAULT 'received',
  error_message     text,
  correlation_id    uuid         NOT NULL DEFAULT gen_random_uuid(),
  CONSTRAINT stripe_events_stripe_event_id_nonempty CHECK (char_length(stripe_event_id) > 0),
  CONSTRAINT stripe_events_event_type_nonempty CHECK (char_length(event_type) > 0),
  CONSTRAINT stripe_events_signature_nonempty CHECK (char_length(signature) > 0),
  CONSTRAINT stripe_events_status_chk
    CHECK (status IN ('received','processed','failed','skipped')),
  -- processed iff processed_at set
  CONSTRAINT stripe_events_processed_iff_timestamp
    CHECK ((status = 'processed') = (processed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS stripe_events_received_idx
  ON public.stripe_events (received_at DESC);
CREATE INDEX IF NOT EXISTS stripe_events_tenant_received_idx
  ON public.stripe_events (tenant_id, received_at DESC)
  WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stripe_events_status_idx
  ON public.stripe_events (status, received_at)
  WHERE status IN ('received','failed');

-- RLS enabled for defense in depth; no policies since authenticated has no grants.
ALTER TABLE public.stripe_events ENABLE ROW LEVEL SECURITY;

-- No authenticated grants. service_role only.
GRANT SELECT, INSERT, UPDATE ON public.stripe_events TO service_role;

COMMENT ON TABLE public.stripe_events IS
  'Stripe webhook idempotency + audit log. PK is Stripe''s evt_* id (natural idempotency). Service-role only — portal does not read Stripe payloads directly (billing view reads users.sub_status). Append-only on payload/signature/received_at; status transitions allowed. Hard UPDATE-constraint trigger deferred to Session P3-4.';

-- ============================================================================
-- 2. llm_cost_log — per-LLM-call cost tracking (append-only)
--
-- High-volume observability table. Unified feature_kind enum with quota
-- architecture (quota_allotments.feature_kind). tenant_id + owner_id nullable.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.llm_cost_log (
  id                   uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid
    REFERENCES public.chiefos_tenants(id) ON DELETE SET NULL,
  owner_id             text,
  feature_kind         text         NOT NULL,
  provider             text         NOT NULL,
  model                text         NOT NULL,
  input_tokens         integer      NOT NULL DEFAULT 0,
  output_tokens        integer      NOT NULL DEFAULT 0,
  cache_read_tokens    integer      NOT NULL DEFAULT 0,
  cache_write_tokens   integer      NOT NULL DEFAULT 0,
  latency_ms           integer      NOT NULL DEFAULT 0,
  cost_cents           bigint       NOT NULL DEFAULT 0,
  trace_id             text,
  correlation_id       uuid,
  created_at           timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT llm_cost_log_provider_chk
    CHECK (provider IN ('anthropic','openai','google')),
  CONSTRAINT llm_cost_log_feature_kind_format
    CHECK (feature_kind ~ '^[a-z][a-z_]*$' AND char_length(feature_kind) BETWEEN 1 AND 64),
  CONSTRAINT llm_cost_log_model_nonempty CHECK (char_length(model) > 0),
  CONSTRAINT llm_cost_log_input_tokens_nonneg CHECK (input_tokens >= 0),
  CONSTRAINT llm_cost_log_output_tokens_nonneg CHECK (output_tokens >= 0),
  CONSTRAINT llm_cost_log_cache_read_nonneg CHECK (cache_read_tokens >= 0),
  CONSTRAINT llm_cost_log_cache_write_nonneg CHECK (cache_write_tokens >= 0),
  CONSTRAINT llm_cost_log_latency_nonneg CHECK (latency_ms >= 0),
  CONSTRAINT llm_cost_log_cost_nonneg CHECK (cost_cents >= 0)
);

CREATE INDEX IF NOT EXISTS llm_cost_log_tenant_month_idx
  ON public.llm_cost_log (tenant_id, created_at DESC)
  WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS llm_cost_log_feature_kind_idx
  ON public.llm_cost_log (feature_kind, created_at DESC);
CREATE INDEX IF NOT EXISTS llm_cost_log_provider_model_idx
  ON public.llm_cost_log (provider, model, created_at DESC);

ALTER TABLE public.llm_cost_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='llm_cost_log'
                   AND policyname='llm_cost_log_tenant_select') THEN
    -- Tenant-scoped read; null-tenant rows service-role only.
    CREATE POLICY llm_cost_log_tenant_select
      ON public.llm_cost_log FOR SELECT
      USING (tenant_id IS NOT NULL AND tenant_id IN
             (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

-- Append-only: no UPDATE or DELETE to any role beyond service_role.
-- service_role gets SELECT + INSERT only (no UPDATE/DELETE); P3-4 trigger enforces.
GRANT SELECT ON public.llm_cost_log TO authenticated;
GRANT SELECT, INSERT ON public.llm_cost_log TO service_role;

COMMENT ON TABLE public.llm_cost_log IS
  'Per-LLM-call cost + usage tracking. High-volume; retention 90 days rolling (rollup is Plan V2 Session 16). Append-only: service_role gets SELECT+INSERT only. Hard UPDATE/DELETE trigger deferred to Session P3-4.';
COMMENT ON COLUMN public.llm_cost_log.feature_kind IS
  'Unified with quota_allotments.feature_kind. Format-enforced; product-concept registry in app-code.';
COMMENT ON COLUMN public.llm_cost_log.cost_cents IS
  'Unified with cents-based financial spine (changed from cost_usd numeric in pre-rebuild).';

-- ============================================================================
-- 3. error_logs — backend error log (append-only; tenant-scoped reads)
--
-- No FKs (log must succeed even when tenant/owner resolution failed).
-- tenant_id nullable. trace_id NOT NULL per Constitution §9.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.error_logs (
  id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid,
  owner_id            text,
  user_id             text,
  error_code          text         NOT NULL,
  error_message       text         NOT NULL,
  error_stack         jsonb,
  context             jsonb,
  from_user           text,
  request_id          text,
  trace_id            text         NOT NULL,
  correlation_id      uuid,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT error_logs_trace_id_nonempty CHECK (char_length(trace_id) > 0),
  CONSTRAINT error_logs_error_code_nonempty CHECK (char_length(error_code) > 0),
  CONSTRAINT error_logs_error_message_nonempty CHECK (char_length(error_message) > 0)
);

CREATE INDEX IF NOT EXISTS error_logs_tenant_time_idx
  ON public.error_logs (tenant_id, created_at DESC)
  WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS error_logs_code_time_idx
  ON public.error_logs (error_code, created_at DESC);
CREATE INDEX IF NOT EXISTS error_logs_trace_idx
  ON public.error_logs (trace_id);

ALTER TABLE public.error_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='error_logs'
                   AND policyname='error_logs_tenant_select') THEN
    -- Tenant members see rows for their tenant; null-tenant rows are
    -- service-role only (system errors pre-auth / pre-tenant-resolution).
    CREATE POLICY error_logs_tenant_select
      ON public.error_logs FOR SELECT
      USING (
        tenant_id IS NOT NULL AND tenant_id IN
        (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid())
      );
  END IF;
END $$;

-- Append-only
GRANT SELECT ON public.error_logs TO authenticated;
GRANT SELECT, INSERT ON public.error_logs TO service_role;

COMMENT ON TABLE public.error_logs IS
  'Backend error log per Constitution §9. trace_id mandatory. No FKs — error logs must succeed even when tenant/owner resolution failed. Retention 30 days rolling. Append-only: service_role SELECT+INSERT only; hard UPDATE/DELETE trigger deferred to Session P3-4.';
COMMENT ON COLUMN public.error_logs.error_stack IS
  'Developer-side stack trace as structured jsonb (e.g., {"frames":[{"file":"...","line":N,"fn":"..."}]}). Never exposed to users directly.';

COMMIT;
