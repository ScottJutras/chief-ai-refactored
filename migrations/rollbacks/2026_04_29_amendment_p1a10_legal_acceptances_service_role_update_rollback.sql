-- Rollback for: 2026_04_29_amendment_p1a10_legal_acceptances_service_role_update.sql
--
-- After rollback, /api/legal/accept's upsert will 42501 again. Only roll
-- back if append-only audit posture needs to be re-enforced at the
-- service_role layer too.

BEGIN;

REVOKE UPDATE ON public.chiefos_legal_acceptances FROM service_role;

COMMIT;
