-- ============================================================================
-- Foundation Rebuild — Session 2, Part 1: Jobs Spine
--
-- Creates:
--   1. chiefos_tenant_counters (shared infrastructure; canonical creation
--      point in the rebuild — Quotes spine and Jobs both use it at runtime
--      via counter_kind values like 'job', 'quote', 'task', 'invoice')
--   2. jobs              (redesigned: tenant_id added, duplicates dropped,
--                         status enum tightened)
--   3. job_phases        (composite FK to jobs, RLS completed)
--   4. job_photos        (stays specialized per Decision 4)
--   5. job_photo_shares  (customer-facing share tokens)
--
-- Authoritative source: FOUNDATION_P1_SCHEMA_DESIGN.md §3.3
--
-- Dependencies:
--   - public.chiefos_tenants (Session 1 rebuild_identity_tenancy)
--   - public.chiefos_portal_users (for RLS membership subquery)
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_tenants') THEN
    RAISE EXCEPTION 'Requires public.chiefos_tenants (apply rebuild_identity_tenancy first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_portal_users') THEN
    RAISE EXCEPTION 'Requires public.chiefos_portal_users (apply rebuild_identity_tenancy first)';
  END IF;
END
$preflight$;

-- ============================================================================
-- 1. chiefos_tenant_counters — shared per-(tenant, kind) counter
--
-- Created here in final generalized form (rather than activity-log-specific
-- first then ALTERed). Used by Quotes spine for human_id, Jobs spine for
-- job_no, future task numbering, future invoice_no, etc.
--
-- Source-of-truth for counter_kind values lives in src/cil/counterKinds.js
-- (app-side). The DB enforces format only per §18.4.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.chiefos_tenant_counters (
  tenant_id     uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  counter_kind  text         NOT NULL,
  next_no       integer      NOT NULL DEFAULT 1,
  updated_at    timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT chiefos_tenant_counters_pkey PRIMARY KEY (tenant_id, counter_kind),
  CONSTRAINT chiefos_tenant_counters_counter_kind_format_chk
    CHECK (counter_kind ~ '^[a-z][a-z_]*$' AND char_length(counter_kind) BETWEEN 1 AND 64),
  CONSTRAINT chiefos_tenant_counters_next_no_positive
    CHECK (next_no >= 1)
);

-- Backend-only writes (counter allocation happens in service_role context).
-- RLS enabled for defense in depth.
ALTER TABLE public.chiefos_tenant_counters ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='chiefos_tenant_counters'
                   AND policyname='chiefos_tenant_counters_tenant_read') THEN
    CREATE POLICY chiefos_tenant_counters_tenant_read
      ON public.chiefos_tenant_counters FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

GRANT SELECT ON public.chiefos_tenant_counters TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chiefos_tenant_counters TO service_role;

COMMENT ON COLUMN public.chiefos_tenant_counters.counter_kind IS
  'Per-tenant counter discriminator. One row per (tenant_id, counter_kind). Allowed values in src/cil/counterKinds.js.';
COMMENT ON COLUMN public.chiefos_tenant_counters.next_no IS
  'Next integer to allocate for this (tenant, kind) pair. Allocated via UPSERT in services/postgres.js::allocateNextDocCounter.';

-- ============================================================================
-- 2. jobs — canonical job table
--
-- Keeps integer PK (design §3.3) for human-readable legacy compat; tenant_id
-- added NOT NULL (critical — pre-rebuild table had only owner_id boundary);
-- job_name/name and active/status duplicates dropped; status CHECK tightened.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.jobs (
  id                      serial       PRIMARY KEY,
  tenant_id               uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id                text         NOT NULL,
  job_no                  integer      NOT NULL,
  name                    text         NOT NULL,
  status                  text         NOT NULL DEFAULT 'active',
  start_date              timestamptz  DEFAULT now(),
  end_date                timestamptz,
  contract_value_cents    bigint,
  material_budget_cents   bigint,
  labour_hours_budget     numeric,
  source_msg_id           text,
  deleted_at              timestamptz,
  created_at              timestamptz  NOT NULL DEFAULT now(),
  updated_at              timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT jobs_status_chk
    CHECK (status IN ('active','on_hold','completed','cancelled')),
  CONSTRAINT jobs_owner_id_nonempty
    CHECK (char_length(owner_id) > 0),
  CONSTRAINT jobs_name_nonempty
    CHECK (char_length(name) > 0),
  CONSTRAINT jobs_job_no_positive
    CHECK (job_no >= 1),
  CONSTRAINT jobs_end_after_start
    CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

-- Per-tenant numbering
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'jobs_tenant_job_no_unique'
      AND conrelid = 'public.jobs'::regclass
  ) THEN
    ALTER TABLE public.jobs
      ADD CONSTRAINT jobs_tenant_job_no_unique UNIQUE (tenant_id, job_no);
  END IF;
END $$;

-- Idempotency
CREATE UNIQUE INDEX IF NOT EXISTS jobs_owner_source_msg_unique_idx
  ON public.jobs (owner_id, source_msg_id)
  WHERE source_msg_id IS NOT NULL;

-- Composite identity UNIQUE (Principle 11) — FK target for transactions,
-- time_entries_v2, tasks, mileage_logs, and the quotes spine.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'jobs_identity_unique'
      AND conrelid = 'public.jobs'::regclass
  ) THEN
    ALTER TABLE public.jobs
      ADD CONSTRAINT jobs_identity_unique UNIQUE (id, tenant_id, owner_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS jobs_tenant_status_idx
  ON public.jobs (tenant_id, status);
CREATE INDEX IF NOT EXISTS jobs_owner_status_idx
  ON public.jobs (owner_id, status);
CREATE INDEX IF NOT EXISTS jobs_deleted_idx
  ON public.jobs (tenant_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='jobs'
                   AND policyname='jobs_tenant_select') THEN
    CREATE POLICY jobs_tenant_select
      ON public.jobs FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='jobs'
                   AND policyname='jobs_tenant_insert') THEN
    CREATE POLICY jobs_tenant_insert
      ON public.jobs FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='jobs'
                   AND policyname='jobs_tenant_update') THEN
    CREATE POLICY jobs_tenant_update
      ON public.jobs FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='jobs'
                   AND policyname='jobs_owner_board_delete') THEN
    CREATE POLICY jobs_owner_board_delete
      ON public.jobs FOR DELETE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                           WHERE user_id = auth.uid() AND role IN ('owner','board_member')));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.jobs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.jobs TO service_role;

-- Now that jobs exists, wire the deferred FKs from Session 1's tables that
-- reference jobs.id (transactions.job_id, users.auto_assign_active_job_id).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='transactions_job_fk'
                   AND conrelid='public.transactions'::regclass) THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT transactions_job_fk
      FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='users_auto_assign_active_job_fk'
                   AND conrelid='public.users'::regclass) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_auto_assign_active_job_fk
      FOREIGN KEY (auto_assign_active_job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ============================================================================
-- 3. job_phases — optional job breakdown
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.job_phases (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  job_id        integer      NOT NULL,
  owner_id      text         NOT NULL,
  phase_name    text         NOT NULL,
  started_at    timestamptz  NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  expires_at    timestamptz,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT job_phases_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT job_phases_phase_name_nonempty CHECK (char_length(phase_name) > 0),
  CONSTRAINT job_phases_ended_after_started CHECK (ended_at IS NULL OR ended_at >= started_at),
  -- Composite FK to jobs per Principle 11
  CONSTRAINT job_phases_job_identity_fk
    FOREIGN KEY (job_id, tenant_id, owner_id)
    REFERENCES public.jobs(id, tenant_id, owner_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS job_phases_tenant_job_idx
  ON public.job_phases (tenant_id, job_id);
CREATE INDEX IF NOT EXISTS job_phases_active_idx
  ON public.job_phases (tenant_id, job_id, started_at DESC)
  WHERE ended_at IS NULL;

ALTER TABLE public.job_phases ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='job_phases'
                   AND policyname='job_phases_tenant_select') THEN
    CREATE POLICY job_phases_tenant_select ON public.job_phases FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='job_phases'
                   AND policyname='job_phases_tenant_insert') THEN
    CREATE POLICY job_phases_tenant_insert ON public.job_phases FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='job_phases'
                   AND policyname='job_phases_tenant_update') THEN
    CREATE POLICY job_phases_tenant_update ON public.job_phases FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='job_phases'
                   AND policyname='job_phases_tenant_delete') THEN
    CREATE POLICY job_phases_tenant_delete ON public.job_phases FOR DELETE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_phases TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_phases TO service_role;

-- ============================================================================
-- 4. job_photos — photos attached to a job (kept specialized per Decision 4)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.job_photos (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  job_id            integer      NOT NULL,
  owner_id          text         NOT NULL,
  description       text,
  storage_bucket    text         NOT NULL DEFAULT 'job-photos',
  storage_path      text         NOT NULL,
  public_url        text,
  source            text         NOT NULL DEFAULT 'portal',
  source_msg_id     text,
  taken_at          timestamptz,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT job_photos_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT job_photos_storage_path_nonempty CHECK (char_length(storage_path) > 0),
  CONSTRAINT job_photos_source_chk
    CHECK (source IN ('whatsapp','portal','email','api')),
  CONSTRAINT job_photos_job_identity_fk
    FOREIGN KEY (job_id, tenant_id, owner_id)
    REFERENCES public.jobs(id, tenant_id, owner_id)
    ON DELETE RESTRICT
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'job_photos_storage_unique'
      AND conrelid = 'public.job_photos'::regclass
  ) THEN
    ALTER TABLE public.job_photos
      ADD CONSTRAINT job_photos_storage_unique UNIQUE (tenant_id, storage_path);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS job_photos_tenant_job_idx
  ON public.job_photos (tenant_id, job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS job_photos_source_msg_idx
  ON public.job_photos (owner_id, source_msg_id)
  WHERE source_msg_id IS NOT NULL;

ALTER TABLE public.job_photos ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='job_photos'
                   AND policyname='job_photos_tenant_select') THEN
    CREATE POLICY job_photos_tenant_select ON public.job_photos FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='job_photos'
                   AND policyname='job_photos_tenant_insert') THEN
    CREATE POLICY job_photos_tenant_insert ON public.job_photos FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='job_photos'
                   AND policyname='job_photos_tenant_delete') THEN
    CREATE POLICY job_photos_tenant_delete ON public.job_photos FOR DELETE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_photos TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_photos TO service_role;

-- ============================================================================
-- 5. job_photo_shares — per-job share tokens for customer-facing galleries
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.job_photo_shares (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  job_id       integer      NOT NULL,
  owner_id     text         NOT NULL,
  token        text         NOT NULL DEFAULT (gen_random_uuid())::text,
  label        text,
  expires_at   timestamptz  NOT NULL DEFAULT (now() + interval '30 days'),
  created_at   timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT job_photo_shares_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT job_photo_shares_token_unique UNIQUE (token),
  CONSTRAINT job_photo_shares_expires_after_created CHECK (expires_at > created_at),
  CONSTRAINT job_photo_shares_job_identity_fk
    FOREIGN KEY (job_id, tenant_id, owner_id)
    REFERENCES public.jobs(id, tenant_id, owner_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS job_photo_shares_tenant_job_idx
  ON public.job_photo_shares (tenant_id, job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS job_photo_shares_expiry_idx
  ON public.job_photo_shares (expires_at)
  WHERE expires_at IS NOT NULL;

ALTER TABLE public.job_photo_shares ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='job_photo_shares'
                   AND policyname='job_photo_shares_tenant_select') THEN
    CREATE POLICY job_photo_shares_tenant_select ON public.job_photo_shares FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='job_photo_shares'
                   AND policyname='job_photo_shares_tenant_insert') THEN
    CREATE POLICY job_photo_shares_tenant_insert ON public.job_photo_shares FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

GRANT SELECT, INSERT ON public.job_photo_shares TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_photo_shares TO service_role;

-- ============================================================================
-- Comments
-- ============================================================================
COMMENT ON TABLE public.chiefos_tenant_counters IS
  'Per-(tenant, counter_kind) sequential counter. Shared infrastructure. Allowed counter_kind values in src/cil/counterKinds.js.';
COMMENT ON TABLE public.jobs IS
  'Canonical job table. Integer PK retained for human-readable legacy compat; tenant_id NOT NULL added in rebuild. job_no allocated via chiefos_tenant_counters with counter_kind=''job''.';
COMMENT ON TABLE public.job_phases IS
  'Optional phase breakdown for a job. Composite FK to jobs (id, tenant_id, owner_id) per Principle 11.';
COMMENT ON TABLE public.job_photos IS
  'Photos attached to a job (specialized per Decision 4; distinct from general media_assets).';
COMMENT ON TABLE public.job_photo_shares IS
  'Per-job shareable tokens for customer-facing photo galleries. 30-day default expiry.';

COMMIT;
