-- Rollback for 2026_04_22_rebuild_admin_support.sql
-- Drops tables in reverse dependency order. Safe to re-run (IF EXISTS everywhere).
--
-- Note: `customers` is a dependency of the Quotes spine. Rolling back
-- customers while rebuild_quotes_spine is applied will fail due to the
-- chiefos_quotes.customer_id and chiefos_quote_events.customer_id FKs.
-- Run rebuild_quotes_spine_rollback.sql first if needed.

BEGIN;

-- chiefos_crew_rates
DROP POLICY IF EXISTS chiefos_crew_rates_owner_update ON public.chiefos_crew_rates;
DROP POLICY IF EXISTS chiefos_crew_rates_owner_insert ON public.chiefos_crew_rates;
DROP POLICY IF EXISTS chiefos_crew_rates_owner_select ON public.chiefos_crew_rates;

DROP INDEX IF EXISTS public.chiefos_crew_rates_tenant_employee_active_idx;
DROP INDEX IF EXISTS public.chiefos_crew_rates_tenant_portal_active_idx;
DROP INDEX IF EXISTS public.chiefos_crew_rates_employee_user_effective_unique_idx;
DROP INDEX IF EXISTS public.chiefos_crew_rates_portal_user_effective_unique_idx;

DROP TABLE IF EXISTS public.chiefos_crew_rates;

-- employee_invites
DROP POLICY IF EXISTS employee_invites_owner_board_update ON public.employee_invites;
DROP POLICY IF EXISTS employee_invites_owner_board_insert ON public.employee_invites;
DROP POLICY IF EXISTS employee_invites_owner_board_select ON public.employee_invites;

DROP INDEX IF EXISTS public.employee_invites_accepted_by_idx;
DROP INDEX IF EXISTS public.employee_invites_tenant_status_idx;

DROP TABLE IF EXISTS public.employee_invites;

-- import_batches
DROP POLICY IF EXISTS import_batches_tenant_update ON public.import_batches;
DROP POLICY IF EXISTS import_batches_tenant_insert ON public.import_batches;
DROP POLICY IF EXISTS import_batches_tenant_select ON public.import_batches;

DROP INDEX IF EXISTS public.import_batches_portal_user_idx;
DROP INDEX IF EXISTS public.import_batches_tenant_status_idx;

DROP TABLE IF EXISTS public.import_batches;

-- settings
DROP POLICY IF EXISTS settings_owner_scope_update ON public.settings;
DROP POLICY IF EXISTS settings_owner_scope_insert ON public.settings;
DROP POLICY IF EXISTS settings_tenant_select ON public.settings;

DROP INDEX IF EXISTS public.settings_owner_key_idx;
DROP INDEX IF EXISTS public.settings_tenant_scope_key_idx;

DROP TABLE IF EXISTS public.settings;

-- customers (FK-referenced by chiefos_quotes, chiefos_quote_events — must drop after Quotes rollback)
DROP POLICY IF EXISTS customers_owner_board_delete ON public.customers;
DROP POLICY IF EXISTS customers_tenant_update ON public.customers;
DROP POLICY IF EXISTS customers_tenant_insert ON public.customers;
DROP POLICY IF EXISTS customers_tenant_select ON public.customers;

DROP INDEX IF EXISTS public.customers_deleted_idx;
DROP INDEX IF EXISTS public.customers_tenant_phone_idx;
DROP INDEX IF EXISTS public.customers_tenant_email_idx;
DROP INDEX IF EXISTS public.customers_tenant_name_idx;
DROP INDEX IF EXISTS public.customers_owner_source_msg_unique_idx;

DROP TABLE IF EXISTS public.customers;

COMMIT;
