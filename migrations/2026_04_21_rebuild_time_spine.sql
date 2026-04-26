-- ============================================================================
-- Foundation Rebuild — Session 2a, Part 2: Time Spine
--
-- Creates (in order; all cold-start CREATE TABLE IF NOT EXISTS):
--   1. time_entries_v2          (canonical timeclock entries + integrity chain)
--   2. timeclock_prompts        (in-flight WhatsApp prompts)
--   3. timeclock_repair_prompts (repair prompts with FKs to time_entries_v2)
--   4. timesheet_locks          (period-lock markers; tenant_id added)
--   5. states                   (per-user WhatsApp conversational state)
--   6. locks                    (distributed lock table; duplicate column dropped)
--   7. employees                (employee records; tenant_id + role CHECK added)
--   8. employer_policies        (pay/break/drive/OT policy; owner_id type fixed)
--
-- Design source: FOUNDATION_P1_SCHEMA_DESIGN.md §3.4
--
-- Rebuild deltas vs. current live schema:
--   - time_entries_v2: tenant_id NOT NULL, job_id uuid→integer (matches jobs.id),
--     job_no denormalized added, kind CHECK tightened, integrity chain preserved,
--     composite UNIQUE (id, tenant_id, owner_id) for Principle 11 FK targets,
--     end-after-start CHECK added
--   - timeclock_repair_prompts: RLS enabled; entry_id/shift_id FKs to v2 added
--   - timesheet_locks: tenant_id NOT NULL added
--   - states: owner_id + tenant_id added (was user_id-only)
--   - locks: duplicate lock_key column dropped (only `key` retained)
--   - employees: tenant_id NOT NULL added; role CHECK added
--   - employer_policies: owner_id uuid→text (matches dual-boundary model); tenant_id NOT NULL added
--
-- DISCARDED (not in this migration, by §3.4 decision):
--   - time_entries (v1 legacy)
--   - timesheet_rollups  (founder-review-flagged; deferred pending Phase 2 audit)
--   - job_counters, task_counters, task_counters_user (folded into chiefos_tenant_counters)
--
-- Dependencies:
--   - public.chiefos_tenants (Session 1 rebuild_identity_tenancy)
--   - public.chiefos_portal_users (Session 1)
--   - public.jobs (Session 2a Part 1 rebuild_jobs_spine) — for time_entries_v2.job_id FK
--
-- Triggers deferred to Session 4 (author function + bind trigger):
--   - chiefos_time_entries_v2_integrity_chain_trigger (Decision 10)
--   - chiefos_touch_updated_at_trigger bindings on tables with updated_at
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
                 WHERE table_schema='public' AND table_name='jobs') THEN
    RAISE EXCEPTION 'Requires public.jobs (apply rebuild_jobs_spine first)';
  END IF;
END
$preflight$;

-- ============================================================================
-- 1. time_entries_v2 — canonical timeclock entries
--
-- Every clock-in/break/drive/clock-out event is one row. Segments compose into
-- shifts via parent_id. Integrity chain columns populated by the trigger
-- authored in Session 4 (same pattern as transactions).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.time_entries_v2 (
  id                       bigserial    PRIMARY KEY,
  tenant_id                uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id                 text         NOT NULL,
  user_id                  text         NOT NULL,
  job_id                   integer,
  job_no                   integer,
  parent_id                bigint,

  kind                     text         NOT NULL,
  start_at_utc             timestamptz  NOT NULL,
  end_at_utc               timestamptz,
  meta                     jsonb        NOT NULL DEFAULT '{}'::jsonb,

  -- Source attribution
  created_by               text,
  source_msg_id            text,
  import_batch_id          uuid,

  -- Integrity chain (Decision 10; trigger populates in Session 4)
  record_hash              text,
  previous_hash            text,
  hash_version             integer      NOT NULL DEFAULT 1,
  hash_input_snapshot      jsonb,

  -- Timestamps + soft-delete
  created_at               timestamptz  NOT NULL DEFAULT now(),
  updated_at               timestamptz  NOT NULL DEFAULT now(),
  deleted_at               timestamptz,

  -- CHECK constraints
  CONSTRAINT time_entries_v2_kind_chk
    CHECK (kind IN (
      'shift_start','shift_end',
      'break_start','break_end',
      'lunch_start','lunch_end',
      'drive_start','drive_end',
      'shift'
    )),
  CONSTRAINT time_entries_v2_owner_id_nonempty
    CHECK (char_length(owner_id) > 0),
  CONSTRAINT time_entries_v2_user_id_nonempty
    CHECK (char_length(user_id) > 0),
  CONSTRAINT time_entries_v2_end_after_start
    CHECK (end_at_utc IS NULL OR end_at_utc > start_at_utc),
  CONSTRAINT time_entries_v2_hash_version_positive
    CHECK (hash_version >= 1),
  CONSTRAINT time_entries_v2_record_hash_format
    CHECK (record_hash IS NULL OR record_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT time_entries_v2_previous_hash_format
    CHECK (previous_hash IS NULL OR previous_hash ~ '^[0-9a-f]{64}$')
);

-- Self-ref FK for shift assembly (parent_id → time_entries_v2.id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'time_entries_v2_parent_fk'
      AND conrelid = 'public.time_entries_v2'::regclass
  ) THEN
    ALTER TABLE public.time_entries_v2
      ADD CONSTRAINT time_entries_v2_parent_fk
      FOREIGN KEY (parent_id) REFERENCES public.time_entries_v2(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- FK to jobs (simple FK; job_id nullable — no-job entries are valid)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'time_entries_v2_job_fk'
      AND conrelid = 'public.time_entries_v2'::regclass
  ) THEN
    ALTER TABLE public.time_entries_v2
      ADD CONSTRAINT time_entries_v2_job_fk
      FOREIGN KEY (job_id) REFERENCES public.jobs(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- Idempotency spine (Principle 7)
CREATE UNIQUE INDEX IF NOT EXISTS time_entries_v2_owner_source_msg_unique_idx
  ON public.time_entries_v2 (owner_id, source_msg_id, kind)
  WHERE source_msg_id IS NOT NULL;

-- Integrity hash uniqueness (partial — hash NULL until Session 4 trigger)
CREATE UNIQUE INDEX IF NOT EXISTS time_entries_v2_record_hash_unique_idx
  ON public.time_entries_v2 (record_hash)
  WHERE record_hash IS NOT NULL;

-- Composite identity UNIQUE (Principle 11) — FK target for downstream tables
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'time_entries_v2_identity_unique'
      AND conrelid = 'public.time_entries_v2'::regclass
  ) THEN
    ALTER TABLE public.time_entries_v2
      ADD CONSTRAINT time_entries_v2_identity_unique UNIQUE (id, tenant_id, owner_id);
  END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS time_entries_v2_tenant_start_idx
  ON public.time_entries_v2 (tenant_id, start_at_utc DESC);
CREATE INDEX IF NOT EXISTS time_entries_v2_owner_user_idx
  ON public.time_entries_v2 (owner_id, user_id, start_at_utc DESC);
CREATE INDEX IF NOT EXISTS time_entries_v2_shift_children_idx
  ON public.time_entries_v2 (parent_id)
  WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS time_entries_v2_job_idx
  ON public.time_entries_v2 (job_id, start_at_utc)
  WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS time_entries_v2_deleted_idx
  ON public.time_entries_v2 (tenant_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;

ALTER TABLE public.time_entries_v2 ENABLE ROW LEVEL SECURITY;

-- Note: design §3.4 calls for "board-members read all; employees read own only"
-- per-employee scoping. That requires a WhatsApp-user_id ↔ portal-auth-user_id
-- mapping which isn't yet codified in chiefos_portal_users (user_id is uuid;
-- time_entries_v2.user_id is digit-string). Current policy uses the standard
-- tenant-membership read, matching the other spine tables. Per-employee scope
-- refinement is tracked as a Phase 4 policy-tightening item.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='time_entries_v2'
                   AND policyname='time_entries_v2_tenant_select') THEN
    CREATE POLICY time_entries_v2_tenant_select
      ON public.time_entries_v2 FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='time_entries_v2'
                   AND policyname='time_entries_v2_tenant_insert') THEN
    CREATE POLICY time_entries_v2_tenant_insert
      ON public.time_entries_v2 FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='time_entries_v2'
                   AND policyname='time_entries_v2_tenant_update') THEN
    CREATE POLICY time_entries_v2_tenant_update
      ON public.time_entries_v2 FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname='public' AND tablename='time_entries_v2'
                   AND policyname='time_entries_v2_owner_board_delete') THEN
    CREATE POLICY time_entries_v2_owner_board_delete
      ON public.time_entries_v2 FOR DELETE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                           WHERE user_id = auth.uid() AND role IN ('owner','board_member')));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.time_entries_v2 TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.time_entries_v2 TO service_role;

-- ============================================================================
-- 2. timeclock_prompts — in-flight WhatsApp prompts (24h TTL)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.timeclock_prompts (
  id              bigserial    PRIMARY KEY,
  owner_id        text         NOT NULL,
  employee_name   text         NOT NULL,
  kind            text         NOT NULL,
  context         jsonb        NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  expires_at      timestamptz  NOT NULL DEFAULT (now() + interval '24 hours'),
  CONSTRAINT timeclock_prompts_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT timeclock_prompts_employee_name_nonempty CHECK (char_length(employee_name) > 0)
);

CREATE INDEX IF NOT EXISTS timeclock_prompts_owner_employee_idx
  ON public.timeclock_prompts (owner_id, employee_name, created_at DESC);
CREATE INDEX IF NOT EXISTS timeclock_prompts_expires_idx
  ON public.timeclock_prompts (expires_at);

-- Backend-only (WhatsApp handler writes via service_role). No portal surface.
ALTER TABLE public.timeclock_prompts ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.timeclock_prompts TO service_role;

-- ============================================================================
-- 3. timeclock_repair_prompts — owner-initiated repair prompts
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.timeclock_repair_prompts (
  id              bigserial    PRIMARY KEY,
  owner_id        text         NOT NULL,
  user_id         text         NOT NULL,
  kind            text         NOT NULL,
  shift_id        bigint,
  entry_id        bigint,
  segment_kind    text         NOT NULL,
  ended_at_utc    timestamptz  NOT NULL,
  ended_reason    text,
  expires_at      timestamptz,
  source_msg_id   text,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT timeclock_repair_prompts_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT timeclock_repair_prompts_user_id_nonempty CHECK (char_length(user_id) > 0)
);

-- FKs to time_entries_v2 (added per §3.4 KEEP-WITH-REDESIGN)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'timeclock_repair_prompts_entry_fk'
      AND conrelid = 'public.timeclock_repair_prompts'::regclass
  ) THEN
    ALTER TABLE public.timeclock_repair_prompts
      ADD CONSTRAINT timeclock_repair_prompts_entry_fk
      FOREIGN KEY (entry_id) REFERENCES public.time_entries_v2(id)
      ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'timeclock_repair_prompts_shift_fk'
      AND conrelid = 'public.timeclock_repair_prompts'::regclass
  ) THEN
    ALTER TABLE public.timeclock_repair_prompts
      ADD CONSTRAINT timeclock_repair_prompts_shift_fk
      FOREIGN KEY (shift_id) REFERENCES public.time_entries_v2(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS timeclock_repair_prompts_owner_user_idx
  ON public.timeclock_repair_prompts (owner_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS timeclock_repair_prompts_expires_idx
  ON public.timeclock_repair_prompts (expires_at)
  WHERE expires_at IS NOT NULL;

ALTER TABLE public.timeclock_repair_prompts ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.timeclock_repair_prompts TO service_role;

-- ============================================================================
-- 4. timesheet_locks — period-lock markers (tenant_id added per design)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.timesheet_locks (
  id              bigserial    PRIMARY KEY,
  tenant_id       uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id        text         NOT NULL,
  employee_name   text         NOT NULL,
  start_date      date         NOT NULL,
  end_date        date         NOT NULL,
  status          text         NOT NULL,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT timesheet_locks_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT timesheet_locks_status_chk
    CHECK (status IN ('locked','pending','released')),
  CONSTRAINT timesheet_locks_end_after_start
    CHECK (end_date >= start_date)
);

CREATE UNIQUE INDEX IF NOT EXISTS timesheet_locks_employee_period_unique_idx
  ON public.timesheet_locks (tenant_id, employee_name, start_date, end_date);
CREATE INDEX IF NOT EXISTS timesheet_locks_owner_idx
  ON public.timesheet_locks (owner_id, start_date DESC);

ALTER TABLE public.timesheet_locks ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='timesheet_locks'
                   AND policyname='timesheet_locks_tenant_select') THEN
    CREATE POLICY timesheet_locks_tenant_select
      ON public.timesheet_locks FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

GRANT SELECT ON public.timesheet_locks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.timesheet_locks TO service_role;

-- ============================================================================
-- 5. states — per-user WhatsApp conversational state
--
-- Design §3.4 adds owner_id + tenant_id for tenant-boundary coherence. The
-- WhatsApp handler resolves both before writing. user_id is the PK (one state
-- row per user), consistent with current shape.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.states (
  user_id      text         PRIMARY KEY,
  owner_id     text         NOT NULL,
  tenant_id    uuid
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  state        jsonb        NOT NULL DEFAULT '{}'::jsonb,
  data         jsonb        NOT NULL DEFAULT '{}'::jsonb,
  updated_at   timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT states_user_id_nonempty CHECK (char_length(user_id) > 0),
  CONSTRAINT states_owner_id_nonempty CHECK (char_length(owner_id) > 0)
);

CREATE INDEX IF NOT EXISTS states_owner_idx
  ON public.states (owner_id);
CREATE INDEX IF NOT EXISTS states_tenant_idx
  ON public.states (tenant_id)
  WHERE tenant_id IS NOT NULL;

-- Backend-only — the WhatsApp handler writes via service_role. RLS on for
-- defense in depth; no authenticated policies (portal does not read state).
ALTER TABLE public.states ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.states TO service_role;

-- ============================================================================
-- 6. locks — distributed lock table (duplicate lock_key column dropped per §3.4)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.locks (
  key          text         PRIMARY KEY,
  holder       text,
  expires_at   timestamptz  NOT NULL,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT locks_key_nonempty CHECK (char_length(key) > 0)
);

CREATE INDEX IF NOT EXISTS locks_expires_idx
  ON public.locks (expires_at);

-- Backend-only concurrency coordination. RLS on, service_role only.
ALTER TABLE public.locks ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.locks TO service_role;

-- ============================================================================
-- 7. employees — employee records (tenant_id + role CHECK added per §3.4)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.employees (
  id              serial       PRIMARY KEY,
  tenant_id       uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id        text         NOT NULL,
  name            text         NOT NULL,
  role            text         NOT NULL DEFAULT 'employee',
  phone           text,
  active          boolean      NOT NULL DEFAULT true,
  source_msg_id   text,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT employees_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT employees_name_nonempty CHECK (char_length(name) > 0),
  CONSTRAINT employees_role_chk
    CHECK (role IN ('owner','employee','contractor','board_member'))
);

CREATE INDEX IF NOT EXISTS employees_tenant_active_idx
  ON public.employees (tenant_id, active);
CREATE INDEX IF NOT EXISTS employees_owner_active_idx
  ON public.employees (owner_id, active);
CREATE UNIQUE INDEX IF NOT EXISTS employees_owner_name_unique_idx
  ON public.employees (owner_id, lower(name))
  WHERE active = true;

ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='employees'
                   AND policyname='employees_tenant_select') THEN
    CREATE POLICY employees_tenant_select
      ON public.employees FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='employees'
                   AND policyname='employees_owner_insert') THEN
    CREATE POLICY employees_owner_insert
      ON public.employees FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                                WHERE user_id = auth.uid() AND role IN ('owner','board_member')));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='employees'
                   AND policyname='employees_owner_update') THEN
    CREATE POLICY employees_owner_update
      ON public.employees FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                           WHERE user_id = auth.uid() AND role IN ('owner','board_member')))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                                WHERE user_id = auth.uid() AND role IN ('owner','board_member')));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.employees TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employees TO service_role;

-- ============================================================================
-- 8. employer_policies — per-owner pay/break/drive/OT policy
--
-- §3.4 fix: owner_id type uuid→text (matches dual-boundary model). tenant_id
-- added NOT NULL. One row per owner (PK on owner_id retained logically).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.employer_policies (
  tenant_id           uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id            text         NOT NULL,
  jurisdiction        text         DEFAULT 'CA-ON',
  paid_break_minutes  integer      NOT NULL DEFAULT 30,
  lunch_paid          boolean      NOT NULL DEFAULT true,
  paid_lunch_minutes  integer      NOT NULL DEFAULT 30,
  drive_is_paid       boolean      NOT NULL DEFAULT true,
  overtime_mode       text         NOT NULL DEFAULT 'weekly',
  daily_ot_minutes    integer      NOT NULL DEFAULT 480,
  weekly_ot_minutes   integer      NOT NULL DEFAULT 2640,
  source_date         date,
  sources             jsonb,
  updated_at          timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT employer_policies_pkey PRIMARY KEY (owner_id),
  CONSTRAINT employer_policies_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT employer_policies_overtime_mode_chk
    CHECK (overtime_mode IN ('weekly','daily','none')),
  CONSTRAINT employer_policies_paid_break_minutes_nonneg CHECK (paid_break_minutes >= 0),
  CONSTRAINT employer_policies_paid_lunch_minutes_nonneg CHECK (paid_lunch_minutes >= 0),
  CONSTRAINT employer_policies_daily_ot_minutes_positive CHECK (daily_ot_minutes > 0),
  CONSTRAINT employer_policies_weekly_ot_minutes_positive CHECK (weekly_ot_minutes > 0)
);

CREATE INDEX IF NOT EXISTS employer_policies_tenant_idx
  ON public.employer_policies (tenant_id);

ALTER TABLE public.employer_policies ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='employer_policies'
                   AND policyname='employer_policies_tenant_select') THEN
    CREATE POLICY employer_policies_tenant_select
      ON public.employer_policies FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='employer_policies'
                   AND policyname='employer_policies_owner_upsert') THEN
    CREATE POLICY employer_policies_owner_upsert
      ON public.employer_policies FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                                WHERE user_id = auth.uid() AND role IN ('owner','board_member')));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='employer_policies'
                   AND policyname='employer_policies_owner_update') THEN
    CREATE POLICY employer_policies_owner_update
      ON public.employer_policies FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                           WHERE user_id = auth.uid() AND role IN ('owner','board_member')))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                                WHERE user_id = auth.uid() AND role IN ('owner','board_member')));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.employer_policies TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employer_policies TO service_role;

-- ============================================================================
-- Comments
-- ============================================================================
COMMENT ON TABLE public.time_entries_v2 IS
  'Canonical timeclock entries. One row per clock-in/break/drive/clock-out event. Segments compose into shifts via parent_id. Integrity chain columns populated by chiefos_time_entries_v2_integrity_chain_trigger (authored Session 4).';
COMMENT ON COLUMN public.time_entries_v2.job_id IS
  'FK to jobs(id). Resolved from prior uuid drift (design §3.4) — type now integer to match jobs.id.';
COMMENT ON COLUMN public.time_entries_v2.record_hash IS
  'SHA-256 of canonical serialization of this row + previous_hash of prior row in same tenant chain. Populated by integrity-chain trigger (Session 4).';

COMMENT ON TABLE public.timeclock_prompts IS
  'In-flight prompts the WhatsApp handler has sent but not yet received a response for. 24h TTL. Backend-only (service_role).';
COMMENT ON TABLE public.timeclock_repair_prompts IS
  'Owner-initiated repair prompts for mismatched clock events. FKs to time_entries_v2 added in rebuild (§3.4). Backend-only (service_role).';
COMMENT ON TABLE public.timesheet_locks IS
  'Period-lock markers preventing edits to closed pay periods. One row per (tenant, employee, date range). tenant_id NOT NULL added in rebuild.';
COMMENT ON TABLE public.states IS
  'Per-user WhatsApp conversational state. Backend-only (service_role). owner_id + tenant_id added in rebuild for dual-boundary coherence.';
COMMENT ON TABLE public.locks IS
  'Distributed lock table for WhatsApp handler single-flight coordination. Backend-only (service_role). Duplicate lock_key column dropped in rebuild.';
COMMENT ON TABLE public.employees IS
  'Employee records. One row per employee of an owner''s business. tenant_id + role CHECK added in rebuild.';
COMMENT ON TABLE public.employer_policies IS
  'Per-owner pay/break/drive/overtime policy. One row per owner. owner_id type fixed uuid→text; tenant_id NOT NULL added in rebuild.';

COMMIT;
