-- ============================================================================
-- ChiefOS Quotes Spine — Migration 3 of N: share tokens
-- Beta Delta Appendix: opaque bearer tokens, 128-bit base58, 30-day absolute
-- expiry, timestamp-column-derived state machine, fill-once terminal columns,
-- recipient snapshot on token row, composite dual-boundary FKs.
--
-- Also backfills the deferred chiefos_qe_share_token_fk on chiefos_quote_events
-- (migration 2 left that column as a forward reference).
--
-- See docs/QUOTES_SPINE_DECISIONS.md §14.
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
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='chiefos_quote_events'
                   AND column_name='share_token_id') THEN
    RAISE EXCEPTION 'Preflight failed: chiefos_quote_events.share_token_id missing; migration 2 schema drift';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints
             WHERE table_schema='public' AND table_name='chiefos_quote_events'
               AND constraint_name='chiefos_qe_share_token_fk') THEN
    RAISE EXCEPTION 'Preflight failed: chiefos_qe_share_token_fk already exists; migration 3 appears to have run';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_portal_users') THEN
    RAISE EXCEPTION 'Preflight failed: chiefos_portal_users missing; RLS would ship broken';
  END IF;
END
$preflight$;

-- ── 1. Share tokens table ───────────────────────────────────────────────────
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

-- ── 2. Partial unique for idempotency on SendQuote retries ──────────────────
CREATE UNIQUE INDEX chiefos_qst_source_msg_unique
  ON public.chiefos_quote_share_tokens (owner_id, source_msg_id)
  WHERE source_msg_id IS NOT NULL;

-- ── 3. Query indexes ────────────────────────────────────────────────────────
-- The hot path (URL → token lookup) is covered by UNIQUE (token).
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

-- ── 4. Scoped-immutability trigger ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.chiefos_quote_share_tokens_guard_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'chiefos_quote_share_tokens: rows are append-only post-insert; DELETE forbidden (id %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Strictly immutable columns.
  IF NEW.id                         IS DISTINCT FROM OLD.id                         THEN RAISE EXCEPTION 'chiefos_quote_share_tokens.id is immutable'; END IF;
  IF NEW.tenant_id                  IS DISTINCT FROM OLD.tenant_id                  THEN RAISE EXCEPTION 'chiefos_quote_share_tokens.tenant_id is immutable'; END IF;
  IF NEW.owner_id                   IS DISTINCT FROM OLD.owner_id                   THEN RAISE EXCEPTION 'chiefos_quote_share_tokens.owner_id is immutable'; END IF;
  IF NEW.quote_version_id           IS DISTINCT FROM OLD.quote_version_id           THEN RAISE EXCEPTION 'chiefos_quote_share_tokens.quote_version_id is immutable'; END IF;
  IF NEW.token                      IS DISTINCT FROM OLD.token                      THEN RAISE EXCEPTION 'chiefos_quote_share_tokens.token is immutable'; END IF;
  IF NEW.recipient_name             IS DISTINCT FROM OLD.recipient_name             THEN RAISE EXCEPTION 'chiefos_quote_share_tokens.recipient_name is immutable'; END IF;
  IF NEW.recipient_channel          IS DISTINCT FROM OLD.recipient_channel          THEN RAISE EXCEPTION 'chiefos_quote_share_tokens.recipient_channel is immutable'; END IF;
  IF NEW.recipient_address          IS DISTINCT FROM OLD.recipient_address          THEN RAISE EXCEPTION 'chiefos_quote_share_tokens.recipient_address is immutable'; END IF;
  IF NEW.recipient_metadata         IS DISTINCT FROM OLD.recipient_metadata         THEN RAISE EXCEPTION 'chiefos_quote_share_tokens.recipient_metadata is immutable'; END IF;
  IF NEW.issued_at                  IS DISTINCT FROM OLD.issued_at                  THEN RAISE EXCEPTION 'chiefos_quote_share_tokens.issued_at is immutable'; END IF;
  IF NEW.absolute_expires_at        IS DISTINCT FROM OLD.absolute_expires_at        THEN RAISE EXCEPTION 'chiefos_quote_share_tokens.absolute_expires_at is immutable'; END IF;
  IF NEW.source_msg_id              IS DISTINCT FROM OLD.source_msg_id              THEN RAISE EXCEPTION 'chiefos_quote_share_tokens.source_msg_id is immutable'; END IF;
  IF NEW.created_at                 IS DISTINCT FROM OLD.created_at                 THEN RAISE EXCEPTION 'chiefos_quote_share_tokens.created_at is immutable'; END IF;

  -- Fill-once columns: NULL → value permitted; value → anything else forbidden.
  IF OLD.revoked_at IS NOT NULL
     AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'chiefos_quote_share_tokens.revoked_at can be set once (NULL->value); further changes forbidden';
  END IF;
  IF OLD.revoked_reason IS NOT NULL
     AND NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason THEN
    RAISE EXCEPTION 'chiefos_quote_share_tokens.revoked_reason can be set once (NULL->value); further changes forbidden';
  END IF;
  IF OLD.superseded_at IS NOT NULL
     AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION 'chiefos_quote_share_tokens.superseded_at can be set once (NULL->value); further changes forbidden';
  END IF;
  IF OLD.superseded_by_version_id IS NOT NULL
     AND NEW.superseded_by_version_id IS DISTINCT FROM OLD.superseded_by_version_id THEN
    RAISE EXCEPTION 'chiefos_quote_share_tokens.superseded_by_version_id can be set once (NULL->value); further changes forbidden';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_chiefos_quote_share_tokens_guard_immutable
BEFORE UPDATE OR DELETE ON public.chiefos_quote_share_tokens
FOR EACH ROW EXECUTE FUNCTION public.chiefos_quote_share_tokens_guard_immutable();

-- ── 5. RLS: portal SELECT only; writes via service role ─────────────────────
ALTER TABLE public.chiefos_quote_share_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY chiefos_qst_tenant_read
  ON public.chiefos_quote_share_tokens FOR SELECT
  USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));

-- ── 6. Backfill deferred FK on chiefos_quote_events.share_token_id ──────────
ALTER TABLE public.chiefos_quote_events
  ADD CONSTRAINT chiefos_qe_share_token_fk
  FOREIGN KEY (share_token_id)
  REFERENCES public.chiefos_quote_share_tokens(id)
  ON DELETE RESTRICT;

-- ── 7. Comments ─────────────────────────────────────────────────────────────
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

COMMIT;
