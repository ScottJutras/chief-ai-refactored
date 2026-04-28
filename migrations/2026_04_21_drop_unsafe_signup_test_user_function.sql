-- ============================================================================
-- Migration: Drop chiefos_delete_signup_test_user_by_email
--
-- SECURITY: Phase 2 security audit (FOUNDATION_P2_SECURITY_AUDIT.md, Finding
-- UA-1) identified this function as UNSAFE in production. It is SECURITY
-- DEFINER owned by the postgres role, has EXECUTE granted to PUBLIC (which
-- means anon and authenticated both inherit it), contains zero authorization
-- check in its body, and performs destructive DELETEs across auth.users plus
-- eleven application tables (chiefos_tenants, chiefos_portal_users,
-- chiefos_legal_acceptances, user_auth_links, portal_phone_link_otp,
-- chiefos_identity_map, chiefos_user_identities, chiefos_actor_identities,
-- billing_subscriptions, chiefos_link_codes, chiefos_pending_signups).
--
-- Exploitation scenario: any anonymous caller with knowledge of the public
-- Supabase URL can issue `supabase.rpc('chiefos_delete_signup_test_user_by_
-- email', { target_email: '<victim>' })` and wipe that user's entire account
-- and tenant. The function name implies "test user" but the body does not
-- verify the target is a test account.
--
-- Grep of the application codebase confirmed zero call sites. Dropping the
-- function has no functional impact on the running application.
--
-- This migration is idempotent (safe to re-run; `DROP FUNCTION IF EXISTS`).
-- ============================================================================

BEGIN;

-- Exact-signature drop first (idempotent).
DROP FUNCTION IF EXISTS public.chiefos_delete_signup_test_user_by_email(text, boolean);

-- Defensive sweep: drop any remaining overloaded signatures. The only
-- known signature at audit time is (text, boolean), but a sweep handles
-- any variant that may have existed at some earlier point or been added
-- between audit and apply. Runs in a DO block so we can iterate the
-- pg_proc catalog and issue DROP FUNCTION with fully-qualified regprocedure.
DO $$
DECLARE
  func_oid oid;
BEGIN
  FOR func_oid IN
    SELECT p.oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'chiefos_delete_signup_test_user_by_email'
  LOOP
    EXECUTE 'DROP FUNCTION ' || func_oid::regprocedure;
  END LOOP;
END $$;

COMMIT;
