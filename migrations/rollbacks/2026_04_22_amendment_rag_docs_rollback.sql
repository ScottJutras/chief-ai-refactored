-- Rollback for 2026_04_22_amendment_rag_docs.sql
-- Drops doc_chunks first (FK to docs), then docs. Safe to re-run.
--
-- NOTE: does not drop the pgvector or pgcrypto extensions — those may be used
-- by other tables. Extensions are additive and safe to leave installed.

BEGIN;

-- doc_chunks (children of docs)
DROP POLICY IF EXISTS doc_chunks_authenticated_select ON public.doc_chunks;

DROP INDEX IF EXISTS public.doc_chunks_embedding_ivfflat_idx;
DROP INDEX IF EXISTS public.doc_chunks_owner_idx;
DROP INDEX IF EXISTS public.doc_chunks_doc_id_idx;

DROP TABLE IF EXISTS public.doc_chunks;

-- docs
DROP POLICY IF EXISTS docs_authenticated_select ON public.docs;

DROP INDEX IF EXISTS public.docs_owner_created_idx;
DROP INDEX IF EXISTS public.docs_owner_idx;

DROP TABLE IF EXISTS public.docs;

COMMIT;
