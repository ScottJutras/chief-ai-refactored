-- Migration: 2026_04_22_amendment_pricing_items.sql
--
-- PHASE 1 AMENDMENT (Session P1A-1) for Foundation Rebuild V2.
--
-- Gap source: Q3 decision in PHASE_4_5_DECISIONS_AND_HANDOFF.md.
-- Reason: pricing_items is the owner's personal rate book (labour, travel, fuel,
-- custom items) — distinct from supplier_catalog. Phase 1 §6.1 marked the table
-- DISCARD; Q3 confirmed it's an active WhatsApp feature (owner says "add pricing:
-- 2x4 lumber @ $5/each") wired via CIL handlers at domain/pricing.js.
--
-- Composite UNIQUE (id, tenant_id, owner_id) per Principle 11 — referenced by
-- chiefos_quote_line_items.source_ref_id under Phase B's polymorphic source_type
-- evolution (deferred per Schema-Evolution note in handoff §8, but composite
-- UNIQUE established from creation so the FK target is ready when Phase B lands).
--
-- Authoritative reference: PHASE_4_5_DECISIONS_AND_HANDOFF.md §3 Gap 5.
-- Design pattern: matches Phase 3 Session 3b supporting tables.
--
-- Depends on: public.chiefos_tenants, public.chiefos_portal_users.
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
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.pricing_items (
  id                 uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id           text         NOT NULL,
  name               text         NOT NULL,
  description        text,
  category           text,
  unit_price_cents   bigint       NOT NULL,
  unit_of_measure    text         NOT NULL,
  notes              text,
  active             boolean      NOT NULL DEFAULT true,
  source             text,
  source_msg_id      text,
  correlation_id     uuid         NOT NULL DEFAULT gen_random_uuid(),
  created_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at         timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT pricing_items_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT pricing_items_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT pricing_items_unit_of_measure_nonempty CHECK (char_length(unit_of_measure) > 0),
  CONSTRAINT pricing_items_unit_price_nonneg CHECK (unit_price_cents >= 0),
  CONSTRAINT pricing_items_category_chk
    CHECK (category IS NULL OR category IN ('labour','travel','fuel','material','custom','other')),
  CONSTRAINT pricing_items_source_chk
    CHECK (source IS NULL OR source IN ('whatsapp','portal','api'))
);

-- Composite identity UNIQUE (Principle 11) — FK target for Phase B's
-- chiefos_quote_line_items.source_ref_id polymorphic reference.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pricing_items_identity_unique'
      AND conrelid = 'public.pricing_items'::regclass
  ) THEN
    ALTER TABLE public.pricing_items
      ADD CONSTRAINT pricing_items_identity_unique UNIQUE (id, tenant_id, owner_id);
  END IF;
END $$;

-- Owner-scoped name uniqueness (soft-archive via active=false): enforce name
-- uniqueness only among active rows, allowing re-use of a name after deletion.
CREATE UNIQUE INDEX IF NOT EXISTS pricing_items_owner_name_active_unique_idx
  ON public.pricing_items (owner_id, lower(name))
  WHERE active = true;

-- Idempotency on WhatsApp creates
CREATE UNIQUE INDEX IF NOT EXISTS pricing_items_owner_source_msg_unique_idx
  ON public.pricing_items (owner_id, source_msg_id)
  WHERE source_msg_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS pricing_items_tenant_active_idx
  ON public.pricing_items (tenant_id, active, category)
  WHERE active = true;

ALTER TABLE public.pricing_items ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='pricing_items'
                   AND policyname='pricing_items_tenant_select') THEN
    CREATE POLICY pricing_items_tenant_select
      ON public.pricing_items FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='pricing_items'
                   AND policyname='pricing_items_tenant_insert') THEN
    CREATE POLICY pricing_items_tenant_insert
      ON public.pricing_items FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='pricing_items'
                   AND policyname='pricing_items_tenant_update') THEN
    CREATE POLICY pricing_items_tenant_update
      ON public.pricing_items FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

-- No DELETE policy — soft-archive via active=false. service_role retains DELETE
-- for admin-level cleanup.
GRANT SELECT, INSERT, UPDATE ON public.pricing_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pricing_items TO service_role;

COMMENT ON TABLE public.pricing_items IS
  'Owner''s personal rate book — labour rates, travel/fuel charges, custom line items. Distinct from supplier_catalog (external pricing). Composite UNIQUE (id, tenant_id, owner_id) per Principle 11 is the FK target for Phase B''s chiefos_quote_line_items.source_ref_id polymorphic reference (deferred to post-cutover per handoff §8).';
COMMENT ON COLUMN public.pricing_items.active IS
  'Soft-archive flag. Deletion = set active=false. Partial UNIQUE on (owner_id, lower(name)) WHERE active=true permits name re-use after archive.';

COMMIT;
