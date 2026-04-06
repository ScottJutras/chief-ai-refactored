-- migrations/2026_04_06_supplier_portal.sql
-- Supplier self-service portal: identity, auth, and status fields.

-- ─── Extend public.suppliers with self-service fields ────────────────────────

ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS status                TEXT    NOT NULL DEFAULT 'active',
  -- 'pending_review' | 'active' | 'suspended' | 'inactive'
  -- Existing admin-seeded suppliers (Gentek) are already active; default to 'active'
  -- New self-service signups should be inserted with status = 'pending_review'
  ADD COLUMN IF NOT EXISTS company_phone         TEXT,
  ADD COLUMN IF NOT EXISTS company_address       TEXT,
  ADD COLUMN IF NOT EXISTS primary_contact_name  TEXT,
  ADD COLUMN IF NOT EXISTS primary_contact_email TEXT,
  ADD COLUMN IF NOT EXISTS primary_contact_phone TEXT,
  ADD COLUMN IF NOT EXISTS onboarding_completed  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS approved_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by           TEXT,
  ADD COLUMN IF NOT EXISTS region                TEXT    NOT NULL DEFAULT 'canada',
  -- 'canada' | 'us' | 'both'
  ADD COLUMN IF NOT EXISTS supplier_type         TEXT    NOT NULL DEFAULT 'manufacturer',
  -- 'manufacturer' | 'distributor' | 'dealer' | 'specialty'
  ADD COLUMN IF NOT EXISTS public_description    TEXT;

-- Mark existing seeded suppliers as active + onboarded
UPDATE public.suppliers SET status = 'active', onboarding_completed = true WHERE status = 'active';

-- ─── supplier_users: links Supabase Auth users to suppliers ──────────────────

CREATE TABLE IF NOT EXISTS public.supplier_users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_uid      UUID        NOT NULL UNIQUE,
  supplier_id   UUID        NOT NULL REFERENCES public.suppliers(id) ON DELETE CASCADE,
  email         TEXT        NOT NULL,
  full_name     TEXT        NOT NULL,
  role          TEXT        NOT NULL DEFAULT 'owner',
  -- 'owner' | 'admin' | 'editor'
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_supplier_users_auth     ON public.supplier_users(auth_uid);
CREATE INDEX IF NOT EXISTS idx_supplier_users_supplier ON public.supplier_users(supplier_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_users_email ON public.supplier_users(email);

-- ─── RLS: supplier users can only see their own supplier's user rows ──────────

ALTER TABLE public.supplier_users ENABLE ROW LEVEL SECURITY;

-- Supplier portal users manage their own record and see teammates
CREATE POLICY supplier_users_own_supplier
  ON public.supplier_users
  USING (
    supplier_id = (
      SELECT supplier_id FROM public.supplier_users WHERE auth_uid = auth.uid() LIMIT 1
    )
  );

-- Supplier users can read/write their own catalog products
-- (existing contractor read policy on catalog_products allows SELECT for authenticated users;
-- this policy allows suppliers to INSERT/UPDATE/DELETE their own products)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'catalog_products' AND policyname = 'supplier_manage_own_products'
  ) THEN
    CREATE POLICY supplier_manage_own_products
      ON public.catalog_products
      FOR ALL
      USING (
        supplier_id = (
          SELECT supplier_id FROM public.supplier_users WHERE auth_uid = auth.uid() LIMIT 1
        )
      );
  END IF;
END $$;

-- Supplier users can manage their own categories
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'supplier_categories' AND policyname = 'supplier_manage_own_categories'
  ) THEN
    CREATE POLICY supplier_manage_own_categories
      ON public.supplier_categories
      FOR ALL
      USING (
        supplier_id = (
          SELECT supplier_id FROM public.supplier_users WHERE auth_uid = auth.uid() LIMIT 1
        )
      );
  END IF;
END $$;
