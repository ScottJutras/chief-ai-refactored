-- Rollback for 2026_04_22_amendment_tenant_supplier_preferences.sql
-- Safe to re-run.

BEGIN;

DROP POLICY IF EXISTS tenant_supplier_preferences_owner_board_delete ON public.tenant_supplier_preferences;
DROP POLICY IF EXISTS tenant_supplier_preferences_owner_board_update ON public.tenant_supplier_preferences;
DROP POLICY IF EXISTS tenant_supplier_preferences_owner_board_insert ON public.tenant_supplier_preferences;
DROP POLICY IF EXISTS tenant_supplier_preferences_tenant_select ON public.tenant_supplier_preferences;

DROP INDEX IF EXISTS public.tenant_supplier_preferences_supplier_idx;
DROP INDEX IF EXISTS public.tenant_supplier_preferences_tenant_preferred_idx;

DROP TABLE IF EXISTS public.tenant_supplier_preferences;

COMMIT;
