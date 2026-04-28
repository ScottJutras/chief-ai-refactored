-- Migration: 2026_04_22_amendment_supplier_catalog_products.sql
--
-- PHASE 1 AMENDMENT (Session P1A-2, Part 2 of 3) for Foundation Rebuild V2.
--
-- Gap source: Phase 4.5 classification Q2 — founder confirmed preserve.
-- See 2026_04_22_amendment_supplier_catalog_root.sql provenance for full
-- context.
--
-- Tables in this file (3): catalog_products, catalog_price_history,
-- catalog_ingestion_log — the product/pricing/ingestion-audit tables.
--
-- Decisions preserved from root migration:
--   A — GLOBAL (no tenant_id on suppliers propagates here — catalog_products
--       inherits GLOBAL visibility through its supplier_id FK).
--   E — catalog_price_history is append-only (service_role SELECT+INSERT only;
--       no UPDATE, no DELETE policies). Hard column-restriction trigger
--       deferred to Session P3-4c.
--
-- Dependencies:
--   - public.suppliers (created in supplier_catalog_root.sql)
--   - public.supplier_categories (created in supplier_catalog_root.sql)
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='suppliers') THEN
    RAISE EXCEPTION 'Requires public.suppliers (apply supplier_catalog_root first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='supplier_categories') THEN
    RAISE EXCEPTION 'Requires public.supplier_categories';
  END IF;
END
$preflight$;

-- ============================================================================
-- 1. catalog_products — the priced catalog
--
-- Production uses `integer` (not `bigint`) for unit_price_cents. Max ~$21M
-- per line item — more than adequate for building materials. Preserving
-- production type.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.catalog_products (
  id                       uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id              uuid         NOT NULL
    REFERENCES public.suppliers(id) ON DELETE CASCADE,
  category_id              uuid
    REFERENCES public.supplier_categories(id) ON DELETE SET NULL,
  sku                      text         NOT NULL,
  name                     text         NOT NULL,
  description              text,
  unit_of_measure          text         NOT NULL,
  unit_price_cents         integer      NOT NULL,
  price_type               text         NOT NULL DEFAULT 'list',
  price_effective_date     date         NOT NULL,
  price_expires_date       date,
  min_order_quantity       integer      NOT NULL DEFAULT 1,
  is_active                boolean      NOT NULL DEFAULT true,
  discontinued_at          timestamptz,
  metadata                 jsonb        NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz  NOT NULL DEFAULT now(),
  updated_at               timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT catalog_products_sku_nonempty CHECK (char_length(sku) > 0),
  CONSTRAINT catalog_products_name_nonempty CHECK (char_length(name) > 0),
  CONSTRAINT catalog_products_unit_of_measure_nonempty CHECK (char_length(unit_of_measure) > 0),
  CONSTRAINT catalog_products_unit_price_nonneg CHECK (unit_price_cents >= 0),
  CONSTRAINT catalog_products_price_type_chk
    CHECK (price_type IN ('list','contractor','distributor','promo')),
  CONSTRAINT catalog_products_min_order_positive CHECK (min_order_quantity >= 1),
  CONSTRAINT catalog_products_price_expiry_after_effective
    CHECK (price_expires_date IS NULL OR price_expires_date >= price_effective_date),
  CONSTRAINT catalog_products_discontinued_iff_inactive
    CHECK ((discontinued_at IS NULL) OR (is_active = false)),
  CONSTRAINT catalog_products_supplier_sku_unique UNIQUE (supplier_id, sku)
);

CREATE INDEX IF NOT EXISTS catalog_products_supplier_active_name_idx
  ON public.catalog_products (supplier_id, is_active, name)
  WHERE is_active = true;
CREATE INDEX IF NOT EXISTS catalog_products_supplier_category_idx
  ON public.catalog_products (supplier_id, category_id, name)
  WHERE category_id IS NOT NULL AND is_active = true;
CREATE INDEX IF NOT EXISTS catalog_products_sku_idx
  ON public.catalog_products (lower(sku));
CREATE INDEX IF NOT EXISTS catalog_products_price_effective_idx
  ON public.catalog_products (supplier_id, price_effective_date DESC);

ALTER TABLE public.catalog_products ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Contractor read: active products of active suppliers. Plan gate at route layer.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='catalog_products'
                   AND policyname='catalog_products_authenticated_select_active') THEN
    CREATE POLICY catalog_products_authenticated_select_active
      ON public.catalog_products FOR SELECT
      TO authenticated
      USING (
        is_active = true
        AND EXISTS (
          SELECT 1 FROM public.suppliers s
          WHERE s.id = supplier_id
            AND s.status = 'active' AND s.is_active = true
        )
      );
  END IF;

  -- Supplier-portal write: owners/admins/editors CRUD their own products.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='catalog_products'
                   AND policyname='catalog_products_supplier_portal_insert') THEN
    CREATE POLICY catalog_products_supplier_portal_insert
      ON public.catalog_products FOR INSERT
      TO authenticated
      WITH CHECK (
        supplier_id IN (
          SELECT supplier_id FROM public.supplier_users
          WHERE auth_uid = auth.uid() AND is_active = true
        )
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='catalog_products'
                   AND policyname='catalog_products_supplier_portal_select') THEN
    -- Supplier-portal sees ALL their own products (including inactive/discontinued)
    CREATE POLICY catalog_products_supplier_portal_select
      ON public.catalog_products FOR SELECT
      TO authenticated
      USING (
        supplier_id IN (
          SELECT supplier_id FROM public.supplier_users
          WHERE auth_uid = auth.uid() AND is_active = true
        )
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='catalog_products'
                   AND policyname='catalog_products_supplier_portal_update') THEN
    CREATE POLICY catalog_products_supplier_portal_update
      ON public.catalog_products FOR UPDATE
      TO authenticated
      USING (
        supplier_id IN (
          SELECT supplier_id FROM public.supplier_users
          WHERE auth_uid = auth.uid() AND is_active = true
        )
      )
      WITH CHECK (
        supplier_id IN (
          SELECT supplier_id FROM public.supplier_users
          WHERE auth_uid = auth.uid() AND is_active = true
        )
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='catalog_products'
                   AND policyname='catalog_products_supplier_portal_delete') THEN
    CREATE POLICY catalog_products_supplier_portal_delete
      ON public.catalog_products FOR DELETE
      TO authenticated
      USING (
        supplier_id IN (
          SELECT supplier_id FROM public.supplier_users
          WHERE auth_uid = auth.uid() AND is_active = true AND role IN ('owner','admin')
        )
      );
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.catalog_products TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.catalog_products TO service_role;

COMMENT ON TABLE public.catalog_products IS
  'Supplier catalog products. UNIQUE (supplier_id, sku). Contractor portal sees active products of active suppliers (plan gate at route layer). Supplier-portal users CRUD their own products; delete requires owner/admin role.';
COMMENT ON COLUMN public.catalog_products.unit_price_cents IS
  'Integer (not bigint) — max ~$21M per line item, adequate for building materials. Matches production.';

-- ============================================================================
-- 2. catalog_price_history — append-only price change log
--
-- Per Decision E: service_role SELECT+INSERT only; no UPDATE/DELETE policies
-- for authenticated. Column-restriction trigger (blocking UPDATE on any
-- column, blocking DELETE entirely) deferred to Session P3-4c alongside
-- other 7 append-only table triggers.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.catalog_price_history (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id        uuid         NOT NULL
    REFERENCES public.catalog_products(id) ON DELETE CASCADE,
  supplier_id       uuid         NOT NULL
    REFERENCES public.suppliers(id) ON DELETE CASCADE,
  old_price_cents   integer,
  new_price_cents   integer      NOT NULL,
  price_type        text         NOT NULL DEFAULT 'list',
  effective_date    date         NOT NULL,
  change_source     text         NOT NULL,
  created_at        timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT catalog_price_history_old_nonneg
    CHECK (old_price_cents IS NULL OR old_price_cents >= 0),
  CONSTRAINT catalog_price_history_new_nonneg CHECK (new_price_cents >= 0),
  CONSTRAINT catalog_price_history_price_type_chk
    CHECK (price_type IN ('list','contractor','distributor','promo')),
  CONSTRAINT catalog_price_history_change_source_chk
    CHECK (change_source IN ('manual','ingestion','api','migration'))
);

CREATE INDEX IF NOT EXISTS catalog_price_history_product_idx
  ON public.catalog_price_history (product_id, effective_date DESC);
CREATE INDEX IF NOT EXISTS catalog_price_history_supplier_date_idx
  ON public.catalog_price_history (supplier_id, effective_date DESC);

ALTER TABLE public.catalog_price_history ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Contractor read: price history visible for active suppliers (plan gate at
  -- route layer). Ask Chief's supplier_spend tool uses this to surface price
  -- increases in vendor-spend responses.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='catalog_price_history'
                   AND policyname='catalog_price_history_authenticated_select') THEN
    CREATE POLICY catalog_price_history_authenticated_select
      ON public.catalog_price_history FOR SELECT
      TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.suppliers s
          WHERE s.id = supplier_id
            AND s.status = 'active' AND s.is_active = true
        )
      );
  END IF;

  -- Supplier-portal sees their own history
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='catalog_price_history'
                   AND policyname='catalog_price_history_supplier_portal_select') THEN
    CREATE POLICY catalog_price_history_supplier_portal_select
      ON public.catalog_price_history FOR SELECT
      TO authenticated
      USING (
        supplier_id IN (
          SELECT supplier_id FROM public.supplier_users
          WHERE auth_uid = auth.uid() AND is_active = true
        )
      );
  END IF;
  -- NO INSERT/UPDATE/DELETE policies: append-only. service_role inserts from
  -- ingestion pipeline. authenticated cannot write.
END $$;

-- Append-only posture: authenticated = SELECT only. service_role = SELECT+INSERT only.
GRANT SELECT ON public.catalog_price_history TO authenticated;
GRANT SELECT, INSERT ON public.catalog_price_history TO service_role;

COMMENT ON TABLE public.catalog_price_history IS
  'Append-only price change log (Decision E). Written by catalogIngest.js during ingestion + manual edits. service_role SELECT+INSERT only; authenticated SELECT only (no UPDATE/DELETE). Hard column-restriction trigger deferred to Session P3-4c.';

-- ============================================================================
-- 3. catalog_ingestion_log — per-upload audit
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.catalog_ingestion_log (
  id                      uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id             uuid         NOT NULL
    REFERENCES public.suppliers(id) ON DELETE CASCADE,
  source_type             text         NOT NULL,
  source_filename         text,
  source_email_id         text,
  products_added          integer      NOT NULL DEFAULT 0,
  products_updated        integer      NOT NULL DEFAULT 0,
  products_discontinued   integer      NOT NULL DEFAULT 0,
  prices_changed          integer      NOT NULL DEFAULT 0,
  errors                  integer      NOT NULL DEFAULT 0,
  error_details           jsonb        NOT NULL DEFAULT '[]'::jsonb,
  status                  text         NOT NULL DEFAULT 'pending',
  started_at              timestamptz,
  completed_at            timestamptz,
  created_at              timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT catalog_ingestion_log_source_type_chk
    CHECK (source_type IN ('xlsx_upload','csv_upload','email_attachment','api','manual')),
  CONSTRAINT catalog_ingestion_log_status_chk
    CHECK (status IN ('pending','processing','completed','failed','partial')),
  CONSTRAINT catalog_ingestion_log_counts_nonneg
    CHECK (products_added >= 0 AND products_updated >= 0
           AND products_discontinued >= 0 AND prices_changed >= 0 AND errors >= 0),
  CONSTRAINT catalog_ingestion_log_completed_iff_timestamp
    CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS catalog_ingestion_log_supplier_created_idx
  ON public.catalog_ingestion_log (supplier_id, created_at DESC);
CREATE INDEX IF NOT EXISTS catalog_ingestion_log_status_idx
  ON public.catalog_ingestion_log (status, created_at DESC)
  WHERE status IN ('pending','processing','failed');

ALTER TABLE public.catalog_ingestion_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Supplier-portal sees their own ingestion history
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='catalog_ingestion_log'
                   AND policyname='catalog_ingestion_log_supplier_portal_select') THEN
    CREATE POLICY catalog_ingestion_log_supplier_portal_select
      ON public.catalog_ingestion_log FOR SELECT
      TO authenticated
      USING (
        supplier_id IN (
          SELECT supplier_id FROM public.supplier_users
          WHERE auth_uid = auth.uid() AND is_active = true
        )
      );
  END IF;
  -- INSERT/UPDATE: service_role only (ingestion pipeline writes)
END $$;

GRANT SELECT ON public.catalog_ingestion_log TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.catalog_ingestion_log TO service_role;

COMMENT ON TABLE public.catalog_ingestion_log IS
  'Per-upload audit for catalogIngest.js runs. Supplier-portal users SELECT their own history; service_role writes. Not visible to contractor portal (internal supplier-side audit).';

COMMIT;
