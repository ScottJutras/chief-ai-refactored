-- ============================================================================
-- Foundation Rebuild — Session P3-3b, Part 3: overhead family
--
-- Section 3.12 of FOUNDATION_P1_SCHEMA_DESIGN.md.
--
-- Creates:
--   1. overhead_items      — recurring business overhead definitions
--   2. overhead_payments   — per-payment record per item
--   3. overhead_reminders  — scheduled reminders for upcoming overhead payments
--
-- Design note: overhead_payments emit a parallel public.transactions row at
-- confirm time (same pattern as mileage_logs). App-code layer handles.
--
-- Dependencies:
--   - public.chiefos_tenants (Session P3-1)
--   - public.transactions   (Session P3-1) — composite FK target for payments.transaction_id
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_tenants') THEN
    RAISE EXCEPTION 'Requires public.chiefos_tenants';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='transactions') THEN
    RAISE EXCEPTION 'Requires public.transactions';
  END IF;
END
$preflight$;

-- ============================================================================
-- 1. overhead_items
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.overhead_items (
  id                       uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id                 text         NOT NULL,
  name                     text         NOT NULL,
  category                 text         NOT NULL DEFAULT 'other',
  item_type                text         NOT NULL DEFAULT 'recurring',
  amount_cents             bigint       NOT NULL,
  currency                 text         NOT NULL DEFAULT 'CAD',
  frequency                text         NOT NULL DEFAULT 'monthly',
  due_day                  integer,
  amortization_months      integer,
  start_date               date,
  end_date                 date,
  next_due_at              date,
  tax_amount_cents         bigint,
  notes                    text,
  source                   text         NOT NULL DEFAULT 'portal',
  source_msg_id            text,
  active                   boolean      NOT NULL DEFAULT true,
  deleted_at               timestamptz,
  correlation_id           uuid         NOT NULL DEFAULT gen_random_uuid(),
  created_at               timestamptz  NOT NULL DEFAULT now(),
  updated_at               timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT overhead_items_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT overhead_items_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT overhead_items_category_chk
    CHECK (category IN ('rent','utilities','insurance','subscription','loan','other')),
  CONSTRAINT overhead_items_item_type_chk
    CHECK (item_type IN ('recurring','amortized','one_time')),
  CONSTRAINT overhead_items_frequency_chk
    CHECK (frequency IN ('monthly','weekly','quarterly','annually','one_time')),
  CONSTRAINT overhead_items_source_chk
    CHECK (source IN ('whatsapp','portal','api')),
  CONSTRAINT overhead_items_amount_nonneg CHECK (amount_cents >= 0),
  CONSTRAINT overhead_items_currency_chk CHECK (currency IN ('CAD','USD')),
  CONSTRAINT overhead_items_due_day_range CHECK (due_day IS NULL OR due_day BETWEEN 1 AND 31),
  CONSTRAINT overhead_items_amortized_months_required
    CHECK ((item_type = 'amortized') = (amortization_months IS NOT NULL)),
  CONSTRAINT overhead_items_amortization_positive
    CHECK (amortization_months IS NULL OR amortization_months > 0),
  CONSTRAINT overhead_items_date_order
    CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

-- Idempotency
CREATE UNIQUE INDEX IF NOT EXISTS overhead_items_owner_source_msg_unique_idx
  ON public.overhead_items (owner_id, source_msg_id)
  WHERE source_msg_id IS NOT NULL;

-- Composite identity UNIQUE (Principle 11) — FK target for payments/reminders
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'overhead_items_identity_unique'
      AND conrelid = 'public.overhead_items'::regclass
  ) THEN
    ALTER TABLE public.overhead_items
      ADD CONSTRAINT overhead_items_identity_unique UNIQUE (id, tenant_id, owner_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS overhead_items_tenant_active_idx
  ON public.overhead_items (tenant_id, active, next_due_at)
  WHERE active = true;
CREATE INDEX IF NOT EXISTS overhead_items_tenant_category_idx
  ON public.overhead_items (tenant_id, category, active);
CREATE INDEX IF NOT EXISTS overhead_items_next_due_idx
  ON public.overhead_items (tenant_id, next_due_at)
  WHERE active = true AND next_due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS overhead_items_deleted_idx
  ON public.overhead_items (tenant_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;

ALTER TABLE public.overhead_items ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='overhead_items'
                   AND policyname='overhead_items_tenant_select') THEN
    CREATE POLICY overhead_items_tenant_select ON public.overhead_items FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='overhead_items'
                   AND policyname='overhead_items_tenant_insert') THEN
    CREATE POLICY overhead_items_tenant_insert ON public.overhead_items FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='overhead_items'
                   AND policyname='overhead_items_tenant_update') THEN
    CREATE POLICY overhead_items_tenant_update ON public.overhead_items FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.overhead_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.overhead_items TO service_role;

COMMENT ON TABLE public.overhead_items IS
  'Recurring business overhead definitions (rent, utilities, insurance, subscriptions). Parent to overhead_payments and overhead_reminders via composite FK per Principle 11.';

-- ============================================================================
-- 2. overhead_payments
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.overhead_payments (
  id                       uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id                 text         NOT NULL,
  item_id                  uuid         NOT NULL,
  period_year              integer      NOT NULL,
  period_month             integer      NOT NULL,
  paid_date                date,
  amount_cents             bigint       NOT NULL,
  tax_amount_cents         bigint,
  currency                 text         NOT NULL DEFAULT 'CAD',
  source                   text         NOT NULL DEFAULT 'manual',
  confirmed_at             timestamptz  NOT NULL DEFAULT now(),
  source_msg_id            text,
  transaction_id           uuid,
  correlation_id           uuid         NOT NULL DEFAULT gen_random_uuid(),
  created_at               timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT overhead_payments_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT overhead_payments_period_month_chk CHECK (period_month BETWEEN 1 AND 12),
  CONSTRAINT overhead_payments_period_year_chk CHECK (period_year BETWEEN 2024 AND 2100),
  CONSTRAINT overhead_payments_amount_nonneg CHECK (amount_cents >= 0),
  CONSTRAINT overhead_payments_source_chk
    CHECK (source IN ('manual','whatsapp','portal','import')),
  CONSTRAINT overhead_payments_currency_chk CHECK (currency IN ('CAD','USD')),
  -- Composite FK to parent item (Principle 11)
  CONSTRAINT overhead_payments_item_identity_fk
    FOREIGN KEY (item_id, tenant_id, owner_id)
    REFERENCES public.overhead_items(id, tenant_id, owner_id)
    ON DELETE RESTRICT,
  -- Composite FK to parallel transactions row (nullable)
  CONSTRAINT overhead_payments_transaction_identity_fk
    FOREIGN KEY (transaction_id, tenant_id, owner_id)
    REFERENCES public.transactions(id, tenant_id, owner_id)
    ON DELETE SET NULL
);

-- One payment per item per month (adjustments use negative amounts)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'overhead_payments_item_period_unique'
      AND conrelid = 'public.overhead_payments'::regclass
  ) THEN
    ALTER TABLE public.overhead_payments
      ADD CONSTRAINT overhead_payments_item_period_unique UNIQUE (item_id, period_year, period_month);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS overhead_payments_owner_source_msg_unique_idx
  ON public.overhead_payments (owner_id, source_msg_id)
  WHERE source_msg_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS overhead_payments_tenant_period_idx
  ON public.overhead_payments (tenant_id, period_year DESC, period_month DESC);
CREATE INDEX IF NOT EXISTS overhead_payments_item_idx
  ON public.overhead_payments (item_id, period_year DESC, period_month DESC);

ALTER TABLE public.overhead_payments ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='overhead_payments'
                   AND policyname='overhead_payments_tenant_select') THEN
    CREATE POLICY overhead_payments_tenant_select ON public.overhead_payments FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='overhead_payments'
                   AND policyname='overhead_payments_tenant_insert') THEN
    CREATE POLICY overhead_payments_tenant_insert ON public.overhead_payments FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='overhead_payments'
                   AND policyname='overhead_payments_tenant_update') THEN
    CREATE POLICY overhead_payments_tenant_update ON public.overhead_payments FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.overhead_payments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.overhead_payments TO service_role;

COMMENT ON TABLE public.overhead_payments IS
  'Per-payment record for an overhead item. App-code emits parallel transactions row (kind=''expense'', category=item.category) at confirm time with matching source_msg_id for idempotency. transaction_id stores the linkage.';

-- ============================================================================
-- 3. overhead_reminders
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.overhead_reminders (
  id                       uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id                 text         NOT NULL,
  item_id                  uuid         NOT NULL,
  item_name                text         NOT NULL,
  period_year              integer      NOT NULL,
  period_month             integer      NOT NULL,
  amount_cents             bigint       NOT NULL,
  tax_amount_cents         bigint,
  status                   text         NOT NULL DEFAULT 'pending',
  whatsapp_sent_at         timestamptz,
  correlation_id           uuid         NOT NULL DEFAULT gen_random_uuid(),
  created_at               timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT overhead_reminders_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT overhead_reminders_status_chk
    CHECK (status IN ('pending','sent','acknowledged','cancelled')),
  CONSTRAINT overhead_reminders_period_month_chk CHECK (period_month BETWEEN 1 AND 12),
  CONSTRAINT overhead_reminders_period_year_chk CHECK (period_year BETWEEN 2024 AND 2100),
  CONSTRAINT overhead_reminders_item_identity_fk
    FOREIGN KEY (item_id, tenant_id, owner_id)
    REFERENCES public.overhead_items(id, tenant_id, owner_id)
    ON DELETE CASCADE
);

-- One reminder per item per month
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'overhead_reminders_item_period_unique'
      AND conrelid = 'public.overhead_reminders'::regclass
  ) THEN
    ALTER TABLE public.overhead_reminders
      ADD CONSTRAINT overhead_reminders_item_period_unique UNIQUE (item_id, period_year, period_month);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS overhead_reminders_tenant_status_idx
  ON public.overhead_reminders (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS overhead_reminders_item_idx
  ON public.overhead_reminders (item_id);

ALTER TABLE public.overhead_reminders ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='overhead_reminders'
                   AND policyname='overhead_reminders_tenant_select') THEN
    CREATE POLICY overhead_reminders_tenant_select ON public.overhead_reminders FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

GRANT SELECT ON public.overhead_reminders TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.overhead_reminders TO service_role;

COMMENT ON TABLE public.overhead_reminders IS
  'Scheduled reminder events for upcoming overhead payments. One row per (item, upcoming period). Cron dispatcher updates status. authenticated gets SELECT only; service_role does INSERT/UPDATE.';

COMMIT;
