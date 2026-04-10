-- Phase 1 & 2 gap-closing migration
-- 1. overhead_items (recurring expenses schema — payments/reminders tables reference this)
-- 2. photo_phase column on job_photos (before/during/after)
-- 3. timesheet_approvals (employee submits, owner approves)

-- ── 1. overhead_items ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.overhead_items (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL,
  owner_id         text        NOT NULL,
  name             text        NOT NULL,
  frequency        text        NOT NULL DEFAULT 'monthly', -- monthly|weekly|quarterly|annual
  amount_cents     bigint      NOT NULL,
  tax_amount_cents bigint,
  category         text        NOT NULL DEFAULT 'Overhead',
  job_id           bigint      REFERENCES public.jobs(id) ON DELETE SET NULL,
  active           boolean     NOT NULL DEFAULT true,
  next_due_at      date,
  notes            text,
  source_msg_id    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, source_msg_id) WHERE source_msg_id IS NOT NULL
);
CREATE INDEX IF NOT EXISTS overhead_items_owner_idx  ON public.overhead_items (owner_id);
CREATE INDEX IF NOT EXISTS overhead_items_tenant_idx ON public.overhead_items (tenant_id);
CREATE INDEX IF NOT EXISTS overhead_items_due_idx    ON public.overhead_items (next_due_at) WHERE active = true;

ALTER TABLE public.overhead_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY overhead_items_tenant ON public.overhead_items FOR ALL
  USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));

-- ── 2. photo_phase on job_photos ───────────────────────────────────────────────
ALTER TABLE public.job_photos
  ADD COLUMN IF NOT EXISTS photo_phase text CHECK (photo_phase IN ('before','during','after'));

-- ── 3. timesheet_approvals ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.timesheet_approvals (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL,
  owner_id         text        NOT NULL,
  employee_name    text        NOT NULL,
  period_start     date        NOT NULL,
  period_end       date        NOT NULL,
  total_hours      numeric(8,2),
  total_cost_cents bigint,
  status           text        NOT NULL DEFAULT 'pending', -- pending|approved|rejected
  submitted_at     timestamptz NOT NULL DEFAULT now(),
  reviewed_at      timestamptz,
  reviewer_note    text,
  source_msg_id    text,
  UNIQUE (owner_id, employee_name, period_start, period_end)
);
CREATE INDEX IF NOT EXISTS timesheet_approvals_owner_idx  ON public.timesheet_approvals (owner_id, status);
CREATE INDEX IF NOT EXISTS timesheet_approvals_tenant_idx ON public.timesheet_approvals (tenant_id);

ALTER TABLE public.timesheet_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY timesheet_approvals_tenant ON public.timesheet_approvals FOR ALL
  USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
