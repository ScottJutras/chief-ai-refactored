-- Rollback for 2026_04_22_amendment_supplier_catalog_root.sql
-- Drops 3 tables in reverse dependency order. Safe to re-run.
--
-- IMPORTANT: downstream tables (catalog_products, catalog_price_history,
-- catalog_ingestion_log, tenant_supplier_preferences) FK into these three.
-- Run those rollbacks first (supplier_catalog_products_rollback.sql and
-- tenant_supplier_preferences_rollback.sql) before this file.

BEGIN;

-- supplier_categories (self-ref FK on parent_category_id + FK to suppliers)
DROP POLICY IF EXISTS supplier_categories_supplier_portal_delete ON public.supplier_categories;
DROP POLICY IF EXISTS supplier_categories_supplier_portal_update ON public.supplier_categories;
DROP POLICY IF EXISTS supplier_categories_supplier_portal_insert ON public.supplier_categories;
DROP POLICY IF EXISTS supplier_categories_authenticated_select ON public.supplier_categories;

DROP INDEX IF EXISTS public.supplier_categories_parent_idx;
DROP INDEX IF EXISTS public.supplier_categories_supplier_idx;

DROP TABLE IF EXISTS public.supplier_categories;

-- supplier_users (FK to suppliers + FK to auth.users)
DROP POLICY IF EXISTS supplier_users_self_update ON public.supplier_users;
DROP POLICY IF EXISTS supplier_users_co_supplier_select ON public.supplier_users;
DROP POLICY IF EXISTS supplier_users_self_select ON public.supplier_users;

DROP INDEX IF EXISTS public.supplier_users_email_idx;
DROP INDEX IF EXISTS public.supplier_users_supplier_idx;

DROP TABLE IF EXISTS public.supplier_users;

-- suppliers (root)
DROP POLICY IF EXISTS suppliers_supplier_portal_update ON public.suppliers;
DROP POLICY IF EXISTS suppliers_supplier_portal_select ON public.suppliers;
DROP POLICY IF EXISTS suppliers_authenticated_select_active ON public.suppliers;

DROP INDEX IF EXISTS public.suppliers_active_idx;
DROP INDEX IF EXISTS public.suppliers_status_idx;

DROP TABLE IF EXISTS public.suppliers;

COMMIT;
