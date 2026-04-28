-- ============================================================================
-- Phase 1 Amendment P1A-4 — public.users.auth_user_id reverse pointer
--
-- PURPOSE:
--   Add a reverse pointer from public.users (ingestion identity) to auth.users
--   (portal identity), enabling the portal↔WhatsApp linkage signal
--   (`hasWhatsApp`) to work for non-owner portal users.
--
-- MOTIVATION (R2 flagged item F1):
--   Post-rebuild, the schema has no durable auth.uid() → phone-digit mapping.
--   routes/portal.js whoami can only approximate `hasWhatsApp` for tenant
--   owners (by joining chiefos_tenants.owner_id = users.user_id). Employees
--   and board members always receive hasWhatsApp = false — a regression from
--   pre-rebuild behavior. This amendment closes that gap without replacing
--   portal_phone_link_otp: successful OTP verification will write
--   users.auth_user_id = auth.uid().
--
-- SCOPE:
--   1 new nullable column on public.users, one UNIQUE constraint, one partial
--   index, one COMMENT. No RLS / GRANT changes — existing tenant-membership
--   policies cover the new column.
--
-- DEPENDENCIES:
--   - public.users (2026_04_21_rebuild_identity_tenancy.sql, §2)
--   - auth.users   (Supabase-managed)
--
-- IDIOM NOTE:
--   Existing rebuild FKs to auth.users(id) use ON DELETE CASCADE
--   (chiefos_portal_users, chiefos_legal_acceptances, portal_phone_link_otp).
--   This amendment deliberately deviates to ON DELETE SET NULL because
--   cascading the delete would orphan ingestion identity and break
--   transactions.owner_id / time_entries_v2.owner_id FK chains if the auth
--   account is later deleted. SET NULL preserves the ingestion row and its
--   financial history; the phone simply becomes un-paired.
--
-- PAIRED WITH:
--   phase5_backfill_users_auth_user_id.sql — manual data migration run at
--   Phase 5 cutover BEFORE opening writes, AFTER all rebuild migrations.
--
-- Idempotent: IF NOT EXISTS guards throughout. Designed to be safe to re-run.
-- ============================================================================

BEGIN;

-- ============================================================================
-- Preflight
-- ============================================================================
DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'users'
  ) THEN
    RAISE EXCEPTION
      'P1A-4 requires public.users. Apply 2026_04_21_rebuild_identity_tenancy.sql first.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'auth' AND table_name = 'users'
  ) THEN
    RAISE EXCEPTION 'P1A-4 requires Supabase auth.users table.';
  END IF;
END
$preflight$;

-- ============================================================================
-- Column addition (nullable, SET NULL on delete — see IDIOM NOTE above)
-- ============================================================================
DO $col$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'users'
       AND column_name  = 'auth_user_id'
  ) THEN
    ALTER TABLE public.users
      ADD COLUMN auth_user_id uuid NULL
        REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END
$col$;

-- ============================================================================
-- Partial index on non-NULL values (typical case: most rows remain NULL)
-- ============================================================================
CREATE INDEX IF NOT EXISTS users_auth_user_idx
  ON public.users (auth_user_id)
  WHERE auth_user_id IS NOT NULL;

-- ============================================================================
-- UNIQUE constraint: one public.users row per auth identity.
-- NULL-distinct semantics (Postgres default) allow many unpaired rows.
-- Paired with existing PK on user_id and users_owner_user_unique.
-- ============================================================================
DO $uniq$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'users_auth_user_id_unique'
       AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_auth_user_id_unique UNIQUE (auth_user_id);
  END IF;
END
$uniq$;

-- ============================================================================
-- Documentation
-- ============================================================================
COMMENT ON COLUMN public.users.auth_user_id IS
  'Reverse pointer to auth.users(id) for portal↔WhatsApp linkage. NULL for un-paired identities. Populated by service_role on successful portal_phone_link_otp verification via routes/webhook.js (R2.5). ON DELETE SET NULL preserves financial history when auth accounts are deleted.';

COMMIT;
