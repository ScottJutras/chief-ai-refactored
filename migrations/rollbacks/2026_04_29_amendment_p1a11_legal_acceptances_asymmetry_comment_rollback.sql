-- Rollback for: 2026_04_29_amendment_p1a11_legal_acceptances_asymmetry_comment.sql
--
-- Removes the documentation comment. Behavior unaffected — this is
-- documentation only.

BEGIN;

COMMENT ON TABLE public.chiefos_legal_acceptances IS NULL;

COMMIT;
