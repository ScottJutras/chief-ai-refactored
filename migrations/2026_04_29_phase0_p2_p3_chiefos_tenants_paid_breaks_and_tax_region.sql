-- Migration: 2026_04_29_phase0_p2_p3_chiefos_tenants_paid_breaks_and_tax_region.sql
--
-- PHASE 0 REMEDIATION (Blockers #2 + #3) for docs/specs/TMTS_v1.1.md §4 audit.
--
-- BLOCKER #2 (CRITICAL): paid_breaks_policy field missing
--   Adds chiefos_tenants.paid_breaks_policy TEXT NOT NULL DEFAULT 'unpaid'
--   with CHECK constraint enforcing 'paid' | 'unpaid' enum.
--   Spec authority: v1.1 §14.2 onboarding wizard.
--   Default 'unpaid' is cost-conservative; wizard prompts user to confirm.
--
-- BLOCKER #3 (MEDIUM): tax_region consolidation
--   1. Drops dead chiefos_tenants.region column (verified 0 readers per recon).
--   2. Adds province format CHECK (^[A-Z]{2}$) mirroring existing country CHECK.
--   3. Sets province NOT NULL (existing 2 tenants both 'ON', verified compliant).
--   4. Adds tax_region as GENERATED ALWAYS AS (country || '-' || province) STORED.
--
-- DESIGN NOTE: tax_region (geographic identifier 'CA-ON') and tax_code
-- (tax-math regime 'HST_ON', 'GST_ONLY', etc.) are different concepts and
-- both columns are retained. The audit's framing "single tax_region replaces
-- 4 columns" was conceptually imprecise; this migration honors spec intent
-- (tax_region as queryable single field) without collapsing distinct concepts.
--
-- PRE-LAUNCH POSTURE: 2 wipeable test tenants. Existing data flows through
-- intact (both will receive tax_region='CA-ON' via generation; both will
-- receive paid_breaks_policy='unpaid' via DEFAULT). Wipe is a separate
-- scheduled step after Phase 0 verifies GREEN.
--
-- Reversible: see migrations/rollbacks/2026_04_29_phase0_p2_p3_chiefos_tenants_paid_breaks_and_tax_region_rollback.sql
-- ============================================================================

BEGIN;

-- Preflight assertions: validate state matches expectations before any DDL.
DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='chiefos_tenants'
  ) THEN
    RAISE EXCEPTION 'chiefos_tenants table missing — apply rebuild_identity_tenancy first';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='chiefos_tenants'
      AND column_name IN ('paid_breaks_policy','tax_region')
  ) THEN
    RAISE EXCEPTION 'paid_breaks_policy or tax_region already exists — migration already applied? Use rollback first if re-applying.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.chiefos_tenants WHERE province IS NULL) THEN
    RAISE EXCEPTION 'Some chiefos_tenants rows have NULL province — fix data before applying NOT NULL constraint';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.chiefos_tenants
    WHERE province IS NOT NULL AND province !~ '^[A-Z]{2}$'
  ) THEN
    RAISE EXCEPTION 'Some chiefos_tenants rows have invalid province format — manual cleanup required';
  END IF;
END
$preflight$;

-- 1. Add paid_breaks_policy (Blocker #2)
ALTER TABLE public.chiefos_tenants
  ADD COLUMN paid_breaks_policy TEXT NOT NULL DEFAULT 'unpaid'
    CHECK (paid_breaks_policy IN ('paid', 'unpaid'));

COMMENT ON COLUMN public.chiefos_tenants.paid_breaks_policy IS
  'Tenant-level wage policy: are short breaks paid time? '
  'Set during onboarding wizard per docs/specs/TMTS_v1.1.md §14.2. '
  'Binary: paid|unpaid. Default unpaid is cost-conservative pre-selection; '
  'wizard prompts user to confirm. Distinct from auto_lunch_deduct_minutes '
  '(separate concept). Consumed by timeclock paid-time calculation; current '
  'consumer code reads from employer_policies (P1B-employer-policies tracker).';

-- 2. Drop dead region column (Blocker #3)
ALTER TABLE public.chiefos_tenants DROP COLUMN region;

-- 3. Province format constraint (mirrors existing chiefos_tenants_country_chk)
ALTER TABLE public.chiefos_tenants
  ADD CONSTRAINT chiefos_tenants_province_format_chk
    CHECK (province ~ '^[A-Z]{2}$');

-- 4. Province NOT NULL (existing data verified compliant in preflight)
ALTER TABLE public.chiefos_tenants
  ALTER COLUMN province SET NOT NULL;

-- 5. Add tax_region as GENERATED column.
--    Single source of truth is country + province; tax_region is computed
--    deterministically with no drift possible.
ALTER TABLE public.chiefos_tenants
  ADD COLUMN tax_region TEXT
    GENERATED ALWAYS AS (country || '-' || province) STORED;

COMMENT ON COLUMN public.chiefos_tenants.tax_region IS
  'Geographic tax region in ISO-3166-2-style format (e.g., CA-ON). '
  'GENERATED ALWAYS AS (country || ''-'' || province) STORED — single source '
  'of truth is country + province; tax_region is computed deterministically. '
  'Distinct from tax_code (tax-math regime; HST_ON, GST_ONLY, etc.). '
  'North-America-scoped at v1.1 (2-letter province format); revisit if '
  'international expansion adds 3-letter subdivision codes.';

-- 6. Sanity assertion: post-migration shape verified
DO $assert$
DECLARE
  v_total int;
  v_paid_breaks_count int;
  v_tax_region_count int;
BEGIN
  SELECT COUNT(*) INTO v_total FROM public.chiefos_tenants;
  SELECT COUNT(paid_breaks_policy) INTO v_paid_breaks_count FROM public.chiefos_tenants;
  SELECT COUNT(tax_region) INTO v_tax_region_count FROM public.chiefos_tenants;

  IF v_total > 0 AND (v_paid_breaks_count <> v_total OR v_tax_region_count <> v_total) THEN
    RAISE EXCEPTION 'Post-migration population incomplete: total=%, paid_breaks=%, tax_region=%',
      v_total, v_paid_breaks_count, v_tax_region_count;
  END IF;

  RAISE NOTICE 'Phase 0 p2+p3: paid_breaks_policy + tax_region populated on % rows.', v_total;
END
$assert$;

COMMIT;
