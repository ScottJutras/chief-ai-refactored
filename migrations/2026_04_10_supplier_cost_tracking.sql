-- migrations/2026_04_10_supplier_cost_tracking.sql
-- Phase 2.4: Expense-to-supplier linking + price tracking over time
-- Applied via Supabase MCP 2026-04-10

-- ── 1. Add supplier_id FK to transactions ────────────────────────────────────

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES public.suppliers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_supplier
  ON public.transactions (owner_id, supplier_id)
  WHERE supplier_id IS NOT NULL;

-- ── 2. Auto-link trigger: match source text → known supplier on INSERT ────────
-- Fires BEFORE INSERT; only for expenses where supplier_id is not already set.
-- Matches when the transaction source contains the supplier name or vice versa.
-- Prefers the longest (most specific) matching supplier name.

CREATE OR REPLACE FUNCTION auto_link_transaction_supplier()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.kind = 'expense'
     AND NEW.supplier_id IS NULL
     AND NEW.source IS NOT NULL
     AND LENGTH(TRIM(NEW.source)) > 0
  THEN
    SELECT id
      INTO NEW.supplier_id
      FROM public.suppliers
     WHERE is_active = true
       AND (
         LOWER(TRIM(NEW.source)) ILIKE '%' || LOWER(TRIM(name)) || '%'
         OR LOWER(TRIM(name)) ILIKE '%' || LOWER(TRIM(NEW.source)) || '%'
       )
     ORDER BY LENGTH(name) DESC
     LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auto_link_supplier ON public.transactions;
CREATE TRIGGER trg_auto_link_supplier
  BEFORE INSERT ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION auto_link_transaction_supplier();

-- ── 3. Backfill supplier_id on existing expense transactions ─────────────────
UPDATE public.transactions t
   SET supplier_id = (
     SELECT s.id
       FROM public.suppliers s
      WHERE s.is_active = true
        AND (
          LOWER(TRIM(t.source)) ILIKE '%' || LOWER(TRIM(s.name)) || '%'
          OR LOWER(TRIM(s.name)) ILIKE '%' || LOWER(TRIM(t.source)) || '%'
        )
      ORDER BY LENGTH(s.name) DESC
      LIMIT 1
   )
 WHERE t.kind = 'expense'
   AND t.supplier_id IS NULL
   AND t.source IS NOT NULL
   AND LENGTH(TRIM(t.source)) > 0;
