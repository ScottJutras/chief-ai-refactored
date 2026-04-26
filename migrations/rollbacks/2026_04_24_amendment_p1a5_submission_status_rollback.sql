-- Rollback: 2026_04_24_amendment_p1a5_submission_status_rollback.sql
--
-- Reverses migrations/2026_04_24_amendment_p1a5_submission_status.sql.
-- Drops the partial indexes, CHECK constraints, then the columns themselves
-- on time_entries_v2 + tasks.
--
-- Order matters: indexes + constraints reference the column, so they drop
-- before the column. IF EXISTS guards make this re-runnable.
--
-- WARNING: rollback does NOT preserve any 'pending_review' / 'rejected' /
-- 'needs_clarification' state — those rows lose their workflow position. If
-- production has crew-submission rows mid-review at rollback time, that work
-- is lost. Acceptable because P1A-5 lands as part of the cold-start cutover
-- before any crew rows exist.
-- ============================================================================

BEGIN;

-- tasks
DROP INDEX IF EXISTS public.tasks_pending_review_idx;

ALTER TABLE IF EXISTS public.tasks
  DROP CONSTRAINT IF EXISTS tasks_submission_status_chk;

ALTER TABLE IF EXISTS public.tasks
  DROP COLUMN IF EXISTS submission_status;

-- time_entries_v2
DROP INDEX IF EXISTS public.time_entries_v2_pending_review_idx;

ALTER TABLE IF EXISTS public.time_entries_v2
  DROP CONSTRAINT IF EXISTS time_entries_v2_submission_status_chk;

ALTER TABLE IF EXISTS public.time_entries_v2
  DROP COLUMN IF EXISTS submission_status;

COMMIT;
