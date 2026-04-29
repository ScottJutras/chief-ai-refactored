-- Migration: 2026_04_29_amendment_p1a7_chiefos_finish_signup_rpc.sql
--
-- PHASE 1 AMENDMENT (Session P1A-7) for Foundation Rebuild V2.
--
-- Gap source: post-cutover Path α onboarding refactor. Pre-rebuild signup
-- routed through public.chiefos_pending_signups (DISCARDed in rebuild per
-- FOUNDATION_P1_SCHEMA_DESIGN_FULL.md §6.1 Decision 1: "Supabase Auth +
-- users.signup_status handles"). Post-cutover, four chiefos-site routes are
-- 503-gated pending the architecturally correct replacement: a single PG RPC
-- that creates tenant + portal_user + public.users atomically from
-- auth.users.raw_user_meta_data.
--
-- ----------------------------------------------------------------------------
-- Source-of-truth contract (READ THIS BEFORE EXTENDING THE RPC):
--
-- chiefos_finish_signup reads onboarding state exclusively from
-- auth.users.raw_user_meta_data. Do not add parameters to this RPC for new
-- signup fields; instead, add the field to auth.users.raw_user_meta_data at
-- the signUp() call in app/api/auth/signup/route.ts and read it here. This
-- preserves the "auth is the source of truth, RPC just commits the tenant"
-- contract.
-- ----------------------------------------------------------------------------
--
-- Identity model (dual-boundary, never collapse):
--   - tenant_id (uuid)         portal/RLS boundary
--   - owner_id  (digits text)  ingestion/audit boundary; UNIQUE per tenant
--   - user_id   (digits text)  actor identity; for owner-self == owner_id
--   - auth_user_id (uuid)      reverse pointer to auth.users; UNIQUE on users
--
-- owner_id derivation: digits-only(metadata.owner_phone). Must be ≥7 digits.
-- Phone is the WhatsApp identity boundary; making it optional creates
-- downstream identity-merge problems (the seed tenant uses owner_id
-- 14165550100). Fail-closed if missing or invalid.
--
-- Idempotency: if chiefos_portal_users row already exists for auth.uid(),
-- return existing {tenant_id, owner_id, portal_user_id} unchanged. The RPC
-- can be called multiple times (page refresh on /finish-signup, etc.) without
-- duplicate rows or errors.
--
-- Phone-collision policy: do NOT pre-check ownership. The
-- chiefos_tenants_owner_id_unique constraint IS the check. Catch
-- unique_violation on chiefos_tenants INSERT and re-raise as structured error
-- with MESSAGE='OWNER_PHONE_ALREADY_CLAIMED' (ERRCODE='P0001'). Pre-checking
-- creates ambiguity for re-signup-with-different-email and future
-- multi-portal-user-per-tenant scenarios; constraint-as-source-of-truth is
-- the simpler invariant.
--
-- Legal acceptance is NOT written here. /api/legal/accept handles
-- chiefos_legal_acceptances post-RPC (it requires tenant_id + auth_user_id,
-- which only exist after this RPC commits). FinishSignupClient orders the
-- two correctly: create-workspace (this RPC) → record-agreement (/legal).
--
-- SECURITY DEFINER required because:
--   - chiefos_portal_users INSERT must succeed against the FK to auth.users
--     even though the caller's role lacks direct INSERT on auth schema.
--   - search_path='' pinned per rebuild_functions.sql idiom (no injection
--     surface; all references are schema-qualified).
--
-- Apply-order: out of band. Phase 5 cutover is COMPLETE (manifest §3 frozen).
-- This is a post-cutover P1A-N amendment applied directly to production via
-- mcp__claude_ai_Supabase__apply_migration. No re-runner. Manifest §7 (post-
-- cutover amendments) records this entry separately.
--
-- Rollback: DROP FUNCTION public.chiefos_finish_signup() — see matching
-- rollback file in migrations/rollbacks/.
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_tenants') THEN
    RAISE EXCEPTION 'Requires public.chiefos_tenants (apply rebuild_identity_tenancy first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_portal_users') THEN
    RAISE EXCEPTION 'Requires public.chiefos_portal_users (apply rebuild_identity_tenancy first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='users'
                   AND column_name='auth_user_id') THEN
    RAISE EXCEPTION 'Requires public.users.auth_user_id (apply amendment_p1a4_users_auth_user_id first)';
  END IF;
END
$preflight$;

-- ============================================================================
-- chiefos_finish_signup
--
-- Inputs:  none. Reads auth.uid() and auth.users.raw_user_meta_data.
--          (Optional company_name_override accepted for FE display-vars use;
--           overrides metadata.company_name when non-null/non-empty.)
-- Output:  jsonb { tenant_id uuid, owner_id text, portal_user_id uuid }
-- Errors:
--          P0001 'NOT_AUTHENTICATED'              auth.uid() is null
--          P0001 'METADATA_MISSING_OWNER_PHONE'   no owner_phone in metadata
--          P0001 'OWNER_PHONE_INVALID'            digits ext < 7 chars
--          P0001 'METADATA_MISSING_COMPANY_NAME'  no company_name in metadata
--          P0001 'OWNER_PHONE_ALREADY_CLAIMED'   another tenant owns owner_id
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

  -- 3. Read auth metadata (single source of truth — see header contract).
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
  --    Catch unique_violation on owner_id to surface structured error.
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
      -- chiefos_tenants_owner_id_unique fired. Re-raise as structured taxonomy.
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'OWNER_PHONE_ALREADY_CLAIMED',
        DETAIL  = format('owner_id %L is already claimed by another tenant', v_owner_id),
        HINT    = 'Use a different phone, or contact support to recover the existing tenant';
  END;

  -- 7. Create portal-user membership (PK = user_id; one auth user → one tenant).
  INSERT INTO public.chiefos_portal_users (user_id, tenant_id, role, can_insert_financials, status)
  VALUES (v_auth_user_id, v_tenant_id, 'owner', true, 'active');

  -- 8. Create public.users owner row. user_id == owner_id for owner-self.
  --    plan_key defaults to 'free'; tester-access activation flips it later.
  --    signup_status='complete' since RPC completes the spine atomically.
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

-- Grants: only authenticated users may invoke. Anon is rejected at auth.uid()
-- check anyway, but explicit GRANT keeps the access surface tight.
REVOKE ALL ON FUNCTION public.chiefos_finish_signup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chiefos_finish_signup(text) TO authenticated;

COMMIT;
