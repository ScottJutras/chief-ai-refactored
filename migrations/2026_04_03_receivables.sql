-- Migration: Receivables intelligence
-- Phase 3.3 — adds payment_status tracking to transactions
-- and a receivables aging view for invoice follow-up automation.

-- ── Payment status on transactions ──────────────────────────────────────────

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS payment_status       text DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'paid', 'partial', 'written_off')),
  ADD COLUMN IF NOT EXISTS payment_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS customer_ref         text;  -- customer name or reference

-- Default existing revenue transactions to 'pending' (historical data)
-- Operators can mark them paid via "mark job 7 paid" command.

-- Index for aging queries
CREATE INDEX IF NOT EXISTS transactions_payment_status_idx
  ON public.transactions (owner_id, payment_status, date)
  WHERE kind = 'revenue';

-- ── Receivables aging view ───────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.receivables_aging AS
SELECT
  t.id,
  t.owner_id,
  t.job_id,
  j.name                                             AS job_name,
  j.job_no,
  t.amount_cents,
  t.date                                             AS revenue_date,
  t.customer_ref,
  t.payment_status,
  t.payment_confirmed_at,
  NOW()::date - t.date                               AS days_outstanding,
  CASE
    WHEN NOW()::date - t.date <= 30  THEN 'current'
    WHEN NOW()::date - t.date <= 60  THEN '31-60'
    WHEN NOW()::date - t.date <= 90  THEN '61-90'
    ELSE '90+'
  END                                                AS aging_bucket
FROM public.transactions t
LEFT JOIN public.jobs j ON j.id = t.job_id
WHERE t.kind           = 'revenue'
  AND t.payment_status IN ('pending', 'partial');

-- ── Fast-path WhatsApp command support ──────────────────────────────────────
-- "revenue $4200 job 7 paid" / "mark job 7 revenue paid"
-- These are handled in the NLP layer; this migration just ensures the column exists.

COMMENT ON COLUMN public.transactions.payment_status IS
  'Receivables status for revenue transactions. Set via WhatsApp: "mark job 7 paid" or "revenue 4200 job 7 paid".';
