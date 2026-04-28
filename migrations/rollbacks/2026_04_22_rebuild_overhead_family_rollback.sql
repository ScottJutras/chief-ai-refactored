-- Rollback for 2026_04_22_rebuild_overhead_family.sql
-- Drops tables in reverse dependency order. Safe to re-run (IF EXISTS everywhere).

BEGIN;

-- overhead_reminders (FK to overhead_items)
DROP POLICY IF EXISTS overhead_reminders_tenant_select ON public.overhead_reminders;

DROP INDEX IF EXISTS public.overhead_reminders_item_idx;
DROP INDEX IF EXISTS public.overhead_reminders_tenant_status_idx;

DROP TABLE IF EXISTS public.overhead_reminders;

-- overhead_payments (FK to overhead_items)
DROP POLICY IF EXISTS overhead_payments_tenant_update ON public.overhead_payments;
DROP POLICY IF EXISTS overhead_payments_tenant_insert ON public.overhead_payments;
DROP POLICY IF EXISTS overhead_payments_tenant_select ON public.overhead_payments;

DROP INDEX IF EXISTS public.overhead_payments_item_idx;
DROP INDEX IF EXISTS public.overhead_payments_tenant_period_idx;
DROP INDEX IF EXISTS public.overhead_payments_owner_source_msg_unique_idx;

DROP TABLE IF EXISTS public.overhead_payments;

-- overhead_items (parent)
DROP POLICY IF EXISTS overhead_items_tenant_update ON public.overhead_items;
DROP POLICY IF EXISTS overhead_items_tenant_insert ON public.overhead_items;
DROP POLICY IF EXISTS overhead_items_tenant_select ON public.overhead_items;

DROP INDEX IF EXISTS public.overhead_items_deleted_idx;
DROP INDEX IF EXISTS public.overhead_items_next_due_idx;
DROP INDEX IF EXISTS public.overhead_items_tenant_category_idx;
DROP INDEX IF EXISTS public.overhead_items_tenant_active_idx;
DROP INDEX IF EXISTS public.overhead_items_owner_source_msg_unique_idx;

DROP TABLE IF EXISTS public.overhead_items;

COMMIT;
