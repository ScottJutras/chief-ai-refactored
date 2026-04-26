-- ============================================================================
-- Phase 5 Data Migration — P1A-4 Backfill: public.users.auth_user_id
--
-- PURPOSE:
--   Populate public.users.auth_user_id for currently-paired identities.
--   Without this, every paired owner becomes un-paired at cutover; whoami
--   returns hasWhatsApp: false for everyone until each re-pairs via OTP.
--
-- EXECUTION CONTEXT:
--   - Run AFTER all rebuild migrations apply (auth_user_id column must exist).
--   - Run BEFORE opening portal and WhatsApp writes post-cutover.
--   - Run as service_role (bypasses RLS).
--
-- DEPENDENCIES:
--   - public.users.auth_user_id column (2026_04_23_amendment_p1a4_*)
--   - public.chiefos_portal_users (2026_04_21_rebuild_identity_tenancy)
--   - public.chiefos_tenants (2026_04_21_rebuild_identity_tenancy)
--   - auth.users (Supabase-managed)
--
-- IDEMPOTENCY:
--   All UPDATEs guarded by WHERE auth_user_id IS NULL. Safe to re-run.
--
-- AUDIT:
--   Each step RAISES NOTICE with row counts. Final verification step
--   reports total paired rows and unpaired-owner count.
-- ============================================================================

-- ============================================================================
-- V8 FINDINGS (authoring session 2026-04-23 against dev DB xnmsjdummnnistzcxrtj,
-- pre-rebuild schema state — see SESSION_P1A4_AMENDMENT_REPORT.md §1):
--
--   chiefos_link_codes           : 28 rows (27 used). Columns:
--                                  (id, tenant_id, portal_user_id, code,
--                                   expires_at, used_at, created_at)
--                                  *** NO phone_digits column on this table.
--                                  *** Phone linkage was written to
--                                      chiefos_identity_map (or _user_identities)
--                                      after redemption — not to link_codes.
--                                  Step 2 (below) therefore CANNOT be authored
--                                  against this table — the phone digit-string
--                                  is not recoverable from link_codes alone.
--
--   chiefos_identity_map         : 0 rows. Empty — Step 3 non-applicable.
--   chiefos_user_identities      : 0 rows. Empty — Step 3b non-applicable.
--   chiefos_phone_active_tenant  : 0 rows. Empty — not a backfill source.
--
--   chiefos_portal_users         : 3 rows (2 'owner' role). Primary Step 1 source.
--   chiefos_tenants              : 5 rows.
--   public.users                 : 605 rows (pre-rebuild shape; many likely
--                                  orphaned employee rows without paired auth).
--
-- CONCLUSION: Only Step 1 (implicit owner linkage via chiefos_portal_users +
-- chiefos_tenants.owner_id) is authored. Employees who redeemed link codes
-- pre-rebuild will need to re-pair post-cutover via the R2.5 OTP flow — the
-- linkage data is not recoverable from the currently-populated DISCARDed tables.
-- This is flagged in the session report §8 F1 for founder review.
-- ============================================================================

BEGIN;

-- ============================================================================
-- Step 1: Backfill implicit owner linkage
--
-- Pre-rebuild, owners' portal identity was implicit: chiefos_portal_users rows
-- with role='owner' carry auth.uid() as user_id; the same human is the
-- WhatsApp owner whose phone-digit public.users.user_id equals
-- chiefos_tenants.owner_id within the same tenant. Join across tenant_id +
-- owner_id to establish the linkage.
-- ============================================================================
DO $step1$
DECLARE
  updated_count int;
BEGIN
  WITH owner_linkage AS (
    SELECT
      pu.user_id   AS auth_uid,
      t.owner_id   AS phone_digits,
      t.id         AS tenant_id
    FROM public.chiefos_portal_users pu
    JOIN public.chiefos_tenants t
      ON t.id = pu.tenant_id
    WHERE pu.role = 'owner'
  )
  UPDATE public.users u
     SET auth_user_id = ol.auth_uid
    FROM owner_linkage ol
   WHERE u.tenant_id = ol.tenant_id
     AND u.user_id   = ol.phone_digits
     AND u.auth_user_id IS NULL;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RAISE NOTICE 'P1A-4 backfill step 1 (implicit owner linkage): % rows updated', updated_count;
END
$step1$;

-- ============================================================================
-- Step 2: Backfill from chiefos_link_codes  — NOT APPLICABLE
--
-- V8 CONFIRMED: chiefos_link_codes lacks a phone_digits column. The table
-- carries (portal_user_id, tenant_id) but the actual phone digit-string was
-- written to chiefos_identity_map at redemption time. That downstream table
-- is empty at authoring time (see V8 Findings above), so employee linkage
-- cannot be recovered from the pre-rebuild data.
--
-- If production inspection at Phase 5 pre-cutover reveals chiefos_link_codes
-- with a different column shape (e.g., a phone column added in a later
-- migration), reopen this step with column names from the production shape.
-- Otherwise, employees must re-pair post-cutover via the R2.5 OTP flow.
-- ============================================================================

-- DO $step2$ BEGIN ... END $step2$;   -- (intentionally not authored)

-- ============================================================================
-- Step 3: Backfill from chiefos_identity_map — NOT APPLICABLE
--
-- V8 CONFIRMED: 0 rows in chiefos_identity_map at authoring time. No data
-- to migrate. The table's shape (tenant_id, kind, identifier) would support
-- backfill if rows existed; leaving a template below for completeness in
-- case production inspection at Phase 5 pre-cutover reveals populated rows.
-- Uncomment and verify before running.
-- ============================================================================

-- DO $step3$
-- DECLARE
--   updated_count int;
-- BEGIN
--   -- NOTE: chiefos_identity_map has no auth_user_id column — only
--   -- (tenant_id, kind, identifier). To recover auth linkage, join via
--   -- chiefos_user_identities (which carries user_id uuid = auth.uid()) on
--   -- matching (tenant_id, kind='whatsapp', identifier=phone_digits).
--   -- This path is only valid if BOTH tables have rows at cutover.
--   UPDATE public.users u
--      SET auth_user_id = ui.user_id
--     FROM public.chiefos_user_identities ui
--     JOIN public.chiefos_identity_map im
--       ON im.tenant_id = ui.tenant_id
--      AND im.kind       = ui.kind
--      AND im.identifier = ui.identifier
--    WHERE u.tenant_id = ui.tenant_id
--      AND u.user_id   = ui.identifier
--      AND ui.kind     = 'whatsapp'
--      AND u.auth_user_id IS NULL;
--
--   GET DIAGNOSTICS updated_count = ROW_COUNT;
--   RAISE NOTICE 'P1A-4 backfill step 3 (chiefos_identity_map ∩ user_identities): % rows updated', updated_count;
-- END
-- $step3$;

-- ============================================================================
-- Step 3b: Backfill from chiefos_user_identities alone — NOT APPLICABLE
--
-- V8 CONFIRMED: 0 rows at authoring time. If the identity_map JOIN above is
-- not usable but user_identities has rows in production at Phase 5 pre-cutover,
-- this simpler path can stand on its own. Uncomment and verify before running.
-- ============================================================================

-- DO $step3b$
-- DECLARE
--   updated_count int;
-- BEGIN
--   UPDATE public.users u
--      SET auth_user_id = ui.user_id
--     FROM public.chiefos_user_identities ui
--    WHERE u.tenant_id = ui.tenant_id
--      AND u.user_id   = ui.identifier
--      AND ui.kind     = 'whatsapp'
--      AND u.auth_user_id IS NULL;
--
--   GET DIAGNOSTICS updated_count = ROW_COUNT;
--   RAISE NOTICE 'P1A-4 backfill step 3b (chiefos_user_identities): % rows updated', updated_count;
-- END
-- $step3b$;

-- ============================================================================
-- Step 4: Post-backfill verification
-- ============================================================================
DO $verify$
DECLARE
  paired_total    int;
  owner_total     int;
  unpaired_owners int;
BEGIN
  SELECT COUNT(*) INTO paired_total
    FROM public.users WHERE auth_user_id IS NOT NULL;

  SELECT COUNT(*) INTO owner_total
    FROM public.users WHERE role = 'owner';

  SELECT COUNT(*) INTO unpaired_owners
    FROM public.users WHERE role = 'owner' AND auth_user_id IS NULL;

  RAISE NOTICE 'P1A-4 backfill complete:';
  RAISE NOTICE '  Total paired public.users rows: %', paired_total;
  RAISE NOTICE '  Total owner public.users rows : %', owner_total;
  RAISE NOTICE '  Unpaired owner rows (expected ~0 for active tenants): %', unpaired_owners;

  IF unpaired_owners > 0 THEN
    RAISE NOTICE 'INFO: % owner rows remain unpaired. Likely owners who never set up portal access; review manually.', unpaired_owners;
  END IF;
END
$verify$;

COMMIT;
