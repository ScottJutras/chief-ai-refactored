-- Rollback for 2026_04_22_amendment_rag_terms.sql
-- Drops rag_terms. Safe to re-run.

BEGIN;

DROP POLICY IF EXISTS rag_terms_authenticated_select ON public.rag_terms;

DROP INDEX IF EXISTS public.rag_terms_lower_term_unique;

DROP TABLE IF EXISTS public.rag_terms;

COMMIT;
