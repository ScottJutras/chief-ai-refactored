-- Rollback for: 2026_04_29_phase0_p2_p3_chiefos_tenants_paid_breaks_and_tax_region.sql
--
-- Restores chiefos_tenants to pre-migration state. Idempotent.
--
-- IMPORTANT: dropped 'region' column data is NOT restored by this rollback
-- (the forward migration removed the column entirely). If 'region' values
-- matter for any reason, restore from backup before running this rollback.
--
-- Drop order (reverse of forward dependencies):
--   1. tax_region (depends on province, country)
--   2. province NOT NULL constraint released
--   3. province format CHECK dropped
--   4. region column re-added (without data; just the column shell)
--   5. paid_breaks_policy dropped
-- ============================================================================

BEGIN;

ALTER TABLE public.chiefos_tenants DROP COLUMN IF EXISTS tax_region;

ALTER TABLE public.chiefos_tenants ALTER COLUMN province DROP NOT NULL;

ALTER TABLE public.chiefos_tenants
  DROP CONSTRAINT IF EXISTS chiefos_tenants_province_format_chk;

ALTER TABLE public.chiefos_tenants
  ADD COLUMN IF NOT EXISTS region TEXT;

ALTER TABLE public.chiefos_tenants DROP COLUMN IF EXISTS paid_breaks_policy;

COMMIT;
