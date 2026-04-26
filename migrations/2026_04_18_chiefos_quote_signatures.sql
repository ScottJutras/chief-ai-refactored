-- ============================================================================
-- ChiefOS Quotes Spine — Migration 4 of N: signatures
-- Beta Delta Appendix: strict-immutable signature rows, composite dual-boundary
-- FKs to version + share token + event, name-match step-up flag, PNG in Storage
-- bucket (key + SHA-256), strict tenant-SELECT RLS.
--
-- Also:
--   - Harmonizes RLS drift on chiefos_quote_versions + chiefos_quote_line_items
--     to the tight pattern (§11.0).
--   - Adds UNIQUE (id, tenant_id, owner_id) on chiefos_quote_events to enable
--     composite FK targeting from signatures.signed_event_id.
--   - Backfills the deferred chiefos_qe_signature_fk on chiefos_quote_events
--     (now composite, for dual-boundary integrity).
--   - Extends chiefos_qe_kind_enum with 'integrity.name_mismatch_signed'.
--   - Extends chiefos_qe_version_scoped_kinds to include the new kind.
--   - Adds per-kind payload CHECK for integrity.name_mismatch_signed (structural
--     invariants only per §14.10).
--   - Creates chiefos_all_signatures_v cross-doc view (quote arm only).
--
-- See docs/QUOTES_SPINE_DECISIONS.md §§11, 11.0, 11a, 11b, 11c, 14.8, 14.10.
-- ============================================================================

BEGIN;

-- ── 0. Preflight ────────────────────────────────────────────────────────────
DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_quote_versions') THEN
    RAISE EXCEPTION 'Preflight failed: chiefos_quote_versions missing; migration 1 required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_quote_events') THEN
    RAISE EXCEPTION 'Preflight failed: chiefos_quote_events missing; migration 2 required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_quote_share_tokens') THEN
    RAISE EXCEPTION 'Preflight failed: chiefos_quote_share_tokens missing; migration 3 required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='chiefos_quote_events'
                   AND column_name='signature_id') THEN
    RAISE EXCEPTION 'Preflight failed: chiefos_quote_events.signature_id missing; migration 2 schema drift';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints
             WHERE table_schema='public' AND table_name='chiefos_quote_events'
               AND constraint_name='chiefos_qe_signature_identity_fk') THEN
    RAISE EXCEPTION 'Preflight failed: chiefos_qe_signature_identity_fk already exists';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_portal_users') THEN
    RAISE EXCEPTION 'Preflight failed: chiefos_portal_users missing; RLS would ship broken';
  END IF;
END
$preflight$;

-- ── 1. Add UNIQUE(id,tenant_id,owner_id) on events so signatures.signed_event_id
--    can have a composite dual-boundary FK target ─────────────────────────────
ALTER TABLE public.chiefos_quote_events
  ADD CONSTRAINT chiefos_qe_identity_unique UNIQUE (id, tenant_id, owner_id);

-- ── 2. Signatures table ─────────────────────────────────────────────────────
CREATE TABLE public.chiefos_quote_signatures (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_version_id            uuid NOT NULL,
  tenant_id                   uuid NOT NULL,
  owner_id                    text NOT NULL,

  -- Event binding (real FK, composite, from day one — events shipped first).
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
  CONSTRAINT chiefos_qs_signed_event_identity_fk
    FOREIGN KEY (signed_event_id, tenant_id, owner_id)
    REFERENCES public.chiefos_quote_events(id, tenant_id, owner_id)
    ON DELETE RESTRICT,
  CONSTRAINT chiefos_qs_share_token_identity_fk
    FOREIGN KEY (share_token_id, tenant_id, owner_id)
    REFERENCES public.chiefos_quote_share_tokens(id, tenant_id, owner_id)
    ON DELETE RESTRICT
);

-- ── 3. Partial unique for idempotency on SignQuote retries ──────────────────
CREATE UNIQUE INDEX chiefos_qs_source_msg_unique
  ON public.chiefos_quote_signatures (owner_id, source_msg_id)
  WHERE source_msg_id IS NOT NULL;

-- ── 4. Query indexes ────────────────────────────────────────────────────────
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

-- ── 5. Strict-immutability trigger (every column, every UPDATE, every DELETE)
CREATE OR REPLACE FUNCTION public.chiefos_quote_signatures_guard_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'chiefos_quote_signatures: rows are append-only post-insert; DELETE forbidden (id %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Every column is immutable. No fill-once exemptions.
  IF NEW.id                          IS DISTINCT FROM OLD.id                          THEN RAISE EXCEPTION 'chiefos_quote_signatures.id is immutable'; END IF;
  IF NEW.quote_version_id            IS DISTINCT FROM OLD.quote_version_id            THEN RAISE EXCEPTION 'chiefos_quote_signatures.quote_version_id is immutable'; END IF;
  IF NEW.tenant_id                   IS DISTINCT FROM OLD.tenant_id                   THEN RAISE EXCEPTION 'chiefos_quote_signatures.tenant_id is immutable'; END IF;
  IF NEW.owner_id                    IS DISTINCT FROM OLD.owner_id                    THEN RAISE EXCEPTION 'chiefos_quote_signatures.owner_id is immutable'; END IF;
  IF NEW.signed_event_id             IS DISTINCT FROM OLD.signed_event_id             THEN RAISE EXCEPTION 'chiefos_quote_signatures.signed_event_id is immutable'; END IF;
  IF NEW.share_token_id              IS DISTINCT FROM OLD.share_token_id              THEN RAISE EXCEPTION 'chiefos_quote_signatures.share_token_id is immutable'; END IF;
  IF NEW.signer_name                 IS DISTINCT FROM OLD.signer_name                 THEN RAISE EXCEPTION 'chiefos_quote_signatures.signer_name is immutable'; END IF;
  IF NEW.signer_email                IS DISTINCT FROM OLD.signer_email                THEN RAISE EXCEPTION 'chiefos_quote_signatures.signer_email is immutable'; END IF;
  IF NEW.signer_ip                   IS DISTINCT FROM OLD.signer_ip                   THEN RAISE EXCEPTION 'chiefos_quote_signatures.signer_ip is immutable'; END IF;
  IF NEW.signer_user_agent           IS DISTINCT FROM OLD.signer_user_agent           THEN RAISE EXCEPTION 'chiefos_quote_signatures.signer_user_agent is immutable'; END IF;
  IF NEW.signed_at                   IS DISTINCT FROM OLD.signed_at                   THEN RAISE EXCEPTION 'chiefos_quote_signatures.signed_at is immutable'; END IF;
  IF NEW.signature_png_storage_key   IS DISTINCT FROM OLD.signature_png_storage_key   THEN RAISE EXCEPTION 'chiefos_quote_signatures.signature_png_storage_key is immutable'; END IF;
  IF NEW.signature_png_sha256        IS DISTINCT FROM OLD.signature_png_sha256        THEN RAISE EXCEPTION 'chiefos_quote_signatures.signature_png_sha256 is immutable'; END IF;
  IF NEW.version_hash_at_sign        IS DISTINCT FROM OLD.version_hash_at_sign        THEN RAISE EXCEPTION 'chiefos_quote_signatures.version_hash_at_sign is immutable'; END IF;
  IF NEW.name_match_at_sign          IS DISTINCT FROM OLD.name_match_at_sign          THEN RAISE EXCEPTION 'chiefos_quote_signatures.name_match_at_sign is immutable'; END IF;
  IF NEW.recipient_name_at_sign      IS DISTINCT FROM OLD.recipient_name_at_sign      THEN RAISE EXCEPTION 'chiefos_quote_signatures.recipient_name_at_sign is immutable'; END IF;
  IF NEW.source_msg_id               IS DISTINCT FROM OLD.source_msg_id               THEN RAISE EXCEPTION 'chiefos_quote_signatures.source_msg_id is immutable'; END IF;
  IF NEW.created_at                  IS DISTINCT FROM OLD.created_at                  THEN RAISE EXCEPTION 'chiefos_quote_signatures.created_at is immutable'; END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_chiefos_quote_signatures_guard_immutable
BEFORE UPDATE OR DELETE ON public.chiefos_quote_signatures
FOR EACH ROW EXECUTE FUNCTION public.chiefos_quote_signatures_guard_immutable();

-- ── 6. RLS: tenant SELECT only (tight pattern per §11.0) ────────────────────
ALTER TABLE public.chiefos_quote_signatures ENABLE ROW LEVEL SECURITY;

CREATE POLICY chiefos_qs_tenant_read
  ON public.chiefos_quote_signatures FOR SELECT
  USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));

-- ── 7. Harmonize RLS drift on versions + line_items (§11.0) ─────────────────
-- Migration 1 shipped these with broad pattern (SELECT+INSERT+UPDATE) before
-- §11.0 was stated. Audit-terminal tables get SELECT only; writes go through
-- service-role CIL handlers. Zero existing callers break because the quote
-- builder portal UI hasn't been built yet.
DROP POLICY chiefos_qv_tenant_write  ON public.chiefos_quote_versions;
DROP POLICY chiefos_qv_tenant_update ON public.chiefos_quote_versions;
DROP POLICY chiefos_qli_tenant_write  ON public.chiefos_quote_line_items;
DROP POLICY chiefos_qli_tenant_update ON public.chiefos_quote_line_items;

-- ── 8. Backfill deferred FK on chiefos_quote_events.signature_id ────────────
-- Migration 2 left this column as uuid with no FK (forward reference).
-- Now that chiefos_quote_signatures exists, add the composite dual-boundary FK.
ALTER TABLE public.chiefos_quote_events
  ADD CONSTRAINT chiefos_qe_signature_identity_fk
  FOREIGN KEY (signature_id, tenant_id, owner_id)
  REFERENCES public.chiefos_quote_signatures(id, tenant_id, owner_id)
  ON DELETE RESTRICT;

-- ── 9. Extend kind enum with integrity.name_mismatch_signed ─────────────────
ALTER TABLE public.chiefos_quote_events
  DROP CONSTRAINT chiefos_qe_kind_enum;

ALTER TABLE public.chiefos_quote_events
  ADD CONSTRAINT chiefos_qe_kind_enum CHECK (kind IN (
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
  ));

-- ── 10. Extend version-scope CHECK to include the new kind ─────────────────
ALTER TABLE public.chiefos_quote_events
  DROP CONSTRAINT chiefos_qe_version_scoped_kinds;

ALTER TABLE public.chiefos_quote_events
  ADD CONSTRAINT chiefos_qe_version_scoped_kinds CHECK (
    kind NOT IN (
      'lifecycle.version_created','lifecycle.sent','lifecycle.customer_viewed',
      'lifecycle.signed','lifecycle.locked',
      'notification.queued','notification.sent','notification.delivered',
      'notification.opened','notification.bounced','notification.failed',
      'share_token.issued','share_token.accessed','share_token.revoked','share_token.expired',
      'integrity.sign_attempt_failed',
      'integrity.name_mismatch_signed'
    ) OR quote_version_id IS NOT NULL
  );

-- ── 11. Per-kind payload CHECK for integrity.name_mismatch_signed ──────────
-- Structural invariants only (§14.10): the event is about a specific
-- signature and records which rule fired. Typed name / recipient snapshot /
-- match-rule internals are ceremonial and live in CIL-handler contract.
ALTER TABLE public.chiefos_quote_events
  ADD CONSTRAINT chiefos_qe_payload_name_mismatch_signed CHECK (
    kind <> 'integrity.name_mismatch_signed'
    OR (signature_id IS NOT NULL AND payload ? 'rule_id')
  );

-- ── 12. Cross-doc signatures analytics view ─────────────────────────────────
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

-- ── 13. Comments ────────────────────────────────────────────────────────────
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

COMMIT;
