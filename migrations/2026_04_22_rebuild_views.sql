-- ============================================================================
-- Foundation Rebuild — Session P3-4a, Part 3: Views
--
-- Section 4 of FOUNDATION_P1_SCHEMA_DESIGN.md.
--
-- Six views, all SECURITY INVOKER (WITH (security_invoker = true)). Zero
-- SECURITY DEFINER views. Underlying RLS on source tables gates visibility.
--
-- Inventory:
--   §4.1 Portal Compatibility Views (3):
--     1. chiefos_portal_expenses     — transactions where kind='expense'
--     2. chiefos_portal_revenue      — transactions where kind='revenue'
--     3. chiefos_portal_time_entries — time_entries_v2 + jobs join
--   §4.2 Aggregation Views (3):
--     4. chiefos_portal_job_summary   — per-job P&L + labour totals
--     5. chiefos_portal_cashflow_daily — daily cash in/out
--     6. chiefos_portal_open_shifts   — active shifts (clock-in, no clock-out)
--
-- View-set reduced from 23 currently live down to 6 per §4.3 DISCARD list.
-- Every remaining view has a clear role.
--
-- Dependencies:
--   - public.transactions (Session P3-1)
--   - public.time_entries_v2 (Session P3-2a)
--   - public.jobs (Session P3-2a)
--
-- Idempotent: CREATE OR REPLACE VIEW — safe to re-run.
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='transactions') THEN
    RAISE EXCEPTION 'Requires public.transactions';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='time_entries_v2') THEN
    RAISE EXCEPTION 'Requires public.time_entries_v2';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='jobs') THEN
    RAISE EXCEPTION 'Requires public.jobs';
  END IF;
END
$preflight$;

-- ============================================================================
-- View 1: chiefos_portal_expenses
-- Portal-safe read of expense transactions. Per §4.1 indicative definition.
-- ============================================================================

-- Drop any predecessor (pre-rebuild defined this view with different columns).
DROP VIEW IF EXISTS public.chiefos_portal_expenses CASCADE;

CREATE VIEW public.chiefos_portal_expenses
WITH (security_invoker = true) AS
SELECT
  t.id, t.tenant_id, t.owner_id, t.user_id,
  t.date, t.amount_cents, t.currency,
  t.subtotal_cents, t.tax_cents, t.tax_label,
  t.merchant, t.description, t.category, t.is_personal,
  t.job_id, t.job_no,
  t.source, t.source_msg_id, t.media_asset_id, t.parse_job_id,
  t.submission_status, t.submitted_by, t.reviewed_at, t.reviewer_note,
  t.created_at, t.updated_at
FROM public.transactions t
WHERE t.kind = 'expense' AND t.deleted_at IS NULL;

GRANT SELECT ON public.chiefos_portal_expenses TO authenticated;
GRANT SELECT ON public.chiefos_portal_expenses TO service_role;

COMMENT ON VIEW public.chiefos_portal_expenses IS
  'Portal-safe read of expense transactions. SECURITY INVOKER — RLS on public.transactions gates visibility.';

-- ============================================================================
-- View 2: chiefos_portal_revenue
-- Same pattern as expenses for kind='revenue'.
-- ============================================================================

DROP VIEW IF EXISTS public.chiefos_portal_revenue CASCADE;

CREATE VIEW public.chiefos_portal_revenue
WITH (security_invoker = true) AS
SELECT
  t.id, t.tenant_id, t.owner_id, t.user_id,
  t.date, t.amount_cents, t.currency,
  t.subtotal_cents, t.tax_cents, t.tax_label,
  t.merchant, t.description, t.category, t.is_personal,
  t.job_id, t.job_no,
  t.source, t.source_msg_id, t.media_asset_id, t.parse_job_id,
  t.submission_status, t.submitted_by, t.reviewed_at, t.reviewer_note,
  t.created_at, t.updated_at
FROM public.transactions t
WHERE t.kind = 'revenue' AND t.deleted_at IS NULL;

GRANT SELECT ON public.chiefos_portal_revenue TO authenticated;
GRANT SELECT ON public.chiefos_portal_revenue TO service_role;

COMMENT ON VIEW public.chiefos_portal_revenue IS
  'Portal-safe read of revenue transactions. SECURITY INVOKER.';

-- ============================================================================
-- View 3: chiefos_portal_time_entries
-- Portal-safe read over time_entries_v2, joining jobs for job_name convenience.
-- ============================================================================

DROP VIEW IF EXISTS public.chiefos_portal_time_entries CASCADE;

CREATE VIEW public.chiefos_portal_time_entries
WITH (security_invoker = true) AS
SELECT
  te.id, te.tenant_id, te.owner_id, te.user_id,
  te.job_id, te.job_no, j.name AS job_name,
  te.parent_id,
  te.kind, te.start_at_utc, te.end_at_utc, te.meta,
  te.created_by, te.source_msg_id, te.import_batch_id,
  te.created_at, te.updated_at
FROM public.time_entries_v2 te
LEFT JOIN public.jobs j
  ON j.id = te.job_id
 AND j.tenant_id = te.tenant_id
 AND j.owner_id = te.owner_id
WHERE te.deleted_at IS NULL;

GRANT SELECT ON public.chiefos_portal_time_entries TO authenticated;
GRANT SELECT ON public.chiefos_portal_time_entries TO service_role;

COMMENT ON VIEW public.chiefos_portal_time_entries IS
  'Portal-safe read over time_entries_v2 joined with jobs for display. SECURITY INVOKER. LEFT JOIN on composite (id, tenant_id, owner_id) preserves entries with null job_id.';

-- ============================================================================
-- View 4: chiefos_portal_job_summary
-- Per-job aggregate collapsing 7 DISCARDed KPI views.
-- Totals computed from transactions (expense + revenue) and time_entries_v2.
-- ============================================================================

DROP VIEW IF EXISTS public.chiefos_portal_job_summary CASCADE;

CREATE VIEW public.chiefos_portal_job_summary
WITH (security_invoker = true) AS
WITH expense_totals AS (
  SELECT
    t.tenant_id,
    t.owner_id,
    t.job_id,
    SUM(t.amount_cents) AS total_expense_cents
  FROM public.transactions t
  WHERE t.kind = 'expense'
    AND t.deleted_at IS NULL
    AND t.submission_status = 'confirmed'
    AND t.job_id IS NOT NULL
  GROUP BY t.tenant_id, t.owner_id, t.job_id
),
revenue_totals AS (
  SELECT
    t.tenant_id,
    t.owner_id,
    t.job_id,
    SUM(t.amount_cents) AS total_revenue_cents
  FROM public.transactions t
  WHERE t.kind = 'revenue'
    AND t.deleted_at IS NULL
    AND t.submission_status = 'confirmed'
    AND t.job_id IS NOT NULL
  GROUP BY t.tenant_id, t.owner_id, t.job_id
),
labour_totals AS (
  -- Sum only completed segments (both start_at_utc and end_at_utc set) so
  -- open shifts don't inflate labour hours. Partial-shift segments compose
  -- into a shift via parent_id but each segment already has its own duration.
  SELECT
    te.tenant_id,
    te.owner_id,
    te.job_id,
    SUM(EXTRACT(EPOCH FROM (te.end_at_utc - te.start_at_utc)) / 3600.0)::numeric(14,4)
      AS total_labour_hours
  FROM public.time_entries_v2 te
  WHERE te.deleted_at IS NULL
    AND te.end_at_utc IS NOT NULL
    AND te.job_id IS NOT NULL
  GROUP BY te.tenant_id, te.owner_id, te.job_id
)
SELECT
  j.id                                   AS job_id,
  j.tenant_id,
  j.owner_id,
  j.job_no,
  j.name                                 AS job_name,
  j.status,
  j.contract_value_cents,
  j.start_date,
  j.end_date,
  COALESCE(et.total_expense_cents, 0)    AS total_expense_cents,
  COALESCE(rt.total_revenue_cents, 0)    AS total_revenue_cents,
  COALESCE(lt.total_labour_hours, 0)     AS total_labour_hours,
  (COALESCE(rt.total_revenue_cents, 0)
    - COALESCE(et.total_expense_cents, 0)) AS gross_profit_cents,
  CASE
    WHEN COALESCE(rt.total_revenue_cents, 0) = 0 THEN NULL
    ELSE ROUND(
      ((COALESCE(rt.total_revenue_cents, 0) - COALESCE(et.total_expense_cents, 0))::numeric
       / rt.total_revenue_cents::numeric) * 100,
      2
    )
  END                                    AS gross_margin_pct,
  j.created_at,
  j.updated_at
FROM public.jobs j
LEFT JOIN expense_totals et
  ON et.tenant_id = j.tenant_id
 AND et.owner_id = j.owner_id
 AND et.job_id = j.id
LEFT JOIN revenue_totals rt
  ON rt.tenant_id = j.tenant_id
 AND rt.owner_id = j.owner_id
 AND rt.job_id = j.id
LEFT JOIN labour_totals lt
  ON lt.tenant_id = j.tenant_id
 AND lt.owner_id = j.owner_id
 AND lt.job_id = j.id
WHERE j.deleted_at IS NULL;

GRANT SELECT ON public.chiefos_portal_job_summary TO authenticated;
GRANT SELECT ON public.chiefos_portal_job_summary TO service_role;

COMMENT ON VIEW public.chiefos_portal_job_summary IS
  'Per-job P&L and labour summary. Collapses 7 DISCARDed KPI views (v_job_profit_simple[_fixed], job_kpis_summary/daily/weekly/monthly) into one canonical surface. SECURITY INVOKER; underlying tenant-RLS gates visibility. Only confirmed transactions count; open shifts excluded from labour (end_at_utc IS NULL rows skipped).';

-- ============================================================================
-- View 5: chiefos_portal_cashflow_daily
-- Daily cash in/out, one row per (tenant, date).
-- ============================================================================

DROP VIEW IF EXISTS public.chiefos_portal_cashflow_daily CASCADE;

CREATE VIEW public.chiefos_portal_cashflow_daily
WITH (security_invoker = true) AS
SELECT
  t.tenant_id,
  t.owner_id,
  t.date,
  SUM(CASE WHEN t.kind = 'revenue' THEN t.amount_cents ELSE 0 END)  AS cash_in_cents,
  SUM(CASE WHEN t.kind = 'expense' THEN t.amount_cents ELSE 0 END)  AS cash_out_cents,
  SUM(CASE WHEN t.kind = 'revenue' THEN t.amount_cents
           WHEN t.kind = 'expense' THEN -t.amount_cents
           ELSE 0 END)                                              AS net_cents,
  COUNT(*) FILTER (WHERE t.kind = 'revenue')                        AS revenue_count,
  COUNT(*) FILTER (WHERE t.kind = 'expense')                        AS expense_count
FROM public.transactions t
WHERE t.kind IN ('expense','revenue')
  AND t.deleted_at IS NULL
  AND t.submission_status = 'confirmed'
GROUP BY t.tenant_id, t.owner_id, t.date;

GRANT SELECT ON public.chiefos_portal_cashflow_daily TO authenticated;
GRANT SELECT ON public.chiefos_portal_cashflow_daily TO service_role;

COMMENT ON VIEW public.chiefos_portal_cashflow_daily IS
  'Daily cash in/out per (tenant, owner, date). Only confirmed transactions. Replaces pre-rebuild v_cashflow_daily with column alignment to rebuilt transactions shape.';

-- ============================================================================
-- View 6: chiefos_portal_open_shifts
-- Active shifts — a shift segment with start_at_utc set and end_at_utc NULL.
-- Joins jobs for the job_name display convenience.
-- ============================================================================

DROP VIEW IF EXISTS public.chiefos_portal_open_shifts CASCADE;

CREATE VIEW public.chiefos_portal_open_shifts
WITH (security_invoker = true) AS
SELECT
  te.id, te.tenant_id, te.owner_id, te.user_id,
  te.job_id, te.job_no, j.name AS job_name,
  te.parent_id,
  te.kind,
  te.start_at_utc,
  (EXTRACT(EPOCH FROM (now() - te.start_at_utc)) / 3600.0)::numeric(14,4)
    AS hours_elapsed,
  te.meta,
  te.source_msg_id,
  te.created_at
FROM public.time_entries_v2 te
LEFT JOIN public.jobs j
  ON j.id = te.job_id
 AND j.tenant_id = te.tenant_id
 AND j.owner_id = te.owner_id
WHERE te.deleted_at IS NULL
  AND te.end_at_utc IS NULL
  AND te.kind IN ('shift_start','shift');

GRANT SELECT ON public.chiefos_portal_open_shifts TO authenticated;
GRANT SELECT ON public.chiefos_portal_open_shifts TO service_role;

COMMENT ON VIEW public.chiefos_portal_open_shifts IS
  'Active shifts (clock-in segment with no clock-out yet). hours_elapsed computed at read time. SECURITY INVOKER.';

COMMIT;
