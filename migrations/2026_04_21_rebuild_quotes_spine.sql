-- Migration: 2026_04_21_rebuild_quotes_spine.sql
--
-- MECHANICAL RE-AUTHOR for Foundation Rebuild V2 cold-start application.
--
-- Original migrations this re-author replaces (schema byte-identical):
--   - 2026_04_18_chiefos_quotes_spine.sql       (chiefos_quotes + versions + line_items)
--   - 2026_04_18_chiefos_quote_events.sql       (chiefos_quote_events + chiefos_all_events_v)
--   - 2026_04_18_chiefos_quote_share_tokens.sql (chiefos_quote_share_tokens; backfilled qe_share_token_fk)
--   - 2026_04_18_chiefos_quote_signatures.sql   (chiefos_quote_signatures + chiefos_all_signatures_v;
--                                                backfilled qe_signature_identity_fk + qe_identity_unique;
--                                                extended qe_kind_enum + qe_version_scoped_kinds;
--                                                dropped qv/qli write+update policies;
--                                                added qe_payload_name_mismatch_signed CHECK)
--   - 2026_04_19_chiefos_qs_png_storage_key_format.sql
--     (ALTER TABLE adding chiefos_qs_png_storage_key_format CHECK —
--      FOLDED into chiefos_quote_signatures CREATE TABLE in this re-author)
--
-- Counter infrastructure (chiefos_tenant_counters) is NOT in this migration;
-- it is established by the Jobs spine migration (rebuild_jobs_spine.sql,
-- Session P3-2a) in its final generalized (tenant_id, counter_kind) PK form.
-- Quotes spine consumes it at runtime via counter_kind = 'quote'.
--
-- Authoritative reference: FOUNDATION_P1_SCHEMA_DESIGN.md §3.5
-- Production schema commit: 2026-04-21 (Foundation Rebuild §3.5 verification)
--
-- NO redesign. NO new columns. NO constraint changes. Cold-start
-- CREATE TABLE structure only, no ALTER TABLE guards.
--
-- Cold-start deltas from source migrations (all structural, no semantic change):
--   - Preflight blocks that required prior Quotes-spine migrations have become
--     no-ops (the tables genuinely don't exist at cold-start). Preflights that
--     verify EXTERNAL dependencies (chiefos_tenants, chiefos_portal_users,
--     jobs, customers, chiefos_tenant_counters) are PRESERVED.
--   - Preflights that guarded against DOUBLE-APPLY (e.g. "chiefos_qe_share_token_fk
--     already exists") are REMOVED — cold-start cannot re-apply.
--   - Preflights that asserted an empty legacy `public.quotes` /
--     `public.quote_line_items` are REMOVED — those legacy tables do not exist
--     in the rebuilt schema.
--   - The `ALTER TABLE ADD CONSTRAINT chiefos_qe_kind_enum` (signatures
--     migration step 9) is folded into the CREATE TABLE chiefos_quote_events
--     kind CHECK with all 20 values from the start.
--   - The `ALTER TABLE DROP+ADD chiefos_qe_version_scoped_kinds` (signatures
--     migration step 10) is folded into the CREATE TABLE chiefos_quote_events
--     version-scope CHECK with all 16 version-scoped kinds from the start.
--   - The `ALTER TABLE ADD CONSTRAINT chiefos_qe_identity_unique`
--     (signatures migration step 1) is folded into the CREATE TABLE
--     chiefos_quote_events table-level UNIQUE constraint.
--   - The `ALTER TABLE ADD CONSTRAINT chiefos_qe_payload_name_mismatch_signed`
--     (signatures migration step 11) is folded into CREATE TABLE
--     chiefos_quote_events payload-CHECK list.
--   - The `ALTER TABLE ADD CONSTRAINT chiefos_qe_share_token_fk` (share_tokens
--     migration step 6) is folded into CREATE TABLE chiefos_quote_events after
--     chiefos_quote_share_tokens exists (so share_tokens creates BEFORE events
--     in this file's creation order, same as the forward-reference target was
--     resolved in the original migration series).
--   - The `ALTER TABLE ADD CONSTRAINT chiefos_qe_signature_identity_fk`
--     (signatures migration step 8) is folded in the same way.
--   - The `ALTER TABLE chiefos_quote_versions / chiefos_quote_line_items
--     DROP POLICY ...tenant_write, ...tenant_update` (signatures migration
--     step 7) never happens here: those policies are simply not created at all.
--     versions + line_items ship with SELECT-only RLS from the start.
--   - The `ALTER TABLE chiefos_quote_signatures ADD CONSTRAINT
--     chiefos_qs_png_storage_key_format CHECK (...)` (Migration 6) is folded
--     into CREATE TABLE chiefos_quote_signatures constraints. The regex below
--     MUST stay BYTE-IDENTICAL to SIGNATURE_STORAGE_KEY_RE.source in
--     src/cil/quoteSignatureStorage.js.
--
-- Trigger bindings are DEFERRED to Session P3-4 (`rebuild_triggers.sql`). The
-- original source migrations defined CREATE FUNCTION + CREATE TRIGGER pairs
-- for:
--   - public.chiefos_quote_versions_guard_immutable
--   - public.chiefos_quote_line_items_guard_parent_lock
--   - public.chiefos_quotes_guard_header_immutable
--   - public.chiefos_quote_events_guard_immutable
--   - public.chiefos_quote_share_tokens_guard_immutable
--   - public.chiefos_quote_signatures_guard_immutable
-- Per Phase 1 §5, trigger FUNCTIONS live in Session P3-4; per this session's
-- work order, trigger BINDINGS land with the functions in P3-4 too (same
-- pattern as Session 1's transactions integrity-chain trigger). Cold-start
-- apply WITHOUT P3-4 leaves the Quotes spine tables immutability-unenforced;
-- app paths do not write to them until P3-4 ships. Documented as a hard
-- ordering dependency in REBUILD_MIGRATION_MANIFEST.md.
--
-- Drift-detection: the chiefos_qs_png_storage_key_format CHECK regex must
-- stay byte-identical to SIGNATURE_STORAGE_KEY_RE.source in
-- src/cil/quoteSignatureStorage.js. Drift-detection test path updated to
-- reference this file (src/cil/quoteSignatureStorage.test.js:1830).
-- ============================================================================

BEGIN;

-- ── Preflight: dependencies exist in the expected shape ────────────────────
DO $preflight$
DECLARE
  has_pgcrypto       boolean;
  has_tenants        boolean;
  has_portal_users   boolean;
  has_portal_uid     boolean;
  has_portal_tid     boolean;
  has_jobs           boolean;
  has_customers      boolean;
  has_tenant_counters boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto')
    INTO has_pgcrypto;
  IF NOT has_pgcrypto THEN
    RAISE EXCEPTION 'Preflight failed: extension pgcrypto required for gen_random_uuid()';
  END IF;

  SELECT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_tenants')
    INTO has_tenants;
  IF NOT has_tenants THEN
    RAISE EXCEPTION 'Preflight failed: public.chiefos_tenants missing; apply rebuild_identity_tenancy first';
  END IF;

  SELECT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_portal_users')
    INTO has_portal_users;
  IF NOT has_portal_users THEN
    RAISE EXCEPTION 'Preflight failed: public.chiefos_portal_users missing; RLS would ship broken';
  END IF;

  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='chiefos_portal_users'
                   AND column_name='user_id' AND data_type='uuid')
    INTO has_portal_uid;
  IF NOT has_portal_uid THEN
    RAISE EXCEPTION 'Preflight failed: chiefos_portal_users.user_id missing or not uuid';
  END IF;

  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='chiefos_portal_users'
                   AND column_name='tenant_id' AND data_type='uuid')
    INTO has_portal_tid;
  IF NOT has_portal_tid THEN
    RAISE EXCEPTION 'Preflight failed: chiefos_portal_users.tenant_id missing or not uuid';
  END IF;

  SELECT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='jobs')
    INTO has_jobs;
  IF NOT has_jobs THEN
    RAISE EXCEPTION 'Preflight failed: public.jobs missing; apply rebuild_jobs_spine first';
  END IF;

  SELECT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='customers')
    INTO has_customers;
  IF NOT has_customers THEN
    RAISE EXCEPTION 'Preflight failed: public.customers missing; a customers-table rebuild migration must land before the Quotes spine re-author. Tracked as Forward Flag 9 in REBUILD_MIGRATION_MANIFEST.md.';
  END IF;

  SELECT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_tenant_counters')
    INTO has_tenant_counters;
  IF NOT has_tenant_counters THEN
    RAISE EXCEPTION 'Preflight failed: public.chiefos_tenant_counters missing; apply rebuild_jobs_spine first (establishes counters in final generalized form)';
  END IF;
END
$preflight$;

-- ── Table 1: chiefos_quotes (header) ────────────────────────────────────────
CREATE TABLE public.chiefos_quotes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES public.chiefos_tenants(id),
  owner_id            text NOT NULL,
  job_id              integer NOT NULL REFERENCES public.jobs(id),
  customer_id         uuid REFERENCES public.customers(id),
  human_id            text NOT NULL,
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','sent','viewed','signed','locked','voided')),
  current_version_id  uuid,
  source              text NOT NULL DEFAULT 'portal'
                        CHECK (source IN ('portal','whatsapp','email','system')),
  source_msg_id       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  voided_at           timestamptz,
  voided_reason       text,
  CONSTRAINT chiefos_quotes_human_id_unique UNIQUE (tenant_id, human_id),
  CONSTRAINT chiefos_quotes_source_msg_unique UNIQUE (owner_id, source_msg_id),
  -- Composite uniqueness that serves as the FK target for dual-boundary
  -- propagation from versions → quotes. Redundant for row-identity (id alone
  -- is PK) but required by Postgres as a composite-FK referent.
  CONSTRAINT chiefos_quotes_identity_unique UNIQUE (id, tenant_id, owner_id),
  CONSTRAINT chiefos_quotes_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT chiefos_quotes_voided_consistency CHECK (
    (status = 'voided' AND voided_at IS NOT NULL) OR
    (status <> 'voided' AND voided_at IS NULL)
  )
);

CREATE INDEX chiefos_quotes_tenant_status_idx  ON public.chiefos_quotes (tenant_id, status);
CREATE INDEX chiefos_quotes_owner_status_idx   ON public.chiefos_quotes (owner_id, status);
CREATE INDEX chiefos_quotes_job_idx            ON public.chiefos_quotes (job_id);
CREATE INDEX chiefos_quotes_customer_idx       ON public.chiefos_quotes (customer_id) WHERE customer_id IS NOT NULL;

-- ── Table 2: chiefos_quote_versions (append-only versioned snapshots) ──────
CREATE TABLE public.chiefos_quote_versions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NOTE: quote_id FK is defined at the table level as a composite
  -- (quote_id, tenant_id, owner_id) → chiefos_quotes(id, tenant_id, owner_id)
  -- to enforce dual-boundary consistency with the parent. See constraint
  -- chiefos_qv_parent_identity_fk below.
  quote_id              uuid NOT NULL,
  tenant_id             uuid NOT NULL,
  owner_id              text NOT NULL,
  version_no            int NOT NULL CHECK (version_no >= 1),
  status                text NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','sent','viewed','signed','locked')),
  project_title         text NOT NULL,
  project_scope         text,
  currency              text NOT NULL DEFAULT 'CAD' CHECK (currency IN ('CAD','USD')),
  subtotal_cents        bigint NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  tax_cents             bigint NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents           bigint NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  deposit_cents         bigint NOT NULL DEFAULT 0 CHECK (deposit_cents >= 0),
  tax_code              text,
  tax_rate_bps          int NOT NULL DEFAULT 0 CHECK (tax_rate_bps >= 0),
  warranty_snapshot     jsonb NOT NULL DEFAULT '{}'::jsonb,
  clauses_snapshot      jsonb NOT NULL DEFAULT '{}'::jsonb,
  tenant_snapshot       jsonb NOT NULL DEFAULT '{}'::jsonb,
  customer_snapshot     jsonb NOT NULL DEFAULT '{}'::jsonb,
  payment_terms         jsonb NOT NULL DEFAULT '{}'::jsonb,
  warranty_template_ref text,
  clauses_template_ref  text,
  issued_at             timestamptz,
  sent_at               timestamptz,
  viewed_at             timestamptz,
  signed_at             timestamptz,
  locked_at             timestamptz,
  server_hash           text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chiefos_qv_quote_version_unique UNIQUE (quote_id, version_no),
  -- Composite uniqueness that serves as the FK target for dual-boundary
  -- propagation from line_items → versions. Same rationale as on chiefos_quotes.
  CONSTRAINT chiefos_qv_identity_unique UNIQUE (id, tenant_id, owner_id),
  -- Dual-boundary FK to parent: a version's tenant_id and owner_id must match
  -- its parent quote's tenant_id and owner_id. Declarative, no trigger bypass.
  CONSTRAINT chiefos_qv_parent_identity_fk
    FOREIGN KEY (quote_id, tenant_id, owner_id)
    REFERENCES public.chiefos_quotes(id, tenant_id, owner_id)
    ON DELETE RESTRICT,
  CONSTRAINT chiefos_qv_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT chiefos_qv_totals_balance CHECK (total_cents = subtotal_cents + tax_cents),
  CONSTRAINT chiefos_qv_hash_required_on_lock CHECK (locked_at IS NULL OR server_hash IS NOT NULL),
  CONSTRAINT chiefos_qv_hash_format CHECK (server_hash IS NULL OR server_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chiefos_qv_status_locked_consistency CHECK (
    (locked_at IS NOT NULL AND status IN ('signed','locked')) OR
    (locked_at IS NULL AND status NOT IN ('signed','locked'))
  )
);

CREATE INDEX chiefos_qv_quote_vno_idx    ON public.chiefos_quote_versions (quote_id, version_no DESC);
CREATE INDEX chiefos_qv_tenant_idx       ON public.chiefos_quote_versions (tenant_id);
CREATE INDEX chiefos_qv_owner_idx        ON public.chiefos_quote_versions (owner_id);
CREATE INDEX chiefos_qv_locked_idx       ON public.chiefos_quote_versions (locked_at) WHERE locked_at IS NOT NULL;
CREATE INDEX chiefos_qv_status_idx       ON public.chiefos_quote_versions (status);

-- Now that the target table exists, add the header's current_version_id FK.
-- Deferrable so CreateQuote can insert header (current_version_id NULL) then
-- UPDATE to point at v1 within the same transaction. Composite so the pointed-
-- to version is guaranteed to share this header's tenant_id and owner_id.
-- A NULL current_version_id turns the entire FK off (MATCH SIMPLE default).
ALTER TABLE public.chiefos_quotes
  ADD CONSTRAINT chiefos_quotes_current_version_fk
  FOREIGN KEY (current_version_id, tenant_id, owner_id)
  REFERENCES public.chiefos_quote_versions(id, tenant_id, owner_id)
  DEFERRABLE INITIALLY DEFERRED;

-- ── Table 3: chiefos_quote_line_items (per-version line items) ──────────────
CREATE TABLE public.chiefos_quote_line_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NOTE: quote_version_id FK is defined at the table level as a composite
  -- (quote_version_id, tenant_id, owner_id) → chiefos_quote_versions(id,
  -- tenant_id, owner_id) to enforce dual-boundary consistency with the parent
  -- version. See constraint chiefos_qli_parent_identity_fk below.
  quote_version_id    uuid NOT NULL,
  tenant_id           uuid NOT NULL,
  owner_id            text NOT NULL,
  sort_order          int NOT NULL DEFAULT 0,
  description         text NOT NULL,
  category            text CHECK (category IS NULL OR category IN ('labour','materials','other')),
  qty                 numeric(18,3) NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_price_cents    bigint NOT NULL CHECK (unit_price_cents >= 0),
  line_subtotal_cents bigint NOT NULL CHECK (line_subtotal_cents >= 0),
  line_tax_cents      bigint NOT NULL DEFAULT 0 CHECK (line_tax_cents >= 0),
  tax_code            text,
  catalog_product_id  uuid,
  catalog_snapshot    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Dual-boundary FK to parent version: line item's tenant_id and owner_id
  -- must match the parent version's tenant_id and owner_id.
  CONSTRAINT chiefos_qli_parent_identity_fk
    FOREIGN KEY (quote_version_id, tenant_id, owner_id)
    REFERENCES public.chiefos_quote_versions(id, tenant_id, owner_id)
    ON DELETE RESTRICT,
  CONSTRAINT chiefos_qli_owner_id_nonempty CHECK (char_length(owner_id) > 0)
);

CREATE INDEX chiefos_qli_version_order_idx  ON public.chiefos_quote_line_items (quote_version_id, sort_order);
CREATE INDEX chiefos_qli_tenant_version_idx ON public.chiefos_quote_line_items (tenant_id, quote_version_id);
CREATE INDEX chiefos_qli_owner_version_idx  ON public.chiefos_quote_line_items (owner_id, quote_version_id);
CREATE INDEX chiefos_qli_catalog_idx        ON public.chiefos_quote_line_items (catalog_product_id) WHERE catalog_product_id IS NOT NULL;

-- Note on catalog_product_id: no FK to catalog_products(id). Per the standalone
-- handoff §4 and the catalog_quote.sql precedent, we deliberately keep the
-- snapshot frozen even if the catalog row is later deleted or altered.

-- ── Global sequence for event ordering (gaps-OK, contention-free) ──────────
CREATE SEQUENCE public.chiefos_events_global_seq
  START WITH 1
  INCREMENT BY 1
  NO MAXVALUE
  CACHE 32;

-- ── Table 4: chiefos_quote_share_tokens (created BEFORE events so that the
--    events.share_token_id FK can be CREATE-time declarative rather than a
--    post-create ALTER backfill) ──────────────────────────────────────────
-- This reorders original migration 2 (events) / migration 3 (share_tokens)
-- vs. their apply sequence. Semantically identical: the original migration 3
-- added the share_token_id FK to events via ALTER; this re-author defines the
-- FK inline on events after share_tokens already exists.
CREATE TABLE public.chiefos_quote_share_tokens (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL,
  owner_id                    text NOT NULL,

  -- Target version. quote_id is derivable via JOIN to chiefos_quote_versions;
  -- not denormalized here to avoid cross-row consistency drift.
  quote_version_id            uuid NOT NULL,

  -- The opaque bearer credential. Application-generated via Node
  -- `crypto.randomBytes(16)` encoded base58 (Bitcoin alphabet). The DB CHECK
  -- below refuses malformed tokens, guarding against future bypass attempts.
  token                       text NOT NULL UNIQUE,

  -- Recipient snapshot (captured at SendQuote time; immutable post-insert).
  -- See §14.2 of the decisions log. Not access control — audit metadata.
  recipient_name              text NOT NULL,
  recipient_channel           text NOT NULL,
  recipient_address           text NOT NULL,
  recipient_metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Lifecycle timestamps (state is derived from these, no enum column).
  issued_at                   timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at         timestamptz NOT NULL,
  revoked_at                  timestamptz,
  revoked_reason              text,
  superseded_at               timestamptz,
  superseded_by_version_id    uuid,

  -- Idempotency for SendQuote CIL retries.
  source_msg_id               text,

  created_at                  timestamptz NOT NULL DEFAULT now(),

  -- ── Token format: 22 chars, base58 (Bitcoin alphabet, no 0/O/I/l) ───────
  CONSTRAINT chiefos_qst_token_format CHECK (
    char_length(token) = 22
    AND token ~ '^[1-9A-HJ-NP-Za-km-z]+$'
  ),

  -- ── Owner nonempty ──────────────────────────────────────────────────────
  CONSTRAINT chiefos_qst_owner_id_nonempty CHECK (char_length(owner_id) > 0),

  -- ── Recipient snapshot constraints ──────────────────────────────────────
  CONSTRAINT chiefos_qst_recipient_name_nonempty CHECK (char_length(recipient_name) > 0),
  CONSTRAINT chiefos_qst_recipient_address_nonempty CHECK (char_length(recipient_address) > 0),
  CONSTRAINT chiefos_qst_recipient_channel_enum CHECK (
    recipient_channel IN ('email','whatsapp','sms')
  ),
  CONSTRAINT chiefos_qst_recipient_email_format CHECK (
    recipient_channel <> 'email'
    OR recipient_address ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
  ),
  CONSTRAINT chiefos_qst_recipient_phone_format CHECK (
    recipient_channel NOT IN ('whatsapp','sms')
    OR recipient_address ~ '^\+[1-9][0-9]{6,14}$'
  ),

  -- ── Absolute expiry must be strictly after issue ────────────────────────
  CONSTRAINT chiefos_qst_expiry_after_issue CHECK (absolute_expires_at > issued_at),

  -- ── Terminal exclusivity: a token is revoked OR superseded, not both ────
  CONSTRAINT chiefos_qst_terminal_exclusive CHECK (
    NOT (revoked_at IS NOT NULL AND superseded_at IS NOT NULL)
  ),

  -- ── revoked_at and revoked_reason must be set/cleared together ──────────
  CONSTRAINT chiefos_qst_revoked_pair CHECK (
    (revoked_at IS NULL AND revoked_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL)
  ),

  -- ── revoked_reason minimum length when populated ────────────────────────
  CONSTRAINT chiefos_qst_revoked_reason_nonempty CHECK (
    revoked_reason IS NULL OR char_length(revoked_reason) >= 3
  ),

  -- ── superseded_at and superseded_by_version_id must be set/cleared together
  CONSTRAINT chiefos_qst_superseded_pair CHECK (
    (superseded_at IS NULL AND superseded_by_version_id IS NULL)
    OR (superseded_at IS NOT NULL AND superseded_by_version_id IS NOT NULL)
  ),

  -- ── Composite uniqueness (FK target for events.share_token_id backfill
  --    and for future signatures.share_token_id if we promote that FK) ────
  CONSTRAINT chiefos_qst_identity_unique UNIQUE (id, tenant_id, owner_id),

  -- ── Dual-boundary FK to parent version ──────────────────────────────────
  CONSTRAINT chiefos_qst_version_identity_fk
    FOREIGN KEY (quote_version_id, tenant_id, owner_id)
    REFERENCES public.chiefos_quote_versions(id, tenant_id, owner_id)
    ON DELETE RESTRICT,

  -- ── Dual-boundary composite FK on superseded_by_version_id ──────────────
  -- When superseded_by_version_id IS NULL, MATCH SIMPLE skips the FK.
  -- When populated, this enforces that the superseding version shares the
  -- same tenant_id + owner_id as the token. Catches cross-tenant
  -- supersession at the schema layer.
  CONSTRAINT chiefos_qst_superseded_by_identity_fk
    FOREIGN KEY (superseded_by_version_id, tenant_id, owner_id)
    REFERENCES public.chiefos_quote_versions(id, tenant_id, owner_id)
    ON DELETE RESTRICT
);

-- Partial unique for idempotency on SendQuote retries
CREATE UNIQUE INDEX chiefos_qst_source_msg_unique
  ON public.chiefos_quote_share_tokens (owner_id, source_msg_id)
  WHERE source_msg_id IS NOT NULL;

-- Query indexes (hot path URL→token lookup is covered by UNIQUE (token))
CREATE INDEX chiefos_qst_tenant_issued_idx
  ON public.chiefos_quote_share_tokens (tenant_id, issued_at DESC);
CREATE INDEX chiefos_qst_owner_issued_idx
  ON public.chiefos_quote_share_tokens (owner_id, issued_at DESC);
CREATE INDEX chiefos_qst_version_idx
  ON public.chiefos_quote_share_tokens (quote_version_id);
-- Expiry cron scan: "tokens past expiry that haven't been terminal-marked".
CREATE INDEX chiefos_qst_expiry_cron_idx
  ON public.chiefos_quote_share_tokens (absolute_expires_at)
  WHERE revoked_at IS NULL AND superseded_at IS NULL;

-- ── Table 5: chiefos_quote_signatures (created BEFORE events so that
--    events.signature_id FK can be CREATE-time declarative) ─────────────────
-- Same reordering rationale as chiefos_quote_share_tokens above.
-- The chiefos_qs_png_storage_key_format CHECK (original Migration 6) is
-- FOLDED into this CREATE TABLE. The regex below is BYTE-IDENTICAL to
-- SIGNATURE_STORAGE_KEY_RE.source in src/cil/quoteSignatureStorage.js.
-- Drift is a §25 violation and is caught by the test at
-- src/cil/quoteSignatureStorage.test.js:1830 (path updated this session).
CREATE TABLE public.chiefos_quote_signatures (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_version_id            uuid NOT NULL,
  tenant_id                   uuid NOT NULL,
  owner_id                    text NOT NULL,

  -- Event binding (real FK, composite, from day one — events shipped first
  -- in the original migration series; in this re-author, events come AFTER
  -- signatures, so the FK target is added via ALTER after events is created).
  signed_event_id             uuid NOT NULL,

  -- Share-token binding (composite dual-boundary, NOT NULL — every Beta
  -- signature comes from a customer-token sign ceremony; future non-ceremony
  -- paths require explicit schema change, by design).
  share_token_id              uuid NOT NULL,

  -- Signer identity (audit metadata, not access control).
  signer_name                 text NOT NULL,
  signer_email                text,
  signer_ip                   text,
  signer_user_agent           text,

  signed_at                   timestamptz NOT NULL DEFAULT now(),

  -- Signature PNG artifact: stored in Supabase Storage; row carries the
  -- storage key + content SHA-256 for tamper-evident integrity.
  signature_png_storage_key   text NOT NULL,
  signature_png_sha256        text NOT NULL,

  -- Integrity binding: server_hash of the parent version at sign time.
  -- Belt-and-suspenders: if anything ever bypassed the version immutability
  -- trigger, the signature row still records what the customer signed against.
  version_hash_at_sign        text NOT NULL,

  -- Name-match step-up (app-layer rule; DB stores flag + recipient snapshot).
  name_match_at_sign          boolean NOT NULL DEFAULT false,
  recipient_name_at_sign      text NOT NULL,

  -- Idempotency for SignQuote CIL retries.
  source_msg_id               text,

  created_at                  timestamptz NOT NULL DEFAULT now(),

  -- ── Structural constraints ─────────────────────────────────────────────
  CONSTRAINT chiefos_qs_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT chiefos_qs_signer_name_nonempty CHECK (char_length(signer_name) > 0),
  CONSTRAINT chiefos_qs_recipient_name_at_sign_nonempty CHECK (char_length(recipient_name_at_sign) > 0),
  CONSTRAINT chiefos_qs_png_storage_key_nonempty CHECK (char_length(signature_png_storage_key) > 0),
  CONSTRAINT chiefos_qs_png_sha256_format CHECK (signature_png_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chiefos_qs_version_hash_format CHECK (version_hash_at_sign ~ '^[0-9a-f]{64}$'),
  -- ── Storage key format (FOLDED from Migration 6 — byte-identical regex) ─
  CONSTRAINT chiefos_qs_png_storage_key_format CHECK (
    signature_png_storage_key ~ '^chiefos-signatures/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$'
  ),

  -- ── Uniqueness ──────────────────────────────────────────────────────────
  -- Strictly one signature per version (multi-party sign is a future v2 schema change).
  CONSTRAINT chiefos_qs_version_unique UNIQUE (quote_version_id),
  -- Composite identity unique: FK target for any future cross-table reference.
  CONSTRAINT chiefos_qs_identity_unique UNIQUE (id, tenant_id, owner_id),

  -- ── Composite dual-boundary FKs ─────────────────────────────────────────
  CONSTRAINT chiefos_qs_version_identity_fk
    FOREIGN KEY (quote_version_id, tenant_id, owner_id)
    REFERENCES public.chiefos_quote_versions(id, tenant_id, owner_id)
    ON DELETE RESTRICT,
  -- chiefos_qs_signed_event_identity_fk: deferred. Target (chiefos_quote_events)
  -- is created AFTER this table in the re-author. ALTER TABLE below adds it
  -- once events exists. Original migration 4 declared it inline because events
  -- was shipped ahead.
  CONSTRAINT chiefos_qs_share_token_identity_fk
    FOREIGN KEY (share_token_id, tenant_id, owner_id)
    REFERENCES public.chiefos_quote_share_tokens(id, tenant_id, owner_id)
    ON DELETE RESTRICT
);

-- Partial unique for idempotency on SignQuote retries
CREATE UNIQUE INDEX chiefos_qs_source_msg_unique
  ON public.chiefos_quote_signatures (owner_id, source_msg_id)
  WHERE source_msg_id IS NOT NULL;

-- Query indexes
CREATE INDEX chiefos_qs_tenant_signed_idx
  ON public.chiefos_quote_signatures (tenant_id, signed_at DESC);
CREATE INDEX chiefos_qs_owner_signed_idx
  ON public.chiefos_quote_signatures (owner_id, signed_at DESC);
CREATE INDEX chiefos_qs_version_idx
  ON public.chiefos_quote_signatures (quote_version_id);
CREATE INDEX chiefos_qs_event_idx
  ON public.chiefos_quote_signatures (signed_event_id);
CREATE INDEX chiefos_qs_share_token_idx
  ON public.chiefos_quote_signatures (tenant_id, share_token_id);

-- ── Table 6: chiefos_quote_events (append-only audit stream) ───────────────
-- At cold-start, events is created AFTER share_tokens and signatures exist,
-- so both share_token_id and signature_id FKs can be CREATE-time declarative.
-- The kind enum includes all 20 values (merged from original migrations 2 + 4).
-- The version-scoped-kinds CHECK includes all 16 (merged).
-- chiefos_qe_identity_unique UNIQUE (originally added via ALTER by migration 4
-- to enable composite FK targeting from signatures) is folded into CREATE.
-- chiefos_qe_payload_name_mismatch_signed CHECK (originally migration 4 step 11)
-- is folded into the payload-CHECK list.
CREATE TABLE public.chiefos_quote_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_seq            bigint NOT NULL DEFAULT nextval('public.chiefos_events_global_seq'),
  tenant_id             uuid NOT NULL,
  owner_id              text NOT NULL,

  -- Parent references: quote_id always NOT NULL; quote_version_id NOT NULL
  -- only for version-scoped events (enforced by scope CHECKs below).
  quote_id              uuid NOT NULL,
  quote_version_id      uuid,

  -- Kind taxonomy: {category}.{action}, with a generated `category` column for
  -- indexing. Single source of truth is `kind`; `category` is derived.
  kind                  text NOT NULL,
  category              text GENERATED ALWAYS AS (split_part(kind, '.', 1)) STORED,

  -- Promoted FK columns (the only references lifted out of payload per the
  -- principle: "stable references to constitutional rows get real FKs").
  signature_id          uuid,
  share_token_id        uuid,
  triggered_by_event_id uuid,
  customer_id           uuid REFERENCES public.customers(id) ON DELETE RESTRICT,

  -- Payload: structured JSONB with per-kind CHECK constraints below enforcing
  -- required keys. Structure only; content validation is not DB-enforced.
  payload               jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Actor attribution.
  actor_user_id         text,
  actor_source          text NOT NULL
                          CHECK (actor_source IN ('portal','whatsapp','email','system','webhook','cron','admin')),
  correlation_id        uuid,

  -- Idempotency for webhook retries.
  external_event_id     text,

  -- Timestamps: emitted_at = when the event semantically happened (may come
  -- from a third-party webhook); created_at = when ChiefOS persisted the row.
  -- Ordering uses global_seq; timestamps are metadata.
  emitted_at            timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),

  -- Forward-plan column for hash-chained audit trail. Unused in this
  -- migration; a later migration populates and verifies. Column exists now
  -- to avoid a disruptive schema change later. See decisions log §12c.
  prev_event_hash       text,

  -- ── Identity / dual-boundary uniqueness ─────────────────────────────────
  CONSTRAINT chiefos_qe_global_seq_unique UNIQUE (global_seq),
  -- Folded from original migration 4 step 1: composite identity UNIQUE so
  -- chiefos_quote_signatures.signed_event_id can target (id, tenant_id, owner_id).
  CONSTRAINT chiefos_qe_identity_unique UNIQUE (id, tenant_id, owner_id),
  CONSTRAINT chiefos_qe_owner_id_nonempty CHECK (char_length(owner_id) > 0),

  -- ── Kind enum (closed; all 20 values merged from migrations 2 + 4) ──────
  CONSTRAINT chiefos_qe_kind_enum CHECK (kind IN (
    'lifecycle.created',
    'lifecycle.version_created',
    'lifecycle.sent',
    'lifecycle.customer_viewed',
    'lifecycle.signed',
    'lifecycle.locked',
    'lifecycle.voided',
    'notification.queued',
    'notification.sent',
    'notification.delivered',
    'notification.opened',
    'notification.bounced',
    'notification.failed',
    'share_token.issued',
    'share_token.accessed',
    'share_token.revoked',
    'share_token.expired',
    'integrity.sign_attempt_failed',
    'integrity.admin_corrected',
    'integrity.name_mismatch_signed'
  )),

  -- ── Category enum (belt-and-suspenders against malformed future kinds) ──
  CONSTRAINT chiefos_qe_category_enum CHECK (
    category IN ('lifecycle','notification','share_token','integrity')
  ),

  -- ── actor_source='admin' reserved for admin-initiated corrections only ──
  CONSTRAINT chiefos_qe_admin_source_scope CHECK (
    actor_source <> 'admin' OR kind = 'integrity.admin_corrected'
  ),

  -- ── Timestamp sanity: emitted_at must be in a reasonable window ─────────
  -- Lower bound catches obvious garbage (1970, 2001, etc.). Upper bound
  -- allows for reasonable clock skew between third-party servers and ours
  -- (7 days covers Postmark's worst documented skew comfortably).
  CONSTRAINT chiefos_qe_emitted_at_sane CHECK (
    emitted_at > '2024-01-01'::timestamptz
    AND emitted_at < created_at + interval '7 days'
  ),

  -- ── Hash format (forward-plan; NULL until populated by chain migration) ──
  CONSTRAINT chiefos_qe_prev_hash_format CHECK (
    prev_event_hash IS NULL OR prev_event_hash ~ '^[0-9a-f]{64}$'
  ),

  -- ── Dual-boundary composite FKs ─────────────────────────────────────────
  CONSTRAINT chiefos_qe_quote_identity_fk
    FOREIGN KEY (quote_id, tenant_id, owner_id)
    REFERENCES public.chiefos_quotes(id, tenant_id, owner_id)
    ON DELETE RESTRICT,
  CONSTRAINT chiefos_qe_version_identity_fk
    FOREIGN KEY (quote_version_id, tenant_id, owner_id)
    REFERENCES public.chiefos_quote_versions(id, tenant_id, owner_id)
    ON DELETE RESTRICT,

  -- Share-token FK (declarative at CREATE since share_tokens already exists
  -- in this re-author's creation order). Original migration 3 added this via
  -- post-create ALTER; semantically equivalent.
  CONSTRAINT chiefos_qe_share_token_fk
    FOREIGN KEY (share_token_id)
    REFERENCES public.chiefos_quote_share_tokens(id)
    ON DELETE RESTRICT,

  -- Signature composite FK (declarative at CREATE since signatures already
  -- exists in this re-author's creation order). Original migration 4 added
  -- this via post-create ALTER. Composite dual-boundary form preserved.
  CONSTRAINT chiefos_qe_signature_identity_fk
    FOREIGN KEY (signature_id, tenant_id, owner_id)
    REFERENCES public.chiefos_quote_signatures(id, tenant_id, owner_id)
    ON DELETE RESTRICT,

  -- ── Self-reference for causal chains (immediate FK; NULL permitted for
  --    out-of-order webhook cases backfilled later by a worker) ────────────
  CONSTRAINT chiefos_qe_triggered_by_fk
    FOREIGN KEY (triggered_by_event_id)
    REFERENCES public.chiefos_quote_events(id)
    ON DELETE RESTRICT,

  -- ── Scope enforcement: version-scoped vs quote-scoped kinds ─────────────
  -- All 16 version-scoped kinds merged from migrations 2 + 4.
  CONSTRAINT chiefos_qe_version_scoped_kinds CHECK (
    kind NOT IN (
      'lifecycle.version_created','lifecycle.sent','lifecycle.customer_viewed',
      'lifecycle.signed','lifecycle.locked',
      'notification.queued','notification.sent','notification.delivered',
      'notification.opened','notification.bounced','notification.failed',
      'share_token.issued','share_token.accessed','share_token.revoked','share_token.expired',
      'integrity.sign_attempt_failed',
      'integrity.name_mismatch_signed'
    ) OR quote_version_id IS NOT NULL
  ),
  CONSTRAINT chiefos_qe_quote_scoped_kinds CHECK (
    kind NOT IN ('lifecycle.created','lifecycle.voided','integrity.admin_corrected')
    OR quote_version_id IS NULL
  ),

  -- ── Per-kind payload CHECKs (structure only, not content validation) ────
  CONSTRAINT chiefos_qe_payload_version_created CHECK (
    kind <> 'lifecycle.version_created'
    OR (payload ? 'version_no' AND payload ? 'trigger_source'
        AND payload->>'trigger_source' IN ('initial','edit','reissue'))
  ),
  CONSTRAINT chiefos_qe_payload_sent CHECK (
    kind <> 'lifecycle.sent'
    OR (payload ? 'recipient_channel' AND payload ? 'recipient_address'
        AND payload->>'recipient_channel' IN ('email','whatsapp','sms')
        AND share_token_id IS NOT NULL)
  ),
  CONSTRAINT chiefos_qe_payload_customer_viewed CHECK (
    kind <> 'lifecycle.customer_viewed'
    OR share_token_id IS NOT NULL
  ),
  CONSTRAINT chiefos_qe_payload_signed CHECK (
    kind <> 'lifecycle.signed'
    OR (signature_id IS NOT NULL AND payload ? 'version_hash_at_sign'
        AND (payload->>'version_hash_at_sign') ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT chiefos_qe_payload_voided CHECK (
    kind <> 'lifecycle.voided' OR (payload ? 'voided_reason')
  ),
  CONSTRAINT chiefos_qe_payload_notification CHECK (
    category <> 'notification'
    OR (payload ? 'channel' AND payload ? 'recipient'
        AND payload->>'channel' IN ('email','whatsapp','sms'))
  ),
  CONSTRAINT chiefos_qe_payload_notification_with_provider CHECK (
    kind NOT IN ('notification.sent','notification.delivered','notification.opened',
                 'notification.bounced','notification.failed')
    OR (payload ? 'provider_message_id')
  ),
  CONSTRAINT chiefos_qe_payload_share_token CHECK (
    category <> 'share_token' OR share_token_id IS NOT NULL
  ),
  CONSTRAINT chiefos_qe_payload_share_token_accessed CHECK (
    kind <> 'share_token.accessed' OR (payload ? 'access_ordinal')
  ),
  CONSTRAINT chiefos_qe_payload_sign_attempt_failed CHECK (
    kind <> 'integrity.sign_attempt_failed' OR (payload ? 'failure_reason')
  ),
  CONSTRAINT chiefos_qe_payload_admin_corrected CHECK (
    kind <> 'integrity.admin_corrected'
    OR (payload ? 'admin_user_id' AND payload ? 'correction_description')
  ),
  -- Folded from original migration 4 step 11:
  CONSTRAINT chiefos_qe_payload_name_mismatch_signed CHECK (
    kind <> 'integrity.name_mismatch_signed'
    OR (signature_id IS NOT NULL AND payload ? 'rule_id')
  )
);

-- Partial unique index for webhook-retry idempotency
-- Explicit partial scope: uniqueness enforced only for rows with an external ID.
-- Internal events (external_event_id IS NULL) never collide on this index.
CREATE UNIQUE INDEX chiefos_qe_external_event_unique
  ON public.chiefos_quote_events (owner_id, external_event_id)
  WHERE external_event_id IS NOT NULL;

-- Query indexes
CREATE INDEX chiefos_qe_tenant_seq_idx       ON public.chiefos_quote_events (tenant_id, global_seq DESC);
CREATE INDEX chiefos_qe_owner_seq_idx        ON public.chiefos_quote_events (owner_id, global_seq DESC);
CREATE INDEX chiefos_qe_quote_seq_idx        ON public.chiefos_quote_events (quote_id, global_seq DESC);
CREATE INDEX chiefos_qe_version_seq_idx      ON public.chiefos_quote_events (quote_version_id, global_seq DESC)
  WHERE quote_version_id IS NOT NULL;
CREATE INDEX chiefos_qe_tenant_category_idx  ON public.chiefos_quote_events (tenant_id, category);
CREATE INDEX chiefos_qe_tenant_kind_idx      ON public.chiefos_quote_events (tenant_id, kind);
CREATE INDEX chiefos_qe_emitted_at_idx       ON public.chiefos_quote_events (emitted_at DESC);
CREATE INDEX chiefos_qe_signature_idx        ON public.chiefos_quote_events (tenant_id, signature_id)
  WHERE signature_id IS NOT NULL;
CREATE INDEX chiefos_qe_share_token_idx      ON public.chiefos_quote_events (tenant_id, share_token_id)
  WHERE share_token_id IS NOT NULL;
CREATE INDEX chiefos_qe_customer_idx         ON public.chiefos_quote_events (tenant_id, customer_id)
  WHERE customer_id IS NOT NULL;
CREATE INDEX chiefos_qe_triggered_by_idx     ON public.chiefos_quote_events (triggered_by_event_id)
  WHERE triggered_by_event_id IS NOT NULL;
CREATE INDEX chiefos_qe_correlation_idx      ON public.chiefos_quote_events (correlation_id)
  WHERE correlation_id IS NOT NULL;
-- GIN on payload for JSONB containment queries (provider_message_id lookup, etc.).
CREATE INDEX chiefos_qe_payload_gin          ON public.chiefos_quote_events USING GIN (payload);

-- Now that events exists, add the deferred signed_event_id composite FK on
-- signatures. Original migration 4 declared this inline because events was
-- shipped ahead; in this re-author, events is created after signatures, so
-- the FK is added via ALTER here. Semantically equivalent.
ALTER TABLE public.chiefos_quote_signatures
  ADD CONSTRAINT chiefos_qs_signed_event_identity_fk
  FOREIGN KEY (signed_event_id, tenant_id, owner_id)
  REFERENCES public.chiefos_quote_events(id, tenant_id, owner_id)
  ON DELETE RESTRICT;

-- ── RLS ────────────────────────────────────────────────────────────────────
-- Tight pattern per §11.0: audit-terminal tables (versions, line_items,
-- events, share_tokens, signatures) get SELECT-only RLS at cold-start.
-- Writes go through backend service-role code paths that bypass RLS.
-- The header (chiefos_quotes) keeps SELECT + INSERT + UPDATE for the portal
-- builder UI (future-scope).
ALTER TABLE public.chiefos_quotes              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chiefos_quote_versions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chiefos_quote_line_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chiefos_quote_share_tokens  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chiefos_quote_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chiefos_quote_signatures    ENABLE ROW LEVEL SECURITY;

-- chiefos_quotes: SELECT + INSERT + UPDATE (portal-writable header)
CREATE POLICY chiefos_quotes_tenant_read
  ON public.chiefos_quotes FOR SELECT
  USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));

CREATE POLICY chiefos_quotes_tenant_write
  ON public.chiefos_quotes FOR INSERT
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));

CREATE POLICY chiefos_quotes_tenant_update
  ON public.chiefos_quotes FOR UPDATE
  USING  (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));

-- chiefos_quote_versions: SELECT only (§11.0 tight pattern; migration 4
-- dropped the write/update policies that migration 1 had created; cold-start
-- simply never creates them)
CREATE POLICY chiefos_qv_tenant_read
  ON public.chiefos_quote_versions FOR SELECT
  USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));

-- chiefos_quote_line_items: SELECT only (same reasoning)
CREATE POLICY chiefos_qli_tenant_read
  ON public.chiefos_quote_line_items FOR SELECT
  USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));

-- chiefos_quote_events: SELECT only (migration 2 policy)
CREATE POLICY chiefos_qe_tenant_read
  ON public.chiefos_quote_events FOR SELECT
  USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));

-- chiefos_quote_share_tokens: SELECT only (migration 3 policy)
CREATE POLICY chiefos_qst_tenant_read
  ON public.chiefos_quote_share_tokens FOR SELECT
  USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));

-- chiefos_quote_signatures: SELECT only (migration 4 policy)
CREATE POLICY chiefos_qs_tenant_read
  ON public.chiefos_quote_signatures FOR SELECT
  USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));

-- Service role bypasses RLS automatically; no policy needed for backend writes.

-- ── Cross-doc analytics views (from migrations 2 + 4) ──────────────────────
CREATE VIEW public.chiefos_all_events_v AS
SELECT
  'quote'::text AS doc_kind,
  id, global_seq, tenant_id, owner_id,
  quote_id     AS document_id,
  quote_version_id AS document_version_id,
  kind, category, signature_id, share_token_id, customer_id,
  triggered_by_event_id, correlation_id, external_event_id,
  actor_user_id, actor_source,
  payload, emitted_at, created_at
FROM public.chiefos_quote_events;

-- Excludes PNG storage_key + SHA-256 (rendering-layer concerns; not for
-- cross-doc analytics). Excludes source_msg_id (idempotency internal).
CREATE VIEW public.chiefos_all_signatures_v AS
SELECT
  'quote'::text AS doc_kind,
  id, tenant_id, owner_id,
  quote_version_id AS document_version_id,
  signed_event_id, share_token_id,
  signer_name, signer_email, signer_ip, signer_user_agent,
  signed_at,
  version_hash_at_sign,
  name_match_at_sign, recipient_name_at_sign,
  created_at
FROM public.chiefos_quote_signatures;

-- ── Comments ───────────────────────────────────────────────────────────────
COMMENT ON TABLE  public.chiefos_quotes IS
  'Mutable quote header. One row per quote identity. Status is state-machine-driven. Pointer to current version. Identity columns protected by trg_chiefos_quotes_guard_header_immutable.';
COMMENT ON TABLE  public.chiefos_quote_versions IS
  'Append-only versioned snapshot of a quote at a point in time. Rows with locked_at IS NOT NULL are constitutionally immutable — triggers block UPDATE and DELETE. server_hash is full SHA-256 of the canonical serialization. See docs/QUOTES_SPINE_DECISIONS.md §4.';
COMMENT ON TABLE  public.chiefos_quote_line_items IS
  'Per-version line items. Mutations blocked by trg_chiefos_quote_line_items_guard_parent_lock when parent version is locked.';
COMMENT ON COLUMN public.chiefos_quote_versions.server_hash IS
  'Full SHA-256 hex of canonical serialization. Computed server-side at lock time. Never trusted from client.';
COMMENT ON COLUMN public.chiefos_quote_versions.warranty_template_ref IS
  'Soft forward-reference to a future chiefos_quote_templates table. Text identifier only; no FK yet.';

COMMENT ON TABLE public.chiefos_quote_events IS
  'Append-only audit event stream for the Quotes spine. Ordered by global_seq (gap-tolerant, contention-free). Rows are immutable post-insert except for NULL→value transitions on prev_event_hash and triggered_by_event_id. See docs/QUOTES_SPINE_DECISIONS.md §12.';
COMMENT ON COLUMN public.chiefos_quote_events.global_seq IS
  'Gap-tolerant global ordering (Postgres SEQUENCE). Use ORDER BY global_seq for deterministic audit chain ordering; gaps indicate rolled-back transactions and carry audit-relevant signal.';
COMMENT ON COLUMN public.chiefos_quote_events.prev_event_hash IS
  'Forward-plan column for hash-chained audit trail. NULL until a future migration populates it and enables chain-verification triggers. See docs/QUOTES_SPINE_DECISIONS.md §12c.';
COMMENT ON COLUMN public.chiefos_quote_events.triggered_by_event_id IS
  'Causal-chain self-reference. NULL for root events. May be set once via NULL→value UPDATE by a post-hoc linker for out-of-order webhooks.';
COMMENT ON COLUMN public.chiefos_quote_events.emitted_at IS
  'When the event semantically happened (may come from a third-party webhook and precede created_at). Does NOT determine chain order — global_seq does.';
COMMENT ON COLUMN public.chiefos_quote_events.created_at IS
  'When ChiefOS persisted the row. Audit chain order uses global_seq, not this column.';
COMMENT ON COLUMN public.chiefos_quote_events.actor_source IS
  'Channel that triggered the event. `admin` is reserved for integrity.admin_corrected (enforced by CHECK). See decisions log §12 actor_source semantics table.';

COMMENT ON TABLE public.chiefos_quote_share_tokens IS
  'Bearer share tokens for customer-facing quote URLs. 128-bit base58 tokens (app-generated). State derived from timestamp columns. Rows are append-only; revoked_at/revoked_reason and superseded_at/superseded_by_version_id are fill-once via trigger. Recipient columns are snapshot at SendQuote time and strictly immutable. See docs/QUOTES_SPINE_DECISIONS.md §14.';
COMMENT ON COLUMN public.chiefos_quote_share_tokens.token IS
  '22-char base58 (Bitcoin alphabet) opaque bearer credential. Generated app-side via crypto.randomBytes(16) + bs58 encode. DB CHECK enforces format to refuse debug/test tokens.';
COMMENT ON COLUMN public.chiefos_quote_share_tokens.absolute_expires_at IS
  'Hard expiry. 30 days default from issued_at. Sign POST has 2-hour grace window; post-sign, effective expiry is LEAST(absolute_expires_at, signed_at + 7 days), computed at read time.';
COMMENT ON COLUMN public.chiefos_quote_share_tokens.recipient_metadata IS
  'Arbitrary audit metadata captured at SendQuote time. Strictly immutable post-insert (no merge semantics).';
COMMENT ON COLUMN public.chiefos_quote_share_tokens.superseded_by_version_id IS
  'When supersession fires (new version insert for the same quote_id), this captures which version caused it. Audit forensics only. Composite FK enforces same tenant/owner as the token.';

COMMENT ON TABLE public.chiefos_quote_signatures IS
  'Quote signatures. Strict-immutable rows (every column immutable post-insert; DELETE forbidden). Composite dual-boundary FKs to version + share token + event. See docs/QUOTES_SPINE_DECISIONS.md §11, §11a.';
COMMENT ON COLUMN public.chiefos_quote_signatures.signature_png_storage_key IS
  'Supabase Storage key pointing to the signature PNG. Bucket + path convention documented in decisions log. Row-level access is rendering-layer concern; excluded from chiefos_all_signatures_v.';
COMMENT ON COLUMN public.chiefos_quote_signatures.signature_png_sha256 IS
  'SHA-256 of the PNG bytes. Tamper-evident integrity. Excluded from chiefos_all_signatures_v (rendering-layer concern).';
COMMENT ON COLUMN public.chiefos_quote_signatures.version_hash_at_sign IS
  'server_hash of the parent version at sign time. Belt-and-suspenders: independently records what the customer signed against, beyond the FK.';
COMMENT ON COLUMN public.chiefos_quote_signatures.name_match_at_sign IS
  'Result of the app-layer name-match rule (last-name exact compare, normalized). true = typed name matched recipient; false = mismatch (triggers integrity.name_mismatch_signed event).';
COMMENT ON COLUMN public.chiefos_quote_signatures.recipient_name_at_sign IS
  'recipient_name from the share token at sign time. Denormalized onto the signature row for dispute forensics without a token-table join.';

COMMENT ON CONSTRAINT chiefos_qs_png_storage_key_format ON public.chiefos_quote_signatures IS
  'Format regex mirrors SIGNATURE_STORAGE_KEY_RE.source in src/cil/quoteSignatureStorage.js. Byte-identity is a §25.3 contract enforced by automated drift-detection test at src/cil/quoteSignatureStorage.test.js:1830 (migration path updated in Session P3-2b to reference this file).';

COMMIT;
