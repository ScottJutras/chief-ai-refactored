-- Migration: 2026_04_22_amendment_tenant_supplier_preferences.sql
--
-- PHASE 1 AMENDMENT (Session P1A-2, Part 3 of 3) for Foundation Rebuild V2.
--
-- Gap source: Phase 4.5 classification Q2 — founder confirmed preserve.
-- See 2026_04_22_amendment_supplier_catalog_root.sql provenance for full
-- context.
--
-- Single table: tenant_supplier_preferences — the one tenant-scoped table
-- in the supplier catalog cluster. Contractor tenants opt in to a
-- "preferred supplier" relationship, store their account number with the
-- supplier, and record any discount percentage.
--
-- Production schema notes:
--   - is_preferred boolean (NOT a 3-way enum — corrects handoff §3 assumption)
--   - discount_percentage integer (0-100 range)
--   - contractor_account_number text (supplier-assigned account # for
--     purchase history lookups)
--   - NO owner_id column — tenant-only scoping (no dual-boundary here;
--     preferences are a tenant-level decision, not an owner-level decision
--     in a multi-seat tenant)
--   - Production lacks FK on tenant_id → chiefos_tenants(id); rebuild ADDS it
--
-- Dependencies:
--   - public.chiefos_tenants (Session P3-1)
--   - public.chiefos_portal_users (Session P3-1) — for RLS
--   - public.suppliers (created in supplier_catalog_root.sql)
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
                 WHERE table_schema='public' AND table_name='suppliers') THEN
    RAISE EXCEPTION 'Requires public.suppliers (apply supplier_catalog_root first)';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.tenant_supplier_preferences (
  id                          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  supplier_id                 uuid         NOT NULL
    REFERENCES public.suppliers(id) ON DELETE CASCADE,
  is_preferred                boolean      NOT NULL DEFAULT false,
  contractor_account_number   text,
  discount_percentage         integer      NOT NULL DEFAULT 0,
  notes                       text,
  created_at                  timestamptz  NOT NULL DEFAULT now(),
  updated_at                  timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT tenant_supplier_preferences_discount_range
    CHECK (discount_percentage BETWEEN 0 AND 100),
  CONSTRAINT tenant_supplier_preferences_tenant_supplier_unique
    UNIQUE (tenant_id, supplier_id)
);

CREATE INDEX IF NOT EXISTS tenant_supplier_preferences_tenant_preferred_idx
  ON public.tenant_supplier_preferences (tenant_id, is_preferred)
  WHERE is_preferred = true;
CREATE INDEX IF NOT EXISTS tenant_supplier_preferences_supplier_idx
  ON public.tenant_supplier_preferences (supplier_id);

ALTER TABLE public.tenant_supplier_preferences ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Standard tenant-membership SELECT
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tenant_supplier_preferences'
                   AND policyname='tenant_supplier_preferences_tenant_select') THEN
    CREATE POLICY tenant_supplier_preferences_tenant_select
      ON public.tenant_supplier_preferences FOR SELECT
      TO authenticated
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  -- INSERT/UPDATE/DELETE: owner or board_member only (tenant-level decision)
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tenant_supplier_preferences'
                   AND policyname='tenant_supplier_preferences_owner_board_insert') THEN
    CREATE POLICY tenant_supplier_preferences_owner_board_insert
      ON public.tenant_supplier_preferences FOR INSERT
      TO authenticated
      WITH CHECK (
        tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                      WHERE user_id = auth.uid() AND role IN ('owner','board_member'))
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tenant_supplier_preferences'
                   AND policyname='tenant_supplier_preferences_owner_board_update') THEN
    CREATE POLICY tenant_supplier_preferences_owner_board_update
      ON public.tenant_supplier_preferences FOR UPDATE
      TO authenticated
      USING (
        tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                      WHERE user_id = auth.uid() AND role IN ('owner','board_member'))
      )
      WITH CHECK (
        tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                      WHERE user_id = auth.uid() AND role IN ('owner','board_member'))
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tenant_supplier_preferences'
                   AND policyname='tenant_supplier_preferences_owner_board_delete') THEN
    CREATE POLICY tenant_supplier_preferences_owner_board_delete
      ON public.tenant_supplier_preferences FOR DELETE
      TO authenticated
      USING (
        tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                      WHERE user_id = auth.uid() AND role IN ('owner','board_member'))
      );
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_supplier_preferences TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_supplier_preferences TO service_role;

COMMENT ON TABLE public.tenant_supplier_preferences IS
  'Tenant-level opt-in relationship with suppliers. No owner_id (tenant-only scope). Writes gated to owner/board_member roles — preferences represent a tenant-level business decision, not a per-owner one. UNIQUE (tenant_id, supplier_id) enforces one-row-per-(tenant, supplier).';
COMMENT ON COLUMN public.tenant_supplier_preferences.contractor_account_number IS
  'Supplier-assigned account number for purchase history lookups. Enables the supplier to link contractor invoices to the contractor''s ChiefOS tenant.';
COMMENT ON COLUMN public.tenant_supplier_preferences.discount_percentage IS
  'Contractor''s negotiated discount off list price (0-100). Applied by quote-building flow when materials from this supplier are selected.';

COMMIT;
