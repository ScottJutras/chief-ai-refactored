-- Migration: 2026_04_22_amendment_supplier_catalog_root.sql
--
-- PHASE 1 AMENDMENT (Session P1A-2, Part 1 of 3) for Foundation Rebuild V2.
--
-- Gap source: Phase 4.5 classification Q2 — founder confirmed preserve.
-- Reason: load-bearing for Quotes pricing (line-item composition via the
-- polymorphic source_type model deferred to Phase B), Ask Chief's
-- `catalog_lookup` tool (wired at services/agent/index.js:158), and
-- channel-partner GTM (Gentek, Home Hardware, TIMBER MART). Phase 1 §6.1
-- Decision 6 ("out of scope") was incorrect.
--
-- Tables in this file (3): suppliers, supplier_users, supplier_categories —
-- the identity/structure root of the supplier catalog cluster.
--
-- Authoritative reference: PHASE_4_5_DECISIONS_AND_HANDOFF.md §8 Gap 2.
-- Schema shape: matches live production `xnmsjdummnnistzcxrtj.public.<table>`
-- introspected 2026-04-22 (production is authoritative per P1A-1's drift-
-- correction precedent).
--
-- Design decisions resolved during authoring (see §3.13 design pages):
--   Decision A — `suppliers` is fully GLOBAL. Production has NO tenant_id
--     column; one supplier record, visible to all contractor tenants.
--   Decision B — `supplier_users.auth_uid` references auth.users(id)
--     directly. This is a parallel auth channel: supplier-portal users are
--     NOT chiefos_portal_users members. Production lacks the explicit FK;
--     rebuild ADDS it for referential integrity.
--   Decision C — Contractor read plan-gating is applied at app-code layer
--     (routes/catalog.js `requireCatalogAccess` middleware checks plan_key
--     before RLS fires). Rebuild preserves this posture — no plan check in
--     RLS itself. Route-layer gate + tenant-membership RLS compose safely.
--   Decision D — Admin (Scott) approval flow uses service_role with a
--     hardcoded email check at route layer (routes/supplierPortal.js
--     `requireChiefOSAdmin`). No admin-role RLS needed.
--
-- Dependencies:
--   - public.chiefos_tenants (Session P3-1)
--   - public.chiefos_portal_users (Session P3-1)
--   - auth.users (Supabase-owned)
--
-- Apply-order: between P1A-1 amendments (steps 17a-17c) and P3-4a rebuild_
-- functions. Manifest updates add entries 17d-17f.
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
  -- auth.users is Supabase-owned; verify visibility to this schema
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='auth' AND table_name='users') THEN
    RAISE EXCEPTION 'Requires auth.users (Supabase Auth schema)';
  END IF;
END
$preflight$;

-- ============================================================================
-- 1. suppliers — GLOBAL supplier registry
--
-- Fully GLOBAL: no tenant_id. One row per partner brand. Visible to every
-- contractor tenant on Starter+ plans (plan gate at route layer).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.suppliers (
  id                          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                        text         NOT NULL,
  name                        text         NOT NULL,
  description                 text,
  public_description          text,
  website_url                 text,
  logo_storage_key            text,
  contact_email               text,
  primary_contact_name        text,
  primary_contact_email       text,
  primary_contact_phone       text,
  company_phone               text,
  company_address             text,
  city                        text,
  region                      text         NOT NULL DEFAULT 'canada',
  supplier_type               text         NOT NULL DEFAULT 'manufacturer',
  catalog_update_cadence      text         NOT NULL DEFAULT 'quarterly',
  status                      text         NOT NULL DEFAULT 'active',
  is_active                   boolean      NOT NULL DEFAULT true,
  onboarding_completed        boolean      NOT NULL DEFAULT false,
  approved_at                 timestamptz,
  approved_by                 text,
  created_at                  timestamptz  NOT NULL DEFAULT now(),
  updated_at                  timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT suppliers_slug_nonempty CHECK (char_length(slug) > 0),
  CONSTRAINT suppliers_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9_-]*$'),
  CONSTRAINT suppliers_name_nonempty CHECK (char_length(name) > 0),
  CONSTRAINT suppliers_status_chk
    CHECK (status IN ('pending','active','suspended','archived')),
  CONSTRAINT suppliers_supplier_type_chk
    CHECK (supplier_type IN ('manufacturer','distributor','retailer','other')),
  CONSTRAINT suppliers_catalog_cadence_chk
    CHECK (catalog_update_cadence IN ('weekly','monthly','quarterly','annually','on_change')),
  CONSTRAINT suppliers_region_chk
    CHECK (region IN ('canada','usa','international')),
  CONSTRAINT suppliers_slug_unique UNIQUE (slug)
);

CREATE INDEX IF NOT EXISTS suppliers_status_idx
  ON public.suppliers (status);
CREATE INDEX IF NOT EXISTS suppliers_active_idx
  ON public.suppliers (is_active, status)
  WHERE is_active = true;

ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Contractor read: active GLOBAL suppliers visible to any tenant member.
  -- Plan gating is enforced at route layer (routes/catalog.js requireCatalogAccess)
  -- before query hits RLS. The RLS policy is "any authenticated user can SELECT
  -- active suppliers" — consistent with GLOBAL data visibility.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='suppliers'
                   AND policyname='suppliers_authenticated_select_active') THEN
    CREATE POLICY suppliers_authenticated_select_active
      ON public.suppliers FOR SELECT
      TO authenticated
      USING (status = 'active' AND is_active = true);
  END IF;
  -- INSERT + DELETE: service_role only (admin approval flow via
  -- routes/supplierPortal.js requireChiefOSAdmin).
END $$;

-- suppliers_supplier_portal_select + suppliers_supplier_portal_update policies
-- reference public.supplier_users; created BELOW after supplier_users CREATE TABLE
-- (forward-ref defect fix: PG resolves CREATE POLICY relation refs at parse time,
-- so policies referencing supplier_users must run after that table exists).

GRANT SELECT, UPDATE ON public.suppliers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.suppliers TO service_role;

COMMENT ON TABLE public.suppliers IS
  'Supplier registry — fully GLOBAL (no tenant_id). Visible to any contractor tenant on Starter+ plans (plan gate at route layer). Supplier-portal users access via supplier_users membership (non-standard auth surface). Admin approval via service_role (route-layer email check).';

-- ============================================================================
-- 2. supplier_users — supplier-portal auth surface
--
-- References auth.users(id) directly (not chiefos_portal_users) — supplier
-- users are a SEPARATE auth channel. UNIQUE (auth_uid) means one auth user
-- belongs to exactly one supplier.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.supplier_users (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_uid          uuid         NOT NULL
    REFERENCES auth.users(id) ON DELETE CASCADE,
  supplier_id       uuid         NOT NULL
    REFERENCES public.suppliers(id) ON DELETE CASCADE,
  email             text         NOT NULL,
  full_name         text         NOT NULL,
  role              text         NOT NULL DEFAULT 'owner',
  is_active         boolean      NOT NULL DEFAULT true,
  last_login_at     timestamptz,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT supplier_users_email_nonempty CHECK (char_length(email) > 0),
  CONSTRAINT supplier_users_full_name_nonempty CHECK (char_length(full_name) > 0),
  CONSTRAINT supplier_users_role_chk
    CHECK (role IN ('owner','admin','editor')),
  CONSTRAINT supplier_users_auth_uid_unique UNIQUE (auth_uid)
);

CREATE INDEX IF NOT EXISTS supplier_users_supplier_idx
  ON public.supplier_users (supplier_id, is_active);
CREATE INDEX IF NOT EXISTS supplier_users_email_idx
  ON public.supplier_users (lower(email));

ALTER TABLE public.supplier_users ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Self-SELECT: supplier-portal user sees their own membership
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='supplier_users'
                   AND policyname='supplier_users_self_select') THEN
    CREATE POLICY supplier_users_self_select
      ON public.supplier_users FOR SELECT
      TO authenticated
      USING (auth_uid = auth.uid());
  END IF;

  -- Co-supplier read: supplier-portal user sees their supplier's other members
  -- (for team-management UI). Gated strictly to the same supplier.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='supplier_users'
                   AND policyname='supplier_users_co_supplier_select') THEN
    CREATE POLICY supplier_users_co_supplier_select
      ON public.supplier_users FOR SELECT
      TO authenticated
      USING (
        supplier_id IN (
          SELECT supplier_id FROM public.supplier_users
          WHERE auth_uid = auth.uid() AND is_active = true
        )
      );
  END IF;

  -- UPDATE own row (last_login_at touch, name/email changes)
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='supplier_users'
                   AND policyname='supplier_users_self_update') THEN
    CREATE POLICY supplier_users_self_update
      ON public.supplier_users FOR UPDATE
      TO authenticated
      USING (auth_uid = auth.uid())
      WITH CHECK (auth_uid = auth.uid());
  END IF;
  -- INSERT (team-member add) + DELETE: service_role only for now.
  -- Supplier owner adding team-members flows through route-layer endpoint.
END $$;

GRANT SELECT, UPDATE ON public.supplier_users TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.supplier_users TO service_role;

COMMENT ON TABLE public.supplier_users IS
  'Supplier-portal authentication membership. Non-standard: auth_uid references auth.users(id) directly (not chiefos_portal_users membership). UNIQUE (auth_uid) means one auth user belongs to exactly one supplier. Supplier team management: service_role adds/removes members via route-layer endpoints.';

-- ============================================================================
-- Deferred suppliers RLS policies (forward-ref defect fix)
--
-- These two policies on public.suppliers reference public.supplier_users in
-- their USING/WITH CHECK clauses. They were originally co-located with the
-- suppliers section above but moved here (after supplier_users CREATE TABLE)
-- so the relation reference resolves at CREATE POLICY parse time.
-- ============================================================================
DO $$
BEGIN
  -- Supplier-portal users: SELECT their own supplier (regardless of status —
  -- they need to see their pending/suspended state).
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='suppliers'
                   AND policyname='suppliers_supplier_portal_select') THEN
    CREATE POLICY suppliers_supplier_portal_select
      ON public.suppliers FOR SELECT
      TO authenticated
      USING (
        id IN (
          SELECT supplier_id FROM public.supplier_users
          WHERE auth_uid = auth.uid() AND is_active = true
        )
      );
  END IF;

  -- Supplier-portal users: UPDATE their own supplier.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='suppliers'
                   AND policyname='suppliers_supplier_portal_update') THEN
    CREATE POLICY suppliers_supplier_portal_update
      ON public.suppliers FOR UPDATE
      TO authenticated
      USING (
        id IN (
          SELECT supplier_id FROM public.supplier_users
          WHERE auth_uid = auth.uid() AND is_active = true AND role IN ('owner','admin')
        )
      )
      WITH CHECK (
        id IN (
          SELECT supplier_id FROM public.supplier_users
          WHERE auth_uid = auth.uid() AND is_active = true AND role IN ('owner','admin')
        )
      );
  END IF;
END $$;

-- ============================================================================
-- 3. supplier_categories — per-supplier category taxonomy (hierarchical)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.supplier_categories (
  id                      uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id             uuid         NOT NULL
    REFERENCES public.suppliers(id) ON DELETE CASCADE,
  parent_category_id      uuid
    REFERENCES public.supplier_categories(id) ON DELETE SET NULL,
  name                    text         NOT NULL,
  slug                    text         NOT NULL,
  sort_order              integer      NOT NULL DEFAULT 0,
  is_active               boolean      NOT NULL DEFAULT true,
  created_at              timestamptz  NOT NULL DEFAULT now(),
  updated_at              timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT supplier_categories_name_nonempty CHECK (char_length(name) > 0),
  CONSTRAINT supplier_categories_slug_nonempty CHECK (char_length(slug) > 0),
  CONSTRAINT supplier_categories_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9_-]*$'),
  CONSTRAINT supplier_categories_supplier_slug_unique UNIQUE (supplier_id, slug)
);

CREATE INDEX IF NOT EXISTS supplier_categories_supplier_idx
  ON public.supplier_categories (supplier_id, is_active, sort_order);
CREATE INDEX IF NOT EXISTS supplier_categories_parent_idx
  ON public.supplier_categories (parent_category_id)
  WHERE parent_category_id IS NOT NULL;

ALTER TABLE public.supplier_categories ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Inherits visibility: if you can see the supplier, you can see its categories.
  -- Contractor + supplier-portal both access via the supplier's row.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='supplier_categories'
                   AND policyname='supplier_categories_authenticated_select') THEN
    CREATE POLICY supplier_categories_authenticated_select
      ON public.supplier_categories FOR SELECT
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

  -- Supplier-portal write: owners/admins/editors of the supplier CRUD their own categories.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='supplier_categories'
                   AND policyname='supplier_categories_supplier_portal_insert') THEN
    CREATE POLICY supplier_categories_supplier_portal_insert
      ON public.supplier_categories FOR INSERT
      TO authenticated
      WITH CHECK (
        supplier_id IN (
          SELECT supplier_id FROM public.supplier_users
          WHERE auth_uid = auth.uid() AND is_active = true
        )
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='supplier_categories'
                   AND policyname='supplier_categories_supplier_portal_update') THEN
    CREATE POLICY supplier_categories_supplier_portal_update
      ON public.supplier_categories FOR UPDATE
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
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='supplier_categories'
                   AND policyname='supplier_categories_supplier_portal_delete') THEN
    CREATE POLICY supplier_categories_supplier_portal_delete
      ON public.supplier_categories FOR DELETE
      TO authenticated
      USING (
        supplier_id IN (
          SELECT supplier_id FROM public.supplier_users
          WHERE auth_uid = auth.uid() AND is_active = true AND role IN ('owner','admin')
        )
      );
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.supplier_categories TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.supplier_categories TO service_role;

COMMENT ON TABLE public.supplier_categories IS
  'Per-supplier category taxonomy. Hierarchical via parent_category_id self-FK. UNIQUE (supplier_id, slug). RLS: any authenticated sees active categories of active suppliers; supplier-portal users CRUD their own categories; delete requires owner/admin role.';

COMMIT;
