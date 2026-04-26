-- Rollback for 2026_04_22_rebuild_functions.sql
-- Drops the 10 functions. Safe to re-run (IF EXISTS everywhere).
--
-- IMPORTANT: triggers that reference these functions must be dropped FIRST.
-- Run rebuild_triggers_rollback.sql before this file.

BEGIN;

DROP FUNCTION IF EXISTS public.chiefos_next_tenant_counter(uuid, text);
DROP FUNCTION IF EXISTS public.chiefos_integrity_chain_stamp();
DROP FUNCTION IF EXISTS public.chiefos_activity_logs_guard_immutable();
DROP FUNCTION IF EXISTS public.chiefos_quote_events_guard_immutable();
DROP FUNCTION IF EXISTS public.chiefos_quote_signatures_guard_immutable();
DROP FUNCTION IF EXISTS public.chiefos_quote_share_tokens_guard_immutable();
DROP FUNCTION IF EXISTS public.chiefos_quote_line_items_guard_parent_lock();
DROP FUNCTION IF EXISTS public.chiefos_quote_versions_guard_immutable();
DROP FUNCTION IF EXISTS public.chiefos_quotes_guard_header_immutable();
DROP FUNCTION IF EXISTS public.chiefos_touch_updated_at();

COMMIT;
