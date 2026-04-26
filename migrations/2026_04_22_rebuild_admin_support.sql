-- ============================================================================
-- Foundation Rebuild — Session P3-3b, Part 5: Admin + support tables
--
-- Section 3.12 of FOUNDATION_P1_SCHEMA_DESIGN.md.
--
-- Creates (in dependency order):
--   1. customers           — auth-orthogonal client entities (closes Phase 2 no-RLS gap)
--   2. settings            — tenant/owner key-value settings (scope discriminator)
--   3. import_batches      — bulk import tracking (CSV / QuickBooks)
--   4. employee_invites    — crew invite flow (token-based)
--   5. chiefos_crew_rates  — historical pay-rate records (role-restricted)
--
-- Notes:
--   - `customers` is step 7 in the rebuild apply order per the manifest — it
--     is a dependency of the Quotes spine. Session P3-3a flagged this; Session
--     P3-3b delivers it. Application of migrations must follow manifest order
--     (customers BEFORE rebuild_quotes_spine if applying cold-start fresh).
--   - `chiefos_crew_rates` intentionally uses SIMPLE FK to chiefos_portal_users
--     (not composite (user_id, tenant_id)): chiefos_portal_users has only
--     PK(user_id) per Session P3-1. A composite UNIQUE on (user_id, tenant_id)
--     would require modifying a Session 1 migration (forbidden by the work
--     order). Flagged in SESSION_P3_3B_MIGRATION_REPORT.md for Session P3-4
--     policy-cleanup to evaluate a composite UNIQUE add.
--
-- Dependencies:
--   - public.chiefos_tenants (Session P3-1)
--   - public.chiefos_portal_users (Session P3-1)
--   - public.users (Session P3-1)
--   - public.media_assets (Session P3-1) — composite FK for import_batches
--   - auth.users (Supabase) — employee_invites.accepted_by_auth_user_id
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
                 WHERE table_schema='public' AND table_name='users') THEN
    RAISE EXCEPTION 'Requires public.users';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='media_assets') THEN
    RAISE EXCEPTION 'Requires public.media_assets';
  END IF;
END
$preflight$;

-- ============================================================================
-- 1. customers — auth-orthogonal client entities
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.customers (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id          text         NOT NULL,
  name              text         NOT NULL,
  phone             text,
  email             text,
  address_line1     text,
  address_line2     text,
  city              text,
  province          text,
  postal_code       text,
  country           text         NOT NULL DEFAULT 'CA',
  notes             text,
  source            text         NOT NULL DEFAULT 'portal',
  source_msg_id     text,
  deleted_at        timestamptz,
  correlation_id    uuid         NOT NULL DEFAULT gen_random_uuid(),
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT customers_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT customers_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT customers_country_iso2 CHECK (char_length(country) = 2 AND country = upper(country)),
  CONSTRAINT customers_source_chk
    CHECK (source IN ('whatsapp','portal','import','quote_handshake'))
);

CREATE UNIQUE INDEX IF NOT EXISTS customers_owner_source_msg_unique_idx
  ON public.customers (owner_id, source_msg_id)
  WHERE source_msg_id IS NOT NULL;

-- Composite identity UNIQUE (Principle 11) — FK target for Quotes spine + future refs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customers_identity_unique'
      AND conrelid = 'public.customers'::regclass
  ) THEN
    ALTER TABLE public.customers
      ADD CONSTRAINT customers_identity_unique UNIQUE (id, tenant_id, owner_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS customers_tenant_name_idx
  ON public.customers (tenant_id, lower(name));
CREATE INDEX IF NOT EXISTS customers_tenant_email_idx
  ON public.customers (tenant_id, lower(email))
  WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS customers_tenant_phone_idx
  ON public.customers (tenant_id, phone)
  WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS customers_deleted_idx
  ON public.customers (tenant_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='customers'
                   AND policyname='customers_tenant_select') THEN
    CREATE POLICY customers_tenant_select ON public.customers FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='customers'
                   AND policyname='customers_tenant_insert') THEN
    CREATE POLICY customers_tenant_insert ON public.customers FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='customers'
                   AND policyname='customers_tenant_update') THEN
    CREATE POLICY customers_tenant_update ON public.customers FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='customers'
                   AND policyname='customers_owner_board_delete') THEN
    CREATE POLICY customers_owner_board_delete ON public.customers FOR DELETE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                           WHERE user_id = auth.uid() AND role IN ('owner','board_member')));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.customers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customers TO service_role;

COMMENT ON TABLE public.customers IS
  'Auth-orthogonal client entities per North Star §14.11. Customer actions (sign, view) capture via chiefos_quote_events + share_tokens; no chiefos_portal_users row required. RLS enabled — closes the Phase 2 no-RLS security finding.';

-- ============================================================================
-- 2. settings — tenant/owner key-value settings
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.settings (
  id                         uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id                   text         NOT NULL,
  scope                      text         NOT NULL DEFAULT 'owner',
  key                        text         NOT NULL,
  value                      jsonb        NOT NULL,
  updated_by_portal_user_id  uuid
    REFERENCES public.chiefos_portal_users(user_id) ON DELETE SET NULL,
  created_at                 timestamptz  NOT NULL DEFAULT now(),
  updated_at                 timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT settings_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT settings_scope_chk CHECK (scope IN ('owner','tenant')),
  CONSTRAINT settings_key_format CHECK (key ~ '^[a-z][a-z0-9_.]*$' AND char_length(key) BETWEEN 1 AND 128)
);

-- Per-(owner, scope, key) uniqueness
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'settings_owner_scope_key_unique'
      AND conrelid = 'public.settings'::regclass
  ) THEN
    ALTER TABLE public.settings
      ADD CONSTRAINT settings_owner_scope_key_unique UNIQUE (owner_id, scope, key);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS settings_tenant_scope_key_idx
  ON public.settings (tenant_id, scope, key);
CREATE INDEX IF NOT EXISTS settings_owner_key_idx
  ON public.settings (owner_id, key)
  WHERE scope = 'owner';

ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='settings'
                   AND policyname='settings_tenant_select') THEN
    CREATE POLICY settings_tenant_select ON public.settings FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='settings'
                   AND policyname='settings_owner_scope_insert') THEN
    -- owner-scope settings: only the owner themselves can INSERT (authenticated
    -- user matched by owner_id's implied mapping is the portal's job; at DB
    -- level we check tenant membership. Per-owner narrowing is portal/app layer.)
    CREATE POLICY settings_owner_scope_insert ON public.settings FOR INSERT
      WITH CHECK (
        (scope = 'owner' AND tenant_id IN
          (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
        OR (scope = 'tenant' AND tenant_id IN
          (SELECT tenant_id FROM public.chiefos_portal_users
           WHERE user_id = auth.uid() AND role = 'owner'))
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='settings'
                   AND policyname='settings_owner_scope_update') THEN
    CREATE POLICY settings_owner_scope_update ON public.settings FOR UPDATE
      USING (
        (scope = 'owner' AND tenant_id IN
          (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
        OR (scope = 'tenant' AND tenant_id IN
          (SELECT tenant_id FROM public.chiefos_portal_users
           WHERE user_id = auth.uid() AND role = 'owner'))
      )
      WITH CHECK (
        (scope = 'owner' AND tenant_id IN
          (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
        OR (scope = 'tenant' AND tenant_id IN
          (SELECT tenant_id FROM public.chiefos_portal_users
           WHERE user_id = auth.uid() AND role = 'owner'))
      );
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.settings TO service_role;

COMMENT ON TABLE public.settings IS
  'Tenant/owner key-value settings. scope = ''owner'' for personal settings (only the owner writes); scope = ''tenant'' for tenant-wide settings (only role=owner writes). UNIQUE (owner_id, scope, key) ensures one value per (owner, scope, key) triple.';

-- ============================================================================
-- 3. import_batches — bulk import tracking
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.import_batches (
  id                              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id                        text         NOT NULL,
  initiated_by_portal_user_id     uuid
    REFERENCES public.chiefos_portal_users(user_id) ON DELETE SET NULL,
  kind                            text         NOT NULL,
  source_file_name                text,
  media_asset_id                  uuid,
  row_count                       integer      NOT NULL DEFAULT 0,
  success_count                   integer      NOT NULL DEFAULT 0,
  error_count                     integer      NOT NULL DEFAULT 0,
  status                          text         NOT NULL DEFAULT 'pending',
  error_summary                   jsonb,
  correlation_id                  uuid         NOT NULL DEFAULT gen_random_uuid(),
  started_at                      timestamptz,
  completed_at                    timestamptz,
  created_at                      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT import_batches_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT import_batches_kind_chk
    CHECK (kind IN ('csv_expenses','csv_revenue','csv_time','quickbooks_export','other')),
  CONSTRAINT import_batches_status_chk
    CHECK (status IN ('pending','processing','completed','failed','cancelled')),
  CONSTRAINT import_batches_counts_nonneg CHECK (row_count >= 0 AND success_count >= 0 AND error_count >= 0),
  CONSTRAINT import_batches_counts_bounded CHECK (success_count + error_count <= row_count),
  CONSTRAINT import_batches_completed_iff_timestamp
    CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  -- Composite FK to media_assets (by (id, tenant_id) — media_assets has that composite UNIQUE)
  CONSTRAINT import_batches_media_asset_fk
    FOREIGN KEY (media_asset_id, tenant_id)
    REFERENCES public.media_assets(id, tenant_id)
    ON DELETE SET NULL
);

-- Composite UNIQUE target for transactions.import_batch_id and time_entries_v2.import_batch_id refs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'import_batches_id_tenant_unique'
      AND conrelid = 'public.import_batches'::regclass
  ) THEN
    ALTER TABLE public.import_batches
      ADD CONSTRAINT import_batches_id_tenant_unique UNIQUE (id, tenant_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS import_batches_tenant_status_idx
  ON public.import_batches (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS import_batches_portal_user_idx
  ON public.import_batches (initiated_by_portal_user_id, created_at DESC)
  WHERE initiated_by_portal_user_id IS NOT NULL;

ALTER TABLE public.import_batches ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='import_batches'
                   AND policyname='import_batches_tenant_select') THEN
    CREATE POLICY import_batches_tenant_select ON public.import_batches FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='import_batches'
                   AND policyname='import_batches_tenant_insert') THEN
    CREATE POLICY import_batches_tenant_insert ON public.import_batches FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='import_batches'
                   AND policyname='import_batches_tenant_update') THEN
    CREATE POLICY import_batches_tenant_update ON public.import_batches FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.import_batches TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.import_batches TO service_role;

COMMENT ON TABLE public.import_batches IS
  'Bulk import tracking. transactions.import_batch_id and time_entries_v2.import_batch_id reference this via (id, tenant_id). Append-only on completed state (trigger in Session P3-4).';

-- ============================================================================
-- 4. employee_invites — token-based crew invite flow
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.employee_invites (
  id                              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id                        text         NOT NULL,
  invited_by_portal_user_id       uuid         NOT NULL
    REFERENCES public.chiefos_portal_users(user_id) ON DELETE RESTRICT,
  token                           text         NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),
  employee_name                   text,
  invite_phone                    text,
  invite_email                    text,
  invited_role                    text         NOT NULL DEFAULT 'employee',
  status                          text         NOT NULL DEFAULT 'pending',
  expires_at                      timestamptz  NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_at                     timestamptz,
  accepted_by_auth_user_id        uuid
    REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_at                      timestamptz,
  revoked_by_portal_user_id       uuid
    REFERENCES public.chiefos_portal_users(user_id) ON DELETE SET NULL,
  correlation_id                  uuid         NOT NULL DEFAULT gen_random_uuid(),
  created_at                      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT employee_invites_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT employee_invites_status_chk
    CHECK (status IN ('pending','accepted','expired','revoked')),
  CONSTRAINT employee_invites_invited_role_chk
    CHECK (invited_role IN ('employee','board_member')),
  CONSTRAINT employee_invites_accepted_iff_timestamp
    CHECK ((status = 'accepted') = (accepted_at IS NOT NULL AND accepted_by_auth_user_id IS NOT NULL)),
  CONSTRAINT employee_invites_revoked_iff_timestamp
    CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT employee_invites_contact_present
    CHECK (invite_phone IS NOT NULL OR invite_email IS NOT NULL)
);

-- Token global UNIQUE
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'employee_invites_token_unique'
      AND conrelid = 'public.employee_invites'::regclass
  ) THEN
    ALTER TABLE public.employee_invites
      ADD CONSTRAINT employee_invites_token_unique UNIQUE (token);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS employee_invites_tenant_status_idx
  ON public.employee_invites (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS employee_invites_accepted_by_idx
  ON public.employee_invites (accepted_by_auth_user_id)
  WHERE accepted_by_auth_user_id IS NOT NULL;

ALTER TABLE public.employee_invites ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='employee_invites'
                   AND policyname='employee_invites_owner_board_select') THEN
    CREATE POLICY employee_invites_owner_board_select ON public.employee_invites FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                           WHERE user_id = auth.uid() AND role IN ('owner','board_member')));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='employee_invites'
                   AND policyname='employee_invites_owner_board_insert') THEN
    CREATE POLICY employee_invites_owner_board_insert ON public.employee_invites FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                                WHERE user_id = auth.uid() AND role IN ('owner','board_member')));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='employee_invites'
                   AND policyname='employee_invites_owner_board_update') THEN
    CREATE POLICY employee_invites_owner_board_update ON public.employee_invites FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                           WHERE user_id = auth.uid() AND role IN ('owner','board_member')))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                                WHERE user_id = auth.uid() AND role IN ('owner','board_member')));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.employee_invites TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_invites TO service_role;

COMMENT ON TABLE public.employee_invites IS
  'Token-based crew invite flow. Owner/admin-only via RLS. Acceptance flow bypasses RLS (service-role endpoint validates token explicitly). 7-day default expiry.';

-- ============================================================================
-- 5. chiefos_crew_rates — historical pay-rate records (role-restricted)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.chiefos_crew_rates (
  id                      uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id                text         NOT NULL,
  portal_user_id          uuid
    REFERENCES public.chiefos_portal_users(user_id) ON DELETE RESTRICT,
  employee_user_id        text
    REFERENCES public.users(user_id) ON DELETE RESTRICT,
  employee_name           text,
  hourly_rate_cents       integer      NOT NULL DEFAULT 0,
  currency                text         NOT NULL DEFAULT 'CAD',
  effective_from          date         NOT NULL DEFAULT CURRENT_DATE,
  effective_to            date,
  set_by_portal_user_id   uuid
    REFERENCES public.chiefos_portal_users(user_id) ON DELETE SET NULL,
  notes                   text,
  correlation_id          uuid         NOT NULL DEFAULT gen_random_uuid(),
  created_at              timestamptz  NOT NULL DEFAULT now(),
  updated_at              timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT chiefos_crew_rates_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT chiefos_crew_rates_hourly_rate_nonneg CHECK (hourly_rate_cents >= 0),
  CONSTRAINT chiefos_crew_rates_currency_chk CHECK (currency IN ('CAD','USD')),
  CONSTRAINT chiefos_crew_rates_effective_order
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT chiefos_crew_rates_identifier_present
    CHECK (portal_user_id IS NOT NULL OR employee_user_id IS NOT NULL OR employee_name IS NOT NULL)
);

-- One rate per (tenant, portal_user_id, effective_from) where portal-scoped
CREATE UNIQUE INDEX IF NOT EXISTS chiefos_crew_rates_portal_user_effective_unique_idx
  ON public.chiefos_crew_rates (tenant_id, portal_user_id, effective_from)
  WHERE portal_user_id IS NOT NULL;
-- One rate per (tenant, employee_user_id, effective_from) where ingestion-scoped-only
CREATE UNIQUE INDEX IF NOT EXISTS chiefos_crew_rates_employee_user_effective_unique_idx
  ON public.chiefos_crew_rates (tenant_id, employee_user_id, effective_from)
  WHERE employee_user_id IS NOT NULL AND portal_user_id IS NULL;

CREATE INDEX IF NOT EXISTS chiefos_crew_rates_tenant_portal_active_idx
  ON public.chiefos_crew_rates (tenant_id, portal_user_id)
  WHERE effective_to IS NULL AND portal_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS chiefos_crew_rates_tenant_employee_active_idx
  ON public.chiefos_crew_rates (tenant_id, employee_user_id)
  WHERE effective_to IS NULL AND employee_user_id IS NOT NULL;

ALTER TABLE public.chiefos_crew_rates ENABLE ROW LEVEL SECURITY;

-- Role-restricted: owner/board_member only. Rates are confidential from the
-- employee being paid.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='chiefos_crew_rates'
                   AND policyname='chiefos_crew_rates_owner_select') THEN
    CREATE POLICY chiefos_crew_rates_owner_select ON public.chiefos_crew_rates FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                           WHERE user_id = auth.uid() AND role IN ('owner','board_member')));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='chiefos_crew_rates'
                   AND policyname='chiefos_crew_rates_owner_insert') THEN
    CREATE POLICY chiefos_crew_rates_owner_insert ON public.chiefos_crew_rates FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                                WHERE user_id = auth.uid() AND role IN ('owner','board_member')));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='chiefos_crew_rates'
                   AND policyname='chiefos_crew_rates_owner_update') THEN
    CREATE POLICY chiefos_crew_rates_owner_update ON public.chiefos_crew_rates FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                           WHERE user_id = auth.uid() AND role IN ('owner','board_member')))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                                WHERE user_id = auth.uid() AND role IN ('owner','board_member')));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.chiefos_crew_rates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chiefos_crew_rates TO service_role;

COMMENT ON TABLE public.chiefos_crew_rates IS
  'Historical pay-rate records per crew member. Append-only semantic: rate changes = new row with new effective_from; app code atomically sets the prior row''s effective_to. Role-restricted: owner/board_member only. Employees cannot see their own rates via RLS.';

COMMIT;
