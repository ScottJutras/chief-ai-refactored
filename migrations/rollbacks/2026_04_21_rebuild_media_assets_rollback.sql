-- Rollback for 2026_04_21_rebuild_media_assets.sql
-- Safe to re-run (IF EXISTS everywhere).

BEGIN;

DROP POLICY IF EXISTS media_assets_tenant_update ON public.media_assets;
DROP POLICY IF EXISTS media_assets_tenant_insert ON public.media_assets;
DROP POLICY IF EXISTS media_assets_tenant_select ON public.media_assets;

DROP INDEX IF EXISTS public.media_assets_kind_idx;
DROP INDEX IF EXISTS public.media_assets_owner_idx;
DROP INDEX IF EXISTS public.media_assets_parent_idx;
DROP INDEX IF EXISTS public.media_assets_hash_idx;
DROP INDEX IF EXISTS public.media_assets_tenant_created_idx;

DROP TABLE IF EXISTS public.media_assets;

COMMIT;
