-- migrations/2026_04_04_email_ingest.sql
-- Email ingestion: capture token per tenant + audit/dedup table.
-- Idempotent. Run once.

-- ── Capture token on tenants ─────────────────────────────────────────────────

ALTER TABLE public.chiefos_tenants
  ADD COLUMN IF NOT EXISTS email_capture_token text;

CREATE UNIQUE INDEX IF NOT EXISTS chiefos_tenants_capture_token_idx
  ON public.chiefos_tenants (email_capture_token)
  WHERE email_capture_token IS NOT NULL;

-- Backfill tokens for existing tenants (random 16-char hex)
UPDATE public.chiefos_tenants
SET email_capture_token = lower(encode(gen_random_bytes(8), 'hex'))
WHERE email_capture_token IS NULL;

-- ── email_ingest_events ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.email_ingest_events (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL,
  owner_id            text        NOT NULL,
  postmark_msg_id     text        NOT NULL,         -- Postmark MessageID, dedup key
  from_email          text,
  subject             text,
  detected_kind       text        DEFAULT 'unknown', -- expense | lead | unknown
  attachment_count    integer     DEFAULT 0,
  processing_status   text        DEFAULT 'received', -- received | processed | failed | quota_exceeded
  source_type         text        DEFAULT 'forwarded_receipt', -- forwarded_receipt | lead_form
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (postmark_msg_id)
);

CREATE INDEX IF NOT EXISTS email_ingest_tenant_idx ON public.email_ingest_events (tenant_id);
CREATE INDEX IF NOT EXISTS email_ingest_owner_month_idx ON public.email_ingest_events (owner_id, created_at);

-- RLS: tenant members can read their own events
ALTER TABLE public.email_ingest_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'email_ingest_events' AND policyname = 'email_ingest_tenant_read'
  ) THEN
    CREATE POLICY email_ingest_tenant_read
      ON public.email_ingest_events
      FOR SELECT
      USING (
        tenant_id IN (
          SELECT tenant_id FROM public.chiefos_portal_users
          WHERE user_id = auth.uid()
        )
      );
  END IF;
END $$;
