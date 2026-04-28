-- Rollback for 2026_04_21_rebuild_intake_pipeline.sql
-- Drops tables in reverse dependency order. Safe to re-run (IF EXISTS everywhere).

BEGIN;

-- intake_item_reviews
DROP POLICY IF EXISTS intake_item_reviews_tenant_insert ON public.intake_item_reviews;
DROP POLICY IF EXISTS intake_item_reviews_tenant_select ON public.intake_item_reviews;

DROP INDEX IF EXISTS public.intake_item_reviews_correlation_idx;
DROP INDEX IF EXISTS public.intake_item_reviews_reviewer_idx;
DROP INDEX IF EXISTS public.intake_item_reviews_tenant_idx;
DROP INDEX IF EXISTS public.intake_item_reviews_item_idx;

DROP TABLE IF EXISTS public.intake_item_reviews;

-- intake_item_drafts
DROP POLICY IF EXISTS intake_item_drafts_tenant_update ON public.intake_item_drafts;
DROP POLICY IF EXISTS intake_item_drafts_tenant_insert ON public.intake_item_drafts;
DROP POLICY IF EXISTS intake_item_drafts_tenant_select ON public.intake_item_drafts;

DROP INDEX IF EXISTS public.intake_item_drafts_job_idx;
DROP INDEX IF EXISTS public.intake_item_drafts_tenant_idx;
DROP INDEX IF EXISTS public.intake_item_drafts_item_idx;

DROP TABLE IF EXISTS public.intake_item_drafts;

-- intake_items
DROP POLICY IF EXISTS intake_items_tenant_update ON public.intake_items;
DROP POLICY IF EXISTS intake_items_tenant_insert ON public.intake_items;
DROP POLICY IF EXISTS intake_items_tenant_select ON public.intake_items;

DROP INDEX IF EXISTS public.intake_items_job_idx;
DROP INDEX IF EXISTS public.intake_items_duplicate_idx;
DROP INDEX IF EXISTS public.intake_items_pending_review_idx;
DROP INDEX IF EXISTS public.intake_items_batch_idx;
DROP INDEX IF EXISTS public.intake_items_owner_status_idx;
DROP INDEX IF EXISTS public.intake_items_tenant_created_idx;
DROP INDEX IF EXISTS public.intake_items_owner_dedupe_unique_idx;
DROP INDEX IF EXISTS public.intake_items_owner_source_msg_unique_idx;

DROP TABLE IF EXISTS public.intake_items;

-- intake_batches
DROP POLICY IF EXISTS intake_batches_tenant_update ON public.intake_batches;
DROP POLICY IF EXISTS intake_batches_tenant_insert ON public.intake_batches;
DROP POLICY IF EXISTS intake_batches_tenant_select ON public.intake_batches;

DROP INDEX IF EXISTS public.intake_batches_creator_idx;
DROP INDEX IF EXISTS public.intake_batches_owner_status_idx;
DROP INDEX IF EXISTS public.intake_batches_tenant_created_idx;

DROP TABLE IF EXISTS public.intake_batches;

COMMIT;
