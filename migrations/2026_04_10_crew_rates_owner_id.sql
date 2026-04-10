-- Migration: add owner_id to chiefos_crew_rates
-- Allows WhatsApp-side writes (which only have owner_id) and direct joins
-- without requiring a tenant_id lookup on every rate query.
-- Safe to run multiple times (idempotent).

ALTER TABLE public.chiefos_crew_rates
  ADD COLUMN IF NOT EXISTS owner_id text;

-- Index for WhatsApp-side lookups
CREATE INDEX IF NOT EXISTS idx_crew_rates_owner_id
  ON public.chiefos_crew_rates (owner_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crew_rates_owner_employee_date
  ON public.chiefos_crew_rates (owner_id, employee_name, effective_from)
  WHERE owner_id IS NOT NULL;
