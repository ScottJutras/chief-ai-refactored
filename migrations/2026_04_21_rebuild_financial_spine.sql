-- ============================================================================
-- Foundation Rebuild — Session 1, Part 3: Canonical Financial Spine
--
-- Creates:
--   1. transactions — the ONE ledger of record (38 cols including Decision 10
--      integrity-chain columns). Replaces the legacy expenses, revenue,
--      chiefos_expenses tables (all DISCARDed in Section 6.1).
--   2. file_exports — generated export files with tenant_id added.
--
-- Authoritative sources:
--   - FOUNDATION_P1_SCHEMA_DESIGN.md §3.2 (full design)
--   - Principle 3 (canonical financial spine)
--   - Principle 7 (idempotency via UNIQUE owner_id+source_msg_id+kind)
--   - Principle 11 (composite FK target)
--   - Decision 10 (integrity hash chain as first-class schema property)
--
-- Dependencies:
--   - public.chiefos_tenants (from rebuild_identity_tenancy)
--   - public.media_assets    (from rebuild_media_assets)
--   - Forward-referenced (FKs added in later sessions):
--     * public.jobs          (Session 2) — transactions.job_id
--     * public.parse_jobs    (Session 2 pair, already tested) — transactions.parse_job_id
--     * public.import_batches (Session 2 or 3) — transactions.import_batch_id
--
-- The integrity-chain trigger `chiefos_transactions_integrity_chain_trigger`
-- is authored in Session 4. Until then, the integrity columns are populatable
-- manually or left NULL; the schema is trigger-ready.
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_tenants') THEN
    RAISE EXCEPTION 'Requires public.chiefos_tenants (apply rebuild_identity_tenancy first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='media_assets') THEN
    RAISE EXCEPTION 'Requires public.media_assets (apply rebuild_media_assets first)';
  END IF;
END
$preflight$;

-- ============================================================================
-- transactions — canonical financial ledger
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.transactions (
  -- Identity (Principle 1 — dual-boundary)
  id                       uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id                 text         NOT NULL,
  user_id                  text,

  -- Discriminator and amounts
  kind                     text         NOT NULL,
  amount_cents             bigint       NOT NULL,
  currency                 text         NOT NULL DEFAULT 'CAD',
  subtotal_cents           bigint,
  tax_cents                bigint,
  tax_label                text,

  -- Event details
  date                     date         NOT NULL,
  description              text,
  merchant                 text,
  category                 text,
  is_personal              boolean      NOT NULL DEFAULT false,

  -- Operational links (FKs to jobs/parse_jobs/import_batches added later)
  job_id                   integer,
  job_no                   integer,
  media_asset_id           uuid
    REFERENCES public.media_assets(id) ON DELETE SET NULL,
  parse_job_id             uuid,          -- FK added when parse_jobs migration runs (already tested)
  import_batch_id          uuid,          -- FK added in Session 2

  -- Source attribution (Principle 7)
  source                   text         NOT NULL,
  source_msg_id            text,
  dedupe_hash              text,

  -- Submission lifecycle
  submission_status        text         NOT NULL DEFAULT 'confirmed',
  submitted_by             text,
  reviewed_at              timestamptz,
  reviewer_note            text,

  -- Soft-delete
  deleted_at               timestamptz,
  deleted_by               uuid,

  -- Integrity chain (Decision 10)
  record_hash              text,
  previous_hash            text,
  hash_version             integer      NOT NULL DEFAULT 1,
  hash_input_snapshot      jsonb,

  -- Edit chain (integrity helpers)
  superseded_by            uuid,
  edit_of                  uuid,
  edited_by                text,

  -- Timestamps
  created_at               timestamptz  NOT NULL DEFAULT now(),
  updated_at               timestamptz  NOT NULL DEFAULT now(),

  -- CHECK constraints
  CONSTRAINT transactions_kind_chk
    CHECK (kind IN ('expense','revenue','bill','customer_receipt','change_order','adjustment')),
  CONSTRAINT transactions_submission_status_chk
    CHECK (submission_status IN ('confirmed','pending_review','voided')),
  CONSTRAINT transactions_source_chk
    CHECK (source IN ('whatsapp','portal','email','api','system')),
  CONSTRAINT transactions_currency_chk
    CHECK (currency IN ('CAD','USD')),
  CONSTRAINT transactions_amount_nonneg
    CHECK (amount_cents >= 0),
  CONSTRAINT transactions_owner_id_nonempty
    CHECK (char_length(owner_id) > 0),
  -- Tax breakdown coherence: subtotal and tax are both null or both set
  CONSTRAINT transactions_tax_breakdown_consistency
    CHECK ((subtotal_cents IS NULL AND tax_cents IS NULL) OR
           (subtotal_cents IS NOT NULL AND tax_cents IS NOT NULL)),
  -- Hash version is a positive integer
  CONSTRAINT transactions_hash_version_positive
    CHECK (hash_version >= 1),
  -- Hash format when set
  CONSTRAINT transactions_record_hash_format
    CHECK (record_hash IS NULL OR record_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT transactions_previous_hash_format
    CHECK (previous_hash IS NULL OR previous_hash ~ '^[0-9a-f]{64}$')
);

-- Self-referential FKs for edit chain (deferred — self-refs can be added
-- after the table exists without circular-dep issues)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'transactions_superseded_by_fk'
      AND conrelid = 'public.transactions'::regclass
  ) THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT transactions_superseded_by_fk
      FOREIGN KEY (superseded_by) REFERENCES public.transactions(id)
      ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'transactions_edit_of_fk'
      AND conrelid = 'public.transactions'::regclass
  ) THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT transactions_edit_of_fk
      FOREIGN KEY (edit_of) REFERENCES public.transactions(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- Idempotency spine (Principle 7)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'transactions_owner_msg_kind_unique'
      AND conrelid = 'public.transactions'::regclass
  ) THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT transactions_owner_msg_kind_unique
      UNIQUE (owner_id, source_msg_id, kind)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- Content-based dedupe (partial UNIQUE INDEX since NULLs are common)
CREATE UNIQUE INDEX IF NOT EXISTS transactions_dedupe_hash_unique_idx
  ON public.transactions (owner_id, dedupe_hash)
  WHERE dedupe_hash IS NOT NULL;

-- Integrity hash uniqueness (partial — hash may be null until Session 4 trigger lands)
CREATE UNIQUE INDEX IF NOT EXISTS transactions_record_hash_unique_idx
  ON public.transactions (record_hash)
  WHERE record_hash IS NOT NULL;

-- Composite identity UNIQUE (Principle 11)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'transactions_identity_unique'
      AND conrelid = 'public.transactions'::regclass
  ) THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT transactions_identity_unique UNIQUE (id, tenant_id, owner_id);
  END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS transactions_tenant_kind_date_idx
  ON public.transactions (tenant_id, kind, date DESC);
CREATE INDEX IF NOT EXISTS transactions_owner_date_idx
  ON public.transactions (owner_id, date DESC);
CREATE INDEX IF NOT EXISTS transactions_job_idx
  ON public.transactions (job_id)
  WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS transactions_pending_review_idx
  ON public.transactions (tenant_id, submission_status)
  WHERE submission_status = 'pending_review';
CREATE INDEX IF NOT EXISTS transactions_deleted_idx
  ON public.transactions (tenant_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS transactions_parse_job_idx
  ON public.transactions (parse_job_id)
  WHERE parse_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS transactions_media_asset_idx
  ON public.transactions (media_asset_id)
  WHERE media_asset_id IS NOT NULL;

ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='transactions'
                   AND policyname='transactions_tenant_select') THEN
    CREATE POLICY transactions_tenant_select
      ON public.transactions FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='transactions'
                   AND policyname='transactions_tenant_insert') THEN
    CREATE POLICY transactions_tenant_insert
      ON public.transactions FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='transactions'
                   AND policyname='transactions_tenant_update') THEN
    CREATE POLICY transactions_tenant_update
      ON public.transactions FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='transactions'
                   AND policyname='transactions_owner_board_delete') THEN
    -- DELETE restricted to owner or board_member roles
    CREATE POLICY transactions_owner_board_delete
      ON public.transactions FOR DELETE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                           WHERE user_id = auth.uid() AND role IN ('owner','board_member')));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.transactions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.transactions TO service_role;

COMMENT ON TABLE public.transactions IS
  'Canonical financial spine. Every financial event (expense, revenue, bill, receipt, change_order, adjustment) is one row. Idempotency via UNIQUE (owner_id, source_msg_id, kind) DEFERRABLE. Integrity chain columns populated by chiefos_transactions_integrity_chain_trigger (authored Session 4).';
COMMENT ON COLUMN public.transactions.record_hash IS
  'SHA-256 of canonical serialization of this row + previous_hash of prior row in same tenant. Populated by integrity-chain trigger (Session 4). Must match regex ^[0-9a-f]{64}$ when set.';
COMMENT ON COLUMN public.transactions.previous_hash IS
  'record_hash of the previous row in the same tenant chain. Chain root (first row per tenant) has previous_hash = NULL.';
COMMENT ON COLUMN public.transactions.hash_version IS
  'Version of the canonical-serialization algorithm used to compute record_hash. Allows algorithm evolution without breaking verification of historical chains.';

-- ============================================================================
-- file_exports — generated export files
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.file_exports (
  id               text         PRIMARY KEY,          -- slug identifier (kept text per design §3.2)
  tenant_id        uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id         text         NOT NULL,
  user_id          text,
  filename         text         NOT NULL,
  content_type     text         NOT NULL,
  bytes            bytea        NOT NULL,             -- NOTE: storage-bucket alternative evaluated in Phase 2 security review; bytea preserved for now
  kind             text         NOT NULL DEFAULT 'xlsx',
  quota_consumed   integer      NOT NULL DEFAULT 1,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  expires_at       timestamptz,
  CONSTRAINT file_exports_owner_id_nonempty
    CHECK (char_length(owner_id) > 0),
  CONSTRAINT file_exports_kind_chk
    CHECK (kind IN ('xlsx','pdf','csv','zip')),
  CONSTRAINT file_exports_quota_consumed_positive
    CHECK (quota_consumed > 0)
);

CREATE INDEX IF NOT EXISTS file_exports_tenant_created_idx
  ON public.file_exports (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS file_exports_owner_created_idx
  ON public.file_exports (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS file_exports_expired_idx
  ON public.file_exports (expires_at)
  WHERE expires_at IS NOT NULL;

ALTER TABLE public.file_exports ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='file_exports'
                   AND policyname='file_exports_tenant_select') THEN
    CREATE POLICY file_exports_tenant_select
      ON public.file_exports FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='file_exports'
                   AND policyname='file_exports_tenant_insert') THEN
    CREATE POLICY file_exports_tenant_insert
      ON public.file_exports FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  -- DELETE deliberately service-role only: audit safety
END $$;

GRANT SELECT, INSERT ON public.file_exports TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.file_exports TO service_role;

COMMENT ON TABLE public.file_exports IS
  'Generated export files (XLSX/PDF/CSV/ZIP) held as bytea for download. Tenant-scoped. 30-day expiry via expires_at drives cleanup cron.';

COMMIT;
