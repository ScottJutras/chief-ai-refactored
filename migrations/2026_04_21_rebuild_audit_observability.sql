-- ============================================================================
-- Foundation Rebuild — Session P3-3a, Part 3: Audit / Observability
--
-- Section 3.11 of FOUNDATION_P1_SCHEMA_DESIGN.md.
--
-- Creates:
--   1. chiefos_activity_logs       — canonical per-action audit (REDESIGN per Decision 12)
--   2. chiefos_deletion_batches    — soft-delete undo batches (consolidates chiefos_txn_delete_batches)
--   3. email_ingest_events         — per-inbound-email audit (KEEP-WITH-REDESIGN)
--   4. integrity_verification_log  — chain verification runs on transactions + time_entries_v2
--   5. chiefos_role_audit          — role-change audit on chiefos_portal_users (REDESIGN per Decision 12)
--
-- DISCARDED per design (not created here):
--   - chiefos_activity_log_events  (flat log replaces parent/child split)
--   - chiefos_txn_delete_batches   (consolidated into chiefos_deletion_batches)
--
-- Actor FKs redesigned away from chiefos_actors (Decision 12):
--   - chiefos_activity_logs.portal_user_id → chiefos_portal_users(user_id) [uuid]
--   - chiefos_activity_logs.actor_user_id  → users(user_id) [text digit-string]
--   - chiefos_deletion_batches.portal_user_id → chiefos_portal_users(user_id)
--   - chiefos_role_audit.acted_by_portal_user_id → chiefos_portal_users(user_id)
--   - chiefos_role_audit.target_portal_user_id   → chiefos_portal_users(user_id)
--
-- Append-only tables (chiefos_activity_logs, chiefos_role_audit): GRANT posture
-- prevents UPDATE/DELETE from authenticated; BEFORE UPDATE/DELETE trigger
-- (hard-enforcing) is deferred to Session P3-4.
--
-- Dependencies:
--   - public.chiefos_tenants (Session P3-1)
--   - public.chiefos_portal_users (Session P3-1)
--   - public.users (Session P3-1)
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
END
$preflight$;

-- ============================================================================
-- 1. chiefos_activity_logs — canonical per-action audit
--
-- REDESIGN per Decision 12: actor cluster DISCARDed; dual FKs to
-- chiefos_portal_users (portal actions) and users (ingestion actions).
-- At least one actor must be present (CHECK).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.chiefos_activity_logs (
  id               uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id         text         NOT NULL,
  portal_user_id   uuid
    REFERENCES public.chiefos_portal_users(user_id) ON DELETE RESTRICT,
  actor_user_id    text
    REFERENCES public.users(user_id) ON DELETE RESTRICT,
  action_kind      text         NOT NULL,
  target_table     text         NOT NULL,
  target_id        text         NOT NULL,
  target_kind      text,
  payload          jsonb        NOT NULL DEFAULT '{}'::jsonb,
  trace_id         text         NOT NULL,
  correlation_id   uuid         NOT NULL,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT chiefos_activity_logs_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT chiefos_activity_logs_target_id_nonempty CHECK (char_length(target_id) > 0),
  CONSTRAINT chiefos_activity_logs_trace_id_nonempty CHECK (char_length(trace_id) > 0),
  CONSTRAINT chiefos_activity_logs_action_kind_chk
    CHECK (action_kind IN ('create','update','delete','confirm','void','reject','export','edit_confirm','reopen')),
  CONSTRAINT chiefos_activity_logs_target_table_format
    CHECK (target_table ~ '^[a-z][a-z_0-9]*$' AND char_length(target_table) BETWEEN 1 AND 64),
  -- At least one actor present. Principle: every audit row attributes to
  -- exactly one of (portal_user_id, actor_user_id) — typically the one that
  -- matches the initiating surface (portal UI → portal_user_id; WhatsApp →
  -- actor_user_id). System-initiated rows (cron, triggers) use service_role
  -- context; they may set actor_user_id to the owner's WhatsApp user_id as
  -- the representative actor, or route through a designated system-user row.
  CONSTRAINT chiefos_activity_logs_actor_present
    CHECK (portal_user_id IS NOT NULL OR actor_user_id IS NOT NULL)
);

-- Indexes per §3.11 design
CREATE INDEX IF NOT EXISTS chiefos_activity_logs_tenant_time_idx
  ON public.chiefos_activity_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS chiefos_activity_logs_target_idx
  ON public.chiefos_activity_logs (target_table, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS chiefos_activity_logs_correlation_idx
  ON public.chiefos_activity_logs (correlation_id);
CREATE INDEX IF NOT EXISTS chiefos_activity_logs_portal_user_idx
  ON public.chiefos_activity_logs (portal_user_id, created_at DESC)
  WHERE portal_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS chiefos_activity_logs_actor_user_idx
  ON public.chiefos_activity_logs (actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

ALTER TABLE public.chiefos_activity_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='chiefos_activity_logs'
                   AND policyname='chiefos_activity_logs_tenant_select') THEN
    CREATE POLICY chiefos_activity_logs_tenant_select
      ON public.chiefos_activity_logs FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
  -- No INSERT / UPDATE / DELETE policies for authenticated. Writes go through
  -- service_role code paths that validate action_kind + target_table against
  -- the app-registry. UPDATE/DELETE denied for authenticated entirely via
  -- GRANT + RLS; service_role retains INSERT only (append-only), with a hard
  -- BEFORE UPDATE/DELETE trigger coming in Session P3-4 as defense in depth.
END $$;

GRANT SELECT ON public.chiefos_activity_logs TO authenticated;
-- Append-only: service_role gets SELECT + INSERT, no UPDATE/DELETE.
GRANT SELECT, INSERT ON public.chiefos_activity_logs TO service_role;

COMMENT ON TABLE public.chiefos_activity_logs IS
  'Canonical audit log. One row per committed action on a canonical table. Attribution: portal_user_id (portal actions) or actor_user_id (ingestion actions). REDESIGN per Decision 12 — actor cluster DISCARDed. Append-only: enforcement is GRANT posture today + BEFORE UPDATE/DELETE trigger in Session P3-4.';
COMMENT ON COLUMN public.chiefos_activity_logs.portal_user_id IS
  'Portal auth user (chiefos_portal_users.user_id = auth.uid()). Set when the action originated from the portal UI. Mutually informative with actor_user_id; at least one is required.';
COMMENT ON COLUMN public.chiefos_activity_logs.actor_user_id IS
  'Ingestion user (users.user_id = WhatsApp digit-string). Set when the action originated from WhatsApp or another ingestion surface.';
COMMENT ON COLUMN public.chiefos_activity_logs.target_table IS
  'Canonical target. Format-regex enforced; product-concept registry in app-code (services/audit/activityLog.js).';
COMMENT ON COLUMN public.chiefos_activity_logs.correlation_id IS
  'Stable trace id per §17.21. Causal-chain reconstruction joins on this.';

-- ============================================================================
-- 2. chiefos_deletion_batches — soft-delete undo batches
--
-- Consolidates the pre-rebuild chiefos_txn_delete_batches (transaction-specific)
-- into a generic batches table via target_table discriminator.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.chiefos_deletion_batches (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id          text         NOT NULL,
  portal_user_id    uuid
    REFERENCES public.chiefos_portal_users(user_id) ON DELETE RESTRICT,
  target_table      text         NOT NULL,
  target_ids        text[]       NOT NULL,
  reason            text,
  undo_expires_at   timestamptz  NOT NULL,
  undone_at         timestamptz,
  correlation_id    uuid         NOT NULL,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT chiefos_deletion_batches_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT chiefos_deletion_batches_target_table_format
    CHECK (target_table ~ '^[a-z][a-z_0-9]*$' AND char_length(target_table) BETWEEN 1 AND 64),
  CONSTRAINT chiefos_deletion_batches_target_ids_nonempty
    CHECK (array_length(target_ids, 1) >= 1),
  CONSTRAINT chiefos_deletion_batches_undo_expires_after_created
    CHECK (undo_expires_at > created_at),
  CONSTRAINT chiefos_deletion_batches_undone_after_created
    CHECK (undone_at IS NULL OR undone_at >= created_at)
);

-- Composite identity UNIQUE (Principle 11) — FK target for activity-log linkage.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chiefos_deletion_batches_identity_unique'
      AND conrelid = 'public.chiefos_deletion_batches'::regclass
  ) THEN
    ALTER TABLE public.chiefos_deletion_batches
      ADD CONSTRAINT chiefos_deletion_batches_identity_unique UNIQUE (id, tenant_id, owner_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS chiefos_deletion_batches_tenant_created_idx
  ON public.chiefos_deletion_batches (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS chiefos_deletion_batches_undo_expiry_idx
  ON public.chiefos_deletion_batches (undo_expires_at)
  WHERE undone_at IS NULL;
CREATE INDEX IF NOT EXISTS chiefos_deletion_batches_correlation_idx
  ON public.chiefos_deletion_batches (correlation_id);

ALTER TABLE public.chiefos_deletion_batches ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='chiefos_deletion_batches'
                   AND policyname='chiefos_deletion_batches_tenant_select') THEN
    CREATE POLICY chiefos_deletion_batches_tenant_select
      ON public.chiefos_deletion_batches FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='chiefos_deletion_batches'
                   AND policyname='chiefos_deletion_batches_tenant_insert') THEN
    CREATE POLICY chiefos_deletion_batches_tenant_insert
      ON public.chiefos_deletion_batches FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='chiefos_deletion_batches'
                   AND policyname='chiefos_deletion_batches_tenant_update') THEN
    CREATE POLICY chiefos_deletion_batches_tenant_update
      ON public.chiefos_deletion_batches FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.chiefos_deletion_batches TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chiefos_deletion_batches TO service_role;

COMMENT ON TABLE public.chiefos_deletion_batches IS
  'Soft-delete undo batches. One batch covers a group of related soft-deletes that undo together. Consolidates the pre-rebuild chiefos_txn_delete_batches via the target_table discriminator.';
COMMENT ON COLUMN public.chiefos_deletion_batches.target_ids IS
  'Array of soft-deleted row PKs as text (uuid-string or bigint-string). Matches chiefos_activity_logs.target_id shape.';

-- ============================================================================
-- 3. email_ingest_events — per-inbound-email audit
--
-- KEEP-WITH-REDESIGN (minor): preserves existing column set; adds composite
-- UNIQUE (id, tenant_id, owner_id) for FK target; adds explicit GRANTs;
-- confirms tenant-scoped RLS. The UNIQUE (postmark_msg_id) idempotency
-- constraint is load-bearing.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.email_ingest_events (
  id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id            text         NOT NULL,
  postmark_msg_id     text         NOT NULL,
  from_email          text,
  subject             text,
  detected_kind       text         DEFAULT 'unknown',
  attachment_count    integer      DEFAULT 0,
  processing_status   text         DEFAULT 'received',
  source_type         text         DEFAULT 'forwarded_receipt',
  created_at          timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT email_ingest_events_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT email_ingest_events_postmark_msg_id_nonempty CHECK (char_length(postmark_msg_id) > 0),
  CONSTRAINT email_ingest_events_attachment_count_nonneg CHECK (attachment_count IS NULL OR attachment_count >= 0),
  CONSTRAINT email_ingest_events_processing_status_chk
    CHECK (processing_status IS NULL OR processing_status IN
           ('received','processing','completed','failed','ignored')),
  CONSTRAINT email_ingest_events_detected_kind_chk
    CHECK (detected_kind IS NULL OR detected_kind IN
           ('receipt_image','voice_note','pdf_document','email_lead','unknown')),
  CONSTRAINT email_ingest_events_source_type_chk
    CHECK (source_type IS NULL OR source_type IN
           ('forwarded_receipt','forwarded_lead','direct_reply','unknown'))
);

-- Idempotency: postmark_msg_id globally unique (one inbound email == one row)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'email_ingest_events_postmark_msg_unique'
      AND conrelid = 'public.email_ingest_events'::regclass
  ) THEN
    ALTER TABLE public.email_ingest_events
      ADD CONSTRAINT email_ingest_events_postmark_msg_unique UNIQUE (postmark_msg_id);
  END IF;
END $$;

-- Composite identity UNIQUE (Principle 11) — FK target for future references.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'email_ingest_events_identity_unique'
      AND conrelid = 'public.email_ingest_events'::regclass
  ) THEN
    ALTER TABLE public.email_ingest_events
      ADD CONSTRAINT email_ingest_events_identity_unique UNIQUE (id, tenant_id, owner_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS email_ingest_events_tenant_created_idx
  ON public.email_ingest_events (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS email_ingest_events_owner_created_idx
  ON public.email_ingest_events (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS email_ingest_events_processing_idx
  ON public.email_ingest_events (processing_status)
  WHERE processing_status IN ('received','processing','failed');

ALTER TABLE public.email_ingest_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='email_ingest_events'
                   AND policyname='email_ingest_events_tenant_select') THEN
    CREATE POLICY email_ingest_events_tenant_select
      ON public.email_ingest_events FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='email_ingest_events'
                   AND policyname='email_ingest_events_tenant_update') THEN
    CREATE POLICY email_ingest_events_tenant_update
      ON public.email_ingest_events FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

GRANT SELECT, UPDATE ON public.email_ingest_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_ingest_events TO service_role;

COMMENT ON TABLE public.email_ingest_events IS
  'Per-inbound-email audit. One row per webhook from Postmark. UNIQUE (postmark_msg_id) idempotency is load-bearing — the webhook retries safely. INSERT is service-role only (api/inbound/email.js); authenticated can SELECT + UPDATE processing_status from portal dashboards.';

-- ============================================================================
-- 4. integrity_verification_log — chain verification run results
--
-- Records results of integrity-chain verification runs on public.transactions
-- and public.time_entries_v2 (both carry the per-tenant record_hash chain per
-- Decision 10). KEEP-WITH-REDESIGN: schema tightened per §3.11 design.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.integrity_verification_log (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  chain             text         NOT NULL,
  started_at        timestamptz  NOT NULL,
  completed_at      timestamptz,
  rows_checked      bigint       NOT NULL DEFAULT 0,
  rows_failed       bigint       NOT NULL DEFAULT 0,
  result            text         NOT NULL,
  failure_details   jsonb,
  correlation_id    uuid         NOT NULL,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT integrity_verification_log_chain_chk
    CHECK (chain IN ('transactions','time_entries_v2')),
  CONSTRAINT integrity_verification_log_result_chk
    CHECK (result IN ('pass','fail','partial')),
  CONSTRAINT integrity_verification_log_rows_checked_nonneg CHECK (rows_checked >= 0),
  CONSTRAINT integrity_verification_log_rows_failed_nonneg CHECK (rows_failed >= 0),
  CONSTRAINT integrity_verification_log_completed_after_started
    CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE INDEX IF NOT EXISTS integrity_verification_log_tenant_created_idx
  ON public.integrity_verification_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS integrity_verification_log_failed_idx
  ON public.integrity_verification_log (tenant_id, chain, created_at DESC)
  WHERE result IN ('fail','partial');

ALTER TABLE public.integrity_verification_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='integrity_verification_log'
                   AND policyname='integrity_verification_log_tenant_select') THEN
    CREATE POLICY integrity_verification_log_tenant_select
      ON public.integrity_verification_log FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

GRANT SELECT ON public.integrity_verification_log TO authenticated;
GRANT SELECT, INSERT ON public.integrity_verification_log TO service_role;

COMMENT ON TABLE public.integrity_verification_log IS
  'Records of integrity-chain verification runs on public.transactions and public.time_entries_v2 (Decision 10). Written by services/audit/verifyIntegrity.js runs. Append-only: service_role gets SELECT+INSERT only.';

-- ============================================================================
-- 5. chiefos_role_audit — role-change audit on chiefos_portal_users
--
-- REDESIGN per Decision 12: actor FK moves from chiefos_actors to
-- chiefos_portal_users (both acted_by and target columns).
-- Append-only: GRANT posture + Session P3-4 trigger.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.chiefos_role_audit (
  id                          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id                    text         NOT NULL,
  acted_by_portal_user_id     uuid         NOT NULL
    REFERENCES public.chiefos_portal_users(user_id) ON DELETE RESTRICT,
  target_portal_user_id       uuid         NOT NULL
    REFERENCES public.chiefos_portal_users(user_id) ON DELETE RESTRICT,
  previous_role               text,
  new_role                    text,
  action                      text         NOT NULL,
  reason                      text,
  correlation_id              uuid         NOT NULL,
  created_at                  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT chiefos_role_audit_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT chiefos_role_audit_action_chk
    CHECK (action IN ('promote','demote','deactivate','reactivate'))
);

CREATE INDEX IF NOT EXISTS chiefos_role_audit_tenant_created_idx
  ON public.chiefos_role_audit (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS chiefos_role_audit_target_idx
  ON public.chiefos_role_audit (target_portal_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS chiefos_role_audit_correlation_idx
  ON public.chiefos_role_audit (correlation_id);

ALTER TABLE public.chiefos_role_audit ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Owner/board-member read only. Role audit is security-sensitive; rank-and-file
  -- employees should not see who promoted whom.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='chiefos_role_audit'
                   AND policyname='chiefos_role_audit_owner_select') THEN
    CREATE POLICY chiefos_role_audit_owner_select
      ON public.chiefos_role_audit FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users
                           WHERE user_id = auth.uid()
                             AND role IN ('owner','board_member')));
  END IF;
END $$;

-- Append-only: authenticated gets SELECT only (gated by the owner/board policy).
-- service_role gets SELECT + INSERT (no UPDATE/DELETE). Hard trigger Session P3-4.
GRANT SELECT ON public.chiefos_role_audit TO authenticated;
GRANT SELECT, INSERT ON public.chiefos_role_audit TO service_role;

COMMENT ON TABLE public.chiefos_role_audit IS
  'Per-role-change audit for chiefos_portal_users.role mutations. Security-sensitive — owner/board-member read only. Append-only: GRANT posture today + BEFORE UPDATE/DELETE trigger in Session P3-4.';
COMMENT ON COLUMN public.chiefos_role_audit.acted_by_portal_user_id IS
  'Which portal user performed the role change. Replaces the DISCARDed chiefos_actors FK per Decision 12.';
COMMENT ON COLUMN public.chiefos_role_audit.target_portal_user_id IS
  'Which portal user had their role changed.';

COMMIT;
