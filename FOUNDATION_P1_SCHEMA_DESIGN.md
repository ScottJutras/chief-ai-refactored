# Foundation Rebuild Phase 1 — Schema Design

**Status:** Design specification. Not migration code. Migrations are authored in Phase 3 after founder approval of this design.
**Date:** 2026-04-21
**Phase:** Phase 1 of 6 (Foundation Rebuild V2)
**Authority:** `FOUNDATION_REBUILD_PLAN_V2.md` §5 Phase 1
**Sources:** `01_CHIEFOS_NORTH_STAR.md`, `03_CHIEFOS_ENGINEERING_CONSTITUTION.md`, `04_CHIEFOS_MONETIZATION_AND_PRICING.md`, `02_CHIEFOS_EXECUTION_PLAYBOOK.md`, `RECEIPT_PARSER_UPGRADE_HANDOFF.md` §5, the seven Session 2 migration files, `SESSION_2_5_SCHEMA_DRIFT_CATALOG.md`.

---

## Table of Contents

1. Design Principles (11 principles + Cross-Cutting Patterns subsection)
2. Table Groups (architectural roles)
3. Per-Table Design Pages
   - 3.1 Identity & Tenancy
   - 3.2 Canonical Financial Spine
   - 3.3 Jobs Spine
   - 3.4 Time Spine
   - 3.5 Quotes / Invoices / Contracts Spine (preservation treatment)
   - 3.6 Intake (Non-Receipt) Pipeline
   - 3.7 Receipt Pipeline (Session 2 migrations, as-is)
   - 3.8 Quota Architecture (Session 2 migrations, as-is)
   - 3.9 Pending Actions / CIL Drafts
   - 3.10 Conversation / Chief Memory
   - 3.11 Audit / Observability
   - 3.12 Supporting Tables (Session 3 addendum)
4. Views
5. Functions and Triggers
6. Cross-Reference to Current Database

This document was produced across three Phase 1 sessions per Plan V2. **Session 1 delivered Sections 1, 2, and Section 3 for the five foundational table groups. Session 2 delivered the remainder, incorporated the 13 closed founder decisions, added Principle 11 and the Cross-Cutting Patterns subsection, and produced the exhaustive Section 6 classification. Session 3 addendum added Section 3.12 with dedicated design pages for the KEEP-WITH-REDESIGN tables that didn't fit the 11 primary table groups.**

---

## 1. Design Principles

This schema embodies eleven architectural principles plus a Cross-Cutting Patterns subsection imported from the Quotes spine Phase 3 §27 formalization. Each principle is grounded in an authoritative doc. Every table in Sections 3–5 derives from these principles. Every DISCARD decision in Section 6 is defended against them. If a reviewer finds a table that violates a principle, that's a design bug that gets fixed before migrations are written.

### 1.1 Dual-Boundary Identity Is Never Collapsed

*North Star §3, §6; Engineering Constitution §2, §4, §6.*

Three identity keys serve three different roles:

| Key | Type | Role | Required on |
|---|---|---|---|
| `tenant_id` | `uuid` | Portal/RLS boundary. Resolved via `chiefos_portal_users` membership when `auth.uid()` is present. | Every portal-facing table. NOT NULL. |
| `owner_id` | `text` (digit string) | Ingestion/audit boundary. The tenant root identity in WhatsApp/email/backend contexts. Resolves deterministically to `tenant_id`. | Every ingestion-facing or audit-facing table. NOT NULL. |
| `user_id` | `text` (digit string) | Actor identity. Scoped under `owner_id`. Never a tenant boundary by itself. | Tables where actor attribution matters. Nullable for backend/system rows. |
| row `id` | `uuid` | Row identifier only. Never a boundary, never an actor. | Every table as the primary key. |

**Rules encoded in the design:**
- Every table that is portal-facing has `tenant_id uuid NOT NULL` and an FK to `chiefos_tenants(id)`.
- Every table written from the ingestion pipeline has `owner_id text NOT NULL` with a `CHECK (char_length(owner_id) > 0)`.
- No table uses `user_id` as a sole filter. RLS policies filter on `tenant_id`; backend queries filter on `owner_id` + (when actor-specific) `user_id`.
- No column is named ambiguously. `id` is always the row identifier; tenant/owner/user identity gets explicit names.

### 1.2 One Mind, Many Senses

*North Star §3.*

Exactly one reasoning seat per tenant (the Owner via Chief). Scaling happens by adding ingestion identities, not by adding reasoning seats. The schema reflects this:

- `chiefos_portal_users.role` includes `'owner'`, `'board_member'`, `'employee'`, but only `'owner'` may read the Chief-grade reasoning surface.
- No table grants "assistant" or "second brain" access to a non-owner user.
- Ingestion identities (phone numbers, email forwarders) are captured under `users` (an ingestion-identity table keyed on the digit string `user_id`), not under `chiefos_portal_users` (the portal login table keyed on `auth.uid()`).

### 1.3 Canonical Financial Spine

*North Star §7; Engineering Constitution §7, §8.*

All money flows through a single table: `public.transactions`. One row per event. `kind` discriminates (`expense`, `revenue`, `bill`, `receipt`, `change_order`, etc.). Amounts in cents (`bigint`). Idempotent by construction via `(owner_id, source_msg_id, kind)`. Dedupe-hashed for content-based replay detection.

Legacy siblings (`expenses`, `revenue`, `chiefos_expenses`, `chiefos_expenses_receipts` view) are tracked-down siblings that predate the unification. **They are all DISCARDED.** Portal reads go through tenant-safe views (e.g., `chiefos_portal_expenses`) that query `transactions` with the appropriate `kind` filter.

### 1.4 Jobs Are the Operational Spine

*North Star §10; Execution Playbook §2 (MVP scope).*

Everything that happens on a tenant's books is attachable to a job. Every transaction, time entry, photo, document, and quote carries `job_id` (nullable when capture is pre-resolution; required before confirm). Per-tenant human-readable numbering lives in `jobs.job_no`, allocated via a tenant-scoped counter table.

### 1.5 CIL Enforcement at the Write Boundary

*North Star §8; Engineering Constitution §7.*

All ingestion follows: Ingress → CIL Draft → Validation → Domain Mutation. The schema supports this:

- `cil_drafts` stores CIL payloads before they become canonical (the staging lane between confirm and commit).
- `pending_actions` stores confirm-flow state (the TTL-bound Yes/Edit/Cancel lane).
- The domain write (`domain/transactions.js::logExpense`) is the only path that writes to `public.transactions`. This is an app-code discipline — the schema just makes sure no shortcut exists through the ingestion surface.

### 1.6 Fail-Closed on Tenant Resolution

*Engineering Constitution §4; North Star §5.*

If tenant resolution is ambiguous (a phone digit matches two tenants, an email forwarder isn't linked), the write refuses. The schema supports this:

- `tenant_id` is NOT NULL on every canonical table.
- Tenant resolution tables (`users.owner_id`, `chiefos_portal_users.tenant_id`) have tight uniqueness so ambiguity is detectable.
- No "fall back to first tenant" nullable tenant columns exist.

### 1.7 Idempotency Is a Schema Property, Not Hope

*Engineering Constitution §8.*

Every write carries enough identity to deduplicate deterministically:

- `transactions`: `UNIQUE (owner_id, source_msg_id, kind)` partial index (where `source_msg_id IS NOT NULL`). Plus a content-based `dedupe_hash` for replays that share `source_msg_id` across kinds.
- `parse_jobs` (from Session 2): `UNIQUE (owner_id, source_msg_id, kind) DEFERRABLE INITIALLY DEFERRED`.
- `email_ingest_events`: `UNIQUE (postmark_msg_id)`.
- `pending_actions`: `UNIQUE (owner_id, user_id, kind)` (one active confirm lane per actor per kind).

Retries never create duplicates; replays are safe.

### 1.8 RLS on Every Tenant-Scoped Table

*Engineering Constitution §2, §4, §6.*

If a table carries `tenant_id`, it has RLS enabled and at least three policies:

- `<table>_tenant_read` — `USING (tenant_id IN (SELECT tenant_id FROM chiefos_portal_users WHERE user_id = auth.uid()))`
- `<table>_tenant_write` — same predicate on `WITH CHECK` for INSERT
- `<table>_tenant_update` — same predicate on both `USING` and `WITH CHECK` for UPDATE

DELETE is not exposed through RLS by default. Deletes flow through application code in service-role context with audit emission. Some tables deliberately relax this (e.g., owner-only DELETE on their own jobs); those are marked explicitly in the design pages.

### 1.9 GRANTs Are Explicit

*Session 2 discovery, Session 3 diagnostic.*

Every migration that creates a table or view includes explicit `GRANT` statements to both `authenticated` and `service_role`. No reliance on Supabase's default ACLs via `supabase_admin`. This is the single most important delta from the current schema — 26 tables today fail portal requests because their GRANTs were never committed to a migration.

Default grant pattern per table kind:

| Table kind | authenticated | service_role |
|---|---|---|
| Portal-writable (jobs, transactions, pending_actions) | SELECT, INSERT, UPDATE | SELECT, INSERT, UPDATE, DELETE |
| Portal-readable only (quota_*, parse_corrections) | SELECT | SELECT, INSERT, UPDATE, DELETE |
| Append-only audit (chiefos_legal_acceptances, quota_consumption_log) | SELECT | SELECT, INSERT |
| Backend-only (states, locks, pending_actions) | — | SELECT, INSERT, UPDATE, DELETE |

### 1.10 No SECURITY DEFINER Without Documented Justification

*Engineering Constitution §5 (migration rules); Session 2.5 red flag.*

Default stance: `SECURITY INVOKER` on every function. `SECURITY DEFINER` is allowed only when:

1. The function needs privileges its callers don't have (e.g., reading across tenants for a dashboarded metric)
2. The operation is impossible to express as an RLS policy
3. The function signature accepts narrow arguments that cannot be manipulated to escalate privileges
4. The design document (this file) contains an explicit justification paragraph per SECDEF function

The current schema has 20 SECURITY DEFINER functions, none of which meet this bar. Phase 2 adjudicates each one; most will be re-implemented as RLS policies or moved to app code. The design's default assumption is zero SECDEF functions survive to Phase 3.

### 1.11 Composite-Key FK Tenant Integrity

*Quotes spine Phase 3 §27 formalization; verified in `FOUNDATION_P1_VERIFICATION_REPORT.md` (98 composite FK rows across the spine).*

Cross-spine foreign keys between tenant-scoped tables use composite keys including `tenant_id` (and where applicable, `owner_id`), not simple `id` references. This makes cross-tenant leakage a schema-level impossibility: an FK from `chiefos_quote_versions` into `chiefos_quotes` via `(quote_id, tenant_id)` rejects writes that reference a quote from the wrong tenant at the database level, before RLS evaluates.

The Quotes spine's 98 composite-FK rows are the production precedent for this pattern. The rebuild generalizes it to every cross-spine FK between tenant-scoped tables. Single-column FKs remain acceptable for:

- FKs from tenant-scoped tables into reference/system tables (`users`, `chiefos_tenants`)
- FKs within a single table (self-references, e.g., `time_entries_v2.parent_id → time_entries_v2.id`)
- Cases where the referenced table has no `tenant_id`

Enforcement requires a composite `UNIQUE (id, tenant_id)` (or `UNIQUE (id, tenant_id, owner_id)`) on the referenced table so the FK target is resolvable. Session 2's parse-pipeline tables already adopted this pattern (`parse_jobs_identity_unique` on `(id, tenant_id, owner_id)` is the documented precedent outside the Quotes spine).

### Cross-Cutting Patterns from Quotes Spine Phase 3 §27

The Quotes spine's production-hardened build formalized six patterns that apply system-wide. These are referenced (not re-derived) by other spine design pages when they face analogous design questions. They are architectural reference points, not re-designable in this rebuild.

**§17.19 — Post-commit paired notification events.** Lifecycle event emitted inside the transaction; `notification.*` event emitted after the external call completes. Neither rethrows the external error. Applies wherever a state transition triggers both a durable event log and an external notification (email, SMS, webhook). The pattern lives in app code; the schema supports it via the `chiefos_quote_events` table's `kind` enum that includes both lifecycle and notification-status event types.

**§17.20 — Pre-BEGIN external write for strict-immutable INSERT.** When the INSERT target is strict-immutable AND requires external-system content (e.g., a signature PNG must exist in storage before the immutable signature row is inserted), the external write happens before the transaction begins. Applies to signatures today; future invoice PDFs and contract documents will follow the same pattern. Schema support: strict-immutability triggers on the target table fail closed, forcing callers to sequence writes correctly.

**§17.21 — `correlation_id` discipline.** A single UUID threaded through all events emitted by one handler invocation. Enables forensic reconstruction of a single business action's full event trail. Applies to every handler in the system, not just quotes. Schema support: every event/audit table in the rebuild carries `correlation_id uuid` (not NULL, unique when combined with event sequence).

**§17.22 — Invariant-assertion discipline.** Assert invariants at the earliest cheap boundary. Prefer pre-transaction loaders that fail closed on tenant mismatch or integrity violation over mid-transaction checks. Applies universally. Schema support: composite FK tenant integrity (Principle 11) is the DB-layer realization of this pattern — invariants enforced before RLS, not after.

**§14.11 — Customer-initiated actor role (auth-orthogonal).** The role of the contractual party on the other side of a quote/invoice/contract is orthogonal to the authentication mechanism. A customer signing a quote is not a `chiefos_portal_users` row; they're a `customers` row, with the signing action recorded as an event referencing `chiefos_quote_signatures`. Refines Principle 1 (dual-boundary identity) for external parties — they get a fourth identity surface: `customers.id` (uuid), tenant-scoped, auth-less.

**§14.12 — Customer-initiated actions not plan-gated.** Actions taken by customers (viewing a shared quote, signing a quote, completing a payment) are not subject to the contractor's plan tier quotas. Only contractor-initiated actions consume plan-tier quotas. Refines Principle 9 (GRANTs are explicit) for external-party actions: the share-token-read path has no quota decrement; signature POST has no quota decrement.

---

## 2. Table Groups (Architectural Roles)

The rebuilt schema has eleven table groups. Each group has a single architectural responsibility. A table lives in exactly one group; cross-group references are through well-defined keys.

### 2.1 Identity & Tenancy *(Section 3.1 — this session)*

**Role:** Every identity the system recognizes — tenants, portal users, ingestion identities, and the mappings between them. Establishes the dual-boundary model at the storage layer. Home of legal acceptances, beta signup tracking, and the signup handshake between anonymous sign-up and authenticated tenant creation.

### 2.2 Canonical Financial Spine *(Section 3.2 — this session)*

**Role:** The one ledger of record for all money — `public.transactions` — plus the export surface (`file_exports`) and the media-asset references that evidence each transaction (`media_assets`). Every portal-facing financial view is a query over this group; nothing else writes money.

### 2.3 Jobs Spine *(Section 3.3 — this session)*

**Role:** Jobs are the units of work. This group holds the job record itself, phases, attached photos, portal sharing tokens for those photos, and the per-tenant numbering counter that gives every job a human-readable `job_no`. Everything in the financial spine and time spine carries a `job_id` pointing here.

### 2.4 Time Spine *(Section 3.4 — this session)*

**Role:** Canonical timeclock entries (`time_entries_v2`), in-flight state machines (`timeclock_prompts`, `timeclock_repair_prompts`), aggregates that the portal reads directly (`timesheet_rollups`), period locks that freeze exported periods, employee records, employer policy (pay/break/drive rules), and the small state/lock tables that the WhatsApp handler uses for coordination.

### 2.5 Quotes / Invoices / Contracts Spine *(Section 3.5 — Session 2)*

**Role:** The six `chiefos_quotes_*` tables from the quotes spine migration, providing draft → sent → signed → locked lifecycle with DB-level immutability after signing. Incorporates as-is from `2026_04_18_chiefos_quotes_spine.sql`, `_quote_versions`, `_quote_line_items`, `_quote_events`, `_quote_share_tokens`, `_quote_signatures`.

### 2.6 Intake (Non-Receipt) Pipeline *(Section 3.6 — Session 2)*

**Role:** Portal upload + voice + PDF + email-lead intake. Per Plan V2 Session 2 decision, `intake_items` is preserved as the canonical surface for non-receipt capture kinds (voice notes, PDF documents, email leads). Receipts, by contrast, route through `parse_jobs` (Session 2.7).

### 2.7 Receipt Pipeline *(Section 3.7 — Session 2)*

**Role:** The three tables produced by the Receipt Parser Upgrade Session 2 migrations: `parse_jobs` (per-receipt tracking row with OCR + LLM auditor state), `vendor_aliases` (tenant-scoped merchant memory — the enrichment moat), `parse_corrections` (per-field owner-correction log). Incorporated as-is from the tested Session 2 migration file.

### 2.8 Quota Architecture *(Section 3.8 — Session 2)*

**Role:** The four quota tables from Session 2: `quota_allotments` (per-bucket quota state), `quota_consumption_log` (audit trail of every metered call), `addon_purchases_yearly` (1,000-pack annual limit enforcement), `upsell_prompts_log` (once-per-month upsell trigger dedup). Incorporated as-is from the tested Session 2 migration file. Matches Engineering Constitution §11 architecture.

### 2.9 Pending Actions / CIL Drafts *(Section 3.9 — Session 2)*

**Role:** The in-flight confirmation state. `pending_actions` holds YES/EDIT/CANCEL state with TTL per `(owner_id, user_id, kind)`. `cil_drafts` stores the draft CIL payload between draft-build and commit. These are the staging lanes that make CIL enforcement possible.

### 2.10 Conversation / Chief Memory *(Section 3.10 — Session 2)*

**Role:** Per North Star §14, Chief maintains multi-turn conversation context. The schema holds `conversation_sessions` and `conversation_messages`, tenant-scoped, plus a lightweight `entity_summary` store for the "what did we just talk about" state reference. Existing tables `assistant_events`, `chief_actor_memory`, `convo_state`, `entity_summary` from the drift catalog will be reviewed in Session 2 and either redesigned into this group or DISCARDED.

### 2.11 Audit / Observability *(Section 3.11 — Session 2)*

**Role:** Attribution and trace logging. Every canonical write carries `trace_id` (not a column on every table, but a cross-reference key in logs). This group captures: `email_ingest_events` (per-message audit), quota logs (already in 2.8), legal acceptances (already in 2.1), and a small `chiefos_deletion_batches` table for undo-able deletes. The design prefers one audit table per concern rather than one mega-audit-table.

---

## 3. Per-Table Design Pages

### 3.1 Identity & Tenancy

This group has four canonical tables plus two compliance/handshake tables. The current database has ~14 identity-related tables; **10 are DISCARDED** in this design. The sprawl is the best single example of the drift problem: iterative bolt-ons for features that should have been expressed inside the existing dual-boundary model.

---

#### Table: `public.chiefos_tenants`

**Role:** One row per business using ChiefOS. The tenant root identity. Every other tenant-scoped table FKs to `id`.

**Authoritative source:** North Star §3 (One Mind, Many Senses), §6 (Dual-Boundary Identity); Constitution §2.

**Identity model:** `tenant_id` is this table's own `id`. `owner_id` is stored here as the digit-string identity corresponding to this tenant (the canonical WhatsApp owner).

**Columns:**

| name | type | nullability | default | description |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK; the `tenant_id` used everywhere |
| `owner_id` | `text` | NOT NULL | — | Digit-string owner identity (canonical WhatsApp sender) |
| `name` | `text` | NOT NULL | — | Business name |
| `tz` | `text` | NOT NULL | `'America/Toronto'` | IANA timezone (used by timeclock, date display) |
| `country` | `text` | NOT NULL | `'CA'` | ISO country code |
| `province` | `text` | nullable | — | Subdivision (province/state) |
| `currency` | `text` | NOT NULL | `'CAD'` | ISO 4217 (`CAD` or `USD`) |
| `tax_code` | `text` | NOT NULL | `'NO_SALES_TAX'` | Tax region code for CIL enrichment |
| `region` | `text` | nullable | — | Finer-grained region for policy lookup |
| `email_capture_token` | `text` | nullable | — | Unique slug for email-ingest forwarding address |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |
| `updated_at` | `timestamptz` | NOT NULL | `now()` | |

**Constraints:**
- `UNIQUE (owner_id)` — one tenant per owner digit-string (rejects phone collisions; Phase 2 of this plan must enforce the one-tenant-per-phone invariant in signup flow too)
- `UNIQUE (email_capture_token)` partial index on non-null
- `CHECK (char_length(owner_id) >= 7 AND owner_id ~ '^\d+$')` — digit-string format
- `CHECK (currency IN ('CAD','USD'))` — monetization doc §2 currency set
- `CHECK (country = upper(country) AND char_length(country) = 2)` — ISO-2

**Indexes:**
- `chiefos_tenants_owner_idx` on `(owner_id)` — ingestion lookup
- `chiefos_tenants_token_idx` (unique, partial) on `(email_capture_token)` where non-null — email-ingest resolver

**RLS:** Enabled. Policies:
- `chiefos_tenants_portal_select` — `USING (id IN (SELECT tenant_id FROM chiefos_portal_users WHERE user_id = auth.uid()))` for SELECT
- `chiefos_tenants_portal_insert` — authenticated can insert if they own the tenant (signup handshake)
- `chiefos_tenants_owner_update` — `USING` owner in membership as `'owner'` role

**GRANTs:** `authenticated` = SELECT, INSERT, UPDATE. `service_role` = SELECT, INSERT, UPDATE, DELETE.

**Classification vs. current:** KEEP-WITH-REDESIGN. Current table has 11 cols with similar shape; design adds `updated_at`, tightens defaults, adds missing UNIQUE on `owner_id` (which today would allow two tenants with the same phone — a fail-closed violation).

**Cross-tenant isolation test:** Create two tenant rows with overlapping `owner_id` last-4 digits but distinct full values; verify SELECT as Tenant A's portal user returns exactly one row (Tenant A's). Tested in Session 2 for seven other tables; pattern identical here.

---

#### Table: `public.chiefos_portal_users`

**Role:** Maps Supabase Auth users (`auth.users.id`) to tenants with role. The RLS linchpin — every tenant-scoped policy subselects this table on `auth.uid()`.

**Authoritative source:** North Star §6; Constitution §2 (portal boundary); Constitution §4 (RLS pattern).

**Identity model:** `user_id` is `auth.users.id` (uuid). `tenant_id` is `chiefos_tenants.id`. Composite key.

**Columns:**

| name | type | nullability | default | description |
|---|---|---|---|---|
| `user_id` | `uuid` | NOT NULL | — | FK → `auth.users(id) ON DELETE CASCADE` |
| `tenant_id` | `uuid` | NOT NULL | — | FK → `chiefos_tenants(id) ON DELETE RESTRICT` |
| `role` | `text` | NOT NULL | — | `'owner'` \| `'board_member'` \| `'employee'` |
| `can_insert_financials` | `boolean` | NOT NULL | `false` | Granular override; board/employee usually false |
| `created_at` | `timestamptz` | NOT NULL | `now()` |  |

**Constraints:**
- PK is `user_id` alone (one auth user belongs to exactly one tenant). Matches current DB; established pattern.
- `CHECK (role IN ('owner','board_member','employee'))`

**Indexes:**
- `chiefos_portal_users_tenant_idx` on `(tenant_id)` — for "list members of tenant" queries
- `chiefos_portal_users_role_idx` on `(tenant_id, role)` where `role = 'owner'` — fast owner lookup for reasoning-seat checks

**RLS:** Enabled. Policies:
- `portal_users_self_select` — `USING (user_id = auth.uid())`
- `portal_users_tenant_read_by_owner` — `USING (tenant_id IN (SELECT tenant_id FROM chiefos_portal_users WHERE user_id = auth.uid() AND role = 'owner'))` for SELECT (owners can read their tenant's membership list)
- `portal_users_owner_update_roles` — owners can update roles in their tenant (with CHECK that they can't demote themselves to non-owner)
- Signup-flow INSERT policy restricted to new tenants created in the same transaction

**GRANTs:** `authenticated` = SELECT, INSERT, UPDATE. `service_role` = ALL.

**Classification:** KEEP-AS-IS (structure) with GRANT backfill. Current table has the right shape; only the GRANTs on migrations are missing.

**Cross-tenant isolation test:** Two users in two tenants — verify neither can see the other's role assignment. Verify a non-owner cannot elevate themselves to owner.

---

#### Table: `public.users`

**Role:** Ingestion identities. One row per WhatsApp phone number (or future channel identifier) that has ever interacted with ChiefOS. Keyed by digit-string `user_id`. Stores plan, tier, subscription state, onboarding state, and the tenant mapping via `owner_id`.

**Authoritative source:** North Star §6 (Ingestion/Audit Boundary); Monetization §2 (tier on `users.plan_key`); Constitution §2.

**Identity model:** `user_id` is the digit-string (phone without `+`). `owner_id` is this user's tenant root (may equal `user_id` if the user is the owner, else points to the owner's `user_id`). No uuid here — this is deliberately the ingestion-side table.

**Columns (slimmed from the current 54 to 21 — see DISCARD rationale below):**

| name | type | nullability | default | description |
|---|---|---|---|---|
| `user_id` | `text` | NOT NULL | — | PK — digit-string phone |
| `owner_id` | `text` | NOT NULL | — | Tenant root digit-string (`= user_id` for owners) |
| `tenant_id` | `uuid` | NOT NULL | — | FK → `chiefos_tenants(id)` |
| `name` | `text` | nullable | — | Display name |
| `email` | `text` | nullable | — | Contact email |
| `role` | `text` | NOT NULL | `'owner'` | `'owner'` \| `'employee'` \| `'contractor'` |
| `plan_key` | `text` | NOT NULL | `'free'` | `'free'` \| `'starter'` \| `'pro'` \| `'enterprise'` |
| `tz` | `text` | nullable | — | Overrides `chiefos_tenants.tz` per-user when present |
| `timezone` | *removed* | — | — | Use `tz` only (current has both; DISCARD duplicate) |
| `stripe_customer_id` | `text` | nullable | — | Stripe customer |
| `stripe_subscription_id` | `text` | nullable | — | Current Stripe subscription |
| `stripe_price_id` | `text` | nullable | — | Active price id |
| `sub_status` | `text` | nullable | — | Stripe subscription status mirror |
| `current_period_start` | `timestamptz` | nullable | — | Stripe period start |
| `current_period_end` | `timestamptz` | nullable | — | Stripe period end |
| `cancel_at_period_end` | `boolean` | NOT NULL | `false` | Stripe cancellation flag |
| `terms_accepted_at` | `timestamptz` | nullable | — | Convenience mirror from `chiefos_legal_acceptances`; authoritative copy lives there |
| `onboarding_completed` | `boolean` | NOT NULL | `false` | Onboarding gate |
| `can_edit_time` | `boolean` | NOT NULL | `false` | Per-user permission granular override |
| `created_at` | `timestamptz` | NOT NULL | `now()` |  |
| `updated_at` | `timestamptz` | NOT NULL | `now()` |  |

**Columns DISCARDED from the current table (33):**

Legacy / dormant / duplicate:
- `country`, `province`, `business_country`, `business_province` — duplicates of fields on `chiefos_tenants`; tenant is the source of truth
- `spreadsheet_id` — legacy pre-DB capture destination, no longer used
- `token_usage`, `trial_start`, `trial_end`, `subscription_tier` (replaced by `plan_key`), `paid_tier` (duplicate of `plan_key`), `current_stage`, `training_completed`, `historical_data_years`, `historical_parsing_purchased` — old onboarding/trial framework
- `team_members`, `team`, `is_team_member` — should live on `chiefos_portal_users` with role membership
- `dashboard_token` — deprecated auth path
- `otp`, `otp_expiry`, `last_otp`, `last_otp_time` — phone-pairing flow uses `portal_phone_link_otp` instead (cleaner separation)
- `fiscal_year_start`, `fiscal_year_end`, `recap_time_pref` — product features that either live on `chiefos_tenants` or don't exist yet
- `reminder_needed` — obsolete reminder dispatch flag; replaced by dedicated `reminders` table (deferred to Session 2)
- `goal`, `goal_progress`, `goal_context` — growth-planning feature never shipped; DISCARD until spec'd
- `industry` — no feature references it
- `onboarding_in_progress` — use `onboarding_completed = false` instead
- `ocr_upgrade_prompt_shown`, `stt_upgrade_prompt_shown`, `export_upgrade_prompt_shown`, `crew_upgrade_prompt_shown` — Monetization §6 mandates once-per-(owner, feature, trigger, month) — now lives in `upsell_prompts_log` (Session 2 migration), not on this table. The fire-once-ever semantics were wrong for multi-month behavior.

Each DISCARD listed above is defensible against app-code grep; Phase 4 will confirm.

**Constraints:**
- PK: `user_id`
- `UNIQUE (owner_id, user_id)` composite to assert the dual-boundary pair (partial index where they differ)
- `CHECK (char_length(user_id) >= 7 AND user_id ~ '^\d+$')`
- `CHECK (char_length(owner_id) >= 7 AND owner_id ~ '^\d+$')`
- `CHECK (role IN ('owner','employee','contractor'))`
- `CHECK (plan_key IN ('free','starter','pro','enterprise'))`

**Indexes:**
- `users_owner_idx` on `(owner_id)` — fan-out from owner to crew lookups
- `users_tenant_idx` on `(tenant_id)` — portal join
- `users_stripe_customer_idx` on `(stripe_customer_id)` where non-null — Stripe webhook routing
- `users_email_idx` on `(lower(email))` where non-null — email lookup

**RLS:** Enabled. Policies:
- `users_self_select` — `USING (user_id IN (SELECT split_part((raw_user_meta_data->>'phone'), '+', 2) FROM auth.users WHERE id = auth.uid()))` — *TBD: finalize in Phase 2 security review. Simpler alternative: tenant-scoped read.*
- `users_tenant_select` — `USING (tenant_id IN (SELECT tenant_id FROM chiefos_portal_users WHERE user_id = auth.uid()))`
- `users_self_update` — limited to onboarding completion, name, email, tz

**GRANTs:** `authenticated` = SELECT, UPDATE (not INSERT — users are created by signup flow in service-role). `service_role` = ALL.

**Classification:** KEEP-WITH-REDESIGN (significant). Column reduction from 54 → 21. Add NOT NULL `tenant_id` FK. Add CHECKs. Two columns (`can_insert_financials` — wait, that's on `chiefos_portal_users`) deliberately live on membership, not here.

**Cross-tenant isolation test:** Same pattern — two tenants, verify no leakage across tenant_id.

---

#### Table: `public.chiefos_legal_acceptances`

**Role:** Append-only compliance log. Every time a user accepts terms, privacy, AI policy, or DPA, a row is written. Required for audit and regulatory response.

**Authoritative source:** Compliance requirement (implicit across monetization §5 "deployment rule"; founder-directed).

**Identity model:** `tenant_id` + `auth_user_id` (uuid). Multiple rows per user across versions.

**Columns:** Per current table (17 columns). KEEP-AS-IS with GRANT backfill. Current design is correct; it captures per-version acceptance of each policy class with timestamps, IP, user agent.

**Constraints:** Current table has:
- `legal_acceptances_delete_block_client` and `legal_acceptances_update_block_client` policies — blocking client-side DELETE/UPDATE (append-only discipline).
- Missing: `CHECK (accepted_via IN ('portal','whatsapp','email','api'))` — add in rebuild.

**RLS:** KEEP. Policies already block DELETE/UPDATE/INSERT from the client; SELECT scoped by tenant membership. INSERTs flow through service role only.

**GRANTs:** `authenticated` = SELECT. `service_role` = SELECT, INSERT. DELETE deliberately not granted even to service_role in most contexts — keep append-only.

**Classification:** KEEP-AS-IS + add GRANT statements in its migration.

---

#### Table: `public.portal_phone_link_otp`

**Role:** OTP codes for portal-to-WhatsApp phone pairing. Time-bounded. Written when a portal user claims a phone; read/deleted when the WhatsApp side confirms.

**Authoritative source:** Implicit in portal sign-up flow; clear functional need.

**Columns:** KEEP shape — `auth_user_id uuid`, `phone_digits text`, `otp_hash text`, `expires_at timestamptz`, `created_at timestamptz`.

**Constraints:** Add `UNIQUE (auth_user_id)` so only one in-flight OTP per user. Add `CHECK (expires_at > created_at)`.

**RLS fix:** Currently has RLS enabled but zero policies — meaning no client can read or write it, which is either intentional (service-role only) or broken. Design: keep RLS enabled, add a `portal_phone_link_otp_owner_select` policy restricted to the current `auth.uid()` so the portal user can see their own OTP state. INSERT/UPDATE/DELETE remain service-role only.

**GRANTs:** `authenticated` = SELECT. `service_role` = SELECT, INSERT, UPDATE, DELETE.

**Classification:** KEEP-WITH-REDESIGN (add policies + UNIQUE + GRANTs).

---

#### Table: `public.chiefos_beta_signups`

**Role:** Pre-signup waitlist / beta-request log. One row per email that requested access.

**Authoritative source:** GTM Brief §9 (Phase 1 Controlled Field Deployment). Operational artifact of the beta invite process.

**Columns:** KEEP-AS-IS (12 cols). Minor tightening:
- `status` CHECK `IN ('requested','approved','onboarded','declined')` — currently unconstrained text
- `plan` CHECK `IN ('unknown','starter','pro')` — currently unconstrained

**RLS:** INSERT policy for public ("Anyone can insert beta signup") is correct for a waitlist; SELECT restricted to service_role via absence of policy.

**GRANTs:** `anon` = INSERT. `authenticated` = INSERT (idempotent if already submitted). `service_role` = ALL.

**Classification:** KEEP-WITH-REDESIGN (add CHECKs + GRANTs).

---

#### **DISCARDED identity tables (with rationale for each):**

| Table | Rationale |
|---|---|
| `chiefos_identity_map` | Superseded by the `users.owner_id ↔ tenant_id` direct mapping. Current table is a parallel lookup index that adds a layer without adding semantics. The dual-boundary model doesn't need a third identity table. |
| `chiefos_user_identities` | Same as above — a parallel identity system. The canonical identity surface is `users` (for ingestion) + `chiefos_portal_users` (for portal). Everything else is drift. |
| `chiefos_actor_identities` | A third parallel identity system. Per Constitution §2, there are three identity keys (tenant, owner, user). "Actor" as a separate taxonomy doesn't appear in any authoritative doc and duplicates `user_id`. **Discard confidently.** |
| `chiefos_actors` | Same as above. |
| `chiefos_tenant_actors` | Same. If the intent was "members of a tenant", `chiefos_portal_users` already holds that. |
| `chiefos_tenant_actor_profiles` | Display data that lives on `users` or `chiefos_portal_users`. Parallel table adds no value. |
| `chiefos_ingestion_identities` | Purpose overlaps with `users` (which is an ingestion identity table by design). If the current table adds a provider indirection (e.g., `whatsapp` vs `email`), design can accommodate via `users.provider` text column with CHECK (flag for founder review: is multi-provider per user a near-term need?). Otherwise DISCARD. |
| `chiefos_phone_active_tenant` | A cache of "which tenant is this phone currently acting in". Stale-cache risk; the authoritative answer comes from joining `users.owner_id → chiefos_tenants.id`. DISCARD; any caller should compute it live or use the `users` lookup. |
| `chiefos_pending_signups` | **Founder review:** this table holds 22 columns of signup-in-flight state. Keep it as an explicit signup-handshake table if the signup flow writes to it from an unauthenticated context (anon INSERT → authenticated pickup), else DISCARD. Tag **KEEP-WITH-REDESIGN (pending founder review of signup flow)**. |
| `users_legacy_archive` | By name, a legacy snapshot. **Founder review:** confirm no one reads it; if so, DISCARD. |
| `chiefos_saved_views` | Portal saved filters/views. Potentially legitimate product feature; I haven't found it documented in the authoritative docs. Flag for founder review — likely product feature not yet in North Star; if in-use, upgrade the docs, if not, DISCARD. |
| `chiefos_role_audit` | Log of role changes. Legitimate audit purpose. **KEEP-WITH-REDESIGN:** move into the Audit/Observability group (Session 2). |
| `chiefos_deletion_batches` | Per-batch soft-delete log for transactions. Legitimate; move to Audit/Observability. |
| `chiefos_txn_delete_batches` | Same — probable duplicate of `chiefos_deletion_batches`. Pick one. |
| `chiefos_expense_audit` | Legacy expense edit log. Superseded by `transactions.previous_hash` chain (integrity system) and soft-delete flags. DISCARD pending Phase 4 app grep. |
| `chiefos_board_assignments` | Board member role assignments. If distinct from `chiefos_portal_users.role = 'board_member'`, justify; if redundant, DISCARD. Pending founder review. |
| `user_auth_links` | Links `auth.users.id` to `users.owner_id`. Duplicates `chiefos_portal_users` which already links auth users to tenants. **KEEP-WITH-REDESIGN** IF the phone-digits column carries semantics not in `users` (it appears to); merge into `users` and drop this table. |
| `chiefos_link_codes` | Portal → WhatsApp pairing codes. Overlaps with `portal_phone_link_otp`. Pick one — `portal_phone_link_otp` is the simpler/cleaner name. Flag for review before DISCARD. |

The full Section 6 cross-reference in Session 2 will re-audit each of these with Phase 4 app-grep evidence.

---

### 3.2 Canonical Financial Spine

Three tables: `transactions` (the ledger), `file_exports` (the output), `media_assets` (the evidence).

---

#### Table: `public.transactions`

**Role:** Single source of truth for every financial event. Expenses, revenue, bills (future), receipts from quotes (future) — all one row per event, discriminated by `kind`.

**Authoritative source:** North Star §7, §8; Constitution §7 (CIL), §8 (idempotency).

**Identity model:** Fully dual-boundary. Every row has `tenant_id`, `owner_id`, optionally `user_id` (actor who captured it).

**Columns (slimmed from 48 to 29):**

| name | type | nullability | default | description |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK. **Changed from integer to uuid** — Constitution §2 says UUIDs for row identifiers; current `integer` is legacy |
| `tenant_id` | `uuid` | NOT NULL | — | FK → `chiefos_tenants(id)` |
| `owner_id` | `text` | NOT NULL | — | Ingestion boundary |
| `user_id` | `text` | nullable | — | Actor who captured (null for system writes) |
| `kind` | `text` | NOT NULL | — | `'expense'` \| `'revenue'` \| `'bill'` \| `'customer_receipt'` \| `'change_order'` \| `'adjustment'` |
| `amount_cents` | `bigint` | NOT NULL | — | **Canonical amount. Drop `amount numeric` duplicate.** |
| `currency` | `text` | NOT NULL | `'CAD'` | ISO 4217 |
| `subtotal_cents` | `bigint` | nullable | — | Tax breakdown support |
| `tax_cents` | `bigint` | nullable | — | Tax breakdown support |
| `tax_label` | `text` | nullable | — | `'GST/HST'` \| `'VAT'` \| `'SALES_TAX'` etc. |
| `date` | `date` | NOT NULL | — | Event date |
| `description` | `text` | nullable | — | Free text |
| `merchant` | `text` | nullable | — | **Renamed from current `source` which was ambiguous** — this is the vendor/payee |
| `category` | `text` | nullable | — | Expense category (materials, labour, etc.) — free text, normalized by vendor_aliases enrichment |
| `is_personal` | `boolean` | NOT NULL | `false` | Personal-expense flag (Starter tier feature) |
| `job_id` | `uuid` | nullable | — | FK → `jobs(id)` — may be null pre-confirm |
| `job_no` | `integer` | nullable | — | Denormalized for read paths; must agree with `jobs.job_no` |
| `source` | `text` | NOT NULL | — | `'whatsapp'` \| `'portal'` \| `'email'` \| `'api'` \| `'system'` |
| `source_msg_id` | `text` | nullable | — | Idempotency key (Twilio SID, Postmark ID, etc.) |
| `dedupe_hash` | `text` | nullable | — | Content-based dedupe (see Constitution §8) |
| `media_asset_id` | `uuid` | nullable | — | FK → `media_assets(id)` |
| `parse_job_id` | `uuid` | nullable | — | FK → `parse_jobs(id)` — present when transaction was produced by the receipt parser |
| `submission_status` | `text` | NOT NULL | `'confirmed'` | `'confirmed'` \| `'pending_review'` \| `'voided'` |
| `submitted_by` | `text` | nullable | — | For employee submissions requiring owner approval (digit-string user_id) |
| `reviewed_at` | `timestamptz` | nullable | — | When the owner confirmed an employee submission |
| `reviewer_note` | `text` | nullable | — | Owner's optional comment on review |
| `deleted_at` | `timestamptz` | nullable | — | Soft-delete marker |
| `deleted_by` | `uuid` | nullable | — | Auth user id (portal) who initiated the delete batch |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |
| `updated_at` | `timestamptz` | NOT NULL | `now()` | |

**Columns DISCARDED from the current 48 (with rationale):**

| Column | Rationale |
|---|---|
| `amount` (numeric) | Duplicate of `amount_cents` in non-cents units. Constitution mandates cents. DISCARD. |
| `job` (varchar) | Pre-FK job reference by name. Superseded by `job_id` (uuid FK). |
| `job_name` (text) | Same — denormalized name lookup. Query joins `jobs` when needed. |
| `job_int_id` (integer) | Third job reference — shows the schema's history. Keep exactly one: `job_id uuid`. |
| `media_url`, `media_type`, `media_transcript`, `media_confidence` | Properties of `media_assets`; join when needed. Denormalization here creates update anomalies. |
| `user_name` (varchar) | Legacy display; look up via `user_id → users.name`. |
| `payee_name` | Use `merchant` as the canonical column name. Consolidate. |
| `payment_status`, `payment_confirmed_at` | **Founder review:** this is for bill-payment tracking, a feature that's in the Execution Playbook as Beta expansion. If the feature ships in V2 post-rebuild, these return in a future migration. Defer; DISCARD for now. |
| `customer_ref` | Same — customer attribution lives on a future `customers` table (the current `customers` table is untracked; see Section 2.5 group). Don't retain on transactions. |
| `import_batch_id` | Historical bulk-import support. If active, keep. **Founder review — likely KEEP.** |
| `record_hash`, `previous_hash`, `hash_version`, `hash_input_snapshot` | **Integrity verification chain** — per `INTEGRITY_VERIFICATION_SYSTEM.md` in repo root. This IS a feature. **KEEP-AS-IS**: restore to the column list. Apologies; I had these in DISCARD before re-reading the integrity doc. Correcting now. |
| `superseded_by`, `edit_of`, `edited_by` | Edit-chain tracking. If integrity chain is active, these are load-bearing. KEEP. |
| `catalog_snapshot` | Frozen catalog reference for quote-to-invoice snapshots. KEEP in transactions if customer_receipt kind uses it; else move to quote-spine. Flag for review. |
| `supplier_id` | FK to `suppliers` — a catalog table in the supplier-catalog feature. If used, KEEP. |
| `expense_category` | Duplicate of `category` (current table has both). Drop `expense_category`; keep `category`. |
| `media_asset_id` | Already in keep list above. |

**Corrected column list** with the integrity fields restored:

Add to above: `record_hash text`, `previous_hash text`, `hash_version integer NOT NULL DEFAULT 1`, `hash_input_snapshot jsonb`, `superseded_by uuid`, `edit_of uuid`, `edited_by text`, `supplier_id uuid`, `import_batch_id uuid`, `catalog_snapshot jsonb` — all with their current nullability.

Revised column count: **~39 columns** (not 29; my initial trim over-cut; the integrity chain is architecturally significant).

**Constraints:**
- `CHECK (kind IN ('expense','revenue','bill','customer_receipt','change_order','adjustment'))`
- `CHECK (submission_status IN ('confirmed','pending_review','voided'))`
- `CHECK (source IN ('whatsapp','portal','email','api','system'))`
- `CHECK (currency IN ('CAD','USD'))`
- `CHECK (amount_cents >= 0)` — negatives disallowed; sign is carried by `kind`
- `CHECK ((subtotal_cents IS NULL AND tax_cents IS NULL) OR (subtotal_cents IS NOT NULL AND tax_cents IS NOT NULL))` — tax breakdown coherence
- `UNIQUE (owner_id, source_msg_id, kind)` partial index where `source_msg_id IS NOT NULL` — **idempotency spine**
- `UNIQUE (owner_id, dedupe_hash)` partial where non-null — content-based dedupe across `source_msg_id` values
- `UNIQUE (record_hash)` partial where non-null — integrity hash uniqueness

**Indexes:**
- `transactions_tenant_idx` on `(tenant_id, kind, date DESC)` — portal listing
- `transactions_owner_idx` on `(owner_id, date DESC)` — backend listing
- `transactions_job_idx` on `(job_id)` where non-null — job profitability queries
- `transactions_pending_review_idx` on `(tenant_id, submission_status)` where `submission_status = 'pending_review'` — employee-submission queue
- `transactions_deleted_idx` on `(tenant_id, deleted_at DESC)` where non-null — undo queries
- `transactions_parse_job_idx` on `(parse_job_id)` where non-null — receipt-pipeline join

**RLS:** Enabled. Policies per Constitution §4 membership pattern. Four policies (SELECT/INSERT/UPDATE/DELETE), all gated on `tenant_id IN (SELECT tenant_id FROM chiefos_portal_users WHERE user_id = auth.uid())`. DELETE additionally restricted to `role IN ('owner','board_member')`.

**GRANTs:** `authenticated` = SELECT, INSERT, UPDATE. `service_role` = ALL.

**Classification:** KEEP-WITH-REDESIGN (major). id type change (integer → uuid) requires careful migration (Phase 3 concern — may need a mapping column for in-flight rebuild). ~48 → ~39 columns. Idempotency and uniqueness tightened.

**Cross-tenant isolation test:** Two tenants with transactions; verify select-via-RLS returns exactly one tenant's rows. Plus: verify that `source_msg_id` collision across tenants does not cause dedupe cross-tenant (because the UNIQUE is on `owner_id + source_msg_id + kind`, not `source_msg_id` alone).

---

#### Table: `public.file_exports`

**Role:** Generated export files. One row per file generated by an export operation. The portal downloads these.

**Authoritative source:** North Star §7 (Exports/Year End); Execution Playbook §2 MVP item 9; Monetization §7 (export protection).

**Identity model:** `owner_id` (required); `tenant_id` (add — currently missing).

**Columns:**

| name | type | nullability | default | description |
|---|---|---|---|---|
| `id` | `text` | NOT NULL | — | PK, short opaque slug (current shape); **flag for redesign: should be uuid** |
| `tenant_id` | `uuid` | NOT NULL | — | **ADD — currently missing, portal RLS cannot work** |
| `owner_id` | `text` | NOT NULL | — | Ingestion boundary |
| `user_id` | `text` | nullable | — | Who requested |
| `filename` | `text` | NOT NULL | — | Display filename |
| `content_type` | `text` | NOT NULL | — | MIME |
| `bytes` | `bytea` | NOT NULL | — | File content **(flag: storage-bucket path preferred over bytea for large files; Phase 2 security review should decide)** |
| `kind` | `text` | NOT NULL | `'xlsx'` | `'xlsx'` \| `'pdf'` \| `'csv'` \| `'zip'` |
| `quota_consumed` | `integer` | NOT NULL | `1` | How much this export consumed of the export quota |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |
| `expires_at` | `timestamptz` | nullable | — | Auto-cleanup target (30 days) |

**Constraints:**
- `CHECK (char_length(owner_id) > 0)`
- `CHECK (kind IN ('xlsx','pdf','csv','zip'))`

**Indexes:**
- `file_exports_tenant_idx` on `(tenant_id, created_at DESC)`
- `file_exports_expired_idx` on `(expires_at)` where non-null — cleanup cron

**RLS:** Enabled. Standard tenant-membership policies.

**GRANTs:** `authenticated` = SELECT, INSERT (DELETE is service-role only for audit safety). `service_role` = ALL.

**Classification:** KEEP-WITH-REDESIGN (add `tenant_id`, add CHECKs and kind enum, evaluate bytea vs storage bucket in Phase 2).

**Cross-tenant isolation test:** Standard.

---

#### Table: `public.media_assets`

**Role:** References to stored files (receipts, invoices, job photos) in Supabase Storage. One row per distinct uploaded artifact.

**Authoritative source:** North Star §9 (evidence pointer per write); Constitution §2.

**Columns:**

| name | type | nullability | default | description |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK |
| `tenant_id` | `uuid` | NOT NULL | — | FK → `chiefos_tenants(id)` |
| `owner_id` | `text` | NOT NULL | — | |
| `storage_bucket` | `text` | NOT NULL | — | Supabase Storage bucket name |
| `storage_key` | `text` | NOT NULL | — | Object key in bucket |
| `content_type` | `text` | NOT NULL | — | MIME |
| `byte_size` | `bigint` | nullable | — | File size |
| `attachment_hash` | `text` | nullable | — | Content hash for dedup (matches `parse_jobs.attachment_hash`) |
| `sha256` | `text` | nullable | — | Full file SHA-256 |
| `source` | `text` | NOT NULL | — | `'whatsapp'` \| `'portal'` \| `'email'` |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |

**Constraints:**
- `UNIQUE (tenant_id, storage_bucket, storage_key)` — one row per stored object
- `CHECK (char_length(owner_id) > 0)`

**Indexes:**
- `media_assets_tenant_idx` on `(tenant_id, created_at DESC)`
- `media_assets_hash_idx` on `(tenant_id, attachment_hash)` where non-null — dedupe lookup

**RLS:** Enabled. Standard.

**GRANTs:** `authenticated` = SELECT. `service_role` = ALL.

**Classification:** KEEP-WITH-REDESIGN (current `media_assets` has `SELECT` grant to authenticated but unclear shape; audit against current columns in Phase 3).

---

### 3.3 Jobs Spine

Five tables: `jobs` (the record), `job_phases`, `job_photos`, `job_photo_shares`, plus the counter table that allocates `job_no`.

---

#### Table: `public.jobs`

**Role:** One row per job. The operational spine. Every transaction, time entry, photo, and quote attaches here.

**Authoritative source:** North Star §10 (job resolution); Execution Playbook §2 MVP item 3.

**Identity model:** Dual-boundary. `tenant_id uuid NOT NULL` — **currently missing on the live `jobs` table** (tenant_id only lives on `job_phases`, a downstream table). This is one of the drift items with the highest impact; every portal query on jobs relies on RLS through `owner_id`, which is not the portal boundary. **Must add.**

**Columns:**

| name | type | nullability | default | description |
|---|---|---|---|---|
| `id` | `integer` | NOT NULL | `nextval('jobs_id_seq')` | PK. **Keep integer** for tenant-internal human-readable legacy compat; the rebuild preserves this because dozens of tables FK by integer and because `job_no` serves the uuid-replacement role of "stable reference". Per Constitution §2, this is defensible as a row identifier — not a boundary. |
| `tenant_id` | `uuid` | NOT NULL | — | **ADD — required for portal RLS** |
| `owner_id` | `text` | NOT NULL | — | |
| `job_no` | `integer` | NOT NULL | — | Per-tenant sequential number; allocated from `chiefos_tenant_counters` (kind `'job'`) |
| `name` | `text` | NOT NULL | — | Job name (current has both `job_name varchar` and `name text`; keep `name`, drop `job_name`) |
| `status` | `text` | NOT NULL | `'active'` | `'active'` \| `'on_hold'` \| `'completed'` \| `'cancelled'` |
| `start_date` | `timestamptz` | nullable | `now()` | |
| `end_date` | `timestamptz` | nullable | — | |
| `contract_value_cents` | `bigint` | nullable | — | |
| `material_budget_cents` | `bigint` | nullable | — | |
| `labour_hours_budget` | `numeric` | nullable | — | |
| `source_msg_id` | `text` | nullable | — | Idempotency for WhatsApp create |
| `deleted_at` | `timestamptz` | nullable | — | Soft-delete |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |
| `updated_at` | `timestamptz` | NOT NULL | `now()` | |

**Columns DISCARDED:**
- `active` (boolean) — duplicate of `status = 'active'`. Keep `status`.
- `job_name` (varchar) — duplicate of `name`. Keep `name`.

**Constraints:**
- `UNIQUE (tenant_id, job_no)` — per-tenant numbering
- `UNIQUE (owner_id, source_msg_id)` partial where non-null — idempotency
- `CHECK (status IN ('active','on_hold','completed','cancelled'))`

**Indexes:**
- `jobs_tenant_status_idx` on `(tenant_id, status)` — portal listing
- `jobs_owner_idx` on `(owner_id, status)` — backend listing
- `jobs_deleted_idx` on `(tenant_id, deleted_at)` where non-null

**RLS:** Enabled. Standard tenant-membership policies. SELECT/INSERT/UPDATE granted to authenticated; DELETE requires `role IN ('owner','board_member')`.

**GRANTs:** `authenticated` = SELECT, INSERT, UPDATE. `service_role` = ALL.

**Classification:** KEEP-WITH-REDESIGN (add `tenant_id`, drop duplicates, tighten status enum).

**Cross-tenant isolation test:** Create two jobs with overlapping `job_no` (both tenants allocate `job_no = 1`); verify RLS-scoped read returns only the current tenant's job.

---

#### Table: `public.job_phases`

**Role:** Optional breakdown of a job into time-bounded phases. Used by timeclock queries ("on which phase did this shift happen") and reporting.

**Authoritative source:** Execution Playbook (implicit — phases are a reporting refinement).

**Columns:** Current 9 columns are shape-appropriate. KEEP-WITH-REDESIGN: add GRANTs, re-examine RLS policies (the current DELETE-only policy is odd — likely needs SELECT/INSERT/UPDATE also).

**Classification:** KEEP-WITH-REDESIGN (minor — GRANTs, policy completeness).

---

#### Table: `public.job_photos`

**Role:** Photos attached to a job. Stored in a Supabase bucket; this table holds metadata and the storage key.

**Authoritative source:** Execution Playbook (job operational surface); `media_assets` is the general evidence table, this is the job-scoped surface.

**Columns:** Current 12 columns look right. KEEP-WITH-REDESIGN: add GRANT statements, verify `storage_bucket` default matches the actual bucket name, add a UNIQUE on `(tenant_id, storage_path)`.

**Relationship to `media_assets`:** Worth a founder review — do we want a single `media_assets` table with a `kind` column (`'receipt' | 'job_photo' | ...`), or separate domain-specific tables? Current schema has both; design could go either way. **Flag for Session 2 decision.**

**Classification:** KEEP-WITH-REDESIGN.

---

#### Table: `public.job_photo_shares`

**Role:** Per-job shareable tokens for customer-facing photo galleries. 30-day expiry by default.

**Authoritative source:** Execution Playbook (customer-facing artifacts).

**Columns:** Current 8 columns look correct. KEEP-WITH-REDESIGN: add GRANTs, tighten `expires_at` default.

**Classification:** KEEP-WITH-REDESIGN.

---

#### Table: `public.chiefos_tenant_counters` *(shared with other groups, described here for first use)*

**Role:** Per-tenant sequential counter for every kind that needs a human-readable number. Currently used for `job`; will also be used for `task`, future `quote_no` (already has its own table), and `invoice_no`.

**Authoritative source:** Migration `2026_04_20_chiefos_tenant_counters_generalize.sql` (already tracked).

**Columns:** `tenant_id uuid NOT NULL`, `counter_kind text NOT NULL`, `next_no integer NOT NULL DEFAULT 1`, `updated_at timestamptz`, PK on `(tenant_id, counter_kind)`.

**Classification:** KEEP-AS-IS. Already migrated correctly in Session 2 group of migrations. Only change: add GRANTs if missing, and **add RLS** — currently `rls_enabled=false` per catalog. Backend-only access is fine, but RLS-enabled with a service-role-only policy is better hygiene.

---

#### **DISCARDED jobs-group tables:**

| Table | Rationale |
|---|---|
| `job_counters` | Superseded by generalized `chiefos_tenant_counters` (which has a `counter_kind = 'job'` row per tenant). Migrate any remaining rows during Phase 5; DISCARD the table. |
| `job_document_files`, `job_documents` | These are document-spine tables. Move to the Documents group (Session 2) if documents are a feature; DISCARD if they're abandoned. **Founder review.** |
| `job_kpis_daily` | Denormalized aggregates for the KPI surface. If read paths still use it, **KEEP-WITH-REDESIGN**. Otherwise replace with a view over `transactions` + `time_entries_v2`. **Flag for Session 2.** |
| `job_kpis_summary`, `job_kpis_weekly`, `job_kpis_monthly` | Views. Section 4 (Session 2) classifies each. |

---

### 3.4 Time Spine

The time spine is the most bolt-on-heavy group in the current schema. Current has: `time_entries_v2` (canonical), `time_entries` (legacy), `timeclock_prompts`, `timeclock_repair_prompts`, `timesheet_locks`, `timesheet_rollups`, `states`, `locks`, `employees`, `employer_policies`, plus `task_counters`, `task_counters_user` (for task numbering, not time — addressed here because they're adjacent).

Design philosophy for this group: keep the canonical entries table, the state machines the WhatsApp handler actually relies on, and the policy table. Roll up aggregates into a view (if reads hit aggregates often) or keep the rollup table with strict invalidation. DISCARD the legacy `time_entries` table entirely; V2 is the truth.

---

#### Table: `public.time_entries_v2`

**Role:** Canonical timeclock entries. One row per clock-in / break / drive / clock-out event. Segments compose into shifts via `parent_id`.

**Authoritative source:** Execution Playbook §2 MVP item 6 (Timeclock v2).

**Columns:** Current 20 columns look mostly right. KEEP-WITH-REDESIGN:

| Change | Rationale |
|---|---|
| Make `tenant_id` NOT NULL | Currently nullable; portal RLS breaks on null |
| Add `job_no integer` denormalized | Match `transactions` pattern for read-path efficiency |
| Tighten `kind` CHECK | `IN ('shift_start','shift_end','break_start','break_end','lunch_start','lunch_end','drive_start','drive_end','shift')` — currently free text |
| Add `CHECK (end_at_utc IS NULL OR end_at_utc > start_at_utc)` | Prevents negative-duration rows |
| Preserve integrity chain cols | `record_hash`, `previous_hash`, `hash_version`, `hash_input_snapshot` — same as transactions |

**Constraints additions:**
- `UNIQUE (owner_id, source_msg_id)` partial where non-null — idempotency
- FK `tenant_id → chiefos_tenants(id)`
- FK `job_id → jobs(id)` (note: current has `job_id uuid` but jobs.id is integer — this is a current drift issue; **resolve in Phase 3 by making `time_entries_v2.job_id integer` to match `jobs.id`**)

**Indexes:**
- `time_entries_v2_tenant_start_idx` on `(tenant_id, start_at_utc DESC)` — portal listing
- `time_entries_v2_owner_user_idx` on `(owner_id, user_id, start_at_utc DESC)` — per-employee shift history
- `time_entries_v2_shift_children_idx` on `(parent_id)` where non-null — segment→shift assembly
- `time_entries_v2_job_idx` on `(job_id, start_at_utc)` where non-null — per-job time

**RLS:** KEEP current tenant_isolation policy but expand from SELECT-only to SELECT/INSERT/UPDATE. Board-members can read all; employees can read their own entries only (tighter than current).

**GRANTs:** `authenticated` = SELECT, INSERT, UPDATE. `service_role` = ALL.

**Classification:** KEEP-WITH-REDESIGN (make `tenant_id` NOT NULL, resolve `job_id` type, tighten kind CHECK, expand policies).

**Cross-tenant isolation test:** Two tenants, overlapping owner_ids, verify RLS.

---

#### Table: `public.timeclock_prompts`

**Role:** In-flight prompts the WhatsApp handler has sent but not yet received a response for. TTL 24 hours. Drives conversation state for "Did you start a break?" / "What job are you on?" prompts.

**Authoritative source:** Execution Playbook §2 MVP item 6 (timeclock conversation state).

**Columns:** Current 7 columns are correct for the role. KEEP-AS-IS with GRANTs.

**Classification:** KEEP-AS-IS (GRANT backfill).

---

#### Table: `public.timeclock_repair_prompts`

**Role:** Prompts for owner-initiated repairs of mismatched clock events ("your shift ended without a clock-out; when did it actually end?").

**Authoritative source:** Execution Playbook §2 MVP item 6.

**Columns:** Current 12 look right. KEEP-WITH-REDESIGN:
- **Enable RLS** (currently disabled) with tenant-membership policy
- Add FK to `time_entries_v2(id)` on the `entry_id` and `shift_id` columns

**Classification:** KEEP-WITH-REDESIGN (enable RLS, add FKs).

---

#### Table: `public.timesheet_locks`

**Role:** Period-lock markers preventing edits to closed pay periods. One row per (employee, date range). Exports read these to gate "finalized" vs "in-progress" data.

**Authoritative source:** Execution Playbook §2 MVP item 6 (exports + integrity).

**Columns:** Current 8 look correct. KEEP-AS-IS with GRANTs; add `tenant_id` NOT NULL (currently missing).

**Classification:** KEEP-WITH-REDESIGN (add tenant_id).

---

#### Table: `public.timesheet_rollups`

**Role:** Denormalized per-(owner, day, employee, job) timesheet totals for dashboard/export reads.

**Authoritative source:** Dashboards/KPIs surface.

**Columns:** Current 9 cols.

**Founder review needed:** this is an invalidation-discipline question. If invalidation is handled correctly (by trigger when `time_entries_v2` writes), it saves portal SELECTs. If not, it drifts. **Recommendation: DISCARD and replace with a materialized view or on-demand query over `time_entries_v2`.** Phase 2 of this plan can audit whether app code already handles invalidation; if so, KEEP-WITH-REDESIGN (add RLS which is currently disabled, add tenant_id). If invalidation is ad-hoc, DISCARD.

**Classification:** **FOUNDER REVIEW REQUIRED** (KEEP-WITH-REDESIGN vs DISCARD).

---

#### Table: `public.states`

**Role:** Per-user conversational state for the WhatsApp handler. Holds `state` (what we're waiting for) and `data` (scratch payload).

**Authoritative source:** Implicit in WhatsApp handler design — the state machine persists here.

**Columns:** Current 4 look correct.

**Issue:** missing `tenant_id`. The `user_id` is a digit-string that uniquely identifies state globally, so tenant boundary isn't load-bearing here. But for RLS on the portal if it ever reads state, we'd need tenant_id. **Design decision: add `owner_id text NOT NULL` and `tenant_id uuid`. Currently RLS is enabled but the policies probably reference `user_id` which is problematic per the dual-boundary rule.**

**Classification:** KEEP-WITH-REDESIGN (add owner_id + tenant_id, review RLS policies).

---

#### Table: `public.locks`

**Role:** Distributed lock table for WhatsApp handler concurrency coordination. Per-key with expiry.

**Authoritative source:** Implicit — the handler uses this for idempotency and single-flight coordination.

**Columns:** Current 6. `key text NOT NULL` plus `lock_key text` duplicate — **DISCARD the duplicate column; keep `key`**. Otherwise shape is correct.

**Classification:** KEEP-WITH-REDESIGN (drop duplicate col).

**GRANTs:** service_role only (backend-only concern; never authenticated).

---

#### Table: `public.employees`

**Role:** Employee records. One row per employee of an owner's business.

**Authoritative source:** Monetization §2 (People caps per tier); Execution Playbook §2 (crew).

**Columns:** Current 8 cols.

**Issues:**
- Missing `tenant_id`. Add NOT NULL.
- `id` is integer; consider whether uuid is preferred (minor consistency issue). **Recommendation: keep integer** — it's shallow and widely referenced; changing the type costs more than it buys.
- Role CHECK `IN ('owner','employee','contractor','board_member')` — currently `text default 'employee'` unconstrained.

**Classification:** KEEP-WITH-REDESIGN (add tenant_id, role CHECK, GRANTs).

---

#### Table: `public.employer_policies`

**Role:** Per-owner pay/break/drive/overtime policy. One row per owner.

**Authoritative source:** Execution Playbook §2 MVP item 6 (policy-aware timeclock).

**Columns:** Current 12 cols look mostly right but `owner_id uuid` is wrong — should be `text` (digit-string) to match the rest of the dual-boundary model. **FIX: change `owner_id` to `text`.**

Additional: add `tenant_id uuid NOT NULL`.

**Classification:** KEEP-WITH-REDESIGN (fix owner_id type, add tenant_id, GRANTs).

---

#### Tables: `task_counters`, `task_counters_user`

**Role:** Per-tenant and per-user task numbering counters.

**Authoritative source:** MVP task feature (Execution Playbook §2 MVP item 7).

**Recommendation:** Same pattern as `job_counters` — **DISCARD both and fold into `chiefos_tenant_counters`** with `counter_kind = 'task'` and a per-user variant via a secondary counter kind. The generalized counter table is the pattern; this group has three specialized counter tables that all duplicate its purpose.

**Classification:** DISCARD (after counter-kind folding migration).

---

#### **DISCARDED time-spine tables:**

| Table | Rationale |
|---|---|
| `time_entries` (v1) | Superseded by `time_entries_v2`. Execution Playbook marks v1 as legacy. Data migrated to v2 long ago. DISCARD confidently pending Phase 4 app grep. |
| `job_counters`, `task_counters`, `task_counters_user` | Superseded by `chiefos_tenant_counters`. |

---

### 3.5 Quotes / Invoices / Contracts Spine

**Treatment: PRESERVATION.** The Quotes spine is architecturally closed territory. Its Phase 3 §27 formalization produced the patterns that inform the rest of this design (see Section 1 Cross-Cutting Patterns). Section 3.5 documents the six tables and forward-flags open handler questions; it does NOT redesign.

**Scope note.** The section heading covers the broader taxonomy (Quotes / Invoices / Contracts). The body documents **Quotes only** — the six `chiefos_quote_*` tables currently in production. Invoices and Contracts are future-scope spines: when those spines are designed, they land as their own Foundation Rebuild sections (likely §3.12, §3.13) or as extensions to §3.5, per whichever session opens them.

All six tables are classified **KEEP-AS-IS**. Column lists, constraints, indexes, RLS policies, GRANTs, and triggers are preserved verbatim from the live schema as captured in the quotes-spine migration files (`2026_04_18_chiefos_quotes_spine.sql`, `2026_04_18_chiefos_quote_events.sql`, `2026_04_18_chiefos_quote_share_tokens.sql`, `2026_04_18_chiefos_quote_signatures.sql`, `2026_04_19_chiefos_qs_png_storage_key_format.sql`, and the dependent migrations).

---

#### 2026-04-21 MCP Introspection Summary

Four read-only MCP queries against production (`xnmsjdummnnistzcxrtj`) plus one line-items follow-up verified schema ground before composing this section.

**Query 1 — `%quote%` tables in `public`:** six tables. No candidate additions beyond the known inventory:

1. `chiefos_quote_events`
2. `chiefos_quote_line_items`
3. `chiefos_quote_share_tokens`
4. `chiefos_quote_signatures`
5. `chiefos_quote_versions`
6. `chiefos_quotes`

Prior prose references to "seven tables" in the Quotes spine were loose — introspection confirms six. External FK targets (`customers`, `chiefos_tenants`, `jobs`) are cross-spine boundaries, not Quotes-owned.

**Query 2 — FK graph from the six spine tables:**
- External targets: `customers`, `chiefos_tenants`, `jobs` (cross-spine)
- Internal composite FKs propagate `(id, tenant_id, owner_id)` across every parent-child relationship — the production precedent for Principle 11
- `chiefos_quote_signatures.signed_event_id` is NOT NULL; `chiefos_quote_events.signature_id` is nullable. No cycle at load time because events insert first in SignQuote Step 14 before signature in Step 15
- `chiefos_quote_events.triggered_by_event_id` self-reference exists but is currently unpopulated (see Open Architectural Questions below)

**Query 3 — `media_assets` leakage check:** `SELECT COUNT(*) FROM media_assets WHERE storage_path LIKE '%chiefos-signatures%'` returned **0 rows**. Signature PNGs live exclusively in the `chiefos-signatures` bucket with persistence on `chiefos_quote_signatures.signature_png_storage_key`; no cross-pollination via `media_assets`.

**Query 4 — signature-shaped PNG keys in other buckets:** empty result. Zero PNGs matching the signature storage_key regex (`[0-9a-f]{8}-…{12}/[0-9a-f]{8}-`) exist outside `chiefos-signatures`.

**Query 5 (line-items follow-up):** enumerated all NOT NULL columns, CHECK constraints, and triggers on `chiefos_quote_line_items`. Surfaced one notable absence documented in the per-table page below — no line-level totals-balance CHECK analogous to `chiefos_qv_totals_balance` on versions.

All queries clean. Section 3.5 composes against verified ground.

**Cross-spine dependencies (verified 2026-04-21):**

- `chiefos_quotes.tenant_id → chiefos_tenants(id)` (external tenant root)
- `chiefos_quotes.customer_id → customers(id)` — customer table identity confirmed as `public.customers` via Query 2; customer-spine shape out of scope for §3.5 (see Open Architectural Questions)
- `chiefos_quotes.job_id → jobs(id)` — quotes attach to jobs
- 98+ internal composite FK rows enforcing `(id, tenant_id, owner_id)` propagation across child tables

**Future (non-rebuild-scope) FKs:**

- Signed-quote → invoice → `public.transactions (kind='revenue')` wiring (future InvoiceQuote handler)
- `chiefos_quote_events.triggered_by_event_id` self-reference (already present) enables causal-chain reconstruction when event-driven handler chaining arrives (see Open Architectural Questions)

---

#### Table: `public.chiefos_quotes`

**Role:** Quote header. One row per quote-identity, regardless of version count. Mutable `current_version_id` pointer; all content lives in `chiefos_quote_versions`. State machine: `draft → sent → viewed → signed → locked → voided`.

**Authoritative source:** Quotes spine Phase 3 §27; migration `2026_04_18_chiefos_quotes_spine.sql` (Migration 1).

**Identity model:** Dual-boundary. `id uuid PK`; `tenant_id uuid NOT NULL`; `owner_id text NOT NULL`. Composite `UNIQUE (id, tenant_id, owner_id)` as FK target for children (Principle 11).

**Classification:** KEEP-AS-IS. Live schema is correct and production-exercised through Phase 3. No redesign.

**Cross-reference notes:**
- `human_id` allocated via `chiefos_tenant_counters` with `counter_kind = 'quote'` (shared infrastructure; see tenant-counters callout below and §3.3 for the counter table itself)
- `current_version_id` FK to `chiefos_quote_versions(id, tenant_id, owner_id)` — composite FK per Principle 11, DEFERRABLE INITIALLY DEFERRED to support §17.14 INSERT-header-then-version-then-UPDATE sequence
- `chiefos_quotes_human_id_unique` — `UNIQUE (tenant_id, human_id)` enforces tenant-unique human_ids
- `chiefos_quotes_source_msg_unique` — `UNIQUE (owner_id, source_msg_id)` — CIL-retry dedup surface
- `chiefos_quotes_voided_consistency` — `CHECK (status = 'voided' ↔ voided_at IS NOT NULL)`
- Header-immutability trigger (`chiefos_quotes_guard_header_immutable`, SECURITY INVOKER) blocks edits to identity columns (id, tenant_id, owner_id, job_id, customer_id, human_id, source, source_msg_id, created_at). Mutable: `status`, `current_version_id`, `updated_at`, `voided_at`, `voided_reason`

---

#### Table: `public.chiefos_quote_versions`

**Role:** Versioned quote content. Append-only after locking. One row per version. `version_no` increments per quote (MAX+1 scoped to quote_id, not tenant-wide; intentional per §3.2 Q2).

**Authoritative source:** Quotes spine Phase 3 §27; migration Migration 1. Migration 4 added the deferred composite FK `chiefos_qs_version_identity_fk` target shape.

**Identity model:** Composite. `id uuid PK`; `tenant_id` + `owner_id` propagate from parent `chiefos_quotes` via composite FK.

**Classification:** KEEP-AS-IS.

**Cross-reference notes:**
- Strict-immutability trigger (`chiefos_quote_versions_guard_immutable`, SECURITY INVOKER) blocks UPDATE and DELETE after `locked_at IS NOT NULL`; also forbids clearing `locked_at` once set
- `chiefos_qv_quote_version_unique` — `UNIQUE (quote_id, version_no)`
- `chiefos_qv_totals_balance` — `CHECK (total_cents = subtotal_cents + tax_cents)` enforces math reconciliation at DB level
- `chiefos_qv_hash_required_on_lock` — `CHECK (locked_at IS NULL OR server_hash IS NOT NULL)` ensures canonical hash is captured at lock time
- `chiefos_qv_hash_format` — `CHECK (server_hash ~ '^[0-9a-f]{64}$')` enforces 64-hex SHA-256 shape
- `chiefos_qv_status_locked_consistency` — status/locked_at co-transition per §3.3
- Composite `UNIQUE (id, tenant_id, owner_id)` serves as FK target for line_items, share_tokens, signatures, events (Principle 11)
- Composite FK to `chiefos_quotes(id, tenant_id, owner_id)`
- First production `server_hash` is pinned in §27: `1e12cc5287c6edc79c9990a3aee47dab30598ddafea0816ea25b058e8b648485`. Any regression against §27's ceremony rows must reproduce this exact hash

---

#### Table: `public.chiefos_quote_line_items`

**Role:** Per-version line items. Mutations blocked when parent version is locked.

**Authoritative source:** Quotes spine Phase 3 §27; migration Migration 1.

**Identity model:** Composite. `id uuid PK`; `tenant_id` + `owner_id` propagate from parent version via composite FK.

**Classification:** KEEP-AS-IS.

**Cross-reference notes:**
- **NOT NULL columns (12):** `id`, `quote_version_id`, `tenant_id`, `owner_id`, `sort_order` (default 0), `description`, `qty` (default 1), `unit_price_cents`, `line_subtotal_cents`, `line_tax_cents` (default 0), `catalog_snapshot` (default `'{}'::jsonb`), `created_at` (default `now()`). Nullable: `category`, `tax_code`, `catalog_product_id`
- `chiefos_qli_owner_id_nonempty` — `CHECK (char_length(owner_id) > 0)`
- `chiefos_quote_line_items_category_check` — `CHECK (category IS NULL OR category IN ('labour', 'materials', 'other'))` enumerated category values
- `chiefos_quote_line_items_qty_check` — `CHECK (qty > 0)`
- `chiefos_quote_line_items_unit_price_cents_check` — `CHECK (unit_price_cents >= 0)`
- `chiefos_quote_line_items_line_subtotal_cents_check` — `CHECK (line_subtotal_cents >= 0)`
- `chiefos_quote_line_items_line_tax_cents_check` — `CHECK (line_tax_cents >= 0)`
- `chiefos_quote_line_items_guard_parent_lock` trigger (SECURITY INVOKER) blocks INSERT/UPDATE/DELETE when parent `chiefos_quote_versions.locked_at IS NOT NULL`
- Composite FK `(quote_version_id, tenant_id, owner_id) → chiefos_quote_versions` `ON DELETE RESTRICT`
- `catalog_snapshot jsonb` frozen at line creation; no FK to catalog_products (intentionally — snapshots are immutable even if the catalog row later changes)
- Min-1 line-item invariant enforced at CIL layer (`loadSignContext` Section 3 Decision C) — not a DB constraint
- **Notable absence — no line-level totals-balance CHECK.** Unlike `chiefos_qv_totals_balance` on versions (which enforces `total_cents = subtotal_cents + tax_cents` at the DB layer), line items have no DB-enforced derivation like `line_subtotal_cents = qty * unit_price_cents`. Handler-side `computeTotals` in `src/cil/quotes.js` computes the derivation; DB trusts the write. Flagged for future hardening consideration — not a current defect (CreateQuote handler computes consistently; lines write through the handler, not direct SQL), but one less belt-and-suspenders layer than the version-level totals check. Noted rather than actioned in this rebuild. This observation surfaced via Query 5 introspection on 2026-04-21

---

#### Table: `public.chiefos_quote_share_tokens`

**Role:** Shareable tokens for customer-facing quote view/sign surface. 22-char base58 token (Bitcoin alphabet); 30-day default expiry; soft-revocation via `revoked_at`; supersession via `superseded_by_version_id`.

**Authoritative source:** Quotes spine Phase 3 §27; migration `2026_04_18_chiefos_quote_share_tokens.sql` (Migration 3).

**Identity model:** Composite. `id uuid PK`; `tenant_id` + `owner_id` propagate from parent version via composite FK.

**Classification:** KEEP-AS-IS.

**Cross-reference notes:**
- `chiefos_qst_token_format` — `CHECK (token ~ '^[1-9A-HJ-NP-Za-km-z]{22}$')` enforces 22-char base58 shape at DB layer
- `chiefos_qst_source_msg_unique` — partial UNIQUE `(owner_id, source_msg_id) WHERE source_msg_id IS NOT NULL` — SendQuote retry dedup surface
- Strict-immutability guard (`chiefos_quote_share_tokens_guard_immutable`, SECURITY INVOKER)
- `superseded_by_version_id` composite FK to newer version's `(id, tenant_id, owner_id)` — supports re-issue flow (handler TBD; see Open Handler Questions — Forward Flags)
- Revocation via `revoked_at` timestamp, not row delete
- Customer-initiated actions through this token are **not plan-gated** per §14.12 (Cross-Cutting Pattern)
- RLS: tenant SELECT only (§11.0 audit-terminal pattern)

---

#### Table: `public.chiefos_quote_signatures`

**Role:** Strict-immutable signature records. One row per signature event (UNIQUE on quote_version_id); 17 columns; signature PNG lives in `chiefos-signatures` storage bucket (verified clean separation via Queries 3 and 4).

**Authoritative source:** Quotes spine Phase 3 §27; migration `2026_04_18_chiefos_quote_signatures.sql` (Migration 4). Migration 6 (`2026_04_19_chiefos_qs_png_storage_key_format.sql`) added the `chiefos_qs_png_storage_key_format` CHECK mirroring app-layer `SIGNATURE_STORAGE_KEY_RE`.

**Identity model:** Composite. `id uuid PK` (pre-generated by handler via `crypto.randomUUID()` per §17.20); `tenant_id` + `owner_id` propagate from parent version via composite FK.

**Classification:** KEEP-AS-IS.

**Cross-reference notes:**
- Strict-immutability guard (`chiefos_quote_signatures_guard_immutable`, SECURITY INVOKER) blocks ALL UPDATE and DELETE on inserted rows — every column immutable post-insert
- `chiefos_qs_version_unique` — `UNIQUE (quote_version_id)` enforces one signature per version. Multi-party sign is a future v2 schema change
- `chiefos_qs_source_msg_unique` — partial UNIQUE for CIL retry dedup
- `chiefos_qs_png_storage_key_format` — regex CHECK mirroring app-layer `SIGNATURE_STORAGE_KEY_RE` (Migration 6; byte-identical regex)
- `chiefos_qs_png_sha256_format` — `CHECK (signature_png_sha256 ~ '^[0-9a-f]{64}$')`
- `chiefos_qs_version_hash_format` — same regex for `version_hash_at_sign`
- §17.20 Pre-BEGIN external write applies: signature PNG must exist in `chiefos-signatures` bucket before row INSERT
- `signed_event_id` composite FK to `chiefos_quote_events(id, tenant_id, owner_id)` — the signing lifecycle event must exist before the signature row; event inserts in SignQuote Step 14, signature in Step 15
- `share_token_id` composite FK to `chiefos_quote_share_tokens(id, tenant_id, owner_id)` — every signature binds to the token that authorized it
- Customer is the signing actor per §14.11 (auth-orthogonal); auth evidence lives in `share_token_id`, not in `actor.role`
- §27 pinned first production `signature_id`: `8b9b982d-6268-4da8-b25e-5cf29228d197`

---

#### Table: `public.chiefos_quote_events`

**Role:** Full lifecycle event log for the Quotes spine. Kinds include state transitions, integrity events, and notification outcomes. Self-referencing via `triggered_by_event_id` for causal-chain reconstruction.

**Authoritative source:** Quotes spine Phase 3 §27 (§17.19 paired notifications; §17.21 correlation_id); migration `2026_04_18_chiefos_quote_events.sql` (Migration 2). Migration 4 extended `chiefos_qe_kind_enum` with `integrity.name_mismatch_signed`.

**Identity model:** Composite. `id uuid PK`; `tenant_id` + `owner_id` propagate from parent records via composite FKs.

**Classification:** KEEP-AS-IS.

**Cross-reference notes:**
- `correlation_id uuid` column — single UUID threaded through all events emitted by one handler invocation per §17.21. SignQuote wires; SendQuote currently leaves NULL (asymmetry documented in §17.21, not a defect)
- Event kinds include both lifecycle (`lifecycle.sent`, `lifecycle.customer_viewed`, `lifecycle.signed`, `lifecycle.locked`, `lifecycle.voided`) and notification outcomes (`notification.sent`, `notification.failed`) per §17.19 paired pattern. 21 total kinds enumerated in `chiefos_qe_kind_enum`
- `chiefos_qe_version_scoped_kinds` — forces `quote_version_id NOT NULL` for version-scoped kinds
- Per-kind payload CHECKs enforce required fields (e.g., `chiefos_qe_payload_signed` requires `payload ? 'version_hash_at_sign'` matching 64-hex; `chiefos_qe_payload_name_mismatch_signed` requires `signature_id NOT NULL AND payload ? 'rule_id'`; `chiefos_qe_payload_sent` requires `recipient_channel`/`recipient_address` + `share_token_id NOT NULL`; plus 8 additional per-kind CHECKs)
- Strict-immutability (`chiefos_quote_events_guard_immutable`, SECURITY INVOKER)
- Composite FKs propagate `(tenant_id, owner_id)` from referenced parent records (quotes, versions, signatures, share_tokens)
- `triggered_by_event_id → chiefos_quote_events(id)` self-reference — currently unpopulated by any handler; latent-valuable for future cross-invocation causal chaining (see Open Architectural Questions)
- RLS: tenant SELECT only

---

#### Table: `public.chiefos_tenant_counters` *(shared)*

Already classified in §3.3. Used by Quotes spine for `human_id` allocation via `counter_kind = 'quote'`. Allocation helper: `src/cil/quotes.js::allocateQuoteHumanId()` calls `pg.allocateNextDocCounter(tenantId, COUNTER_KINDS.QUOTE, client)`.

Reserved `counter_kind` values per `src/cil/counterKinds.js`: `activity_log`, `quote`, `invoice`, `change_order`, `receipt`. Quotes currently uses only `quote`. Future doctypes (`invoice`, `change_order`, `receipt`) will use the counter table when those spines arrive.

Jobs has its own `jobs.job_no` integer column allocated via per-owner `MAX+1` (not via `chiefos_tenant_counters`) — the counter table and `jobs.job_no` solve similar problems but are architecturally distinct.

No Quotes-spine-specific changes required. `version_no` on `chiefos_quote_versions` is also **not** a tenant-wide counter — it's per-quote serial via `MAX(version_no) + 1 WHERE quote_id = $1`, intentional per §3.2 Q2.

---

#### Open Handler Questions — Forward Flags (Six Candidate Handlers/Tasks)

Six candidate handlers or hygiene tasks surface from Phase 3's closure. Flagged, not chosen. These are Plan V2 post-rebuild sequencing items, not Foundation Rebuild scope.

1. **ViewQuote / RecordQuoteAccess (small).** Transitions `sent → viewed` when a customer opens `/q/:token`. Emits `lifecycle.customer_viewed` event. No signature, no external dispatch. `loadSignContext` already accepts `viewed` as a valid source state (`sent OR viewed → signed`), but no handler currently populates `viewed`. Useful for contractor telemetry ("customer opened the quote but hasn't signed yet"). Not load-bearing for Phase 3's proven flow; deferrable.

2. **VoidQuote (small-medium).** Transitions `draft / sent / viewed → voided` (terminal). Sets `chiefos_quotes.status = 'voided'`, `voided_at = NOW()`, `voided_reason`. Closes the edge `loadSignContext` defends against (`QUOTE_VOIDED` error code already exists in `SIG_ERR`). Emits `lifecycle.voided` event. Defines voided semantics; affects future ReissueQuote (voided quotes cannot be reissued).

3. **ReissueQuote (medium).** Creates a new version (append-only); populates `superseded_by_version_id` on the old share_token; bumps `chiefos_quotes.current_version_id`. Triggers §17.20 again (new strict-immutable version row). Makes §27's supersession defense load-bearing — the `SHARE_TOKEN_SUPERSEDED` rejection currently fires only if `token.quote_version_id !== quote.current_version_id`, and ReissueQuote is the first handler that could produce the diverging state.

4. **LockQuote (small).** `signed → locked` cosmetic transition on quote header. Version is already locked at sign time; this is a header-only status flip for portal rendering (§3.3). Small handler.

5. **InvoiceQuote (large, future).** Converts signed quote to invoice. Wires to `public.transactions` canonical financial spine. Spans Quotes spine + Invoices spine (not yet built) + Financial spine. Scope-blocked on the Invoices spine's design — whenever that session opens, InvoiceQuote becomes the natural first handler for it.

6. **SendQuote `correlation_id` backfill (hygiene).** Pass `correlationId` through SendQuote's existing `emitLifecycleSent` / `emitNotificationSent` / `emitNotificationFailed` helpers so §17.21's documented asymmetry closes. ~15 min; low risk. Closes the only known asymmetry in the Quotes-spine event emission model.

---

#### Open Architectural Questions (Three, None Blocking)

Three architectural uncertainties worth documenting. None are blockers; none require resolution before the next handler session.

1. **Per-doctype events tables vs. generalized events table.** Current posture (§12) is one events table per doctype with its own `chiefos_<doctype>_qe_kind_enum` CHECK and per-kind payload CHECKs. Alternative considered at §12: single generalized `chiefos_events` with `doctype` discriminator + discriminated-union payload CHECKs. Per-doctype chosen for payload-CHECK simplicity, schema evolution isolation, and RLS clarity. Revisit when three or more doctypes have their own events tables (Quotes + two future additions — likely Invoices and Change-Orders). At that point, review whether the per-doctype cost accumulates or whether the per-doctype benefits continue to justify the pattern. No action this session.

2. **Customer spine shape not verified.** Query 2 reveals `customers` is an external FK target for `chiefos_quotes.customer_id` and `chiefos_quote_events.customer_id`. The Customer spine's own design (table shape, tenant scoping, deduplication rules, lifecycle) is out of scope for §3.5. Phase 3's ceremony used `customer_id = null` (inline-synthesized customer snapshot on the version, no linked customer row); CreateQuote Section 1 supports both branches (inline-create vs. existing-customer link) per §20. Forward flag: a dedicated Customer spine section of this Foundation Rebuild document should document the customer-table shape and lifecycle.

3. **`triggered_by_event_id` is latent-valuable, not unused.** The `chiefos_quote_events.triggered_by_event_id` self-reference FK is currently unpopulated by any handler. §17.21's `correlation_id` discipline solves the "group events within one invocation" problem; `triggered_by_event_id` solves a distinct problem — "link causally-related events across different invocations" (e.g., `lifecycle.signed` in SignQuote → future `lifecycle.auto_invoiced` in an auto-invoice handler that fires when signature completes). Not broken, not a priority now, but not redundant with correlation_id. When event-driven handler chaining or auto-follow-on handlers arrive, this column becomes load-bearing. §12c (hash-chained audit verification — forward-flagged in the decisions log) may formalize `triggered_by_event_id` as part of the hash-chain construction. Preserve as-is.

---

### 3.6 Intake (Non-Receipt) Pipeline

Per Plan V2 Session 2 decision (confirmed), `intake_items` family is preserved as the canonical surface for **non-receipt** intake kinds: voice notes, PDF documents, email leads. Receipts route through `parse_jobs` (§3.7) from the start — they never enter the `intake_items` pipeline in the rebuilt system.

**Design imperative:** the rebuild's `intake_items.kind` CHECK explicitly excludes receipt kinds. If existing `intake_items` rows currently include receipt-category values, Phase 3 migration does not carry them forward. Phase 4 app audit confirms the WhatsApp handler routes receipts to `parse_jobs` directly; if any code path inserts a receipt into `intake_items`, that's a BLOCKING Phase 4 fix.

**OCR column separation:** `intake_item_drafts` retains OCR-related columns BUT they are for voice transcription (from Speech-to-Text) and PDF text extraction only. Receipt OCR (Document AI primary + Textract fallback + LLM auditor) flows through `parse_jobs` per the Session 2 migration and never touches `intake_item_drafts`. The design pages note this explicitly.

---

#### Table: `public.intake_batches`

**Role:** Groups upload sessions. One batch per portal upload action; one batch per email ingestion with attachments; one batch per voice-note WhatsApp message with multiple media.

**Classification:** KEEP-WITH-REDESIGN (minor).

**Design deltas vs. current:**
- Confirm `tenant_id uuid NOT NULL` with composite `UNIQUE (id, tenant_id)` as FK target for `intake_items`
- `kind` CHECK constraint narrowed to `('voice_batch','pdf_batch','email_batch','mixed_batch')` — **`receipt_image_batch` removed** per receipt-pipeline-separation imperative above
- Explicit GRANTs to `authenticated` (SELECT, INSERT, UPDATE) and `service_role` (ALL) per Principle 9
- RLS policies per Principle 8 membership pattern (live table has this; verify coverage)

**Columns, indexes, FKs:** retained from current schema; see Session 2.5 catalog for exact shape.

---

#### Table: `public.intake_items`

**Role:** One row per uploaded/received artifact. Discriminator: `kind`. Status lifecycle: `pending_review → persisted | rejected`.

**Classification:** KEEP-WITH-REDESIGN (moderate).

**Design deltas vs. current:**
- `kind` CHECK narrowed to `('voice_note','pdf_document','email_lead','unknown')` — **`receipt_image` removed**
- Composite FK `(batch_id, tenant_id) → intake_batches(id, tenant_id)` per Principle 11
- `duplicate_of_item_id` self-FK composite `(duplicate_of_item_id, tenant_id)` (currently simple FK; tighten for tenant coherence)
- Composite `UNIQUE (id, tenant_id)` serves as FK target for `intake_item_drafts` and `intake_item_reviews`
- Explicit GRANTs per Principle 9

---

#### Table: `public.intake_item_drafts`

**Role:** Parsed/extracted content from a non-receipt intake artifact. Voice transcripts, PDF text, email body parse. One row per draft; multiple drafts per item possible (reparse loop).

**Classification:** KEEP-WITH-REDESIGN (moderate).

**Design deltas vs. current:**
- Composite FK `(intake_item_id, tenant_id) → intake_items(id, tenant_id)` per Principle 11
- `draft_kind` CHECK restricted to non-receipt kinds (`'voice_transcript'`, `'pdf_text'`, `'email_body_parse'`, `'email_lead_extract'`). **Receipt-draft kinds removed.**
- Explicit design note in the migration comment block: **"Receipt OCR does not flow through this table. See `parse_jobs` for receipt drafts."**
- Retain `confidence_score`, `validation_flags`, `raw_model_output` columns for non-receipt drafts
- Explicit GRANTs per Principle 9

---

#### Table: `public.intake_item_reviews`

**Role:** Action-level audit for non-receipt intake items. One row per confirm/reject/edit_confirm action.

**Classification:** KEEP-WITH-REDESIGN (minor).

**Design deltas vs. current:**
- Composite FK `(intake_item_id, tenant_id) → intake_items(id, tenant_id)` per Principle 11
- Action CHECK: `('confirm','reject','edit_confirm','reopen')`
- `reviewed_by_portal_user_id uuid NOT NULL` — FK to `chiefos_portal_users(user_id)`. **Actor FK redesigned away from `chiefos_actors`** per Decision 12
- `correlation_id uuid NOT NULL` per §17.21 pattern
- Append-only: no UPDATE or DELETE granted to `authenticated`; INSERT only. Trigger prevents UPDATE and DELETE.

**Purpose separation from `parse_corrections`:** `intake_item_reviews` logs action-level decisions on non-receipt intake items; `parse_corrections` logs per-field corrections on receipt items. Both tables coexist with no overlap.

---

### 3.7 Receipt Pipeline (Plan V2 Session 2 — Incorporated As-Is)

The three tables in this group were authored, tested, and deployed via Session 2's migration files. They passed the 171/171 cross-tenant isolation test battery. **Classification for all three: KEEP-AS-IS.** No redesign in the rebuild.

Source migrations:
- `migrations/2026_04_21_chiefos_parse_pipeline_tables.sql`
- (Note: this migration was applied to the current DB; it's being carried forward into the rebuild's clean migration set as Phase 3 Session author)

The design pages below are summaries; the authoritative DDL is in the migration file.

---

#### Table: `public.parse_jobs`

**Role:** Per-receipt/invoice parse-job tracking. One row per OCR + auditor pass. Canonical surface for the receipt pipeline state machine: queued → processing → completed | failed.

**Authoritative source:** `RECEIPT_PARSER_UPGRADE_HANDOFF.md` §5.1; migration `2026_04_21_chiefos_parse_pipeline_tables.sql`.

**Classification:** KEEP-AS-IS.

**Key properties (verbatim from Session 2 migration):**
- 29 columns including OCR primary/fallback results + confidence, LLM auditor result + model + provider + token counts, validation flags, CIL draft, final confidence, routing decision
- `UNIQUE (owner_id, source_msg_id, kind) DEFERRABLE INITIALLY DEFERRED` — idempotency spine
- `UNIQUE (id, tenant_id, owner_id)` — composite FK target per Principle 11
- `routing_decision` CHECK: `IN ('pending_review','rejected')` — explicitly no auto-accept per plan
- RLS + policies + GRANTs already applied correctly in Session 2 migration
- 5 indexes: tenant, owner, status (partial), routing (partial), hash

---

#### Table: `public.vendor_aliases`

**Role:** Tenant-scoped merchant normalization memory. The enrichment moat. Upserted on every owner confirmation.

**Authoritative source:** `RECEIPT_PARSER_UPGRADE_HANDOFF.md` §5.2.

**Classification:** KEEP-AS-IS.

**Key properties:**
- 12 columns including `raw_merchant_normalized`, `canonical_merchant`, `default_category`, `default_tax_treatment`, **`default_job_hint`** (load-bearing for Auto-Assign §7 and Suggested-Job Logic §9)
- `UNIQUE (tenant_id, raw_merchant_normalized)` — dedupe
- RLS + policies + GRANTs per Session 2 migration
- 2 indexes: tenant, lookup

---

#### Table: `public.parse_corrections`

**Role:** Per-field correction log. Enrichment moat record of every owner edit before confirming a receipt.

**Authoritative source:** `RECEIPT_PARSER_UPGRADE_HANDOFF.md` §5.3.

**Classification:** KEEP-AS-IS.

**Key properties:**
- 10 columns including `field_name`, `original_value`, `corrected_value`, `original_source`
- FK `parse_job_id → parse_jobs(id)` (current migration uses simple FK; acceptable because `parse_jobs` co-carries `tenant_id` and RLS enforces cross-tenant safety at read time — Phase 3 migration author may choose to upgrade to composite FK per Principle 11 for defense in depth)
- RLS + GRANTs per Session 2 migration
- 2 indexes: tenant, job

---

### 3.8 Quota Architecture (Plan V2 Session 2 — Incorporated As-Is)

The four quota tables implement Engineering Constitution §11 quota architecture. Built, tested, and deployed via Session 2 migration. **Classification for all four: KEEP-AS-IS.**

Source migration: `migrations/2026_04_21_chiefos_quota_architecture_tables.sql`.

---

#### Table: `public.quota_allotments`

**Role:** Per-(owner_id, feature_kind) quota bucket. Layered buckets per owner (plan + add-ons + soft overage).

**Classification:** KEEP-AS-IS.

**Key properties:** 12 columns; Stripe event idempotency via `UNIQUE (stripe_event_id)` partial index; active-buckets partial index; CHECK constraints on `feature_kind` format, `bucket_source` format, `allotment_consumed <= allotment_total`, `expires_at > valid_from`. RLS + GRANTs per migration.

---

#### Table: `public.quota_consumption_log`

**Role:** Audit trail for every metered call. Append-only.

**Classification:** KEEP-AS-IS.

**Key properties:** 10 columns including `trace_id`, `remaining_in_bucket`, `consumed_amount`. FK to `quota_allotments(id)`. Indexes on `(owner_id, feature_kind, created_at)`, tenant, allotment (partial). RLS + GRANTs per migration.

---

#### Table: `public.addon_purchases_yearly`

**Role:** 1,000-pack annual limit enforcement per `(owner_id, calendar_year)`.

**Classification:** KEEP-AS-IS.

**Key properties:** 7 columns; `UNIQUE (stripe_event_id)` enforces Stripe webhook idempotency; CHECK `pack_size IN (100, 250, 500, 1000)`; CHECK `calendar_year BETWEEN 2024 AND 2100`. RLS + GRANTs per migration.

---

#### Table: `public.upsell_prompts_log`

**Role:** Once-per-(owner, feature, trigger, month) upsell prompt dedupe.

**Classification:** KEEP-AS-IS.

**Key properties:** 9 columns; `UNIQUE (owner_id, feature_kind, trigger_type, period_year_month)` — the load-bearing guarantee for once-per-month per handoff §11.3. Format CHECKs on `feature_kind`, `trigger_type`, `period_year_month ~ '^\d{4}-(0[1-9]|1[0-2])$'`. RLS + GRANTs per migration.

---

### 3.9 Pending Actions / CIL Drafts

Two tables that support the CIL enforcement pattern (Principle 5): `pending_actions` holds the TTL-bound YES/EDIT/CANCEL confirm state; `cil_drafts` stages the CIL payload between validation and domain mutation.

---

#### Table: `public.pending_actions`

**Role:** Per-(owner, user, kind) in-flight confirm state. TTL 10 minutes default. Holds the draft payload the WhatsApp handler is asking the user to confirm.

**Authoritative source:** Engineering Constitution §7 (CIL enforcement); Execution Playbook §2 (MVP pending-action state machine).

**Classification:** KEEP-WITH-REDESIGN.

**Design deltas vs. current:**
- **Add `tenant_id uuid NOT NULL`** — currently missing; the table is RLS-enabled but policies reference `current_setting('request.jwt.claims.owner_id')`, which is a custom backend pattern. Adding `tenant_id` enables standard tenant-scoped RLS (Principle 8) for parity with the rest of the schema.
- FK `tenant_id → chiefos_tenants(id)`
- Keep `owner_id text NOT NULL`, `user_id text NOT NULL`
- `kind` CHECK enumerated: `('confirm_expense','confirm_revenue','confirm_quote','confirm_task','confirm_timeclock_event', ...)` — list grows with features; CHECK uses format regex `^[a-z][a-z_]*$` plus an app-code registry (precedent: `chiefos_tenant_counters.counter_kind`)
- `UNIQUE (owner_id, user_id, kind)` — one active confirm per actor per kind
- `payload jsonb NOT NULL DEFAULT '{}'::jsonb`
- `expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes')`
- TTL-cleanup cron reference: `api/cron/cleanup_pending.js` (existing; no change needed)
- Explicit GRANTs per Principle 9: `service_role` = ALL; `authenticated` = SELECT, INSERT, UPDATE (DELETE is service-role only)

**Columns:** `id uuid PK`, `tenant_id uuid`, `owner_id text`, `user_id text`, `kind text`, `payload jsonb`, `created_at`, `expires_at`, `updated_at`.

---

#### Table: `public.cil_drafts`

**Role:** CIL payload staging between validation and domain mutation (per Constitution §7). One row per draft awaiting commit. Enables replay, audit, and recovery on handler crashes.

**Authoritative source:** Engineering Constitution §7 (CIL enforcement); North Star §8 (CIL architecture).

**Classification:** KEEP-WITH-REDESIGN.

**Design deltas vs. current:**
- **Add `tenant_id uuid NOT NULL`** — currently missing
- FK to `chiefos_tenants(id)`
- **Enable RLS** — currently `rls_enabled = false` per verification report
- Standard tenant-scoped RLS policies (Principle 8)
- `cil_type` CHECK: `('LogExpense','LogRevenue','CreateQuote','CreateInvoice','Clock','CreateTask','ChangeOrder', ...)` — matches North Star §8 CIL types; format + app-registry pattern
- Composite `UNIQUE (id, tenant_id, owner_id)` for cross-spine FK readiness
- `source_msg_id text` + composite `UNIQUE (owner_id, source_msg_id, cil_type)` — idempotency (Principle 7)
- `validated_at timestamptz` — set when CIL validation passes
- `committed_at timestamptz` — set when domain mutation writes canonical row; also captures `committed_to_table` and `committed_to_id` for traceback
- `trace_id text NOT NULL` — request-scoped trace identifier
- `correlation_id uuid NOT NULL` per §17.21
- Explicit GRANTs per Principle 9

**Columns:** `id uuid PK`, `tenant_id uuid`, `owner_id text`, `user_id text`, `cil_type text`, `payload jsonb NOT NULL`, `source_msg_id text`, `validated_at timestamptz`, `committed_at timestamptz`, `committed_to_table text`, `committed_to_id text`, `trace_id text NOT NULL`, `correlation_id uuid NOT NULL`, `created_at`, `updated_at`.

---

### 3.10 Conversation / Chief Memory

Per North Star §14, Chief maintains persistent multi-turn conversation context: session state, message history, tracked entities. The current schema has scattered tables for adjacent purposes (`assistant_events`, `chief_actor_memory`, `convo_state`, `entity_summary`) but **no proper `conversation_sessions` / `conversation_messages` pair**.

**Rebuild decision:** two new tables, **NEW**, plus selective retention of one existing table. Rebuild the conversation spine cleanly per North Star §14; DISCARD the ad-hoc predecessors.

---

#### Table: `public.conversation_sessions` *(NEW)*

**Role:** Per-session conversational state for Ask Chief. One row per active session. Session = continuous conversation within a context window. Closes when inactivity exceeds TTL or user explicitly resets.

**Authoritative source:** North Star §14 (Conversational Intelligence); Plan V2 Session 2 decision (this table is NEW).

**Identity model:** Dual-boundary. `tenant_id uuid NOT NULL`, `owner_id text NOT NULL`, `user_id text NOT NULL` (the actor — even in a single-seat reasoning model, we record who asked).

**Columns:**

| name | type | nullability | default | description |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK |
| `tenant_id` | `uuid` | NOT NULL | — | FK → `chiefos_tenants(id)` |
| `owner_id` | `text` | NOT NULL | — | |
| `user_id` | `text` | NOT NULL | — | Actor (owner seat — per North Star §3, exactly one reasoning seat) |
| `source` | `text` | NOT NULL | — | `'whatsapp'` \| `'portal'` |
| `started_at` | `timestamptz` | NOT NULL | `now()` | |
| `last_activity_at` | `timestamptz` | NOT NULL | `now()` | Drives TTL |
| `ended_at` | `timestamptz` | nullable | — | Explicit end or timeout |
| `end_reason` | `text` | nullable | — | `'timeout'` \| `'user_reset'` \| `'context_limit'` |
| `active_entities` | `jsonb` | NOT NULL | `'{}'::jsonb` | Tracked entities ("active job", "date range", etc.) — state per North Star §14 |
| `trace_id` | `text` | NOT NULL | — | Initial request trace id |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |
| `updated_at` | `timestamptz` | NOT NULL | `now()` | |

**Constraints:**
- `CHECK (source IN ('whatsapp','portal'))`
- `CHECK ((ended_at IS NULL) OR (end_reason IS NOT NULL))`
- `UNIQUE (id, tenant_id, owner_id)` — composite FK target
- `CHECK (last_activity_at >= started_at)`

**Indexes:**
- `conversation_sessions_tenant_idx ON (tenant_id, last_activity_at DESC)` — portal "recent conversations" query
- `conversation_sessions_owner_active_idx ON (owner_id, last_activity_at DESC) WHERE ended_at IS NULL` — active-session lookup for next-message-in-session routing

**RLS:** Enabled. Standard tenant-membership policies (Principle 8).

**GRANTs:** `authenticated` = SELECT, INSERT, UPDATE (owner-only per app code check; RLS ensures tenant bound). `service_role` = ALL.

---

#### Table: `public.conversation_messages` *(NEW)*

**Role:** Per-message history for a conversation session. Includes user messages, Chief's responses, and tool invocations (domain-service calls). References the domain entities Chief grounded each response in.

**Authoritative source:** North Star §14 (multi-turn context tracking; references prior answers; drills into jobs/expenses/time/revenue).

**Columns:**

| name | type | nullability | default | description |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK |
| `session_id` | `uuid` | NOT NULL | — | Composite FK to conversation_sessions |
| `tenant_id` | `uuid` | NOT NULL | — | |
| `owner_id` | `text` | NOT NULL | — | |
| `sequence_no` | `integer` | NOT NULL | — | Monotonic sequence within session |
| `role` | `text` | NOT NULL | — | `'user'` \| `'chief'` \| `'system'` \| `'tool'` |
| `content` | `text` | NOT NULL | — | Message body (for user/chief); tool name+args/response (for tool) |
| `tool_name` | `text` | nullable | — | When role='tool' — which domain service was called |
| `tool_input` | `jsonb` | nullable | — | Structured tool input |
| `tool_output` | `jsonb` | nullable | — | Structured tool result |
| `grounded_entities` | `jsonb` | NOT NULL | `'[]'::jsonb` | References to domain rows: `[{"table":"jobs","id":"...","name":"..."}, ...]` |
| `source_msg_id` | `text` | nullable | — | Twilio/etc message id for user messages |
| `provider` | `text` | nullable | — | `'anthropic'` \| `'openai'` — which LLM generated chief messages |
| `model` | `text` | nullable | — | Model name |
| `tokens_in` | `integer` | nullable | — | Token usage |
| `tokens_out` | `integer` | nullable | — | |
| `trace_id` | `text` | NOT NULL | — | Request trace |
| `correlation_id` | `uuid` | NOT NULL | — | §17.21 |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |

**Constraints:**
- Composite FK `(session_id, tenant_id, owner_id) → conversation_sessions(id, tenant_id, owner_id)` per Principle 11
- `CHECK (role IN ('user','chief','system','tool'))`
- `UNIQUE (session_id, sequence_no)` — monotonic ordering guarantee
- `UNIQUE (owner_id, source_msg_id)` partial where non-null — idempotency for user messages

**Indexes:**
- `conversation_messages_session_idx ON (session_id, sequence_no)` — replay order
- `conversation_messages_tenant_idx ON (tenant_id, created_at DESC)` — observability

**RLS + GRANTs:** Standard tenant-scoped; append-only (no UPDATE via RLS); service_role inserts chief/tool rows.

---

#### Table: `public.entity_summary`

**Role:** Per-tenant tracked entity state — what Chief last mentioned, for disambiguating follow-up questions ("what about last month?", "compare that to the previous job").

**Authoritative source:** North Star §14 (entity tracking for reference resolution).

**Classification:** KEEP-WITH-REDESIGN (if existing shape matches use case) — **OR DISCARD and fold `active_entities` column on `conversation_sessions` into this role** if the current `entity_summary` table design isn't clean.

**Decision pending app-code audit (Phase 4):** If `entity_summary` is actively read by the Ask Chief handler for reference resolution, KEEP with redesign to add `tenant_id` and RLS. If the role is adequately covered by `conversation_sessions.active_entities jsonb`, DISCARD. Default assumption: DISCARD and use `active_entities` inline; revisit if Phase 4 reveals an active read path needing denormalized row structure.

---

#### DISCARDED conversation-group tables:

| Table | Rationale |
|---|---|
| `assistant_events` | Ad-hoc event log predating proper conversation spine. Superseded by `conversation_messages` (for message-level) and `chiefos_activity_logs` (for action-level). Phase 4 app audit confirms no live reads; migration does not carry forward. |
| `chief_actor_memory` | Parallel memory store keyed on the "actor" taxonomy being DISCARDed per Decision 12. Functionality subsumed by `conversation_sessions.active_entities` and `conversation_messages.grounded_entities`. DISCARD. |
| `convo_state` | Predecessor to `conversation_sessions`. DISCARD; the new table is the canonical session state. |

---

### 3.11 Audit / Observability

Every canonical write in the rebuilt system emits an audit record. The audit surface has three distinct tables, each with a clear purpose:

- **`chiefos_activity_logs`** — per-action audit (who did what, when, to which row). REDESIGNED per Decision 12.
- **`email_ingest_events`** — per-email audit (one row per inbound email to the capture endpoint). Kept; already tracked.
- **`chiefos_deletion_batches`** — per-delete-batch record for soft-delete undo. Kept; consolidated with `chiefos_txn_delete_batches`.

Plus one table for the integrity chain (§3.2 `transactions` carries the chain; the verification log here records chain audit events):

- **`integrity_verification_log`** — chain verification run results.

Activity log events (`chiefos_activity_log_events`) is consolidated INTO `chiefos_activity_logs` in the redesign — the one-log-to-many-events split in the current schema has no clear purpose post-actor-cluster-discard.

---

#### Table: `public.chiefos_activity_logs`

**Role:** Canonical audit log for actions on canonical tables. One row per committed action (create / update / delete / confirm / export / etc.). Attribution: who, when, to what, payload.

**Authoritative source:** North Star §9 (attribution requirement: "Every write must be attributable"); Decision 12 Option C (actor cluster DISCARD + redesign).

**Classification:** REDESIGN. Actor FK removed; replaced with direct FK to `chiefos_portal_users` + `users`.

**Columns:**

| name | type | nullability | default | description |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK |
| `tenant_id` | `uuid` | NOT NULL | — | FK → `chiefos_tenants(id)` |
| `owner_id` | `text` | NOT NULL | — | |
| `portal_user_id` | `uuid` | nullable | — | FK → `chiefos_portal_users(user_id)` — when action is portal-initiated |
| `actor_user_id` | `text` | nullable | — | FK → `users(user_id)` — when action is ingestion-initiated (WhatsApp) |
| `action_kind` | `text` | NOT NULL | — | `'create'` \| `'update'` \| `'delete'` \| `'confirm'` \| `'void'` \| `'reject'` \| `'export'` \| `'edit_confirm'` \| `'reopen'` |
| `target_table` | `text` | NOT NULL | — | `'transactions'` \| `'jobs'` \| `'chiefos_quotes'` etc. |
| `target_id` | `text` | NOT NULL | — | Row PK of the target (uuid-string or bigint-string) |
| `target_kind` | `text` | nullable | — | Sub-discriminator (e.g., transaction.kind) |
| `payload` | `jsonb` | NOT NULL | `'{}'::jsonb` | Before/after diff, optional note |
| `trace_id` | `text` | NOT NULL | — | Request trace |
| `correlation_id` | `uuid` | NOT NULL | — | §17.21 |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |

**Constraints:**
- `CHECK (action_kind IN ('create','update','delete','confirm','void','reject','export','edit_confirm','reopen'))`
- `CHECK (portal_user_id IS NOT NULL OR actor_user_id IS NOT NULL)` — at least one actor present
- Format CHECK on `target_table`: `^[a-z][a-z_0-9]*$`

**Indexes:**
- `chiefos_activity_logs_tenant_time_idx ON (tenant_id, created_at DESC)` — portal audit-list query
- `chiefos_activity_logs_target_idx ON (target_table, target_id, created_at DESC)` — per-row audit query
- `chiefos_activity_logs_correlation_idx ON (correlation_id)` — causal-chain reconstruction (§17.21)
- `chiefos_activity_logs_portal_user_idx ON (portal_user_id, created_at DESC) WHERE portal_user_id IS NOT NULL` — per-user audit

**RLS:** Enabled. SELECT gated by tenant membership; INSERT only via service role (app code with validated inputs); UPDATE / DELETE denied (append-only via trigger).

**GRANTs:** `authenticated` = SELECT. `service_role` = SELECT, INSERT (not UPDATE / DELETE).

**Append-only enforcement:** Trigger `chiefos_activity_logs_guard_immutable` (SECURITY INVOKER) blocks UPDATE and DELETE. This is the one append-only pattern that justifies a dedicated trigger in the audit group.

---

#### DISCARDED: `public.chiefos_activity_log_events`

**Rationale:** Current schema has `chiefos_activity_logs` (parent) + `chiefos_activity_log_events` (child, one-to-many). Both FK into `chiefos_actors`. Decision 12 DISCARDs the actor cluster; if the one-to-many structure also DISCARDs, the activity log becomes a flat single-row-per-action table. Since no authoritative doc requires the one-to-many split, and the flat structure is simpler and equivalent in information content (multiple related events can share a `correlation_id`), **DISCARD**. Migration does not carry forward.

---

#### Table: `public.chiefos_deletion_batches`

**Role:** Per-batch record for soft-delete operations with undo. One batch covers a group of related row soft-deletes that should undo together.

**Authoritative source:** Execution Playbook §2 (MVP safe-fail + undo discipline).

**Classification:** KEEP-WITH-REDESIGN. Consolidates `chiefos_txn_delete_batches` into this single table (both tables currently exist; `chiefos_txn_delete_batches` is transaction-specific and redundant with the general `chiefos_deletion_batches`).

**Columns:**

| name | type | nullability | default | description |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK |
| `tenant_id` | `uuid` | NOT NULL | — | FK → `chiefos_tenants(id)` |
| `owner_id` | `text` | NOT NULL | — | |
| `portal_user_id` | `uuid` | nullable | — | Initiating portal user |
| `target_table` | `text` | NOT NULL | — | `'transactions'` \| `'jobs'` \| `'time_entries_v2'` etc. |
| `target_ids` | `text[]` | NOT NULL | — | Array of soft-deleted row PKs |
| `reason` | `text` | nullable | — | Optional free-text reason |
| `undo_expires_at` | `timestamptz` | NOT NULL | — | After this, undo closes |
| `undone_at` | `timestamptz` | nullable | — | Set if batch was undone |
| `correlation_id` | `uuid` | NOT NULL | — | Links to `chiefos_activity_logs` rows for each affected row |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |

**RLS + GRANTs:** Standard. `authenticated` = SELECT, INSERT, UPDATE (to mark undone). `service_role` = ALL.

---

#### DISCARDED: `public.chiefos_txn_delete_batches`

**Rationale:** Transaction-specific deletion batch table. Superseded by `chiefos_deletion_batches` with `target_table = 'transactions'`. No distinct functionality. DISCARD.

---

#### Table: `public.email_ingest_events`

**Role:** Per-email audit of inbound capture messages.

**Classification:** KEEP-WITH-REDESIGN (minor: add GRANTs, confirm tenant RLS, composite FK target for future references).

**Key properties (preserved):** `UNIQUE (postmark_msg_id)` for idempotency, tenant-scoped RLS, status enum for processing lifecycle.

---

#### Table: `public.integrity_verification_log`

**Role:** Log of integrity-chain verification runs on `public.transactions` (and `time_entries_v2` if that spine also carries an integrity chain per Decision 10).

**Classification:** KEEP-WITH-REDESIGN.

**Design deltas vs. current:**
- **Enable RLS** (currently `rls_enabled = false`)
- Standard tenant-scoped policies
- Explicit GRANTs per Principle 9
- CHECK on `result`: `('pass','fail','partial')`
- `tenant_id uuid NOT NULL` FK to `chiefos_tenants`

**Columns:** `id uuid PK`, `tenant_id uuid`, `chain` text (`'transactions'` | `'time_entries_v2'`), `started_at`, `completed_at`, `rows_checked`, `rows_failed`, `result`, `failure_details jsonb`, `correlation_id`, `created_at`.

---

#### Table: `public.chiefos_role_audit`

**Role:** Per-role-change audit for `chiefos_portal_users.role`. One row per role mutation (promote/demote/deactivate).

**Classification:** KEEP-WITH-REDESIGN.

**Design deltas vs. current:**
- Actor FK redesigned away from `chiefos_actors` (Decision 12); `acted_by_portal_user_id uuid NOT NULL FK chiefos_portal_users(user_id)` replaces
- Add `correlation_id uuid NOT NULL` per §17.21
- Standard RLS (owner-role-only SELECT; append-only via trigger)
- Explicit GRANTs: `authenticated` = SELECT (owner-only via app code check); `service_role` = SELECT, INSERT

**Purpose clarification:** this table records role changes on `chiefos_portal_users`. General action audit goes to `chiefos_activity_logs`. Kept separate because role changes are security-sensitive and deserve dedicated auditability (e.g., portal UI "who promoted X to owner" view).

---

---

### 3.12 Supporting Tables

Tables classified KEEP-WITH-REDESIGN in §6.1 that don't fit the eleven primary table groups. Each has a dedicated design page below; Phase 3 migration authorship uses these pages as source of truth.

**Session 3 addendum scope: 15 gap tables scanned, 2 upgraded to DISCARD during design investigation, 13 full design pages produced in this section.**

**Gap scan preamble:**
- Tables classified KEEP-WITH-REDESIGN in §6.1: 43
- Of those, with dedicated §3.1–§3.11 design pages: 28
- Of those, without dedicated §3 design pages: 15
- Reclassified to DISCARD during investigation: 2 (`uploads`, `team_member_assignments` — both duplicate existing retained tables; rationale in §6.1 reclassification notes)
- Full design pages produced in §3.12: 13

---

#### Table: `public.tasks`

**Role:** MVP-scope task management — create, assign, list, mark done. One row per task. Attaches to a job optionally. Actor-scoped (owner creates and assigns to self or crew; crew marks own assigned tasks as done).

**Authoritative source:** Execution Playbook §2 MVP item 7 (Tasks: create, assign, list, mark done). North Star §10 (Everything Is a Job — tasks optionally attach).

**Identity model:** Full dual-boundary. `tenant_id uuid NOT NULL`, `owner_id text NOT NULL`. Creator and assignee tracked via portal-user refs (for portal-created/assigned tasks) AND ingestion identity (for WhatsApp-created tasks, where the actor is keyed by digit-string `user_id`).

**Columns:**

| name | type | nullability | default | description |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK. **Changed from `bigint` to `uuid`** per Constitution §2 — current integer `id` is legacy drift |
| `tenant_id` | `uuid` | NOT NULL | — | FK → `chiefos_tenants(id)` |
| `owner_id` | `text` | NOT NULL | — | Ingestion boundary |
| `task_no` | `integer` | NOT NULL | — | Per-tenant sequential; allocated via `chiefos_next_tenant_counter(tenant_id, 'task')` |
| `title` | `text` | NOT NULL | — | Display title; CHECK `char_length(title) BETWEEN 1 AND 280` |
| `body` | `text` | nullable | — | Optional longer description |
| `status` | `text` | NOT NULL | `'open'` | `'open'` \| `'in_progress'` \| `'done'` \| `'cancelled'` |
| `kind` | `text` | NOT NULL | `'general'` | Task type discriminator; `'general'` \| `'follow_up'` \| `'review'` \| `'reminder'` (**renamed from `type` to avoid SQL keyword shadowing**) |
| `job_id` | `uuid` | nullable | — | Optional FK → `jobs(id, tenant_id, owner_id)` composite per Principle 11 |
| `job_no` | `integer` | nullable | — | Denormalized for read-path efficiency; must match `jobs.job_no` when `job_id` present |
| `created_by_portal_user_id` | `uuid` | nullable | — | FK → `chiefos_portal_users(user_id)` when portal-created |
| `created_by_user_id` | `text` | nullable | — | Digit-string ingestion identity when WhatsApp-created; FK → `users(user_id)` |
| `assigned_to_portal_user_id` | `uuid` | nullable | — | FK → `chiefos_portal_users(user_id)` for portal assignees |
| `assigned_to_user_id` | `text` | nullable | — | Digit-string for ingestion-scoped assignees (crew identified by phone) |
| `assignee_display_name` | `text` | nullable | — | Denormalized for display when assignee isn't a portal user (e.g., crew by name) |
| `due_at` | `timestamptz` | nullable | — | Optional due time |
| `completed_at` | `timestamptz` | nullable | — | Set when `status` transitions to `'done'` |
| `completed_by_portal_user_id` | `uuid` | nullable | — | Who marked it done |
| `completed_by_user_id` | `text` | nullable | — | WhatsApp marker — matches assignee_user_id when crew self-closes |
| `source` | `text` | NOT NULL | `'portal'` | `'whatsapp'` \| `'portal'` \| `'system'` |
| `source_msg_id` | `text` | nullable | — | Idempotency key for WhatsApp creation |
| `correlation_id` | `uuid` | NOT NULL | `gen_random_uuid()` | §17.21 threading |
| `deleted_at` | `timestamptz` | nullable | — | Soft-delete |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |
| `updated_at` | `timestamptz` | NOT NULL | `now()` | |

**Columns DISCARDED from the current 18 cols:** `related_entry_id bigint` (unused; Phase 4 grep to confirm), `acceptance_status text` (unconstrained free text with no clear semantic — fold into `status` lifecycle, probably `'in_progress'` state covered it). `type` renamed to `kind` (SQL-reserved avoidance). `completed_by text` → split into portal_user_id + user_id dual-boundary.

**Constraints:**
- `CHECK (status IN ('open','in_progress','done','cancelled'))`
- `CHECK (kind IN ('general','follow_up','review','reminder'))`
- `CHECK (source IN ('whatsapp','portal','system'))`
- `CHECK ((status = 'done') = (completed_at IS NOT NULL))` — `done` iff `completed_at` set
- `CHECK (created_by_portal_user_id IS NOT NULL OR created_by_user_id IS NOT NULL)` — attribution required
- `UNIQUE (tenant_id, task_no)` — per-tenant human-readable numbering
- `UNIQUE (owner_id, source_msg_id)` partial where non-null — idempotency
- `UNIQUE (id, tenant_id, owner_id)` — composite FK target per Principle 11

**Indexes:**
- `tasks_tenant_status_idx` on `(tenant_id, status, created_at DESC)` — portal "open tasks" list
- `tasks_assignee_due_idx` on `(tenant_id, assigned_to_portal_user_id, due_at)` where `assigned_to_portal_user_id IS NOT NULL AND status != 'done'` — "my open tasks due soon" query
- `tasks_assignee_ingestion_idx` on `(owner_id, assigned_to_user_id, due_at)` where `assigned_to_user_id IS NOT NULL AND status != 'done'` — WhatsApp crew task pick-up
- `tasks_job_idx` on `(tenant_id, job_id)` where non-null — per-job task listing
- `tasks_correlation_idx` on `(correlation_id)` — audit trail reconstruction

**RLS:** Enabled. Standard tenant-membership SELECT/INSERT/UPDATE pattern (Principle 8). Plus a role-aware tightening: employees can UPDATE a task only if they're the assignee (`assigned_to_portal_user_id = auth.uid()` or the digit-string `assigned_to_user_id` maps to them). Owners/board can UPDATE any task in tenant.

**GRANTs:** `authenticated` = SELECT, INSERT, UPDATE. `service_role` = ALL.

**Classification:** KEEP-WITH-REDESIGN (significant).

**Design deltas vs. current:**
- `id` type uuid (from `bigint`)
- `tenant_id` added (currently missing — critical for portal RLS)
- `task_no` allocated via generalized `chiefos_next_tenant_counter`, not per-owner `task_counters` (which is DISCARDed)
- Creator/assignee dual-boundary (portal_user_id + user_id pair) rather than single ambiguous text columns
- `type` → `kind` rename (avoids SQL keyword)
- `deleted_at` soft-delete
- `correlation_id` per §17.21

**Cross-spine dependencies:**
- FK → `chiefos_tenants(id)` (tenant boundary)
- FK → `jobs(id, tenant_id, owner_id)` composite (optional job attach)
- FK → `chiefos_portal_users(user_id)` (creator/assignee/completer; where portal-scoped)
- FK → `users(user_id)` (WhatsApp actor; where ingestion-scoped)
- FKs INTO `tasks`: none expected (tasks are a leaf in the dependency graph)

---

#### Table: `public.mileage_logs`

**Role:** Per-trip mileage capture for contractors claiming vehicle expenses. One row per logged trip. Optionally attaches to a job.

**Authoritative source:** Execution Playbook §2 (MVP capture surface — mileage is a capture kind alongside expense/revenue/time).

**Identity model:** Dual-boundary. `tenant_id uuid NOT NULL`, `owner_id text NOT NULL` (ingestion). `employee_user_id text nullable` (driver; may differ from owner when owner logs for crew).

**Columns:**

| name | type | nullability | default | description |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK (**changed from `bigint`** per Constitution §2) |
| `tenant_id` | `uuid` | NOT NULL | — | FK → `chiefos_tenants(id)` |
| `owner_id` | `text` | NOT NULL | — | **Changed type from `uuid` → `text`** — current table has `owner_id uuid` which conflicts with the dual-boundary text convention |
| `employee_user_id` | `text` | nullable | — | Driver (digit-string ingestion identity); null if owner drove |
| `trip_date` | `date` | NOT NULL | — | |
| `job_id` | `uuid` | nullable | — | FK → `jobs(id, tenant_id, owner_id)` composite, optional |
| `job_no` | `integer` | nullable | — | Denormalized |
| `origin` | `text` | nullable | — | |
| `destination` | `text` | nullable | — | |
| `distance` | `numeric(10,2)` | NOT NULL | — | |
| `unit` | `text` | NOT NULL | `'km'` | `'km'` \| `'mi'` |
| `rate_cents` | `integer` | NOT NULL | — | Rate per unit at time of log (historical accuracy) |
| `deductible_cents` | `bigint` | NOT NULL | — | Computed `distance * rate_cents` snapshot |
| `notes` | `text` | nullable | — | |
| `source` | `text` | NOT NULL | `'whatsapp'` | `'whatsapp'` \| `'portal'` \| `'api'` |
| `source_msg_id` | `text` | nullable | — | Idempotency |
| `transaction_id` | `uuid` | nullable | — | FK → `transactions(id, tenant_id, owner_id)` composite — the parallel transactions-row this mileage log mirrors when the owner confirms for expense purposes |
| `deleted_at` | `timestamptz` | nullable | — | |
| `correlation_id` | `uuid` | NOT NULL | `gen_random_uuid()` | |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |
| `updated_at` | `timestamptz` | NOT NULL | `now()` | |

**Decision documented:** Mileage writes emit a parallel `public.transactions` row (kind=`'expense'`, category=`'mileage'`) at confirm time, idempotent via `source_msg_id`. The `mileage_logs.transaction_id` FK stores the linkage. This creates the canonical financial representation (queryable through the canonical spine) while preserving the domain-specific mileage detail here.

**Constraints:**
- `CHECK (unit IN ('km','mi'))`
- `CHECK (source IN ('whatsapp','portal','api'))`
- `CHECK (distance > 0)`
- `CHECK (rate_cents >= 0)`
- `CHECK (deductible_cents >= 0)`
- `UNIQUE (owner_id, source_msg_id)` partial where non-null
- `UNIQUE (id, tenant_id, owner_id)` — composite FK target

**Indexes:**
- `mileage_logs_tenant_date_idx` on `(tenant_id, trip_date DESC)` — portal listing
- `mileage_logs_owner_date_idx` on `(owner_id, trip_date DESC)` — backend
- `mileage_logs_job_idx` on `(tenant_id, job_id)` where non-null — per-job mileage
- `mileage_logs_employee_idx` on `(tenant_id, employee_user_id, trip_date DESC)` where `employee_user_id IS NOT NULL` — per-driver listing

**RLS:** Standard. `authenticated` = SELECT, INSERT, UPDATE. `service_role` = ALL.

**Classification:** KEEP-WITH-REDESIGN. Deltas: `id uuid` (from bigint), `owner_id text` (from uuid — current schema drift), `transaction_id` linkage column added, composite FKs for job + transaction refs, source enum, explicit unit CHECK.

**Cross-spine dependencies:**
- FK → `chiefos_tenants(id)`
- FK → `jobs(id, tenant_id, owner_id)` composite
- FK → `transactions(id, tenant_id, owner_id)` composite (parallel-row link)
- FKs INTO `mileage_logs`: none expected

---

#### Table: `public.overhead_items`

**Role:** Recurring business overhead definitions (rent, utilities, insurance, subscriptions). One row per recurring item. Parent to `overhead_payments` (per-payment records) and `overhead_reminders` (upcoming-payment notifications).

**Authoritative source:** Execution Playbook §2 (overhead tracking — recurring expense category; supports monthly P&L and tax readiness).

**Identity model:** Dual-boundary. `tenant_id`, `owner_id`.

**Columns:**

| name | type | nullability | default | description |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK |
| `tenant_id` | `uuid` | NOT NULL | — | FK → `chiefos_tenants(id)` |
| `owner_id` | `text` | NOT NULL | — | **Changed from nullable to NOT NULL** — every item belongs to an owner |
| `name` | `text` | NOT NULL | — | `char_length BETWEEN 1 AND 120` |
| `category` | `text` | NOT NULL | `'other'` | `'rent'` \| `'utilities'` \| `'insurance'` \| `'subscription'` \| `'loan'` \| `'other'` |
| `item_type` | `text` | NOT NULL | `'recurring'` | `'recurring'` \| `'amortized'` \| `'one_time'` |
| `amount_cents` | `bigint` | NOT NULL | — | CHECK >= 0 |
| `currency` | `text` | NOT NULL | `'CAD'` | Added for currency awareness (current schema lacks) |
| `frequency` | `text` | NOT NULL | `'monthly'` | `'monthly'` \| `'weekly'` \| `'quarterly'` \| `'annually'` \| `'one_time'` |
| `due_day` | `integer` | nullable | — | Day-of-month for monthly; CHECK 1–31 |
| `amortization_months` | `integer` | nullable | — | For `item_type = 'amortized'`; CHECK > 0 |
| `start_date` | `date` | nullable | — | |
| `end_date` | `date` | nullable | — | |
| `next_due_at` | `date` | nullable | — | Maintained by handler; used by reminder scheduler |
| `tax_amount_cents` | `bigint` | nullable | — | Optional tax portion |
| `notes` | `text` | nullable | — | |
| `source` | `text` | NOT NULL | `'portal'` | `'whatsapp'` \| `'portal'` \| `'api'` |
| `source_msg_id` | `text` | nullable | — | |
| `active` | `boolean` | NOT NULL | `true` | |
| `deleted_at` | `timestamptz` | nullable | — | |
| `correlation_id` | `uuid` | NOT NULL | `gen_random_uuid()` | |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |
| `updated_at` | `timestamptz` | NOT NULL | `now()` | |

**Constraints:**
- `CHECK (category IN ('rent','utilities','insurance','subscription','loan','other'))`
- `CHECK (item_type IN ('recurring','amortized','one_time'))`
- `CHECK (frequency IN ('monthly','weekly','quarterly','annually','one_time'))`
- `CHECK (amount_cents >= 0)`
- `CHECK (due_day IS NULL OR (due_day BETWEEN 1 AND 31))`
- `CHECK ((item_type = 'amortized') = (amortization_months IS NOT NULL))`
- `CHECK (currency IN ('CAD','USD'))`
- `CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)`
- `UNIQUE (owner_id, source_msg_id)` partial where non-null
- `UNIQUE (id, tenant_id, owner_id)` — composite FK target for payments/reminders

**Indexes:**
- `overhead_items_tenant_active_idx` on `(tenant_id, active, next_due_at)` where `active = true` — active-items reminder query
- `overhead_items_tenant_category_idx` on `(tenant_id, category, active)` — portal listing
- `overhead_items_next_due_idx` on `(tenant_id, next_due_at)` where `active = true AND next_due_at IS NOT NULL` — upcoming-items scheduler

**RLS:** Standard. `authenticated` = SELECT, INSERT, UPDATE. `service_role` = ALL.

**Classification:** KEEP-WITH-REDESIGN. Deltas: `owner_id` NOT NULL (currently nullable), `currency` added, CHECKs added on category/frequency/item_type, composite FK target.

**Cross-spine dependencies:**
- FK → `chiefos_tenants(id)`
- FKs INTO: `overhead_payments`, `overhead_reminders` (both composite per Principle 11)

---

#### Table: `public.overhead_payments`

**Role:** Per-payment record for an overhead item. One row per payment event. Optionally links to a parallel `transactions` row (kind=`'expense'`) when the payment should appear in the canonical ledger.

**Authoritative source:** Execution Playbook §2 (overhead tracking — payment reconciliation).

**Identity model:** Dual-boundary inherited from parent overhead_item; tenant_id + owner_id present explicitly.

**Columns:**

| name | type | nullability | default | description |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK |
| `tenant_id` | `uuid` | NOT NULL | — | FK → `chiefos_tenants(id)` |
| `owner_id` | `text` | NOT NULL | — | **Added from current schema** — current table has no owner_id column |
| `item_id` | `uuid` | NOT NULL | — | FK → `overhead_items(id, tenant_id, owner_id)` composite per Principle 11 |
| `period_year` | `integer` | NOT NULL | — | e.g., 2026 |
| `period_month` | `integer` | NOT NULL | — | 1–12 |
| `paid_date` | `date` | nullable | — | Null until confirmed paid |
| `amount_cents` | `bigint` | NOT NULL | — | CHECK >= 0 |
| `tax_amount_cents` | `bigint` | nullable | — | |
| `currency` | `text` | NOT NULL | `'CAD'` | |
| `source` | `text` | NOT NULL | `'manual'` | `'manual'` \| `'whatsapp'` \| `'portal'` \| `'import'` |
| `confirmed_at` | `timestamptz` | NOT NULL | `now()` | |
| `source_msg_id` | `text` | nullable | — | |
| `transaction_id` | `uuid` | nullable | — | FK → `transactions(id, tenant_id, owner_id)` composite — parallel ledger row link |
| `correlation_id` | `uuid` | NOT NULL | `gen_random_uuid()` | |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |

**Decision documented:** Overhead payments emit a parallel `transactions` row (kind=`'expense'`, category=item.category) at confirm time, idempotent via `source_msg_id`. Same pattern as `mileage_logs`.

**Constraints:**
- `CHECK (period_month BETWEEN 1 AND 12)`
- `CHECK (period_year BETWEEN 2024 AND 2100)`
- `CHECK (amount_cents >= 0)`
- `CHECK (source IN ('manual','whatsapp','portal','import'))`
- `CHECK (currency IN ('CAD','USD'))`
- `UNIQUE (item_id, period_year, period_month)` — one payment per item per month (append-only within period; adjustments use negative amounts)
- `UNIQUE (owner_id, source_msg_id)` partial where non-null

**Indexes:**
- `overhead_payments_tenant_period_idx` on `(tenant_id, period_year DESC, period_month DESC)` — portal listing
- `overhead_payments_item_idx` on `(item_id, period_year DESC, period_month DESC)` — per-item history

**RLS:** Standard. `authenticated` = SELECT, INSERT, UPDATE. `service_role` = ALL.

**Classification:** KEEP-WITH-REDESIGN. Deltas: `owner_id` added (currently absent — a dual-boundary violation), composite FK to items + transactions, `correlation_id`, `currency` column.

**Cross-spine dependencies:**
- FK → `overhead_items(id, tenant_id, owner_id)` composite
- FK → `transactions(id, tenant_id, owner_id)` composite (parallel-row link)
- FK → `chiefos_tenants(id)`

---

#### Table: `public.overhead_reminders`

**Role:** Scheduled reminder events for upcoming overhead payments. One row per (item, upcoming period) triggered reminder.

**Authoritative source:** Execution Playbook §2 (overhead-reminder dispatch).

**Note:** This table stays despite the general `reminders` feature being DISCARDed (per the REVIEW stance in §6.1) — overhead reminders are tightly coupled to `overhead_items` lifecycle and serve a specific, well-scoped purpose.

**Columns:**

| name | type | nullability | default | description |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK |
| `tenant_id` | `uuid` | NOT NULL | — | FK → `chiefos_tenants(id)` |
| `owner_id` | `text` | NOT NULL | — | **Added from current schema** |
| `item_id` | `uuid` | NOT NULL | — | FK → `overhead_items(id, tenant_id, owner_id)` composite |
| `item_name` | `text` | NOT NULL | — | Denormalized for display |
| `period_year` | `integer` | NOT NULL | — | |
| `period_month` | `integer` | NOT NULL | — | |
| `amount_cents` | `bigint` | NOT NULL | — | |
| `tax_amount_cents` | `bigint` | nullable | — | |
| `status` | `text` | NOT NULL | `'pending'` | `'pending'` \| `'sent'` \| `'acknowledged'` \| `'cancelled'` |
| `whatsapp_sent_at` | `timestamptz` | nullable | — | |
| `correlation_id` | `uuid` | NOT NULL | `gen_random_uuid()` | |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |

**Constraints:**
- `CHECK (status IN ('pending','sent','acknowledged','cancelled'))`
- `CHECK (period_month BETWEEN 1 AND 12)`
- `CHECK (period_year BETWEEN 2024 AND 2100)`
- `UNIQUE (item_id, period_year, period_month)` — one reminder per item per month

**Indexes:**
- `overhead_reminders_tenant_status_idx` on `(tenant_id, status, created_at DESC)` — dispatcher queue
- `overhead_reminders_item_idx` on `(item_id)` — per-item reminder history

**RLS:** Standard.

**GRANTs:** `authenticated` = SELECT. `service_role` = SELECT, INSERT, UPDATE (cron dispatch updates status).

**Classification:** KEEP-WITH-REDESIGN. Deltas: `owner_id` added, composite FK to items, status enum CHECK, `correlation_id`.

**Cross-spine dependencies:**
- FK → `overhead_items(id, tenant_id, owner_id)` composite
- FK → `chiefos_tenants(id)`

---

#### Table: `public.stripe_events`

**Role:** Stripe webhook idempotency and audit log. One row per Stripe event received. Service-role only — no portal surface.

**Authoritative source:** Monetization §9 (Stripe integration requirements: "Webhook verifies signature; no plan drift between DB and Stripe"). Implicit in handoff §5.4's `stripe_event_id` idempotency pattern on `quota_allotments` and `addon_purchases_yearly`.

**Identity model:** Backend-only. `tenant_id uuid nullable` — some Stripe events (e.g., `account.*`) are account-level, not tenant-scoped.

**Columns:**

| name | type | nullability | default | description |
|---|---|---|---|---|
| `stripe_event_id` | `text` | NOT NULL | — | PK. Stripe's `evt_*` identifier |
| `event_type` | `text` | NOT NULL | — | Stripe event type (`'customer.subscription.updated'` etc.) |
| `tenant_id` | `uuid` | nullable | — | Resolved from payload when possible |
| `owner_id` | `text` | nullable | — | Resolved from `stripe_customer_id` → `users.owner_id` |
| `payload` | `jsonb` | NOT NULL | — | Full event payload (for audit + replay) |
| `signature` | `text` | NOT NULL | — | Raw Stripe signature header (for audit) |
| `received_at` | `timestamptz` | NOT NULL | `now()` | |
| `processed_at` | `timestamptz` | nullable | — | Set when handler completes successfully |
| `status` | `text` | NOT NULL | `'received'` | `'received'` \| `'processed'` \| `'failed'` \| `'skipped'` |
| `error_message` | `text` | nullable | — | Set when status = 'failed' |
| `correlation_id` | `uuid` | NOT NULL | `gen_random_uuid()` | |

**Constraints:**
- PK on `stripe_event_id` (Stripe's guarantee of unique event id gives us idempotency for free)
- `CHECK (status IN ('received','processed','failed','skipped'))`
- `CHECK ((status = 'processed') = (processed_at IS NOT NULL))`

**Indexes:**
- `stripe_events_received_idx` on `(received_at DESC)` — dispatcher order
- `stripe_events_tenant_received_idx` on `(tenant_id, received_at DESC)` where `tenant_id IS NOT NULL` — per-tenant audit
- `stripe_events_status_idx` on `(status, received_at)` where `status IN ('received','failed')` — retry queue

**RLS:** Enabled; **no policies for `authenticated`** — service role only. Portal does not read Stripe events directly; any portal-facing billing view reads `users.sub_status` etc.

**GRANTs:** `authenticated` = (none). `service_role` = SELECT, INSERT, UPDATE.

**Append-only enforcement:** Trigger blocks DELETE and UPDATEs except `status`/`processed_at`/`error_message` transitions.

**Classification:** KEEP-WITH-REDESIGN (substantial — current table has only 3 cols). Deltas: add `payload`, `signature`, `tenant_id`, `owner_id`, `status`, `error_message`, `processed_at`, `correlation_id`. Enable RLS (currently `rls_enabled = false`).

**Cross-spine dependencies:** 
- No FKs (Stripe event payload may reference entities; we don't FK because Stripe is authoritative and may arrive before our mirrored rows)

---

#### Table: `public.llm_cost_log`

**Role:** Per-LLM-call cost and usage tracking. One row per provider call (Claude, OpenAI, etc.). Feeds the Developer Observability Dashboard (Plan V2 Session 16) and tenant COGS telemetry.

**Authoritative source:** Handoff §12 (Developer Observability Dashboard). Constitution §10 (reliability + observability).

**Identity model:** `tenant_id` + `owner_id` (both nullable — some calls are pre-auth or system-level).

**Columns:**

| name | type | nullability | default | description |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK (**changed from bigint**) |
| `tenant_id` | `uuid` | nullable | — | Resolved from context when possible |
| `owner_id` | `text` | nullable | — | |
| `feature_kind` | `text` | NOT NULL | — | `'ask_chief'` \| `'receipt_audit'` \| `'voice_transcription'` \| `'summarize'` \| etc. (**renamed from `query_kind`**) |
| `provider` | `text` | NOT NULL | — | `'anthropic'` \| `'openai'` \| `'google'` |
| `model` | `text` | NOT NULL | — | Full model name (e.g., `'claude-sonnet-4-6'`) |
| `input_tokens` | `integer` | NOT NULL | `0` | CHECK >= 0 |
| `output_tokens` | `integer` | NOT NULL | `0` | CHECK >= 0 |
| `cache_read_tokens` | `integer` | NOT NULL | `0` | Prompt-cache hit tokens |
| `cache_write_tokens` | `integer` | NOT NULL | `0` | Prompt-cache write tokens |
| `latency_ms` | `integer` | NOT NULL | `0` | |
| `cost_cents` | `bigint` | NOT NULL | `0` | **Changed from `cost_usd numeric` — unify with cents-based financial spine** |
| `trace_id` | `text` | nullable | — | Request trace for cross-system correlation |
| `correlation_id` | `uuid` | nullable | — | §17.21 when available |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |

**Constraints:**
- `CHECK (provider IN ('anthropic','openai','google'))`
- `CHECK (input_tokens >= 0 AND output_tokens >= 0)`
- `CHECK (cost_cents >= 0)`

**Indexes:**
- `llm_cost_log_tenant_month_idx` on `(tenant_id, created_at DESC)` where `tenant_id IS NOT NULL` — per-tenant cost query
- `llm_cost_log_feature_kind_idx` on `(feature_kind, created_at DESC)` — per-feature aggregate
- `llm_cost_log_provider_model_idx` on `(provider, model, created_at DESC)` — per-model cost analysis

**RLS:** Enabled. SELECT restricted to tenant members when `tenant_id` present; service-role INSERT-only.

**GRANTs:** `authenticated` = SELECT (tenant-scoped). `service_role` = SELECT, INSERT.

**Append-only:** Trigger blocks UPDATE and DELETE.

**Retention:** Phase 3 decision — suggest 90 days rolling with older rows rolled up into monthly aggregates (separate rollup table design is Plan V2 Session 16's job, not this rebuild's).

**Classification:** KEEP-WITH-REDESIGN (moderate). Deltas: `id uuid`, `cost_usd` → `cost_cents`, `query_kind` → `feature_kind` (matches the enum used in quota_allotments), `trace_id` + `correlation_id` added, RLS enabled, GRANTs explicit.

**Cross-spine dependencies:**
- No FKs (log is write-and-forget; referential integrity not needed)

---

#### Table: `public.error_logs`

**Role:** Backend error log. One row per uncaught-but-reported error. Service-role writes, tenant-member reads scoped to `tenant_id`.

**Authoritative source:** Constitution §9 (Error handling envelope format; every error has a `trace_id`).

**Identity model:** `tenant_id uuid nullable` (some errors predate tenant resolution), `owner_id text nullable`.

**Columns:**

| name | type | nullability | default | description |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK (**changed from bigint**) |
| `tenant_id` | `uuid` | nullable | — | Present when resolvable |
| `owner_id` | `text` | nullable | — | Present when resolvable |
| `user_id` | `text` | nullable | — | Ingestion-side actor |
| `error_code` | `text` | NOT NULL | — | Constitution §9 enum: `'PERMISSION_DENIED'`, `'TENANT_MISSING'`, `'OVER_QUOTA'`, etc. (or free-form for ad-hoc) |
| `error_message` | `text` | NOT NULL | — | User-safe message (no stack, no PII) |
| `error_stack` | `jsonb` | nullable | — | Developer-side stack trace as structured jsonb (`{frames: [...]}` etc.) |
| `context` | `jsonb` | nullable | — | Structured request context |
| `from_user` | `text` | nullable | — | Phone or email of the actor when available |
| `request_id` | `text` | nullable | — | HTTP request id |
| `trace_id` | `text` | NOT NULL | — | Mandatory per Constitution §9 |
| `correlation_id` | `uuid` | nullable | — | §17.21 when available |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |

**Constraints:**
- `CHECK (char_length(trace_id) > 0)`
- No FKs — error logs must succeed even when tenant/owner resolution failed

**Indexes:**
- `error_logs_tenant_time_idx` on `(tenant_id, created_at DESC)` where `tenant_id IS NOT NULL` — per-tenant error listing
- `error_logs_code_time_idx` on `(error_code, created_at DESC)` — alert dashboards
- `error_logs_trace_idx` on `(trace_id)` — cross-system debug join

**RLS:** Enabled. SELECT policy: `(tenant_id IS NULL) OR (tenant_id IN (SELECT tenant_id FROM chiefos_portal_users WHERE user_id = auth.uid()))` — tenant-members see their tenant's errors; null-tenant errors are service-role only.

**GRANTs:** `authenticated` = SELECT (RLS-gated). `service_role` = SELECT, INSERT.

**Append-only:** Trigger blocks UPDATE and DELETE.

**Retention:** Phase 3 decision — suggest 30 days rolling. Delete-older cron job runs nightly.

**Classification:** KEEP-WITH-REDESIGN (substantial). Deltas: `id uuid`, structured `error_stack jsonb` instead of text, `trace_id` NOT NULL, `correlation_id`, RLS policies formalized, append-only trigger.

**Cross-spine dependencies:** None (intentional).

---

#### Table: `public.settings`

**Role:** Key-value settings per owner, with optional tenant-wide scope. Feature flags, UI preferences, policy overrides.

**Authoritative source:** Execution Playbook §2 (onboarding settings — business name, timezone, tax region, policies).

**Identity model:** `tenant_id uuid NOT NULL`, `owner_id text NOT NULL` (scope: `owner` → owner-specific, `tenant` → tenant-wide; see `scope` column).

**Columns:**

| name | type | nullability | default | description |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK (**changed from bigint**) |
| `tenant_id` | `uuid` | NOT NULL | — | FK → `chiefos_tenants(id)` — **added from current schema** (currently missing) |
| `owner_id` | `text` | NOT NULL | — | |
| `scope` | `text` | NOT NULL | `'owner'` | `'owner'` \| `'tenant'` — discriminates personal vs. tenant-wide settings |
| `key` | `text` | NOT NULL | — | Dotted-namespace key (`'ui.timezone'`, `'policy.paid_break_minutes'`) |
| `value` | `jsonb` | NOT NULL | — | **Changed from `text` to `jsonb`** for structured settings |
| `updated_by_portal_user_id` | `uuid` | nullable | — | |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |
| `updated_at` | `timestamptz` | NOT NULL | `now()` | |

**Design decision documented:** Rather than a separate `tenant_settings` table, use a `scope` column on this single `settings` table. Rationale: keeps the key-value pattern uniform, avoids a parallel table with identical shape, lets portal query both scopes with one read. Trade-off: `UNIQUE` constraint is 3-column.

**Constraints:**
- `CHECK (scope IN ('owner','tenant'))`
- `CHECK (key ~ '^[a-z][a-z0-9_.]*$')` — dotted-namespace format
- `UNIQUE (owner_id, scope, key)` — one setting per (owner, scope, key)
- For `scope = 'tenant'`, all owners' rows should share the same value — enforced by app code (UPDATE to tenant-scope key writes to all owner_id rows in the tenant); not DB-enforced

**Indexes:**
- `settings_tenant_scope_key_idx` on `(tenant_id, scope, key)` — portal lookup
- `settings_owner_key_idx` on `(owner_id, key)` where `scope = 'owner'` — per-owner settings fetch

**RLS:** Enabled. SELECT: tenant-membership. UPDATE: `scope = 'owner'` allowed for the owner themselves; `scope = 'tenant'` allowed only for `role = 'owner'` member.

**GRANTs:** `authenticated` = SELECT, UPDATE (RLS further gates). `service_role` = ALL.

**Classification:** KEEP-WITH-REDESIGN (moderate). Deltas: `id uuid`, `tenant_id` added (critical), `value` → jsonb, `scope` enum added to support tenant-wide settings, updated_by tracking.

**Cross-spine dependencies:**
- FK → `chiefos_tenants(id)`

---

#### Table: `public.import_batches`

**Role:** Bulk import tracking (CSV expenses/revenue uploads, QuickBooks exports, year-end reconciliation imports). One row per import batch. Parent-referenced by `transactions.import_batch_id` and `time_entries_v2.import_batch_id`.

**Authoritative source:** Execution Playbook §2 (bulk import / year-end pack); referenced by existing canonical tables via `import_batch_id` FK.

**Identity model:** Dual-boundary.

**Columns:**

| name | type | nullability | default | description |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK |
| `tenant_id` | `uuid` | NOT NULL | — | FK → `chiefos_tenants(id)` |
| `owner_id` | `text` | NOT NULL | — | |
| `initiated_by_portal_user_id` | `uuid` | nullable | — | FK → `chiefos_portal_users(user_id)` |
| `kind` | `text` | NOT NULL | — | `'csv_expenses'` \| `'csv_revenue'` \| `'csv_time'` \| `'quickbooks_export'` \| `'other'` |
| `source_file_name` | `text` | nullable | — | Original upload filename (display) |
| `media_asset_id` | `uuid` | nullable | — | FK → `media_assets(id, tenant_id)` composite — the uploaded source file |
| `row_count` | `integer` | NOT NULL | `0` | Total rows in input |
| `success_count` | `integer` | NOT NULL | `0` | Rows successfully written |
| `error_count` | `integer` | NOT NULL | `0` | Rows that failed validation |
| `status` | `text` | NOT NULL | `'pending'` | `'pending'` \| `'processing'` \| `'completed'` \| `'failed'` \| `'cancelled'` |
| `error_summary` | `jsonb` | nullable | — | Structured per-row error details |
| `correlation_id` | `uuid` | NOT NULL | `gen_random_uuid()` | Threads across all rows in the batch |
| `started_at` | `timestamptz` | nullable | — | |
| `completed_at` | `timestamptz` | nullable | — | |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |

**Constraints:**
- `CHECK (kind IN ('csv_expenses','csv_revenue','csv_time','quickbooks_export','other'))`
- `CHECK (status IN ('pending','processing','completed','failed','cancelled'))`
- `CHECK (success_count + error_count <= row_count)`
- `CHECK ((status = 'completed') = (completed_at IS NOT NULL))`
- `UNIQUE (id, tenant_id)` — composite FK target for `transactions.import_batch_id`

**Indexes:**
- `import_batches_tenant_status_idx` on `(tenant_id, status, created_at DESC)` — portal history
- `import_batches_portal_user_idx` on `(initiated_by_portal_user_id, created_at DESC)` where non-null — "my imports" view

**RLS:** Standard tenant-membership.

**GRANTs:** `authenticated` = SELECT, INSERT, UPDATE. `service_role` = ALL.

**Classification:** KEEP-WITH-REDESIGN (substantial). Current table has only 7 cols; redesign adds `initiated_by_portal_user_id`, `media_asset_id`, `success_count`, `error_count`, `status`, `error_summary`, `correlation_id`, `started_at`, `completed_at`. Adds composite FK target.

**Cross-spine dependencies:**
- FK → `chiefos_tenants(id)`
- FK → `chiefos_portal_users(user_id)` (nullable — system imports possible)
- FK → `media_assets(id, tenant_id)` composite (nullable)
- FKs INTO: `transactions.import_batch_id`, `time_entries_v2.import_batch_id`

---

#### Table: `public.employee_invites`

**Role:** Invite flow for adding crew members to a tenant. Token-based; owner/admin generates; recipient clicks or types a code to pair their phone.

**Authoritative source:** Execution Playbook §2 item 7 (crew self-logging requires invite flow); Monetization §2 (Pro tier employee seats).

**Identity model:** `tenant_id` + `owner_id` (inviter-side). Claimed by an `auth.users.id` after signup (recipient-side).

**Columns:**

| name | type | nullability | default | description |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK |
| `tenant_id` | `uuid` | NOT NULL | — | FK → `chiefos_tenants(id)` |
| `owner_id` | `text` | NOT NULL | — | |
| `invited_by_portal_user_id` | `uuid` | NOT NULL | — | FK → `chiefos_portal_users(user_id)` (**renamed from no-column current**) |
| `token` | `text` | NOT NULL | `encode(gen_random_bytes(16), 'hex')` | URL-safe 32-char hex |
| `employee_name` | `text` | nullable | — | Display name of invitee |
| `invite_phone` | `text` | nullable | — | Expected phone (optional; validates against acceptor) |
| `invite_email` | `text` | nullable | — | Expected email (optional) |
| `invited_role` | `text` | NOT NULL | `'employee'` | `'employee'` \| `'board_member'` |
| `status` | `text` | NOT NULL | `'pending'` | `'pending'` \| `'accepted'` \| `'expired'` \| `'revoked'` |
| `expires_at` | `timestamptz` | NOT NULL | `now() + interval '7 days'` | |
| `accepted_at` | `timestamptz` | nullable | — | |
| `accepted_by_auth_user_id` | `uuid` | nullable | — | `auth.users(id)` of the acceptor |
| `revoked_at` | `timestamptz` | nullable | — | |
| `revoked_by_portal_user_id` | `uuid` | nullable | — | |
| `correlation_id` | `uuid` | NOT NULL | `gen_random_uuid()` | |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |

**Constraints:**
- `UNIQUE (token)` — token-lookup
- `CHECK (status IN ('pending','accepted','expired','revoked'))`
- `CHECK (invited_role IN ('employee','board_member'))`
- `CHECK ((status = 'accepted') = (accepted_at IS NOT NULL AND accepted_by_auth_user_id IS NOT NULL))`
- `CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))`
- `CHECK (invite_phone IS NOT NULL OR invite_email IS NOT NULL)` — at least one contact channel

**Indexes:**
- `employee_invites_tenant_status_idx` on `(tenant_id, status, created_at DESC)` — portal pending-invites view
- `employee_invites_token_idx` — already the UNIQUE index
- `employee_invites_accepted_by_idx` on `(accepted_by_auth_user_id)` where non-null — for anti-abuse / reporting

**RLS:** Enabled. SELECT/INSERT/UPDATE gated by `role IN ('owner','board_member')` in the inviting tenant. The acceptance flow does NOT go through RLS — the accept endpoint runs in service-role context and validates the token explicitly.

**GRANTs:** `authenticated` = SELECT, INSERT, UPDATE. `service_role` = ALL.

**Interaction with `portal_phone_link_otp`:** Invite acceptance and phone pairing are separate flows. An invite links `auth.users.id` to a tenant in `chiefos_portal_users`; OTP pairs a phone to an `auth.users.id`. A new crew member typically accepts an invite first, then pairs a phone via OTP. Phase 3 migration authors both tables cleanly without conflating.

**Classification:** KEEP-WITH-REDESIGN (moderate). Current table has 12 cols; redesign adds `invited_by_portal_user_id`, `revoked_at`/`revoked_by_portal_user_id`, `accepted_by_auth_user_id` (explicitly typed), `correlation_id`; tightens CHECKs on status/role consistency.

**Cross-spine dependencies:**
- FK → `chiefos_tenants(id)`
- FK → `chiefos_portal_users(user_id)` (inviter, revoker)
- FK to `auth.users(id)` (acceptor) — crosses into Supabase Auth schema; nullable until accepted

---

#### Table: `public.chiefos_crew_rates`

**Role:** Historical pay-rate records per crew member. Append-only within a (portal_user_id, effective_from) — rate changes mean inserting a new row with a new `effective_from`.

**Authoritative source:** Execution Playbook §2 item 6 (payroll-aware timeclock; rate at time of shift).

**Identity model:** Tenant-scoped. `portal_user_id` identifies the crew member (portal surface).

**Columns:**

| name | type | nullability | default | description |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK (**changed from bigint**) |
| `tenant_id` | `uuid` | NOT NULL | — | FK → `chiefos_tenants(id)` |
| `owner_id` | `text` | NOT NULL | — | |
| `portal_user_id` | `uuid` | nullable | — | FK → `chiefos_portal_users(user_id)` — preferred attribution |
| `employee_user_id` | `text` | nullable | — | Digit-string fallback when crew member isn't a portal user yet |
| `employee_name` | `text` | nullable | — | Denormalized display; retained for backwards compatibility with current schema |
| `hourly_rate_cents` | `integer` | NOT NULL | `0` | CHECK >= 0 |
| `currency` | `text` | NOT NULL | `'CAD'` | |
| `effective_from` | `date` | NOT NULL | `CURRENT_DATE` | |
| `effective_to` | `date` | nullable | — | NULL means currently active |
| `set_by_portal_user_id` | `uuid` | nullable | — | Who set this rate |
| `notes` | `text` | nullable | — | Reason for rate change |
| `correlation_id` | `uuid` | NOT NULL | `gen_random_uuid()` | |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |
| `updated_at` | `timestamptz` | NOT NULL | `now()` | |

**Historical accuracy:** Rates are append-only within a `portal_user_id` (or `employee_user_id`). Updating a rate = inserting a new row; app code atomically sets the previous row's `effective_to`. This preserves payroll audit integrity.

**Constraints:**
- `CHECK (portal_user_id IS NOT NULL OR employee_user_id IS NOT NULL OR employee_name IS NOT NULL)` — at least one identifier
- `CHECK (hourly_rate_cents >= 0)`
- `CHECK (currency IN ('CAD','USD'))`
- `CHECK (effective_to IS NULL OR effective_to > effective_from)`
- `UNIQUE (tenant_id, portal_user_id, effective_from)` partial where `portal_user_id IS NOT NULL`
- `UNIQUE (tenant_id, employee_user_id, effective_from)` partial where `employee_user_id IS NOT NULL AND portal_user_id IS NULL`

**Indexes:**
- `chiefos_crew_rates_tenant_portal_active_idx` on `(tenant_id, portal_user_id)` where `effective_to IS NULL AND portal_user_id IS NOT NULL` — "current rate for this crew member"
- `chiefos_crew_rates_tenant_employee_active_idx` on `(tenant_id, employee_user_id)` where `effective_to IS NULL AND employee_user_id IS NOT NULL`

**RLS:** Enabled. SELECT restricted to `role IN ('owner','board_member')` in the tenant — rates are confidential from the employee being paid. INSERT/UPDATE owner-only.

**GRANTs:** `authenticated` = SELECT, INSERT, UPDATE (RLS tightens). `service_role` = ALL.

**Classification:** KEEP-WITH-REDESIGN. Deltas: `id uuid` (from bigint), `portal_user_id` added (current table uses employee_name only — weak), composite FK discipline, partial uniques, role-restricted RLS.

**Cross-spine dependencies:**
- FK → `chiefos_tenants(id)`
- FK → `chiefos_portal_users(user_id)` (nullable)
- FK → `users(user_id)` via `employee_user_id` (nullable; digit-string → users.user_id)
- Referenced by: timeclock cost calculation (app-side read during timesheet rollup)

---

#### Table: `public.customers`

**Role:** Customers (the contractor's clients — the contractual party on the receiving end of quotes/invoices). Per North Star §14.11 Cross-Cutting Pattern, customers are an **auth-orthogonal** actor role: they interact via share tokens, not via `auth.users` logins.

**Authoritative source:** North Star §14.11 (customer-initiated actor role); Quotes spine Phase 3 §27; Execution Playbook §2 Beta items (quotes → invoice → customer receipt flow).

**Identity model:** Tenant-scoped. No `auth.users` linkage. Each customer is a `customers.id uuid`, scoped to a `tenant_id`.

**Columns:**

| name | type | nullability | default | description |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | PK |
| `tenant_id` | `uuid` | NOT NULL | — | FK → `chiefos_tenants(id)` |
| `owner_id` | `text` | NOT NULL | — | **Added — currently missing** |
| `name` | `text` | NOT NULL | — | CHECK char_length BETWEEN 1 AND 200 |
| `phone` | `text` | nullable | — | E.164 preferred |
| `email` | `text` | nullable | — | |
| `address_line1` | `text` | nullable | — | **Split from single `address text`** for structured address |
| `address_line2` | `text` | nullable | — | |
| `city` | `text` | nullable | — | |
| `province` | `text` | nullable | — | |
| `postal_code` | `text` | nullable | — | |
| `country` | `text` | NOT NULL | `'CA'` | ISO-2 |
| `notes` | `text` | nullable | — | |
| `source` | `text` | NOT NULL | `'portal'` | `'whatsapp'` \| `'portal'` \| `'import'` \| `'quote_handshake'` |
| `source_msg_id` | `text` | nullable | — | |
| `deleted_at` | `timestamptz` | nullable | — | |
| `correlation_id` | `uuid` | NOT NULL | `gen_random_uuid()` | |
| `created_at` | `timestamptz` | NOT NULL | `now()` | |
| `updated_at` | `timestamptz` | NOT NULL | `now()` | |

**Constraints:**
- `CHECK (source IN ('whatsapp','portal','import','quote_handshake'))`
- `CHECK (char_length(country) = 2 AND country = upper(country))`
- `UNIQUE (owner_id, source_msg_id)` partial where non-null
- `UNIQUE (id, tenant_id, owner_id)` — composite FK target per Principle 11

**Indexes:**
- `customers_tenant_name_idx` on `(tenant_id, lower(name))` — portal search-by-name
- `customers_tenant_email_idx` on `(tenant_id, lower(email))` where non-null — email lookup
- `customers_tenant_phone_idx` on `(tenant_id, phone)` where non-null — phone lookup (for inbound quote-link clicks)
- `customers_deleted_idx` on `(tenant_id, deleted_at)` where non-null

**RLS:** **Enable RLS** (currently `rls_enabled = false` per verification report — one of the 14 tenant-scoped-no-RLS tables). Standard tenant-membership pattern. SELECT/INSERT/UPDATE for any tenant member; DELETE for `role IN ('owner','board_member')`.

**GRANTs:** `authenticated` = SELECT, INSERT, UPDATE. `service_role` = ALL.

**Classification:** KEEP-WITH-REDESIGN (moderate). Deltas: `owner_id` added (critical — currently missing), address split into structured fields, `country` NOT NULL with CHECK, `source` CHECK, RLS enabled (the security finding from verification report), composite FK target.

**Customer-initiated action note:** Per §14.11, customer actions (viewing a shared quote via token, signing) do NOT require `customers` to be in `chiefos_portal_users`. Those actions are captured as `chiefos_quote_events` rows with the `customers.id` reference but no `auth.uid()` dependency. Per §14.12, customer actions are not plan-gated.

**Cross-spine dependencies:**
- FK → `chiefos_tenants(id)`
- FKs INTO: `chiefos_quotes.customer_id → customers.id` (verified Query 2), `chiefos_quote_events.customer_id`, `job_documents.customer_id` (if `job_documents` were KEEP — it's DISCARDed), future `transactions.customer_id` (revenue attribution — Plan V2 post-rebuild)

---

---

## 4. Views

The rebuilt schema has a small number of focused views. Default posture: **`SECURITY INVOKER`** (view inherits caller's RLS). **`SECURITY DEFINER` is not used** in the rebuild's view set. Every view below is `SECURITY INVOKER`.

Views fall into two purposes: (a) portal compatibility — stable read surfaces for the portal that abstract over `public.transactions` with the appropriate `kind` filter, and (b) aggregation — pre-composed summaries for dashboards and exports.

### 4.1 Portal Compatibility Views

These views give the portal a stable read surface even as the underlying `transactions` table evolves.

---

#### View: `public.chiefos_portal_expenses`

**Role:** Portal-safe read of expense transactions. Filters `transactions` by `kind = 'expense' AND deleted_at IS NULL`.

**Definition (indicative):**

```sql
CREATE VIEW public.chiefos_portal_expenses
WITH (security_invoker = true) AS
SELECT
  t.id, t.tenant_id, t.owner_id, t.user_id,
  t.date, t.amount_cents, t.currency,
  t.subtotal_cents, t.tax_cents, t.tax_label,
  t.merchant, t.description, t.category, t.is_personal,
  t.job_id, t.job_no,
  t.source, t.source_msg_id, t.media_asset_id, t.parse_job_id,
  t.submission_status, t.submitted_by, t.reviewed_at, t.reviewer_note,
  t.created_at, t.updated_at
FROM public.transactions t
WHERE t.kind = 'expense' AND t.deleted_at IS NULL;
```

**Role tags:** `SECURITY INVOKER` — RLS on `transactions` gates visibility.

**GRANTs:** `authenticated` = SELECT; `service_role` = SELECT.

**Classification:** KEEP-WITH-REDESIGN (the current view is similar but needs column alignment with the rebuilt `transactions` shape per §3.2).

---

#### View: `public.chiefos_portal_revenue`

**Role:** Same pattern as `chiefos_portal_expenses` but for `kind = 'revenue'`. NEW in rebuild if it doesn't exist; KEEP-WITH-REDESIGN otherwise.

---

#### View: `public.chiefos_portal_time_entries`

**Role:** Portal-safe read over `time_entries_v2` (canonical) with `deleted_at IS NULL` filter. Joins `jobs` for `job_name` display convenience.

**SECURITY INVOKER.** `authenticated` = SELECT.

**Classification:** NEW in rebuild (current schema uses `jobs_view` for something related but not tight to the time spine).

---

### 4.2 Aggregation Views

These views power dashboard and export queries. All `SECURITY INVOKER`.

---

#### View: `public.chiefos_portal_job_summary`

**Role:** Per-job aggregate — total expenses, total revenue, total labour hours, contract value, gross profit, gross margin. Computed from `transactions` and `time_entries_v2`.

**SECURITY INVOKER.** Underlying RLS enforces tenant scoping.

**Classification:** NEW in rebuild. Current schema has `v_job_profit_simple`, `v_job_profit_simple_fixed`, `job_kpis_summary`, `job_kpis_daily/weekly/monthly` — a proliferation. The rebuild collapses to **one canonical job-summary view** plus an optional time-bucketed variant if needed.

---

#### View: `public.chiefos_portal_cashflow_daily`

**Role:** Daily cash in/out summary for dashboards. One row per (tenant, date).

**SECURITY INVOKER.**

**Classification:** KEEP-WITH-REDESIGN (current `v_cashflow_daily` is the predecessor; align columns with rebuilt `transactions`).

---

#### View: `public.chiefos_portal_open_shifts`

**Role:** Active shifts (clock-in without clock-out) for the timeclock portal surface.

**SECURITY INVOKER.**

**Classification:** KEEP-WITH-REDESIGN (current `open_shifts` is the predecessor).

---

### 4.3 DISCARDED Views

| View | Rationale |
|---|---|
| `_rls_audit` | Internal diagnostic view. Useful during development; not needed in the rebuilt schema. If drift detection returns to needing a DB-side view, reintroduce then. |
| `chiefos_all_events_v`, `chiefos_all_signatures_v` | Union views across event/signature tables for ease of query. Reconstructible post-rebuild if needed; no current reads grepped in app code. **DISCARD pending Phase 4 confirmation.** |
| `chiefos_expenses_receipts` | Legacy expense+receipt join. Superseded by `transactions` with `media_asset_id` FK. DISCARD. |
| `company_balance_kpis`, `company_kpis`, `company_kpis_monthly`, `company_kpis_weekly` | Four tenant-level KPI views. Rebuild collapses to one `chiefos_portal_tenant_kpis` view with a date-bucket parameter (or app-side bucketing). DISCARD the four; NEW the single replacement. |
| `job_kpis_summary`, `job_kpis_weekly`, `job_kpis_monthly` | Job-level KPI view proliferation. Collapsed into `chiefos_portal_job_summary` above. DISCARD. |
| `jobs_view` | Redundant with direct `jobs` reads through RLS. DISCARD. |
| `v_actor_identity_resolver`, `v_identity_resolver` | Resolver views relying on the DISCARDed actor taxonomy (Decision 12). DISCARD. |
| `v_finance_ledger`, `v_revenue` | Legacy finance views. `v_finance_ledger` replaced by direct `transactions` queries; `v_revenue` collapsed into `chiefos_portal_revenue`. DISCARD. |
| `v_job_profit_simple`, `v_job_profit_simple_fixed` | Two versions of the same view. Superseded by `chiefos_portal_job_summary`. DISCARD both. |
| `llm_cost_daily` | Aggregation over `llm_cost_log`. Rebuild does not require this view — aggregation is computed on demand if needed. DISCARD view; keep `llm_cost_log` table if app code writes to it (Phase 4 confirms). |
| `receivables_aging` | Aggregation over `receivables` table. The receivables table itself is out of scope for rebuild (a future feature). DISCARD the view. |

**Total view count in rebuild: 6 views** (4 portal compat + 2 aggregation in §4.1 and §4.2), down from 23 currently. Every remaining view has a clear role and SECURITY INVOKER.

---

---

## 5. Functions and Triggers

Target: **≤ 10 functions total, ≤ 10 triggers total** (per work order). Current schema has 39 user functions (20 SECURITY DEFINER) and 28 triggers (21 untracked). The rebuild discards the vast majority.

**SECURITY DEFINER target count: 0** in the rebuild. The privilege model is RLS + tight app-code checks, not DB-function-elevated privilege. If Phase 3 migration authorship reveals a specific case that genuinely requires SECURITY DEFINER, it comes back to this doc for explicit justification — not silently added.

### 5.1 Functions (Target ≤ 10)

#### KEEP functions (all SECURITY INVOKER):

**1. `chiefos_touch_updated_at() RETURNS trigger`** *(existing, keep)*

Standard `updated_at` timestamping for any table with that column. SECURITY INVOKER. Used as the function body for `BEFORE UPDATE` triggers on multiple tables.

**2. `chiefos_quotes_guard_header_immutable() RETURNS trigger`** *(Quotes spine, keep)*

Blocks identity-column edits on `chiefos_quotes`. KEEP-AS-IS per §3.5 preservation.

**3. `chiefos_quote_versions_guard_immutable() RETURNS trigger`** *(Quotes spine, keep)*

Full-row immutability after locking. KEEP-AS-IS.

**4. `chiefos_quote_line_items_guard_parent_lock() RETURNS trigger`** *(Quotes spine, keep)*

Blocks mutations when parent version is locked. KEEP-AS-IS.

**5. `chiefos_quote_share_tokens_guard_immutable() RETURNS trigger`** *(Quotes spine, keep)*

Blocks identity-column edits on share tokens. KEEP-AS-IS.

**6. `chiefos_quote_signatures_guard_immutable() RETURNS trigger`** *(Quotes spine, keep)*

Strict immutability on signatures. KEEP-AS-IS.

**7. `chiefos_quote_events_guard_immutable() RETURNS trigger`** *(Quotes spine, keep)*

Append-only guarantee on events. KEEP-AS-IS.

**8. `chiefos_activity_logs_guard_immutable() RETURNS trigger`** *(NEW in rebuild)*

Append-only enforcement on `chiefos_activity_logs`. Blocks UPDATE and DELETE. SECURITY INVOKER.

**9. `chiefos_transactions_integrity_chain() RETURNS trigger`** *(NEW — Decision 10)*

Computes and stamps the integrity-chain columns on every INSERT into `public.transactions`. Reads the most-recent committed row for the same tenant, computes `record_hash = SHA256(canonical_serialization || previous_hash)`, writes `record_hash` + `previous_hash` + `hash_version` + `hash_input_snapshot` atomically as part of the row insert. SECURITY INVOKER.

**Design sketch (body pseudocode):**

```
BEFORE INSERT ON public.transactions:
  Acquire a per-tenant advisory lock (pg_try_advisory_xact_lock keyed on tenant_id hash)
  Fetch previous_hash: SELECT record_hash FROM transactions WHERE tenant_id = NEW.tenant_id ORDER BY created_at DESC, id DESC LIMIT 1
  Build canonical input: jsonb_build_object('id', NEW.id, 'tenant_id', NEW.tenant_id, 'owner_id', NEW.owner_id, 'kind', NEW.kind, 'amount_cents', NEW.amount_cents, 'currency', NEW.currency, 'date', NEW.date, 'source', NEW.source, 'source_msg_id', NEW.source_msg_id, 'created_at', NEW.created_at, 'previous_hash', previous_hash)
  NEW.previous_hash := previous_hash
  NEW.hash_input_snapshot := canonical_input
  NEW.record_hash := encode(digest(canonical_input::text, 'sha256'), 'hex')
  NEW.hash_version := 1
  RETURN NEW
```

**Concurrency concern:** concurrent INSERTs within the same tenant would race on reading `previous_hash`. The advisory lock serializes per-tenant inserts during the hash computation. **Open implementation question for Phase 3:** verify advisory lock approach under realistic write load; alternative is a per-tenant sequence table with `FOR UPDATE` locking. Phase 3 migration authorship selects the approach empirically.

**10. `chiefos_next_tenant_counter(p_tenant_id uuid, p_counter_kind text) RETURNS integer`** *(existing; keep as SECURITY INVOKER)*

Atomic increment of `chiefos_tenant_counters.next_no` for a given `(tenant_id, counter_kind)`. UPSERT pattern. SECURITY INVOKER. Used by job/task/quote numbering handlers.

---

**Function count: 10.** Target met.

### 5.2 DISCARDED Functions (39 → 10)

**All 20 SECURITY DEFINER functions are DISCARDED:**

| Function | Disposition |
|---|---|
| `chiefos_bulk_assign_expense_job` | Logic moves to app code operating under the caller's RLS — no elevated privilege needed; validate inputs in app code |
| `chiefos_create_link_code` | App code INSERT into `chiefos_link_codes` (or `portal_phone_link_otp`) under RLS |
| `chiefos_delete_expenses` | App code UPDATE setting `deleted_at`; soft-delete batch written via `chiefos_deletion_batches` |
| `chiefos_delete_saved_view` | `chiefos_saved_views` is DISCARDed (Decision 3); function DISCARD follows |
| `chiefos_delete_signup_test_user_by_email` | Test-only utility; not production schema. DISCARD. |
| `chiefos_finish_signup` | Signup flow moves to app code using Supabase Auth + regular INSERTs (Decision 1) |
| `chiefos_is_owner_in_tenant` | Inline subquery in RLS policies or app code; no function needed |
| `chiefos_list_expense_audit` | App code reads `chiefos_activity_logs` directly under RLS |
| `chiefos_list_saved_views` | `chiefos_saved_views` DISCARDed (Decision 3) |
| `chiefos_list_vendors` | App code reads `vendor_aliases` directly under RLS |
| `chiefos_normalize_vendor` | Logic moves to `services/parser/` app code; function DISCARD |
| `chiefos_restore_expense`, `chiefos_restore_expenses_bulk`, `chiefos_undo_delete_expenses` | Undo logic is app code updating `deleted_at = NULL` and `chiefos_deletion_batches.undone_at` |
| **`chiefos_set_user_role`** | **DISCARD.** Role changes are direct `UPDATE chiefos_portal_users SET role = $new WHERE user_id = $target AND tenant_id IN (owner's tenants)` under RLS. Owner-only authorization enforced via RLS policy (UPDATE allowed only if actor is `role = 'owner'` in the target's tenant). `chiefos_role_audit` INSERT emitted from app code alongside the update. See §3.11 `chiefos_role_audit` design page. |
| `chiefos_update_expense` | App code UPDATE on `transactions` under RLS |
| `chiefos_upsert_saved_view` | `chiefos_saved_views` DISCARDed (Decision 3) |
| `ensure_job_no` | Replaced by `chiefos_next_tenant_counter()` (function 10 above) |
| `stamp_owner_id`, `stamp_time_entry_user` | These are trigger functions stamping identity columns on INSERT. Moved to app code: the WhatsApp/portal handler fills identity columns explicitly before INSERT. Triggers that auto-populate identity are an anti-pattern (they hide the write's true provenance). DISCARD. |

**Other INVOKER functions DISCARDED:**

| Function | Disposition |
|---|---|
| `_enqueue_kpi_touch_from_row`, `auto_link_transaction_supplier` | KPI/supplier-link triggers. Denormalization side effects. DISCARD; app code handles if needed. |
| `chiefos_phone_digits`, `chiefos_try_uuid` | Small coercion helpers. Move to app code utilities. DISCARD. |
| `enforce_employee_cap` | Plan-tier enforcement in trigger. Move to app code check before INSERT. DISCARD trigger + function. |
| `ensure_task_no`, `ensure_task_no_per_user` | Task numbering. Replaced by `chiefos_next_tenant_counter()` with `counter_kind = 'task'`. DISCARD. |
| `normalize_beta_signup_email` | Trigger-side normalization. Move to app code. DISCARD. |
| `next_job_no`, `next_task_no`, `next_task_no_for_user` | Counter helpers. Superseded by `chiefos_next_tenant_counter()`. DISCARD. |
| `set_updated_at_timestamp`, `tg_set_updated_at`, `touch_updated_at`, `touch_states_updated_at` | Multiple variants of the same updated_at trigger function. Consolidated into **`chiefos_touch_updated_at`** (function 1 above). DISCARD the duplicates. |
| `sync_error_logs_cols`, `sync_locks_cols`, `sync_states_cols` | Column-sync triggers papering over naming inconsistencies. With the rebuilt schema having consistent column names, these are unnecessary. DISCARD. |
| `sync_transactions_expense_to_portal` | Syncs `transactions.kind='expense'` to a legacy portal table. Legacy portal table is DISCARDed; `chiefos_portal_expenses` view replaces the sync pattern. DISCARD. |

**114 C-language vector/halfvec/sparsevec functions + 4 internal + extension-owned functions:** Not ChiefOS-owned. Supabase extension (pgvector). These are not in the rebuild's function count because they're provided by the extension installation, not by migrations. Unchanged.

### 5.3 Triggers (Target ≤ 10)

#### KEEP triggers:

**1–6. Quotes spine immutability triggers** (one per table: `chiefos_quotes`, `chiefos_quote_versions`, `chiefos_quote_line_items`, `chiefos_quote_share_tokens`, `chiefos_quote_signatures`, `chiefos_quote_events`) — bound to their respective guard functions (§5.1 functions 2–7). KEEP-AS-IS.

**7. `chiefos_activity_logs_guard_immutable_trigger`** — BEFORE UPDATE OR DELETE on `chiefos_activity_logs`. Binds to function 8 (§5.1). NEW in rebuild.

**8. `chiefos_transactions_integrity_chain_trigger`** — BEFORE INSERT on `public.transactions`. Binds to function 9 (§5.1). NEW in rebuild per Decision 10.

**9. `chiefos_time_entries_v2_integrity_chain_trigger`** — BEFORE INSERT on `public.time_entries_v2`. Binds to an analogous integrity-chain function (same pattern as transactions; not re-enumerated to stay within function count cap — the trigger can either share the function with a table-parameter argument, or the function gets a generic variant. Phase 3 chooses).

**10. `chiefos_touch_updated_at_trigger`** — BEFORE UPDATE on any table with `updated_at`. Binds to function 1 (§5.1). Applied to: `users`, `chiefos_tenants`, `chiefos_portal_users`, `jobs`, `transactions`, `time_entries_v2`, `vendor_aliases`, `conversation_sessions`, `chiefos_deletion_batches`, and others as needed. **One function, many bindings — not counted as separate triggers in the target.**

**Trigger count: 10 distinct trigger definitions in the rebuild** (with `chiefos_touch_updated_at` applied as a reusable binding across ~10 tables, not counted as separate triggers).

Target met.

### 5.4 DISCARDED Triggers

All 21 untracked triggers in Session 2.5 catalog are DISCARDed. Specifically:

| Trigger | Rationale |
|---|---|
| `trg_bills_kpi_touch`, `trg_expenses_kpi_touch` | KPI invalidation triggers. Denormalization side effect. DISCARD. |
| `trg_beta_signups_normalize_email` | Email normalization in trigger. App code handles. DISCARD. |
| `t_touch_identity_map`, `trg_chiefos_identity_map_touch` | `chiefos_identity_map` is DISCARDed (§3.1). Trigger follows. DISCARD. |
| `trg_chiefos_legal_acceptances_updated_at` | Replaced by unified `chiefos_touch_updated_at_trigger`. DISCARD as a duplicate. |
| `trg_chiefos_pending_signups_updated_at` | `chiefos_pending_signups` is DISCARDed (Decision 1). DISCARD. |
| `trg_chiefos_user_identities_touch` | `chiefos_user_identities` is DISCARDed. DISCARD. |
| `trg_enforce_employee_cap` | Plan-cap enforcement. Move to app code. DISCARD. |
| `trg_error_logs_sync`, `trg_locks_sync`, `trg_states_sync`, `trg_states_touch`, `trg_locks_touch` | Column-sync triggers. Eliminated by consistent column naming in rebuild. DISCARD. |
| `a_jobs_stamp_owner`, `b_jobs_ensure_no` | Trigger-based identity stamping and counter allocation. Move to app code (explicit provenance). DISCARD. |
| `trg_jobs_job_no`, `trg_tasks_task_no` | Counter-allocation triggers. Replaced by explicit `chiefos_next_tenant_counter()` call in app code. DISCARD. |
| `time_entries_stamp_owner`, `time_entries_stamp_user` | Trigger-based identity stamping. App code handles explicitly. DISCARD. |
| `trg_sync_transactions_expense_to_portal` | Legacy portal sync. Replaced by `chiefos_portal_expenses` view. DISCARD. |
| `set_updated_at_user_auth_links` | `user_auth_links` is DISCARDed (§3.1). DISCARD. |

---

---

## 6. Cross-Reference to Current Database

Every object in `SESSION_2_5_SCHEMA_DRIFT_CATALOG.md` appears below with a classification and rationale. No object is silently omitted.

**Classification legend:**
- **KEEP-AS-IS** — live shape matches design; no changes
- **KEEP-WITH-REDESIGN** — table/view/function continues in rebuild with specified changes
- **REDESIGN** — same role, substantial changes (columns added/removed/renamed, RLS added)
- **NEW** — table does not exist in current schema; added by rebuild
- **DISCARD** — not carried forward into rebuild
- **REVIEW** — classification tentative, requires Phase 2/4 audit confirmation

### 6.1 Tables (116 public.*)

| Object | Group | Classification | Rationale |
|---|---|---|---|
| `addon_purchases_yearly` | 3.8 Quota | KEEP-AS-IS | Session 2 migration; §3.8 |
| `assistant_events` | 3.10 Conv | DISCARD | Ad-hoc predecessor to `conversation_messages` (§3.10) |
| `bills` | — | DISCARD | Bill-tracking feature out of rebuild scope (Decision 5); transactions.kind='bill' is the future path |
| `budgets` | — | DISCARD | Budget feature out of rebuild scope; reintroduce with explicit design when shipping |
| `capability_denials` | — | DISCARD | Plan-gate denial log; unused in current app per grep; Monetization §5 audit goes to `chiefos_activity_logs` |
| `catalog_ingestion_log` | — | DISCARD | Supplier catalog out of scope (Decision 6) |
| `catalog_price_history` | — | DISCARD | Same |
| `catalog_products` | — | DISCARD | Same |
| `category_rules` | — | DISCARD | Expense categorization rules; feature not documented; app code grep pending Phase 4 — **REVIEW** |
| `change_orders` | — | DISCARD | Part of quotes spine future handler scope; not a separate table — change orders flow through `chiefos_quote_versions` as new versions |
| `chief_actor_memory` | 3.10 Conv | DISCARD | Actor taxonomy cluster (Decision 12); folded into `conversation_sessions.active_entities` |
| `chiefos_activity_log_events` | 3.11 Audit | DISCARD | Flattened into `chiefos_activity_logs` (§3.11) |
| `chiefos_activity_logs` | 3.11 Audit | REDESIGN | Actor FK removed per Decision 12; columns aligned to new design (§3.11) |
| `chiefos_actor_identities` | — | DISCARD | Actor cluster (Decision 12) |
| `chiefos_actors` | — | DISCARD | Actor cluster (Decision 12) |
| `chiefos_beta_signups` | 3.1 Identity | KEEP-WITH-REDESIGN | CHECKs tightened, GRANTs added (§3.1) |
| `chiefos_board_assignments` | — | DISCARD | Collapsed into `chiefos_portal_users.role = 'board_member'` (Decision 9) |
| `chiefos_crew_rates` | — | KEEP-WITH-REDESIGN | Pay-rate table; retain, add composite FK discipline + GRANTs |
| `chiefos_deletion_batches` | 3.11 Audit | KEEP-WITH-REDESIGN | Consolidates with `chiefos_txn_delete_batches` (§3.11) |
| `chiefos_expense_audit` | — | DISCARD | Legacy expense audit; superseded by `chiefos_activity_logs` |
| `chiefos_expenses` | — | DISCARD | Legacy expense table; superseded by canonical `transactions` (§3.2) |
| `chiefos_identity_map` | — | DISCARD | Parallel identity sprawl; dual-boundary model in `users` + `chiefos_portal_users` is the canonical surface (§3.1) |
| `chiefos_ingestion_identities` | — | REVIEW | May retain for multi-provider future; default stance DISCARD if Phase 4 confirms no multi-provider use today |
| `chiefos_legal_acceptances` | 3.1 Identity | KEEP-AS-IS | §3.1, GRANT backfill only |
| `chiefos_link_codes` | 3.1 Identity | DISCARD | Overlaps with `portal_phone_link_otp`; choose one canonical (decision: keep `portal_phone_link_otp`, discard `chiefos_link_codes`) |
| `chiefos_pending_signups` | — | DISCARD | Decision 1; Supabase Auth + `users.signup_status` handles |
| `chiefos_phone_active_tenant` | — | DISCARD | Stale-cache risk; compute live via `users.owner_id → chiefos_tenants` |
| `chiefos_portal_users` | 3.1 Identity | KEEP-AS-IS | §3.1, GRANT backfill only |
| `chiefos_quote_events` | 3.5 Quotes | KEEP-AS-IS | §3.5 |
| `chiefos_quote_line_items` | 3.5 Quotes | KEEP-AS-IS | §3.5 |
| `chiefos_quote_share_tokens` | 3.5 Quotes | KEEP-AS-IS | §3.5 |
| `chiefos_quote_signatures` | 3.5 Quotes | KEEP-AS-IS | §3.5 |
| `chiefos_quote_versions` | 3.5 Quotes | KEEP-AS-IS | §3.5 |
| `chiefos_quotes` | 3.5 Quotes | KEEP-AS-IS | §3.5 |
| `chiefos_role_audit` | 3.11 Audit | KEEP-WITH-REDESIGN | Actor FK redesigned per Decision 12 (§3.11) |
| `chiefos_saved_views` | — | DISCARD | Decision 3 |
| `chiefos_tenant_actor_profiles` | — | DISCARD | Actor cluster (Decision 12) |
| `chiefos_tenant_actors` | — | DISCARD | Actor cluster (Decision 12) |
| `chiefos_tenant_counters` | 3.3 Jobs / shared | KEEP-AS-IS | §3.3, RLS enabled + GRANTs added |
| `chiefos_tenants` | 3.1 Identity | KEEP-WITH-REDESIGN | Add UNIQUE on owner_id, tighten CHECKs (§3.1) |
| `chiefos_txn_delete_batches` | — | DISCARD | Consolidated into `chiefos_deletion_batches` (§3.11) |
| `chiefos_user_identities` | — | DISCARD | Identity sprawl; dual-boundary model covers (§3.1) |
| `chiefos_vendor_aliases` | — | DISCARD | Legacy vendor alias table; superseded by new `vendor_aliases` (§3.7 — Session 2) |
| `cil_drafts` | 3.9 Pending | KEEP-WITH-REDESIGN | Add tenant_id + RLS + GRANTs + composite UNIQUE (§3.9) |
| `convo_state` | 3.10 Conv | DISCARD | Predecessor to `conversation_sessions` (§3.10) |
| `customers` | — | KEEP-WITH-REDESIGN | Portal-facing; add RLS (currently missing per verification report) + GRANTs; composite FK target for quotes spine |
| `doc_chunks` | — | DISCARD | RAG knowledge-base chunks; `owner_id = 'GLOBAL'` pattern indicates system-wide reference data; **REVIEW** for rebuild scope — default DISCARD pending app code audit |
| `docs` | — | DISCARD | Same rationale as `doc_chunks`; parent table |
| `email_ingest_events` | 3.11 Audit | KEEP-WITH-REDESIGN | §3.11; GRANTs + composite FK target |
| `employee_invites` | — | KEEP-WITH-REDESIGN | Add composite FKs; GRANTs |
| `employees` | 3.4 Time | KEEP-WITH-REDESIGN | Add tenant_id + role CHECK (§3.4) |
| `employer_policies` | 3.4 Time | KEEP-WITH-REDESIGN | Fix owner_id type (uuid → text), add tenant_id (§3.4) |
| `entity_summary` | 3.10 Conv | DISCARD | Fold into `conversation_sessions.active_entities` (§3.10) |
| `error_logs` | — | KEEP-WITH-REDESIGN | Backend error log; add tenant_id (optional) + RLS + GRANTs; append-only trigger |
| `expenses` | — | DISCARD | Legacy table superseded by `transactions` (§3.2) |
| `fact_events` | — | DISCARD | Unused event log; app code grep pending — **REVIEW** |
| `file_exports` | 3.2 Financial | KEEP-WITH-REDESIGN | Add tenant_id, kind CHECK, expires_at; evaluate bytea vs storage (§3.2) |
| `import_batches` | — | KEEP-WITH-REDESIGN | Bulk import tracking; add composite FKs + GRANTs |
| `insight_log` | — | DISCARD | Chief-insight emission log; app-code path unclear; **REVIEW** pending Phase 4 |
| `intake_batches` | 3.6 Intake | KEEP-WITH-REDESIGN | §3.6 |
| `intake_item_drafts` | 3.6 Intake | KEEP-WITH-REDESIGN | §3.6 — receipt kinds removed |
| `intake_item_reviews` | 3.6 Intake | KEEP-WITH-REDESIGN | §3.6 — actor FK redesigned |
| `intake_items` | 3.6 Intake | KEEP-WITH-REDESIGN | §3.6 — receipt kinds removed |
| `intake_processing_jobs` | — | DISCARD | Processing work queue; can be app-side queue (Upstash) or a simpler `status` column on `intake_items`. DISCARD pending Phase 4. |
| `integrity_verification_log` | 3.11 Audit | KEEP-WITH-REDESIGN | Enable RLS + GRANTs (§3.11) |
| `job_counters` | — | DISCARD | Superseded by `chiefos_tenant_counters` (counter_kind='job') (§3.3) |
| `job_document_files` | — | DISCARD | Decision 8: no parallel documents table; documents flow through quotes spine + `media_assets` |
| `job_documents` | — | DISCARD | Decision 8 |
| `job_kpis_daily` | — | DISCARD | Denormalized KPI aggregate; replaced by `chiefos_portal_job_summary` view (§4.2) |
| `job_phases` | 3.3 Jobs | KEEP-WITH-REDESIGN | §3.3; add composite FK, policy completeness |
| `job_photo_shares` | 3.3 Jobs | KEEP-WITH-REDESIGN | §3.3; GRANTs |
| `job_photos` | 3.3 Jobs | KEEP-WITH-REDESIGN | §3.3; stays specialized (Decision 4) |
| `jobs` | 3.3 Jobs | KEEP-WITH-REDESIGN | §3.3; add tenant_id (critical) |
| `knowledge_cards` | — | DISCARD | Related to `docs`/`doc_chunks`; same disposition |
| `kpi_touches` | — | DISCARD | KPI invalidation queue; denormalization removed in rebuild |
| `llm_cost_log` | — | KEEP-WITH-REDESIGN | Cost tracking; add tenant_id + RLS + GRANTs; append-only |
| `locks` | 3.4 Time | KEEP-WITH-REDESIGN | §3.4; drop duplicate `lock_key` column |
| `media_assets` | 3.1 Identity / 3.2 Financial | KEEP-WITH-REDESIGN | OCR columns DISCARDed (Decision 13); file-metadata columns preserved; parent_kind/parent_id polymorphic refs (Decision 4) |
| `mileage_logs` | — | KEEP-WITH-REDESIGN | Mileage tracking; composite FKs + GRANTs |
| `overhead_items` | — | KEEP-WITH-REDESIGN | Overhead expense tracking; composite FKs |
| `overhead_payments` | — | KEEP-WITH-REDESIGN | Same |
| `overhead_reminders` | — | KEEP-WITH-REDESIGN | Same |
| `owner_nudges` | — | DISCARD | Owner prompt/notification log; app code handles; **REVIEW** |
| `parse_corrections` | 3.7 Receipt | KEEP-AS-IS | Session 2 migration; §3.7 |
| `parse_jobs` | 3.7 Receipt | KEEP-AS-IS | Session 2 migration; §3.7 |
| `pending_actions` | 3.9 Pending | KEEP-WITH-REDESIGN | Add tenant_id, standard RLS (§3.9) |
| `portal_phone_link_otp` | 3.1 Identity | KEEP-WITH-REDESIGN | Add policies, UNIQUE, GRANTs (§3.1) |
| `pricing_items` | — | DISCARD | Supplier catalog pricing (Decision 6 scope) |
| `quota_allotments` | 3.8 Quota | KEEP-AS-IS | Session 2 migration; §3.8 |
| `quota_consumption_log` | 3.8 Quota | KEEP-AS-IS | Session 2 migration; §3.8 |
| `rag_terms` | — | DISCARD | RAG terms dictionary; same disposition as `docs`/`doc_chunks` |
| `reminders` | — | DISCARD | Reminders feature; retire or move to app-side scheduling; **REVIEW** |
| `revenue` | — | DISCARD | Legacy revenue table superseded by `transactions` (§3.2) |
| `settings` | — | KEEP-WITH-REDESIGN | Per-owner settings; add tenant_id + RLS + GRANTs |
| `states` | 3.4 Time | KEEP-WITH-REDESIGN | §3.4; add owner_id + tenant_id |
| `stripe_events` | — | KEEP-WITH-REDESIGN | Stripe webhook idempotency table; add tenant_id where resolvable; append-only |
| `supplier_categories` | — | DISCARD | Supplier catalog (Decision 6) |
| `supplier_users` | — | DISCARD | Supplier catalog (Decision 6) |
| `suppliers` | — | DISCARD | Supplier catalog (Decision 6) |
| `task_counters` | — | DISCARD | Superseded by `chiefos_tenant_counters` (counter_kind='task') (§3.4) |
| `task_counters_user` | — | DISCARD | Same pattern; optionally kept as counter_kind='task_user' if per-user task numbering is required; default DISCARD |
| `tasks` | — | KEEP-WITH-REDESIGN | Core MVP feature (Execution Playbook §2 item 7); add tenant_id, status CHECK, composite FKs, GRANTs — full design page in Phase 3 (not covered in this Session since it's outside the five groups) — flagged for Phase 1 addendum if the founder wants it formalized before Phase 3 |
| `team_member_assignments` | — | DISCARD | **Reclassified in Session 3 addendum.** Current 5-col shape (`owner_id`, `team_member_user_id`, `employee_name`, `id`, `created_at`) duplicates the `(users.owner_id, users.user_id, users.name)` + `employees` join already available through the retained identity spine. No semantic not already captured. No app code grep match to a unique use case. **DISCARD.** |
| `tenant_knowledge` | — | DISCARD | Parallel to docs/rag_terms; same disposition |
| `tenant_supplier_preferences` | — | DISCARD | Supplier catalog (Decision 6) |
| `time_entries` | — | DISCARD | Legacy v1; superseded by `time_entries_v2` (§3.4) |
| `time_entries_v2` | 3.4 Time | KEEP-WITH-REDESIGN | §3.4 |
| `timeclock_prompts` | 3.4 Time | KEEP-AS-IS | §3.4; GRANT backfill only |
| `timeclock_repair_prompts` | 3.4 Time | KEEP-WITH-REDESIGN | §3.4; enable RLS, add FKs |
| `timesheet_locks` | 3.4 Time | KEEP-WITH-REDESIGN | §3.4; add tenant_id |
| `timesheet_rollups` | 3.4 Time | DISCARD | Decision 7: compute-on-read via `chiefos_portal_job_summary` view |
| `transactions` | 3.2 Financial | KEEP-WITH-REDESIGN | §3.2; canonical ledger; integrity chain columns retained per Decision 10 |
| `uploads` | — | DISCARD | **Reclassified in Session 3 addendum.** Current 5-col shape (`id`, `user_id`, `file_path`, `mime_type`, `created_at`) is a minimal predecessor to `media_assets`, which already carries `storage_provider`/`storage_path`/`content_type`/`size_bytes` plus tenant_id/owner_id and full RLS. No column on `uploads` carries semantics not already in `media_assets`. Substantial overlap per the Session 3 addendum investigation guidance. **DISCARD.** |
| `upsell_prompts_log` | 3.8 Quota | KEEP-AS-IS | Session 2 migration; §3.8 |
| `usage_monthly` | — | DISCARD | Superseded by `quota_consumption_log` (§3.8) |
| `usage_monthly_v2` | — | DISCARD | Same |
| `user_active_job` | — | DISCARD | Auto-assign active-job state — fold into `users.auto_assign_active_job_id` per RECEIPT_PARSER_UPGRADE_HANDOFF §7 |
| `user_auth_links` | — | DISCARD | `chiefos_portal_users` is the canonical auth→tenant link (§3.1) |
| `user_memory` | — | DISCARD | Parallel memory store; fold into `conversation_sessions`/`conversation_messages` (§3.10) |
| `users` | 3.1 Identity | KEEP-WITH-REDESIGN | §3.1; 54→21 cols, add signup_status per Decision 1 |
| `users_legacy_archive` | — | DISCARD | Decision 2 |
| `vendor_aliases` | 3.7 Receipt | KEEP-AS-IS | Session 2 migration; §3.7 |

### 6.2 Views (23 current)

| Object | Classification | Rationale |
|---|---|---|
| `_rls_audit` | DISCARD | §4.3 |
| `chiefos_all_events_v` | DISCARD | §4.3 |
| `chiefos_all_signatures_v` | DISCARD | §4.3 |
| `chiefos_expenses_receipts` | DISCARD | §4.3 |
| `chiefos_portal_expenses` | KEEP-WITH-REDESIGN | §4.1 |
| `company_balance_kpis` | DISCARD | §4.3 |
| `company_kpis` | DISCARD | §4.3 |
| `company_kpis_monthly` | DISCARD | §4.3 |
| `company_kpis_weekly` | DISCARD | §4.3 |
| `job_kpis_monthly` | DISCARD | §4.3 |
| `job_kpis_summary` | DISCARD | §4.3 |
| `job_kpis_weekly` | DISCARD | §4.3 |
| `jobs_view` | DISCARD | §4.3 |
| `llm_cost_daily` | DISCARD | §4.3 |
| `open_shifts` | KEEP-WITH-REDESIGN | §4.2 (becomes `chiefos_portal_open_shifts`) |
| `receivables_aging` | DISCARD | §4.3 |
| `v_actor_identity_resolver` | DISCARD | §4.3 |
| `v_cashflow_daily` | KEEP-WITH-REDESIGN | §4.2 (becomes `chiefos_portal_cashflow_daily`) |
| `v_finance_ledger` | DISCARD | §4.3 |
| `v_identity_resolver` | DISCARD | §4.3 |
| `v_job_profit_simple` | DISCARD | §4.3 |
| `v_job_profit_simple_fixed` | DISCARD | §4.3 |
| `v_revenue` | DISCARD | §4.3 |

**NEW views:** `chiefos_portal_revenue`, `chiefos_portal_time_entries`, `chiefos_portal_job_summary`, `chiefos_portal_tenant_kpis` (the collapsed replacement for the four company-KPI views).

### 6.3 Functions

All 20 SECURITY DEFINER functions: **DISCARD** per §5.2. Specific rationales per function listed in §5.2.

All 19 SECURITY INVOKER user-owned functions: **DISCARD** except the 10 KEEP functions listed in §5.1. Rationales per function listed in §5.2.

All extension-provided functions (114 C + 4 internal + supabase_admin-owned): **UNCHANGED** — not part of the rebuild's function count.

### 6.4 Triggers

All 21 untracked triggers: **DISCARD** per §5.4. Specific rationales per trigger listed in §5.4.

Six Quotes-spine triggers (tracked): **KEEP-AS-IS** per §5.3.

One `chiefos_touch_updated_at_trigger` unified binding replaces multiple `*_updated_at` triggers: **NEW application**, binding to existing `chiefos_touch_updated_at` function (§5.1 function 1).

Two integrity-chain triggers (`chiefos_transactions_integrity_chain_trigger`, `chiefos_time_entries_v2_integrity_chain_trigger`): **NEW** per Decision 10.

One append-only trigger (`chiefos_activity_logs_guard_immutable_trigger`): **NEW** per §3.11.

### 6.5 Sequences (30 current)

Sequences underlying `bigserial` / `SERIAL` columns on retained tables are carried forward automatically (implicit in `CREATE TABLE` with identity columns). Sequences for DISCARDed tables are implicitly dropped when the tables are DISCARDed. **No per-sequence design page required.** Phase 3 migration authorship handles sequence naming for any table where the default doesn't fit.

### 6.6 Custom types / enums

Session 2.5 catalog reported 145 "types" but all 145 were auto-generated composite row-types for tables and views (one per table/view). **Zero user-defined enums or domains exist in the current schema.** None are added by the rebuild — `CHECK (col IN (...))` constraints serve the enum role (Phase 3 migration authorship may revisit this trade-off if explicit enum types simplify specific migrations).

---

---

## Items for Founder Re-Review

None of the 13 closed decisions has a conflict that requires re-opening. A small number of classification decisions are tentative pending Phase 4 app-code audit evidence; these are flagged in §6.1 as **REVIEW** but have a default disposition:

1. **`category_rules`** (DISCARD default) — if app code uses for expense categorization, KEEP-WITH-REDESIGN
2. **`chiefos_ingestion_identities`** (DISCARD default) — if multi-provider ingestion exists, KEEP
3. **`doc_chunks` / `docs` / `knowledge_cards` / `rag_terms` / `tenant_knowledge`** (DISCARD default) — RAG knowledge base; if app reads during Ask Chief, KEEP-WITH-REDESIGN as a retained group in a future addendum
4. **`fact_events`** (DISCARD default) — if written during canonical actions, KEEP
5. **`insight_log`** (DISCARD default) — if Chief writes insights, KEEP
6. **`intake_processing_jobs`** (DISCARD default) — if used as work queue, KEEP or migrate to app-side queue
7. **`owner_nudges`** (DISCARD default) — if app writes nudges, KEEP
8. **`reminders`** (DISCARD default) — if reminders feature ships, KEEP
9. **`tasks`** — KEEP-WITH-REDESIGN with no full design page this session. Execution Playbook §2 MVP item 7 says tasks exist; full §3.12 design page can be added as a Phase 1 addendum before Phase 3 migration authorship, or Phase 3 handles with a brief design note inline.

**Recommendation for the founder review:** Sections 1–5 and the 116-table Section 6.1 classification are ready for Checkpoint 1 approval. Items 1–8 above are low-stakes and can be resolved in Phase 4 with app-code grep; they don't block Phase 2. Item 9 (tasks) deserves a brief addendum if the founder wants task-table design locked before Phase 3 authors migrations; otherwise Phase 3 designs the table inline in the migration file.

---

## Integrity Chain — Phase 3 Implementation Notes (Decision 10)

The per-tenant integrity hash chain on `public.transactions` (and `time_entries_v2`) is specified in Principle and in the trigger function design (§5.1 function 9). Phase 3 migration authorship faces one open implementation question:

**Concurrency approach:** When two inserts to the same tenant's `transactions` race, both compute `previous_hash` from the same state and write conflicting `record_hash` values. Options:

1. **Per-tenant advisory lock** (`pg_try_advisory_xact_lock(hashtext(tenant_id::text)::bigint)`) — cheapest, standard pattern, serializes per-tenant writes. Recommended default.
2. **Sequence-like chain table** — separate `transactions_chain_head` table with `FOR UPDATE` lock on the tenant's row; more explicit, more code.
3. **Serializable isolation** — transaction-level guarantee without locks; higher abort rate under contention.

**Default recommendation (documented here for Phase 3):** advisory lock per tenant, falling back to a SAVEPOINT retry loop on lock-acquisition-failure. Measure under realistic load; escalate if contention proves problematic.

**Chain verification:** `integrity_verification_log` records periodic verification runs (cron job, post-rebuild). Verification walks the chain for each tenant: for every row, recompute `record_hash` from `canonical_serialization || previous_hash` and compare to stored value. A mismatch means tampering (or a chain-break bug). Failure details logged with specific row IDs; app code can surface an operator alert.

**Schema support required in `transactions`:** `record_hash text`, `previous_hash text`, `hash_version integer NOT NULL DEFAULT 1`, `hash_input_snapshot jsonb`. All present in the rebuild design per §3.2.

---

---

## Summary for Checkpoint 1 Review

- **Principles:** 11, grounded in authoritative docs. Plus 6 Cross-Cutting Patterns imported from Quotes spine Phase 3 §27.
- **Table groups:** 11. Every table lives in exactly one group (or is DISCARDed).
- **Tables KEEP-AS-IS:** 17 (the 7 Session 2 receipt+quota tables, 6 Quotes spine tables, plus `chiefos_legal_acceptances`, `chiefos_portal_users`, `timeclock_prompts`, `chiefos_tenant_counters`).
- **Tables KEEP-WITH-REDESIGN:** 41 (Sections 3.1–3.11: 28; Section 3.12 addendum: 13).
- **Tables REDESIGN (substantial):** 1 (`chiefos_activity_logs`, actor FK removal per Decision 12).
- **Tables NEW:** 2 (`conversation_sessions`, `conversation_messages`).
- **Tables DISCARD:** ~62 (including all actor-cluster tables, legacy `expenses`/`revenue`/`time_entries` v1, parallel identity tables, KPI denormalizations, feature-out-of-scope tables, plus Session 3 addendum's 2 reclassifications: `uploads`, `team_member_assignments`).
- **Section 3.12 added:** 13 supporting-tables design pages closing the design-page gap from Session 2. Every KEEP-WITH-REDESIGN table in §6.1 now has a dedicated design page.
- **Views:** 6 in rebuild (down from 23). All `SECURITY INVOKER`.
- **Functions:** 10 in rebuild (down from 39 user functions). **Zero `SECURITY DEFINER` functions.** The `chiefos_set_user_role` DISCARD is the single most consequential change — privilege management moves from an elevated function to RLS-gated UPDATE with app-code audit emission.
- **Triggers:** 10 in rebuild (down from 28). Integrity chain (2), append-only audit (1), Quotes spine immutability (6), unified `updated_at` (1 binding applied many places).
- **GRANTs:** Every table has explicit `authenticated` and `service_role` grants specified in its migration. Session 3 diagnostic's 26-table GRANT gap does not recur.
- **RLS:** Every tenant-scoped table has the standard three policies (SELECT/INSERT/UPDATE) plus membership predicate. The 14 tenant-scoped-but-no-RLS tables from the verification report are all either REDESIGNed with RLS or DISCARDed.
- **Integrity chain (Decision 10):** Per-tenant hash chain on `transactions` and `time_entries_v2`; tamper-evidence as first-class schema property; verification run surface in `integrity_verification_log`.
- **Composite-key FK tenant integrity (Principle 11):** generalized from the Quotes spine precedent across all cross-spine FKs between tenant-scoped tables.

The rebuilt schema is narrower, cleaner, and more auditable than the current one. It expresses the authoritative docs' architecture at the storage layer faithfully. Every DISCARD has a rationale. Every KEEP has a path to migration.

---

**Phase 1 Session 2 complete. FOUNDATION_P1_SCHEMA_DESIGN.md is ready for Founder Checkpoint 1 review before Phase 2 begins.**

**Phase 1 Session 3 addendum complete. FOUNDATION_P1_SCHEMA_DESIGN.md has complete design coverage for every KEEP-WITH-REDESIGN table. Ready for Founder Checkpoint 1 final approval before Phase 2 begins.**
