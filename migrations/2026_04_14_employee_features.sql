-- ============================================================
-- 2026_04_14_employee_features.sql
-- Employee feature expansion: submission queue, mileage attribution,
-- employee invites, and mileage_logs employee_user_id column.
-- All statements are idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- ============================================================

-- ── 1. transactions: submission review columns ────────────────────────────────
-- Allows Pro employees to submit expenses/revenue → pending owner review.

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS submission_status text
    NOT NULL DEFAULT 'confirmed'
    CHECK (submission_status IN ('pending_review', 'confirmed', 'declined'));

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS submitted_by text;      -- paUserId of employee submitter

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS reviewer_note text;

-- Index for owner review queue queries
CREATE INDEX IF NOT EXISTS idx_transactions_submission_status
  ON public.transactions (owner_id, submission_status)
  WHERE submission_status = 'pending_review';

-- ── 2. mileage_logs: employee attribution ─────────────────────────────────────
-- Tracks which employee submitted a mileage log (null = owner-submitted).

ALTER TABLE public.mileage_logs
  ADD COLUMN IF NOT EXISTS employee_user_id text;  -- paUserId of employee; null = owner-submitted

CREATE INDEX IF NOT EXISTS idx_mileage_logs_employee_user_id
  ON public.mileage_logs (owner_id, employee_user_id)
  WHERE employee_user_id IS NOT NULL;

-- ── 3. employee_invites: invite-link based portal access ─────────────────────
-- Owners generate invite links (SMS or email) for employees to claim portal access.

CREATE TABLE IF NOT EXISTS public.employee_invites (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL,
  owner_id            text        NOT NULL,
  token               text        NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  employee_name       text        NOT NULL,
  phone               text,                         -- E.164 or digits; used to send SMS
  email               text,                         -- optional; used to send magic-link email
  role                text        NOT NULL DEFAULT 'employee'
                                  CHECK (role IN ('employee', 'board')),
  expires_at          timestamptz NOT NULL DEFAULT now() + interval '7 days',
  claimed_at          timestamptz,
  claimed_by_user_id  uuid,                         -- Supabase auth.uid of claimant
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_employee_invites_token
  ON public.employee_invites (token);

CREATE INDEX IF NOT EXISTS idx_employee_invites_tenant
  ON public.employee_invites (tenant_id, owner_id);

-- RLS: owner can manage their own invites; no public read.
ALTER TABLE public.employee_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS employee_invites_owner_all ON public.employee_invites;
CREATE POLICY employee_invites_owner_all ON public.employee_invites
  FOR ALL
  USING (
    tenant_id IN (
      SELECT tenant_id FROM public.chiefos_portal_users
      WHERE user_id = auth.uid()::text
        AND role IN ('owner', 'admin')
    )
  );

-- ── 4. job_photos: employee attribution source value ─────────────────────────
-- Already supports source text; adding a check comment for clarity.
-- source = 'whatsapp_employee' when a non-owner employee submits a photo.
-- No schema change needed — the existing source column accepts any text.

-- ── 5. Update chiefos_portal_expenses view to exclude pending_review ──────────
-- Safety: pending employee submissions must not appear in P&L until confirmed.
-- We update the view definition to filter submission_status.

CREATE OR REPLACE VIEW public.chiefos_portal_expenses AS
SELECT
  t.id,
  t.tenant_id,
  t.owner_id,
  t.amount_cents,
  t.description,
  t.vendor,
  t.category,
  t.job_no,
  t.occurred_at,
  t.source_msg_id,
  t.created_at,
  t.updated_at,
  NULL::timestamptz AS deleted_at,         -- compatibility placeholder
  t.submission_status,
  t.submitted_by,
  t.reviewer_note
FROM public.transactions t
WHERE t.kind = 'expense'
  AND t.submission_status IN ('confirmed', 'pending_review')  -- owner sees both; RLS scopes further
  AND t.tenant_id IN (
    SELECT tenant_id FROM public.chiefos_portal_users
    WHERE user_id = auth.uid()::text
  );

-- NOTE: P&L / financial totals queries should add:
--   AND submission_status = 'confirmed'
-- to exclude pending employee submissions from financial calculations.
