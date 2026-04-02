-- Add tax_amount_cents to overhead_items
-- Stores the tax amount per occurrence at the item's stated frequency
ALTER TABLE overhead_items ADD COLUMN IF NOT EXISTS tax_amount_cents bigint DEFAULT NULL;
