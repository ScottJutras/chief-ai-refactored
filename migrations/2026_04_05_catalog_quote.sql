-- migrations/2026_04_05_catalog_quote.sql
-- Add catalog traceability columns to quote_line_items.
-- catalog_product_id: references the catalog product (no FK — snapshot is intentionally frozen)
-- catalog_snapshot: frozen copy of product details at time of quote (price may change after)

ALTER TABLE public.quote_line_items
  ADD COLUMN IF NOT EXISTS catalog_product_id UUID DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS catalog_snapshot    JSONB DEFAULT NULL;

COMMENT ON COLUMN public.quote_line_items.catalog_product_id IS
  'UUID of the catalog_products row this line item was priced from. No FK — price is frozen in snapshot.';

COMMENT ON COLUMN public.quote_line_items.catalog_snapshot IS
  'Frozen copy of catalog product details at quote creation time: {product_id, sku, supplier, name, unit_price_cents, price_as_of, freshness}.';
