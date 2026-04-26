-- ============================================================================
-- Phase A Session 5 — ReissueQuote prerequisite migration
--
-- Adds source_msg_id-based idempotency to chiefos_quote_versions and extends
-- the constitutional immutability trigger to cover supersession (a prior
-- version becomes immutable once chiefos_quotes.current_version_id no longer
-- points at it).
--
-- Rationale:
--   ReissueQuote (handleReissueQuote) creates a NEW chiefos_quote_versions
--   row on an existing voided quote header. The header's source_msg_id slot
--   was already consumed by CreateQuote and is constitutionally immutable
--   (trg_chiefos_quotes_guard_header_immutable, migration 2026_04_18). To
--   give ReissueQuote its own §17.8 entity-table dedup, we add source_msg_id
--   to the version row and a partial UNIQUE on (owner_id, source_msg_id).
--   Replays of the same Twilio sid land on the unique-violation path, the
--   handler catches, returns the prior reissuedReturnShape with
--   meta.already_existed = true.
--
-- Supersession immutability:
--   The pre-existing chiefos_quote_versions_guard_immutable trigger blocks
--   UPDATE/DELETE only when locked_at IS NOT NULL. That covers signed/locked
--   versions but NOT versions superseded from a draft/sent/viewed-then-voided
--   posture. After Reissue, prior unlocked versions must also be immutable
--   (constitutional rule: once a version is no longer current, it is part of
--   the audit chain and must not mutate). This migration extends the trigger
--   to additionally block UPDATE/DELETE when the version is no longer the
--   chiefos_quotes.current_version_id for its parent quote.
--
-- Migration discipline:
--   - Idempotent: every statement uses IF NOT EXISTS / OR REPLACE.
--   - Reversible: rollback script lives in migrations/rollbacks/.
--   - Additive: no destructive change to existing rows; new column is
--     nullable; partial UNIQUE only fires on non-null source_msg_id.
--   - source_msg_id immutability: fill-once (NULL→value via INSERT or first
--     UPDATE); subsequent UPDATEs with a different value are blocked. This
--     mirrors chiefos_quotes.source_msg_id discipline.
-- ============================================================================

BEGIN;

-- ── 1. source_msg_id column ────────────────────────────────────────────────
ALTER TABLE public.chiefos_quote_versions
  ADD COLUMN IF NOT EXISTS source_msg_id text;

COMMENT ON COLUMN public.chiefos_quote_versions.source_msg_id IS
  'Caller-supplied dedup key (typically a Twilio MessageSid for WhatsApp ingest, or a portal Idempotency-Key UUID). Fill-once via trg_chiefos_quote_versions_source_msg_immutable. Partial UNIQUE on (owner_id, source_msg_id) supports §17.8 entity-table dedup for ReissueQuote (and CreateQuote''s initial-version path; see handler.js for backfill posture).';

-- ── 2. Partial UNIQUE for §17.8 dedup ──────────────────────────────────────
-- Per Reading 1 (founder-approved 2026-04-25): no `kind` discriminator. The
-- source_msg_id space is per-message and globally unique by Twilio sid;
-- collision across kinds within an owner would be a webhook bug. Replays
-- safely surface the existing version via unique-violation handling in
-- handleReissueQuote.
CREATE UNIQUE INDEX IF NOT EXISTS chiefos_qv_source_msg_unique
  ON public.chiefos_quote_versions (owner_id, source_msg_id)
  WHERE source_msg_id IS NOT NULL;

-- ── 3. source_msg_id fill-once trigger ─────────────────────────────────────
-- Mirrors chiefos_quotes.source_msg_id immutability. Once written non-null,
-- cannot be cleared or changed. Allows initial NULL→value transition (so
-- existing rows can be backfilled by CreateQuote on the next write).
CREATE OR REPLACE FUNCTION public.chiefos_quote_versions_source_msg_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Permit NULL→value (one-time fill). Block value→different-value and
  -- value→NULL.
  IF OLD.source_msg_id IS NOT NULL
     AND NEW.source_msg_id IS DISTINCT FROM OLD.source_msg_id THEN
    RAISE EXCEPTION
      'chiefos_quote_versions.source_msg_id is fill-once (NULL->value); further changes forbidden'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_chiefos_qv_source_msg_immutable
  ON public.chiefos_quote_versions;

CREATE TRIGGER trg_chiefos_qv_source_msg_immutable
BEFORE UPDATE ON public.chiefos_quote_versions
FOR EACH ROW EXECUTE FUNCTION public.chiefos_quote_versions_source_msg_immutable();

-- ── 4. Extend immutability guard to cover supersession ─────────────────────
-- The existing chiefos_quote_versions_guard_immutable function (defined in
-- migration 2026_04_18_chiefos_quotes_spine.sql) blocks UPDATE/DELETE on
-- locked rows. We extend it to ALSO block UPDATE/DELETE when this version
-- is no longer the current_version_id of its parent quote — i.e., it has
-- been superseded by a later version (typically via ReissueQuote).
--
-- The supersession check uses chiefos_quotes.current_version_id as the
-- source of truth: if the header points at a different version, this row
-- is part of the audit chain and immutable.
--
-- Edge cases preserved:
--   - locked_at-based immutability still fires first (no behavior change for
--     signed/locked rows).
--   - Initial INSERT path is untouched (trigger is BEFORE UPDATE OR DELETE).
--   - Concurrent CreateQuote insert (current_version_id NULL transition)
--     is handled by the IS NULL check: if header.current_version_id IS NULL,
--     no version is current, and no version can be "superseded" — UPDATE
--     allowed (CreateQuote needs to UPDATE the header to point at v1; the
--     version row itself is INSERTed first and may receive snapshot
--     touch-ups in the same transaction).
CREATE OR REPLACE FUNCTION public.chiefos_quote_versions_guard_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_current_version_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Existing rule: locked rows are constitutionally immutable.
    IF OLD.locked_at IS NOT NULL THEN
      RAISE EXCEPTION
        'chiefos_quote_versions: row % is locked at %; updates are forbidden (constitutional immutability)',
        OLD.id, OLD.locked_at
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.locked_at IS NULL AND OLD.locked_at IS NOT NULL THEN
      RAISE EXCEPTION 'chiefos_quote_versions: locked_at cannot be cleared once set'
        USING ERRCODE = 'check_violation';
    END IF;

    -- Phase A Session 5: superseded versions are immutable.
    -- Detected via header pointer divergence: if the parent quote's
    -- current_version_id is not this row, this version is part of the
    -- audit chain.
    SELECT current_version_id INTO parent_current_version_id
      FROM public.chiefos_quotes
      WHERE id = OLD.quote_id;

    IF parent_current_version_id IS NOT NULL
       AND parent_current_version_id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION
        'chiefos_quote_versions: row % is superseded (parent current_version_id = %); updates are forbidden',
        OLD.id, parent_current_version_id
        USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.locked_at IS NOT NULL THEN
      RAISE EXCEPTION
        'chiefos_quote_versions: row % is locked at %; deletes are forbidden',
        OLD.id, OLD.locked_at
        USING ERRCODE = 'check_violation';
    END IF;

    -- Phase A Session 5: superseded versions cannot be deleted.
    SELECT current_version_id INTO parent_current_version_id
      FROM public.chiefos_quotes
      WHERE id = OLD.quote_id;

    IF parent_current_version_id IS NOT NULL
       AND parent_current_version_id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION
        'chiefos_quote_versions: row % is superseded (parent current_version_id = %); deletes are forbidden',
        OLD.id, parent_current_version_id
        USING ERRCODE = 'check_violation';
    END IF;

    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

-- Trigger definition unchanged (BEFORE UPDATE OR DELETE on
-- chiefos_quote_versions, FOR EACH ROW). Replacing the function body via
-- CREATE OR REPLACE FUNCTION above is sufficient — the trigger continues
-- to point at the new function body.

-- ── 5. Verify migration applied cleanly ────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'chiefos_quote_versions'
      AND column_name = 'source_msg_id'
  ) THEN
    RAISE EXCEPTION 'Migration verification failed: source_msg_id column missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'chiefos_quote_versions'
      AND indexname = 'chiefos_qv_source_msg_unique'
  ) THEN
    RAISE EXCEPTION 'Migration verification failed: chiefos_qv_source_msg_unique index missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_chiefos_qv_source_msg_immutable'
  ) THEN
    RAISE EXCEPTION 'Migration verification failed: trg_chiefos_qv_source_msg_immutable missing';
  END IF;
END $$;

COMMIT;
