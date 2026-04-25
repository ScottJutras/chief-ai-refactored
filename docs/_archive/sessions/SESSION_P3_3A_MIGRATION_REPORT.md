# Session P3-3a — Migration Authorship Report

**Date:** 2026-04-21
**Scope delivered:** Clean-sheet migrations for Sections 3.9 (Pending Actions / CIL Drafts), 3.10 (Conversation Spine — NEW), and 3.11 (Audit / Observability).
**Scope deferred to Session P3-3b:** Section 3.12 Supporting Tables (tasks, mileage_logs, overheads, stripe_events, llm_cost_log, error_logs, settings, import_batches, employee_invites, chiefos_crew_rates, customers).
**Authority:** Session P3-3a work order; `FOUNDATION_P1_SCHEMA_DESIGN.md` §3.9–§3.11.

---

## 0. Session 2a Founder-Review Items Surfaced (Carry-Forward)

Six items flagged by Session P3-2a. None block Session P3-3a.

1. **time_entries_v2 per-employee RLS policy** — design §3.4 calls for board-reads-all / employees-read-own-only; P3-2a shipped standard tenant-membership SELECT. **Affects Session 3a? No.** Default disposition: defer to P3-4 after onboarding-path audit.

2. **states.tenant_id nullable** — design §3.4 specifies NOT NULL; P3-2a kept nullable for pre-tenant rows. **Affects Session 3a? No.** Default disposition: keep nullable through P3-4.

3. **intake_item_drafts has BOTH `draft_kind` and `draft_type`** — P3-2a kept both additively. **Affects Session 3a? No.** Default disposition: retain both pending founder rename/retain confirmation.

4. **Receipt pipeline composite-FK upgrade on parse_corrections** — **RESOLVED in P3-2b**; composite FK delivered. Closed.

5. **chiefos_tenant_counters created by jobs-spine migration (shared infra)** — deliberate per §3.3. **Affects Session 3a? No.** Accepted; noted as manifest Forward Flag 1.

6. **Rollback ordering when chiefos_tenant_counters has rows from multiple spines** — acceptable risk. **Affects Session 3a? No.** Documented in jobs_spine rollback header.

**Items affecting this session:** none. **Proceeding with Session 3a authoring — no Session 2a item blocked this work.**

---

## 1. Migrations Produced

### 1.1 `migrations/2026_04_21_rebuild_pending_actions_cil_drafts.sql`

**Section 3.9.** Two tables:

- **`pending_actions`** — uuid PK, tenant_id NOT NULL FK → chiefos_tenants, owner_id + user_id text NOT NULL, kind text with format regex CHECK (`^[a-z][a-z_]*$`, 1–64 chars; product-concept registry in app-code), `UNIQUE (owner_id, user_id, kind)` (one active confirm per actor per kind), payload jsonb NOT NULL DEFAULT, expires_at DEFAULT `now() + interval '10 minutes'`, CHECK `expires_at > created_at`. RLS enabled with tenant-membership SELECT + UPDATE (INSERT/DELETE service-role only). GRANTs per Principle 9.
- **`cil_drafts`** — full rebuild from the pre-rebuild bigint-PK + varchar-columns + no-RLS shape. uuid PK, tenant_id NOT NULL FK, owner_id + user_id text NOT NULL, cil_type text with CamelCase format CHECK (product-concept registry at `src/cil/cilTypes.js`), payload jsonb NOT NULL, `source_msg_id text` + partial UNIQUE `(owner_id, source_msg_id, cil_type)` for Principle 7 idempotency, composite UNIQUE `(id, tenant_id, owner_id)` for Principle 11, validated_at + committed_at + committed_to_table + committed_to_id timestamps/traceback, trace_id NOT NULL, correlation_id NOT NULL DEFAULT `gen_random_uuid()`, commit-pair CHECK (all three commit columns null-or-set together), validate-before-commit CHECK, target_table format CHECK. Standard RLS + GRANTs.

### 1.2 `migrations/2026_04_21_rebuild_conversation_spine.sql`

**Section 3.10.** Two NEW tables (no clean predecessor).

- **`conversation_sessions`** — uuid PK, dual-boundary identity (tenant_id + owner_id + user_id), source CHECK (`'whatsapp'|'portal'`), started_at + last_activity_at + ended_at + end_reason CHECK (`'timeout'|'user_reset'|'context_limit'`), end-reason-required-if-ended CHECK, activity-after-started CHECK, `active_entities jsonb` subsuming the DISCARDed entity_summary, trace_id NOT NULL, composite UNIQUE `(id, tenant_id, owner_id)`. Indexes: `(tenant_id, last_activity_at DESC)` for portal listing; `(owner_id, last_activity_at DESC) WHERE ended_at IS NULL` for active-session routing.
- **`conversation_messages`** — uuid PK, composite FK `(session_id, tenant_id, owner_id) → conversation_sessions` with **ON DELETE CASCADE** (session deletion is rare; messages have no meaning without session — see §2 decision note), sequence_no monotonic with UNIQUE `(session_id, sequence_no)`, role CHECK (`'user'|'chief'|'system'|'tool'`), tool-row consistency CHECK (tool rows must carry tool_name; non-tool rows must not), tokens_in/out nonneg CHECKs, partial UNIQUE `(owner_id, source_msg_id)` for user-message idempotency, grounded_entities jsonb, trace_id + correlation_id NOT NULL, append-only GRANT posture (authenticated SELECT+INSERT only; service_role full verbs).

**`entity_summary` disposition: DISCARDED** per design §3.10 default. The `active_entities jsonb` column on `conversation_sessions` subsumes the entity-tracking role. Documented in the migration header; Phase 4 app-audit may revisit if a denormalized read path is found.

### 1.3 `migrations/2026_04_21_rebuild_audit_observability.sql`

**Section 3.11.** Five tables:

- **`chiefos_activity_logs`** — REDESIGN per Decision 12. uuid PK, tenant_id NOT NULL, owner_id text NOT NULL, **dual actor FKs**: `portal_user_id uuid → chiefos_portal_users(user_id)` + `actor_user_id text → users(user_id)`, at-least-one-actor CHECK, action_kind CHECK 9 values (`'create','update','delete','confirm','void','reject','export','edit_confirm','reopen'`), target_table format CHECK, trace_id + correlation_id NOT NULL. Indexes: tenant+time DESC, target+time DESC, correlation_id, portal_user partial, actor_user partial. **Append-only**: authenticated = SELECT only; service_role = SELECT+INSERT only (no UPDATE/DELETE). Hard BEFORE UPDATE/DELETE trigger deferred to P3-4.
- **`chiefos_deletion_batches`** — consolidates `chiefos_txn_delete_batches`. uuid PK, tenant_id NOT NULL, owner_id text NOT NULL, portal_user_id FK, target_table format CHECK, `target_ids text[]` NOT NULL with array-length-nonempty CHECK, undo_expires_at + undone_at timestamps with ordering CHECKs, correlation_id NOT NULL. Composite UNIQUE `(id, tenant_id, owner_id)` for Principle 11. Standard RLS + GRANTs (authenticated = SELECT+INSERT+UPDATE to mark undone).
- **`email_ingest_events`** — KEEP-WITH-REDESIGN. Preserves the pre-rebuild column set (id, tenant_id, owner_id, postmark_msg_id, from_email, subject, detected_kind, attachment_count, processing_status, source_type, created_at). Adds UNIQUE (postmark_msg_id), composite UNIQUE (id, tenant_id, owner_id), CHECKs on processing_status + detected_kind + source_type enums, explicit GRANTs (authenticated = SELECT+UPDATE; service_role = ALL — INSERT is service-role only because the api/inbound/email.js webhook handler runs in service-role context).
- **`integrity_verification_log`** — KEEP-WITH-REDESIGN. Schema tightened per §3.11: `chain` CHECK (`'transactions'|'time_entries_v2'`), `result` CHECK (`'pass'|'fail'|'partial'`), rows_checked/rows_failed nonneg, completed_at ordering, correlation_id NOT NULL. **RLS enabled** (was disabled). GRANTs: authenticated = SELECT; service_role = SELECT+INSERT (append-only).
- **`chiefos_role_audit`** — REDESIGN per Decision 12. Actor FK redesigned away from chiefos_actors: `acted_by_portal_user_id uuid NOT NULL FK chiefos_portal_users(user_id)` + `target_portal_user_id uuid NOT NULL FK chiefos_portal_users(user_id)`. action CHECK (`'promote'|'demote'|'deactivate'|'reactivate'`), correlation_id NOT NULL. **Owner/board-member SELECT only** (security-sensitive per §3.11). Append-only: authenticated = SELECT (gated by owner-only RLS); service_role = SELECT+INSERT only. Hard trigger Session P3-4.

---

## 2. Rollbacks Produced

All in `migrations/rollbacks/`:

- `2026_04_21_rebuild_pending_actions_cil_drafts_rollback.sql` — drops cil_drafts first (it could be FK-referenced by future tables), then pending_actions. Policies + indexes explicit before DROP TABLE for auditability.
- `2026_04_21_rebuild_conversation_spine_rollback.sql` — drops conversation_messages first (composite FK to sessions), then conversation_sessions. DROP CASCADE would also work given the FK, but the explicit order is clearer for operators reading the rollback.
- `2026_04_21_rebuild_audit_observability_rollback.sql` — drops 5 tables in reverse dep order: chiefos_role_audit → integrity_verification_log → email_ingest_events → chiefos_deletion_batches → chiefos_activity_logs. All policies + indexes explicit.

All use `IF EXISTS` throughout; safe to re-run.

---

## 3. Manifest Updates

`REBUILD_MIGRATION_MANIFEST.md`:
- Session history: P3-3a entry added.
- Apply order: steps 11, 12, 13 marked DELIVERED; step 7 (rebuild_customers) reassigned from P3-3 to P3-3b with a grouping note; step 14 (rebuild_supporting_tables) reassigned to P3-3b.
- Apply-order notes: P3-3a block added covering all three migrations with design rationales, FK patterns, and GRANT posture.
- DISCARDED tables section: 4 DISCARDed tables enumerated (chiefos_activity_log_events, chiefos_txn_delete_batches, entity_summary, assistant_events + chief_actor_memory + convo_state).
- Dependency Map: expanded with all 9 new tables (pending_actions, cil_drafts, conversation_sessions, conversation_messages, chiefos_activity_logs, chiefos_deletion_batches, email_ingest_events, integrity_verification_log, chiefos_role_audit) showing FK targets + Principle 11 composite-UNIQUE annotations.
- Forward Flags: #11 (P3-4 append-only triggers for audit tables), #12 (entity_summary DISCARD revisit condition), #13 (chiefos_activity_logs actor semantics — Phase 4 app audit), #14 (cil_drafts type coercion from pre-rebuild shape — Phase 5 backfill).
- Rollback Posture: 3 new rollbacks listed; reverse apply order extended through steps 1–13.

---

## 4. entity_summary DISCARD Decision

**Decision: DISCARD.** The default per design §3.10.

**Rationale:** The role of entity_summary is "per-tenant tracked entity state for reference resolution" — what Chief last mentioned for disambiguating follow-up questions. That role is subsumed by the `active_entities jsonb` column on `conversation_sessions`, which:
- Scopes naturally per session (the right granularity — "what Chief last mentioned" is session-scoped, not tenant-scoped)
- Lives on the same row as other session state; single source of truth
- Avoids a separate table with its own RLS/GRANT surface
- Matches the Plan V2 Session 2 design intent ("use active_entities inline")

**Revisit condition:** A Phase 4 app-code audit of the Ask Chief handler may reveal a denormalized per-entity read path (e.g., a query like `SELECT * FROM entity_summary WHERE tenant_id = $1 AND entity_kind = 'job' ORDER BY last_mentioned_at DESC LIMIT 5`). If that path exists and cannot be efficiently served from `active_entities jsonb`, a future migration (likely P3-3b or P3-4) can add a denormalized `entity_summary` table with `tenant_id` + RLS. Absent evidence of such a path, DISCARD is correct.

**Status:** Recorded as manifest Forward Flag 12.

---

## 5. Flagged Items for Founder Review

1. **chiefos_activity_logs actor semantics — system-initiated actions have no natural actor.** The at-least-one-actor CHECK requires either `portal_user_id` or `actor_user_id` to be set. System-initiated writes (cron, triggers, migrations, integrity-chain repairs) don't have a clean actor. **Options for Phase 4:**
   - (a) Designate a system row in `public.users` (e.g., user_id = 'system') and route all system-initiated audit rows through it.
   - (b) Relax the CHECK to allow both-NULL rows with a new `system_action_reason text` column.
   - (c) Route system actions through a designated owner-actor where the concept applies (e.g., a cron running on behalf of owner X uses owner X's user_id).
   **Recommendation:** (a) — cleanest; preserves the invariant; add one `users` row per deploy. **Flagged for Phase 4 app-code audit.**

2. **cil_drafts type coercion from pre-rebuild shape.** Pre-rebuild table used bigint id, varchar owner_id, varchar kind, no tenant_id, no RLS, and a `status` column (values not documented in the design page). The rebuild uses uuid id, text throughout, composite UNIQUE (id, tenant_id, owner_id), standard RLS, `cil_type` name instead of `kind`, and drops `status` in favor of timestamp pair `validated_at / committed_at`. **Phase 5 data backfill** (if any rows exist at rebuild time) requires explicit coercion:
   - Generate fresh uuids (bigint ids don't map)
   - Assign tenant_id by joining on owner_id → chiefos_tenants
   - Rename kind → cil_type; retain the value (both registries overlap)
   - Derive validated_at + committed_at from status column (status='draft' → both null; status='validated' → validated_at=updated_at; status='committed' → both=updated_at)
   **Not blocking P3-3a migration authoring.** Flagged as a Phase 5 cutover item.

3. **cil_type CamelCase format** (`^[A-Z][A-Za-z0-9]*$`). Design §3.9 says "`('LogExpense','LogRevenue','CreateQuote','CreateInvoice','Clock','CreateTask','ChangeOrder', ...)`". The migration uses a CamelCase format CHECK rather than a closed enum so the list can grow without coordinated DB migrations. Matches the `chiefos_tenant_counters.counter_kind` precedent. **Confirmation requested:** is the format CHECK sufficient, or should the design list become a closed enum CHECK? **Recommendation:** format CHECK. Lower-friction for feature additions. Product-concept registry in app-code is the authoritative source.

4. **conversation_messages ON DELETE CASCADE on the composite FK to conversation_sessions.** Session deletion is rare (retention cleanup after long inactivity, user explicit delete-account flow). When it happens, messages without a session have no meaning. Chose CASCADE over RESTRICT to make session deletion a clean operation. **Confirmation requested.** **Recommendation:** keep CASCADE.

5. **chiefos_role_audit FK to chiefos_portal_users on BOTH `acted_by_portal_user_id` and `target_portal_user_id`.** Two FKs to the same table. Both ON DELETE RESTRICT — a portal user cannot be deleted while role-audit rows reference them. **Confirmation requested:** if a user self-deletes (future GDPR / data-retention flow), do those audit rows need special handling? **Recommendation for Phase 4:** when a user self-deletes, null out the portal_user_id references in role_audit (changing RESTRICT to SET NULL for a trailing audit); add a `deleted_target_user_hint jsonb` for forensic traceability. Not blocking; flagged for the future data-retention policy.

6. **email_ingest_events INSERT posture.** The webhook handler (`api/inbound/email.js`) runs in service-role context. Authenticated gets SELECT + UPDATE (for portal dashboards marking processing_status). No INSERT policy for authenticated — deliberate, since the portal UI should never directly insert email events. **Confirmation requested.** **Recommendation:** as shipped — INSERT via service_role only.

---

## 6. Split Decision

**No split.** Session 3a completed within scope. All three migrations were authored with clean design quality; no scope pressure emerged. Section 3.12 (Supporting Tables) proceeds as planned to Session P3-3b.

---

## 7. Readiness for Session P3-3b

**Blocked on:** nothing.

**P3-3b inputs already in place:**
- Session 3a's three migrations + rollbacks are idempotent and independently applicable.
- The audit surface (chiefos_activity_logs) is the target for most §3.12 tables' audit trail — they can emit activity-log rows at INSERT/UPDATE time.
- `chiefos_deletion_batches` is the target for §3.12 soft-delete tracking (tasks, mileage_logs).
- Manifest apply order positions §3.12 at step 14 (after step 13 audit_observability); no ordering issues.

**P3-3b work items (per Session 3a work order Step 4 note; exact list per §3.12):**
1. Author `rebuild_customers.sql` (step 7 in apply order; Quotes spine dependency).
2. Author `rebuild_supporting_tables.sql` (step 14) covering: tasks, mileage_logs, overheads, stripe_events, llm_cost_log, error_logs, settings, import_batches, employee_invites, chiefos_crew_rates, customers — or split across multiple files if size warrants.
3. Matching rollbacks.
4. Update manifest.
5. Produce `SESSION_P3_3B_MIGRATION_REPORT.md`.

**Consideration for P3-3b:** if `customers` design is substantial (the live DB has it; design §3.12 specifies the rebuild shape), author it as its own file `rebuild_customers.sql` separate from the generic `rebuild_supporting_tables.sql`. Confirms with the manifest's step-7 / step-14 split.

---

## 8. File Inventory

**Created in P3-3a:**
```
migrations/2026_04_21_rebuild_pending_actions_cil_drafts.sql
migrations/2026_04_21_rebuild_conversation_spine.sql
migrations/2026_04_21_rebuild_audit_observability.sql
migrations/rollbacks/2026_04_21_rebuild_pending_actions_cil_drafts_rollback.sql
migrations/rollbacks/2026_04_21_rebuild_conversation_spine_rollback.sql
migrations/rollbacks/2026_04_21_rebuild_audit_observability_rollback.sql
SESSION_P3_3A_MIGRATION_REPORT.md
```

**Updated in P3-3a:**
```
REBUILD_MIGRATION_MANIFEST.md (apply order, DISCARDED tables, dependency map, forward flags, rollback ordering)
```

**Untouched, pre-existing:**
- All P3-1, P3-2a, P3-2b migrations + rollbacks.
- All app code (src/**, api/**, services/**).
- `FOUNDATION_P1_SCHEMA_DESIGN.md` (read-only input).

---

Phase 3 Session 3a complete. Ready for Phase 3 Session 3b (Section 3.12 supporting tables).
