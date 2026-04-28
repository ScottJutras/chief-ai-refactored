-- ============================================================================
-- ChiefOS Quotes Spine — Migration 1 of N
-- Beta Delta Appendix: dual-boundary identity, immutable signed versions,
-- DB-enforced immutability via triggers, canonical server-hash integrity.
--
-- Scope: chiefos_quotes (header), chiefos_quote_versions (append-only),
--        chiefos_quote_line_items (child of versions), triggers, RLS.
-- NOT in scope this round: chiefos_quote_signatures, chiefos_quote_events,
--                          chiefos_quote_share_tokens, chiefos_quote_templates.
--
-- Drops the legacy (empty, unused) `public.quotes` PocketCFO table and the
-- pre-sprint `public.quote_line_items`. See docs/QUOTES_SPINE_DECISIONS.md §2.
-- ============================================================================

BEGIN;

-- ── 0. Preflight: verify target tables are empty (fail-closed) ──────────────
DO $preflight$
DECLARE
  qli_count int;
  q_count   int;
BEGIN
  SELECT COUNT(*) INTO qli_count FROM public.quote_line_items;
  SELECT COUNT(*) INTO q_count   FROM public.quotes;
  IF qli_count > 0 OR q_count > 0 THEN
    RAISE EXCEPTION 'Preflight failed: quote_line_items=% quotes=%; refusing to drop non-empty tables',
      qli_count, q_count;
  END IF;
END
$preflight$;

-- ── 0b. Verify chiefos_portal_users shape before any destructive DDL ─────────
-- Every RLS policy below depends on (user_id uuid, tenant_id uuid). If this
-- table's shape drifts, RLS ships broken silently. Fail BEFORE the DROPs.
DO $verify_portal_users$
DECLARE
  has_table     boolean;
  has_user_id   boolean;
  has_tenant_id boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'chiefos_portal_users'
  ) INTO has_table;
  IF NOT has_table THEN
    RAISE EXCEPTION 'Preflight failed: public.chiefos_portal_users does not exist; RLS policies would ship broken';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'chiefos_portal_users'
      AND column_name = 'user_id' AND data_type = 'uuid'
  ) INTO has_user_id;
  IF NOT has_user_id THEN
    RAISE EXCEPTION 'Preflight failed: chiefos_portal_users.user_id missing or not uuid; RLS policies would ship broken';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'chiefos_portal_users'
      AND column_name = 'tenant_id' AND data_type = 'uuid'
  ) INTO has_tenant_id;
  IF NOT has_tenant_id THEN
    RAISE EXCEPTION 'Preflight failed: chiefos_portal_users.tenant_id missing or not uuid; RLS policies would ship broken';
  END IF;
END
$verify_portal_users$;

-- ── 1. Drop legacy / pre-sprint tables (verified empty above) ───────────────
DROP TABLE IF EXISTS public.quote_line_items;
DROP TABLE IF EXISTS public.quotes;

-- ── 2. Header: chiefos_quotes ───────────────────────────────────────────────
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

-- ── 3. Versions: chiefos_quote_versions ─────────────────────────────────────
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

-- ── 4. Line items: chiefos_quote_line_items ─────────────────────────────────
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

-- ── 5. Triggers ─────────────────────────────────────────────────────────────

-- 5a. Versions: block UPDATE/DELETE on locked rows, block unlocking.
CREATE OR REPLACE FUNCTION public.chiefos_quote_versions_guard_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.locked_at IS NOT NULL THEN
      RAISE EXCEPTION
        'chiefos_quote_versions: row % is locked at %; updates are forbidden (constitutional immutability)',
        OLD.id, OLD.locked_at
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.locked_at IS NULL AND OLD.locked_at IS NOT NULL THEN
      RAISE EXCEPTION 'chiefos_quote_versions: locked_at cannot be cleared once set'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.locked_at IS NOT NULL THEN
      RAISE EXCEPTION
        'chiefos_quote_versions: row % is locked at %; deletes are forbidden',
        OLD.id, OLD.locked_at
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_chiefos_quote_versions_guard_immutable
BEFORE UPDATE OR DELETE ON public.chiefos_quote_versions
FOR EACH ROW EXECUTE FUNCTION public.chiefos_quote_versions_guard_immutable();

-- 5b. Line items: block INSERT/UPDATE/DELETE when parent version is locked.
CREATE OR REPLACE FUNCTION public.chiefos_quote_line_items_guard_parent_lock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_locked_at timestamptz;
  parent_version_id uuid;
BEGIN
  parent_version_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.quote_version_id ELSE NEW.quote_version_id END;

  SELECT locked_at INTO parent_locked_at
  FROM public.chiefos_quote_versions
  WHERE id = parent_version_id;

  IF parent_locked_at IS NOT NULL THEN
    RAISE EXCEPTION
      'chiefos_quote_line_items: parent version % is locked at %; % is forbidden',
      parent_version_id, parent_locked_at, TG_OP
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_chiefos_quote_line_items_guard_parent_lock
BEFORE INSERT OR UPDATE OR DELETE ON public.chiefos_quote_line_items
FOR EACH ROW EXECUTE FUNCTION public.chiefos_quote_line_items_guard_parent_lock();

-- 5c. Header: immutability of identity columns.
CREATE OR REPLACE FUNCTION public.chiefos_quotes_guard_header_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id             IS DISTINCT FROM OLD.id             THEN RAISE EXCEPTION 'chiefos_quotes.id is immutable'; END IF;
  IF NEW.tenant_id      IS DISTINCT FROM OLD.tenant_id      THEN RAISE EXCEPTION 'chiefos_quotes.tenant_id is immutable'; END IF;
  IF NEW.owner_id       IS DISTINCT FROM OLD.owner_id       THEN RAISE EXCEPTION 'chiefos_quotes.owner_id is immutable'; END IF;
  IF NEW.job_id         IS DISTINCT FROM OLD.job_id         THEN RAISE EXCEPTION 'chiefos_quotes.job_id is immutable'; END IF;
  IF NEW.customer_id    IS DISTINCT FROM OLD.customer_id    THEN RAISE EXCEPTION 'chiefos_quotes.customer_id is immutable'; END IF;
  IF NEW.human_id       IS DISTINCT FROM OLD.human_id       THEN RAISE EXCEPTION 'chiefos_quotes.human_id is immutable'; END IF;
  IF NEW.source         IS DISTINCT FROM OLD.source         THEN RAISE EXCEPTION 'chiefos_quotes.source is immutable'; END IF;
  IF NEW.source_msg_id  IS DISTINCT FROM OLD.source_msg_id  THEN RAISE EXCEPTION 'chiefos_quotes.source_msg_id is immutable'; END IF;
  IF NEW.created_at     IS DISTINCT FROM OLD.created_at     THEN RAISE EXCEPTION 'chiefos_quotes.created_at is immutable'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_chiefos_quotes_guard_header_immutable
BEFORE UPDATE ON public.chiefos_quotes
FOR EACH ROW EXECUTE FUNCTION public.chiefos_quotes_guard_header_immutable();

-- ── 6. RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE public.chiefos_quotes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chiefos_quote_versions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chiefos_quote_line_items  ENABLE ROW LEVEL SECURITY;

-- Portal SELECT: tenant-scoped via chiefos_portal_users membership.
CREATE POLICY chiefos_quotes_tenant_read
  ON public.chiefos_quotes FOR SELECT
  USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));

CREATE POLICY chiefos_qv_tenant_read
  ON public.chiefos_quote_versions FOR SELECT
  USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));

CREATE POLICY chiefos_qli_tenant_read
  ON public.chiefos_quote_line_items FOR SELECT
  USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));

-- Portal INSERT/UPDATE: tenant-scoped. DELETE is not exposed via RLS — service
-- role only (forces deletes through application code paths that respect the
-- state-machine and can emit audit events).
CREATE POLICY chiefos_quotes_tenant_write
  ON public.chiefos_quotes FOR INSERT
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));

CREATE POLICY chiefos_quotes_tenant_update
  ON public.chiefos_quotes FOR UPDATE
  USING  (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));

CREATE POLICY chiefos_qv_tenant_write
  ON public.chiefos_quote_versions FOR INSERT
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));

CREATE POLICY chiefos_qv_tenant_update
  ON public.chiefos_quote_versions FOR UPDATE
  USING  (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));

CREATE POLICY chiefos_qli_tenant_write
  ON public.chiefos_quote_line_items FOR INSERT
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));

CREATE POLICY chiefos_qli_tenant_update
  ON public.chiefos_quote_line_items FOR UPDATE
  USING  (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));

-- Service role bypasses RLS automatically; no policy needed for backend writes.

-- ── 7. Comments for future maintainers ──────────────────────────────────────
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

COMMIT;
