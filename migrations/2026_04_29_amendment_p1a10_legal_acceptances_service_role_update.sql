-- Migration: 2026_04_29_amendment_p1a10_legal_acceptances_service_role_update.sql
--
-- PHASE 1 AMENDMENT (Session P1A-10) for Foundation Rebuild V2.
--
-- Gap source: Path α end-to-end test (2026-04-28). After P1A-9 added the
-- UNIQUE arbiter required by /api/legal/accept's upsert(onConflict=...),
-- the upsert moved past 42P10 (parser-level) but immediately hit 42501
-- 'permission denied for table chiefos_legal_acceptances'.
--
-- Root cause: PostgreSQL requires INSERT *and* UPDATE privileges on the
-- target table for INSERT ... ON CONFLICT DO UPDATE statements, even when
-- no row actually conflicts at runtime. The original
-- rebuild_identity_tenancy.sql granted INSERT + SELECT to service_role on
-- chiefos_legal_acceptances but NOT UPDATE — leaving service_role unable
-- to use upsert. Peer tables (chiefos_portal_users, chiefos_tenants,
-- public.users) all grant the full DELETE/INSERT/SELECT/UPDATE quartet
-- to service_role; chiefos_legal_acceptances was the lone exception.
--
-- Bug class: missing GRANT to service_role on a table that /api/* routes
-- write to. Third bug class identified in the post-cutover RLS+grants
-- surface alongside missing-UNIQUE-arbiter (P1A-9) and self-referential-
-- RLS-recursion (P1A-8).
--
-- Scope decision: GRANT UPDATE only. NOT DELETE. Append-only audit
-- posture is preserved for legal acceptance records — when an auth.users
-- row is deleted, the FK CASCADE on auth_user_id still removes its
-- chiefos_legal_acceptances rows, so service_role doesn't need explicit
-- DELETE for normal lifecycle. Compliance/audit principle: legal
-- acceptance records should not be discardable by routine code paths.
--
-- The "block client" RLS policies on this table remain unchanged — only
-- service_role gains UPDATE. Authenticated clients still cannot directly
-- INSERT/UPDATE/DELETE; they must go through /api/legal/accept which uses
-- the admin client with service_role.
--
-- Apply-order: post-cutover P1A-N amendment. Recorded in
-- REBUILD_MIGRATION_MANIFEST.md §7. Applied directly to production via
-- mcp__claude_ai_Supabase__apply_migration.
--
-- Rollback: REVOKE UPDATE.
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_legal_acceptances') THEN
    RAISE EXCEPTION 'Requires public.chiefos_legal_acceptances';
  END IF;
END
$preflight$;

GRANT UPDATE ON public.chiefos_legal_acceptances TO service_role;

COMMIT;
