-- ============================================================================
-- Foundation Rebuild — Session P3-3b, Part 2: mileage_logs
--
-- Section 3.12 of FOUNDATION_P1_SCHEMA_DESIGN.md.
--
-- Creates:
--   1. mileage_logs — per-trip mileage capture
--
-- Design note: mileage writes emit a parallel public.transactions row
-- (kind='expense', category='mileage') at confirm time, idempotent via
-- source_msg_id. The mileage_logs.transaction_id FK stores the linkage.
-- App-code layer handles the emission — no DB trigger.
--
-- Design drift resolved: §3.12 text specifies job_id uuid; jobs.id is serial
-- (integer) per §3.3. This migration uses integer to match the FK target.
--
-- Dependencies:
--   - public.chiefos_tenants (Session P3-1)
--   - public.users (Session P3-1)
--   - public.jobs (Session P3-2a)
--   - public.transactions (Session P3-1) — composite FK target for transaction_id
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_tenants') THEN
    RAISE EXCEPTION 'Requires public.chiefos_tenants';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='jobs') THEN
    RAISE EXCEPTION 'Requires public.jobs';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='transactions') THEN
    RAISE EXCEPTION 'Requires public.transactions';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='users') THEN
    RAISE EXCEPTION 'Requires public.users';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.mileage_logs (
  id                   uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id             text         NOT NULL,
  employee_user_id     text
    REFERENCES public.users(user_id) ON DELETE RESTRICT,
  trip_date            date         NOT NULL,
  job_id               integer,
  job_no               integer,
  origin               text,
  destination          text,
  distance             numeric(10,2) NOT NULL,
  unit                 text         NOT NULL DEFAULT 'km',
  rate_cents           integer      NOT NULL,
  deductible_cents     bigint       NOT NULL,
  notes                text,
  source               text         NOT NULL DEFAULT 'whatsapp',
  source_msg_id        text,
  transaction_id       uuid,
  deleted_at           timestamptz,
  correlation_id       uuid         NOT NULL DEFAULT gen_random_uuid(),
  created_at           timestamptz  NOT NULL DEFAULT now(),
  updated_at           timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT mileage_logs_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT mileage_logs_unit_chk CHECK (unit IN ('km','mi')),
  CONSTRAINT mileage_logs_source_chk CHECK (source IN ('whatsapp','portal','api')),
  CONSTRAINT mileage_logs_distance_positive CHECK (distance > 0),
  CONSTRAINT mileage_logs_rate_cents_nonneg CHECK (rate_cents >= 0),
  CONSTRAINT mileage_logs_deductible_cents_nonneg CHECK (deductible_cents >= 0),
  -- Composite FK to jobs (optional; MATCH SIMPLE on nullable job_id)
  CONSTRAINT mileage_logs_job_identity_fk
    FOREIGN KEY (job_id, tenant_id, owner_id)
    REFERENCES public.jobs(id, tenant_id, owner_id)
    ON DELETE SET NULL,
  -- Composite FK to transactions (parallel-row link; optional)
  CONSTRAINT mileage_logs_transaction_identity_fk
    FOREIGN KEY (transaction_id, tenant_id, owner_id)
    REFERENCES public.transactions(id, tenant_id, owner_id)
    ON DELETE SET NULL
);

-- Idempotency: partial UNIQUE on (owner_id, source_msg_id).
CREATE UNIQUE INDEX IF NOT EXISTS mileage_logs_owner_source_msg_unique_idx
  ON public.mileage_logs (owner_id, source_msg_id)
  WHERE source_msg_id IS NOT NULL;

-- Composite identity UNIQUE (Principle 11)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mileage_logs_identity_unique'
      AND conrelid = 'public.mileage_logs'::regclass
  ) THEN
    ALTER TABLE public.mileage_logs
      ADD CONSTRAINT mileage_logs_identity_unique UNIQUE (id, tenant_id, owner_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS mileage_logs_tenant_date_idx
  ON public.mileage_logs (tenant_id, trip_date DESC);
CREATE INDEX IF NOT EXISTS mileage_logs_owner_date_idx
  ON public.mileage_logs (owner_id, trip_date DESC);
CREATE INDEX IF NOT EXISTS mileage_logs_job_idx
  ON public.mileage_logs (tenant_id, job_id)
  WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mileage_logs_employee_idx
  ON public.mileage_logs (tenant_id, employee_user_id, trip_date DESC)
  WHERE employee_user_id IS NOT NULL;

ALTER TABLE public.mileage_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='mileage_logs'
                   AND policyname='mileage_logs_tenant_select') THEN
    CREATE POLICY mileage_logs_tenant_select
      ON public.mileage_logs FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='mileage_logs'
                   AND policyname='mileage_logs_tenant_insert') THEN
    CREATE POLICY mileage_logs_tenant_insert
      ON public.mileage_logs FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='mileage_logs'
                   AND policyname='mileage_logs_tenant_update') THEN
    CREATE POLICY mileage_logs_tenant_update
      ON public.mileage_logs FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.mileage_logs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mileage_logs TO service_role;

COMMENT ON TABLE public.mileage_logs IS
  'Per-trip mileage capture. App-code layer emits a parallel public.transactions row (kind=''expense'', category=''mileage'') at confirm time with matching source_msg_id for idempotency. transaction_id stores the linkage. No DB trigger; emission is service-code layer.';
COMMENT ON COLUMN public.mileage_logs.deductible_cents IS
  'Snapshot of distance * rate_cents at capture time (historical accuracy for rate-changes over time).';
COMMENT ON COLUMN public.mileage_logs.transaction_id IS
  'FK to transactions(id, tenant_id, owner_id) composite — the parallel canonical ledger row. Set after app-code emits the transactions row post-confirm.';

COMMIT;
