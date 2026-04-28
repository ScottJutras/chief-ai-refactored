-- ============================================================================
-- Foundation Rebuild — Session P3-3b, Part 1: tasks
--
-- Section 3.12 of FOUNDATION_P1_SCHEMA_DESIGN.md.
--
-- Creates:
--   1. tasks — MVP task management. One row per task.
--
-- Authoritative source: Execution Playbook §2 MVP item 7.
-- Task_no allocation: app-side via chiefos_tenant_counters UPSERT with
-- counter_kind = 'task'. No DB trigger; service_role insert path allocates.
--
-- Dependencies:
--   - public.chiefos_tenants (Session P3-1)
--   - public.chiefos_portal_users (Session P3-1)
--   - public.users (Session P3-1)
--   - public.jobs (Session P3-2a) — composite FK target
--   - public.chiefos_tenant_counters (Session P3-2a rebuild_jobs_spine) —
--     counter allocation target (app-side)
--
-- IMPORTANT design-drift note: design §3.12 specifies tasks.job_id as uuid,
-- but public.jobs.id is `serial` (integer) per §3.3 and Session P3-2a. Type
-- must match the FK target. This migration uses `job_id integer` to match
-- jobs.id. Flagged in SESSION_P3_3B_MIGRATION_REPORT.md as a design-doc
-- clarification item (design text vs. design table says integer).
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
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='users') THEN
    RAISE EXCEPTION 'Requires public.users (apply rebuild_identity_tenancy first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='jobs') THEN
    RAISE EXCEPTION 'Requires public.jobs (apply rebuild_jobs_spine first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_tenant_counters') THEN
    RAISE EXCEPTION 'Requires public.chiefos_tenant_counters (apply rebuild_jobs_spine first)';
  END IF;
END
$preflight$;

-- ============================================================================
-- tasks — MVP task management
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.tasks (
  id                              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id                        text         NOT NULL,
  task_no                         integer      NOT NULL,
  title                           text         NOT NULL,
  body                            text,
  status                          text         NOT NULL DEFAULT 'open',
  kind                            text         NOT NULL DEFAULT 'general',
  job_id                          integer,
  job_no                          integer,
  created_by_portal_user_id       uuid
    REFERENCES public.chiefos_portal_users(user_id) ON DELETE RESTRICT,
  created_by_user_id              text
    REFERENCES public.users(user_id) ON DELETE RESTRICT,
  assigned_to_portal_user_id      uuid
    REFERENCES public.chiefos_portal_users(user_id) ON DELETE RESTRICT,
  assigned_to_user_id             text
    REFERENCES public.users(user_id) ON DELETE RESTRICT,
  assignee_display_name           text,
  due_at                          timestamptz,
  completed_at                    timestamptz,
  completed_by_portal_user_id     uuid
    REFERENCES public.chiefos_portal_users(user_id) ON DELETE RESTRICT,
  completed_by_user_id            text
    REFERENCES public.users(user_id) ON DELETE RESTRICT,
  source                          text         NOT NULL DEFAULT 'portal',
  source_msg_id                   text,
  correlation_id                  uuid         NOT NULL DEFAULT gen_random_uuid(),
  deleted_at                      timestamptz,
  created_at                      timestamptz  NOT NULL DEFAULT now(),
  updated_at                      timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT tasks_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT tasks_title_length CHECK (char_length(title) BETWEEN 1 AND 280),
  CONSTRAINT tasks_task_no_positive CHECK (task_no > 0),
  CONSTRAINT tasks_status_chk
    CHECK (status IN ('open','in_progress','done','cancelled')),
  CONSTRAINT tasks_kind_chk
    CHECK (kind IN ('general','follow_up','review','reminder')),
  CONSTRAINT tasks_source_chk
    CHECK (source IN ('whatsapp','portal','system')),
  -- done iff completed_at set
  CONSTRAINT tasks_done_iff_completed
    CHECK ((status = 'done') = (completed_at IS NOT NULL)),
  -- attribution required (at least one creator)
  CONSTRAINT tasks_creator_present
    CHECK (created_by_portal_user_id IS NOT NULL OR created_by_user_id IS NOT NULL),
  -- Composite FK to jobs per Principle 11 (optional; all three cols null-friendly
  -- via MATCH SIMPLE — if job_id IS NULL, tenant/owner cols aren't checked).
  -- jobs.id is integer (see migration header note).
  CONSTRAINT tasks_job_identity_fk
    FOREIGN KEY (job_id, tenant_id, owner_id)
    REFERENCES public.jobs(id, tenant_id, owner_id)
    ON DELETE SET NULL
);

-- Per-tenant human-readable numbering
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tasks_tenant_task_no_unique'
      AND conrelid = 'public.tasks'::regclass
  ) THEN
    ALTER TABLE public.tasks
      ADD CONSTRAINT tasks_tenant_task_no_unique UNIQUE (tenant_id, task_no);
  END IF;
END $$;

-- Idempotency (Principle 7): partial UNIQUE on (owner_id, source_msg_id).
CREATE UNIQUE INDEX IF NOT EXISTS tasks_owner_source_msg_unique_idx
  ON public.tasks (owner_id, source_msg_id)
  WHERE source_msg_id IS NOT NULL;

-- Composite identity UNIQUE (Principle 11) — FK target for future references.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tasks_identity_unique'
      AND conrelid = 'public.tasks'::regclass
  ) THEN
    ALTER TABLE public.tasks
      ADD CONSTRAINT tasks_identity_unique UNIQUE (id, tenant_id, owner_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS tasks_tenant_status_idx
  ON public.tasks (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_assignee_due_idx
  ON public.tasks (tenant_id, assigned_to_portal_user_id, due_at)
  WHERE assigned_to_portal_user_id IS NOT NULL AND status <> 'done';
CREATE INDEX IF NOT EXISTS tasks_assignee_ingestion_idx
  ON public.tasks (owner_id, assigned_to_user_id, due_at)
  WHERE assigned_to_user_id IS NOT NULL AND status <> 'done';
CREATE INDEX IF NOT EXISTS tasks_job_idx
  ON public.tasks (tenant_id, job_id)
  WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_correlation_idx
  ON public.tasks (correlation_id);
CREATE INDEX IF NOT EXISTS tasks_deleted_idx
  ON public.tasks (tenant_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tasks'
                   AND policyname='tasks_tenant_select') THEN
    CREATE POLICY tasks_tenant_select
      ON public.tasks FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tasks'
                   AND policyname='tasks_tenant_insert') THEN
    CREATE POLICY tasks_tenant_insert
      ON public.tasks FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  -- UPDATE: owners/board can update any; employees can update only when
  -- they're the assignee. Design §3.12 tasks RLS tightening.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tasks'
                   AND policyname='tasks_tenant_update') THEN
    CREATE POLICY tasks_tenant_update
      ON public.tasks FOR UPDATE
      USING (
        tenant_id IN (
          SELECT tenant_id FROM public.chiefos_portal_users
          WHERE user_id = auth.uid()
            AND (role IN ('owner','board_member') OR assigned_to_portal_user_id = auth.uid())
        )
      )
      WITH CHECK (
        tenant_id IN (
          SELECT tenant_id FROM public.chiefos_portal_users
          WHERE user_id = auth.uid()
            AND (role IN ('owner','board_member') OR assigned_to_portal_user_id = auth.uid())
        )
      );
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.tasks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tasks TO service_role;

COMMENT ON TABLE public.tasks IS
  'MVP task management. One row per task. task_no allocated app-side via chiefos_tenant_counters UPSERT with counter_kind=''task''. Composite FK to jobs(id, tenant_id, owner_id) per Principle 11.';
COMMENT ON COLUMN public.tasks.task_no IS
  'Per-tenant sequential. Allocated at INSERT time via services/postgres.js::allocateNextDocCounter(tenant_id, ''task''). DB CHECK > 0 + UNIQUE (tenant_id, task_no).';
COMMENT ON COLUMN public.tasks.job_id IS
  'FK → jobs(id). Integer type matches jobs.id (design §3.3 serial PK). The composite FK (job_id, tenant_id, owner_id) uses MATCH SIMPLE so NULL job_id rows skip the check.';

COMMIT;
