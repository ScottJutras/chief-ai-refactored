-- ============================================================================
-- Foundation Rebuild — Session 2a, Part 3: Intake (Non-Receipt) Pipeline
--
-- Creates (in order):
--   1. intake_batches       (upload groups; receipt_image_batch kind removed)
--   2. intake_items         (per-artifact rows; receipt_image kind removed)
--   3. intake_item_drafts   (extracted content for non-receipt artifacts)
--   4. intake_item_reviews  (action-level audit; actor FK → portal users)
--
-- Design source: FOUNDATION_P1_SCHEMA_DESIGN.md §3.6
--
-- Receipt pipeline separation (design imperative):
--   Receipts flow through parse_jobs (§3.7), NEVER through intake_items.
--   kind/draft_kind CHECK enums in this file EXCLUDE all receipt-category values.
--   Any Phase 4 app-code path that still routes receipts to intake_items is a
--   BLOCKING bug — fix the code, not the schema.
--
-- Rebuild deltas vs. current live schema:
--   - intake_batches.kind CHECK: drop 'receipt_image_batch'
--   - intake_batches: composite UNIQUE (id, tenant_id, owner_id) for Principle 11
--   - intake_items.kind CHECK: drop 'receipt_image'
--   - intake_items: composite FK (batch_id, tenant_id, owner_id) → intake_batches
--   - intake_items: composite FK (duplicate_of_item_id, tenant_id, owner_id) → intake_items (self)
--   - intake_items: composite UNIQUE (id, tenant_id, owner_id) for Principle 11
--   - intake_item_drafts: composite FK (intake_item_id, tenant_id, owner_id) → intake_items
--   - intake_item_drafts: new draft_kind column with source-extraction enum per §3.6
--     ('voice_transcript','pdf_text','email_body_parse','email_lead_extract')
--   - intake_item_reviews: composite FK (intake_item_id, tenant_id, owner_id) → intake_items
--   - intake_item_reviews: reviewed_by_auth_user_id → reviewed_by_portal_user_id;
--     FK retargeted to chiefos_portal_users(user_id) per Decision 12
--   - intake_item_reviews: correlation_id uuid NOT NULL added per §17.21
--   - intake_item_reviews: action CHECK tightened to ('confirm','reject','edit_confirm','reopen')
--   - intake_item_reviews: append-only enforcement is Session 4 (trigger prevents UPDATE/DELETE);
--     this migration sets GRANTs to INSERT-only for authenticated.
--
-- Purpose separation reminder:
--   intake_item_reviews logs action-level decisions on non-receipt items.
--   parse_corrections (§3.7) logs per-field corrections on receipt items.
--   Both coexist with no overlap.
--
-- Dependencies:
--   - public.chiefos_tenants (Session 1)
--   - public.chiefos_portal_users (Session 1)
--   - public.jobs (Session 2a Part 1) — for intake_item_drafts.job_int_id/intake_items.job_int_id
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_tenants') THEN
    RAISE EXCEPTION 'Requires public.chiefos_tenants (apply rebuild_identity_tenancy first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_portal_users') THEN
    RAISE EXCEPTION 'Requires public.chiefos_portal_users (apply rebuild_identity_tenancy first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='jobs') THEN
    RAISE EXCEPTION 'Requires public.jobs (apply rebuild_jobs_spine first)';
  END IF;
END
$preflight$;

-- ============================================================================
-- 1. intake_batches — upload session groups
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.intake_batches (
  id                       uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id                 text         NOT NULL,
  created_by_auth_user_id  uuid         NOT NULL
    REFERENCES auth.users(id) ON DELETE CASCADE,
  kind                     text         NOT NULL,
  status                   text         NOT NULL DEFAULT 'uploaded',
  total_items              integer      NOT NULL DEFAULT 0,
  confirmed_items          integer      NOT NULL DEFAULT 0,
  skipped_items            integer      NOT NULL DEFAULT 0,
  duplicate_items          integer      NOT NULL DEFAULT 0,
  created_at               timestamptz  NOT NULL DEFAULT now(),
  updated_at               timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT intake_batches_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT intake_batches_kind_chk
    CHECK (kind IN ('voice_batch','pdf_batch','email_batch','mixed_batch')),
  CONSTRAINT intake_batches_status_chk
    CHECK (status IN ('uploaded','processing','pending_review','completed','failed')),
  CONSTRAINT intake_batches_total_items_nonneg CHECK (total_items >= 0),
  CONSTRAINT intake_batches_confirmed_items_nonneg CHECK (confirmed_items >= 0),
  CONSTRAINT intake_batches_skipped_items_nonneg CHECK (skipped_items >= 0),
  CONSTRAINT intake_batches_duplicate_items_nonneg CHECK (duplicate_items >= 0)
);

-- Composite identity UNIQUE (Principle 11) — FK target for intake_items
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'intake_batches_identity_unique'
      AND conrelid = 'public.intake_batches'::regclass
  ) THEN
    ALTER TABLE public.intake_batches
      ADD CONSTRAINT intake_batches_identity_unique UNIQUE (id, tenant_id, owner_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS intake_batches_tenant_created_idx
  ON public.intake_batches (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS intake_batches_owner_status_idx
  ON public.intake_batches (owner_id, status);
CREATE INDEX IF NOT EXISTS intake_batches_creator_idx
  ON public.intake_batches (created_by_auth_user_id, created_at DESC);

ALTER TABLE public.intake_batches ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='intake_batches'
                   AND policyname='intake_batches_tenant_select') THEN
    CREATE POLICY intake_batches_tenant_select
      ON public.intake_batches FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='intake_batches'
                   AND policyname='intake_batches_tenant_insert') THEN
    CREATE POLICY intake_batches_tenant_insert
      ON public.intake_batches FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='intake_batches'
                   AND policyname='intake_batches_tenant_update') THEN
    CREATE POLICY intake_batches_tenant_update
      ON public.intake_batches FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.intake_batches TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.intake_batches TO service_role;

-- ============================================================================
-- 2. intake_items — per-artifact rows
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.intake_items (
  id                       uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id                 uuid         NOT NULL,
  tenant_id                uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id                 text         NOT NULL,
  created_by_auth_user_id  uuid         NOT NULL
    REFERENCES auth.users(id) ON DELETE CASCADE,
  kind                     text         NOT NULL,
  status                   text         NOT NULL DEFAULT 'uploaded',
  storage_bucket           text         NOT NULL DEFAULT 'intake-uploads',
  storage_path             text         NOT NULL,
  source_filename          text,
  mime_type                text,
  source_hash              text,
  ocr_text                 text,
  transcript_text          text,
  draft_type               text,
  confidence_score         numeric,
  duplicate_of_item_id     uuid,
  job_int_id               bigint,
  job_name                 text,
  source_msg_id            text,
  source_email_id          text,
  dedupe_hash              text,
  created_at               timestamptz  NOT NULL DEFAULT now(),
  updated_at               timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT intake_items_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT intake_items_storage_path_nonempty CHECK (char_length(storage_path) > 0),
  CONSTRAINT intake_items_kind_chk
    CHECK (kind IN ('voice_note','pdf_document','email_lead','unknown')),
  CONSTRAINT intake_items_status_chk
    CHECK (status IN (
      'uploaded','normalized','extracted','validated',
      'pending_review','confirmed','persisted',
      'skipped','duplicate','failed','quarantine'
    )),
  CONSTRAINT intake_items_draft_type_chk
    CHECK (draft_type IS NULL OR draft_type IN ('expense','time','task','revenue','unknown')),
  CONSTRAINT intake_items_confidence_range
    CHECK (confidence_score IS NULL OR (confidence_score >= 0 AND confidence_score <= 1))
);

-- Composite identity UNIQUE (Principle 11) — must be added BEFORE any FK that
-- references intake_items(id, tenant_id, owner_id), including the self-FK below.
-- PG resolves FK target uniqueness eagerly at ALTER TABLE ADD CONSTRAINT time.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'intake_items_identity_unique'
      AND conrelid = 'public.intake_items'::regclass
  ) THEN
    ALTER TABLE public.intake_items
      ADD CONSTRAINT intake_items_identity_unique UNIQUE (id, tenant_id, owner_id);
  END IF;
END $$;

-- Composite FK to intake_batches (Principle 11)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'intake_items_batch_identity_fk'
      AND conrelid = 'public.intake_items'::regclass
  ) THEN
    ALTER TABLE public.intake_items
      ADD CONSTRAINT intake_items_batch_identity_fk
      FOREIGN KEY (batch_id, tenant_id, owner_id)
      REFERENCES public.intake_batches(id, tenant_id, owner_id)
      ON DELETE CASCADE;
  END IF;
END $$;

-- Self-FK for duplicate marking (composite — per Principle 11)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'intake_items_duplicate_of_identity_fk'
      AND conrelid = 'public.intake_items'::regclass
  ) THEN
    ALTER TABLE public.intake_items
      ADD CONSTRAINT intake_items_duplicate_of_identity_fk
      FOREIGN KEY (duplicate_of_item_id, tenant_id, owner_id)
      REFERENCES public.intake_items(id, tenant_id, owner_id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- FK to jobs for job_int_id (simple FK; nullable)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'intake_items_job_fk'
      AND conrelid = 'public.intake_items'::regclass
  ) THEN
    ALTER TABLE public.intake_items
      ADD CONSTRAINT intake_items_job_fk
      FOREIGN KEY (job_int_id) REFERENCES public.jobs(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- Idempotency (Principle 7)
CREATE UNIQUE INDEX IF NOT EXISTS intake_items_owner_source_msg_unique_idx
  ON public.intake_items (owner_id, source_msg_id)
  WHERE source_msg_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS intake_items_owner_dedupe_unique_idx
  ON public.intake_items (owner_id, dedupe_hash)
  WHERE dedupe_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS intake_items_tenant_created_idx
  ON public.intake_items (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS intake_items_owner_status_idx
  ON public.intake_items (owner_id, status);
CREATE INDEX IF NOT EXISTS intake_items_batch_idx
  ON public.intake_items (batch_id);
CREATE INDEX IF NOT EXISTS intake_items_pending_review_idx
  ON public.intake_items (tenant_id, status)
  WHERE status = 'pending_review';
CREATE INDEX IF NOT EXISTS intake_items_duplicate_idx
  ON public.intake_items (duplicate_of_item_id)
  WHERE duplicate_of_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS intake_items_job_idx
  ON public.intake_items (job_int_id)
  WHERE job_int_id IS NOT NULL;

ALTER TABLE public.intake_items ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='intake_items'
                   AND policyname='intake_items_tenant_select') THEN
    CREATE POLICY intake_items_tenant_select
      ON public.intake_items FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='intake_items'
                   AND policyname='intake_items_tenant_insert') THEN
    CREATE POLICY intake_items_tenant_insert
      ON public.intake_items FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='intake_items'
                   AND policyname='intake_items_tenant_update') THEN
    CREATE POLICY intake_items_tenant_update
      ON public.intake_items FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.intake_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.intake_items TO service_role;

-- ============================================================================
-- 3. intake_item_drafts — extracted content (non-receipt only)
--
-- Receipt OCR does NOT flow through this table. See parse_jobs (§3.7) for
-- receipt drafts. draft_kind CHECK enum enforces this at schema level.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.intake_item_drafts (
  id                 uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_item_id     uuid         NOT NULL,
  tenant_id          uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id           text         NOT NULL,
  draft_kind         text         NOT NULL,
  draft_type         text         NOT NULL,
  amount_cents       bigint,
  currency           text,
  vendor             text,
  description        text,
  event_date         date,
  job_int_id         bigint,
  job_name           text,
  raw_model_output   jsonb        NOT NULL DEFAULT '{}'::jsonb,
  validation_flags   jsonb        NOT NULL DEFAULT '[]'::jsonb,
  expense_category   text,
  is_personal        boolean      NOT NULL DEFAULT false,
  payee_name         text,
  confidence_score   numeric,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at         timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT intake_item_drafts_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT intake_item_drafts_draft_kind_chk
    CHECK (draft_kind IN ('voice_transcript','pdf_text','email_body_parse','email_lead_extract')),
  CONSTRAINT intake_item_drafts_draft_type_chk
    CHECK (draft_type IN ('expense','time','task','revenue','unknown')),
  CONSTRAINT intake_item_drafts_amount_nonneg
    CHECK (amount_cents IS NULL OR amount_cents >= 0),
  CONSTRAINT intake_item_drafts_confidence_range
    CHECK (confidence_score IS NULL OR (confidence_score >= 0 AND confidence_score <= 1))
);

-- Composite FK to intake_items (Principle 11)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'intake_item_drafts_item_identity_fk'
      AND conrelid = 'public.intake_item_drafts'::regclass
  ) THEN
    ALTER TABLE public.intake_item_drafts
      ADD CONSTRAINT intake_item_drafts_item_identity_fk
      FOREIGN KEY (intake_item_id, tenant_id, owner_id)
      REFERENCES public.intake_items(id, tenant_id, owner_id)
      ON DELETE CASCADE;
  END IF;
END $$;

-- FK to jobs (simple; nullable)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'intake_item_drafts_job_fk'
      AND conrelid = 'public.intake_item_drafts'::regclass
  ) THEN
    ALTER TABLE public.intake_item_drafts
      ADD CONSTRAINT intake_item_drafts_job_fk
      FOREIGN KEY (job_int_id) REFERENCES public.jobs(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS intake_item_drafts_item_idx
  ON public.intake_item_drafts (intake_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS intake_item_drafts_tenant_idx
  ON public.intake_item_drafts (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS intake_item_drafts_job_idx
  ON public.intake_item_drafts (job_int_id)
  WHERE job_int_id IS NOT NULL;

ALTER TABLE public.intake_item_drafts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='intake_item_drafts'
                   AND policyname='intake_item_drafts_tenant_select') THEN
    CREATE POLICY intake_item_drafts_tenant_select
      ON public.intake_item_drafts FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='intake_item_drafts'
                   AND policyname='intake_item_drafts_tenant_insert') THEN
    CREATE POLICY intake_item_drafts_tenant_insert
      ON public.intake_item_drafts FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='intake_item_drafts'
                   AND policyname='intake_item_drafts_tenant_update') THEN
    CREATE POLICY intake_item_drafts_tenant_update
      ON public.intake_item_drafts FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.intake_item_drafts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.intake_item_drafts TO service_role;

-- ============================================================================
-- 4. intake_item_reviews — action-level audit (append-only)
--
-- Actor FK redesigned to chiefos_portal_users(user_id) per Decision 12 (actors
-- cluster DISCARDed). Column renamed reviewed_by_auth_user_id →
-- reviewed_by_portal_user_id to signal the FK target. Values are identical
-- (portal_users.user_id IS auth.uid()).
--
-- Append-only: authenticated role receives INSERT only. Session 4 adds a
-- BEFORE UPDATE/DELETE trigger that RAISEs EXCEPTION for defense in depth.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.intake_item_reviews (
  id                          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  intake_item_id              uuid         NOT NULL,
  tenant_id                   uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id                    text         NOT NULL,
  reviewed_by_portal_user_id  uuid         NOT NULL,
  action                      text         NOT NULL,
  before_payload              jsonb        NOT NULL DEFAULT '{}'::jsonb,
  after_payload               jsonb        NOT NULL DEFAULT '{}'::jsonb,
  comment                     text,
  correlation_id              uuid         NOT NULL DEFAULT gen_random_uuid(),
  created_at                  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT intake_item_reviews_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT intake_item_reviews_action_chk
    CHECK (action IN ('confirm','reject','edit_confirm','reopen'))
);

-- Composite FK to intake_items (Principle 11)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'intake_item_reviews_item_identity_fk'
      AND conrelid = 'public.intake_item_reviews'::regclass
  ) THEN
    ALTER TABLE public.intake_item_reviews
      ADD CONSTRAINT intake_item_reviews_item_identity_fk
      FOREIGN KEY (intake_item_id, tenant_id, owner_id)
      REFERENCES public.intake_items(id, tenant_id, owner_id)
      ON DELETE CASCADE;
  END IF;
END $$;

-- Actor FK to chiefos_portal_users (Decision 12)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'intake_item_reviews_reviewer_portal_fk'
      AND conrelid = 'public.intake_item_reviews'::regclass
  ) THEN
    ALTER TABLE public.intake_item_reviews
      ADD CONSTRAINT intake_item_reviews_reviewer_portal_fk
      FOREIGN KEY (reviewed_by_portal_user_id)
      REFERENCES public.chiefos_portal_users(user_id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS intake_item_reviews_item_idx
  ON public.intake_item_reviews (intake_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS intake_item_reviews_tenant_idx
  ON public.intake_item_reviews (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS intake_item_reviews_reviewer_idx
  ON public.intake_item_reviews (reviewed_by_portal_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS intake_item_reviews_correlation_idx
  ON public.intake_item_reviews (correlation_id);

ALTER TABLE public.intake_item_reviews ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='intake_item_reviews'
                   AND policyname='intake_item_reviews_tenant_select') THEN
    CREATE POLICY intake_item_reviews_tenant_select
      ON public.intake_item_reviews FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='intake_item_reviews'
                   AND policyname='intake_item_reviews_tenant_insert') THEN
    CREATE POLICY intake_item_reviews_tenant_insert
      ON public.intake_item_reviews FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

-- Append-only: authenticated role gets INSERT and SELECT only (no UPDATE, no DELETE)
GRANT SELECT, INSERT ON public.intake_item_reviews TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.intake_item_reviews TO service_role;

-- ============================================================================
-- Comments
-- ============================================================================
COMMENT ON TABLE public.intake_batches IS
  'Upload session groups for non-receipt intake. Receipt-image batches flow through parse_jobs (§3.7), not this table.';
COMMENT ON TABLE public.intake_items IS
  'One row per uploaded/received non-receipt artifact. kind CHECK excludes receipt_image by design. Composite FK to intake_batches per Principle 11.';
COMMENT ON TABLE public.intake_item_drafts IS
  'Extracted content for non-receipt artifacts (voice transcripts, PDF text, email body parse). Receipt OCR does NOT flow through this table — see parse_jobs (§3.7).';
COMMENT ON TABLE public.intake_item_reviews IS
  'Append-only action-level audit for non-receipt intake decisions. Actor FK points to chiefos_portal_users per Decision 12. Per-field correction audit for receipts lives in parse_corrections (§3.7).';
COMMENT ON COLUMN public.intake_item_drafts.draft_kind IS
  'Source-extraction discriminator: which ingestion pipeline produced this draft. One of voice_transcript/pdf_text/email_body_parse/email_lead_extract. Distinct from draft_type (business-intent classification).';
COMMENT ON COLUMN public.intake_item_reviews.correlation_id IS
  'Stable trace-id for cross-table correlation per §17.21. Auto-assigned to a fresh uuid per review row; callers may override to link to a broader trace.';

COMMIT;
