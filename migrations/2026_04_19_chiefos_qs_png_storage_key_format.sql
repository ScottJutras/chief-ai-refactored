-- ============================================================================
-- Migration 6: chiefos_quote_signatures.signature_png_storage_key format CHECK
-- ============================================================================
--
-- Adds fail-closed DB boundary enforcement for storage_key format per
-- docs/QUOTES_SPINE_DECISIONS.md §25.3 Tightening A.
--
-- Migration 4 shipped with a nonempty check (char_length > 0) but no format
-- check. This migration closes that gap: any bypass of the app-layer
-- buildSignatureStorageKey helper (direct SQL, future code path, migration
-- error) is now blocked at INSERT time, not deferred to a future read.
--
-- ── Regex byte-identity contract ───────────────────────────────────────────
--
-- The regex below MUST remain byte-identical to
-- SIGNATURE_STORAGE_KEY_RE.source in src/cil/quoteSignatureStorage.js.
-- Drift between these two regexes is a §25 violation.
--
-- See src/cil/quoteSignatureStorage.js for the app-layer regex definition
-- and the cross-reference comment pointing back at this migration.
--
-- Automated drift-detection test in src/cil/quoteSignatureStorage.test.js
-- reads this file and asserts byte-identity with SIGNATURE_STORAGE_KEY_RE.source.
--
-- ── Regex shape (for human review) ─────────────────────────────────────────
--   chiefos-signatures/{tenantId}/{quoteId}/{versionId}/{signatureId}.png
--   where each {id} is a lowercase canonical UUID (8-4-4-4-12, [0-9a-f]).
--   Total fixed length: 170 characters.
--
-- PostgreSQL's ~ operator uses ARE (Advanced Regular Expression) flavor,
-- which is a superset of POSIX ERE. Our regex uses only the intersection
-- of ARE and JS ECMAScript regex: ^, $, [char-class], {N}, \. — fully
-- portable. No escape translation required (standard_conforming_strings = on).
--
-- ============================================================================
-- Preflight: table + column must exist (fail loud if Migration 4 didn't run).
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'chiefos_quote_signatures'
      AND column_name = 'signature_png_storage_key'
  ) THEN
    RAISE EXCEPTION 'Preflight failed: chiefos_quote_signatures.signature_png_storage_key missing; Migration 4 required';
  END IF;

  -- Fail loud if constraint already exists. Catches accidental double-apply
  -- but means re-application requires manual DROP CONSTRAINT first.
  -- Alternative (idempotent no-op) was considered and rejected: silent no-op
  -- could mask a partial prior apply where schema is inconsistent with
  -- expectation.
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'chiefos_quote_signatures'
      AND constraint_name = 'chiefos_qs_png_storage_key_format'
  ) THEN
    RAISE EXCEPTION 'Preflight failed: chiefos_qs_png_storage_key_format already exists';
  END IF;
END
$$;

-- ============================================================================
-- Add format CHECK constraint.
-- ============================================================================
ALTER TABLE public.chiefos_quote_signatures
  ADD CONSTRAINT chiefos_qs_png_storage_key_format CHECK (
    signature_png_storage_key ~ '^chiefos-signatures/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$'
  );

COMMENT ON CONSTRAINT chiefos_qs_png_storage_key_format ON public.chiefos_quote_signatures IS
  'Format regex mirrors SIGNATURE_STORAGE_KEY_RE.source in src/cil/quoteSignatureStorage.js. Byte-identity is a §25.3 contract enforced by automated drift-detection test.';

-- ============================================================================
-- Rollback (emergency revert — not run as part of normal apply):
--   ALTER TABLE public.chiefos_quote_signatures
--     DROP CONSTRAINT chiefos_qs_png_storage_key_format;
-- ============================================================================
