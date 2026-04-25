# Session P3-4c Migration Report

**Date:** 2026-04-22
**Scope:** Phase 3 Session 4c — trigger extensions for amendment tables + append-only-family triggers for 9 tables
**Status:** DELIVERED

---

## 1. Scope delivered (counts)

| Category | Count | Function(s) used |
|---|---|---|
| Touch-trigger bindings | 11 | chiefos_touch_updated_at (P3-4a) |
| Pure append-only bindings | 6 | chiefos_append_only_guard (new) |
| Column-restriction binding (stripe_events) | 1 | chiefos_stripe_events_status_transition_guard (new) |
| Completion-lock binding (import_batches) | 1 | chiefos_import_batches_completion_lock_guard (new) |
| Column-restriction binding (insight_log) | 1 | chiefos_insight_log_column_restriction_guard (new) |
| **Total new bindings** | **20** | |
| **New functions** | **4** | |

1 migration file + 1 rollback file. Additive only — does not touch P3-4a's `rebuild_functions.sql` or `rebuild_triggers.sql`.

---

## 2. Touch-trigger bindings (11 tables)

Derived by grep `updated_at timestamptz NOT NULL DEFAULT now()` across all `2026_04_22_amendment_*.sql` files, then deduplicated by table.

**P1A-1 (4):**
- reminders
- pricing_items
- job_documents
- job_document_files

**P1A-2 (5):**
- suppliers
- supplier_users
- supplier_categories
- catalog_products
- tenant_supplier_preferences

**P1A-3 (2):**
- docs
- rag_terms

**Not bound (no updated_at column, verified via file reads):**
- `insight_log` — uses `acknowledged_at` / `acknowledged_by_portal_user_id` pair; column-restriction trigger handles its mutation pattern instead.
- `catalog_ingestion_log` — has `started_at`/`completed_at`/`created_at` only.
- `catalog_price_history` — pure append-only by design.
- `doc_chunks` — append-only chunks; only `created_at`.
- `tenant_knowledge` — uses `first_seen`/`last_seen`/`seen_count` pattern.

**Deviation from directive:** directive estimated 13 bindings; reality is 11. The directive's expected list included `insight_log` and `catalog_ingestion_log`; neither has an `updated_at` column, confirmed by direct file read. Manifest note corrected.

---

## 3. Append-only-family bindings (9 tables)

### Pure append-only (6 tables — blocks UPDATE and DELETE)

Bound to `chiefos_append_only_guard()` (generic, table-agnostic error message):

- `llm_cost_log` — high-volume observability; `Hard UPDATE/DELETE trigger deferred to Session P3-4` per its migration comment
- `error_logs` — backend error log, no mutable state
- `conversation_messages` — per-message history, append-only for authenticated
- `chiefos_role_audit` — security-sensitive; owner/board SELECT only
- `intake_item_reviews` — P3-2a Forward Flag 4
- `catalog_price_history` — P1A-2 append-only pattern

### Column-restriction — stripe_events (1 table)

Bound to `chiefos_stripe_events_status_transition_guard()`:
- UPDATE allowed only on `status`, `processed_at`, `error_message`
- DELETE always blocked
- Other columns (stripe_event_id, event_type, tenant_id, owner_id, payload, signature, received_at, correlation_id) immutable

Motivation: the rebuild migration body explicitly states "status transitions allowed. Hard UPDATE-constraint trigger deferred to Session P3-4." A pure append-only trigger would break webhook processing.

### Completion-lock — import_batches (1 table)

Bound to `chiefos_import_batches_completion_lock_guard()`:
- UPDATE allowed only while `OLD.status != 'completed'`
- Once `status='completed'`, further UPDATE rejected
- DELETE always blocked
- Structural columns (id, tenant_id, owner_id, kind, correlation_id, created_at) immutable in every state

Motivation: the rebuild migration body states "Append-only on completed state (trigger in Session P3-4)." The import pipeline legitimately mutates `status`, `row_count`, `success_count`, `error_count`, `error_summary`, `started_at`, `completed_at` during processing.

### Column-restriction — insight_log (1 table)

Bound to `chiefos_insight_log_column_restriction_guard()`:
- UPDATE allowed only on `acknowledged_at` and `acknowledged_by_portal_user_id`
- DELETE always blocked
- Signal data (signal_kind, signal_key, severity, payload) immutable

Motivation: the migration's existing RLS policy `insight_log_tenant_update` allows authenticated UPDATE for the dismiss-alert flow (`/api/alerts/dismiss`). The trigger enforces the column restriction at the DB layer that the RLS policy alone cannot.

---

## 4. New functions (4)

All four are `LANGUAGE plpgsql`, `SECURITY INVOKER`, `SET search_path = ''` — identical discipline to P3-4a's 10 functions.

1. `chiefos_append_only_guard()` — generic; error message uses `TG_TABLE_SCHEMA` + `TG_TABLE_NAME`, so one function supports 6 bindings.
2. `chiefos_stripe_events_status_transition_guard()` — table-specific column list.
3. `chiefos_import_batches_completion_lock_guard()` — table-specific structural lock + status-transition gate.
4. `chiefos_insight_log_column_restriction_guard()` — table-specific column list.

**Decision on P3-4a's `chiefos_activity_logs_guard_immutable`:** retained under its original name, bound only to `chiefos_activity_logs` (P3-4a binding unchanged). The new generic `chiefos_append_only_guard` is the going-forward function for new append-only tables. Renaming the P3-4a function would require modifying P3-4a artifacts, violating this session's additive-only boundary.

---

## 5. Deviation from directive (flagged for founder review)

The directive proposed binding pure append-only triggers to all 7 P3-4a carry-forward tables, including `stripe_events` and `import_batches`. Reading the rebuild migrations for those two tables revealed that both **require legitimate UPDATEs** to function:

- `stripe_events` needs status transitions for webhook processing (documented in the migration COMMENT).
- `import_batches` needs progress tracking during import (documented in the migration COMMENT).

Binding pure append-only would have broken both paths at cutover. The deviation authored table-specific guards for those two, matching the semantics already documented in the rebuild migrations.

**Same introspection-first discipline pattern as prior P1A sessions.** Prior examples: P1A-1 `job_id` uuid→integer; P1A-3 `tenant_knowledge.owner_id` uuid→text. This session's pattern is slightly different — the rebuild migrations' COMMENTs were the authoritative source rather than live production schema, but the principle is the same: prefer the declared semantics over the directive's estimate.

Result: 9 append-only-family triggers authored instead of the directive's 8. The 9th (insight_log column-restriction) was already in the directive; the deviation is in the *shape* of triggers for stripe_events and import_batches, not the count.

---

## 6. Manifest updates applied

- Session history line added for P3-4c.
- Apply-order entry `17j. amendment_trigger_extensions` inserted between `17i. amendment_tenant_knowledge` and `18. rebuild_functions`. Note: naming sorts within the 17* amendment bucket even though it logically runs *after* the 18/19/20 P3-4a migrations because it depends on `chiefos_touch_updated_at`. The manifest entry clarifies the actual apply order: AFTER step 19 (rebuild_triggers) at cutover.
- Touch-trigger note rewritten: 11 bindings in P3-4c (not 13 as estimated). Combined total: 37 touch bindings across the rebuild schema.
- Forward Flag 4 (intake_item_reviews append-only) → resolved.
- Forward Flag 11 (audit-table append-only) → resolved.
- Forward Flag 18 (stripe_events column-level restriction) → resolved.
- Rollback posture §6 lists the new rollback file.

**Apply-order precision note:** although entry is labelled `17j`, the migration must run AFTER entry 19 (`rebuild_triggers`) because its preflight requires the `chiefos_touch_updated_at` function created by P3-4a. The `17j` label reflects its membership in the amendment bucket, not its absolute apply position. Phase 5 runner must respect the dependency: `rebuild_functions` (18) → `rebuild_triggers` (19) → `amendment_trigger_extensions`. All three can run together at the tail of the apply sequence.

---

## 7. Flagged items for founder review

1. **Function naming: `chiefos_activity_logs_guard_immutable` vs `chiefos_append_only_guard`** — two parallel functions now exist. Consider whether a future consolidation session should rename/merge them. Non-blocking: both work, both have clear provenance.
2. **Completion-lock vs append-only boundary for import_batches** — the migration allows transition to 'cancelled' and 'failed' as terminal states as well as 'completed'. Current trigger only freezes on 'completed'. If product expects 'cancelled'/'failed' to also freeze the row, extend the OLD.status check. Documented in the function COMMENT so future tightening is trivial.
3. **No trigger on `cil_drafts`, `pending_actions`, or `conversation_sessions`** — these have `updated_at` and are already touch-bound in P3-4a (not in this session). This session only adds bindings for *amendment* tables; Phase 3 tables were already covered.
4. **`catalog_ingestion_log` lacks any hard trigger** — it's mutable (status transitions), has no `updated_at`, and was not in the P3-4a carry-forward list. It relies on RLS + GRANT posture alone. If the `completed_at` column should be frozen once set, a completion-lock trigger similar to import_batches would be needed. Non-blocking; flagged for later consideration if the ingestion pipeline surfaces audit integrity issues.

---

## 8. Phase 3 + Amendments closeout

With P3-4c delivered, all planned trigger work is complete:

- **Phase 3**: 20 migrations, 57 tables, 10 functions, 35 original trigger bindings (10 distinct + 26 touch), 6 views
- **Phase 1 Amendments**: 9 migrations, 16 tables across 3 sessions (P1A-1, P1A-2, P1A-3)
- **P3-4c**: 1 additive migration, 4 functions, 11 touch + 9 append-only-family bindings

**Grand totals:**
- 30 migrations in the rebuild schema
- 73 tables
- 14 functions (10 from P3-4a + 4 from P3-4c)
- 37 touch-trigger bindings
- 19 append-only-family trigger bindings (10 distinct guards from P3-4a + 9 from P3-4c)

**Ready for R1 remediation session** (pre-cutover CHECK spot-checks per `PHASE_5_PRE_CUTOVER_CHECKLIST.md`).
