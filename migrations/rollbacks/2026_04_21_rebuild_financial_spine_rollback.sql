-- Rollback for 2026_04_21_rebuild_financial_spine.sql
-- Drops file_exports then transactions (reverse dependency order).
-- Safe to re-run.

BEGIN;

-- file_exports
DROP POLICY IF EXISTS file_exports_tenant_insert ON public.file_exports;
DROP POLICY IF EXISTS file_exports_tenant_select ON public.file_exports;

DROP INDEX IF EXISTS public.file_exports_expired_idx;
DROP INDEX IF EXISTS public.file_exports_owner_created_idx;
DROP INDEX IF EXISTS public.file_exports_tenant_created_idx;

DROP TABLE IF EXISTS public.file_exports;

-- transactions
DROP POLICY IF EXISTS transactions_owner_board_delete ON public.transactions;
DROP POLICY IF EXISTS transactions_tenant_update ON public.transactions;
DROP POLICY IF EXISTS transactions_tenant_insert ON public.transactions;
DROP POLICY IF EXISTS transactions_tenant_select ON public.transactions;

DROP INDEX IF EXISTS public.transactions_media_asset_idx;
DROP INDEX IF EXISTS public.transactions_parse_job_idx;
DROP INDEX IF EXISTS public.transactions_deleted_idx;
DROP INDEX IF EXISTS public.transactions_pending_review_idx;
DROP INDEX IF EXISTS public.transactions_job_idx;
DROP INDEX IF EXISTS public.transactions_owner_date_idx;
DROP INDEX IF EXISTS public.transactions_tenant_kind_date_idx;
DROP INDEX IF EXISTS public.transactions_record_hash_unique_idx;
DROP INDEX IF EXISTS public.transactions_dedupe_hash_unique_idx;

DROP TABLE IF EXISTS public.transactions;

COMMIT;
