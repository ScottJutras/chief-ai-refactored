-- ============================================================================
-- Foundation Rebuild — Session P3-4b: RLS coverage gap fix
--
-- Single coverage gap identified by the Session P3-4b RLS verification
-- (SESSION_P3_4B_RLS_COVERAGE_REPORT.md):
--
-- **Quotes spine tables lack explicit GRANT statements.**
--
-- The 6 Quotes spine tables (created by rebuild_quotes_spine.sql) enable RLS
-- and have appropriate tenant-membership SELECT policies (plus write policies
-- on the header table). However, per Principle 9 ("explicit GRANTs required;
-- never rely on Supabase default_acl"), each table must GRANT the matching
-- verbs to `authenticated` and `service_role`.
--
-- Pre-rebuild schema relied on Supabase's default_acl which auto-grants when
-- tables are created by `supabase_admin` via the SQL editor. Post-rebuild,
-- tables are created by the migration runner (postgres role) — default_acl
-- does NOT apply and explicit GRANTs are load-bearing. Without them, the
-- Quotes spine tables would be unreadable to `authenticated` even though RLS
-- policies nominally allow SELECT.
--
-- This migration ADDS only the missing GRANTs. It does NOT modify the
-- rebuild_quotes_spine.sql file (per Session P3-4b work order constraint:
-- "gap fix = additive only").
--
-- GRANT set matches the policy posture in rebuild_quotes_spine.sql:
--   - chiefos_quotes (portal-writable header): auth = SELECT, INSERT, UPDATE
--   - chiefos_quote_versions (append-only post-lock): auth = SELECT only
--   - chiefos_quote_line_items (append-only post-lock): auth = SELECT only
--   - chiefos_quote_share_tokens (§11.0 tight pattern): auth = SELECT only
--   - chiefos_quote_signatures (strict immutable): auth = SELECT only
--   - chiefos_quote_events (append-only): auth = SELECT only
-- All six: service_role = ALL (for backend writes; service_role bypasses RLS).
--
-- Dependencies:
--   - All 6 Quotes spine tables must exist (rebuild_quotes_spine.sql applied).
--
-- Idempotent: GRANT is a no-op when the privilege is already held. Safe to re-run.
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_quotes') THEN
    RAISE EXCEPTION 'Requires public.chiefos_quotes (apply rebuild_quotes_spine first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_quote_events') THEN
    RAISE EXCEPTION 'Requires public.chiefos_quote_events (apply rebuild_quotes_spine first)';
  END IF;
END
$preflight$;

-- chiefos_quotes (portal-writable header: SELECT + INSERT + UPDATE)
GRANT SELECT, INSERT, UPDATE ON public.chiefos_quotes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chiefos_quotes TO service_role;

-- chiefos_quote_versions (SELECT only for authenticated; service_role full)
GRANT SELECT ON public.chiefos_quote_versions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chiefos_quote_versions TO service_role;

-- chiefos_quote_line_items (SELECT only for authenticated)
GRANT SELECT ON public.chiefos_quote_line_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chiefos_quote_line_items TO service_role;

-- chiefos_quote_share_tokens (SELECT only for authenticated)
GRANT SELECT ON public.chiefos_quote_share_tokens TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chiefos_quote_share_tokens TO service_role;

-- chiefos_quote_signatures (SELECT only for authenticated)
GRANT SELECT ON public.chiefos_quote_signatures TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chiefos_quote_signatures TO service_role;

-- chiefos_quote_events (SELECT only for authenticated)
GRANT SELECT ON public.chiefos_quote_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chiefos_quote_events TO service_role;

COMMIT;
