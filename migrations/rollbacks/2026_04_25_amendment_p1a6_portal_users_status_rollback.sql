-- Rollback: 2026_04_25_amendment_p1a6_portal_users_status_rollback.sql
--
-- Reverses migrations/2026_04_25_amendment_p1a6_portal_users_status.sql.
-- Drops the partial index, CHECK constraint, then the column on
-- chiefos_portal_users.
--
-- Order matters: index + constraint reference the column, so they drop
-- before the column. IF EXISTS guards make this re-runnable.
--
-- WARNING: rollback does NOT preserve any 'deactivated' state — those rows
-- become indistinguishable from active rows. Acceptable because P1A-6 lands
-- pre-cutover before any deactivations exist.
--
-- Blocks rollback ordering: if F1 ships and is later rolled back, P1A-6
-- rollback must wait — F1 crewAdmin code depends on the column existing.
-- See REBUILD_MIGRATION_MANIFEST.md §6 rollback list.
-- ============================================================================

BEGIN;

DROP INDEX IF EXISTS public.chiefos_portal_users_active_idx;

ALTER TABLE IF EXISTS public.chiefos_portal_users
  DROP CONSTRAINT IF EXISTS chiefos_portal_users_status_check;

ALTER TABLE IF EXISTS public.chiefos_portal_users
  DROP COLUMN IF EXISTS status;

COMMIT;
