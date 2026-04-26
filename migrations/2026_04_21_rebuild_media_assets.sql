-- ============================================================================
-- Foundation Rebuild — Session 1, Part 2: media_assets
--
-- Creates the generic polymorphic media-metadata table per Decisions 4 and 13:
--   - Decision 4: single polymorphic table (parent_kind + parent_id) covers
--     receipts, quote attachments, email attachments, voice notes, PDFs.
--     job_photos stays specialized (job-specific phase/sharing semantics).
--   - Decision 13: OCR columns DISCARDed in rebuild. parse_jobs is the sole
--     OCR surface; media_assets carries pure file metadata.
--
-- Authoritative source: FOUNDATION_P1_SCHEMA_DESIGN.md §3.2 (media_assets),
--   reconciled with the live-DB column shape per Phase 1 Session 2's
--   verification report (storage_provider + storage_path rather than the
--   original design's storage_bucket + storage_key).
--
-- Dependencies:
--   - public.chiefos_tenants (created by rebuild_identity_tenancy)
--   - pgcrypto for gen_random_uuid
--
-- Idempotent.
-- ============================================================================

BEGIN;

-- Preflight
DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_tenants') THEN
    RAISE EXCEPTION 'Migration requires public.chiefos_tenants. Apply rebuild_identity_tenancy first.';
  END IF;
END
$preflight$;

-- ============================================================================
-- media_assets — polymorphic file-metadata table
-- Source: FOUNDATION_P1_SCHEMA_DESIGN.md §3.2
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.media_assets (
  id                 uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id           text         NOT NULL,
  user_id            text,
  storage_provider   text         NOT NULL DEFAULT 'supabase',
  storage_path       text         NOT NULL,
  mime_type          text,
  size_bytes         bigint,
  original_filename  text,
  attachment_hash    text,                         -- content hash (matches parse_jobs.attachment_hash for dedup)
  sha256             text,                         -- full SHA-256
  kind               text         NOT NULL,
  parent_kind        text,                         -- polymorphic parent discriminator per Decision 4
  parent_id          text,                         -- polymorphic parent id (text to handle both uuid and integer FKs)
  source             text         NOT NULL DEFAULT 'portal',
  source_msg_id      text,
  uploaded_at        timestamptz,
  uploaded_by        uuid,                         -- auth.users.id; no FK to avoid coupling
  created_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at         timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT media_assets_owner_id_nonempty
    CHECK (char_length(owner_id) > 0),
  CONSTRAINT media_assets_storage_provider_chk
    CHECK (storage_provider IN ('supabase','s3','gcs','other')),
  CONSTRAINT media_assets_storage_path_nonempty
    CHECK (char_length(storage_path) > 0),
  CONSTRAINT media_assets_kind_chk
    CHECK (kind IN ('receipt_image','quote_attachment','email_attachment',
                    'voice_note','pdf_document','other')),
  CONSTRAINT media_assets_parent_kind_chk
    CHECK (parent_kind IS NULL OR parent_kind IN (
      'transaction','parse_job','quote_version','intake_item','email_event','other'
    )),
  CONSTRAINT media_assets_source_chk
    CHECK (source IN ('whatsapp','portal','email','api')),
  CONSTRAINT media_assets_parent_consistency
    CHECK ((parent_kind IS NULL AND parent_id IS NULL) OR
           (parent_kind IS NOT NULL AND parent_id IS NOT NULL)),
  CONSTRAINT media_assets_size_bytes_positive
    CHECK (size_bytes IS NULL OR size_bytes >= 0)
);

-- UNIQUE (tenant_id, storage_provider, storage_path) — one row per stored object
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'media_assets_storage_path_unique'
      AND conrelid = 'public.media_assets'::regclass
  ) THEN
    ALTER TABLE public.media_assets
      ADD CONSTRAINT media_assets_storage_path_unique
      UNIQUE (tenant_id, storage_provider, storage_path);
  END IF;
END $$;

-- Composite identity UNIQUE (Principle 11) for cross-spine FK targets
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'media_assets_identity_unique'
      AND conrelid = 'public.media_assets'::regclass
  ) THEN
    ALTER TABLE public.media_assets
      ADD CONSTRAINT media_assets_identity_unique UNIQUE (id, tenant_id, owner_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS media_assets_tenant_created_idx
  ON public.media_assets (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS media_assets_hash_idx
  ON public.media_assets (tenant_id, attachment_hash)
  WHERE attachment_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_assets_parent_idx
  ON public.media_assets (parent_kind, parent_id)
  WHERE parent_kind IS NOT NULL AND parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_assets_owner_idx
  ON public.media_assets (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS media_assets_kind_idx
  ON public.media_assets (tenant_id, kind);

ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='media_assets'
                   AND policyname='media_assets_tenant_select') THEN
    CREATE POLICY media_assets_tenant_select
      ON public.media_assets FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='media_assets'
                   AND policyname='media_assets_tenant_insert') THEN
    CREATE POLICY media_assets_tenant_insert
      ON public.media_assets FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='media_assets'
                   AND policyname='media_assets_tenant_update') THEN
    CREATE POLICY media_assets_tenant_update
      ON public.media_assets FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.media_assets TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.media_assets TO service_role;

COMMENT ON TABLE public.media_assets IS
  'Polymorphic file-metadata table. One row per uploaded artifact. parent_kind+parent_id references the owning domain row. OCR columns DISCARDed per Decision 13 — parse_jobs is the OCR surface; this table is pure file metadata.';
COMMENT ON COLUMN public.media_assets.parent_kind IS
  'Discriminator for polymorphic parent reference. Not a DB-enforced FK (parent rows span multiple tables with varied PK types).';
COMMENT ON COLUMN public.media_assets.attachment_hash IS
  'Content hash for deduplication; matches parse_jobs.attachment_hash when the asset is a receipt image.';

COMMIT;
