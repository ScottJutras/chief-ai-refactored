-- Rollback for: 2026_04_29_phase0_p1_phone_e164_on_chiefos_tenants.sql
--
-- Restores chiefos_tenants to pre-migration state. Idempotent: safe to run
-- if forward migration was partially applied or never applied.
--
-- Drops in reverse dependency order: index → CHECK constraint → column.
-- ============================================================================

BEGIN;

DROP INDEX IF EXISTS public.chiefos_tenants_phone_e164_unique_idx;

ALTER TABLE public.chiefos_tenants
  DROP CONSTRAINT IF EXISTS chiefos_tenants_phone_e164_format_chk;

ALTER TABLE public.chiefos_tenants
  DROP COLUMN IF EXISTS phone_e164;

COMMIT;
