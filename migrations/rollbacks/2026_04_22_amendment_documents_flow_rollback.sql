-- Rollback for 2026_04_22_amendment_documents_flow.sql
-- Drops tables in reverse dependency order. Safe to re-run (IF EXISTS everywhere).
--
-- IMPORTANT: job_document_files CASCADEs on its FK to job_documents, but the
-- explicit order here drops the child first for clarity. Also explicitly
-- revokes the anon grants (defense in depth — if tables were somehow
-- recreated with different shapes, the grants shouldn't survive).

BEGIN;

-- job_document_files
REVOKE SELECT, UPDATE ON public.job_document_files FROM anon;

DROP POLICY IF EXISTS job_document_files_anon_sign_update ON public.job_document_files;
DROP POLICY IF EXISTS job_document_files_anon_sign_select ON public.job_document_files;
DROP POLICY IF EXISTS job_document_files_tenant_update  ON public.job_document_files;
DROP POLICY IF EXISTS job_document_files_tenant_insert  ON public.job_document_files;
DROP POLICY IF EXISTS job_document_files_tenant_select  ON public.job_document_files;

DROP INDEX IF EXISTS public.job_document_files_pending_sign_idx;
DROP INDEX IF EXISTS public.job_document_files_tenant_kind_idx;
DROP INDEX IF EXISTS public.job_document_files_tenant_job_document_idx;
DROP INDEX IF EXISTS public.job_document_files_signature_token_unique_idx;

DROP TABLE IF EXISTS public.job_document_files;

-- job_documents
DROP POLICY IF EXISTS job_documents_tenant_update ON public.job_documents;
DROP POLICY IF EXISTS job_documents_tenant_insert ON public.job_documents;
DROP POLICY IF EXISTS job_documents_tenant_select ON public.job_documents;

DROP INDEX IF EXISTS public.job_documents_correlation_idx;
DROP INDEX IF EXISTS public.job_documents_tenant_customer_idx;
DROP INDEX IF EXISTS public.job_documents_tenant_stage_idx;
DROP INDEX IF EXISTS public.job_documents_tenant_job_unique_idx;

DROP TABLE IF EXISTS public.job_documents;

COMMIT;
