-- Migration: insight_log table
-- Foundation for all proactive intelligence features.
-- Tracks every outbound insight/alert sent to owners — prevents re-sends and provides audit trail.

CREATE TABLE IF NOT EXISTS public.insight_log (
  id               bigserial     PRIMARY KEY,
  tenant_id        uuid          NOT NULL,
  owner_id         text          NOT NULL,
  kind             text          NOT NULL,  -- 'weekly_digest' | 'margin_alert' | 'anomaly' | 'daily_summary' | etc.
  signal_key       text,                    -- dedup key, e.g. 'weekly_digest_2026_16' or 'margin_alert_job_42_2026_04'
  payload          jsonb,                   -- structured data used to generate the message
  message_text     text,                    -- the actual text that was sent
  sent_at          timestamptz   NOT NULL DEFAULT now(),
  acknowledged_at  timestamptz,             -- set when user taps 'Got it' or replies
  UNIQUE (owner_id, signal_key)             -- prevents re-sending the same alert
);

CREATE INDEX IF NOT EXISTS insight_log_owner_idx
  ON public.insight_log (owner_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS insight_log_kind_idx
  ON public.insight_log (kind, sent_at DESC);

CREATE INDEX IF NOT EXISTS insight_log_tenant_idx
  ON public.insight_log (tenant_id, sent_at DESC);

-- RLS: tenants can read their own insight log via portal
ALTER TABLE public.insight_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "insight_log_tenant_read" ON public.insight_log
  FOR SELECT USING (
    tenant_id IN (
      SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()
    )
  );

-- Service role (backend workers) bypasses RLS — no INSERT policy needed for server-side writes
