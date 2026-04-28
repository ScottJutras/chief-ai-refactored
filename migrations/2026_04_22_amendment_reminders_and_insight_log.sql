-- Migration: 2026_04_22_amendment_reminders_and_insight_log.sql
--
-- PHASE 1 AMENDMENT (Session P1A-1) for Foundation Rebuild V2.
--
-- Gap sources:
--   Gap 1 (reminders) — Phase 4.5 classification; `services/reminders.js` is
--     live for task + lunch reminders. Phase 1 §6.1 marked the table DISCARD
--     with REVIEW stance; founder confirmed preserve.
--   Gap 4 (insight_log) — Phase 4.5 classification; `services/anomalyDetector.js`
--     writes here; portal dashboard reads + /api/alerts/dismiss mutates. Anomaly
--     detection is Beta-included per North Star §12.
--
-- Reason (both): close design-doc gaps that Phase 1's original DISCARD scope
-- over-shot. Rebuild needs these tables at cutover.
--
-- Authoritative reference: PHASE_4_5_DECISIONS_AND_HANDOFF.md §3 (schemas) + §8.
-- Design pattern: matches Phase 3 Session 3b supporting tables (similar complexity).
--
-- Standard Phase 3 patterns applied:
--   - tenant-membership RLS via chiefos_portal_users subquery (Principle 8)
--   - composite UNIQUE (id, tenant_id, owner_id) for FK target (Principle 11)
--   - partial UNIQUE (owner_id, source_msg_id) for idempotency (Principle 7) on reminders
--   - explicit GRANTs per Principle 9
--   - touch_updated_at trigger binding ADDED via P3-4a extension (flagged in session report)
--
-- Depends on: public.chiefos_tenants, public.chiefos_portal_users.
-- Apply-order: between P3-3b supporting tables (step 17) and P3-4a rebuild_functions
-- (step 18). Manifest updated accordingly.
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
END
$preflight$;

-- ============================================================================
-- 1. reminders — task + lunch reminders (Gap 1)
--
-- Cron (workers/reminder_dispatch.js) picks up due rows; handlers/commands/
-- tasks.js + handlers/commands/timeclock.js INSERT on task-due + shift-start.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.reminders (
  id               uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id         text         NOT NULL,
  user_id          text,
  kind             text         NOT NULL,
  due_at           timestamptz  NOT NULL,
  sent_at          timestamptz,
  cancelled_at     timestamptz,
  payload          jsonb        NOT NULL DEFAULT '{}'::jsonb,
  source_msg_id    text,
  correlation_id   uuid         NOT NULL DEFAULT gen_random_uuid(),
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT reminders_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT reminders_kind_chk
    CHECK (kind IN ('task','lunch','custom')),
  CONSTRAINT reminders_sent_cancel_exclusive
    CHECK (sent_at IS NULL OR cancelled_at IS NULL)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reminders_identity_unique'
      AND conrelid = 'public.reminders'::regclass
  ) THEN
    ALTER TABLE public.reminders
      ADD CONSTRAINT reminders_identity_unique UNIQUE (id, tenant_id, owner_id);
  END IF;
END $$;

-- Idempotency
CREATE UNIQUE INDEX IF NOT EXISTS reminders_owner_source_msg_unique_idx
  ON public.reminders (owner_id, source_msg_id)
  WHERE source_msg_id IS NOT NULL;

-- Cron due-now query
CREATE INDEX IF NOT EXISTS reminders_due_pending_idx
  ON public.reminders (tenant_id, due_at)
  WHERE sent_at IS NULL AND cancelled_at IS NULL;

-- Per-user upcoming
CREATE INDEX IF NOT EXISTS reminders_owner_user_due_idx
  ON public.reminders (owner_id, user_id, due_at)
  WHERE sent_at IS NULL AND cancelled_at IS NULL;

CREATE INDEX IF NOT EXISTS reminders_correlation_idx
  ON public.reminders (correlation_id);

ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='reminders'
                   AND policyname='reminders_tenant_select') THEN
    CREATE POLICY reminders_tenant_select
      ON public.reminders FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='reminders'
                   AND policyname='reminders_tenant_update') THEN
    CREATE POLICY reminders_tenant_update
      ON public.reminders FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

-- Reminders are system-created (handlers INSERT via service_role) and user-
-- cancellable (authenticated UPDATE to set cancelled_at). No INSERT policy for
-- authenticated — service_role bypasses RLS.
GRANT SELECT, UPDATE ON public.reminders TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reminders TO service_role;

COMMENT ON TABLE public.reminders IS
  'Task + lunch reminders (Gap 1 amendment). Created by services/reminders.js from tasks + timeclock handlers. Cron dispatcher (workers/reminder_dispatch.js) picks up due rows. service_role writes; authenticated can SELECT + UPDATE (cancel) own-tenant rows.';

-- ============================================================================
-- 2. insight_log — anomaly + pattern-signal log (Gap 4)
--
-- Written by services/anomalyDetector.js. Portal dashboard reads.
-- /api/alerts/dismiss marks acknowledged.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.insight_log (
  id                              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id                        text         NOT NULL,
  signal_kind                     text         NOT NULL,
  signal_key                      text         NOT NULL,
  severity                        text         NOT NULL,
  payload                         jsonb        NOT NULL DEFAULT '{}'::jsonb,
  created_at                      timestamptz  NOT NULL DEFAULT now(),
  acknowledged_at                 timestamptz,
  acknowledged_by_portal_user_id  uuid
    REFERENCES public.chiefos_portal_users(user_id) ON DELETE SET NULL,

  CONSTRAINT insight_log_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT insight_log_signal_kind_chk
    CHECK (signal_kind IN ('vendor_anomaly','category_spike','job_imbalance','custom')),
  CONSTRAINT insight_log_severity_chk
    CHECK (severity IN ('info','warn','critical')),
  CONSTRAINT insight_log_signal_key_nonempty CHECK (char_length(signal_key) > 0),
  CONSTRAINT insight_log_ack_pair
    CHECK ((acknowledged_at IS NULL AND acknowledged_by_portal_user_id IS NULL)
           OR acknowledged_at IS NOT NULL)
);

-- Prevent duplicate alerts for the same (tenant, kind, key).
-- e.g., signal_key = 'vendor:HOMEDEPOT:2026-04' means one alert per (Home Depot,
-- April 2026) per tenant regardless of how many anomaly-detector runs fire.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'insight_log_dedupe_unique'
      AND conrelid = 'public.insight_log'::regclass
  ) THEN
    ALTER TABLE public.insight_log
      ADD CONSTRAINT insight_log_dedupe_unique UNIQUE (tenant_id, signal_kind, signal_key);
  END IF;
END $$;

-- Composite identity UNIQUE (Principle 11) — FK target
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'insight_log_identity_unique'
      AND conrelid = 'public.insight_log'::regclass
  ) THEN
    ALTER TABLE public.insight_log
      ADD CONSTRAINT insight_log_identity_unique UNIQUE (id, tenant_id, owner_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS insight_log_tenant_created_idx
  ON public.insight_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS insight_log_unack_critical_idx
  ON public.insight_log (tenant_id, severity, created_at DESC)
  WHERE acknowledged_at IS NULL;

ALTER TABLE public.insight_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='insight_log'
                   AND policyname='insight_log_tenant_select') THEN
    CREATE POLICY insight_log_tenant_select
      ON public.insight_log FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  -- UPDATE allowed only to set acknowledged_at + acknowledged_by_portal_user_id.
  -- Other column edits blocked at app level; RLS allows UPDATE so authenticated
  -- can dismiss alerts via /api/alerts/dismiss. Hard append-only trigger is
  -- Session P3-4b scope (see manifest Forward Flag 11).
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='insight_log'
                   AND policyname='insight_log_tenant_update') THEN
    CREATE POLICY insight_log_tenant_update
      ON public.insight_log FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

-- Append-only via GRANT posture: authenticated can SELECT + UPDATE (dismiss)
-- but not INSERT or DELETE. service_role writes + reads + updates (cron).
GRANT SELECT, UPDATE ON public.insight_log TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.insight_log TO service_role;

COMMENT ON TABLE public.insight_log IS
  'Anomaly + pattern-signal log (Gap 4 amendment). Written by services/anomalyDetector.js. Dedupe via UNIQUE (tenant_id, signal_kind, signal_key). Append-only: service_role writes; authenticated SELECT + UPDATE-acknowledged only. Hard UPDATE-column-restriction trigger deferred to P3-4b.';

COMMIT;
