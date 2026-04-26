-- ============================================================================
-- ROLLBACK for 2026_04_21_chiefos_quota_architecture_tables.sql
--
-- Drops upsell_prompts_log → addon_purchases_yearly → quota_consumption_log
-- → quota_allotments (reverse FK order).
--
-- Idempotent: uses IF EXISTS for every drop.
--
-- Safe to run when: no other migrations or code depend on these tables.
-- NEVER run in production without an explicit deploy-gate approval.
-- ============================================================================

BEGIN;

-- ── Preflight: warn about row counts before drop ───────────────────────────
DO $rollback_preflight$
DECLARE
  qa_count  bigint := 0;
  qcl_count bigint := 0;
  apy_count bigint := 0;
  upl_count bigint := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='quota_allotments') THEN
    SELECT COUNT(*) INTO qa_count FROM public.quota_allotments;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='quota_consumption_log') THEN
    SELECT COUNT(*) INTO qcl_count FROM public.quota_consumption_log;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='addon_purchases_yearly') THEN
    SELECT COUNT(*) INTO apy_count FROM public.addon_purchases_yearly;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='upsell_prompts_log') THEN
    SELECT COUNT(*) INTO upl_count FROM public.upsell_prompts_log;
  END IF;
  RAISE NOTICE 'Rollback preflight: quota_allotments=% quota_consumption_log=% addon_purchases_yearly=% upsell_prompts_log=% rows (dropping regardless)',
    qa_count, qcl_count, apy_count, upl_count;
END
$rollback_preflight$;

-- ── Drop policies ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS upsell_prompts_log_tenant_read      ON public.upsell_prompts_log;
DROP POLICY IF EXISTS addon_purchases_yearly_tenant_read  ON public.addon_purchases_yearly;
DROP POLICY IF EXISTS quota_consumption_log_tenant_read   ON public.quota_consumption_log;
DROP POLICY IF EXISTS quota_allotments_tenant_read        ON public.quota_allotments;

-- ── Drop indexes ────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS public.upsell_prompts_log_tenant_idx;
DROP INDEX IF EXISTS public.upsell_prompts_once_per_month_idx;

DROP INDEX IF EXISTS public.addon_purchases_yearly_tenant_idx;
DROP INDEX IF EXISTS public.addon_purchases_yearly_owner_year_idx;

DROP INDEX IF EXISTS public.quota_consumption_log_allotment_idx;
DROP INDEX IF EXISTS public.quota_consumption_log_tenant_idx;
DROP INDEX IF EXISTS public.quota_consumption_log_owner_month_idx;

DROP INDEX IF EXISTS public.quota_allotments_stripe_idempotent_idx;
DROP INDEX IF EXISTS public.quota_allotments_tenant_idx;
DROP INDEX IF EXISTS public.quota_allotments_active_idx;
DROP INDEX IF EXISTS public.quota_allotments_owner_idx;

-- ── Drop tables (reverse FK order) ──────────────────────────────────────────
DROP TABLE IF EXISTS public.upsell_prompts_log;
DROP TABLE IF EXISTS public.addon_purchases_yearly;
DROP TABLE IF EXISTS public.quota_consumption_log;
DROP TABLE IF EXISTS public.quota_allotments;

COMMIT;
