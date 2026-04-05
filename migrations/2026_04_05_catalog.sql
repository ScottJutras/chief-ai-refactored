-- ============================================================
-- ChiefOS Supplier Catalog Integration
-- Migration: 2026_04_05_catalog
-- Applied via Supabase MCP 2026-04-05
-- ============================================================

CREATE TABLE IF NOT EXISTS public.suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  website_url TEXT,
  logo_storage_key TEXT,
  contact_email TEXT,
  catalog_update_cadence TEXT NOT NULL DEFAULT 'quarterly',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_suppliers_slug ON public.suppliers(slug);
CREATE INDEX IF NOT EXISTS idx_suppliers_active ON public.suppliers(is_active) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS public.supplier_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES public.suppliers(id),
  parent_category_id UUID REFERENCES public.supplier_categories(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(supplier_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_supplier_categories_supplier ON public.supplier_categories(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_categories_parent ON public.supplier_categories(parent_category_id);

CREATE TABLE IF NOT EXISTS public.catalog_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES public.suppliers(id),
  category_id UUID REFERENCES public.supplier_categories(id),
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  unit_of_measure TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  price_type TEXT NOT NULL DEFAULT 'list',
  price_effective_date DATE NOT NULL,
  price_expires_date DATE,
  min_order_quantity INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,
  discontinued_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(supplier_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_catalog_products_supplier ON public.catalog_products(supplier_id);
CREATE INDEX IF NOT EXISTS idx_catalog_products_category ON public.catalog_products(category_id);
CREATE INDEX IF NOT EXISTS idx_catalog_products_active ON public.catalog_products(supplier_id, is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_catalog_products_fts ON public.catalog_products
  USING gin(to_tsvector('english', name || ' ' || COALESCE(description, '')));

CREATE TABLE IF NOT EXISTS public.catalog_price_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES public.catalog_products(id),
  supplier_id UUID NOT NULL REFERENCES public.suppliers(id),
  old_price_cents INTEGER,
  new_price_cents INTEGER NOT NULL,
  price_type TEXT NOT NULL DEFAULT 'list',
  effective_date DATE NOT NULL,
  change_source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_history_product ON public.catalog_price_history(product_id);
CREATE INDEX IF NOT EXISTS idx_price_history_supplier ON public.catalog_price_history(supplier_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.catalog_ingestion_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES public.suppliers(id),
  source_type TEXT NOT NULL,
  source_filename TEXT,
  source_email_id TEXT,
  products_added INTEGER NOT NULL DEFAULT 0,
  products_updated INTEGER NOT NULL DEFAULT 0,
  products_discontinued INTEGER NOT NULL DEFAULT 0,
  prices_changed INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  error_details JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ingestion_log_supplier ON public.catalog_ingestion_log(supplier_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.tenant_supplier_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  supplier_id UUID NOT NULL REFERENCES public.suppliers(id),
  is_preferred BOOLEAN NOT NULL DEFAULT false,
  contractor_account_number TEXT,
  discount_percentage INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, supplier_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_supplier_prefs_tenant ON public.tenant_supplier_preferences(tenant_id);

ALTER TABLE public.tenant_supplier_preferences ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'tenant_supplier_preferences'
      AND policyname = 'tenant_supplier_prefs_tenant_isolation'
  ) THEN
    CREATE POLICY tenant_supplier_prefs_tenant_isolation
      ON public.tenant_supplier_preferences
      FOR ALL
      USING (
        tenant_id IN (
          SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()
        )
      );
  END IF;
END $$;

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS catalog_snapshot JSONB DEFAULT NULL;

-- Seed Gentek Building Products
INSERT INTO public.suppliers (slug, name, description, website_url, catalog_update_cadence)
VALUES (
  'gentek',
  'Gentek Building Products',
  'Canadian manufacturer of exterior building products — siding, soffit, fascia, rainware, and accessories.',
  'https://www.gentek.ca',
  'quarterly'
)
ON CONFLICT (slug) DO NOTHING;
