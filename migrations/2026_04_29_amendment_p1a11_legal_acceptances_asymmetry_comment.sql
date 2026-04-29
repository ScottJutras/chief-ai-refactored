-- Migration: 2026_04_29_amendment_p1a11_legal_acceptances_asymmetry_comment.sql
--
-- PHASE 1 AMENDMENT (Session P1A-11) for Foundation Rebuild V2.
--
-- Documents the intentional service_role grant asymmetry between
-- chiefos_legal_acceptances and its peer tables. Schema-side COMMENT so
-- the rationale is queryable from `\d+ chiefos_legal_acceptances` or any
-- introspection tool — not just buried in migration history.
--
-- Pairs with P1A-10 (which granted UPDATE only, deliberately omitting
-- DELETE). Without this comment, a future engineer running a
-- consistency-cleanup pass might "fix" the divergence by granting DELETE
-- — re-introducing the footgun P1A-10 deliberately avoided.
-- ============================================================================

BEGIN;

COMMENT ON TABLE public.chiefos_legal_acceptances IS
$comment$INTENTIONAL ASYMMETRY (P1A-10/P1A-11): service_role grants on this table
are INSERT + SELECT + UPDATE only. DELETE is NOT granted to service_role,
unlike peer tables (chiefos_portal_users, chiefos_tenants, public.users)
which carry the full DELETE/INSERT/SELECT/UPDATE quartet.

Rationale: legal acceptances are compliance/audit records. Routine deletion
via service_role is a footgun. Account-deletion lifecycle is handled by the
FK CASCADE on auth_user_id (when auth.users row is deleted, dependent rows
go with it). Manual cleanup for unusual cases is still possible via direct
postgres-role SQL.

If a future use case requires service_role DELETE on this table, ship a
dedicated P1A-N migration with explicit justification. DO NOT "fix" this
divergence as mere consistency cleanup.

Client-side INSERT/UPDATE/DELETE are blocked at the RLS layer
(legal_acceptances_*_block_client policies) — only service_role can write
via /api/legal/accept. Authenticated clients have SELECT-by-tenant-
membership only.$comment$;

COMMIT;
