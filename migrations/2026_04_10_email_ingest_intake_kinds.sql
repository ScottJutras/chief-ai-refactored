-- migrations/2026_04_10_email_ingest_intake_kinds.sql
-- Add email_batch kind to intake_batches and email_lead kind to intake_items.
-- Required by the email ingest webhook (routes/emailIngest.js).
-- Applied via Supabase MCP 2026-04-10

-- ── intake_batches.kind ───────────────────────────────────────────────────────
ALTER TABLE public.intake_batches
  DROP CONSTRAINT IF EXISTS intake_batches_kind_check;

ALTER TABLE public.intake_batches
  ADD CONSTRAINT intake_batches_kind_check
  CHECK (kind = ANY (ARRAY[
    'receipt_image_batch'::text,
    'voice_batch'::text,
    'pdf_batch'::text,
    'mixed_batch'::text,
    'email_batch'::text
  ]));

-- ── intake_items.kind ─────────────────────────────────────────────────────────
ALTER TABLE public.intake_items
  DROP CONSTRAINT IF EXISTS intake_items_kind_check;

ALTER TABLE public.intake_items
  ADD CONSTRAINT intake_items_kind_check
  CHECK (kind = ANY (ARRAY[
    'receipt_image'::text,
    'voice_note'::text,
    'pdf_document'::text,
    'unknown'::text,
    'email_lead'::text
  ]));

-- ── intake_items: source_email_id for email-origin traceability ───────────────
ALTER TABLE public.intake_items
  ADD COLUMN IF NOT EXISTS source_email_id TEXT;   -- postmark_msg_id reference

CREATE INDEX IF NOT EXISTS idx_intake_items_source_email
  ON public.intake_items (source_email_id)
  WHERE source_email_id IS NOT NULL;
