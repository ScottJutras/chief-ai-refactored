-- ============================================================================
-- ChiefOS Quotes Spine — Migration 2 of N: events
-- Beta Delta Appendix: append-only audit chain, gap-tolerant global ordering,
-- dual-boundary composite FKs to quote + version parents, scoped immutability
-- (prev_event_hash + triggered_by_event_id are NULL→value fill-once columns;
-- all other columns strictly immutable post-insert; DELETE always forbidden).
--
-- Ships ahead of chiefos_quote_signatures so that signatures can reference
-- events via a real FK from day one. See docs/QUOTES_SPINE_DECISIONS.md §12.
-- ============================================================================

BEGIN;

-- ── 0. Preflight: confirm chiefos_quote_versions exists (migration 1 landed) ─
DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_quote_versions') THEN
    RAISE EXCEPTION 'Preflight failed: chiefos_quote_versions missing; migration 1 must land first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_portal_users') THEN
    RAISE EXCEPTION 'Preflight failed: chiefos_portal_users missing; RLS policies would ship broken';
  END IF;
END
$preflight$;

-- ── 1. Global sequence for ordering (gaps-OK, contention-free) ──────────────
CREATE SEQUENCE public.chiefos_events_global_seq
  START WITH 1
  INCREMENT BY 1
  NO MAXVALUE
  CACHE 32;

-- ── 2. Events table ─────────────────────────────────────────────────────────
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
  -- FKs on signature_id and share_token_id are added by later migrations once
  -- chiefos_quote_signatures and chiefos_quote_share_tokens exist.
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
  CONSTRAINT chiefos_qe_owner_id_nonempty CHECK (char_length(owner_id) > 0),

  -- ── Kind enum (closed) ──────────────────────────────────────────────────
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
    'integrity.admin_corrected'
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

  -- ── Self-reference for causal chains (immediate FK; NULL permitted for
  --    out-of-order webhook cases backfilled later by a worker) ────────────
  CONSTRAINT chiefos_qe_triggered_by_fk
    FOREIGN KEY (triggered_by_event_id)
    REFERENCES public.chiefos_quote_events(id)
    ON DELETE RESTRICT,

  -- ── Scope enforcement: version-scoped vs quote-scoped kinds ─────────────
  CONSTRAINT chiefos_qe_version_scoped_kinds CHECK (
    kind NOT IN (
      'lifecycle.version_created','lifecycle.sent','lifecycle.customer_viewed',
      'lifecycle.signed','lifecycle.locked',
      'notification.queued','notification.sent','notification.delivered',
      'notification.opened','notification.bounced','notification.failed',
      'share_token.issued','share_token.accessed','share_token.revoked','share_token.expired',
      'integrity.sign_attempt_failed'
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
  )
);

-- ── 3. Partial unique index for webhook-retry idempotency ───────────────────
-- Explicit partial scope: uniqueness enforced only for rows with an external ID.
-- Internal events (external_event_id IS NULL) never collide on this index.
CREATE UNIQUE INDEX chiefos_qe_external_event_unique
  ON public.chiefos_quote_events (owner_id, external_event_id)
  WHERE external_event_id IS NOT NULL;

-- ── 4. Query indexes ────────────────────────────────────────────────────────
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

-- ── 5. Scoped-immutability trigger ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.chiefos_quote_events_guard_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'chiefos_quote_events: rows are append-only; DELETE forbidden (row id %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- UPDATE: every column immutable EXCEPT prev_event_hash and
  -- triggered_by_event_id, and those may only transition NULL → value once.
  IF NEW.id                    IS DISTINCT FROM OLD.id                    THEN RAISE EXCEPTION 'chiefos_quote_events.id is immutable'; END IF;
  IF NEW.global_seq            IS DISTINCT FROM OLD.global_seq            THEN RAISE EXCEPTION 'chiefos_quote_events.global_seq is immutable'; END IF;
  IF NEW.tenant_id             IS DISTINCT FROM OLD.tenant_id             THEN RAISE EXCEPTION 'chiefos_quote_events.tenant_id is immutable'; END IF;
  IF NEW.owner_id              IS DISTINCT FROM OLD.owner_id              THEN RAISE EXCEPTION 'chiefos_quote_events.owner_id is immutable'; END IF;
  IF NEW.quote_id              IS DISTINCT FROM OLD.quote_id              THEN RAISE EXCEPTION 'chiefos_quote_events.quote_id is immutable'; END IF;
  IF NEW.quote_version_id      IS DISTINCT FROM OLD.quote_version_id      THEN RAISE EXCEPTION 'chiefos_quote_events.quote_version_id is immutable'; END IF;
  IF NEW.kind                  IS DISTINCT FROM OLD.kind                  THEN RAISE EXCEPTION 'chiefos_quote_events.kind is immutable'; END IF;
  IF NEW.signature_id          IS DISTINCT FROM OLD.signature_id          THEN RAISE EXCEPTION 'chiefos_quote_events.signature_id is immutable'; END IF;
  IF NEW.share_token_id        IS DISTINCT FROM OLD.share_token_id        THEN RAISE EXCEPTION 'chiefos_quote_events.share_token_id is immutable'; END IF;
  IF NEW.customer_id           IS DISTINCT FROM OLD.customer_id           THEN RAISE EXCEPTION 'chiefos_quote_events.customer_id is immutable'; END IF;
  IF NEW.payload               IS DISTINCT FROM OLD.payload               THEN RAISE EXCEPTION 'chiefos_quote_events.payload is immutable'; END IF;
  IF NEW.actor_user_id         IS DISTINCT FROM OLD.actor_user_id         THEN RAISE EXCEPTION 'chiefos_quote_events.actor_user_id is immutable'; END IF;
  IF NEW.actor_source          IS DISTINCT FROM OLD.actor_source          THEN RAISE EXCEPTION 'chiefos_quote_events.actor_source is immutable'; END IF;
  IF NEW.correlation_id        IS DISTINCT FROM OLD.correlation_id        THEN RAISE EXCEPTION 'chiefos_quote_events.correlation_id is immutable'; END IF;
  IF NEW.external_event_id     IS DISTINCT FROM OLD.external_event_id     THEN RAISE EXCEPTION 'chiefos_quote_events.external_event_id is immutable'; END IF;
  IF NEW.emitted_at            IS DISTINCT FROM OLD.emitted_at            THEN RAISE EXCEPTION 'chiefos_quote_events.emitted_at is immutable'; END IF;
  IF NEW.created_at            IS DISTINCT FROM OLD.created_at            THEN RAISE EXCEPTION 'chiefos_quote_events.created_at is immutable'; END IF;

  -- prev_event_hash: NULL → value once; any other transition forbidden.
  IF OLD.prev_event_hash IS NOT NULL
     AND NEW.prev_event_hash IS DISTINCT FROM OLD.prev_event_hash THEN
    RAISE EXCEPTION 'chiefos_quote_events.prev_event_hash can be set once (NULL→value); further changes forbidden';
  END IF;

  -- triggered_by_event_id: NULL → value once; any other transition forbidden.
  IF OLD.triggered_by_event_id IS NOT NULL
     AND NEW.triggered_by_event_id IS DISTINCT FROM OLD.triggered_by_event_id THEN
    RAISE EXCEPTION 'chiefos_quote_events.triggered_by_event_id can be set once (NULL→value); further changes forbidden';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_chiefos_quote_events_guard_immutable
BEFORE UPDATE OR DELETE ON public.chiefos_quote_events
FOR EACH ROW EXECUTE FUNCTION public.chiefos_quote_events_guard_immutable();

-- ── 6. RLS: portal SELECT only; writes are service-role only ────────────────
ALTER TABLE public.chiefos_quote_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY chiefos_qe_tenant_read
  ON public.chiefos_quote_events FOR SELECT
  USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));

-- No INSERT/UPDATE/DELETE policies. Writes go through backend CIL handlers
-- under service-role auth (bypasses RLS). Audit rows cannot be forged from
-- a compromised portal session.

-- ── 7. Cross-doc analytics view (initially one arm) ─────────────────────────
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

-- ── 8. Comments ─────────────────────────────────────────────────────────────
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

COMMIT;
