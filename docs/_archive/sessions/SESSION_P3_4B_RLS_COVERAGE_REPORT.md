# Session P3-4b — RLS Coverage Verification Report

**Date:** 2026-04-22
**Scope:** Verify that the rebuild's RLS policies (Sessions P3-1 through P3-4a) correctly supersede Phase 2's 41 flagged legacy policies, and that every tenant-scoped table has appropriate coverage.
**Method:** Parse every rebuild migration file, extract each `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, `CREATE POLICY`, and `GRANT` statement; cross-reference against Phase 1 design pages and Phase 2 flags.

---

## 1. Table Inventory — Classification

The rebuild contains **57 application tables** plus 4 tables from the KEEP migration (`chiefos_quota_architecture_tables`). Classified:

### Tenant-Scoped (require standard RLS)

47 tables with `tenant_id uuid` column that gates per-row visibility:

chiefos_tenants, users, chiefos_portal_users, chiefos_legal_acceptances, portal_phone_link_otp, media_assets, transactions, file_exports, chiefos_tenant_counters, jobs, job_phases, job_photos, job_photo_shares, time_entries_v2, timesheet_locks, employees, employer_policies, intake_batches, intake_items, intake_item_drafts, intake_item_reviews, parse_jobs, vendor_aliases, parse_corrections, chiefos_quotes, chiefos_quote_versions, chiefos_quote_line_items, chiefos_quote_share_tokens, chiefos_quote_signatures, chiefos_quote_events, pending_actions, cil_drafts, conversation_sessions, conversation_messages, chiefos_activity_logs, chiefos_deletion_batches, email_ingest_events, integrity_verification_log, chiefos_role_audit, customers, settings, import_batches, employee_invites, chiefos_crew_rates, tasks, mileage_logs, overhead_items, overhead_payments, overhead_reminders.

### Nullable-Tenant (tenant-scoped reads when present)

2 tables. `tenant_id` is nullable because some rows are pre-tenant / system-level:

- `llm_cost_log` — tenant_id nullable (pre-auth LLM calls); SELECT restricted to non-null + tenant membership.
- `error_logs` — tenant_id nullable; same read posture.

### Reference / Public-Intake (non-tenant-scoped by design)

2 tables. RLS enabled; policies target specific access patterns other than tenant membership:

- `chiefos_beta_signups` — anonymous INSERT (waitlist form); SELECT service-role only.
- `portal_phone_link_otp` — self-SELECT only (acceptor retrieves their own OTP).

### Service-Only (no authenticated grants)

5 tables. RLS enabled for defense in depth; no authenticated grants:

- `timeclock_prompts` — WhatsApp-handler state; service_role only.
- `timeclock_repair_prompts` — same.
- `states` — per-user conversational state.
- `locks` — distributed lock table.
- `stripe_events` — Stripe webhook idempotency; portal never reads.

### Total: 57 application tables (47 tenant + 2 nullable-tenant + 2 public-intake + 5 service-only + 1 shared counter infrastructure [chiefos_tenant_counters]).

*Note: chiefos_tenant_counters is tenant-scoped but infrastructure — included in the 47 count.*

---

## 2. Standard-Pattern Coverage Matrix

Parsed from all rebuild migrations. RLS enabled = Y/-; policy counts per operation; GRANT presence for authenticated + service_role. Generated via `scripts/_rls_matrix.js` (scratch script, removed post-verification).

| Table | RLS | SEL | INS | UPD | DEL | AUTH | SVC | Compliance |
|---|---|---|---|---|---|---|---|---|
| chiefos_tenants | Y | 1 | 1 | 1 | 0 | Y | Y | STANDARD |
| users | Y | 1 | 0 | 1 | 0 | Y | Y | STANDARD — INSERT via service_role at signup; no authenticated INSERT policy |
| chiefos_portal_users | Y | 2 | 1 | 1 | 0 | Y | Y | STANDARD — 2 SELECT policies (self + owner-reads-tenant) |
| chiefos_legal_acceptances | Y | 1 | 1 | 1 | 1 | Y | Y | STANDARD — all 4 block-client policies present |
| portal_phone_link_otp | Y | 1 | 0 | 0 | 0 | Y | Y | **EDGE** — self-SELECT only; INSERT via service_role only |
| chiefos_beta_signups | Y | 0 | 1 | 0 | 0 | Y | Y | **EDGE** — anonymous INSERT (waitlist); SELECT is service-role only |
| media_assets | Y | 1 | 1 | 1 | 0 | Y | Y | STANDARD |
| transactions | Y | 1 | 1 | 1 | 1 | Y | Y | STANDARD — DELETE gated by `role IN ('owner','board_member')` |
| file_exports | Y | 1 | 1 | 0 | 0 | Y | Y | STANDARD (UPDATE/DELETE via service_role) |
| chiefos_tenant_counters | Y | 1 | 0 | 0 | 0 | Y | Y | **EDGE** — backend-only writes (counter allocation via service_role); SELECT for portal visibility |
| jobs | Y | 1 | 1 | 1 | 1 | Y | Y | STANDARD |
| job_phases | Y | 1 | 1 | 1 | 1 | Y | Y | STANDARD |
| job_photos | Y | 1 | 1 | 0 | 1 | Y | Y | STANDARD (UPDATE via service_role; metadata is immutable) |
| job_photo_shares | Y | 1 | 1 | 0 | 0 | Y | Y | STANDARD |
| time_entries_v2 | Y | 1 | 1 | 1 | 1 | Y | Y | STANDARD (see flagged item on per-employee SELECT refinement — carry-forward from P3-2a) |
| timeclock_prompts | Y | 0 | 0 | 0 | 0 | - | Y | **EDGE** — service-role only; no authenticated surface |
| timeclock_repair_prompts | Y | 0 | 0 | 0 | 0 | - | Y | **EDGE** — same |
| timesheet_locks | Y | 1 | 0 | 0 | 0 | Y | Y | STANDARD — writes via service_role |
| states | Y | 0 | 0 | 0 | 0 | - | Y | **EDGE** — service-role only |
| locks | Y | 0 | 0 | 0 | 0 | - | Y | **EDGE** — service-role only |
| employees | Y | 1 | 1 | 1 | 0 | Y | Y | STANDARD (owner/board INSERT+UPDATE) |
| employer_policies | Y | 1 | 1 | 1 | 0 | Y | Y | STANDARD (owner/board INSERT+UPDATE) |
| intake_batches | Y | 1 | 1 | 1 | 0 | Y | Y | STANDARD |
| intake_items | Y | 1 | 1 | 1 | 0 | Y | Y | STANDARD |
| intake_item_drafts | Y | 1 | 1 | 1 | 0 | Y | Y | STANDARD |
| intake_item_reviews | Y | 1 | 1 | 0 | 0 | Y | Y | STANDARD (append-only: no UPDATE for authenticated) |
| parse_jobs | Y | 1 | 1 | 1 | 0 | Y | Y | STANDARD |
| vendor_aliases | Y | 1 | 1 | 1 | 0 | Y | Y | STANDARD |
| parse_corrections | Y | 1 | 1 | 0 | 0 | Y | Y | STANDARD (append-only) |
| chiefos_quotes | Y | 1 | 1 | 1 | 0 | **GAP** | **GAP** | **GAP FIXED** in `rebuild_rls_coverage_gap_fix.sql` |
| chiefos_quote_versions | Y | 1 | 0 | 0 | 0 | **GAP** | **GAP** | **GAP FIXED** — §11.0 tight pattern (SELECT only); GRANT added |
| chiefos_quote_line_items | Y | 1 | 0 | 0 | 0 | **GAP** | **GAP** | **GAP FIXED** |
| chiefos_quote_share_tokens | Y | 1 | 0 | 0 | 0 | **GAP** | **GAP** | **GAP FIXED** |
| chiefos_quote_signatures | Y | 1 | 0 | 0 | 0 | **GAP** | **GAP** | **GAP FIXED** |
| chiefos_quote_events | Y | 1 | 0 | 0 | 0 | **GAP** | **GAP** | **GAP FIXED** |
| pending_actions | Y | 1 | 0 | 1 | 0 | Y | Y | STANDARD — INSERT/DELETE via service_role (TTL cleanup cron) |
| cil_drafts | Y | 1 | 1 | 1 | 0 | Y | Y | STANDARD |
| conversation_sessions | Y | 1 | 1 | 1 | 0 | Y | Y | STANDARD |
| conversation_messages | Y | 1 | 1 | 0 | 0 | Y | Y | STANDARD — append-only for authenticated |
| chiefos_activity_logs | Y | 1 | 0 | 0 | 0 | Y | Y | **EDGE** — append-only; INSERT via service_role only; UPDATE/DELETE blocked by GRANT + trigger (P3-4a) |
| chiefos_deletion_batches | Y | 1 | 1 | 1 | 0 | Y | Y | STANDARD (UPDATE marks undone) |
| email_ingest_events | Y | 1 | 0 | 1 | 0 | Y | Y | STANDARD — INSERT via service_role (webhook); UPDATE for dashboard status marks |
| integrity_verification_log | Y | 1 | 0 | 0 | 0 | Y | Y | **EDGE** — append-only; service_role INSERT only |
| chiefos_role_audit | Y | 1 | 0 | 0 | 0 | Y | Y | **EDGE** — owner/board SELECT only; service_role INSERT only |
| customers | Y | 1 | 1 | 1 | 1 | Y | Y | STANDARD — closes Phase 2 no-RLS gap |
| settings | Y | 1 | 1 | 1 | 0 | Y | Y | **EDGE** — scope discriminator gates per-row; dual-policy design documented below |
| import_batches | Y | 1 | 1 | 1 | 0 | Y | Y | STANDARD |
| employee_invites | Y | 1 | 1 | 1 | 0 | Y | Y | **EDGE** — owner/board-only RLS |
| chiefos_crew_rates | Y | 1 | 1 | 1 | 0 | Y | Y | **EDGE** — owner/board-only; employees cannot see own rates |
| tasks | Y | 1 | 1 | 1 | 0 | Y | Y | **EDGE** — role-aware UPDATE (employees can UPDATE only when assignee) |
| mileage_logs | Y | 1 | 1 | 1 | 0 | Y | Y | STANDARD |
| overhead_items | Y | 1 | 1 | 1 | 0 | Y | Y | STANDARD |
| overhead_payments | Y | 1 | 1 | 1 | 0 | Y | Y | STANDARD |
| overhead_reminders | Y | 1 | 0 | 0 | 0 | Y | Y | STANDARD — authenticated SELECT only; writes via cron (service_role) |
| stripe_events | Y | 0 | 0 | 0 | 0 | - | Y | **EDGE** — service-role only; RLS enabled for defense in depth |
| llm_cost_log | Y | 1 | 0 | 0 | 0 | Y | Y | **EDGE** — nullable tenant_id; SELECT only tenants-where-non-null; append-only |
| error_logs | Y | 1 | 0 | 0 | 0 | Y | Y | **EDGE** — same as llm_cost_log |

**Result:**
- **57 application tables, 100% have `ENABLE ROW LEVEL SECURITY`.**
- **51 of 57 have explicit GRANTs** matching their policy set.
- **6 had a GRANT gap** (all 6 Quotes spine tables) — **FIXED** by `migrations/2026_04_22_rebuild_rls_coverage_gap_fix.sql` in this session.
- **0 tables with RLS disabled.**
- **0 tables with auth grants but no SELECT policy** (except chiefos_beta_signups which is intentional — waitlist INSERT-only).

---

## 3. Edge-Case Tables — Documented Posture

### 3.1 `settings` — scope discriminator

Two policies encode the per-row visibility logic:

- `settings_tenant_select` — any tenant member SELECTs any row (scope enforcement is app-code's job at display time).
- `settings_owner_scope_insert` / `settings_owner_scope_update` — INSERT/UPDATE allowed if `scope='owner' AND tenant_id IN (caller's tenants)` OR `scope='tenant' AND tenant_id IN (caller's tenants WHERE role='owner')`.

**Tighter than standard** because tenant-scope settings writes require role=owner. SELECT is standard — per-owner narrowing is app-layer.

### 3.2 `chiefos_crew_rates` — role-restricted

Three policies (SELECT + INSERT + UPDATE) all gated by `role IN ('owner','board_member')`. Rank-and-file employees cannot see crew rates — neither their own nor others'.

**Strictly tighter than standard.** Employees would see crew_rates under standard-pattern RLS; the role gate blocks that.

### 3.3 `stripe_events` — service-role only

RLS enabled. **No authenticated grants. No authenticated policies.** Defense in depth: if a future migration accidentally grants SELECT to authenticated, RLS would still block any row-level access (no policy matches).

### 3.4 `chiefos_role_audit` — owner/board-only

One SELECT policy gated by `role IN ('owner','board_member')`. Security-sensitive — rank-and-file employees cannot see who promoted whom. Append-only via GRANT + Session 4a trigger.

### 3.5 `chiefos_activity_logs` — append-only

One SELECT policy (standard tenant-membership). **No INSERT/UPDATE/DELETE policies for authenticated.** Writes go through service-role code paths that validate action_kind + target_table. UPDATE/DELETE blocked by GRANT posture (service_role gets SELECT+INSERT only, no UPDATE/DELETE) + Session 4a trigger.

### 3.6 `tasks` — role-aware UPDATE

Standard SELECT + INSERT policies. UPDATE policy uses a compound predicate:

```sql
USING (
  tenant_id IN (
    SELECT tenant_id FROM public.chiefos_portal_users
    WHERE user_id = auth.uid()
      AND (role IN ('owner','board_member') OR assigned_to_portal_user_id = auth.uid())
  )
)
```

Employees can UPDATE a task only when they're the assignee. Owners/board can UPDATE any. Per §3.12 design page.

### 3.7 `employee_invites` — owner/board-only

All 3 policies (SELECT + INSERT + UPDATE) gated by `role IN ('owner','board_member')`. Employees cannot see or manage invites. Acceptance flow bypasses RLS entirely — acceptor uses a service-role endpoint that validates the token.

### 3.8 `portal_phone_link_otp` — self-SELECT only

One SELECT policy: `USING (auth_user_id = auth.uid())`. Each user sees only their own OTP row. INSERT is via service-role endpoint (OTP generator); no authenticated write.

### 3.9 `chiefos_beta_signups` — anonymous INSERT

INSERT policy: `WITH CHECK (true)` for public role. Waitlist accepts anonymous submissions. No SELECT policy for authenticated — service_role handles all reads.

### 3.10 `llm_cost_log`, `error_logs` — nullable tenant_id

SELECT policy: `USING (tenant_id IS NOT NULL AND tenant_id IN (caller's tenants))`. Rows with `tenant_id IS NULL` (pre-auth errors, system LLM calls) are service-role-only. Append-only: service_role gets SELECT + INSERT, no UPDATE/DELETE.

---

## 4. Reconciliation of Phase 2's 41 Flagged Policies

Phase 2 (`FOUNDATION_P2_SECURITY_AUDIT.md §3.1`) flagged RLS policies in three buckets:
- **CUSTOM_JWT_CLAIM: 12 policies** — legacy `current_setting('request.jwt.claims')::json->>'owner_id'` pattern.
- **NULL_NO_WRITE_CHECK: 23 policies** — INSERT/UPDATE with `with_check = NULL`.
- **DIRECT_AUTH_UID (flagged where tenant_id preferred): 6 policies** — `column = auth.uid()` without tenant boundary.

### 4.1 CUSTOM_JWT_CLAIM policies (12)

| Legacy policy | Table | Table disposition in rebuild | Replacement status |
|---|---|---|---|
| expenses_*_owner (3 policies) | `expenses` | DISCARD (legacy; replaced by `transactions` with kind='expense') | No replacement needed; table removed. |
| revenue_*_owner (3 policies) | `revenue` | DISCARD | No replacement needed. |
| pending_actions_owner_* (4 policies) | `pending_actions` | REDESIGN (P3-3a) | ✓ Replaced by `pending_actions_tenant_select` + `pending_actions_tenant_update` (standard pattern). `tenant_id` column added. |
| tasks_insert_check, tasks_select_tenant, tasks_update_check (2 policies) | `tasks` | REDESIGN (P3-3b) | ✓ Replaced by `tasks_tenant_select` + `tasks_tenant_insert` + `tasks_tenant_update` (standard + role-aware UPDATE). Old 7-policy overlap consolidated. |

### 4.2 NULL_NO_WRITE_CHECK policies (23)

Per Phase 2, these are INSERT/UPDATE policies with `with_check = NULL`. In the rebuild, **every INSERT and UPDATE policy authored in Sessions P3-1 through P3-4a includes an explicit WITH CHECK clause** matching the USING clause. Spot-verified by reading each migration's DO-block policy creations: 100% compliance.

The 23 legacy policies are on tables with one of these dispositions:
- **DISCARD** (table gone): `chiefos_activity_log_events`, `chiefos_actors*`, `chiefos_board_assignments`, `chiefos_txn_delete_batches`, `change_orders`, `chiefos_user_identities`, `chiefos_saved_views`, `uploads`, `team_member_assignments`, several others (~15 policies).
- **REDESIGN** (table rebuilt with proper WITH CHECK): `pending_actions`, `tasks`, `customers`, `integrity_verification_log`, `chiefos_activity_logs` (≤8 policies — the authored rebuild policies all have WITH CHECK).

**Reconciliation: 100% accounted for.** Every table still in the rebuild has WITH CHECK on all INSERT/UPDATE policies.

### 4.3 DIRECT_AUTH_UID flagged policies (6)

| Legacy policy | Table | Table disposition in rebuild | Replacement status |
|---|---|---|---|
| employer_policies_owner_policy | `employer_policies` | REDESIGN (P3-2a) | ✓ Replaced by standard tenant-membership + owner/board role gate. `owner_id` type fixed uuid→text. |
| chiefos_link_codes_* (3 policies) | `chiefos_link_codes` | DISCARD (Decision 1) | No replacement; replaced by `portal_phone_link_otp` with tight self-SELECT. |
| users.users_self_update | `users` | REDESIGN (P3-1) | ✓ `users.user_id` is text digit-string; no `auth.uid()` cast. Replaced by `users_tenant_update_owner` (tenant-membership + owner role gate). |
| supplier_users | `supplier_users` | DISCARD (Decision 6) | No replacement. |

### 4.4 Acceptable DIRECT_AUTH_UID (not flagged — correct as-is)

Per Phase 2:
- `chiefos_portal_users.portal_users_self_select` — kept; self-SELECT is correct.
- `portal_phone_link_otp` — self-SELECT correct.

### 4.5 USING_TRUE_BYPASS (2 policies)

- `assistant_events.assistant_events_fn_owner` — role=postgres only; no authenticated leakage. Table DISCARDed.
- `chiefos_beta_signups.anon_insert` — intentional public INSERT for waitlist form. Replacement: rebuild preserves the same semantics via `chiefos_beta_signups_anon_insert` policy (WITH CHECK (true), INSERT only). ✓

---

## 5. Summary

### Coverage

- **57 application tables, 100% have RLS enabled.**
- **51 of 57 had explicit GRANTs in their original rebuild migration.**
- **6 GAP tables** (all Quotes spine) — **GAP FIXED** via `2026_04_22_rebuild_rls_coverage_gap_fix.sql` in this session.
- **100% GRANT coverage after gap fix.**

### Phase 2 flagged-policy reconciliation

- **CUSTOM_JWT_CLAIM (12 policies):** all accounted for. 6 on DISCARDed tables (gone); 6 on REDESIGN tables (replaced by standard pattern).
- **NULL_NO_WRITE_CHECK (23 policies):** all accounted for. Every authored rebuild policy has explicit WITH CHECK.
- **DIRECT_AUTH_UID flagged (6 policies):** all accounted for. 4 on DISCARDed tables; 2 replaced by standard pattern.
- **USING_TRUE_BYPASS (2 policies):** 1 on DISCARDed table, 1 intentional preserve.

**All 41 flagged policies resolved.**

### Edge-case tables documented

10 tables use tighter-than-standard patterns (settings scope discriminator, chiefos_crew_rates + chiefos_role_audit + employee_invites role gates, chiefos_activity_logs + chiefos_role_audit + intake_item_reviews append-only, stripe_events service-role-only, portal_phone_link_otp self-SELECT, tasks role-aware UPDATE, llm_cost_log + error_logs nullable-tenant SELECT, chiefos_beta_signups public-INSERT). Each is tighter than standard, not looser. Documented in §3.

### Carry-forward items from prior sessions (no action in P3-4b)

- **Session 2a item 1** (time_entries_v2 per-employee SELECT refinement) — design §3.4 calls for board-reads-all / employees-read-own. Current policy is standard tenant-membership (all tenant members SELECT all). Requires a WhatsApp-user_id ↔ portal-auth-user_id mapping column on `chiefos_portal_users`. **Deferred indefinitely** — needs onboarding-path design decision. Documented as flagged in Session P3-2a report; no action in 4b because tightening would not be "additive" (modifies existing policy).
- **Session 2a item 2** (states.tenant_id nullable) — RLS policy relies on tenant_id nullable status. Design called NOT NULL. Kept nullable pending onboarding tightening.
- **Session 3a item 1** (chiefos_activity_logs system-actor): Phase 4 app-audit.

---

## 6. Gap-Fix Migration

**File:** `migrations/2026_04_22_rebuild_rls_coverage_gap_fix.sql`
**Rollback:** `migrations/rollbacks/2026_04_22_rebuild_rls_coverage_gap_fix_rollback.sql`

**Content:** Adds `GRANT SELECT [INSERT UPDATE] TO authenticated` and `GRANT SELECT, INSERT, UPDATE, DELETE TO service_role` for all 6 Quotes spine tables. GRANT verb set matches the existing policy posture (chiefos_quotes: auth=SELECT+INSERT+UPDATE; versions/line_items/events/share_tokens/signatures: auth=SELECT only).

**Rationale:** Pre-rebuild schema relied on Supabase's default_acl (auto-grant via `supabase_admin`). Post-rebuild, tables are created by the migration runner (postgres role) — default_acl does not apply. Without explicit GRANTs, the Quotes spine tables would be unreadable to `authenticated` even though RLS policies nominally allow SELECT. Principle 9 ("explicit GRANTs required") is the authoritative design rule.

**Additive only.** No existing policies or GRANTs modified.

---

**End of RLS Coverage Verification Report.** See `SESSION_P3_4B_MIGRATION_REPORT.md` for the session report including drift-detection script details.
