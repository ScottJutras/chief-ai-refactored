-- ============================================================================
-- Foundation Rebuild — Session P3-4a, Part 2: Triggers
--
-- Section 5.3 of FOUNDATION_P1_SCHEMA_DESIGN.md.
--
-- Binds the 10 trigger functions (authored in rebuild_functions.sql) to
-- specific tables and events. Target met: 10 distinct trigger definitions,
-- with chiefos_touch_updated_at applied as a reusable binding across all
-- tables with an updated_at column ("one function, many bindings — not
-- counted as separate triggers" per §5.3).
--
-- Apply order requirement: rebuild_functions.sql MUST run before this file.
-- Verified by the preflight below — the functions must exist at CREATE TRIGGER
-- time or the statement fails.
--
-- Every binding uses DROP TRIGGER IF EXISTS before CREATE TRIGGER for
-- idempotency. Safe to re-run.
--
-- Trigger inventory:
--   1–6. Quotes spine immutability (6 tables, one trigger each)
--   7.  chiefos_activity_logs append-only
--   8.  transactions integrity chain (BEFORE INSERT)
--   9.  time_entries_v2 integrity chain (BEFORE INSERT)
--  10.  chiefos_touch_updated_at bindings (~26 tables with updated_at)
--
-- Tables with updated_at verified by scan of all rebuild CREATE TABLE blocks.
-- If a future migration adds updated_at to a new table, add its touch-trigger
-- binding in rebuild_policies_grants_final (P3-4b) or a follow-up migration.
-- ============================================================================

BEGIN;

-- Preflight: verify required trigger functions exist.
DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'chiefos_touch_updated_at') THEN
    RAISE EXCEPTION 'Requires public.chiefos_touch_updated_at (apply rebuild_functions first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'chiefos_integrity_chain_stamp') THEN
    RAISE EXCEPTION 'Requires public.chiefos_integrity_chain_stamp (apply rebuild_functions first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'chiefos_activity_logs_guard_immutable') THEN
    RAISE EXCEPTION 'Requires public.chiefos_activity_logs_guard_immutable (apply rebuild_functions first)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'chiefos_quotes_guard_header_immutable') THEN
    RAISE EXCEPTION 'Requires public.chiefos_quotes_guard_header_immutable (apply rebuild_functions first)';
  END IF;
END
$preflight$;

-- ============================================================================
-- Triggers 1–6: Quotes spine immutability
-- ============================================================================

-- 1. chiefos_quotes header immutability (BEFORE UPDATE — per original source)
DROP TRIGGER IF EXISTS trg_chiefos_quotes_guard_header_immutable ON public.chiefos_quotes;
CREATE TRIGGER trg_chiefos_quotes_guard_header_immutable
  BEFORE UPDATE ON public.chiefos_quotes
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_quotes_guard_header_immutable();

-- 2. chiefos_quote_versions locked-row immutability (BEFORE UPDATE OR DELETE)
DROP TRIGGER IF EXISTS trg_chiefos_quote_versions_guard_immutable ON public.chiefos_quote_versions;
CREATE TRIGGER trg_chiefos_quote_versions_guard_immutable
  BEFORE UPDATE OR DELETE ON public.chiefos_quote_versions
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_quote_versions_guard_immutable();

-- 3. chiefos_quote_line_items parent-lock guard (BEFORE INSERT OR UPDATE OR DELETE)
DROP TRIGGER IF EXISTS trg_chiefos_quote_line_items_guard_parent_lock ON public.chiefos_quote_line_items;
CREATE TRIGGER trg_chiefos_quote_line_items_guard_parent_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.chiefos_quote_line_items
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_quote_line_items_guard_parent_lock();

-- 4. chiefos_quote_share_tokens fill-once immutability (BEFORE UPDATE OR DELETE)
DROP TRIGGER IF EXISTS trg_chiefos_quote_share_tokens_guard_immutable ON public.chiefos_quote_share_tokens;
CREATE TRIGGER trg_chiefos_quote_share_tokens_guard_immutable
  BEFORE UPDATE OR DELETE ON public.chiefos_quote_share_tokens
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_quote_share_tokens_guard_immutable();

-- 5. chiefos_quote_signatures strict-immutable (BEFORE UPDATE OR DELETE)
DROP TRIGGER IF EXISTS trg_chiefos_quote_signatures_guard_immutable ON public.chiefos_quote_signatures;
CREATE TRIGGER trg_chiefos_quote_signatures_guard_immutable
  BEFORE UPDATE OR DELETE ON public.chiefos_quote_signatures
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_quote_signatures_guard_immutable();

-- 6. chiefos_quote_events append-only + fill-once (BEFORE UPDATE OR DELETE)
DROP TRIGGER IF EXISTS trg_chiefos_quote_events_guard_immutable ON public.chiefos_quote_events;
CREATE TRIGGER trg_chiefos_quote_events_guard_immutable
  BEFORE UPDATE OR DELETE ON public.chiefos_quote_events
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_quote_events_guard_immutable();

-- ============================================================================
-- Trigger 7: chiefos_activity_logs append-only
-- ============================================================================
DROP TRIGGER IF EXISTS trg_chiefos_activity_logs_guard_immutable ON public.chiefos_activity_logs;
CREATE TRIGGER trg_chiefos_activity_logs_guard_immutable
  BEFORE UPDATE OR DELETE ON public.chiefos_activity_logs
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_activity_logs_guard_immutable();

-- ============================================================================
-- Trigger 8: transactions integrity chain (BEFORE INSERT)
-- ============================================================================
DROP TRIGGER IF EXISTS trg_chiefos_transactions_integrity_chain ON public.transactions;
CREATE TRIGGER trg_chiefos_transactions_integrity_chain
  BEFORE INSERT ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_integrity_chain_stamp();

-- ============================================================================
-- Trigger 9: time_entries_v2 integrity chain (BEFORE INSERT)
-- ============================================================================
DROP TRIGGER IF EXISTS trg_chiefos_time_entries_v2_integrity_chain ON public.time_entries_v2;
CREATE TRIGGER trg_chiefos_time_entries_v2_integrity_chain
  BEFORE INSERT ON public.time_entries_v2
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_integrity_chain_stamp();

-- ============================================================================
-- Trigger 10: chiefos_touch_updated_at bindings (one function, many bindings)
--
-- Applied to every table with an updated_at column that defaults to now().
-- List derived by scanning all rebuild CREATE TABLE blocks for
-- "updated_at timestamptz NOT NULL DEFAULT now()".
-- ============================================================================

-- Session P3-1 tables
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.chiefos_tenants;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.chiefos_tenants
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.users;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.chiefos_legal_acceptances;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.chiefos_legal_acceptances
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.media_assets;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.media_assets
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.transactions;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

-- Session P3-2a tables
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.chiefos_tenant_counters;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.chiefos_tenant_counters
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.jobs;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.time_entries_v2;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.time_entries_v2
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.timesheet_locks;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.timesheet_locks
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.states;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.states
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.locks;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.locks
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.employer_policies;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.employer_policies
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.intake_batches;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.intake_batches
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.intake_items;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.intake_items
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.intake_item_drafts;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.intake_item_drafts
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

-- Session P3-2b — receipt pipeline
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.parse_jobs;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.parse_jobs
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.vendor_aliases;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.vendor_aliases
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

-- (Note: Quotes spine tables do NOT receive touch triggers. The spine is
-- immutable — versions/events/signatures/share_tokens have explicit
-- immutability guards. chiefos_quotes has its own header-immutability guard
-- that runs BEFORE UPDATE and would interact with updated_at stamping. The
-- quotes header's updated_at is not guaranteed in the CREATE TABLE but if
-- present, it would be managed via the explicit guard path, not the generic
-- touch function.)

-- Session P3-3a tables
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.pending_actions;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.pending_actions
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.cil_drafts;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.cil_drafts
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.conversation_sessions;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.conversation_sessions
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

-- Session P3-3b tables
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.customers;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.settings;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.settings
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.chiefos_crew_rates;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.chiefos_crew_rates
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.tasks;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.mileage_logs;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.mileage_logs
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.overhead_items;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.overhead_items
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

COMMIT;
