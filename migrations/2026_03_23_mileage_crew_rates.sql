-- Migration: mileage_logs + chiefos_crew_rates
-- Run in Supabase SQL Editor

-- ============================================================
-- 1. mileage_logs
-- ============================================================
CREATE TABLE IF NOT EXISTS mileage_logs (
  id               bigserial PRIMARY KEY,
  tenant_id        uuid        NOT NULL,
  owner_id         uuid        NOT NULL,
  job_id           bigint,
  job_name         text,
  trip_date        date        NOT NULL,
  origin           text,
  destination      text,
  distance         numeric(10,2) NOT NULL,
  unit             text        NOT NULL DEFAULT 'km',  -- 'km' | 'mi'
  rate_cents       int         NOT NULL,               -- rate per unit in cents
  deductible_cents int         NOT NULL,               -- distance × rate
  notes            text,
  source_msg_id    text,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);

ALTER TABLE mileage_logs ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to access their own tenant's rows
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'mileage_logs' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY "tenant_isolation" ON mileage_logs
      USING (
        tenant_id IN (
          SELECT tenant_id FROM chiefos_portal_users
          WHERE user_id = auth.uid()
        )
      )
      WITH CHECK (
        tenant_id IN (
          SELECT tenant_id FROM chiefos_portal_users
          WHERE user_id = auth.uid()
        )
      );
  END IF;
END$$;


-- ============================================================
-- 2. chiefos_crew_rates
-- ============================================================
CREATE TABLE IF NOT EXISTS chiefos_crew_rates (
  id                 bigserial PRIMARY KEY,
  tenant_id          uuid    NOT NULL,
  employee_name      text    NOT NULL,
  hourly_rate_cents  int     NOT NULL DEFAULT 0,
  currency           text    NOT NULL DEFAULT 'CAD',
  effective_from     date    NOT NULL DEFAULT CURRENT_DATE,
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now(),
  UNIQUE (tenant_id, employee_name, effective_from)
);

ALTER TABLE chiefos_crew_rates ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'chiefos_crew_rates' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY "tenant_isolation" ON chiefos_crew_rates
      USING (
        tenant_id IN (
          SELECT tenant_id FROM chiefos_portal_users
          WHERE user_id = auth.uid()
        )
      )
      WITH CHECK (
        tenant_id IN (
          SELECT tenant_id FROM chiefos_portal_users
          WHERE user_id = auth.uid()
        )
      );
  END IF;
END$$;


-- ============================================================
-- 3. Grant anon/service role access (adjust as needed)
-- ============================================================
GRANT SELECT, INSERT, UPDATE ON mileage_logs TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON chiefos_crew_rates TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE mileage_logs_id_seq TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE chiefos_crew_rates_id_seq TO anon, authenticated;
