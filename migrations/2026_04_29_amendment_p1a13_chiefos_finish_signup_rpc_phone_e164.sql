-- Migration: 2026_04_29_amendment_p1a13_chiefos_finish_signup_rpc_phone_e164.sql
--
-- PHASE 1 AMENDMENT (Session P1A-13) for Foundation Rebuild V2.
--
-- Companion to phase0_p1 migration: extends chiefos_finish_signup() to
-- normalize the original phone string to E.164 and persist it to
-- chiefos_tenants.phone_e164 (added by phase0_p1).
--
-- Apply order: this migration MUST be applied AFTER
-- 2026_04_29_phase0_p1_phone_e164_on_chiefos_tenants.sql. The RPC body
-- references chiefos_tenants.phone_e164 which does not exist before phase0_p1.
--
-- ----------------------------------------------------------------------------
-- Behavior delta vs P1A-7:
--
--   AFTER reading v_owner_phone from auth metadata and validating digit length,
--   the RPC now ALSO computes v_phone_e164 = '+' || v_owner_id and asserts the
--   result matches the chiefos_tenants_phone_e164_format_chk regex. If the
--   normalized form is invalid (e.g., owner_id starts with 0, or is >15
--   digits), raises OWNER_PHONE_FORMAT_INVALID before INSERT.
--
--   The chiefos_tenants INSERT is extended to write phone_e164 alongside
--   owner_id, name, country, province.
--
-- What is NOT changed:
--   - v_owner_id derivation (regexp_replace digit-strip) — still canonical
--     ingestion identity per Engineering Constitution §2 dual-boundary rule
--   - Idempotency contract (chiefos_portal_users PK on user_id)
--   - Phone-collision policy (catch unique_violation on chiefos_tenants
--     INSERT, re-raise OWNER_PHONE_ALREADY_CLAIMED). The unique_violation
--     can now fire from EITHER chiefos_tenants_owner_id_unique OR the new
--     chiefos_tenants_phone_e164_unique_idx; same structural error from the
--     caller's perspective.
--   - All other validation steps, error taxonomy, grants, search_path
-- ----------------------------------------------------------------------------
--
-- Identity model unchanged:
--   - tenant_id (uuid)         portal/RLS boundary
--   - owner_id  (digits text)  ingestion/audit boundary; UNIQUE per tenant
--   - phone_e164 (text)        ADDED storage of E.164 phone format
--
-- Backward compatibility: the RPC is a CREATE OR REPLACE FUNCTION; existing
-- callers (chiefos-site finish-signup flow, idempotent re-calls on page
-- refresh) continue to work without code changes. Previously-onboarded
-- tenants have phone_e164 backfilled by phase0_p1 migration.
--
-- Rollback: restore P1A-7 RPC body — see matching rollback file at
-- migrations/rollbacks/2026_04_29_amendment_p1a13_chiefos_finish_signup_rpc_phone_e164_rollback.sql
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='chiefos_tenants'
                   AND column_name='phone_e164') THEN
    RAISE EXCEPTION 'Requires chiefos_tenants.phone_e164 (apply 2026_04_29_phase0_p1 first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname='public' AND p.proname='chiefos_finish_signup') THEN
    RAISE EXCEPTION 'Requires public.chiefos_finish_signup (apply amendment_p1a7 first)';
  END IF;
END
$preflight$;

-- ============================================================================
-- chiefos_finish_signup (extended for phone_e164 persistence)
--
-- Inputs:  same as P1A-7
-- Output:  same as P1A-7
-- Errors:
--          P0001 'NOT_AUTHENTICATED'              auth.uid() is null
--          P0001 'METADATA_MISSING_OWNER_PHONE'   no owner_phone in metadata
--          P0001 'OWNER_PHONE_INVALID'            digit count < 7
--          P0001 'OWNER_PHONE_FORMAT_INVALID'     E.164 normalization fails
--                                                 (e.g., starts with 0, >15 digits)
--          P0001 'METADATA_MISSING_COMPANY_NAME'  no company_name in metadata
--          P0001 'OWNER_PHONE_ALREADY_CLAIMED'   owner_id OR phone_e164 collision
-- ============================================================================
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
  v_phone_e164     text;
  v_tenant_id      uuid;
BEGIN
  -- 1. Authentication
  v_auth_user_id := auth.uid();
  IF v_auth_user_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'NOT_AUTHENTICATED',
      DETAIL  = 'auth.uid() returned null',
      HINT    = 'Caller must present a valid Supabase Auth bearer token';
  END IF;

  -- 2. Idempotency: if portal_user row exists, return existing state unchanged.
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

  -- 3. Read auth metadata (single source of truth — see P1A-7 header contract).
  SELECT raw_user_meta_data, email
    INTO v_metadata, v_email
  FROM auth.users
  WHERE id = v_auth_user_id;

  v_owner_phone  := NULLIF(trim(coalesce(v_metadata->>'owner_phone', '')), '');
  v_owner_name   := NULLIF(trim(coalesce(v_metadata->>'owner_name',  '')), '');
  v_company_name := NULLIF(trim(coalesce(company_name_override, v_metadata->>'company_name', '')), '');
  v_country      := upper(NULLIF(trim(coalesce(v_metadata->>'country', '')), ''));
  v_province     := NULLIF(trim(coalesce(v_metadata->>'province', '')), '');

  -- 4. Validate phone (the WhatsApp identity boundary).
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

  -- 4b. Compute and validate E.164 form.
  --     phase0_p1 added chiefos_tenants_phone_e164_format_chk: '^\+[1-9]\d{6,14}$'
  --     v_phone_e164 must match the same regex BEFORE INSERT, so we surface a
  --     structured error rather than letting the CHECK constraint produce a
  --     generic 23514 violation.
  v_phone_e164 := '+' || v_owner_id;

  IF v_phone_e164 !~ '^\+[1-9]\d{6,14}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'OWNER_PHONE_FORMAT_INVALID',
      DETAIL  = format('phone_e164 candidate %L does not match E.164 (^\+[1-9]\d{6,14}$). owner_id digits: %s.',
                       v_phone_e164, char_length(v_owner_id)),
      HINT    = 'Phone must produce a valid E.164 number: country code 1-9, total 7-15 digits';
  END IF;

  -- 5. Validate company.
  IF v_company_name IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'METADATA_MISSING_COMPANY_NAME',
      DETAIL  = 'auth.users.raw_user_meta_data.company_name is null/empty (and no override passed)',
      HINT    = 'Company name is required at signup; check signUp options.data payload';
  END IF;

  -- 6. Create tenant. Country/province defaults handled by table definition
  --    when metadata is silent (country defaults 'CA', province nullable).
  --    Catch unique_violation on owner_id OR phone_e164 to surface structured
  --    error. Both constraints enforce one-tenant-per-phone (deterministically
  --    redundant; phone_e164 is defense-in-depth).
  BEGIN
    INSERT INTO public.chiefos_tenants (owner_id, name, country, province, phone_e164)
    VALUES (
      v_owner_id,
      v_company_name,
      coalesce(v_country, 'CA'),
      v_province,
      v_phone_e164
    )
    RETURNING id INTO v_tenant_id;
  EXCEPTION
    WHEN unique_violation THEN
      -- chiefos_tenants_owner_id_unique OR chiefos_tenants_phone_e164_unique_idx fired.
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'OWNER_PHONE_ALREADY_CLAIMED',
        DETAIL  = format('owner_id %L (phone %L) is already claimed by another tenant', v_owner_id, v_phone_e164),
        HINT    = 'Use a different phone, or contact support to recover the existing tenant';
  END;

  -- 7. Create portal-user membership (PK = user_id; one auth user → one tenant).
  INSERT INTO public.chiefos_portal_users (user_id, tenant_id, role, can_insert_financials, status)
  VALUES (v_auth_user_id, v_tenant_id, 'owner', true, 'active');

  -- 8. Create public.users owner row. user_id == owner_id for owner-self.
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
  'Path α onboarding spine (P1A-13: phone_e164 persistence). Reads auth.uid() '
  '+ auth.users.raw_user_meta_data; creates chiefos_tenants + chiefos_portal_users '
  '+ public.users atomically. Persists original E.164 phone alongside derived '
  'owner_id. Idempotent on chiefos_portal_users(user_id). Phone collisions '
  'surface as OWNER_PHONE_ALREADY_CLAIMED (P0001) from owner_id OR phone_e164 '
  'unique constraint. DO NOT add parameters — extend metadata at signUp() and '
  'read here. See migrations 2026_04_29_amendment_p1a7 + amendment_p1a13.';

REVOKE ALL ON FUNCTION public.chiefos_finish_signup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chiefos_finish_signup(text) TO authenticated;

COMMIT;
