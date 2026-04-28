-- Rollback for 2026_04_22_amendment_pricing_items.sql
-- Safe to re-run (IF EXISTS everywhere).

BEGIN;

DROP POLICY IF EXISTS pricing_items_tenant_update ON public.pricing_items;
DROP POLICY IF EXISTS pricing_items_tenant_insert ON public.pricing_items;
DROP POLICY IF EXISTS pricing_items_tenant_select ON public.pricing_items;

DROP INDEX IF EXISTS public.pricing_items_tenant_active_idx;
DROP INDEX IF EXISTS public.pricing_items_owner_source_msg_unique_idx;
DROP INDEX IF EXISTS public.pricing_items_owner_name_active_unique_idx;

DROP TABLE IF EXISTS public.pricing_items;

COMMIT;
