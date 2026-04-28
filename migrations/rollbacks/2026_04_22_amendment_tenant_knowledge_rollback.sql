-- Rollback for 2026_04_22_amendment_tenant_knowledge.sql
-- Drops tenant_knowledge. Safe to re-run.

BEGIN;

DROP POLICY IF EXISTS tenant_knowledge_authenticated_select ON public.tenant_knowledge;

DROP INDEX IF EXISTS public.tenant_knowledge_owner_kind_idx;
DROP INDEX IF EXISTS public.tenant_knowledge_owner_lastseen_idx;

DROP TABLE IF EXISTS public.tenant_knowledge;

COMMIT;
