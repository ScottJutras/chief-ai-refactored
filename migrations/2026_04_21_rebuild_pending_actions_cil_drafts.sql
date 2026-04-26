-- ============================================================================
-- Foundation Rebuild — Session P3-3a, Part 1: Pending Actions / CIL Drafts
--
-- Section 3.9 of FOUNDATION_P1_SCHEMA_DESIGN.md.
--
-- Creates:
--   1. pending_actions — per-(owner, user, kind) TTL-bound confirm state
--   2. cil_drafts      — CIL payload staging between validation and commit
--
-- Both tables support Principle 5 (CIL enforcement) and Principle 7 (idempotency).
-- cil_drafts carries the composite UNIQUE (id, tenant_id, owner_id) per
-- Principle 11 to enable future cross-spine FK targeting.
--
-- Dependencies:
--   - public.chiefos_tenants (Session P3-1)
--   - public.chiefos_portal_users (Session P3-1) — referenced in RLS
--
-- Triggers: none in this migration. TTL cleanup runs via api/cron/cleanup_pending.js
-- (app-side; no DB trigger needed per design §3.9).
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
-- 1. pending_actions — TTL-bound confirm state
--
-- One active confirm per (owner, user, kind). 10-minute default TTL.
-- Replaces the pre-rebuild pending_actions which used custom JWT claim RLS.
-- Design §3.9 switches to standard tenant-membership RLS (Principle 8).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.pending_actions (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id     text         NOT NULL,
  user_id      text         NOT NULL,
  kind         text         NOT NULL,
  payload      jsonb        NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now(),
  expires_at   timestamptz  NOT NULL DEFAULT (now() + interval '10 minutes'),
  CONSTRAINT pending_actions_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT pending_actions_user_id_nonempty CHECK (char_length(user_id) > 0),
  -- Format-only CHECK on kind; product-concept whitelist lives in app-code registry
  -- (precedent: chiefos_tenant_counters.counter_kind per §18.4).
  CONSTRAINT pending_actions_kind_format_chk
    CHECK (kind ~ '^[a-z][a-z_]*$' AND char_length(kind) BETWEEN 1 AND 64),
  CONSTRAINT pending_actions_expires_after_created
    CHECK (expires_at > created_at)
);

-- One active confirm per actor per kind. Supersession = DELETE old then INSERT new
-- (both flow through the same service-role code path; see services/cil/pending.js).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pending_actions_owner_user_kind_unique'
      AND conrelid = 'public.pending_actions'::regclass
  ) THEN
    ALTER TABLE public.pending_actions
      ADD CONSTRAINT pending_actions_owner_user_kind_unique UNIQUE (owner_id, user_id, kind);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS pending_actions_tenant_expires_idx
  ON public.pending_actions (tenant_id, expires_at);
CREATE INDEX IF NOT EXISTS pending_actions_expires_cron_idx
  ON public.pending_actions (expires_at)
  WHERE expires_at IS NOT NULL;

ALTER TABLE public.pending_actions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='pending_actions'
                   AND policyname='pending_actions_tenant_select') THEN
    CREATE POLICY pending_actions_tenant_select
      ON public.pending_actions FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='pending_actions'
                   AND policyname='pending_actions_tenant_update') THEN
    CREATE POLICY pending_actions_tenant_update
      ON public.pending_actions FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

-- INSERT and DELETE are service-role only (handlers create pending actions and
-- TTL-cleanup deletes them). authenticated can SELECT its own tenant's rows
-- and UPDATE them (to expire or supersede via upsert). No explicit INSERT
-- policy; service_role bypasses RLS.
GRANT SELECT, INSERT, UPDATE ON public.pending_actions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pending_actions TO service_role;

COMMENT ON TABLE public.pending_actions IS
  'Per-(owner, user, kind) TTL-bound confirm state for CIL enforcement (Principle 5). 10-minute default TTL. One active confirm per actor per kind; supersession via DELETE+INSERT. Cleaned by api/cron/cleanup_pending.js.';
COMMENT ON COLUMN public.pending_actions.kind IS
  'Confirm kind discriminator. Format regex enforced in DB; product-concept whitelist in app-code registry (precedent: chiefos_tenant_counters.counter_kind).';

-- ============================================================================
-- 2. cil_drafts — CIL payload staging between validation and commit
--
-- One row per draft awaiting commit. Enables replay, audit, recovery after
-- handler crashes. committed_to_table / committed_to_id capture traceback to
-- the canonical row post-commit.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.cil_drafts (
  id                    uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id              text         NOT NULL,
  user_id               text         NOT NULL,
  cil_type              text         NOT NULL,
  payload               jsonb        NOT NULL,
  source_msg_id         text,
  validated_at          timestamptz,
  committed_at          timestamptz,
  committed_to_table    text,
  committed_to_id       text,
  trace_id              text         NOT NULL,
  correlation_id        uuid         NOT NULL DEFAULT gen_random_uuid(),
  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT cil_drafts_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT cil_drafts_user_id_nonempty CHECK (char_length(user_id) > 0),
  CONSTRAINT cil_drafts_trace_id_nonempty CHECK (char_length(trace_id) > 0),
  -- cil_type format CHECK; app-code registry (src/cil/cilTypes.js) is source of truth for values.
  -- Expected values include LogExpense, LogRevenue, CreateQuote, CreateInvoice, Clock, CreateTask, ChangeOrder, ...
  CONSTRAINT cil_drafts_cil_type_format_chk
    CHECK (cil_type ~ '^[A-Z][A-Za-z0-9]*$' AND char_length(cil_type) BETWEEN 1 AND 64),
  -- committed_at, committed_to_table, committed_to_id must be set/cleared together.
  CONSTRAINT cil_drafts_commit_pair CHECK (
    (committed_at IS NULL AND committed_to_table IS NULL AND committed_to_id IS NULL)
    OR (committed_at IS NOT NULL AND committed_to_table IS NOT NULL AND committed_to_id IS NOT NULL)
  ),
  -- target_table format when set.
  CONSTRAINT cil_drafts_committed_to_table_format CHECK (
    committed_to_table IS NULL OR committed_to_table ~ '^[a-z][a-z_0-9]*$'
  ),
  -- Validation must precede commit.
  CONSTRAINT cil_drafts_validate_before_commit CHECK (
    committed_at IS NULL OR validated_at IS NOT NULL
  )
);

-- Composite identity UNIQUE (Principle 11) — FK target for cross-spine references.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cil_drafts_identity_unique'
      AND conrelid = 'public.cil_drafts'::regclass
  ) THEN
    ALTER TABLE public.cil_drafts
      ADD CONSTRAINT cil_drafts_identity_unique UNIQUE (id, tenant_id, owner_id);
  END IF;
END $$;

-- Idempotency spine (Principle 7): partial UNIQUE on (owner_id, source_msg_id, cil_type)
-- where source_msg_id IS NOT NULL.
CREATE UNIQUE INDEX IF NOT EXISTS cil_drafts_owner_source_msg_unique_idx
  ON public.cil_drafts (owner_id, source_msg_id, cil_type)
  WHERE source_msg_id IS NOT NULL;

-- Indexes
CREATE INDEX IF NOT EXISTS cil_drafts_tenant_created_idx
  ON public.cil_drafts (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cil_drafts_owner_pending_idx
  ON public.cil_drafts (owner_id, created_at DESC)
  WHERE committed_at IS NULL;
CREATE INDEX IF NOT EXISTS cil_drafts_correlation_idx
  ON public.cil_drafts (correlation_id);
CREATE INDEX IF NOT EXISTS cil_drafts_committed_target_idx
  ON public.cil_drafts (committed_to_table, committed_to_id)
  WHERE committed_at IS NOT NULL;

ALTER TABLE public.cil_drafts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='cil_drafts'
                   AND policyname='cil_drafts_tenant_select') THEN
    CREATE POLICY cil_drafts_tenant_select
      ON public.cil_drafts FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='cil_drafts'
                   AND policyname='cil_drafts_tenant_insert') THEN
    CREATE POLICY cil_drafts_tenant_insert
      ON public.cil_drafts FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='cil_drafts'
                   AND policyname='cil_drafts_tenant_update') THEN
    CREATE POLICY cil_drafts_tenant_update
      ON public.cil_drafts FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.cil_drafts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cil_drafts TO service_role;

COMMENT ON TABLE public.cil_drafts IS
  'CIL payload staging between validation and domain mutation (Constitution §7). One row per draft awaiting commit. committed_to_table + committed_to_id capture traceback to the canonical row post-commit. Composite UNIQUE (id, tenant_id, owner_id) per Principle 11; idempotency via partial UNIQUE (owner_id, source_msg_id, cil_type).';
COMMENT ON COLUMN public.cil_drafts.cil_type IS
  'CIL type discriminator. Format CamelCase enforced in DB; product-concept registry in src/cil/cilTypes.js.';
COMMENT ON COLUMN public.cil_drafts.correlation_id IS
  'Stable trace id for cross-table correlation per §17.21. DEFAULT-assigned to a fresh uuid; callers may override to link to a broader trace.';

COMMIT;
