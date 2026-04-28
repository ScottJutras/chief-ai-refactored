-- ============================================================================
-- ChiefOS Receipt Parser Upgrade — Session 2, Phase 2
-- Quota Architecture Tables:
--   quota_allotments, quota_consumption_log, addon_purchases_yearly,
--   upsell_prompts_log
--
-- Scope: creates the four quota-architecture tables per
--   RECEIPT_PARSER_UPGRADE_HANDOFF.md §5.4 and Engineering Constitution §11.
--
-- Identity model: dual-boundary per Engineering Constitution §2.
--   tenant_id (uuid) — portal/RLS boundary.
--   owner_id  (text) — canonical quota enforcement scope (§11).
--
-- Idempotency: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS,
--   DO-block guarded CREATE POLICY. Safe to run multiple times.
--
-- Dependencies: public.chiefos_tenants (FK), public.chiefos_portal_users
--   (RLS). Preflight verifies shape.
--
-- Creation order:
--   quota_allotments → quota_consumption_log (FK) → addon_purchases_yearly
--   → upsell_prompts_log.
--
-- Non-scope: the `expired_quota_ledger` referenced in Constitution §11 is
--   deferred to a future migration that will ship with the quota expiration
--   scheduled job (Session 13). Not needed until then.
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
    RAISE EXCEPTION 'Preflight failed: chiefos_portal_users.user_id missing or not uuid';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'chiefos_portal_users'
      AND column_name = 'tenant_id' AND data_type = 'uuid'
  ) INTO has_portal_tenant_id;
  IF NOT has_portal_tenant_id THEN
    RAISE EXCEPTION 'Preflight failed: chiefos_portal_users.tenant_id missing or not uuid';
  END IF;
END
$preflight$;

-- ============================================================================
-- 1. quota_allotments — per-(owner_id, feature_kind, period) quota bucket
--    Per handoff §5.4 and Constitution §11.
--
--    feature_kind ∈ {ocr_plan, ocr_addon, ocr_soft_overage, voice_plan,
--                    askchief_plan} — format-only CHECK (product concept set
--                    is source-of-truth-ed in app code per the tenant_counters
--                    precedent in 2026_04_20_chiefos_tenant_counters_generalize.sql).
--    bucket_source ∈ {plan, addon_pack_100, addon_pack_250, addon_pack_500,
--                     addon_pack_1000, soft_overage}.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.quota_allotments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES public.chiefos_tenants(id),
  owner_id            text NOT NULL,
  feature_kind        text NOT NULL,
  bucket_source       text NOT NULL,
  allotment_total     integer NOT NULL CHECK (allotment_total >= 0),
  allotment_consumed  integer NOT NULL DEFAULT 0 CHECK (allotment_consumed >= 0),
  valid_from          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  stripe_event_id     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quota_allotments_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT quota_allotments_feature_kind_format_chk
    CHECK (feature_kind ~ '^[a-z][a-z_]*$' AND char_length(feature_kind) BETWEEN 1 AND 64),
  CONSTRAINT quota_allotments_bucket_source_format_chk
    CHECK (bucket_source ~ '^[a-z][a-z0-9_]*$' AND char_length(bucket_source) BETWEEN 1 AND 64),
  CONSTRAINT quota_allotments_consumed_le_total CHECK (allotment_consumed <= allotment_total),
  CONSTRAINT quota_allotments_expires_after_valid CHECK (expires_at > valid_from)
);

CREATE INDEX IF NOT EXISTS quota_allotments_owner_idx
  ON public.quota_allotments (owner_id, feature_kind);

CREATE INDEX IF NOT EXISTS quota_allotments_active_idx
  ON public.quota_allotments (owner_id, feature_kind, expires_at)
  WHERE allotment_consumed < allotment_total;

CREATE INDEX IF NOT EXISTS quota_allotments_tenant_idx
  ON public.quota_allotments (tenant_id);

-- Stripe webhook idempotency: one allotment per Stripe event (when present).
CREATE UNIQUE INDEX IF NOT EXISTS quota_allotments_stripe_idempotent_idx
  ON public.quota_allotments (stripe_event_id)
  WHERE stripe_event_id IS NOT NULL;

-- ============================================================================
-- 2. quota_consumption_log — every metered call's audit trail
--    Per handoff §5.4 and Constitution §11.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.quota_consumption_log (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES public.chiefos_tenants(id),
  owner_id             text NOT NULL,
  feature_kind         text NOT NULL,
  quota_allotment_id   uuid REFERENCES public.quota_allotments(id),
  bucket_source        text NOT NULL,
  consumed_amount      integer NOT NULL CHECK (consumed_amount > 0),
  remaining_in_bucket  integer NOT NULL CHECK (remaining_in_bucket >= 0),
  trace_id             text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quota_consumption_log_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT quota_consumption_log_feature_kind_format_chk
    CHECK (feature_kind ~ '^[a-z][a-z_]*$' AND char_length(feature_kind) BETWEEN 1 AND 64),
  CONSTRAINT quota_consumption_log_bucket_source_format_chk
    CHECK (bucket_source ~ '^[a-z][a-z0-9_]*$' AND char_length(bucket_source) BETWEEN 1 AND 64),
  CONSTRAINT quota_consumption_log_trace_id_nonempty CHECK (char_length(trace_id) > 0)
);

CREATE INDEX IF NOT EXISTS quota_consumption_log_owner_month_idx
  ON public.quota_consumption_log (owner_id, feature_kind, created_at);

CREATE INDEX IF NOT EXISTS quota_consumption_log_tenant_idx
  ON public.quota_consumption_log (tenant_id);

CREATE INDEX IF NOT EXISTS quota_consumption_log_allotment_idx
  ON public.quota_consumption_log (quota_allotment_id)
  WHERE quota_allotment_id IS NOT NULL;

-- ============================================================================
-- 3. addon_purchases_yearly — tracks 1,000-pack annual limit
--    Per handoff §5.4 and handoff §11.2 (3 per (owner_id, calendar_year)
--    maximum; 4th triggers Enterprise lead).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.addon_purchases_yearly (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES public.chiefos_tenants(id),
  owner_id          text NOT NULL,
  pack_size         integer NOT NULL CHECK (pack_size IN (100, 250, 500, 1000)),
  calendar_year     integer NOT NULL CHECK (calendar_year BETWEEN 2024 AND 2100),
  stripe_event_id   text NOT NULL,
  purchased_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT addon_purchases_yearly_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT addon_purchases_yearly_stripe_event_nonempty CHECK (char_length(stripe_event_id) > 0)
);

DO $addon_stripe_unique$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'addon_purchases_yearly_stripe_event_unique'
      AND conrelid = 'public.addon_purchases_yearly'::regclass
  ) THEN
    ALTER TABLE public.addon_purchases_yearly
      ADD CONSTRAINT addon_purchases_yearly_stripe_event_unique UNIQUE (stripe_event_id);
  END IF;
END
$addon_stripe_unique$;

CREATE INDEX IF NOT EXISTS addon_purchases_yearly_owner_year_idx
  ON public.addon_purchases_yearly (owner_id, calendar_year, pack_size);

CREATE INDEX IF NOT EXISTS addon_purchases_yearly_tenant_idx
  ON public.addon_purchases_yearly (tenant_id);

-- ============================================================================
-- 4. upsell_prompts_log — once-per-(owner, feature, trigger, month) enforcement
--    Per handoff §5.4 and handoff §11.3 (upsell triggers fire at most once
--    per (owner_id, feature_kind, trigger_type, period_year_month)).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.upsell_prompts_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES public.chiefos_tenants(id),
  owner_id            text NOT NULL,
  feature_kind        text NOT NULL,
  trigger_type        text NOT NULL,
  period_year_month   text NOT NULL,
  prompted_at         timestamptz NOT NULL DEFAULT now(),
  response            text,
  response_at         timestamptz,
  CONSTRAINT upsell_prompts_log_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT upsell_prompts_log_feature_kind_format_chk
    CHECK (feature_kind ~ '^[a-z][a-z_]*$' AND char_length(feature_kind) BETWEEN 1 AND 64),
  CONSTRAINT upsell_prompts_log_trigger_type_format_chk
    CHECK (trigger_type ~ '^[a-z0-9_]+$' AND char_length(trigger_type) BETWEEN 1 AND 64),
  CONSTRAINT upsell_prompts_log_period_format_chk
    CHECK (period_year_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT upsell_prompts_log_response_values_chk
    CHECK (response IS NULL OR response IN ('accepted','declined','ignored')),
  CONSTRAINT upsell_prompts_log_response_at_consistency
    CHECK ((response IS NULL AND response_at IS NULL) OR (response IS NOT NULL AND response_at IS NOT NULL))
);

-- Once-per-(owner, feature, trigger, month) guarantee — unique index is the
-- enforcement mechanism per handoff §11.3. Prevents duplicate upsell prompts.
CREATE UNIQUE INDEX IF NOT EXISTS upsell_prompts_once_per_month_idx
  ON public.upsell_prompts_log (owner_id, feature_kind, trigger_type, period_year_month);

CREATE INDEX IF NOT EXISTS upsell_prompts_log_tenant_idx
  ON public.upsell_prompts_log (tenant_id);

-- ============================================================================
-- 5. Row-Level Security
--    Quota tables are primarily backend-written (Stripe webhooks, quota
--    consumption engine) via service role. Portal SELECT is gated by
--    tenant membership. INSERT/UPDATE via RLS is not exposed — the quota
--    state is service-controlled.
-- ============================================================================

ALTER TABLE public.quota_allotments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quota_consumption_log   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.addon_purchases_yearly  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.upsell_prompts_log      ENABLE ROW LEVEL SECURITY;

-- quota_allotments
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='quota_allotments' AND policyname='quota_allotments_tenant_read') THEN
    CREATE POLICY quota_allotments_tenant_read
      ON public.quota_allotments FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

-- quota_consumption_log
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='quota_consumption_log' AND policyname='quota_consumption_log_tenant_read') THEN
    CREATE POLICY quota_consumption_log_tenant_read
      ON public.quota_consumption_log FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

-- addon_purchases_yearly
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='addon_purchases_yearly' AND policyname='addon_purchases_yearly_tenant_read') THEN
    CREATE POLICY addon_purchases_yearly_tenant_read
      ON public.addon_purchases_yearly FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

-- upsell_prompts_log
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='upsell_prompts_log' AND policyname='upsell_prompts_log_tenant_read') THEN
    CREATE POLICY upsell_prompts_log_tenant_read
      ON public.upsell_prompts_log FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

-- ============================================================================
-- 6. Role grants
--    Quota tables are backend-written (service_role) and read-only exposed
--    to authenticated users via RLS. No INSERT/UPDATE/DELETE for authenticated
--    — state mutations go through the quota engine (Session 13) in service
--    context. GRANT is idempotent.
-- ============================================================================

GRANT SELECT ON public.quota_allotments        TO authenticated;
GRANT SELECT ON public.quota_consumption_log   TO authenticated;
GRANT SELECT ON public.addon_purchases_yearly  TO authenticated;
GRANT SELECT ON public.upsell_prompts_log      TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.quota_allotments        TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.quota_consumption_log   TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.addon_purchases_yearly  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.upsell_prompts_log      TO service_role;

-- ============================================================================
-- 7. Table-level comments
-- ============================================================================

COMMENT ON TABLE public.quota_allotments IS
  'Per-(owner_id, feature_kind) quota bucket. Multiple rows per owner represent layered buckets (plan + add-ons + soft overage). Consumption order: plan → newest addon → older addons → soft overage (handoff §11.2). Stripe-backed add-ons carry stripe_event_id for webhook idempotency.';
COMMENT ON TABLE public.quota_consumption_log IS
  'Audit trail for every quota consumption. Required for Developer Observability Dashboard (handoff §12) and margin telemetry. One row per metered call.';
COMMENT ON TABLE public.addon_purchases_yearly IS
  '1,000-pack annual limit enforcement. 3 purchases per (owner_id, calendar_year) maximum; 4th triggers Enterprise lead creation (handoff §11.2). Smaller packs (100/250/500) have no annual cap but still record here for telemetry.';
COMMENT ON TABLE public.upsell_prompts_log IS
  'Once-per-(owner, feature, trigger, month) upsell prompt enforcement (handoff §11.3). Unique index on (owner_id, feature_kind, trigger_type, period_year_month) is the load-bearing guarantee.';

COMMIT;
