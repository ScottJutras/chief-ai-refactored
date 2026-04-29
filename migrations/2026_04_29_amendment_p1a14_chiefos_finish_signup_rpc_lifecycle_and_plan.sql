-- Migration: 2026_04_29_amendment_p1a14_chiefos_finish_signup_rpc_lifecycle_and_plan.sql
--
-- PHASE 1 PR-A AMENDMENT (Session P1A-14) for Foundation Rebuild V2.
--
-- Companion to 2026_04_29_phase1_pra_lifecycle_and_plan_key_on_chiefos_tenants.sql:
-- updates chiefos_finish_signup() to drop the users.plan_key write (column has
-- been removed) and rely on chiefos_tenants column DEFAULTs to set
-- lifecycle_state='pre_trial' and plan_key='trial' for every new tenant.
--
-- Apply order: this migration MUST be applied AFTER
-- 2026_04_29_phase1_pra_lifecycle_and_plan_key_on_chiefos_tenants.sql.
-- The RPC body would fail (column users.plan_key does not exist) if applied first.
--
-- ============================================================================
-- Behavior delta vs P1A-13:
--
--   1. The public.users INSERT no longer writes plan_key. The column has
--      been dropped by the schema migration.
--
--   2. New tenants automatically receive lifecycle_state='pre_trial' and
--      plan_key='trial' via chiefos_tenants column DEFAULTs (no explicit
--      INSERT clause needed). The RPC creates a tenant in pre_trial state;
--      the trial clock starts on first WhatsApp msg or first portal login
--      (per TMTS v1.1 §7.3 — startTrialClock).
--
--   3. Header docstring updated to reflect plan_key migration to chiefos_tenants.
--
-- What is NOT changed:
--   - Authentication step (auth.uid() check)
--   - Idempotency contract (chiefos_portal_users PK on user_id)
--   - Phone normalization, validation, and E.164 persistence (P1A-13 logic intact)
--   - Company name validation
--   - Phone-collision policy (OWNER_PHONE_ALREADY_CLAIMED)
--   - All other validation steps, error taxonomy, grants, search_path
--   - All other public.users columns: user_id, owner_id, tenant_id, name,
--     email, role, signup_status, auth_user_id remain in the INSERT
-- ============================================================================
--
-- Rollback: restore P1A-13 RPC body — see matching rollback file at
-- migrations/rollbacks/2026_04_29_amendment_p1a14_chiefos_finish_signup_rpc_lifecycle_and_plan_rollback.sql
--
-- Rollback ordering: apply this RPC rollback BEFORE the schema rollback,
-- because P1A-13 writes users.plan_key='free' which requires the column to exist.
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='chiefos_tenants'
                   AND column_name='lifecycle_state') THEN
    RAISE EXCEPTION 'Requires chiefos_tenants.lifecycle_state (apply 2026_04_29_phase1_pra schema migration first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='chiefos_tenants'
                   AND column_name='plan_key') THEN
    RAISE EXCEPTION 'Requires chiefos_tenants.plan_key (apply 2026_04_29_phase1_pra schema migration first)';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='users'
               AND column_name='plan_key') THEN
    RAISE EXCEPTION 'public.users.plan_key still present — schema migration not yet applied; this RPC body would silently leave the legacy column unwritten';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname='public' AND p.proname='chiefos_finish_signup') THEN
    RAISE EXCEPTION 'Requires public.chiefos_finish_signup (apply amendment_p1a13 first)';
  END IF;
END
$preflight$;

-- ============================================================================
-- chiefos_finish_signup (P1A-14: lifecycle on tenants; plan_key on tenants)
--
-- Inputs:  same as P1A-13 — company_name_override (optional)
-- Output:  same as P1A-13 — jsonb with tenant_id, owner_id, portal_user_id, idempotent
-- Errors:
--          P0001 'NOT_AUTHENTICATED'              auth.uid() is null
--          P0001 'METADATA_MISSING_OWNER_PHONE'   no owner_phone in metadata
--          P0001 'OWNER_PHONE_INVALID'            digit count < 7
--          P0001 'OWNER_PHONE_FORMAT_INVALID'     E.164 normalization fails
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

  -- 4b. Compute and validate E.164 form (P1A-13 logic preserved verbatim).
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

  -- 6. Create tenant.
  --    lifecycle_state and plan_key receive their column DEFAULTs ('pre_trial'
  --    and 'trial' respectively, per TMTS v1.1 §5.1 + §5.2 amended for Phase 1).
  --    This means every new tenant lands in pre_trial; the 14-day trial clock
  --    starts on first WhatsApp msg OR first portal login per startTrialClock()
  --    in §7.3.
  --    Phone-collision: catch unique_violation (chiefos_tenants_owner_id_unique
  --    OR chiefos_tenants_phone_e164_unique_idx) → OWNER_PHONE_ALREADY_CLAIMED.
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
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'OWNER_PHONE_ALREADY_CLAIMED',
        DETAIL  = format('owner_id %L (phone %L) is already claimed by another tenant', v_owner_id, v_phone_e164),
        HINT    = 'Use a different phone, or contact support to recover the existing tenant';
  END;

  -- 7. Create portal-user membership (PK = user_id; one auth user → one tenant).
  INSERT INTO public.chiefos_portal_users (user_id, tenant_id, role, can_insert_financials, status)
  VALUES (v_auth_user_id, v_tenant_id, 'owner', true, 'active');

  -- 8. Create public.users owner row.
  --    user_id == owner_id for the owner-self row (per dual-boundary identity).
  --    plan_key is no longer written here — it lives on chiefos_tenants (P1A-14).
  --    Plan resolution (TMTS §6) reads plan_key via tenant_id JOIN going forward.
  INSERT INTO public.users (
    user_id, owner_id, tenant_id, name, email, role, signup_status, auth_user_id
  )
  VALUES (
    v_owner_id,
    v_owner_id,
    v_tenant_id,
    v_owner_name,
    v_email,
    'owner',
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
  'Path α onboarding spine (P1A-14: lifecycle + plan_key on chiefos_tenants). '
  'Reads auth.uid() + auth.users.raw_user_meta_data; creates chiefos_tenants + '
  'chiefos_portal_users + public.users atomically. New tenant lands in '
  'lifecycle_state=pre_trial / plan_key=trial via column DEFAULTs (TMTS v1.1 §5.1, §5.2). '
  'Persists original E.164 phone alongside derived owner_id (P1A-13). Idempotent on '
  'chiefos_portal_users(user_id). Phone collisions surface as OWNER_PHONE_ALREADY_CLAIMED '
  '(P0001) from owner_id OR phone_e164 unique constraint. DO NOT add parameters — '
  'extend metadata at signUp() and read here. See migrations 2026_04_29_amendment_p1a7 + '
  'amendment_p1a13 + amendment_p1a14.';

REVOKE ALL ON FUNCTION public.chiefos_finish_signup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chiefos_finish_signup(text) TO authenticated;

COMMIT;
