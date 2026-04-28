-- ============================================================================
-- Rollback — P1A-4 public.users.auth_user_id
--
-- REVERSES: 2026_04_23_amendment_p1a4_users_auth_user_id.sql
--
-- ROLLBACK IMPACT:
--   - Any R2.5 application code reading public.users.auth_user_id will fail
--     after rollback. Rollback of P1A-4 REQUIRES rollback of R2.5 as
--     prerequisite.
--   - Invalidates the Phase 5 backfill
--     (phase5_backfill_users_auth_user_id.sql) — the column it populates no
--     longer exists. Backfilled data is permanently lost.
--   - Portal whoami `hasWhatsApp` signal reverts to owner-only approximation.
--
-- ORDER: drop constraint → drop index → drop column (each idempotent).
-- ============================================================================

BEGIN;

-- 1. Drop UNIQUE constraint (must come before column drop)
DO $drop_uniq$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'users_auth_user_id_unique'
       AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE public.users DROP CONSTRAINT users_auth_user_id_unique;
  END IF;
END
$drop_uniq$;

-- 2. Drop partial index
DROP INDEX IF EXISTS public.users_auth_user_idx;

-- 3. Drop the column (FK auto-removes with the column)
DO $drop_col$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'users'
       AND column_name  = 'auth_user_id'
  ) THEN
    ALTER TABLE public.users DROP COLUMN auth_user_id;
  END IF;
END
$drop_col$;

COMMIT;
