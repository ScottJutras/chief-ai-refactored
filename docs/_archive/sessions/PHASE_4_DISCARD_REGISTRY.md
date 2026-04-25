# Phase 4 DISCARD Registry

**Purpose:** authoritative reference list of every database object the Foundation Rebuild DISCARDs. Used by the Phase 4 app-code grep to identify dependencies.
**Sources:** `FOUNDATION_P1_SCHEMA_DESIGN.md` §6.1 + §5.2 + §4.3; `FOUNDATION_P2_SECURITY_AUDIT.md` §1 + §3.

---

## 1. DISCARDed Tables (63 total — matches P3-4b drift baseline)

### 1.1 Actor cluster (Decision 12)
- `chiefos_actors`
- `chiefos_actor_identities`
- `chiefos_tenant_actors`
- `chiefos_tenant_actor_profiles`

### 1.2 Legacy financial (superseded by `transactions`)
- `expenses`
- `revenue`
- `chiefos_expenses`
- `chiefos_expense_audit`
- `bills`
- `budgets`
- `receivables`

### 1.3 Legacy activity / audit
- `chiefos_activity_log_events` (flattened into `chiefos_activity_logs`)
- `chiefos_txn_delete_batches` (consolidated into `chiefos_deletion_batches`)
- `chiefos_vendor_aliases` (replaced by canonical `vendor_aliases`)

### 1.4 Legacy identity / signup / admin
- `chiefos_link_codes` (replaced by `portal_phone_link_otp`)
- `chiefos_user_identities`
- `chiefos_user_identities_old`
- `chiefos_identity_map`
- `chiefos_ingestion_identities`
- `chiefos_phone_active_tenant`
- `chiefos_pending_signups` (Decision 1 — signup moves to Supabase Auth)
- `chiefos_board_assignments` (replaced by `chiefos_portal_users.role='board_member'`)
- `chiefos_saved_views` (Decision 3)
- `users_legacy_archive` (Decision 2)
- `user_auth_links` (replaced by `chiefos_portal_users`)
- `user_memory` (folded into `conversation_sessions`/`conversation_messages`)

### 1.5 Legacy time spine
- `time_entries` (v1 — superseded by `time_entries_v2`)
- `timesheet_rollups` (Decision 7 — compute-on-read via `chiefos_portal_job_summary`)

### 1.6 Legacy counters
- `job_counters`
- `task_counters`
- `task_counters_user`

### 1.7 Legacy KPI / denormalization
- `job_kpis_daily`
- `kpi_touches`

### 1.8 Supplier catalog cluster (Decision 6 — out of scope)
- `suppliers`
- `supplier_users`
- `supplier_categories`
- `tenant_supplier_preferences`
- `catalog_products`
- `catalog_ingestion_log`
- `catalog_price_history`
- `pricing_items`

### 1.9 Docs / RAG / knowledge
- `rag_terms`
- `docs`
- `doc_chunks`
- `knowledge_cards`
- `tenant_knowledge`

### 1.10 Conversation predecessors
- `assistant_events`
- `chief_actor_memory`
- `convo_state`
- `entity_summary` (folded into `conversation_sessions.active_entities`)

### 1.11 Legacy intake / jobs
- `intake_processing_jobs`
- `job_documents`
- `job_document_files`

### 1.12 Misc
- `uploads` (reclassified — duplicate of `media_assets`)
- `team_member_assignments` (reclassified — duplicate of `employees`/`chiefos_portal_users` join)
- `reminders` (deferred)
- `owner_nudges`
- `insight_log`
- `fact_events`
- `change_orders` (Decision 8)
- `capability_denials`
- `category_rules`
- `user_active_job` (folded into `users.auto_assign_active_job_id`)
- `usage_monthly`
- `usage_monthly_v2` (both superseded by `quota_consumption_log`)

---

## 2. DISCARDed Views (17 total)

### 2.1 Diagnostic / internal
- `_rls_audit`

### 2.2 Legacy event/signature unions
- `chiefos_all_events_v`
- `chiefos_all_signatures_v`

### 2.3 Legacy finance/expense joins
- `chiefos_expenses_receipts`
- `v_finance_ledger`
- `v_revenue`

### 2.4 KPI aggregate views (collapsed into `chiefos_portal_job_summary`)
- `company_balance_kpis`
- `company_kpis`
- `company_kpis_monthly`
- `company_kpis_weekly`
- `job_kpis_summary`
- `job_kpis_monthly`
- `job_kpis_weekly`
- `v_job_profit_simple`
- `v_job_profit_simple_fixed`

### 2.5 Other legacy views
- `jobs_view` (redundant with direct `jobs` queries under RLS)
- `llm_cost_daily` (replaced by app-side aggregation or ad-hoc `llm_cost_log` queries)
- `receivables_aging` (receivables feature out of scope)
- `v_actor_identity_resolver`
- `v_identity_resolver`

### 2.6 Renamed (replaced by `chiefos_portal_*` siblings)
Note: these are KEEP-WITH-REDESIGN (i.e., the functional slot is preserved) but under new names. App code referring to the old names must switch:
- `open_shifts` → `chiefos_portal_open_shifts`
- `v_cashflow_daily` → `chiefos_portal_cashflow_daily`

---

## 3. DISCARDed Functions (39 total — 20 SECDEF + 19 INVOKER)

### 3.1 SECURITY DEFINER (20) — all DISCARDed per §5.2

- `chiefos_bulk_assign_expense_job`
- `chiefos_create_link_code`
- `chiefos_delete_expenses`
- `chiefos_delete_saved_view`
- `chiefos_delete_signup_test_user_by_email`
- `chiefos_finish_signup`
- `chiefos_is_owner_in_tenant`
- `chiefos_list_expense_audit`
- `chiefos_list_saved_views`
- `chiefos_list_vendors`
- `chiefos_normalize_vendor`
- `chiefos_restore_expense`
- `chiefos_restore_expenses_bulk`
- `chiefos_undo_delete_expenses`
- `chiefos_set_user_role`
- `chiefos_update_expense`
- `chiefos_upsert_saved_view`
- `ensure_job_no`
- `stamp_owner_id`
- `stamp_time_entry_user`

### 3.2 INVOKER user functions (19) — all DISCARDed per §5.2

- `_enqueue_kpi_touch_from_row`
- `auto_link_transaction_supplier`
- `chiefos_phone_digits`
- `chiefos_try_uuid`
- `enforce_employee_cap`
- `ensure_task_no`
- `ensure_task_no_per_user`
- `normalize_beta_signup_email`
- `next_job_no`
- `next_task_no`
- `next_task_no_for_user`
- `set_updated_at_timestamp`
- `tg_set_updated_at`
- `touch_updated_at` (the plain variant; the rebuild has `chiefos_touch_updated_at`)
- `touch_states_updated_at`
- `sync_error_logs_cols`
- `sync_locks_cols`
- `sync_states_cols`
- `sync_transactions_expense_to_portal`

---

## 4. Dropped columns from KEEP-WITH-REDESIGN tables

### 4.1 `users` (54 → 21; 33 columns dropped)

- `country`, `province`, `business_country`, `business_province`
- `spreadsheet_id`
- `token_usage`, `trial_start`, `trial_end`
- `subscription_tier`, `paid_tier` (collapsed into `plan_key`)
- `current_stage`, `training_completed`, `historical_data_years`, `historical_parsing_purchased`
- `team_members`, `team`, `is_team_member`
- `dashboard_token`
- `otp`, `otp_expiry`, `last_otp`, `last_otp_time`
- `fiscal_year_start`, `fiscal_year_end`, `recap_time_pref`
- `reminder_needed`
- `goal`, `goal_progress`, `goal_context`
- `industry`
- `onboarding_in_progress` (use `onboarding_completed = false`)
- `ocr_upgrade_prompt_shown`, `stt_upgrade_prompt_shown`, `export_upgrade_prompt_shown`, `crew_upgrade_prompt_shown`
- `timezone` (use `tz` only — duplicate removed)

### 4.2 `transactions` (§3.2 — columns dropped)

- `amount` numeric (duplicate of `amount_cents`)
- `payment_status`, `payment_confirmed_at` (bill-payment-tracking feature deferred)

### 4.3 `media_assets` (Decision 13 — OCR columns DISCARDed)

OCR-specific columns removed. File-metadata columns (`storage_provider`, `storage_path`, `content_type`, `size_bytes`, `storage_bucket`, `content_hash`) preserved. The polymorphic `parent_kind` / `parent_id` discriminator + `mime_type` + `media_kind` remain. Any column with a name hinting at OCR (`ocr_*`, `parse_*` on media_assets) is removed — OCR now happens via `parse_jobs` pipeline against the `media_asset_id` reference.

### 4.4 `tasks` (§3.12 — 4 columns reshaped)

- `related_entry_id bigint` (unused)
- `acceptance_status text` (folded into `status` enum)
- `type` renamed to `kind` (SQL keyword avoidance)
- `completed_by text` split into `completed_by_portal_user_id uuid` + `completed_by_user_id text` (dual-boundary)

### 4.5 `employer_policies` (§3.4)

- `owner_id` type changed from `uuid` → `text` (dual-boundary fix). App code referencing `employer_policies.owner_id` with a uuid comparator will fail.

### 4.6 `locks` (§3.4)

- `lock_key` column DROPPED (duplicate of `key`). App code using `lock_key` must switch to `key`.

### 4.7 `states` (§3.4)

- `owner_id text NOT NULL` and `tenant_id uuid` ADDED (WhatsApp handler must populate these on write).

### 4.8 `time_entries_v2` (§3.4)

- `job_id` type changed from `uuid` → `integer` (to match `jobs.id serial`). App code casting/comparing with uuid will fail.
- `job_no` denormalized column ADDED.

### 4.9 `overhead_items`, `overhead_payments`, `overhead_reminders` (§3.12)

- `overhead_items.owner_id` changed from nullable → `NOT NULL`.
- `overhead_payments.owner_id` ADDED (was absent — a dual-boundary violation in pre-rebuild).
- `overhead_reminders.owner_id` ADDED.
- `overhead_payments.transaction_id` + `overhead_items.currency` + `overhead_*.correlation_id` ADDED.

### 4.10 `cil_drafts` (§3.9 — FULL REBUILD)

- `id` type `bigint` → `uuid` (no integer-key compatibility).
- `status` column DROPPED (replaced by `validated_at` + `committed_at` timestamp pair).
- `kind` column RENAMED to `cil_type` with CamelCase format CHECK.
- `actor_phone`, `actor_user_id` DROPPED (use dual-boundary `owner_id` + `user_id`).
- `tenant_id uuid NOT NULL` ADDED.
- `trace_id text NOT NULL` + `correlation_id uuid NOT NULL` ADDED.
- `committed_to_table`, `committed_to_id` ADDED for traceback.

### 4.11 `employees` (§3.4)

- `role` CHECK added (`'owner'`/`'employee'`/`'contractor'`/`'board_member'`).
- `tenant_id uuid NOT NULL` ADDED.

### 4.12 `settings` (§3.12 — FULL REBUILD)

- `id bigint` → `uuid`.
- `tenant_id uuid NOT NULL` ADDED (was missing).
- `scope text` column ADDED ('owner'/'tenant').
- `value` type changed `text` → `jsonb`.

### 4.13 `mileage_logs` (§3.12)

- `id bigint` → `uuid`.
- `owner_id uuid` → `text`.
- `transaction_id uuid` ADDED (parallel-row link).
- `correlation_id` ADDED.
- Columns: `unit`, `rate_cents`, `deductible_cents` (formalized).

### 4.14 `chiefos_crew_rates` (§3.12)

- `id bigint` → `uuid`.
- `portal_user_id uuid` ADDED.
- `correlation_id` ADDED.
- Strict role-restricted RLS (employees cannot see their rates).

### 4.15 `stripe_events` (§3.12)

- Substantial column additions: `payload jsonb`, `signature`, `tenant_id`, `owner_id`, `status`, `error_message`, `processed_at`, `correlation_id`. Pre-rebuild had only 3 cols.

### 4.16 `llm_cost_log` (§3.12)

- `id bigint` → `uuid`.
- `cost_usd numeric` RENAMED to `cost_cents bigint`.
- `query_kind` RENAMED to `feature_kind`.
- `trace_id`, `correlation_id` ADDED.
- RLS enabled (was disabled).

### 4.17 `error_logs` (§3.12)

- `id bigint` → `uuid`.
- `error_stack text` → `jsonb`.
- `trace_id text NOT NULL` ADDED (was optional).
- `correlation_id` ADDED.

### 4.18 `intake_batches`, `intake_items`, `intake_item_drafts`, `intake_item_reviews` (§3.6)

- `kind` CHECKs narrowed to exclude `receipt_image*` values on batches and items. Receipt flow now uses `parse_jobs`.
- `intake_item_drafts.draft_kind` ADDED (distinct from existing `draft_type`).
- `intake_item_reviews.reviewed_by_auth_user_id` RENAMED to `reviewed_by_portal_user_id`.
- `intake_item_reviews.correlation_id uuid NOT NULL` ADDED.

### 4.19 `chiefos_role_audit` (§3.11)

- Actor column rename: `actor_user_id uuid` → `acted_by_portal_user_id uuid`.
- `target_user_id uuid` → `target_portal_user_id uuid`.
- `old_role` → `previous_role`.
- `action text NOT NULL` CHECK ADDED (`'promote'`/`'demote'`/`'deactivate'`/`'reactivate'`).
- `correlation_id uuid NOT NULL` ADDED.

### 4.20 `chiefos_deletion_batches` (§3.11)

- `actor_user_id uuid` RENAMED to `portal_user_id uuid`.
- `expense_ids text[]` RENAMED to `target_ids text[]`.
- `target_table text NOT NULL` ADDED (now generic, not expense-specific).
- `owner_id text NOT NULL`, `reason`, `undo_expires_at`, `undone_at`, `correlation_id` ADDED.

### 4.21 `integrity_verification_log` (§3.11 — FULL REBUILD)

Substantial column reshuffle:
- `table_name` → `chain` (CHECK enum: `'transactions'`/`'time_entries_v2'`).
- `verification_type`, `total_records_checked`, `records_valid`, `records_invalid`, `records_unhashed`, `first_invalid_record_id`, `invalid_details` DROPPED.
- New: `rows_checked`, `rows_failed`, `result` CHECK (`'pass'`/`'fail'`/`'partial'`), `failure_details jsonb`, `correlation_id uuid NOT NULL`.
- RLS enabled.

---

## 5. DISCARDed triggers (21 untracked + 0 tracked)

See §5.4. App code does not typically reference triggers by name but may log about them. Low-priority grep.

---

**End of DISCARD registry.** Use this file as the reference during Phase 4 grep audits.
