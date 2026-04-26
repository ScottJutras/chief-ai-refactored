-- Migration: 2026_04_21_rebuild_receipt_pipeline.sql
--
-- MECHANICAL RE-AUTHOR for Foundation Rebuild V2 cold-start application.
--
-- Original migration this re-author replaces:
--   - 2026_04_21_chiefos_parse_pipeline_tables.sql
--
-- ONE deliberate upgrade from the original:
--   parse_corrections.parse_job_id FK is upgraded from simple
--   (parse_job_id → parse_jobs(id)) to composite
--   (parse_job_id, tenant_id, owner_id → parse_jobs(id, tenant_id, owner_id))
--   per Principle 11 (Composite-Key FK Tenant Integrity). The parse_jobs
--   composite UNIQUE (id, tenant_id, owner_id) already exists in the source
--   migration, so the upgrade is mechanical and defense-in-depth.
--
-- Authoritative reference: FOUNDATION_P1_SCHEMA_DESIGN.md §3.7
-- Principle 11 source: FOUNDATION_P1_SCHEMA_DESIGN.md §1.11
--
-- NO other changes from source.
-- ============================================================================
-- ChiefOS Receipt Parser Upgrade — Session 2, Phase 1
-- Parse Pipeline Tables: parse_jobs, vendor_aliases, parse_corrections
--
-- Scope: creates the three receipt-pipeline canonical tables per
--   RECEIPT_PARSER_UPGRADE_HANDOFF.md §5.1, §5.2, §5.3.
--
-- Identity model: dual-boundary per Engineering Constitution §2.
--   tenant_id (uuid) — portal/RLS boundary.
--   owner_id  (text) — ingestion/audit boundary.
-- Never collapsed. All three tables carry both.
--
-- Idempotency: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS,
--   DO-block guarded CREATE POLICY. Safe to run multiple times.
--
-- Dependencies: public.chiefos_tenants, public.chiefos_portal_users.
--   Preflight verifies shape of chiefos_portal_users before creating RLS
--   policies that reference (user_id uuid, tenant_id uuid).
--
-- Creation order: parse_jobs → vendor_aliases → parse_corrections (composite FK).
--
-- Non-scope: quota_* tables ship in Phase 2 (companion migration file
--   YYYY_MM_DD_chiefos_quota_architecture_tables.sql).
-- ============================================================================

BEGIN;

-- ── Preflight: dependencies exist in the expected shape ────────────────────
DO $preflight$
DECLARE
  has_tenants_table      boolean;
  has_portal_users_table boolean;
  has_portal_user_id     boolean;
  has_portal_tenant_id   boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'chiefos_tenants'
  ) INTO has_tenants_table;
  IF NOT has_tenants_table THEN
    RAISE EXCEPTION 'Preflight failed: public.chiefos_tenants missing; tenant_id FK cannot be wired';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'chiefos_portal_users'
  ) INTO has_portal_users_table;
  IF NOT has_portal_users_table THEN
    RAISE EXCEPTION 'Preflight failed: public.chiefos_portal_users missing; RLS policies would ship broken';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'chiefos_portal_users'
      AND column_name = 'user_id' AND data_type = 'uuid'
  ) INTO has_portal_user_id;
  IF NOT has_portal_user_id THEN
    RAISE EXCEPTION 'Preflight failed: chiefos_portal_users.user_id missing or not uuid; RLS policies would ship broken';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'chiefos_portal_users'
      AND column_name = 'tenant_id' AND data_type = 'uuid'
  ) INTO has_portal_tenant_id;
  IF NOT has_portal_tenant_id THEN
    RAISE EXCEPTION 'Preflight failed: chiefos_portal_users.tenant_id missing or not uuid; RLS policies would ship broken';
  END IF;
END
$preflight$;

-- ============================================================================
-- 1. parse_jobs — job-tracking row for each parsed receipt/invoice
--    Per RECEIPT_PARSER_UPGRADE_HANDOFF.md §5.1
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.parse_jobs (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid NOT NULL REFERENCES public.chiefos_tenants(id),
  owner_id                   text NOT NULL,
  user_id                    text,
  source                     text NOT NULL
                               CHECK (source IN ('whatsapp','email','portal','api')),
  source_msg_id              text,
  media_asset_id             uuid NOT NULL,
  attachment_hash            text NOT NULL,
  kind                       text NOT NULL
                               CHECK (kind IN ('receipt','invoice','unknown')),
  normalization_status       text,
  ocr_primary_result         jsonb,
  ocr_primary_confidence     numeric,
  ocr_fallback_result        jsonb,
  ocr_fallback_confidence    numeric,
  llm_auditor_result         jsonb,
  llm_auditor_model          text,
  llm_auditor_provider       text,
  llm_auditor_tokens_in      integer,
  llm_auditor_tokens_out     integer,
  llm_auditor_cached_tokens  integer,
  bypass_reason              text,
  validation_flags           jsonb,
  enrichment_applied         jsonb,
  cil_draft                  jsonb,
  final_confidence           numeric,
  routing_decision           text
                               CHECK (routing_decision IS NULL
                                      OR routing_decision IN ('pending_review','rejected')),
  status                     text NOT NULL DEFAULT 'queued'
                               CHECK (status IN ('queued','processing','completed','failed')),
  error_code                 text,
  error_detail               text,
  trace_id                   text NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  completed_at               timestamptz,
  CONSTRAINT parse_jobs_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT parse_jobs_trace_id_nonempty CHECK (char_length(trace_id) > 0)
);

-- Deferrable unique — allows same-transaction multi-insert patterns (e.g.
-- retry after rollback within a transaction block).
DO $parse_jobs_unique$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'parse_jobs_owner_msg_kind_unique'
      AND conrelid = 'public.parse_jobs'::regclass
  ) THEN
    ALTER TABLE public.parse_jobs
      ADD CONSTRAINT parse_jobs_owner_msg_kind_unique
      UNIQUE (owner_id, source_msg_id, kind)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$parse_jobs_unique$;

CREATE INDEX IF NOT EXISTS parse_jobs_tenant_idx
  ON public.parse_jobs (tenant_id);

CREATE INDEX IF NOT EXISTS parse_jobs_owner_idx
  ON public.parse_jobs (owner_id);

CREATE INDEX IF NOT EXISTS parse_jobs_status_idx
  ON public.parse_jobs (status)
  WHERE status != 'completed';

CREATE INDEX IF NOT EXISTS parse_jobs_routing_idx
  ON public.parse_jobs (routing_decision)
  WHERE routing_decision IS NOT NULL;

CREATE INDEX IF NOT EXISTS parse_jobs_hash_idx
  ON public.parse_jobs (owner_id, attachment_hash);

-- Composite (id, tenant_id, owner_id) unique — redundant for row identity
-- (id alone is PK) but serves as an FK target for dual-boundary propagation.
-- This rebuild re-author USES this composite UNIQUE as the target of the
-- parse_corrections.parse_job_id composite FK (Principle 11 upgrade).
-- See Engineering Constitution §2 (dual-boundary) and quotes-spine precedent.
DO $parse_jobs_identity$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'parse_jobs_identity_unique'
      AND conrelid = 'public.parse_jobs'::regclass
  ) THEN
    ALTER TABLE public.parse_jobs
      ADD CONSTRAINT parse_jobs_identity_unique UNIQUE (id, tenant_id, owner_id);
  END IF;
END
$parse_jobs_identity$;

-- ============================================================================
-- 2. vendor_aliases — tenant-scoped merchant normalization memory
--    Per RECEIPT_PARSER_UPGRADE_HANDOFF.md §5.2
--    Load-bearing: default_job_hint feeds Auto-Assign (§7) and
--                   Suggested-Job Logic (§9).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.vendor_aliases (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES public.chiefos_tenants(id),
  owner_id                 text NOT NULL,
  raw_merchant_normalized  text NOT NULL,
  canonical_merchant       text NOT NULL,
  default_category         text,
  default_tax_treatment    text,
  default_job_hint         text,
  confirmation_count       integer NOT NULL DEFAULT 1
                             CHECK (confirmation_count >= 1),
  last_confirmed_at        timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vendor_aliases_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT vendor_aliases_raw_nonempty CHECK (char_length(raw_merchant_normalized) > 0),
  CONSTRAINT vendor_aliases_canonical_nonempty CHECK (char_length(canonical_merchant) > 0)
);

DO $vendor_aliases_unique$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'vendor_aliases_tenant_raw_unique'
      AND conrelid = 'public.vendor_aliases'::regclass
  ) THEN
    ALTER TABLE public.vendor_aliases
      ADD CONSTRAINT vendor_aliases_tenant_raw_unique
      UNIQUE (tenant_id, raw_merchant_normalized);
  END IF;
END
$vendor_aliases_unique$;

CREATE INDEX IF NOT EXISTS vendor_aliases_tenant_idx
  ON public.vendor_aliases (tenant_id);

CREATE INDEX IF NOT EXISTS vendor_aliases_lookup_idx
  ON public.vendor_aliases (tenant_id, raw_merchant_normalized);

COMMENT ON COLUMN public.vendor_aliases.default_job_hint IS
  'Text-encoded job suggestion hint: literal "active_job" or a specific job_id (integer or uuid as string). Load-bearing for Auto-Assign (handoff §7) and Suggested-Job Logic (handoff §9).';

-- ============================================================================
-- 3. parse_corrections — per-field correction log
--    Per RECEIPT_PARSER_UPGRADE_HANDOFF.md §5.3
--    Writes here feed the vendor_aliases upsert on merchant corrections,
--    building the enrichment moat (§10, "Chief's Confidence").
--
--    REBUILD DELTA from original migration: the FK
--      parse_job_id → parse_jobs(id)
--    is upgraded to the composite dual-boundary form
--      (parse_job_id, tenant_id, owner_id) → parse_jobs(id, tenant_id, owner_id)
--    per Principle 11. Target UNIQUE already exists on parse_jobs. All three
--    columns (parse_job_id, tenant_id, owner_id) are NOT NULL, so MATCH SIMPLE
--    semantics match the simple-FK behavior exactly: every row's
--    (parse_job_id, tenant_id, owner_id) triple must exist on parse_jobs.
--    Defense in depth against a cross-tenant correction row being wedged in
--    via bypass of app-layer tenant checks.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.parse_corrections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES public.chiefos_tenants(id),
  owner_id         text NOT NULL,
  user_id          text,
  parse_job_id     uuid NOT NULL,
  field_name       text NOT NULL,
  original_value   text,
  corrected_value  text NOT NULL,
  original_source  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT parse_corrections_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT parse_corrections_field_name_nonempty CHECK (char_length(field_name) > 0),
  -- Principle 11 upgrade from original migration (simple FK → composite).
  -- Target parse_jobs_identity_unique established above.
  CONSTRAINT parse_corrections_parse_job_identity_fk
    FOREIGN KEY (parse_job_id, tenant_id, owner_id)
    REFERENCES public.parse_jobs(id, tenant_id, owner_id)
);

CREATE INDEX IF NOT EXISTS parse_corrections_tenant_idx
  ON public.parse_corrections (tenant_id);

CREATE INDEX IF NOT EXISTS parse_corrections_job_idx
  ON public.parse_corrections (parse_job_id);

-- ============================================================================
-- 4. Row-Level Security
--    Pattern matches chiefos_quotes_spine and email_ingest precedents.
--    Portal SELECT/INSERT/UPDATE gated by tenant membership via
--    chiefos_portal_users. DELETE not exposed via RLS — service role only,
--    forcing deletes through application code with audit emission.
-- ============================================================================

ALTER TABLE public.parse_jobs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_aliases     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parse_corrections  ENABLE ROW LEVEL SECURITY;

-- parse_jobs policies
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='parse_jobs' AND policyname='parse_jobs_tenant_read') THEN
    CREATE POLICY parse_jobs_tenant_read
      ON public.parse_jobs FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='parse_jobs' AND policyname='parse_jobs_tenant_write') THEN
    CREATE POLICY parse_jobs_tenant_write
      ON public.parse_jobs FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='parse_jobs' AND policyname='parse_jobs_tenant_update') THEN
    CREATE POLICY parse_jobs_tenant_update
      ON public.parse_jobs FOR UPDATE
      USING      (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

-- vendor_aliases policies
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='vendor_aliases' AND policyname='vendor_aliases_tenant_read') THEN
    CREATE POLICY vendor_aliases_tenant_read
      ON public.vendor_aliases FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='vendor_aliases' AND policyname='vendor_aliases_tenant_write') THEN
    CREATE POLICY vendor_aliases_tenant_write
      ON public.vendor_aliases FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='vendor_aliases' AND policyname='vendor_aliases_tenant_update') THEN
    CREATE POLICY vendor_aliases_tenant_update
      ON public.vendor_aliases FOR UPDATE
      USING      (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

-- parse_corrections policies
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='parse_corrections' AND policyname='parse_corrections_tenant_read') THEN
    CREATE POLICY parse_corrections_tenant_read
      ON public.parse_corrections FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='parse_corrections' AND policyname='parse_corrections_tenant_write') THEN
    CREATE POLICY parse_corrections_tenant_write
      ON public.parse_corrections FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

-- ============================================================================
-- 5. Role grants
--    Supabase roles (authenticated, anon, service_role) need explicit table
--    privileges when tables are created by the `postgres` role via a direct
--    migration runner (rather than by `supabase_admin` via the SQL editor,
--    which auto-grants via pg_default_acl). RLS policies above gate row
--    visibility; these grants gate table-level access.
--    GRANT is idempotent — re-running is a no-op.
--
--    Design: service_role has full access; authenticated has the write
--    verbs matching exposed RLS policies (SELECT + INSERT + UPDATE on all
--    three tables; DELETE deliberately not exposed to authenticated and
--    must go through service-role code paths per Engineering Constitution).
--    anon gets no access to these tables.
-- ============================================================================

GRANT SELECT, INSERT, UPDATE ON public.parse_jobs        TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.vendor_aliases    TO authenticated;
GRANT SELECT, INSERT         ON public.parse_corrections TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.parse_jobs        TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vendor_aliases    TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.parse_corrections TO service_role;

-- ============================================================================
-- 6. Table-level comments for future maintainers
-- ============================================================================

COMMENT ON TABLE public.parse_jobs IS
  'Per-receipt/invoice parse job tracking. One row per OCR+auditor pass. Idempotency via UNIQUE (owner_id, source_msg_id, kind). Routing: pending_review or rejected — no auto-accept in this upgrade (handoff §5.1, Plan V2 Session 8).';
COMMENT ON TABLE public.vendor_aliases IS
  'Tenant-scoped merchant normalization memory. Upserted on every owner confirmation via services/parser/correctionFlow.js (future Session 10). confirmation_count increments with each confirm; default_job_hint powers Auto-Assign (handoff §7) and Suggested-Job Logic (§9).';
COMMENT ON TABLE public.parse_corrections IS
  'Per-field correction log. Written when an owner edits a parsed field before confirming. Feeds vendor_aliases upsert for merchant corrections — the enrichment moat. Composite FK (parse_job_id, tenant_id, owner_id) → parse_jobs per Principle 11 (upgraded in rebuild re-author from simple FK).';

COMMIT;
