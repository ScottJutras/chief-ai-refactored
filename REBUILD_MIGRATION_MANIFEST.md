markdown# Rebuild Migration Manifest

**Last updated:** P1A-6 (2026-04-25)
**Status:** Authoritative source-of-truth for which migrations run during Phase 5 of the Foundation Rebuild.
**Authority:** `FOUNDATION_REBUILD_PLAN_V2.md` §5 Phase 5.

Session history lives in `docs/_archive/sessions/`. This file reflects current state only.

---

## 1. Directory Decision

Existing `migrations/` directory reused. Logical split between ARCHIVED (skipped at Phase 5) and KEEP (run at Phase 5) is enforced by this manifest's apply-order list. Pre-rebuild migrations remain physically in place; physical relocation to `migrations/_archive_pre_rebuild/` deferred per "document, don't unilaterally move" guidance.

Phase 5 runner reads §3 Apply Order and applies only listed migrations against an emptied `public` schema, in listed order.

---

## 2. Existing Migrations — Classification

### 2.1 KEEP (run in Phase 5)

| File | Purpose |
|---|---|
| `2026_04_21_chiefos_quota_architecture_tables.sql` | quota_allotments, quota_consumption_log, addon_purchases_yearly, upsell_prompts_log |
| `2026_04_21_drop_unsafe_signup_test_user_function.sql` | Security drop of `chiefos_delete_signup_test_user_by_email` (no-op on cold-start; kept for history) |

### 2.2 ARCHIVED (do NOT run in Phase 5)

55 pre-rebuild migration files remain physically in `migrations/`. The Phase 5 runner skips them via this manifest's apply-order list. See git log for individual filenames if needed.

### 2.3 SUPERSEDED BY P3-2b RE-AUTHORS

Files remain on disk as historical record but are NOT run in Phase 5. Effective DDL ships via re-authored files:

| Superseded file | Superseded by |
|---|---|
| `2026_04_18_chiefos_quotes_spine.sql` | `rebuild_quotes_spine` |
| `2026_04_18_chiefos_quote_events.sql` | `rebuild_quotes_spine` |
| `2026_04_18_chiefos_quote_share_tokens.sql` | `rebuild_quotes_spine` |
| `2026_04_18_chiefos_quote_signatures.sql` | `rebuild_quotes_spine` |
| `2026_04_19_chiefos_qs_png_storage_key_format.sql` | `rebuild_quotes_spine` |
| `2026_04_20_chiefos_tenant_counters_generalize.sql` | `rebuild_jobs_spine` |
| `2026_04_21_chiefos_parse_pipeline_tables.sql` | `rebuild_receipt_pipeline` |

---

## 3. Apply Order for Phase 5

Phase 5 applies migrations against an empty `public` schema in this order:
rebuild_identity_tenancy
rebuild_media_assets
rebuild_financial_spine
rebuild_jobs_spine                    -- creates chiefos_tenant_counters; wires deferred FKs
rebuild_time_spine                    -- integrity-chain cols populated; trigger wired in step 19
rebuild_intake_pipeline
rebuild_admin_support                 -- creates customers (FK target for Quotes spine)
rebuild_quotes_spine                  -- folds 6 prior migrations byte-identical
rebuild_receipt_pipeline              -- Principle 11 composite-FK upgrade on parse_corrections
2026_04_21_chiefos_quota_architecture_tables.sql
rebuild_pending_actions_cil_drafts
rebuild_conversation_spine            -- §3.10 NEW; entity_summary DISCARDed
rebuild_audit_observability
rebuild_tasks
rebuild_mileage_logs
rebuild_overhead_family
rebuild_financial_observability       -- append-only via GRANT; hard triggers in step 17j
17a. amendment_reminders_and_insight_log  -- P1A-1 (Gaps 1, 4)
17b. amendment_pricing_items              -- P1A-1 (Gap 5)
17c. amendment_documents_flow             -- P1A-1 (Gap 6 Option A; non-standard anon signing RLS)
17d. amendment_supplier_catalog_root      -- P1A-2 (Gap 2; suppliers + supplier_users + categories)
17e. amendment_supplier_catalog_products  -- P1A-2 (Gap 2; products + price_history + ingestion_log)
17f. amendment_tenant_supplier_preferences -- P1A-2 (Gap 2)
17g. amendment_rag_docs                   -- P1A-3 (§3.14; pgvector(1536); requires CREATE EXTENSION vector preflight)
17h. amendment_rag_terms                  -- P1A-3 (§3.14; GLOBAL glossary)
17i. amendment_tenant_knowledge           -- P1A-3 (§3.14; owner_id drift-corrected uuid→text)
17k. amendment_p1a4_users_auth_user_id    -- P1A-4 (auth_user_id reverse pointer; consumed by R2.5)
17l. amendment_p1a5_submission_status     -- P1A-5 (time_entries_v2 + tasks; consumed by R3b)
17m. amendment_p1a6_portal_users_status   -- P1A-6 (chiefos_portal_users soft-delete; consumed by F1)
rebuild_functions                     -- 10 functions, all SECURITY INVOKER, SET search_path=''
amendment_trigger_extensions          -- formerly 17j; moved here from amendment block to satisfy chiefos_touch_updated_at dependency. P3-4c (4 functions + 11 touch bindings + 9 append-only-family bindings; CREATE TRIGGER resolves function refs at parse time, so must run after rebuild_functions defines chiefos_touch_updated_at)
rebuild_triggers                      -- 10 distinct + 26 touch_updated_at bindings; depends on rebuild_functions
rebuild_views                         -- 6 views, all SECURITY INVOKER WITH (security_invoker = true)
rebuild_rls_coverage_gap_fix          -- additive GRANTs for 6 Quotes spine tables (Principle 9)
2026_04_25_chiefos_quote_versions_source_msg_id  -- Phase A Session 5; adds source_msg_id + partial UNIQUE for §17.8 ReissueQuote dedup; extends chiefos_quote_versions_guard_immutable to block UPDATE/DELETE on superseded versions (header pointer divergence detection)
drift_detection_script                -- scripts/schema_drift_check.js + package.json entries
2026_04_21_drop_unsafe_signup_test_user_function.sql
remediation_drop_users_dashboard_token -- R1; must run AFTER R9 cleans services/postgres.js references


**Phase 3 status: COMPLETE.** All rebuild migrations, functions, triggers, views, RLS policies, and the drift-detection script are authored. Phase 4 (App Code Audit) ongoing via R-sessions.

**Critical dependency notes:**

- Step 7 must run before step 8 (Quotes spine FK to customers).
- `amendment_trigger_extensions` (formerly 17j) must run after `rebuild_functions` so `chiefos_touch_updated_at()` exists at parse time. Resolved in apply-order list above (2026-04-26 manifest reorder); prior ordering placed 17j before `rebuild_functions` and would have failed against an empty schema with `42883: function public.chiefos_touch_updated_at() does not exist`.
- Step 24 must run after R9 cleans `services/postgres.js:3370,3385,4593` references to `dashboard_token`.

---

## 4. Dependency Map (spine-level)rebuild_identity_tenancy   → chiefos_tenants, users, chiefos_portal_users, chiefos_legal_acceptances, portal_phone_link_otp, chiefos_beta_signups
rebuild_media_assets       → media_assets
rebuild_financial_spine    → transactions (FK to jobs deferred), file_exports
rebuild_jobs_spine         → chiefos_tenant_counters, jobs (+ phases, photos, photo_shares); WIRES transactions.job_id, users.auto_assign_active_job_id
rebuild_time_spine         → time_entries_v2 (integrity chain), timeclock_prompts, timeclock_repair_prompts, timesheet_locks, states, locks, employees, employer_policies
rebuild_intake_pipeline    → intake_batches, intake_items (+ duplicate_of self-FK), intake_item_drafts, intake_item_reviews
rebuild_admin_support      → customers, settings, import_batches, employee_invites, chiefos_crew_rates
rebuild_quotes_spine       → chiefos_quotes, chiefos_quote_versions, chiefos_quote_line_items, chiefos_events_global_seq SEQUENCE, chiefos_quote_share_tokens, chiefos_quote_signatures, chiefos_quote_events; views chiefos_all_events_v + chiefos_all_signatures_v
rebuild_receipt_pipeline   → parse_jobs, vendor_aliases, parse_corrections (composite FK upgrade)
rebuild_pending_actions_cil_drafts → pending_actions, cil_drafts
rebuild_conversation_spine → conversation_sessions (active_entities jsonb subsumes entity_summary), conversation_messages
rebuild_audit_observability → chiefos_activity_logs, chiefos_deletion_batches, email_ingest_events, integrity_verification_log, chiefos_role_audit
rebuild_tasks              → tasks (composite FK to jobs; task_no via chiefos_tenant_counters)
rebuild_mileage_logs       → mileage_logs (composite FKs to jobs + transactions)
rebuild_overhead_family    → overhead_items, overhead_payments, overhead_reminders
rebuild_financial_observability → stripe_events, llm_cost_log, error_logs
quota_architecture         → quota_allotments, quota_consumption_log, addon_purchases_yearly, upsell_prompts_log

Per-table FK details live in each migration file's preflight + provenance header. This map is for spine-level cutover sequencing.

**DISCARDED tables** (not created by any rebuild migration; documented to prevent reintroduction):
`uploads` (duplicate of media_assets), `team_member_assignments` (duplicate of chiefos_portal_users role membership), `chiefos_activity_log_events` (parent/child split obsolete post-actor-cluster-DISCARD), `chiefos_txn_delete_batches` (consolidated into chiefos_deletion_batches), `entity_summary` (subsumed by conversation_sessions.active_entities), `assistant_events`, `chief_actor_memory`, `convo_state` (ad-hoc predecessors to conversation spine).

---

## 5. Active Forward Flags

Resolved flags removed; numbering preserved for any extant citations. See git log for resolved-flag content if needed.

**3. Integrity-chain triggers for transactions + time_entries_v2.** Both tables have integrity-chain columns populated NULL/default at INSERT. Trigger function authored in step 18 (one function, two bindings). Until step 19 binds, `record_hash` is NULL and partial UNIQUE indexes permit NULL. **Status: bound at step 19; verify post-cutover.**

**5. time_entries_v2 per-employee policy tightening.** Standard tenant-membership RLS in place. Design §3.4 calls for "board members read all; employees read own only" scoping. Requires WhatsApp-user_id ↔ portal-auth-user_id mapping. P1A-4 partially addresses via `users.auth_user_id`. **Status: partial; full per-employee scoping pending app-side adoption.**

**6. Policy cleanup sweep.** 41 RLS policies flagged for REDESIGN in Phase 2 (§3.1). Replaced progressively across rebuild migrations. **Status: per-table replaced; no final sweep migration needed.**

**7. states.tenant_id is nullable.** Beta signups pre-tenant; partial index used. Promote to NOT NULL once app-code guarantees resolved tenant before any `states` write. **Status: deferred until onboarding-tightening session.**

**8. Superseded pre-rebuild Quotes migrations physically present.** Six files remain in `migrations/` but skipped by Phase 5. Physical relocation deferred. **Status: non-blocking.**

**12. entity_summary DISCARD revisit.** `active_entities jsonb` on `conversation_sessions` subsumes the role. Revisit if Phase 4 app-code audit reveals an active denormalized read path. **Status: open; no path discovered to date.**

**13. chiefos_activity_logs system-actor semantics.** At-least-one-actor CHECK requires designated system-user row for cron/trigger/migration-originated rows. **Status: open; app-code resolution.**

**14. cil_drafts type coercion from pre-rebuild shape.** bigint→uuid, varchar→text, status column dropped. Requires explicit coercion if rows exist at rebuild time. **Status: Phase 5 backfill item.**

**15. jobs.id type reconciliation in design doc.** §3.12 text says uuid; §3.3 (and migrations) ship integer. Recommend §3.12 text update for consistency. **Status: doc-only fix.**

**16. chiefos_crew_rates simple FK to chiefos_portal_users.** Design §3.12 calls for composite FK; portal_users PK is single-column. Recommend P3-4 policy-cleanup sweep evaluate adding composite UNIQUE to portal_users. **Status: open.**

**17. task_no allocation via chiefos_next_tenant_counter helper.** Function authored in step 18; until live, app-code allocates via direct UPSERT. **Status: bound at step 18; verify app-code uses helper post-cutover.**

**19. tenant_knowledge.owner_id drift correction.** Production had uuid; rebuild ships text matching `services/learning.js` writes. Production row count was 0 (writes never succeeded). **Status: corrected; no data migration needed.**

**20. RAG doc ingestion + reindex paths.** ivfflat index on `doc_chunks.embedding` at lists=100. Post-cutover: REINDEX once chunk count >5× lists value (pgvector guidance). **Status: operational runbook item.**

**21. RAG embedding dimension pinning.** vector(1536) matches OpenAI text-embedding-3-small. Provider/model swap requires column ALTER + regeneration. **Status: documented; flag any future swap.**

**22. users.dashboard_token app-side cleanup.** Step 24 migration drops the column. `services/postgres.js:3370,3385,4593` still reference it. Must be cleaned before step 24 applies. **Status: scheduled for R9.**

**23. /app/activity/expenses/audit portal navigation.** `chiefos-site/app/app/activity/expenses/audit/page.tsx` is DELETE-SAFELY but 4 portal pages link to the route. Either redirect navigation targets to `/app/activity/expenses/vendors` or keep audit page until RPC replacement lands. **Status: founder decision pending.**

---

## 6. Rollback Posture

Every `rebuild_*.sql` and amendment migration has a matching rollback in `migrations/rollbacks/`. Rollback files mirror apply-order (reverse sequence at cutover-rollback time). FK-cycle migrations (Quotes spine, audit_observability) break cycles explicitly before DROP TABLE.

**Rollback ordering rule:** reverse of apply order. Specific orderings worth noting:

- `rebuild_admin_support_rollback` runs AFTER `rebuild_quotes_spine_rollback` (customers FK target)
- `rebuild_jobs_spine_rollback` drops deferred FKs on transactions + users to avoid dangling references
- `rebuild_quotes_spine_rollback` breaks chiefos_quotes↔versions and chiefos_quote_signatures↔events FK cycles before DROP TABLE
- `rebuild_triggers_rollback` runs BEFORE `rebuild_functions_rollback`
- Amendment rollbacks (P1A-4/5/6) run BEFORE their consumer R-session rollbacks (R2.5/R3b/F1 respectively)
- `remediation_drop_users_dashboard_token_rollback` restores column shape only; pre-drop values are not preserved

Rollbacks tested in fresh-DB scenario: apply all rebuild migrations, apply rollbacks reverse-order, confirm `public` schema empty (except `chiefos_portal_users` FK target `auth.users` from Supabase).

---

## 7. Post-Cutover Amendments

Phase 5 cutover completed 2026-04-28 (sentinel commit `8f44ea90`). The §3 apply-order list is frozen as the cold-start contract. Amendments authored after cutover apply directly to production via `mcp__claude_ai_Supabase__apply_migration` and are listed here for traceability. Each entry has a paired rollback in `migrations/rollbacks/`.

| Apply date | File | Purpose | Rollback |
|---|---|---|---|
| 2026-04-29 | `2026_04_29_amendment_p1a7_chiefos_finish_signup_rpc.sql` | P1A-7. Path α onboarding spine RPC. Reads `auth.users.raw_user_meta_data`; creates `chiefos_tenants` + `chiefos_portal_users` + `public.users` atomically. Idempotent on `chiefos_portal_users(user_id)`. Phone collisions surface as `OWNER_PHONE_ALREADY_CLAIMED` (P0001). | `DROP FUNCTION chiefos_finish_signup(text)` |
| 2026-04-29 | `2026_04_29_amendment_p1a8_rls_recursion_fix.sql` | P1A-8. Fixes 42P17 infinite-recursion bug in 3 RLS policies that subqueried their own table (`chiefos_portal_users.portal_users_tenant_read_by_owner` + `..._owner_update_roles`; `supplier_users.supplier_users_co_supplier_select`). Adds `chiefos_owner_tenants_for(uuid)` + `chiefos_supplier_ids_for(uuid)` SECURITY DEFINER helpers as canonical pattern. Surfaced during Path α end-to-end test. | restores broken policies + drops helpers (rollback exists for completeness; not expected to fire) |
| 2026-04-29 | `2026_04_29_amendment_p1a9_legal_acceptances_unique.sql` | P1A-9. Adds missing `UNIQUE (tenant_id, auth_user_id)` to `chiefos_legal_acceptances` so `/api/legal/accept` upsert with `onConflict: 'tenant_id,auth_user_id'` resolves correctly. Was 42P10'ing at runtime; surfaced during Path α end-to-end test (legal-accept HTTP call after RPC). Same bug class as the chiefos_beta_signups upsert (caught earlier this session). | `ALTER TABLE ... DROP CONSTRAINT` |
| 2026-04-29 | `2026_04_29_amendment_p1a10_legal_acceptances_service_role_update.sql` | P1A-10. `GRANT UPDATE ON chiefos_legal_acceptances TO service_role`. Original `rebuild_identity_tenancy.sql` granted only INSERT+SELECT to service_role; PostgreSQL requires UPDATE for `INSERT ... ON CONFLICT DO UPDATE` even when no row conflicts. Was 42501'ing at runtime after P1A-9 unblocked the parser. Restores parity with peer tables. DELETE intentionally NOT granted — append-only audit posture preserved (FK CASCADE handles auth.users-row removal). | `REVOKE UPDATE` |

---

**End of manifest. Updated by replacement, not narrative append. Session history in `docs/_archive/sessions/`.**