-- Rollback for 2026_04_22_amendment_trigger_extensions.sql
-- Drops 20 trigger bindings and 4 new functions introduced in P3-4c.
-- Safe to re-run (DROP ... IF EXISTS throughout).
--
-- Order: triggers first, then functions (triggers depend on functions).
-- Does NOT drop chiefos_touch_updated_at — that's owned by P3-4a.

BEGIN;

-- === 11 TOUCH-TRIGGER BINDINGS ===
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.reminders;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.pricing_items;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.job_documents;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.job_document_files;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.suppliers;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.supplier_users;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.supplier_categories;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.catalog_products;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.tenant_supplier_preferences;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.docs;
DROP TRIGGER IF EXISTS trg_chiefos_touch_updated_at ON public.rag_terms;

-- === 6 PURE APPEND-ONLY BINDINGS ===
DROP TRIGGER IF EXISTS trg_chiefos_llm_cost_log_append_only ON public.llm_cost_log;
DROP TRIGGER IF EXISTS trg_chiefos_error_logs_append_only ON public.error_logs;
DROP TRIGGER IF EXISTS trg_chiefos_conversation_messages_append_only ON public.conversation_messages;
DROP TRIGGER IF EXISTS trg_chiefos_role_audit_append_only ON public.chiefos_role_audit;
DROP TRIGGER IF EXISTS trg_chiefos_intake_item_reviews_append_only ON public.intake_item_reviews;
DROP TRIGGER IF EXISTS trg_chiefos_catalog_price_history_append_only ON public.catalog_price_history;

-- === 3 SPECIAL BINDINGS ===
DROP TRIGGER IF EXISTS trg_chiefos_stripe_events_status_transition ON public.stripe_events;
DROP TRIGGER IF EXISTS trg_chiefos_import_batches_completion_lock ON public.import_batches;
DROP TRIGGER IF EXISTS trg_chiefos_insight_log_column_restriction ON public.insight_log;

-- === 4 NEW FUNCTIONS ===
DROP FUNCTION IF EXISTS public.chiefos_append_only_guard();
DROP FUNCTION IF EXISTS public.chiefos_stripe_events_status_transition_guard();
DROP FUNCTION IF EXISTS public.chiefos_import_batches_completion_lock_guard();
DROP FUNCTION IF EXISTS public.chiefos_insight_log_column_restriction_guard();

COMMIT;
