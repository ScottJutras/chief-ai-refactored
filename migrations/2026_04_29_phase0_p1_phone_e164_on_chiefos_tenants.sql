-- Migration: 2026_04_29_phase0_p1_phone_e164_on_chiefos_tenants.sql
--
-- PHASE 0 REMEDIATION (Blocker #1) for docs/specs/TMTS_v1.1.md §4 audit.
--
-- Adds canonical E.164-formatted phone storage to chiefos_tenants. Pre-rebuild
-- and post-rebuild signup paths derive owner_id by digit-stripping the original
-- phone string; the original E.164 form is never persisted, leaving the schema
-- unable to support reverse-lookup (owner_id → phone) needed for v1.1 §9
-- (WhatsApp inbound matching) and §16.2 (idempotent account creation /
-- anti-abuse).
--
-- This migration:
--   1. Adds nullable chiefos_tenants.phone_e164 (text) with E.164 CHECK.
--   2. Backfills existing tenants from owner_id (deterministic for NANP-11
--      format; pre-author introspection 2026-04-29 verified all 2 production
--      tenants are 11-digit NANP).
--   3. Adds partial UNIQUE INDEX (combines uniqueness + index in single object).
--      Defense-in-depth: chiefos_tenants_owner_id_unique already enforces
--      one-tenant-per-owner_id; phone_e164 uniqueness catches RPC bugs that
--      would violate the deterministic owner_id ↔ phone relationship.
--   4. Asserts backfill is all-or-nothing (no partial population).
--
-- Identity model (dual-boundary, never collapse):
--   - tenant_id (uuid)         portal/RLS boundary — UNCHANGED
--   - owner_id  (digits text)  ingestion/audit boundary — UNCHANGED
--   - phone_e164 (text)        ADDED storage of original phone format
--
-- phone_e164 is NOT a tenant-resolution mechanism. Per Engineering
-- Constitution §5: do not "create 'first tenant by phone' tenant resolution."
-- The owner_id (digits) remains the canonical resolution key. phone_e164 is
-- additive storage to support exact-format lookup, idempotent landing-page
-- form submission, and Twilio webhook matching where the inbound `From`
-- header arrives in E.164.
--
-- Reversible: see migrations/rollbacks/2026_04_29_phase0_p1_phone_e164_on_chiefos_tenants_rollback.sql
-- ============================================================================

BEGIN;

-- Preflight: ensure target table exists and the column does not already exist
DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_tenants') THEN
    RAISE EXCEPTION 'Requires public.chiefos_tenants (apply rebuild_identity_tenancy first)';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='chiefos_tenants'
               AND column_name='phone_e164') THEN
    RAISE EXCEPTION 'phone_e164 column already exists; migration is not idempotent across re-runs (CHECK + INDEX additions would conflict). Use rollback first if re-applying.';
  END IF;
END
$preflight$;

-- 1. Add nullable column with E.164 format CHECK.
--    Regex: '+' followed by country code (1-9) followed by 6-14 more digits.
--    Total digit count 7-15 matches E.164 spec.
ALTER TABLE public.chiefos_tenants
  ADD COLUMN phone_e164 TEXT;

ALTER TABLE public.chiefos_tenants
  ADD CONSTRAINT chiefos_tenants_phone_e164_format_chk
  CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9]\d{6,14}$');

-- 2. Backfill existing tenants from owner_id digits.
--    Pre-condition (verified 2026-04-29): all 2 production tenants have
--    11-digit NANP-format owner_ids. Deterministic '+' prefix produces
--    valid E.164 (+14165550100, +19053279955).
--    Conditional WHERE clause guards against any non-conforming owner_id
--    that might exist in dev/test environments — those rows skip backfill
--    and remain NULL (and the assertion below catches partial state).
UPDATE public.chiefos_tenants
   SET phone_e164 = '+' || owner_id
 WHERE phone_e164 IS NULL
   AND owner_id ~ '^[1-9]\d{6,14}$';

-- 3. Partial UNIQUE INDEX. Combined uniqueness + index in single DB object.
--    WHERE phone_e164 IS NOT NULL allows future tenants without phone (e.g.,
--    legacy fixtures or migrated-without-phone scenarios) without forcing
--    a sentinel value. Defense-in-depth anti-abuse mechanism per v1.1 §16.2.
CREATE UNIQUE INDEX chiefos_tenants_phone_e164_unique_idx
  ON public.chiefos_tenants (phone_e164)
  WHERE phone_e164 IS NOT NULL;

-- 4. Sanity assertion: backfill is all-or-nothing.
--    If any rows have non-conforming owner_id, the UPDATE skipped them and
--    we'd see a partial population state. Fail loudly; require manual review.
DO $assert$
DECLARE
  v_total int;
  v_populated int;
BEGIN
  SELECT COUNT(*), COUNT(phone_e164) INTO v_total, v_populated
    FROM public.chiefos_tenants;

  IF v_total > 0 AND v_populated <> v_total AND v_populated <> 0 THEN
    RAISE EXCEPTION
      'Backfill incomplete: % of % chiefos_tenants rows populated. Manual review required for non-NANP owner_ids.',
      v_populated, v_total;
  END IF;

  RAISE NOTICE 'phone_e164 backfill: % of % rows populated.', v_populated, v_total;
END
$assert$;

COMMENT ON COLUMN public.chiefos_tenants.phone_e164 IS
  'Owner''s primary phone in E.164 format (+ country code + national number). '
  'Source of truth for phone format. owner_id (digits-only derivation) remains '
  'the dual-boundary ingestion identity per Engineering Constitution §2; '
  'phone_e164 is additive storage for exact-format lookup, landing-page form '
  'idempotency, and Twilio webhook reverse-matching. Partial UNIQUE INDEX '
  'chiefos_tenants_phone_e164_unique_idx is the structural anti-abuse mechanism '
  'per docs/specs/TMTS_v1.1.md §16.2.';

COMMIT;
