-- Migration: 2026_04_24_amendment_p1a5_submission_status.sql
--
-- PHASE 1 AMENDMENT (Session P1A-5) for Foundation Rebuild V2.
--
-- Gap source: R3a §F2 / Option B — crew submission workflow needs pending-state
-- on canonical rows rather than a separate inbox table. `transactions` already
-- has its own `submission_status` (3-value: confirmed|pending_review|voided —
-- financial-row lifecycle); `time_entries_v2` and `tasks` lack the column.
-- This amendment adds a 4-value crew-review enum to those two tables so R3b
-- can migrate crew call sites to write canonical rows directly in
-- 'pending_review' state.
--
-- Tables in this file (2): time_entries_v2 (Session P3-2a), tasks (Session P3-3b).
--
-- Crew-cluster scope confirmation (P1A-5 V1, 2026-04-24):
--   Live crew files (routes/crewAdmin.js, routes/crewControl.js,
--   routes/crewReview.js, services/crewControl.js) currently INSERT only into
--   actor-cluster + audit-log tables. They do NOT write to canonical
--   time_entries_v2 / tasks today; that's R3b's call-site work. This amendment
--   prepares the schema so R3b can write canonical rows in pending state.
--
-- Why two separate enums (transactions vs time_entries_v2 + tasks)?
--   transactions ('confirmed','pending_review','voided') tracks financial-row
--   lifecycle — a row is either active, awaiting owner approval, or
--   soft-deleted. The crew-review enum
--   ('approved','pending_review','needs_clarification','rejected') tracks the
--   review workflow specifically — owner can approve, ask for clarification,
--   or reject a crew submission. Different domains; intentionally separate.
--   Both share the 'pending_review' value because the inbox query predicate is
--   the same shape across both clusters.
--
-- Default: 'approved' — preserves pre-rebuild semantics. Owner-logged rows
--   land approved automatically; R3b call-site migration will explicitly set
--   'pending_review' on crew-submitted rows at INSERT time.
--
-- No data migration needed: column add with NOT NULL DEFAULT fills existing
--   rows with 'approved'. Documented in PHASE_5_PRE_CUTOVER_CHECKLIST.md §4.
--
-- Dependencies:
--   - public.time_entries_v2 (Session P3-2a)
--   - public.tasks (Session P3-3b)
--
-- Apply-order: position 17l in REBUILD_MIGRATION_MANIFEST.md §3 — after P1A-4
--   (17k), before P3-4a rebuild_functions (step 18). Both target tables exist
--   by step 14 (tasks) so any position 14+ works; 17l groups with Phase 1
--   amendments.
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='time_entries_v2') THEN
    RAISE EXCEPTION 'Requires public.time_entries_v2 (apply rebuild_time_spine first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='tasks') THEN
    RAISE EXCEPTION 'Requires public.tasks (apply rebuild_tasks first)';
  END IF;
END
$preflight$;

-- ============================================================================
-- 1. time_entries_v2 — add submission_status (crew-review enum)
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='time_entries_v2'
      AND column_name='submission_status'
  ) THEN
    ALTER TABLE public.time_entries_v2
      ADD COLUMN submission_status text NOT NULL DEFAULT 'approved';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'time_entries_v2_submission_status_chk'
      AND conrelid = 'public.time_entries_v2'::regclass
  ) THEN
    ALTER TABLE public.time_entries_v2
      ADD CONSTRAINT time_entries_v2_submission_status_chk
      CHECK (submission_status IN ('approved','pending_review','needs_clarification','rejected'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS time_entries_v2_pending_review_idx
  ON public.time_entries_v2 (tenant_id, created_at DESC)
  WHERE submission_status IN ('pending_review','needs_clarification');

COMMENT ON COLUMN public.time_entries_v2.submission_status IS
  'Crew-review state (P1A-5 amendment). Default ''approved'' — owner-logged rows skip review. Crew-submitted rows are explicitly set to ''pending_review'' by R3b call-site code; owner transitions to ''approved'' / ''rejected'' / ''needs_clarification'' via crewReview.js handlers. Distinct from transactions.submission_status (3-value financial lifecycle); different domain, intentionally separate.';

-- ============================================================================
-- 2. tasks — add submission_status (crew-review enum)
--
-- Note: tasks already has `status` ('open','in_progress','done','cancelled')
-- tracking task lifecycle. submission_status is orthogonal — it tracks the
-- crew-submission review workflow, independent of whether the task is open or
-- done. A task can be submission_status='pending_review' AND status='open'
-- simultaneously (crew-created task awaiting owner approval to add to the
-- backlog).
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='tasks'
      AND column_name='submission_status'
  ) THEN
    ALTER TABLE public.tasks
      ADD COLUMN submission_status text NOT NULL DEFAULT 'approved';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tasks_submission_status_chk'
      AND conrelid = 'public.tasks'::regclass
  ) THEN
    ALTER TABLE public.tasks
      ADD CONSTRAINT tasks_submission_status_chk
      CHECK (submission_status IN ('approved','pending_review','needs_clarification','rejected'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS tasks_pending_review_idx
  ON public.tasks (tenant_id, created_at DESC)
  WHERE submission_status IN ('pending_review','needs_clarification');

COMMENT ON COLUMN public.tasks.submission_status IS
  'Crew-review state (P1A-5 amendment). Default ''approved'' — owner-created tasks skip review. Crew-created tasks are explicitly set to ''pending_review'' by R3b call-site code. Orthogonal to tasks.status (lifecycle: open/in_progress/done/cancelled).';

COMMIT;
