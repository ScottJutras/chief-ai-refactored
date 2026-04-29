-- Rollback for: 2026_04_29_amendment_p1a8_rls_recursion_fix.sql
--
-- Reinstates the original (broken) policies and drops the SECURITY DEFINER
-- helpers. After rollback, client-side SELECTs on chiefos_portal_users and
-- supplier_users will 42P17 again. Only roll back if the helper functions
-- themselves prove problematic — no expected scenario.

BEGIN;

-- 1. Restore original (recursive) policies, verbatim from pre-P1A-8 state.

DROP POLICY IF EXISTS portal_users_tenant_read_by_owner ON public.chiefos_portal_users;
CREATE POLICY portal_users_tenant_read_by_owner
  ON public.chiefos_portal_users
  FOR SELECT
  USING (tenant_id IN (
    SELECT chiefos_portal_users_1.tenant_id
    FROM public.chiefos_portal_users chiefos_portal_users_1
    WHERE chiefos_portal_users_1.user_id = auth.uid()
      AND chiefos_portal_users_1.role = 'owner'
  ));

DROP POLICY IF EXISTS portal_users_owner_update_roles ON public.chiefos_portal_users;
CREATE POLICY portal_users_owner_update_roles
  ON public.chiefos_portal_users
  FOR UPDATE
  USING (tenant_id IN (
    SELECT chiefos_portal_users_1.tenant_id
    FROM public.chiefos_portal_users chiefos_portal_users_1
    WHERE chiefos_portal_users_1.user_id = auth.uid()
      AND chiefos_portal_users_1.role = 'owner'
  ))
  WITH CHECK (tenant_id IN (
    SELECT chiefos_portal_users_1.tenant_id
    FROM public.chiefos_portal_users chiefos_portal_users_1
    WHERE chiefos_portal_users_1.user_id = auth.uid()
      AND chiefos_portal_users_1.role = 'owner'
  ));

DROP POLICY IF EXISTS supplier_users_co_supplier_select ON public.supplier_users;
CREATE POLICY supplier_users_co_supplier_select
  ON public.supplier_users
  FOR SELECT
  USING (supplier_id IN (
    SELECT supplier_users_1.supplier_id
    FROM public.supplier_users supplier_users_1
    WHERE supplier_users_1.auth_uid = auth.uid()
      AND supplier_users_1.is_active = true
  ));

-- 2. Drop the helper functions.

DROP FUNCTION IF EXISTS public.chiefos_owner_tenants_for(uuid);
DROP FUNCTION IF EXISTS public.chiefos_supplier_ids_for(uuid);

COMMIT;
