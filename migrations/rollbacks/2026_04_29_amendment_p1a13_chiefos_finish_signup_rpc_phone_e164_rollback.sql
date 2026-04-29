-- Rollback for: 2026_04_29_amendment_p1a13_chiefos_finish_signup_rpc_phone_e164.sql
--
-- Restores chiefos_finish_signup() to the P1A-7 body (phone_e164 persistence
-- removed). Requires the phase0_p1 column rollback to also be applied if
-- callers should not see phone_e164 errors from the schema.
--
-- This rollback redefines the function inline rather than DROP-then-recreate
-- to avoid breaking GRANTs or callers between the two operations.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.chiefos_finish_signup(
  company_name_override text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_auth_user_id   uuid;
  v_metadata       jsonb;
  v_email          text;
  v_existing_pu    public.chiefos_portal_users%ROWTYPE;
  v_existing_user  public.users%ROWTYPE;
  v_owner_phone    text;
  v_owner_name     text;
  v_company_name   text;
  v_country        text;
  v_province       text;
  v_owner_id       text;
  v_tenant_id      uuid;
BEGIN
  v_auth_user_id := auth.uid();
  IF v_auth_user_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'NOT_AUTHENTICATED',
      DETAIL  = 'auth.uid() returned null',
      HINT    = 'Caller must present a valid Supabase Auth bearer token';
  END IF;

  SELECT * INTO v_existing_pu
  FROM public.chiefos_portal_users
  WHERE user_id = v_auth_user_id;

  IF FOUND THEN
    SELECT * INTO v_existing_user
    FROM public.users
    WHERE auth_user_id = v_auth_user_id;

    RETURN jsonb_build_object(
      'tenant_id',      v_existing_pu.tenant_id,
      'owner_id',       v_existing_user.owner_id,
      'portal_user_id', v_existing_pu.user_id,
      'idempotent',     true
    );
  END IF;

  SELECT raw_user_meta_data, email
    INTO v_metadata, v_email
  FROM auth.users
  WHERE id = v_auth_user_id;

  v_owner_phone  := NULLIF(trim(coalesce(v_metadata->>'owner_phone', '')), '');
  v_owner_name   := NULLIF(trim(coalesce(v_metadata->>'owner_name',  '')), '');
  v_company_name := NULLIF(trim(coalesce(company_name_override, v_metadata->>'company_name', '')), '');
  v_country      := upper(NULLIF(trim(coalesce(v_metadata->>'country', '')), ''));
  v_province     := NULLIF(trim(coalesce(v_metadata->>'province', '')), '');

  IF v_owner_phone IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'METADATA_MISSING_OWNER_PHONE',
      DETAIL  = 'auth.users.raw_user_meta_data.owner_phone is null/empty',
      HINT    = 'Phone is required at signup; check signUp options.data payload';
  END IF;

  v_owner_id := regexp_replace(v_owner_phone, '\D', '', 'g');

  IF char_length(v_owner_id) < 7 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'OWNER_PHONE_INVALID',
      DETAIL  = format('owner_phone %L yields %s digits; requires >= 7', v_owner_phone, char_length(v_owner_id)),
      HINT    = 'Provide a full phone number in E.164 or national format';
  END IF;

  IF v_company_name IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'METADATA_MISSING_COMPANY_NAME',
      DETAIL  = 'auth.users.raw_user_meta_data.company_name is null/empty (and no override passed)',
      HINT    = 'Company name is required at signup; check signUp options.data payload';
  END IF;

  BEGIN
    INSERT INTO public.chiefos_tenants (owner_id, name, country, province)
    VALUES (
      v_owner_id,
      v_company_name,
      coalesce(v_country, 'CA'),
      v_province
    )
    RETURNING id INTO v_tenant_id;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'OWNER_PHONE_ALREADY_CLAIMED',
        DETAIL  = format('owner_id %L is already claimed by another tenant', v_owner_id),
        HINT    = 'Use a different phone, or contact support to recover the existing tenant';
  END;

  INSERT INTO public.chiefos_portal_users (user_id, tenant_id, role, can_insert_financials, status)
  VALUES (v_auth_user_id, v_tenant_id, 'owner', true, 'active');

  INSERT INTO public.users (
    user_id, owner_id, tenant_id, name, email, role, plan_key, signup_status, auth_user_id
  )
  VALUES (
    v_owner_id,
    v_owner_id,
    v_tenant_id,
    v_owner_name,
    v_email,
    'owner',
    'free',
    'complete',
    v_auth_user_id
  );

  RETURN jsonb_build_object(
    'tenant_id',      v_tenant_id,
    'owner_id',       v_owner_id,
    'portal_user_id', v_auth_user_id,
    'idempotent',     false
  );
END;
$function$;

COMMENT ON FUNCTION public.chiefos_finish_signup(text) IS
  'Path α onboarding spine. Reads auth.uid() + auth.users.raw_user_meta_data; '
  'creates chiefos_tenants + chiefos_portal_users + public.users atomically. '
  'Idempotent on chiefos_portal_users(user_id). Phone collisions surface as '
  'OWNER_PHONE_ALREADY_CLAIMED (P0001). DO NOT add parameters — extend metadata '
  'at signUp() and read here. See migration 2026_04_29_amendment_p1a7 header.';

REVOKE ALL ON FUNCTION public.chiefos_finish_signup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chiefos_finish_signup(text) TO authenticated;

COMMIT;
