-- Rollback for 2026_04_21_rebuild_conversation_spine.sql
-- Drops tables in reverse dependency order. Safe to re-run (IF EXISTS everywhere).

BEGIN;

-- conversation_messages (FKs to conversation_sessions)
DROP POLICY IF EXISTS conversation_messages_tenant_insert ON public.conversation_messages;
DROP POLICY IF EXISTS conversation_messages_tenant_select ON public.conversation_messages;

DROP INDEX IF EXISTS public.conversation_messages_correlation_idx;
DROP INDEX IF EXISTS public.conversation_messages_tenant_idx;
DROP INDEX IF EXISTS public.conversation_messages_session_idx;
DROP INDEX IF EXISTS public.conversation_messages_owner_source_msg_unique_idx;

DROP TABLE IF EXISTS public.conversation_messages;

-- conversation_sessions
DROP POLICY IF EXISTS conversation_sessions_tenant_update ON public.conversation_sessions;
DROP POLICY IF EXISTS conversation_sessions_tenant_insert ON public.conversation_sessions;
DROP POLICY IF EXISTS conversation_sessions_tenant_select ON public.conversation_sessions;

DROP INDEX IF EXISTS public.conversation_sessions_owner_active_idx;
DROP INDEX IF EXISTS public.conversation_sessions_tenant_idx;

DROP TABLE IF EXISTS public.conversation_sessions;

COMMIT;
