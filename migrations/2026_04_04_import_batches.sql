-- migrations/2026_04_04_import_batches.sql
-- Bulk import audit table + FK columns on transactions + time_entries_v2.
-- Idempotent. Run once.

-- ── import_batches ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.import_batches (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL,
  owner_id     text        NOT NULL,
  kind         text        NOT NULL CHECK (kind IN ('expense', 'revenue', 'time')),
  row_count    integer     NOT NULL DEFAULT 0,
  source_file  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS import_batches_tenant_idx
  ON public.import_batches (tenant_id);

CREATE INDEX IF NOT EXISTS import_batches_owner_idx
  ON public.import_batches (owner_id);

-- RLS: tenant members can read their own batches
ALTER TABLE public.import_batches ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'import_batches' AND policyname = 'import_batches_tenant_read'
  ) THEN
    CREATE POLICY import_batches_tenant_read
      ON public.import_batches
      FOR SELECT
      USING (
        tenant_id IN (
          SELECT tenant_id FROM public.chiefos_portal_users
          WHERE user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- ── FK columns ───────────────────────────────────────────────────────────────

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS import_batch_id uuid
    REFERENCES public.import_batches (id)
    ON DELETE SET NULL;

ALTER TABLE public.time_entries_v2
  ADD COLUMN IF NOT EXISTS import_batch_id uuid
    REFERENCES public.import_batches (id)
    ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS transactions_import_batch_idx
  ON public.transactions (import_batch_id)
  WHERE import_batch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS time_entries_import_batch_idx
  ON public.time_entries_v2 (import_batch_id)
  WHERE import_batch_id IS NOT NULL;
