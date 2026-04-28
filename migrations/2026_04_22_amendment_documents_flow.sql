-- Migration: 2026_04_22_amendment_documents_flow.sql
--
-- PHASE 1 AMENDMENT (Session P1A-1) for Foundation Rebuild V2.
--
-- Gap source: Phase 4.5b Q5 Option A decision
-- (PHASE_4_5_DECISIONS_AND_HANDOFF.md §7-§8 Gap 6).
--
-- Reason: the job_documents + job_document_files flow is the ONLY active
-- quote/contract lifecycle UI in the chiefos-site portal (verified via
-- Phase 4.5b sub-audit: grep of chiefos-site/app returned zero matches for
-- chiefos_quote_*). The Quotes spine is consumed only by WhatsApp CIL
-- handlers. Option A preserves documents flow; Quotes spine stays
-- WhatsApp-only for cutover. Portal Quotes UI migration is deferred to
-- post-cutover development. Founder decision final.
--
-- Supports kinds the Quotes spine doesn't cover today: contracts, invoices,
-- receipts, change_orders — plus PDF upload path (externally-generated
-- documents with signature workflow).
--
-- Authoritative reference: PHASE_4_5_DECISIONS_AND_HANDOFF.md §8 Gap 6.
-- Design pattern: matches Phase 3 Session 3b supporting tables; anon
-- signing RLS matches chiefos_quote_share_tokens / _signatures in the
-- Quotes spine.
--
-- SECURITY NOTE: the unauthenticated /sign/[token]/page.tsx route requires
-- anon role SELECT + UPDATE access gated strictly by signature_token match.
-- signature_token must be cryptographically random (>= 128 bits of entropy)
-- to be safe. The app-layer token generator at /api/documents/send uses
-- crypto.randomUUID() which provides 122 bits of entropy; acceptable under
-- the same security posture as chiefos_quote_share_tokens.token.
--
-- Depends on: public.chiefos_tenants, public.chiefos_portal_users,
-- public.jobs (composite FK), public.customers (composite FK).
-- Apply-order: between P3-3b and P3-4a.
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_tenants') THEN
    RAISE EXCEPTION 'Requires public.chiefos_tenants';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_portal_users') THEN
    RAISE EXCEPTION 'Requires public.chiefos_portal_users';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='jobs') THEN
    RAISE EXCEPTION 'Requires public.jobs';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='customers') THEN
    RAISE EXCEPTION 'Requires public.customers';
  END IF;
END
$preflight$;

-- ============================================================================
-- 1. job_documents — pipeline-stage tracking per job
--
-- Lifecycle stages: lead → quote → contract → active → invoiced.
-- One row per (job, customer) pair; stage advances as quote/contract flow
-- progresses. Parent for job_document_files (actual PDFs).
--
-- Note: jobs.id is integer (serial) per §3.3; job_id here is also integer
-- to match. Composite FK (job_id, tenant_id, owner_id) per Principle 11.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.job_documents (
  id               uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id         text         NOT NULL,
  job_id           integer,
  customer_id      uuid,
  stage            text         NOT NULL DEFAULT 'lead',
  lead_notes       text,
  lead_source      text,
  correlation_id   uuid         NOT NULL DEFAULT gen_random_uuid(),
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT job_documents_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT job_documents_stage_chk
    CHECK (stage IN ('lead','quote','contract','active','invoiced')),
  -- Composite FK to jobs(id, tenant_id, owner_id) per Principle 11. Nullable:
  -- lead-stage rows may not have a job yet (portal creates lead → later links job).
  CONSTRAINT job_documents_job_identity_fk
    FOREIGN KEY (job_id, tenant_id, owner_id)
    REFERENCES public.jobs(id, tenant_id, owner_id)
    ON DELETE SET NULL,
  -- Composite FK to customers per Principle 11. Nullable.
  CONSTRAINT job_documents_customer_identity_fk
    FOREIGN KEY (customer_id, tenant_id, owner_id)
    REFERENCES public.customers(id, tenant_id, owner_id)
    ON DELETE SET NULL
);

-- Composite identity UNIQUE — FK target for job_document_files
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'job_documents_identity_unique'
      AND conrelid = 'public.job_documents'::regclass
  ) THEN
    ALTER TABLE public.job_documents
      ADD CONSTRAINT job_documents_identity_unique UNIQUE (id, tenant_id, owner_id);
  END IF;
END $$;

-- One pipeline row per job (app code upserts rather than creating duplicates).
-- Enforced by partial UNIQUE WHERE job_id IS NOT NULL since nullable job_id
-- allows pre-link lead rows.
CREATE UNIQUE INDEX IF NOT EXISTS job_documents_tenant_job_unique_idx
  ON public.job_documents (tenant_id, job_id)
  WHERE job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS job_documents_tenant_stage_idx
  ON public.job_documents (tenant_id, stage, created_at DESC);
CREATE INDEX IF NOT EXISTS job_documents_tenant_customer_idx
  ON public.job_documents (tenant_id, customer_id)
  WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS job_documents_correlation_idx
  ON public.job_documents (correlation_id);

ALTER TABLE public.job_documents ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='job_documents'
                   AND policyname='job_documents_tenant_select') THEN
    CREATE POLICY job_documents_tenant_select
      ON public.job_documents FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='job_documents'
                   AND policyname='job_documents_tenant_insert') THEN
    CREATE POLICY job_documents_tenant_insert
      ON public.job_documents FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='job_documents'
                   AND policyname='job_documents_tenant_update') THEN
    CREATE POLICY job_documents_tenant_update
      ON public.job_documents FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.job_documents TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_documents TO service_role;

COMMENT ON TABLE public.job_documents IS
  'Pipeline-stage tracking per job (lead → quote → contract → active → invoiced). Parent for job_document_files. Preserved per Phase 4.5b Q5 Option A — documents flow is the only portal quote-lifecycle UI today.';

-- ============================================================================
-- 2. job_document_files — PDF storage + signature workflow
--
-- One row per uploaded document. PDF lives in Supabase Storage; this row
-- holds the metadata + optional signature_token for the public signing flow.
--
-- Public signing flow (from /sign/[token]/page.tsx):
--   1. /api/documents/send UPDATEs signature_token + sent_at + sent_via
--   2. customer visits /sign/<token> — anon SELECT via signature_token match
--      (policy below); fetches signed URL for PDF from Supabase Storage
--   3. customer draws signature on canvas; POSTs base64 PNG to /api/documents/sign
--   4. /api/documents/sign UPDATEs signature_data + signed_at + clears
--      signature_token (anon UPDATE via policy below; WITH CHECK enforces
--      signature_data + signed_at must be set)
--
-- After step 4, signature_token is NULL — row no longer accessible via anon.
-- Only tenant-authenticated reads succeed.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.job_document_files (
  id                         uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id                   text         NOT NULL,
  job_document_id            uuid         NOT NULL,
  job_id                     integer,
  kind                       text         NOT NULL,
  label                      text,
  storage_bucket             text         NOT NULL,
  storage_path               text         NOT NULL,
  signature_token            text,
  signature_data             text,
  signed_at                  timestamptz,
  signed_url_expires_at      timestamptz,
  sent_at                    timestamptz,
  sent_via                   text,
  correlation_id             uuid         NOT NULL DEFAULT gen_random_uuid(),
  created_at                 timestamptz  NOT NULL DEFAULT now(),
  updated_at                 timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT job_document_files_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT job_document_files_kind_chk
    CHECK (kind IN ('quote','contract','change_order','invoice','receipt')),
  CONSTRAINT job_document_files_storage_path_nonempty CHECK (char_length(storage_path) > 0),
  CONSTRAINT job_document_files_sent_via_chk
    CHECK (sent_via IS NULL OR sent_via IN ('email','whatsapp','portal')),
  -- Signed state consistency: signature_data + signed_at move together.
  CONSTRAINT job_document_files_signed_pair
    CHECK ((signature_data IS NULL AND signed_at IS NULL)
           OR (signature_data IS NOT NULL AND signed_at IS NOT NULL)),
  -- Once signed, signature_token MUST be cleared (single-use token).
  CONSTRAINT job_document_files_token_cleared_on_sign
    CHECK (signed_at IS NULL OR signature_token IS NULL),
  -- Composite FK to parent document (Principle 11)
  CONSTRAINT job_document_files_job_document_identity_fk
    FOREIGN KEY (job_document_id, tenant_id, owner_id)
    REFERENCES public.job_documents(id, tenant_id, owner_id)
    ON DELETE CASCADE,
  -- Composite FK to jobs (optional; for convenience queries)
  CONSTRAINT job_document_files_job_identity_fk
    FOREIGN KEY (job_id, tenant_id, owner_id)
    REFERENCES public.jobs(id, tenant_id, owner_id)
    ON DELETE SET NULL
);

-- Composite identity UNIQUE (Principle 11)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'job_document_files_identity_unique'
      AND conrelid = 'public.job_document_files'::regclass
  ) THEN
    ALTER TABLE public.job_document_files
      ADD CONSTRAINT job_document_files_identity_unique UNIQUE (id, tenant_id, owner_id);
  END IF;
END $$;

-- Signature token must be globally unique when present (partial UNIQUE).
-- Same pattern as chiefos_quote_share_tokens.token.
CREATE UNIQUE INDEX IF NOT EXISTS job_document_files_signature_token_unique_idx
  ON public.job_document_files (signature_token)
  WHERE signature_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS job_document_files_tenant_job_document_idx
  ON public.job_document_files (tenant_id, job_document_id);
CREATE INDEX IF NOT EXISTS job_document_files_tenant_kind_idx
  ON public.job_document_files (tenant_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS job_document_files_pending_sign_idx
  ON public.job_document_files (tenant_id, signature_token)
  WHERE signature_token IS NOT NULL AND signed_at IS NULL;

ALTER TABLE public.job_document_files ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- RLS policies for job_document_files
--
-- Standard tenant-membership policies for authenticated (portal UI access).
-- Plus non-standard anon policies for the public signing flow — gated
-- strictly by signature_token + unsigned state + non-expired.
-- ============================================================================

DO $$
BEGIN
  -- Authenticated: tenant-member full CRUD (minus DELETE)
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='job_document_files'
                   AND policyname='job_document_files_tenant_select') THEN
    CREATE POLICY job_document_files_tenant_select
      ON public.job_document_files FOR SELECT
      TO authenticated
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='job_document_files'
                   AND policyname='job_document_files_tenant_insert') THEN
    CREATE POLICY job_document_files_tenant_insert
      ON public.job_document_files FOR INSERT
      TO authenticated
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='job_document_files'
                   AND policyname='job_document_files_tenant_update') THEN
    CREATE POLICY job_document_files_tenant_update
      ON public.job_document_files FOR UPDATE
      TO authenticated
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  -- Anon: public signing flow.
  -- SELECT: only rows with a valid signature_token, not yet signed, not expired.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='job_document_files'
                   AND policyname='job_document_files_anon_sign_select') THEN
    CREATE POLICY job_document_files_anon_sign_select
      ON public.job_document_files FOR SELECT
      TO anon
      USING (
        signature_token IS NOT NULL
        AND signed_at IS NULL
        AND (signed_url_expires_at IS NULL OR signed_url_expires_at > now())
      );
  END IF;

  -- UPDATE: the signing completion — anon can set signature_data + signed_at
  -- and clear signature_token. The CHECK enforces the transition shape.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='job_document_files'
                   AND policyname='job_document_files_anon_sign_update') THEN
    CREATE POLICY job_document_files_anon_sign_update
      ON public.job_document_files FOR UPDATE
      TO anon
      USING (
        signature_token IS NOT NULL
        AND signed_at IS NULL
        AND (signed_url_expires_at IS NULL OR signed_url_expires_at > now())
      )
      WITH CHECK (
        signature_data IS NOT NULL
        AND signed_at IS NOT NULL
      );
  END IF;
END $$;

-- Anon gets narrow SELECT + UPDATE, gated by the policies above.
-- Authenticated gets standard tenant-membership verbs.
-- service_role retains ALL for admin repair and cron.
GRANT SELECT, UPDATE ON public.job_document_files TO anon;
GRANT SELECT, INSERT, UPDATE ON public.job_document_files TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_document_files TO service_role;

COMMENT ON TABLE public.job_document_files IS
  'PDF storage + signature workflow for job_documents. Public signing flow via unauthenticated /sign/[token]/page.tsx — anon role gated by signature_token match (similar to chiefos_quote_share_tokens in Quotes spine). Once signed (signature_data + signed_at set, signature_token NULL), rows become effectively immutable; anon access impossible.';
COMMENT ON COLUMN public.job_document_files.signature_token IS
  'Cryptographically-random single-use bearer token for unauthenticated signing. Cleared when signed. Partial UNIQUE index ensures global uniqueness when present. Generated by /api/documents/send via crypto.randomUUID().';

COMMIT;
