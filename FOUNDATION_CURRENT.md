# Foundation — Current Canonical State

This is the load-when-needed summary of the Foundation Rebuild schema. It captures the identity model, current Decision-12 status, and the canonical table inventory (Phase 3 + P1A amendments) at a glance. The full design rationale, historical decisions, per-table design pages, and pre-rebuild → rebuild migration mappings live in the archived full document; this file exists so a session can confirm canonical shape without paying the cost of loading the 215KB original.

## Identity model

- **`tenant_id`** (`uuid`) — portal/RLS boundary. Every portal-facing table carries `tenant_id NOT NULL` with FK to `chiefos_tenants(id)`. Resolved via `chiefos_portal_users` membership when `auth.uid()` is present. RLS policies filter on this.
- **`owner_id`** (`text`, digit string) — ingestion/audit boundary. The tenant root identity in WhatsApp/email/backend contexts. Resolves deterministically to `tenant_id`. Every ingestion-facing or audit-facing table carries `owner_id NOT NULL` with `CHECK (char_length(owner_id) > 0)`.
- **`user_id`** (`text`, digit string) — actor identity. Scoped under `owner_id`. Never used as a sole tenant filter. Nullable on backend/system rows.
- **`auth_user_id`** (`uuid`) — Supabase auth identity. Reverse pointer for portal↔WhatsApp linkage on `public.users` (P1A-4). UNIQUE on non-NULL. Populated by OTP verification.
- **Row `id`** (`uuid`) — row identifier only. Never a tenant boundary, never an actor, never an owner.

**Dual-boundary discipline:** never collapse `tenant_id` and `owner_id` into a single ID. Portal queries filter by `tenant_id`; ingestion/backend queries filter by `owner_id`. Updates and deletes never address rows by `id` alone — they always carry the owning boundary key.

## Decision 12 status

The "actor cluster" (legacy `chiefos_tenant_actors` / actor-memory tables) is **DISCARDed**. Replaced by dual-FK on `chiefos_activity_logs` (flat rebuild shape per FOUNDATION §3.11). The actor-memory cluster (`getActorMemory` / `patchActorMemory` and callers in `services/agent/index.js`, `services/answerChief.js`, `services/orchestrator.js`) remains quarantined pending R4c — those call sites still write to the discarded `chief_actor_memory` table and will break at cutover.

The crew cluster (`services/crewControl.js`, `routes/crewControl.js`, `routes/crewReview.js`) is similarly quarantined pending R3b — writes to pre-rebuild `chiefos_activity_logs` shape.

## Canonical table list

Status legend: **P3** = Phase 3 core spine; **P1A-N** = post-Phase-3 amendment N.

### Identity & tenancy (P3, §3.1)

- `chiefos_tenants` — tenant root (P3)
- `chiefos_portal_users` — portal membership; `(tenant_id, auth_user_id)` UNIQUE (P3, status added in P1A-6)
- `users` — ingestion-identity table keyed on `user_id` digit string; `auth_user_id` reverse pointer added P1A-4

### Canonical financial spine (P3, §3.2)

- `transactions` — single canonical table for money movement; `kind` discriminates (`expense`, `revenue`, `bill`, `receipt`, `change_order`, etc.); amounts in cents; `UNIQUE (owner_id, source_msg_id, kind)` partial idempotency
- `chiefos_portal_expenses` — tenant-safe view over `transactions` filtered by expense kind

### Jobs spine (P3, §3.3)

- `jobs` — operational spine; per-tenant numbering via `job_no`; `job_int_id` for cross-table linkage

### Time spine (P3, §3.4)

- `time_entries_v2` — timeclock entries
- `mileage_logs` — mileage capture (P3, §3.4 family)

### Quotes spine (P3 + amendments, §3.5)

- `chiefos_quotes` — quote header rows
- `chiefos_quote_versions` — versioned snapshots
- `chiefos_quote_events` — lifecycle event log
- `chiefos_quote_share_tokens` — recipient-scoped share tokens
- `chiefos_quote_signatures` — captured signatures (incl. storage-backed image refs)

### Intake (non-receipt) pipeline (P3, §3.6)

- `intake_items` — generic ingestion staging
- `intake_item_reviews` — review/approval rows; `reviewed_by_portal_user_id` (post-P1A-3 rename)

### Receipt pipeline (P3, §3.7; Session 2 migrations as-is)

- `parse_jobs` — receipt parse jobs; `UNIQUE (owner_id, source_msg_id, kind) DEFERRABLE INITIALLY DEFERRED`
- `email_ingest_events` — inbound email events; `UNIQUE (postmark_msg_id)`
- `media_assets` — receipts/images/documents storage refs

### Quota architecture (P3, §3.8; Session 2 migrations as-is)

- `quota_*` family — plan-gating, consumption, allowance ledger

### Pending actions / CIL drafts (P3, §3.9)

- `cil_drafts` — staged CIL payloads (rebuild shape: uuid id, text columns, `cil_type`/`validated_at`/`committed_at` timestamps)
- `pending_actions` — TTL-bound Yes/Edit/Cancel confirm lane; `UNIQUE (owner_id, user_id, kind)` for one active lane per actor per kind

### Conversation / Chief memory (P3, §3.10)

- `conversation_sessions` — session state for Chief reasoning loop

### Audit / observability (P3, §3.11)

- `chiefos_activity_logs` — flat rebuild shape; dual-FK to tenant + actor; single write surface via `services/activityLog.js`
- `llm_cost_log` — cost tracking; `feature_kind` + `cost_cents` (post-rename)
- `chiefos_legal_acceptances` — append-only legal acceptance audit

### Supporting tables (P3 Session 3 addendum, §3.12)

- `tasks` — task tracking; `kind` column (post-rename from `type`)
- `tenant_knowledge` — tenant knowledge base; `owner_id text` (post-P1A-3 type correction)
- `reminders` — reminder dispatch
- `insight_log` — analytical insight capture

### P1A amendments — added shapes

- **P1A-1** documents flow (`migrations/2026_04_22_amendment_documents_flow.sql`): document ingestion + sign tokens
- **P1A-2** pricing items (`migrations/2026_04_22_amendment_pricing_items.sql`): pricing-item canonical rows
- **P1A-3** RAG + tenant knowledge (`amendment_rag_docs.sql`, `amendment_rag_terms.sql`, `amendment_tenant_knowledge.sql`): RAG retrieval surface; `rag_terms` UNIQUE on `lower(term)`
- **P1A-4** users.auth_user_id (`amendment_p1a4_users_auth_user_id.sql`): reverse pointer for portal↔WhatsApp linkage
- **P1A-5** submission_status (`amendment_p1a5_submission_status.sql`): adds `submission_status text NOT NULL DEFAULT 'approved'` + 4-value CHECK + partial pending-review index to `time_entries_v2` and `tasks` (resolves R3a §F2 / Option B; unblocks R3b crew-cluster migration)
- **P1A-6** portal_users.status (`amendment_p1a6_portal_users_status.sql`): membership lifecycle status

### Supplier catalog + reminders + tenant prefs (P1A series)

- `supplier_catalog_root` — supplier registry (P1A)
- `supplier_catalog_products` — supplier-scoped product catalog (P1A)
- `tenant_supplier_preferences` — tenant-level supplier ranking (P1A)

## Triggers, functions, and views

The rebuild moved away from SECURITY DEFINER as default — every function is `SECURITY INVOKER` unless the design page documents an explicit exception. View list and trigger inventory are in §4 and §5 of the archived FULL doc; portal-safe views (e.g., `chiefos_portal_expenses`) are the read surfaces — never query the underlying canonical tables from the portal.

## Need full design rationale or historical decision context?

See `docs/_archive/foundation/FOUNDATION_P1_SCHEMA_DESIGN_FULL.md` (preserved at original byte-content; only path changed).

The FULL doc contains:
- Section 1: 11 design principles + Cross-Cutting Patterns subsection
- Section 2: Table groups (architectural roles)
- Section 3: Per-table design pages (3.1–3.12, including post-amendments §3.13 Supplier Catalog and §3.14 RAG)
- Section 4: Views
- Section 5: Functions and triggers
- Section 6: Cross-reference to current database (KEEP / KEEP-WITH-REDESIGN / DISCARD classification for every pre-rebuild table)

## Last updated

2026-04-25
