-- Migration: 2026_04_29_amendment_p1a9_legal_acceptances_unique.sql
--
-- PHASE 1 AMENDMENT (Session P1A-9) for Foundation Rebuild V2.
--
-- Gap source: Path α end-to-end test (2026-04-28). The chiefos-site
-- /api/legal/accept route (chiefos-site/app/api/legal/accept/route.ts:107-134)
-- calls .upsert(..., { onConflict: 'tenant_id,auth_user_id' }) to record
-- legal acceptance idempotently per (tenant, user). PostgreSQL requires a
-- UNIQUE/EXCLUSION arbiter on the conflict columns; the original
-- rebuild_identity_tenancy.sql shipped chiefos_legal_acceptances WITHOUT
-- a UNIQUE on (tenant_id, auth_user_id), so the upsert errored at runtime
-- with 42P10 ('there is no unique or exclusion constraint matching the
-- ON CONFLICT specification').
--
-- This was latent in production since cutover and surfaced only when an
-- authenticated user actually walked the finish-signup flow far enough
-- to invoke /api/legal/accept (Path α step 5 of 6).
--
-- Bug class: ON CONFLICT clauses without backing UNIQUE constraints. Same
-- shape as the chiefos_beta_signups.email upsert caught earlier in this
-- session (resolved there by switching to manual check+insert; here we
-- add the UNIQUE because the table semantically requires one-row-per-
-- (tenant, user) anyway).
--
-- Semantic: a user accepts legal terms once per tenant they belong to.
-- Re-accepting (e.g., when terms version changes) UPDATEs the existing
-- row in place via the upsert. Different tenant memberships for the same
-- auth user produce independent rows. UNIQUE on (tenant_id, auth_user_id)
-- captures this correctly.
--
-- Idempotent: ALTER TABLE ADD CONSTRAINT IF NOT EXISTS does not exist in
-- Postgres for UNIQUE constraints, so we wrap in DO + pg_constraint check.
-- No data migration needed: production table is empty at apply time
-- (verified via service-role count).
--
-- Apply-order: post-cutover P1A-N amendment. Recorded in
-- REBUILD_MIGRATION_MANIFEST.md §7. Applied directly to production via
-- mcp__claude_ai_Supabase__apply_migration.
--
-- Rollback: ALTER TABLE ... DROP CONSTRAINT.
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chiefos_legal_acceptances_tenant_auth_user_unique'
      AND conrelid = 'public.chiefos_legal_acceptances'::regclass
  ) THEN
    ALTER TABLE public.chiefos_legal_acceptances
      ADD CONSTRAINT chiefos_legal_acceptances_tenant_auth_user_unique
      UNIQUE (tenant_id, auth_user_id);
  END IF;
END $$;

COMMIT;
