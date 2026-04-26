-- Migration: 2026_04_22_amendment_trigger_extensions.sql
--
-- PHASE 3 SESSION 4c extension of the Phase 3 Session 4a trigger set.
--
-- Delivers (by count, verified via amendment-migration scan):
--   1. 11 chiefos_touch_updated_at bindings for amendment tables with updated_at
--      (P1A-1: 4, P1A-2: 5, P1A-3: 2 — NOT 13 as the directive estimated;
--      `insight_log` and `catalog_ingestion_log` lack updated_at on verification)
--   2. 4 new functions (see below)
--   3. 6 pure append-only trigger bindings
--   4. 1 column-restriction trigger (stripe_events — status transitions required)
--   5. 1 completion-lock trigger (import_batches — UPDATEs allowed until completed)
--   6. 1 column-restriction trigger (insight_log — ack columns only)
--   → 11 touch + 9 append-only-family = 20 trigger bindings total.
--
-- DEVIATION FROM DIRECTIVE (documented in SESSION_P3_4C_MIGRATION_REPORT.md §5):
-- The P3-4c directive grouped stripe_events and import_batches with pure
-- append-only tables. Reading the rebuild migration bodies reveals:
--   - stripe_events: COMMENT says "status transitions allowed" — needs UPDATEs
--     to transition 'received' → 'processed'/'failed'/'skipped' and set
--     processed_at + error_message. Pure append-only would break webhook processing.
--   - import_batches: COMMENT says "Append-only on completed state" — row is
--     mutable during import (row_count, success_count, status), becomes immutable
--     after status='completed'. Pure append-only would break import pipeline.
--
-- Introspection-first discipline: deviated from directive to match the actual
-- semantics declared in the rebuild migrations. 9 append-only-family triggers
-- instead of 8; 3 distinct function shapes (pure / column-restriction /
-- completion-lock) instead of 2.
--
-- Authoritative references:
--   - SESSION_P3_4A_MIGRATION_REPORT.md — original trigger patterns
--   - SESSION_P1A_1, P1A_2, P1A_3 migration reports — amendment tables
--   - REBUILD_MIGRATION_MANIFEST.md Forward Flags 11, 18, 19-21
--   - migrations/2026_04_22_rebuild_functions.sql — pattern reference (NOT modified)
--   - migrations/2026_04_22_rebuild_triggers.sql — pattern reference (NOT modified)
--
-- Naming convention: trg_chiefos_<...> for trigger names (matches P3-4a).
-- Function names: chiefos_<...>_guard / _touch_updated_at (matches P3-4a).
--
-- Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS patterns.
-- Additive: does not modify rebuild_functions.sql or rebuild_triggers.sql.
-- ============================================================================

BEGIN;

-- Preflight: verify P3-4a base trigger infrastructure is present.
DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'chiefos_touch_updated_at'
  ) THEN
    RAISE EXCEPTION 'chiefos_touch_updated_at function missing — P3-4a must have applied first';
  END IF;
END $preflight$;

-- ============================================================================
-- FUNCTION 11: chiefos_append_only_guard — generic append-only
--
-- Blocks UPDATE and DELETE. Used for pure append-only tables where no column
-- may ever change post-insert.
--
-- Error message is generic (references TG_TABLE_SCHEMA.TG_TABLE_NAME) so the
-- same function binds to multiple tables without per-table copies. Analogous
-- to chiefos_activity_logs_guard_immutable() from P3-4a but with a table-
-- agnostic message — the P3-4a function is left untouched for session history.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.chiefos_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION '% on %.% is not permitted — append-only table',
      TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.chiefos_append_only_guard() IS
'Generic append-only guard. Blocks UPDATE and DELETE with a table-agnostic error message. Bound to llm_cost_log, error_logs, conversation_messages, chiefos_role_audit, intake_item_reviews, catalog_price_history. Parallel function to P3-4a''s chiefos_activity_logs_guard_immutable() which is retained under its original name for session-history clarity.';

-- ============================================================================
-- FUNCTION 12: chiefos_stripe_events_status_transition_guard
--
-- stripe_events needs UPDATE for status transitions (webhook processing).
-- Allowed to change: status, processed_at, error_message.
-- Everything else immutable. DELETE always blocked.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.chiefos_stripe_events_status_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETE on stripe_events is not permitted — append-only audit log'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.stripe_event_id IS DISTINCT FROM OLD.stripe_event_id
       OR NEW.event_type IS DISTINCT FROM OLD.event_type
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
       OR NEW.payload IS DISTINCT FROM OLD.payload
       OR NEW.signature IS DISTINCT FROM OLD.signature
       OR NEW.received_at IS DISTINCT FROM OLD.received_at
       OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
    THEN
      RAISE EXCEPTION 'stripe_events permits UPDATE only on status, processed_at, and error_message columns'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.chiefos_stripe_events_status_transition_guard() IS
'Column-restriction guard for stripe_events. UPDATE allowed only on status, processed_at, error_message (webhook processing transitions). DELETE always blocked. Resolves REBUILD_MIGRATION_MANIFEST.md Forward Flag 18.';

-- ============================================================================
-- FUNCTION 13: chiefos_import_batches_completion_lock_guard
--
-- import_batches is mutable during import (row_count, status transitions),
-- but becomes immutable once status='completed'. Before completion: UPDATE
-- allowed for status transitions pending → processing → completed/failed/
-- cancelled. DELETE always blocked.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.chiefos_import_batches_completion_lock_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETE on import_batches is not permitted — retain as audit trail'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Once the batch has reached the 'completed' state, further UPDATEs are
    -- forbidden. Intermediate states (pending, processing) may transition.
    IF OLD.status = 'completed' THEN
      RAISE EXCEPTION 'import_batches row % is completed; further UPDATEs forbidden', OLD.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Structural columns (id, tenant_id, owner_id, kind, correlation_id,
    -- created_at) are immutable across all states.
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'import_batches structural columns (id, tenant_id, owner_id, kind, correlation_id, created_at) are immutable'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.chiefos_import_batches_completion_lock_guard() IS
'Completion-lock guard for import_batches. Allows UPDATE during import (pending/processing → completed/failed/cancelled transitions with progress counts) but freezes the row once status=''completed''. Structural columns immutable always. DELETE always blocked.';

-- ============================================================================
-- FUNCTION 14: chiefos_insight_log_column_restriction_guard
--
-- insight_log permits UPDATE only to acknowledge an alert (set
-- acknowledged_at + acknowledged_by_portal_user_id). Signal data immutable.
-- DELETE always blocked.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.chiefos_insight_log_column_restriction_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETE on insight_log is not permitted — append-only with ack mutation only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
       OR NEW.signal_kind IS DISTINCT FROM OLD.signal_kind
       OR NEW.signal_key IS DISTINCT FROM OLD.signal_key
       OR NEW.severity IS DISTINCT FROM OLD.severity
       OR NEW.payload IS DISTINCT FROM OLD.payload
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'insight_log permits UPDATE only on acknowledged_at and acknowledged_by_portal_user_id columns'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.chiefos_insight_log_column_restriction_guard() IS
'Column-restriction guard for insight_log. UPDATE allowed only on acknowledged_at and acknowledged_by_portal_user_id (alert-dismissal pattern). DELETE always blocked.';

-- ============================================================================
-- TOUCH-TRIGGER BINDINGS — 11 amendment tables with updated_at
--
-- Binding count derived by grep "updated_at timestamptz NOT NULL DEFAULT now()"
-- across all 2026_04_22_amendment_*.sql files (verified 2026-04-22).
--
-- P1A-1 (4): reminders, pricing_items, job_documents, job_document_files
-- P1A-2 (5): suppliers, supplier_users, supplier_categories, catalog_products,
--            tenant_supplier_preferences
-- P1A-3 (2): docs, rag_terms
--
-- Not bound (no updated_at column, verified):
--   - insight_log (uses acknowledged_at/acknowledged_by pair; column-restriction
--     trigger handles mutations below)
--   - catalog_ingestion_log (has started_at/completed_at/created_at; no updated_at)
--   - catalog_price_history (pure append-only; below)
--   - doc_chunks (append-only chunks; created_at only)
--   - tenant_knowledge (first_seen / last_seen / seen_count pattern; no updated_at)
-- ============================================================================

-- P1A-1 touch bindings
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.reminders;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.reminders
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.pricing_items;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.pricing_items
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.job_documents;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.job_documents
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.job_document_files;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.job_document_files
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

-- P1A-2 touch bindings
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.suppliers;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.suppliers
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.supplier_users;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.supplier_users
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.supplier_categories;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.supplier_categories
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.catalog_products;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.catalog_products
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.tenant_supplier_preferences;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.tenant_supplier_preferences
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

-- P1A-3 touch bindings
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.docs;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.docs
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.rag_terms;
CREATE TRIGGER trg_chiefos_touch_updated_at
  BEFORE UPDATE ON public.rag_terms
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_touch_updated_at();

-- ============================================================================
-- PURE APPEND-ONLY TRIGGER BINDINGS — 6 tables
--
-- Blocks UPDATE + DELETE. Uses chiefos_append_only_guard() (generic).
-- Parallel to P3-4a's trg_chiefos_activity_logs_guard_immutable on
-- chiefos_activity_logs (retained under its original name).
-- ============================================================================

DROP TRIGGER IF EXISTS trg_chiefos_llm_cost_log_append_only ON public.llm_cost_log;
CREATE TRIGGER trg_chiefos_llm_cost_log_append_only
  BEFORE UPDATE OR DELETE ON public.llm_cost_log
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_append_only_guard();

DROP TRIGGER IF EXISTS trg_chiefos_error_logs_append_only ON public.error_logs;
CREATE TRIGGER trg_chiefos_error_logs_append_only
  BEFORE UPDATE OR DELETE ON public.error_logs
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_append_only_guard();

DROP TRIGGER IF EXISTS trg_chiefos_conversation_messages_append_only ON public.conversation_messages;
CREATE TRIGGER trg_chiefos_conversation_messages_append_only
  BEFORE UPDATE OR DELETE ON public.conversation_messages
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_append_only_guard();

DROP TRIGGER IF EXISTS trg_chiefos_role_audit_append_only ON public.chiefos_role_audit;
CREATE TRIGGER trg_chiefos_role_audit_append_only
  BEFORE UPDATE OR DELETE ON public.chiefos_role_audit
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_append_only_guard();

DROP TRIGGER IF EXISTS trg_chiefos_intake_item_reviews_append_only ON public.intake_item_reviews;
CREATE TRIGGER trg_chiefos_intake_item_reviews_append_only
  BEFORE UPDATE OR DELETE ON public.intake_item_reviews
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_append_only_guard();

DROP TRIGGER IF EXISTS trg_chiefos_catalog_price_history_append_only ON public.catalog_price_history;
CREATE TRIGGER trg_chiefos_catalog_price_history_append_only
  BEFORE UPDATE OR DELETE ON public.catalog_price_history
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_append_only_guard();

-- ============================================================================
-- COLUMN-RESTRICTION TRIGGER — stripe_events (status transitions allowed)
-- Resolves Forward Flag 18.
-- ============================================================================
DROP TRIGGER IF EXISTS trg_chiefos_stripe_events_status_transition ON public.stripe_events;
CREATE TRIGGER trg_chiefos_stripe_events_status_transition
  BEFORE UPDATE OR DELETE ON public.stripe_events
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_stripe_events_status_transition_guard();

-- ============================================================================
-- COMPLETION-LOCK TRIGGER — import_batches
-- Allows UPDATEs until status='completed', then locks the row.
-- ============================================================================
DROP TRIGGER IF EXISTS trg_chiefos_import_batches_completion_lock ON public.import_batches;
CREATE TRIGGER trg_chiefos_import_batches_completion_lock
  BEFORE UPDATE OR DELETE ON public.import_batches
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_import_batches_completion_lock_guard();

-- ============================================================================
-- COLUMN-RESTRICTION TRIGGER — insight_log (ack columns only)
-- ============================================================================
DROP TRIGGER IF EXISTS trg_chiefos_insight_log_column_restriction ON public.insight_log;
CREATE TRIGGER trg_chiefos_insight_log_column_restriction
  BEFORE UPDATE OR DELETE ON public.insight_log
  FOR EACH ROW EXECUTE FUNCTION public.chiefos_insight_log_column_restriction_guard();

COMMIT;
