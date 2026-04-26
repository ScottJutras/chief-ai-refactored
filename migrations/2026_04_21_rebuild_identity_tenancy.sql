-- ============================================================================
-- Foundation Rebuild — Session 1, Part 1: Identity & Tenancy
--
-- Creates the six foundational identity/tenancy tables:
--   1. chiefos_tenants       (tenant root)
--   2. users                 (ingestion identity; redesigned 54 → 25 cols
--                             including Decision 1 signup_status and the
--                             4 auto-assign columns per Receipt Parser §7)
--   3. chiefos_portal_users  (portal membership; auth.users → tenant)
--   4. chiefos_legal_acceptances (append-only compliance log)
--   5. portal_phone_link_otp (phone-pairing OTP with own-owner read policy)
--   6. chiefos_beta_signups  (anon-INSERT waitlist)
--
-- Authoritative sources:
--   - FOUNDATION_P1_SCHEMA_DESIGN.md Section 3.1
--   - 13 closed founder decisions (Decisions 1, 2, 3, 12, 13 especially)
--   - Principles 1, 5, 6, 7, 8, 9, 11 (Section 1 of design doc)
--   - FOUNDATION_P2_SECURITY_AUDIT.md §3 (policy redesign guidance)
--   - Receipt Parser Upgrade Handoff §7 (auto-assign columns on users)
--
-- Dependencies: pgcrypto extension (for gen_random_uuid); auth.users table
--   (Supabase-managed; always present in a Supabase project).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + DO-block policy wrappers.
-- Designed to run against an empty `public` schema on cold-start.
-- ============================================================================

BEGIN;

-- ============================================================================
-- Preflight
-- ============================================================================
DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    RAISE EXCEPTION 'Migration requires pgcrypto extension. Run: CREATE EXTENSION pgcrypto;';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'auth' AND table_name = 'users'
  ) THEN
    RAISE EXCEPTION 'Migration requires Supabase auth.users table to exist';
  END IF;
END
$preflight$;

-- ============================================================================
-- 1. chiefos_tenants — tenant root
-- Source: FOUNDATION_P1_SCHEMA_DESIGN.md §3.1 (chiefos_tenants design page)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.chiefos_tenants (
  id                    uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id              text         NOT NULL,
  name                  text         NOT NULL,
  tz                    text         NOT NULL DEFAULT 'America/Toronto',
  country               text         NOT NULL DEFAULT 'CA',
  province              text,
  currency              text         NOT NULL DEFAULT 'CAD',
  tax_code              text         NOT NULL DEFAULT 'NO_SALES_TAX',
  region                text,
  email_capture_token   text,
  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT chiefos_tenants_owner_id_format_chk
    CHECK (char_length(owner_id) >= 7 AND owner_id ~ '^\d+$'),
  CONSTRAINT chiefos_tenants_currency_chk
    CHECK (currency IN ('CAD','USD')),
  CONSTRAINT chiefos_tenants_country_chk
    CHECK (country = upper(country) AND char_length(country) = 2),
  CONSTRAINT chiefos_tenants_name_nonempty
    CHECK (char_length(name) > 0)
);

-- UNIQUE (owner_id) — fail-closed one-tenant-per-phone (Principle 6)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chiefos_tenants_owner_id_unique'
      AND conrelid = 'public.chiefos_tenants'::regclass
  ) THEN
    ALTER TABLE public.chiefos_tenants
      ADD CONSTRAINT chiefos_tenants_owner_id_unique UNIQUE (owner_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS chiefos_tenants_owner_idx
  ON public.chiefos_tenants (owner_id);

CREATE UNIQUE INDEX IF NOT EXISTS chiefos_tenants_token_idx
  ON public.chiefos_tenants (email_capture_token)
  WHERE email_capture_token IS NOT NULL;

ALTER TABLE public.chiefos_tenants ENABLE ROW LEVEL SECURITY;

-- RLS policies attached BELOW after chiefos_portal_users is created (forward-ref defect fix:
-- CREATE POLICY resolves relation refs at parse time, so policies referencing
-- chiefos_portal_users must run after that table exists).

GRANT SELECT, INSERT, UPDATE ON public.chiefos_tenants TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chiefos_tenants TO service_role;

-- ============================================================================
-- 2. users — ingestion identities (digit-string PK)
-- Source: FOUNDATION_P1_SCHEMA_DESIGN.md §3.1 (users design page)
--
-- Column reduction: 54 (pre-rebuild) → 25 (here) — includes Decision 1's
--   signup_status and four Receipt Parser §7 auto-assign columns.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.users (
  user_id                         text         NOT NULL PRIMARY KEY,
  owner_id                        text         NOT NULL,
  tenant_id                       uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  name                            text,
  email                           text,
  role                            text         NOT NULL DEFAULT 'owner',
  plan_key                        text         NOT NULL DEFAULT 'free',
  tz                              text,
  stripe_customer_id              text,
  stripe_subscription_id          text,
  stripe_price_id                 text,
  sub_status                      text,
  current_period_start            timestamptz,
  current_period_end              timestamptz,
  cancel_at_period_end            boolean      NOT NULL DEFAULT false,
  terms_accepted_at               timestamptz,
  onboarding_completed            boolean      NOT NULL DEFAULT false,
  can_edit_time                   boolean      NOT NULL DEFAULT false,
  signup_status                   text         NOT NULL DEFAULT 'complete',
  auto_assign_active_job_id       integer,        -- FK to jobs(id) added in Session 2
  auto_assign_activated_at        timestamptz,
  auto_assign_daily_reset         boolean      NOT NULL DEFAULT false,
  auto_assign_last_daily_prompt_date date,
  created_at                      timestamptz  NOT NULL DEFAULT now(),
  updated_at                      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT users_user_id_format_chk
    CHECK (char_length(user_id) >= 7 AND user_id ~ '^\d+$'),
  CONSTRAINT users_owner_id_format_chk
    CHECK (char_length(owner_id) >= 7 AND owner_id ~ '^\d+$'),
  CONSTRAINT users_role_chk
    CHECK (role IN ('owner','employee','contractor')),
  CONSTRAINT users_plan_key_chk
    CHECK (plan_key IN ('free','starter','pro','enterprise')),
  CONSTRAINT users_signup_status_chk
    CHECK (signup_status IN ('pending_auth','pending_onboarding','complete'))
);

-- Dual-boundary integrity: composite UNIQUE (owner_id, user_id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_owner_user_unique'
      AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_owner_user_unique UNIQUE (owner_id, user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS users_owner_idx
  ON public.users (owner_id);
CREATE INDEX IF NOT EXISTS users_tenant_idx
  ON public.users (tenant_id);
CREATE INDEX IF NOT EXISTS users_stripe_customer_idx
  ON public.users (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_email_idx
  ON public.users (lower(email))
  WHERE email IS NOT NULL;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- RLS policies attached BELOW after chiefos_portal_users is created (forward-ref defect fix).

-- Note: users INSERTs flow through service_role (signup flow + crew onboarding).
-- No INSERT policy for authenticated — intentional per design §3.1.
GRANT SELECT, UPDATE ON public.users TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users TO service_role;

-- ============================================================================
-- 3. chiefos_portal_users — portal membership (auth.users → tenant)
-- Source: FOUNDATION_P1_SCHEMA_DESIGN.md §3.1 (chiefos_portal_users design page)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.chiefos_portal_users (
  user_id                   uuid         NOT NULL PRIMARY KEY
    REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id                 uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  role                      text         NOT NULL,
  can_insert_financials     boolean      NOT NULL DEFAULT false,
  created_at                timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT chiefos_portal_users_role_chk
    CHECK (role IN ('owner','board_member','employee'))
);

CREATE INDEX IF NOT EXISTS chiefos_portal_users_tenant_idx
  ON public.chiefos_portal_users (tenant_id);
CREATE INDEX IF NOT EXISTS chiefos_portal_users_owner_lookup_idx
  ON public.chiefos_portal_users (tenant_id, role)
  WHERE role = 'owner';

ALTER TABLE public.chiefos_portal_users ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='chiefos_portal_users'
                   AND policyname='portal_users_self_select') THEN
    CREATE POLICY portal_users_self_select
      ON public.chiefos_portal_users FOR SELECT
      USING (user_id = auth.uid());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='chiefos_portal_users'
                   AND policyname='portal_users_tenant_read_by_owner') THEN
    CREATE POLICY portal_users_tenant_read_by_owner
      ON public.chiefos_portal_users FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                           WHERE user_id = auth.uid() AND role = 'owner'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='chiefos_portal_users'
                   AND policyname='portal_users_authenticated_self_insert') THEN
    -- Signup flow: the authenticated user can create their own portal_users row
    -- (tying themselves to a tenant). The tenant must already exist.
    CREATE POLICY portal_users_authenticated_self_insert
      ON public.chiefos_portal_users FOR INSERT
      WITH CHECK (user_id = auth.uid());
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='chiefos_portal_users'
                   AND policyname='portal_users_owner_update_roles') THEN
    -- Owners can update roles in their tenant (replaces the DISCARDed
    -- SECURITY DEFINER chiefos_set_user_role function per Phase 2 plan)
    CREATE POLICY portal_users_owner_update_roles
      ON public.chiefos_portal_users FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                           WHERE user_id = auth.uid() AND role = 'owner'))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                                WHERE user_id = auth.uid() AND role = 'owner'));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.chiefos_portal_users TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chiefos_portal_users TO service_role;

-- ============================================================================
-- Deferred RLS policies for chiefos_tenants and users
--
-- These were originally co-located with their tables (sections 1 and 2) but
-- referenced public.chiefos_portal_users in their USING/WITH CHECK clauses.
-- PostgreSQL resolves CREATE POLICY relation refs at parse time, so the
-- referenced table must already exist. Moved here (after chiefos_portal_users
-- is created in section 3) to fix the forward-reference defect.
-- ============================================================================

-- chiefos_tenants — tenant-membership pattern (Principle 8)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='chiefos_tenants'
                   AND policyname='chiefos_tenants_portal_select') THEN
    CREATE POLICY chiefos_tenants_portal_select
      ON public.chiefos_tenants FOR SELECT
      USING (id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='chiefos_tenants'
                   AND policyname='chiefos_tenants_portal_insert') THEN
    CREATE POLICY chiefos_tenants_portal_insert
      ON public.chiefos_tenants FOR INSERT
      WITH CHECK (true);  -- signup handshake; authenticated role only
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='chiefos_tenants'
                   AND policyname='chiefos_tenants_owner_update') THEN
    CREATE POLICY chiefos_tenants_owner_update
      ON public.chiefos_tenants FOR UPDATE
      USING (id IN (SELECT tenant_id FROM public.chiefos_portal_users
                    WHERE user_id = auth.uid() AND role = 'owner'))
      WITH CHECK (id IN (SELECT tenant_id FROM public.chiefos_portal_users
                         WHERE user_id = auth.uid() AND role = 'owner'));
  END IF;
END $$;

-- users — tenant-membership SELECT; owner-only UPDATE
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='users'
                   AND policyname='users_tenant_select') THEN
    CREATE POLICY users_tenant_select
      ON public.users FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='users'
                   AND policyname='users_tenant_update_owner') THEN
    -- Only owner role in the tenant can UPDATE users
    CREATE POLICY users_tenant_update_owner
      ON public.users FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                           WHERE user_id = auth.uid() AND role = 'owner'))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                                WHERE user_id = auth.uid() AND role = 'owner'));
  END IF;
END $$;

-- ============================================================================
-- 4. chiefos_legal_acceptances — append-only compliance log
-- Source: FOUNDATION_P1_SCHEMA_DESIGN.md §3.1 (chiefos_legal_acceptances)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.chiefos_legal_acceptances (
  id                       uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  auth_user_id             uuid         NOT NULL
    REFERENCES auth.users(id) ON DELETE CASCADE,
  terms_accepted_at        timestamptz  NOT NULL,
  terms_version            text         NOT NULL,
  privacy_accepted_at      timestamptz  NOT NULL,
  privacy_version          text         NOT NULL,
  ai_policy_accepted_at    timestamptz,
  ai_policy_version        text         NOT NULL,
  dpa_acknowledged_at      timestamptz,
  dpa_version              text         NOT NULL,
  accepted_via             text,
  accepted_at              timestamptz,
  ip_address               text,
  user_agent               text,
  created_at               timestamptz  NOT NULL DEFAULT now(),
  updated_at               timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT chiefos_legal_acceptances_accepted_via_chk
    CHECK (accepted_via IS NULL OR accepted_via IN ('portal','whatsapp','email','api'))
);

CREATE INDEX IF NOT EXISTS chiefos_legal_acceptances_tenant_idx
  ON public.chiefos_legal_acceptances (tenant_id);
CREATE INDEX IF NOT EXISTS chiefos_legal_acceptances_auth_user_idx
  ON public.chiefos_legal_acceptances (auth_user_id);

ALTER TABLE public.chiefos_legal_acceptances ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='chiefos_legal_acceptances'
                   AND policyname='legal_acceptances_select_by_tenant_membership') THEN
    CREATE POLICY legal_acceptances_select_by_tenant_membership
      ON public.chiefos_legal_acceptances FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  -- INSERT/UPDATE/DELETE deliberately denied to authenticated — append-only.
  -- Service role writes acceptances on user action.
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='chiefos_legal_acceptances'
                   AND policyname='legal_acceptances_insert_block_client') THEN
    CREATE POLICY legal_acceptances_insert_block_client
      ON public.chiefos_legal_acceptances FOR INSERT
      WITH CHECK (false);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='chiefos_legal_acceptances'
                   AND policyname='legal_acceptances_update_block_client') THEN
    CREATE POLICY legal_acceptances_update_block_client
      ON public.chiefos_legal_acceptances FOR UPDATE
      USING (false)
      WITH CHECK (false);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='chiefos_legal_acceptances'
                   AND policyname='legal_acceptances_delete_block_client') THEN
    CREATE POLICY legal_acceptances_delete_block_client
      ON public.chiefos_legal_acceptances FOR DELETE
      USING (false);
  END IF;
END $$;

GRANT SELECT ON public.chiefos_legal_acceptances TO authenticated;
GRANT SELECT, INSERT ON public.chiefos_legal_acceptances TO service_role;
-- DELETE deliberately not granted even to service_role: append-only by design.

-- ============================================================================
-- 5. portal_phone_link_otp — time-bounded OTP for phone pairing
-- Source: FOUNDATION_P1_SCHEMA_DESIGN.md §3.1 (portal_phone_link_otp)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.portal_phone_link_otp (
  auth_user_id     uuid         NOT NULL PRIMARY KEY
    REFERENCES auth.users(id) ON DELETE CASCADE,
  phone_digits     text         NOT NULL,
  otp_hash         text         NOT NULL,
  expires_at       timestamptz  NOT NULL,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT portal_phone_link_otp_expires_after_created
    CHECK (expires_at > created_at),
  CONSTRAINT portal_phone_link_otp_phone_digits_format
    CHECK (char_length(phone_digits) >= 7 AND phone_digits ~ '^\d+$')
);

CREATE INDEX IF NOT EXISTS portal_phone_link_otp_expires_idx
  ON public.portal_phone_link_otp (expires_at);

ALTER TABLE public.portal_phone_link_otp ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='portal_phone_link_otp'
                   AND policyname='portal_phone_link_otp_own_select') THEN
    CREATE POLICY portal_phone_link_otp_own_select
      ON public.portal_phone_link_otp FOR SELECT
      USING (auth_user_id = auth.uid());
  END IF;
  -- INSERT/UPDATE/DELETE service_role only: handled by backend verification flow.
END $$;

GRANT SELECT ON public.portal_phone_link_otp TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.portal_phone_link_otp TO service_role;

-- ============================================================================
-- 6. chiefos_beta_signups — anon-INSERT waitlist
-- Source: FOUNDATION_P1_SCHEMA_DESIGN.md §3.1 (chiefos_beta_signups)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.chiefos_beta_signups (
  id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text         NOT NULL,
  name                text,
  phone               text,
  ip                  text,
  source              text,
  plan                text         NOT NULL DEFAULT 'unknown',
  status              text         NOT NULL DEFAULT 'requested',
  entitlement_plan    text,
  approved_at         timestamptz,
  notes               text,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT chiefos_beta_signups_plan_chk
    CHECK (plan IN ('unknown','starter','pro','enterprise')),
  CONSTRAINT chiefos_beta_signups_status_chk
    CHECK (status IN ('requested','approved','onboarded','declined'))
);

CREATE INDEX IF NOT EXISTS chiefos_beta_signups_email_idx
  ON public.chiefos_beta_signups (lower(email));
CREATE INDEX IF NOT EXISTS chiefos_beta_signups_status_idx
  ON public.chiefos_beta_signups (status, created_at DESC);

ALTER TABLE public.chiefos_beta_signups ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='chiefos_beta_signups'
                   AND policyname='chiefos_beta_signups_anon_insert') THEN
    -- Intentional: public waitlist form. SELECT is service_role only.
    CREATE POLICY chiefos_beta_signups_anon_insert
      ON public.chiefos_beta_signups FOR INSERT
      WITH CHECK (true);
  END IF;
END $$;

GRANT INSERT ON public.chiefos_beta_signups TO anon;
GRANT INSERT ON public.chiefos_beta_signups TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chiefos_beta_signups TO service_role;

-- ============================================================================
-- Comments for future maintainers
-- ============================================================================
COMMENT ON TABLE public.chiefos_tenants IS
  'Tenant root. One row per business. Source of truth for tenant_id, owner_id (digit-string), currency, timezone, tax region.';
COMMENT ON TABLE public.users IS
  'Ingestion identities keyed by digit-string user_id. Holds plan/Stripe state and WhatsApp-side identity. 54-col legacy predecessor reduced to 25 cols per Foundation Rebuild V2 design.';
COMMENT ON TABLE public.chiefos_portal_users IS
  'Portal membership: auth.users → tenant mapping with role. RLS linchpin — tenant-membership policies across the schema subquery this table.';
COMMENT ON TABLE public.chiefos_legal_acceptances IS
  'Append-only compliance log. One row per tenant × user × policy-acceptance event. Client-side DELETE/UPDATE explicitly blocked via RLS WITH CHECK (false).';
COMMENT ON TABLE public.portal_phone_link_otp IS
  'Time-bounded OTP for portal-to-WhatsApp phone pairing. One in-flight OTP per auth user (PK on auth_user_id).';
COMMENT ON TABLE public.chiefos_beta_signups IS
  'Public beta waitlist. Anonymous INSERT permitted for form submissions; service-role reads only.';

COMMIT;
