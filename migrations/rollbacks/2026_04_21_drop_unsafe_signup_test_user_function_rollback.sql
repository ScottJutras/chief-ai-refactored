-- ============================================================================
-- Rollback for 2026_04_21_drop_unsafe_signup_test_user_function.sql
--
-- WARNING: This rollback exists for forensic / audit completeness ONLY.
-- The function being restored was identified as UNSAFE in
-- FOUNDATION_P2_SECURITY_AUDIT.md (Finding UA-1). It has no authorization
-- check and allows any anonymous caller to delete any user's account and
-- tenant by email.
--
-- IF YOU ARE RUNNING THIS ROLLBACK:
--   - The function is restored with SECURITY INVOKER (not DEFINER) to
--     blunt the worst of the exploit path.
--   - The original PUBLIC EXECUTE grant is DELIBERATELY NOT RE-GRANTED.
--     Only service_role retains EXECUTE. Restoring the PUBLIC grant would
--     restore the vulnerability. Do not add it.
--   - The function body is reconstructed from the pg_get_functiondef()
--     output captured in FOUNDATION_P2_SECURITY_AUDIT.md §1.5 for forensic
--     comparison.
--   - This rollback should only ever run in a local dev environment for
--     investigating what the original function did. It must never run
--     against production.
--
-- If you legitimately need test-cleanup functionality in development,
-- write a NEW function that:
--   - Has SECURITY INVOKER
--   - Verifies the target email matches a known test-domain pattern
--     (e.g., ends in '@test.chiefos.local')
--   - Has EXECUTE granted ONLY to service_role
--   - Lives in a development migration that is not applied to production
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.chiefos_delete_signup_test_user_by_email(
  target_email text,
  delete_owned_tenant boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER                    -- changed from DEFINER for safety
SET search_path TO 'public', 'auth'
AS $function$
declare
  v_email text;
  v_auth_user_id uuid;
  v_portal_tenant_id uuid;
  v_portal_role text;
  v_tenant_owner_id text;

  v_deleted_auth_users int := 0;
  v_deleted_portal_users int := 0;
  v_deleted_legal_acceptances int := 0;
  v_deleted_pending_signups int := 0;
  v_deleted_billing_subscriptions int := 0;
  v_deleted_link_codes int := 0;
  v_deleted_user_auth_links int := 0;
  v_deleted_phone_otps int := 0;
  v_deleted_identity_map int := 0;
  v_deleted_user_identities int := 0;
  v_deleted_actor_identities int := 0;
  v_deleted_tenants int := 0;
begin
  v_email := lower(trim(target_email));

  if v_email is null or v_email = '' or position('@' in v_email) = 0 then
    raise exception 'Invalid email';
  end if;

  select u.id into v_auth_user_id
  from auth.users u
  where lower(trim(u.email)) = v_email
  limit 1;

  if to_regclass('public.chiefos_pending_signups') is not null then
    delete from public.chiefos_pending_signups
    where lower(trim(email)) = v_email;
    get diagnostics v_deleted_pending_signups = row_count;
  end if;

  if v_auth_user_id is null then
    return jsonb_build_object(
      'ok', true, 'message', 'No auth user found for email.',
      'email', v_email,
      'deleted', jsonb_build_object('chiefos_pending_signups', v_deleted_pending_signups)
    );
  end if;

  if to_regclass('public.chiefos_portal_users') is not null then
    select pu.tenant_id, pu.role into v_portal_tenant_id, v_portal_role
    from public.chiefos_portal_users pu
    where pu.user_id = v_auth_user_id
    order by pu.created_at desc nulls last limit 1;
  end if;

  if v_portal_tenant_id is not null and to_regclass('public.chiefos_tenants') is not null then
    select t.owner_id into v_tenant_owner_id
    from public.chiefos_tenants t
    where t.id = v_portal_tenant_id limit 1;
  end if;

  if to_regclass('public.chiefos_legal_acceptances') is not null then
    delete from public.chiefos_legal_acceptances where auth_user_id = v_auth_user_id;
    get diagnostics v_deleted_legal_acceptances = row_count;
  end if;

  if to_regclass('public.chiefos_portal_users') is not null then
    delete from public.chiefos_portal_users where user_id = v_auth_user_id;
    get diagnostics v_deleted_portal_users = row_count;
  end if;

  if to_regclass('public.user_auth_links') is not null then
    delete from public.user_auth_links
    where auth_user_id = v_auth_user_id or lower(trim(email)) = v_email;
    get diagnostics v_deleted_user_auth_links = row_count;
  end if;

  if v_tenant_owner_id is not null and trim(v_tenant_owner_id) <> '' then
    if to_regclass('public.portal_phone_link_otp') is not null then
      delete from public.portal_phone_link_otp where phone_digits = v_tenant_owner_id;
      get diagnostics v_deleted_phone_otps = row_count;
    end if;

    if to_regclass('public.chiefos_identity_map') is not null then
      delete from public.chiefos_identity_map
      where identifier = v_tenant_owner_id or identifier = 'whatsapp:' || v_tenant_owner_id;
      get diagnostics v_deleted_identity_map = row_count;
    end if;

    if to_regclass('public.chiefos_user_identities') is not null then
      delete from public.chiefos_user_identities
      where identifier = v_tenant_owner_id or identifier = 'whatsapp:' || v_tenant_owner_id;
      get diagnostics v_deleted_user_identities = row_count;
    end if;

    if to_regclass('public.chiefos_actor_identities') is not null then
      delete from public.chiefos_actor_identities
      where identifier = v_tenant_owner_id or identifier = 'whatsapp:' || v_tenant_owner_id;
      get diagnostics v_deleted_actor_identities = row_count;
    end if;
  end if;

  if delete_owned_tenant and v_portal_tenant_id is not null then
    if to_regclass('public.billing_subscriptions') is not null then
      delete from public.billing_subscriptions where tenant_id = v_portal_tenant_id;
      get diagnostics v_deleted_billing_subscriptions = row_count;
    end if;

    if to_regclass('public.chiefos_link_codes') is not null then
      delete from public.chiefos_link_codes where portal_user_id = v_auth_user_id;
      get diagnostics v_deleted_link_codes = row_count;
    end if;

    if to_regclass('public.chiefos_tenants') is not null then
      delete from public.chiefos_tenants where id = v_portal_tenant_id;
      get diagnostics v_deleted_tenants = row_count;
    end if;
  end if;

  delete from auth.users where id = v_auth_user_id;
  get diagnostics v_deleted_auth_users = row_count;

  return jsonb_build_object(
    'ok', true,
    'email', v_email,
    'auth_user_id', v_auth_user_id,
    'tenant_id', v_portal_tenant_id,
    'tenant_owner_id', v_tenant_owner_id,
    'deleted', jsonb_build_object(
      'chiefos_legal_acceptances', v_deleted_legal_acceptances,
      'chiefos_portal_users', v_deleted_portal_users,
      'chiefos_pending_signups', v_deleted_pending_signups,
      'user_auth_links', v_deleted_user_auth_links,
      'portal_phone_link_otp', v_deleted_phone_otps,
      'chiefos_identity_map', v_deleted_identity_map,
      'chiefos_user_identities', v_deleted_user_identities,
      'chiefos_actor_identities', v_deleted_actor_identities,
      'billing_subscriptions', v_deleted_billing_subscriptions,
      'chiefos_link_codes', v_deleted_link_codes,
      'chiefos_tenants', v_deleted_tenants,
      'auth_users', v_deleted_auth_users
    )
  );
end;
$function$;

-- Explicitly REVOKE PUBLIC EXECUTE so this rollback does not re-introduce
-- the vulnerability even if future Postgres defaults change.
REVOKE ALL ON FUNCTION public.chiefos_delete_signup_test_user_by_email(text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.chiefos_delete_signup_test_user_by_email(text, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.chiefos_delete_signup_test_user_by_email(text, boolean) FROM authenticated;

-- Grant EXECUTE only to service_role.
GRANT EXECUTE ON FUNCTION public.chiefos_delete_signup_test_user_by_email(text, boolean) TO service_role;

COMMIT;
