-- Rollback for 2026_04_21_rebuild_pending_actions_cil_drafts.sql
-- Drops tables in reverse dependency order. Safe to re-run (IF EXISTS everywhere).

BEGIN;

-- cil_drafts
DROP POLICY IF EXISTS cil_drafts_tenant_update ON public.cil_drafts;
DROP POLICY IF EXISTS cil_drafts_tenant_insert ON public.cil_drafts;
DROP POLICY IF EXISTS cil_drafts_tenant_select ON public.cil_drafts;

DROP INDEX IF EXISTS public.cil_drafts_committed_target_idx;
DROP INDEX IF EXISTS public.cil_drafts_correlation_idx;
DROP INDEX IF EXISTS public.cil_drafts_owner_pending_idx;
DROP INDEX IF EXISTS public.cil_drafts_tenant_created_idx;
DROP INDEX IF EXISTS public.cil_drafts_owner_source_msg_unique_idx;

DROP TABLE IF EXISTS public.cil_drafts;

-- pending_actions
DROP POLICY IF EXISTS pending_actions_tenant_update ON public.pending_actions;
DROP POLICY IF EXISTS pending_actions_tenant_select ON public.pending_actions;

DROP INDEX IF EXISTS public.pending_actions_expires_cron_idx;
DROP INDEX IF EXISTS public.pending_actions_tenant_expires_idx;

DROP TABLE IF EXISTS public.pending_actions;

COMMIT;
