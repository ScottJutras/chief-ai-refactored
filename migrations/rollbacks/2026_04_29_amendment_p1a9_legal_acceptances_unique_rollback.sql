-- Rollback for: 2026_04_29_amendment_p1a9_legal_acceptances_unique.sql
--
-- Drops the UNIQUE constraint. After rollback, /api/legal/accept's upsert
-- will 42P10 again. Only roll back if the constraint itself proves
-- problematic — no expected scenario.

BEGIN;

ALTER TABLE public.chiefos_legal_acceptances
  DROP CONSTRAINT IF EXISTS chiefos_legal_acceptances_tenant_auth_user_unique;

COMMIT;
