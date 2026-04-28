-- Rollback for 2026_04_22_rebuild_views.sql
-- Drops all 6 views. Safe to re-run (IF EXISTS everywhere).
-- Views are independent — no cross-references among them — so order doesn't
-- matter. Independent of functions/triggers rollback.

BEGIN;

DROP VIEW IF EXISTS public.chiefos_portal_open_shifts;
DROP VIEW IF EXISTS public.chiefos_portal_cashflow_daily;
DROP VIEW IF EXISTS public.chiefos_portal_job_summary;
DROP VIEW IF EXISTS public.chiefos_portal_time_entries;
DROP VIEW IF EXISTS public.chiefos_portal_revenue;
DROP VIEW IF EXISTS public.chiefos_portal_expenses;

COMMIT;
