-- ============================================================================
-- Foundation Rebuild — Session P3-3a, Part 2: Conversation Spine (NEW)
--
-- Section 3.10 of FOUNDATION_P1_SCHEMA_DESIGN.md.
--
-- Creates:
--   1. conversation_sessions  — per-session conversational state for Ask Chief
--   2. conversation_messages  — per-message history with grounded_entities
--
-- Both tables are NEW in the rebuild (North Star §14 spec; no clean predecessor
-- in the pre-rebuild schema). The ad-hoc predecessors (assistant_events,
-- chief_actor_memory, convo_state) are DISCARDed per design §3.10.
--
-- entity_summary disposition: DISCARDed per design §3.10 default. active_entities
-- jsonb on conversation_sessions subsumes the entity-tracking role. A later
-- Phase 4 app-code audit may revisit (recorded in Session P3-3a report).
--
-- Dependencies:
--   - public.chiefos_tenants (Session P3-1)
--   - public.chiefos_portal_users (Session P3-1)
--
-- Triggers: none in this migration. Append-only enforcement for
-- conversation_messages is via GRANT posture (no UPDATE/DELETE to
-- authenticated; service_role retains full verbs for admin repair). A
-- hard-enforcing BEFORE UPDATE/DELETE trigger is deferred to Session P3-4
-- alongside the other append-only triggers (chiefos_activity_logs,
-- chiefos_role_audit, intake_item_reviews, quote-spine immutability triggers).
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
-- 1. conversation_sessions — per-session conversational state
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.conversation_sessions (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id          text         NOT NULL,
  user_id           text         NOT NULL,
  source            text         NOT NULL,
  started_at        timestamptz  NOT NULL DEFAULT now(),
  last_activity_at  timestamptz  NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  end_reason        text,
  active_entities   jsonb        NOT NULL DEFAULT '{}'::jsonb,
  trace_id          text         NOT NULL,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT conversation_sessions_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT conversation_sessions_user_id_nonempty CHECK (char_length(user_id) > 0),
  CONSTRAINT conversation_sessions_trace_id_nonempty CHECK (char_length(trace_id) > 0),
  CONSTRAINT conversation_sessions_source_chk
    CHECK (source IN ('whatsapp','portal')),
  CONSTRAINT conversation_sessions_end_reason_chk
    CHECK (end_reason IS NULL OR end_reason IN ('timeout','user_reset','context_limit')),
  CONSTRAINT conversation_sessions_end_reason_required_if_ended
    CHECK ((ended_at IS NULL) OR (end_reason IS NOT NULL)),
  CONSTRAINT conversation_sessions_activity_after_started
    CHECK (last_activity_at >= started_at)
);

-- Composite identity UNIQUE (Principle 11) — FK target for conversation_messages
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversation_sessions_identity_unique'
      AND conrelid = 'public.conversation_sessions'::regclass
  ) THEN
    ALTER TABLE public.conversation_sessions
      ADD CONSTRAINT conversation_sessions_identity_unique UNIQUE (id, tenant_id, owner_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS conversation_sessions_tenant_idx
  ON public.conversation_sessions (tenant_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS conversation_sessions_owner_active_idx
  ON public.conversation_sessions (owner_id, last_activity_at DESC)
  WHERE ended_at IS NULL;

ALTER TABLE public.conversation_sessions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='conversation_sessions'
                   AND policyname='conversation_sessions_tenant_select') THEN
    CREATE POLICY conversation_sessions_tenant_select
      ON public.conversation_sessions FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='conversation_sessions'
                   AND policyname='conversation_sessions_tenant_insert') THEN
    CREATE POLICY conversation_sessions_tenant_insert
      ON public.conversation_sessions FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='conversation_sessions'
                   AND policyname='conversation_sessions_tenant_update') THEN
    CREATE POLICY conversation_sessions_tenant_update
      ON public.conversation_sessions FOR UPDATE
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON public.conversation_sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversation_sessions TO service_role;

COMMENT ON TABLE public.conversation_sessions IS
  'Per-session conversational state for Ask Chief (North Star §14). One row per active session. Session = continuous conversation within a context window. Closes when inactivity exceeds TTL or user explicitly resets. active_entities jsonb subsumes the former entity_summary table.';
COMMENT ON COLUMN public.conversation_sessions.active_entities IS
  'Tracked entities for reference resolution ("active job", "date range", etc.) per North Star §14. Subsumes the DISCARDed entity_summary table.';

-- ============================================================================
-- 2. conversation_messages — per-message history
--
-- Append-only: authenticated gets SELECT + INSERT only. UPDATE/DELETE retained
-- for service_role (admin repair). Hard BEFORE UPDATE/DELETE trigger deferred
-- to Session P3-4 per append-only pattern.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.conversation_messages (
  id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          uuid         NOT NULL,
  tenant_id           uuid         NOT NULL
    REFERENCES public.chiefos_tenants(id) ON DELETE RESTRICT,
  owner_id            text         NOT NULL,
  sequence_no         integer      NOT NULL,
  role                text         NOT NULL,
  content             text         NOT NULL,
  tool_name           text,
  tool_input          jsonb,
  tool_output         jsonb,
  grounded_entities   jsonb        NOT NULL DEFAULT '[]'::jsonb,
  source_msg_id       text,
  provider            text,
  model               text,
  tokens_in           integer,
  tokens_out          integer,
  trace_id            text         NOT NULL,
  correlation_id      uuid         NOT NULL DEFAULT gen_random_uuid(),
  created_at          timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT conversation_messages_owner_id_nonempty CHECK (char_length(owner_id) > 0),
  CONSTRAINT conversation_messages_trace_id_nonempty CHECK (char_length(trace_id) > 0),
  CONSTRAINT conversation_messages_sequence_no_positive CHECK (sequence_no >= 1),
  CONSTRAINT conversation_messages_role_chk
    CHECK (role IN ('user','chief','system','tool')),
  -- tool rows must carry tool_name; non-tool rows must not.
  CONSTRAINT conversation_messages_tool_name_consistency CHECK (
    (role = 'tool' AND tool_name IS NOT NULL) OR
    (role <> 'tool' AND tool_name IS NULL)
  ),
  CONSTRAINT conversation_messages_tokens_in_nonneg CHECK (tokens_in IS NULL OR tokens_in >= 0),
  CONSTRAINT conversation_messages_tokens_out_nonneg CHECK (tokens_out IS NULL OR tokens_out >= 0),
  -- Composite FK to conversation_sessions (Principle 11).
  -- ON DELETE CASCADE: session deletion is rare (retention cleanup); when it
  -- happens, messages go with the session — a dangling message row without a
  -- session has no semantic meaning.
  CONSTRAINT conversation_messages_session_identity_fk
    FOREIGN KEY (session_id, tenant_id, owner_id)
    REFERENCES public.conversation_sessions(id, tenant_id, owner_id)
    ON DELETE CASCADE,
  -- Monotonic ordering within a session.
  CONSTRAINT conversation_messages_session_sequence_unique
    UNIQUE (session_id, sequence_no)
);

-- Idempotency: partial UNIQUE on (owner_id, source_msg_id) for user messages (Twilio/etc).
CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_owner_source_msg_unique_idx
  ON public.conversation_messages (owner_id, source_msg_id)
  WHERE source_msg_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS conversation_messages_session_idx
  ON public.conversation_messages (session_id, sequence_no);
CREATE INDEX IF NOT EXISTS conversation_messages_tenant_idx
  ON public.conversation_messages (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS conversation_messages_correlation_idx
  ON public.conversation_messages (correlation_id);

ALTER TABLE public.conversation_messages ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='conversation_messages'
                   AND policyname='conversation_messages_tenant_select') THEN
    CREATE POLICY conversation_messages_tenant_select
      ON public.conversation_messages FOR SELECT
      USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='conversation_messages'
                   AND policyname='conversation_messages_tenant_insert') THEN
    CREATE POLICY conversation_messages_tenant_insert
      ON public.conversation_messages FOR INSERT
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()));
  END IF;
END $$;

-- Append-only: authenticated gets SELECT + INSERT only. No UPDATE, no DELETE.
-- service_role retains full verbs for admin repair and retention cleanup.
GRANT SELECT, INSERT ON public.conversation_messages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversation_messages TO service_role;

COMMENT ON TABLE public.conversation_messages IS
  'Per-message history for a conversation session. Includes user messages, Chief responses, and tool invocations. grounded_entities references the domain rows Chief grounded each response in. Append-only for authenticated; hard BEFORE UPDATE/DELETE trigger deferred to Session P3-4.';
COMMENT ON COLUMN public.conversation_messages.sequence_no IS
  'Monotonic sequence within session (starts at 1). Allocated by the app-side message writer in session-order.';
COMMENT ON COLUMN public.conversation_messages.grounded_entities IS
  'Array of domain-row references Chief used in composing the response. Shape: [{"table":"jobs","id":"...","name":"..."}, ...]. Enables "drill into that expense" follow-ups.';
COMMENT ON COLUMN public.conversation_messages.correlation_id IS
  'Stable trace id per §17.21. Links the message row to related chiefos_activity_logs entries and cil_drafts.';

COMMIT;
