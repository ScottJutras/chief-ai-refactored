-- ============================================================================
-- Rollback for 2026_04_21_rebuild_identity_tenancy.sql
--
-- Drops the six identity/tenancy tables and their policies in reverse order.
-- Safe to re-run (IF EXISTS on every drop).
--
-- WARNING: dropping chiefos_tenants cascades to every tenant-scoped table
-- (users, chiefos_portal_users, chiefos_legal_acceptances) via ON DELETE
-- RESTRICT FKs, which will BLOCK the drop if rows exist. Run against an
-- empty schema, or drop rows first.
-- ============================================================================

BEGIN;

-- Drop policies first (explicit; DROP TABLE would cascade, but auditable)
DROP POLICY IF EXISTS chiefos_beta_signups_anon_insert ON public.chiefos_beta_signups;
DROP POLICY IF EXISTS portal_phone_link_otp_own_select ON public.portal_phone_link_otp;

DROP POLICY IF EXISTS legal_acceptances_delete_block_client ON public.chiefos_legal_acceptances;
DROP POLICY IF EXISTS legal_acceptances_update_block_client ON public.chiefos_legal_acceptances;
DROP POLICY IF EXISTS legal_acceptances_insert_block_client ON public.chiefos_legal_acceptances;
DROP POLICY IF EXISTS legal_acceptances_select_by_tenant_membership ON public.chiefos_legal_acceptances;

DROP POLICY IF EXISTS portal_users_owner_update_roles ON public.chiefos_portal_users;
DROP POLICY IF EXISTS portal_users_authenticated_self_insert ON public.chiefos_portal_users;
DROP POLICY IF EXISTS portal_users_tenant_read_by_owner ON public.chiefos_portal_users;
DROP POLICY IF EXISTS portal_users_self_select ON public.chiefos_portal_users;

DROP POLICY IF EXISTS users_tenant_update_owner ON public.users;
DROP POLICY IF EXISTS users_tenant_select ON public.users;

DROP POLICY IF EXISTS chiefos_tenants_owner_update ON public.chiefos_tenants;
DROP POLICY IF EXISTS chiefos_tenants_portal_insert ON public.chiefos_tenants;
DROP POLICY IF EXISTS chiefos_tenants_portal_select ON public.chiefos_tenants;

-- Drop indexes (explicit; DROP TABLE cascades but this is auditable)
DROP INDEX IF EXISTS public.chiefos_beta_signups_status_idx;
DROP INDEX IF EXISTS public.chiefos_beta_signups_email_idx;

DROP INDEX IF EXISTS public.portal_phone_link_otp_expires_idx;

DROP INDEX IF EXISTS public.chiefos_legal_acceptances_auth_user_idx;
DROP INDEX IF EXISTS public.chiefos_legal_acceptances_tenant_idx;

DROP INDEX IF EXISTS public.chiefos_portal_users_owner_lookup_idx;
DROP INDEX IF EXISTS public.chiefos_portal_users_tenant_idx;

DROP INDEX IF EXISTS public.users_email_idx;
DROP INDEX IF EXISTS public.users_stripe_customer_idx;
DROP INDEX IF EXISTS public.users_tenant_idx;
DROP INDEX IF EXISTS public.users_owner_idx;

DROP INDEX IF EXISTS public.chiefos_tenants_token_idx;
DROP INDEX IF EXISTS public.chiefos_tenants_owner_idx;

-- Drop tables in reverse dependency order
DROP TABLE IF EXISTS public.chiefos_beta_signups;
DROP TABLE IF EXISTS public.portal_phone_link_otp;
DROP TABLE IF EXISTS public.chiefos_legal_acceptances;
DROP TABLE IF EXISTS public.chiefos_portal_users;
DROP TABLE IF EXISTS public.users;
DROP TABLE IF EXISTS public.chiefos_tenants;

COMMIT;
