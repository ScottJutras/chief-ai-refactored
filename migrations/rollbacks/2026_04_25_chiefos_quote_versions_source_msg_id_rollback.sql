-- ============================================================================
-- Rollback for 2026_04_25_chiefos_quote_versions_source_msg_id.sql
--
-- Reverses:
--   1. Restores chiefos_quote_versions_guard_immutable to its pre-Session-5
--      body (locked-only immutability; no supersession check).
--   2. Drops trg_chiefos_qv_source_msg_immutable trigger + function.
--   3. Drops chiefos_qv_source_msg_unique partial UNIQUE index.
--   4. Drops source_msg_id column.
--
-- Safety: rollback is destructive of source_msg_id values written since
-- migration apply. Run only with explicit owner approval. If any
-- chiefos_quote_versions row has source_msg_id IS NOT NULL, those values
-- will be lost and any §17.8-dependent replay path that relied on dedup
-- will break for those rows.
-- ============================================================================

BEGIN;

-- ── 1. Restore pre-Session-5 immutability function body ────────────────────
CREATE OR REPLACE FUNCTION public.chiefos_quote_versions_guard_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
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
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.locked_at IS NOT NULL THEN
      RAISE EXCEPTION
        'chiefos_quote_versions: row % is locked at %; deletes are forbidden',
        OLD.id, OLD.locked_at
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

-- ── 2. Drop source_msg_id immutability trigger + function ──────────────────
DROP TRIGGER IF EXISTS trg_chiefos_qv_source_msg_immutable
  ON public.chiefos_quote_versions;
DROP FUNCTION IF EXISTS public.chiefos_quote_versions_source_msg_immutable();

-- ── 3. Drop partial UNIQUE index ───────────────────────────────────────────
DROP INDEX IF EXISTS public.chiefos_qv_source_msg_unique;

-- ── 4. Drop source_msg_id column ───────────────────────────────────────────
ALTER TABLE public.chiefos_quote_versions
  DROP COLUMN IF EXISTS source_msg_id;

COMMIT;
