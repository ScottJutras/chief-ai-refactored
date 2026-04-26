-- Rollback for 2026_04_22_rebuild_rls_coverage_gap_fix.sql
-- Revokes the Quotes spine GRANTs. Safe to re-run.
--
-- Note: after this rollback, the 6 Quotes spine tables would fall back to
-- whatever default_acl grants apply. In a post-rebuild Supabase project
-- without default_acl, authenticated SELECT would stop working on these
-- tables — intentional rollback behavior (matches pre-gap-fix state).

BEGIN;

REVOKE SELECT, INSERT, UPDATE, DELETE ON public.chiefos_quote_events FROM service_role;
REVOKE SELECT ON public.chiefos_quote_events FROM authenticated;

REVOKE SELECT, INSERT, UPDATE, DELETE ON public.chiefos_quote_signatures FROM service_role;
REVOKE SELECT ON public.chiefos_quote_signatures FROM authenticated;

REVOKE SELECT, INSERT, UPDATE, DELETE ON public.chiefos_quote_share_tokens FROM service_role;
REVOKE SELECT ON public.chiefos_quote_share_tokens FROM authenticated;

REVOKE SELECT, INSERT, UPDATE, DELETE ON public.chiefos_quote_line_items FROM service_role;
REVOKE SELECT ON public.chiefos_quote_line_items FROM authenticated;

REVOKE SELECT, INSERT, UPDATE, DELETE ON public.chiefos_quote_versions FROM service_role;
REVOKE SELECT ON public.chiefos_quote_versions FROM authenticated;

REVOKE SELECT, INSERT, UPDATE, DELETE ON public.chiefos_quotes FROM service_role;
REVOKE SELECT, INSERT, UPDATE ON public.chiefos_quotes FROM authenticated;

COMMIT;
