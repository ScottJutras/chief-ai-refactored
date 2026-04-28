# Session 3 Addendum Report — Design-Page Gap Closure

**Date:** 2026-04-21
**Session:** Phase 1 Session 3 (addendum)
**Output:** Section 3.12 added to `FOUNDATION_P1_SCHEMA_DESIGN.md` with 13 new design pages. Two §6.1 reclassifications from KEEP-WITH-REDESIGN to DISCARD.

---

## Gap Scan Output

- **Tables classified KEEP-WITH-REDESIGN in §6.1 (pre-session):** 43
- **Of those, with dedicated §3.1–§3.11 design pages:** 28
- **Of those, WITHOUT dedicated §3 design pages:** 15
- **List of gap tables investigated in this session:**
  1. `tasks` (highest priority, MVP scope per Execution Playbook §2 item 7)
  2. `team_member_assignments`
  3. `mileage_logs`
  4. `overhead_items`
  5. `overhead_payments`
  6. `overhead_reminders`
  7. `stripe_events`
  8. `llm_cost_log`
  9. `error_logs`
  10. `settings`
  11. `uploads`
  12. `import_batches`
  13. `employee_invites`
  14. `chiefos_crew_rates`
  15. `customers` (added during scan — was KEEP-WITH-REDESIGN in §6.1 but absent from the expected list; §3.1 design page covered only `chiefos_beta_signups`/`chiefos_legal_acceptances`/etc., not customers)

## List of Tables Designed in This Session

**Full design pages produced (13):**

1. `public.tasks` — MVP-scope, full-attention design: uuid id, tenant_id + owner_id dual-boundary, per-tenant `task_no` via generalized counter, portal+ingestion dual-assignee pattern, status/kind CHECKs, soft-delete, correlation_id
2. `public.mileage_logs` — dual-boundary fix (current `owner_id uuid` → `text`), parallel `transaction_id` link for canonical financial ledger mirror
3. `public.overhead_items` — currency column added, CHECKs tightened, `owner_id NOT NULL`, composite FK target
4. `public.overhead_payments` — `owner_id` added (critical gap in current), parallel `transaction_id` link, composite FK to items
5. `public.overhead_reminders` — `owner_id` added, status enum, composite FK to items
6. `public.stripe_events` — substantial rebuild (current has only 3 cols); adds payload, signature, tenant_id, status lifecycle, error_message, correlation_id
7. `public.llm_cost_log` — `cost_usd numeric` → `cost_cents bigint`, `query_kind` → `feature_kind` (matches quota enum), RLS enabled, append-only
8. `public.error_logs` — structured `error_stack jsonb`, `trace_id NOT NULL` per Constitution §9, append-only, RLS policy scoped
9. `public.settings` — `tenant_id` added, `value` → jsonb, `scope` column (`'owner'|'tenant'`) supports tenant-wide settings without parallel table
10. `public.import_batches` — substantial rebuild; adds `initiated_by_portal_user_id`, `media_asset_id`, success/error counts, status lifecycle, composite FK target
11. `public.employee_invites` — structured invited_by/revoked_by attribution, composite FK discipline, interaction-note with `portal_phone_link_otp`
12. `public.chiefos_crew_rates` — `portal_user_id` FK added (current uses weak `employee_name` only), role-restricted RLS (rates confidential from employee), append-only history model
13. `public.customers` — RLS enabled (closes the verification-report security gap), `owner_id` added (critical dual-boundary gap), structured address fields, composite FK target for quotes spine

## Classifications Changed During Design

Two tables upgraded KEEP-WITH-REDESIGN → DISCARD during investigation:

| Table | Reason for upgrade |
|---|---|
| `uploads` | Current 5-col shape is a minimal predecessor to `media_assets`. Every column on `uploads` is a subset of what `media_assets` already provides. No distinct semantics. Per the Session 3 work order guidance ("default to DISCARD if shape overlaps substantially with media_assets"), this qualifies. §6.1 updated. |
| `team_member_assignments` | Current 5-col shape (`owner_id, team_member_user_id, employee_name`) is already covered by `(users.owner_id, users.user_id, users.name)` + `employees.name` join. The table adds no semantics not already captured in the retained identity spine. Per the work order guidance ("If it duplicates chiefos_portal_users functionality, upgrade to DISCARD"), applied here for duplication with `users`/`employees` instead. §6.1 updated. |

Both DISCARD rationales recorded inline in Section 6.1 rows for transparency.

## Design Decisions Flagged for Founder Review

These were made during this session without deferring. All can be revisited; none are load-bearing in a way that blocks Phase 2.

1. **Mileage logs emit parallel `transactions` rows at confirm time.** Adopted the approach the Session 3 work order recommended. This means mileage appears in the canonical financial ledger as `kind='expense'` with `category='mileage'`, idempotent via `source_msg_id`. The `mileage_logs.transaction_id` FK stores the linkage. Duplication is intentional — `mileage_logs` stays as the domain table, `transactions` is the canonical ledger query surface.

2. **Overhead payments emit parallel `transactions` rows the same way.** Same pattern as mileage.

3. **`settings` uses a `scope` column (`'owner' | 'tenant'`) instead of a parallel `tenant_settings` table.** Single-table design chosen for uniform key-value pattern. Trade-off: `UNIQUE` constraint is 3-column; tenant-scope rows duplicate across owners in the same tenant (enforced by app code, not DB). Can be split into two tables if this proves awkward in Phase 3.

4. **`stripe_events` stays RLS-enabled with no `authenticated` grants.** Stripe webhooks are service-role-only; portal surfaces read derived state from `users.sub_status` etc., never from this table directly. No portal read path planned.

5. **`chiefos_crew_rates` uses dual identifier columns (`portal_user_id` uuid + `employee_user_id` text + `employee_name` text fallback).** Three levels of attribution supported: portal user (preferred), WhatsApp digit-string identity, name-only fallback. Partial UNIQUEs enforce one-active-rate-per-person per effective date.

6. **`customers.owner_id` added as NOT NULL**, even though customers are tenant-level (not owner-level) entities. Rationale: dual-boundary consistency, plus ingestion-side create paths (WhatsApp owner says "new customer John Smith") need `owner_id` for attribution and idempotency (`source_msg_id` pairing).

7. **`tasks.id` changed from `bigint` to `uuid`.** Per Constitution §2 (UUIDs for row identifiers). Phase 3 migration carries out the type change; no data to preserve since rebuild wipes the table.

8. **`tasks.type` renamed to `tasks.kind`.** SQL reserved-word avoidance; matches the `kind` discriminator pattern used on `transactions`, `intake_items`, `parse_jobs`, etc.

## Architectural Questions Surfaced (None Require Existing-Page Changes)

No design decisions in this session surface a question that affects Sections 3.1–3.11 already in the document. The 13 new pages integrate cleanly:

- Composite FKs outward (to `chiefos_tenants`, `jobs`, `chiefos_portal_users`, `users`, `media_assets`, `overhead_items`, `transactions`) are all to tables whose design pages already specify the `UNIQUE (id, tenant_id, owner_id)` composite FK target per Principle 11
- No circular dependencies introduced
- No shifts in the 11 principles or the Cross-Cutting Patterns

Three minor forward-references:

- `tasks` references `users(user_id)` for WhatsApp crew assignees — this works because §3.1's `users` design has `PK user_id`; no change to `users` needed
- `employee_invites.accepted_by_auth_user_id` crosses into Supabase Auth `auth.users.id` — same pattern as `chiefos_portal_users.user_id → auth.users(id)`; no cross-schema FK concern beyond what already exists
- `import_batches.media_asset_id → media_assets(id, tenant_id)` composite — media_assets §3.2 design already specifies composite uniqueness

## Confirmation: Every KEEP-WITH-REDESIGN Table Now Has a Dedicated Design Page

**Yes.** Post-session state:

- §6.1 KEEP-WITH-REDESIGN tables: 41 (was 43; -2 reclassified to DISCARD)
- §3 design pages covering KEEP-WITH-REDESIGN tables: 41 (28 in §3.1–§3.11 + 13 in §3.12)
- Gap: **0**

## Files Modified This Session

- `FOUNDATION_P1_SCHEMA_DESIGN.md`:
  - TOC updated to list §3.12
  - Header paragraph updated to reflect three Phase 1 sessions
  - §3.12 inserted between §3.11 and §4 (13 design pages, ~820 lines added)
  - §6.1 two rows updated (uploads, team_member_assignments reclassified to DISCARD)
  - Summary-for-Checkpoint counts updated
  - New closing line added for Session 3 addendum completion
- `SESSION_3_ADDENDUM_REPORT.md` (this file): new

## Files NOT Modified (Per Work Order Boundaries)

- Sections 1, 2, 3.1–3.11, 4, 5 of `FOUNDATION_P1_SCHEMA_DESIGN.md` — unchanged
- The 11 principles and Cross-Cutting Patterns subsection — unchanged
- The 13 closed founder decisions — honored without deviation
- No migration SQL written
- No app code modified
- No database changes
- No commits

---

**Phase 1 Session 3 addendum complete. FOUNDATION_P1_SCHEMA_DESIGN.md has complete design coverage for every KEEP-WITH-REDESIGN table. Ready for Founder Checkpoint 1 final approval before Phase 2 begins.**
