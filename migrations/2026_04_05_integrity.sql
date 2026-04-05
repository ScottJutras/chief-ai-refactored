-- ============================================================
-- ChiefOS Cryptographic Record Integrity System
-- Migration: 2026_04_05_integrity
-- Applied via Supabase MCP 2026-04-05
-- ============================================================

-- Add hash columns to public.transactions
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS record_hash TEXT,
  ADD COLUMN IF NOT EXISTS previous_hash TEXT,
  ADD COLUMN IF NOT EXISTS hash_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS hash_input_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS superseded_by UUID,
  ADD COLUMN IF NOT EXISTS edit_of UUID,
  ADD COLUMN IF NOT EXISTS edited_by TEXT;

-- Add hash columns to public.time_entries_v2
ALTER TABLE public.time_entries_v2
  ADD COLUMN IF NOT EXISTS record_hash TEXT,
  ADD COLUMN IF NOT EXISTS previous_hash TEXT,
  ADD COLUMN IF NOT EXISTS hash_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS hash_input_snapshot JSONB;

-- Chain traversal index: find latest hashed record for a tenant fast
CREATE INDEX IF NOT EXISTS idx_transactions_tenant_chain
  ON public.transactions(tenant_id, created_at DESC)
  WHERE record_hash IS NOT NULL;

-- Lookup index: find record by hash (for verification)
CREATE INDEX IF NOT EXISTS idx_transactions_record_hash
  ON public.transactions(record_hash)
  WHERE record_hash IS NOT NULL;

-- Chain traversal index for time entries
CREATE INDEX IF NOT EXISTS idx_time_entries_owner_chain
  ON public.time_entries_v2(owner_id, created_at DESC)
  WHERE record_hash IS NOT NULL;

-- Verification audit log
CREATE TABLE IF NOT EXISTS public.integrity_verification_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  table_name TEXT NOT NULL,
  verification_type TEXT NOT NULL,
  total_records_checked INTEGER NOT NULL DEFAULT 0,
  records_valid INTEGER NOT NULL DEFAULT 0,
  records_invalid INTEGER NOT NULL DEFAULT 0,
  records_unhashed INTEGER NOT NULL DEFAULT 0,
  first_invalid_record_id UUID,
  invalid_details JSONB DEFAULT '[]',
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_integrity_log_tenant
  ON public.integrity_verification_log(tenant_id, created_at DESC);
