-- Rollback for 2026_04_22_rebuild_triggers.sql
-- Drops all trigger bindings. Safe to re-run (IF EXISTS everywhere).
-- Must run BEFORE rebuild_functions_rollback.sql (functions are referenced
-- by these triggers; dropping the function while a trigger still references
-- it would fail or CASCADE).

BEGIN;

-- Quotes spine immutability triggers
DROP TRIGGER IF EXISTS trg_chiefos_quote_events_guard_immutable ON public.chiefos_quote_events;
DROP TRIGGER IF EXISTS trg_chiefos_quote_signatures_guard_immutable ON public.chiefos_quote_signatures;
DROP TRIGGER IF EXISTS trg_chiefos_quote_share_tokens_guard_immutable ON public.chiefos_quote_share_tokens;
DROP TRIGGER IF EXISTS trg_chiefos_quote_line_items_guard_parent_lock ON public.chiefos_quote_line_items;
DROP TRIGGER IF EXISTS trg_chiefos_quote_versions_guard_immutable ON public.chiefos_quote_versions;
DROP TRIGGER IF EXISTS trg_chiefos_quotes_guard_header_immutable ON public.chiefos_quotes;

-- Activity log append-only
DROP TRIGGER IF EXISTS trg_chiefos_activity_logs_guard_immutable ON public.chiefos_activity_logs;

-- Integrity chain triggers
DROP TRIGGER IF EXISTS trg_chiefos_transactions_integrity_chain ON public.transactions;
DROP TRIGGER IF EXISTS trg_chiefos_time_entries_v2_integrity_chain ON public.time_entries_v2;

-- Touch-updated-at bindings (all tables that received one)
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.overhead_items;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.mileage_logs;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.tasks;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.chiefos_crew_rates;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.settings;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.customers;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.conversation_sessions;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.cil_drafts;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.pending_actions;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.vendor_aliases;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.parse_jobs;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.intake_item_drafts;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.intake_items;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.intake_batches;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.employer_policies;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.locks;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.states;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.timesheet_locks;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.time_entries_v2;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.jobs;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.chiefos_tenant_counters;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.transactions;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.media_assets;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.chiefos_legal_acceptances;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.users;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.chiefos_tenants;

COMMIT;
