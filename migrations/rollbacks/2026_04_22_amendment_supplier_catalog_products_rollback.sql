-- Rollback for 2026_04_22_amendment_supplier_catalog_products.sql
-- Drops 3 tables in reverse dependency order. Safe to re-run.

BEGIN;

-- catalog_ingestion_log
DROP POLICY IF EXISTS catalog_ingestion_log_supplier_portal_select ON public.catalog_ingestion_log;

DROP INDEX IF EXISTS public.catalog_ingestion_log_status_idx;
DROP INDEX IF EXISTS public.catalog_ingestion_log_supplier_created_idx;

DROP TABLE IF EXISTS public.catalog_ingestion_log;

-- catalog_price_history (append-only)
DROP POLICY IF EXISTS catalog_price_history_supplier_portal_select ON public.catalog_price_history;
DROP POLICY IF EXISTS catalog_price_history_authenticated_select ON public.catalog_price_history;

DROP INDEX IF EXISTS public.catalog_price_history_supplier_date_idx;
DROP INDEX IF EXISTS public.catalog_price_history_product_idx;

DROP TABLE IF EXISTS public.catalog_price_history;

-- catalog_products
DROP POLICY IF EXISTS catalog_products_supplier_portal_delete ON public.catalog_products;
DROP POLICY IF EXISTS catalog_products_supplier_portal_update ON public.catalog_products;
DROP POLICY IF EXISTS catalog_products_supplier_portal_select ON public.catalog_products;
DROP POLICY IF EXISTS catalog_products_supplier_portal_insert ON public.catalog_products;
DROP POLICY IF EXISTS catalog_products_authenticated_select_active ON public.catalog_products;

DROP INDEX IF EXISTS public.catalog_products_price_effective_idx;
DROP INDEX IF EXISTS public.catalog_products_sku_idx;
DROP INDEX IF EXISTS public.catalog_products_supplier_category_idx;
DROP INDEX IF EXISTS public.catalog_products_supplier_active_name_idx;

DROP TABLE IF EXISTS public.catalog_products;

COMMIT;
