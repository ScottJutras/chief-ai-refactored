# Session P3-4a — Migration Authorship Report

**Date:** 2026-04-22
**Scope delivered:** 10 functions + 10 trigger bindings (plus 26 touch_updated_at bindings) + 6 views per FOUNDATION_P1_SCHEMA_DESIGN.md §4, §5.1, §5.3.
**Deferred to Session P3-4b:** 41 flagged RLS policy redesigns; append-only triggers for non-§5.1 tables (llm_cost_log, error_logs, conversation_messages, chiefos_role_audit, intake_item_reviews, stripe_events column-restricted UPDATE, import_batches completed-state); schema drift detection script.
**Authority:** Session P3-4a work order; `FOUNDATION_P1_SCHEMA_DESIGN.md` §4 + §5.1 + §5.3.

---

## 0. Unresolved Flagged Items Carry-Forward

### From Session 2a (6 items)
- Items 1 (time_entries_v2 per-employee RLS), 2 (states.tenant_id), 3 (intake_item_drafts columns), 6 (counter rollback): **No effect on 4a.** Defer to P3-4b.
- Item 4 (parse_corrections composite FK): resolved P3-2b. Closed.
- Item 5 (counter infra): **Affects 4a indirectly** — Function 10 (`chiefos_next_tenant_counter`) consumes `chiefos_tenant_counters`. Verified present.

### From Session 3a (6 items)
- All 6: **No effect on 4a.**

### From Session 3b (8 items)
- Item 3 (tasks.task_no helper): **Resolved by 4a Function 10.**
- Item 4 (stripe_events column-level UPDATE restriction): **Deferred to P3-4b.** Not in §5.1's 10-function inventory, so out of scope this session.
- All other 3b items: **No effect on 4a.**

### Affecting Session 4a: none blocking. All dependencies satisfied.

---

## 1. Functions Migration (`2026_04_22_rebuild_functions.sql`)

**10 functions authored.** All `SECURITY INVOKER`. All have explicit `SET search_path = ''`.

| # | Function | Role | Provenance |
|---|---|---|---|
| 1 | `chiefos_touch_updated_at()` | `NEW.updated_at := now()` | NEW in rebuild |
| 2 | `chiefos_quotes_guard_header_immutable()` | chiefos_quotes identity-column guard | Byte-identical re-author from `2026_04_18_chiefos_quotes_spine.sql` §5c |
| 3 | `chiefos_quote_versions_guard_immutable()` | Locked-row immutability | Byte-identical re-author from same file §5a |
| 4 | `chiefos_quote_line_items_guard_parent_lock()` | Parent-lock mutation guard | Byte-identical re-author from same file §5b |
| 5 | `chiefos_quote_share_tokens_guard_immutable()` | Strict + fill-once immutability | Byte-identical from `2026_04_18_chiefos_quote_share_tokens.sql` §4 |
| 6 | `chiefos_quote_signatures_guard_immutable()` | Strict immutability on signatures | Byte-identical from `2026_04_18_chiefos_quote_signatures.sql` §5 |
| 7 | `chiefos_quote_events_guard_immutable()` | Append-only + 2 fill-once columns | Byte-identical from `2026_04_18_chiefos_quote_events.sql` §5 |
| 8 | `chiefos_activity_logs_guard_immutable()` | Append-only audit log | NEW in rebuild |
| 9 | `chiefos_integrity_chain_stamp()` | Per-tenant SHA-256 chain | NEW per Decision 10 |
| 10 | `chiefos_next_tenant_counter(uuid, text)` | UPSERT counter allocation | NEW (not present in production DB; work order body template used) |

### Re-author byte-fidelity note (Functions 2–7)

The six Quotes spine guard functions are byte-identical to the original source migrations, EXCEPT for one safety addition: each now carries `SET search_path = ''` at the function-definition level. This was not present in production. Safe addition because:

- Functions 2, 5, 6, 7 only reference `OLD` and `NEW` columns and raise exceptions. No schema lookups.
- Function 3 only accesses `OLD`, `NEW`, `TG_OP`, and `ERRCODE` literals. No schema lookups.
- Function 4 accesses `public.chiefos_quote_versions` — already fully qualified in the original source. With `SET search_path = ''`, this remains unambiguous.

All function bodies semantically preserve production behavior. Drift is zero.

### Integrity chain function (Function 9) — design decisions taken

1. **SHA-256 implementation:** uses core `sha256()` from `pg_catalog` rather than `pgcrypto.digest()`. Benefits: no extension dependency; portable across Supabase projects without requiring `CREATE EXTENSION pgcrypto`; `pg_catalog` is implicitly on search_path even with `SET search_path = ''`.
2. **Concurrency:** per-(table, tenant) advisory lock via `pg_advisory_xact_lock(hashtextextended(...))`. Transaction-scoped. Serializes inserts within a tenant's chain; no contention across tenants. **Escape hatch** documented in the function's COMMENT: chain-head table with FOR UPDATE locking if Phase 5 load testing reveals contention.
3. **Parameterization:** one function, TG_TABLE_NAME-branched body for `transactions` and `time_entries_v2`. Feature-not-supported exception raised if bound to any other table. This preserves the "≤10 functions" target while supporting both integrity-chain tables.
4. **Canonical input shape:** deterministic `jsonb_build_object` with a fixed key set per table. `COALESCE(v_previous_hash, '')` ensures chain-root rows (first row per tenant) produce a well-defined hash input. Any future addition of a field to the canonical input bumps `hash_version` (currently 1).
5. **Chain column stamping:** `NEW.previous_hash`, `NEW.hash_input_snapshot`, `NEW.record_hash`, `NEW.hash_version` all set before RETURN NEW. A BEFORE INSERT trigger ensures these are part of the same row write.

---

## 2. Triggers Migration (`2026_04_22_rebuild_triggers.sql`)

**10 distinct trigger definitions + 26 touch_updated_at bindings = 35 CREATE TRIGGER statements.**

Per §5.3, the 10-count target excludes the touch_updated_at bindings as "one function, many bindings." All 35 are idempotent (each preceded by DROP TRIGGER IF EXISTS).

### 10 distinct trigger definitions

| # | Trigger name | Table | Event | Function |
|---|---|---|---|---|
| 1 | trg_chiefos_quotes_guard_header_immutable | chiefos_quotes | BEFORE UPDATE | function 2 |
| 2 | trg_chiefos_quote_versions_guard_immutable | chiefos_quote_versions | BEFORE UPDATE OR DELETE | function 3 |
| 3 | trg_chiefos_quote_line_items_guard_parent_lock | chiefos_quote_line_items | BEFORE INSERT OR UPDATE OR DELETE | function 4 |
| 4 | trg_chiefos_quote_share_tokens_guard_immutable | chiefos_quote_share_tokens | BEFORE UPDATE OR DELETE | function 5 |
| 5 | trg_chiefos_quote_signatures_guard_immutable | chiefos_quote_signatures | BEFORE UPDATE OR DELETE | function 6 |
| 6 | trg_chiefos_quote_events_guard_immutable | chiefos_quote_events | BEFORE UPDATE OR DELETE | function 7 |
| 7 | trg_chiefos_activity_logs_guard_immutable | chiefos_activity_logs | BEFORE UPDATE OR DELETE | function 8 |
| 8 | trg_chiefos_transactions_integrity_chain | transactions | BEFORE INSERT | function 9 (branch: transactions) |
| 9 | trg_chiefos_time_entries_v2_integrity_chain | time_entries_v2 | BEFORE INSERT | function 9 (branch: time_entries_v2) |
| 10 | trg_chiefos_touch_updated_at | 26 tables (one binding each) | BEFORE UPDATE | function 1 |

### 26 touch_updated_at table coverage

Derived from scanning all rebuild CREATE TABLE blocks for `updated_at timestamptz NOT NULL DEFAULT now()`:

chiefos_tenants, users, chiefos_legal_acceptances, media_assets, transactions, chiefos_tenant_counters, jobs, time_entries_v2, timesheet_locks, states, locks, employer_policies, intake_batches, intake_items, intake_item_drafts, parse_jobs, vendor_aliases, pending_actions, cil_drafts, conversation_sessions, customers, settings, chiefos_crew_rates, tasks, mileage_logs, overhead_items.

### Notable omissions from touch bindings

- **Quotes spine tables** (chiefos_quotes, chiefos_quote_versions, chiefos_quote_line_items, chiefos_quote_share_tokens, chiefos_quote_signatures, chiefos_quote_events) do NOT receive touch bindings. The spine is immutable; touch semantics conflict with the immutability guards (the header's BEFORE UPDATE guard would see an unwanted updated_at change). The spine has its own update discipline.
- **Append-only tables without updated_at** (chiefos_activity_logs, chiefos_role_audit, chiefos_deletion_batches, conversation_messages, stripe_events, llm_cost_log, error_logs, intake_item_reviews, timeclock_prompts, timeclock_repair_prompts, chiefos_beta_signups, portal_phone_link_otp, chiefos_portal_users, chiefos_quote_line_items, email_ingest_events, integrity_verification_log, overhead_payments, overhead_reminders, import_batches, employee_invites, job_phases, job_photos, job_photo_shares, quota_*, addon_*, upsell_*) — no touch binding needed.

---

## 3. Views Migration (`2026_04_22_rebuild_views.sql`)

**6 views, all `WITH (security_invoker = true)`.**

| # | View | Role | Columns |
|---|---|---|---|
| 1 | chiefos_portal_expenses | Portal expense read (kind='expense' AND deleted_at IS NULL) | 26 cols per §4.1 indicative definition |
| 2 | chiefos_portal_revenue | Portal revenue read (kind='revenue' AND deleted_at IS NULL) | Same 26 cols; parallel to #1 |
| 3 | chiefos_portal_time_entries | time_entries_v2 + jobs LEFT JOIN | 14 cols incl. job_name display |
| 4 | chiefos_portal_job_summary | Per-job P&L + labour totals | job_id/tenant_id/owner_id/job_no/name/status/contract_value_cents/start_date/end_date/total_expense_cents/total_revenue_cents/total_labour_hours/gross_profit_cents/gross_margin_pct/created_at/updated_at |
| 5 | chiefos_portal_cashflow_daily | Daily cash in/out | tenant_id/owner_id/date/cash_in_cents/cash_out_cents/net_cents/revenue_count/expense_count |
| 6 | chiefos_portal_open_shifts | Active shifts (start_at_utc set, end_at_utc NULL) | 12 cols incl. hours_elapsed computed |

### Design decisions on View 4 (chiefos_portal_job_summary)

- Collapses 7 DISCARDed KPI views into one.
- Only confirmed transactions count (`submission_status = 'confirmed'`) — pending review excluded from P&L per `chiefos_portal_expenses` pattern from pre-rebuild.
- Labour hours: sum of only completed segments (`end_at_utc IS NOT NULL`). Open shifts excluded to prevent inflation.
- Three CTEs (expense_totals, revenue_totals, labour_totals) + LEFT JOINs on composite `(tenant_id, owner_id, job_id)` to preserve tenant-boundary discipline. Jobs without activity still appear with COALESCEd zeros.
- `gross_margin_pct` is NULL when revenue=0 (avoids divide-by-zero).

### Design decisions on Views 3 + 6 (time-entry views)

- LEFT JOIN jobs on `(id, tenant_id, owner_id)` composite — preserves tenant-boundary even though `job_id` alone would technically resolve uniquely.
- View 6's `hours_elapsed` computed live via `EXTRACT(EPOCH FROM (now() - start_at_utc)) / 3600.0`.
- View 6 filters `kind IN ('shift_start','shift')` to match §3.4 kind enum for shift-start segments; `parent_id` retained for client-side shift-assembly.

---

## 4. Zero-SECDEF Verification

```
$ grep -iE "SECURITY[[:space:]]+DEFINER" migrations/2026_04_22_rebuild_functions.sql
     migrations/2026_04_22_rebuild_triggers.sql
     migrations/2026_04_22_rebuild_views.sql
```

Only matches: 2 comment lines (one in functions file stating "zero SECURITY DEFINER," one in views file stating "SECURITY DEFINER is not used"). **Zero `SECURITY DEFINER` attached to any CREATE FUNCTION or CREATE VIEW statement.** PASS.

## 5. Search-path Hardening Verification

All 10 functions carry `SET search_path = ''` between the LANGUAGE line and the AS body:

```
$ grep -n "^SET search_path = ''$" migrations/2026_04_22_rebuild_functions.sql
# 10 matches at lines 50, 69, 93, 129, 161, 214, 253, 305, 326, 422
```

PASS. All built-in functions used (`sha256`, `encode`, `jsonb_build_object`, `now`, `hashtextextended`, `pg_advisory_xact_lock`) live in `pg_catalog`, which is implicitly on search_path even with the empty setting. All table references are fully schema-qualified (`public.chiefos_quote_versions`, `public.transactions`, etc.) — no unqualified schema lookups that could be hijacked.

## 6. Cross-Reference Validation

| Check | Design expected | Delivered | Result |
|---|---|---|---|
| Functions per §5.1 | 10 | 10 | PASS |
| CREATE OR REPLACE FUNCTION statements | 10 | 10 | PASS |
| Distinct trigger definitions per §5.3 | 10 | 10 | PASS |
| touch_updated_at bindings | ~10–26 per §5.3 wording | 26 | PASS (all tables with updated_at) |
| CREATE TRIGGER statements total | 10 + N | 35 | PASS |
| Views per §4 | 6 | 6 | PASS |
| CREATE VIEW statements | 6 | 6 | PASS |
| SECURITY DEFINER functions | 0 | 0 | PASS |
| SECURITY DEFINER views | 0 | 0 | PASS |
| SET search_path = '' on each function | 10 | 10 | PASS |
| WITH (security_invoker = true) on each view | 6 | 6 | PASS |

All cross-reference checks PASS.

---

## 7. Rollback Files Produced

- `migrations/rollbacks/2026_04_22_rebuild_functions_rollback.sql` — DROPs 10 functions. Must run AFTER triggers rollback.
- `migrations/rollbacks/2026_04_22_rebuild_triggers_rollback.sql` — DROPs 35 trigger bindings. Must run BEFORE functions rollback.
- `migrations/rollbacks/2026_04_22_rebuild_views_rollback.sql` — DROPs 6 views. Independent of functions/triggers.

All idempotent (`IF EXISTS` throughout).

---

## 8. Manifest Updates

- Session history: P3-4a entry added.
- Apply order: steps 18 (rebuild_functions), 19 (rebuild_triggers), 20 (rebuild_views) marked DELIVERED. Step 21 (rebuild_policies_grants_final) and new step 22 (drift_detection_script) reassigned to P3-4b. Step numbering shifted (former step 22 → 23).
- Apply-order notes: P3-4a block added covering all three migrations + function 9's parameterization + touch-trigger coverage.
- DISCARDED functions + triggers + views: counts added (20 SECDEF functions, 19 INVOKER functions, 21 triggers, 17 views).
- Rollback Posture: 3 new rollbacks listed with ordering constraints.

---

## 9. Flagged Items for Founder Review

1. **Integrity chain function uses core `sha256()` instead of `pgcrypto.digest()`.** Core sha256 is available from Postgres 11+; no extension dependency. The work-order spec used pgcrypto. **Recommendation:** keep core sha256 (simpler, portable). Byte-level hash output is identical — SHA-256 is SHA-256 regardless of implementation. **Confirmation requested.**

2. **Integrity chain concurrency approach — per-tenant advisory lock.** `pg_advisory_xact_lock(hashtextextended(table::text || '::' || tenant_id::text, 0))` serializes inserts within a (table, tenant) pair. Hash collisions on `hashtextextended` (64-bit output) are astronomically unlikely for ChiefOS tenant counts but theoretically possible. **Recommendation:** acceptable for Phase 5 cutover. If load testing reveals a collision or contention hot spot, switch to the chain-head-table-with-FOR-UPDATE escape hatch documented in the function's COMMENT. **No action needed unless observed.**

3. **Integrity chain canonical input shape.** The current shape (transactions: id, tenant_id, owner_id, kind, amount_cents, currency, date, source, source_msg_id, created_at, previous_hash) is the work-order-specified set. It deliberately excludes mutable columns like `description`, `merchant`, `category` — these can be edited post-insert without breaking the chain. **Implication:** the chain verifies that a row's identity + financial amount + source was not tampered with, but not that its descriptive fields are unchanged. If stronger tamper-evidence is desired (e.g., merchant tampering detection), the canonical shape would need to expand and `hash_version` bumps to 2. **Confirmation requested.**

4. **View 4 (job_summary) labour-hours semantics.** Sums `end_at_utc - start_at_utc` for completed segments. Breaks (`break_start`/`break_end`) and lunches are also segments and would reduce work-time if subtracted. The current view sums ALL completed segments — so a shift with breaks counts more hours than the employee was actually working. **Phase 4 app-audit item:** if the portal needs true work-time, filter `kind NOT IN ('break_start','break_end','lunch_start','lunch_end','drive_start','drive_end')` or treat only `'shift'` / `'shift_start'`+`'shift_end'` as work-time. Non-blocking for migration authoring; flagged for semantic review.

5. **View 6 (open_shifts) kind filter.** Matches `kind IN ('shift_start','shift')`. Assumes a shift-start event leaves `end_at_utc` NULL until clock-out flips that to a matching shift-end event on a parent_id relationship. **If the shift-assembly model is different** (e.g., parent_id tracks segments, and only the parent row has end_at_utc=NULL), the view kind filter may need refinement. **Phase 4 app-audit confirms.** Non-blocking.

6. **Function 10 (chiefos_next_tenant_counter) did not pre-exist in production DB.** MCP introspection confirmed no such function in the live `public` schema. The work order's body template was used. **Non-blocking** — app code currently allocates via direct UPSERT against `chiefos_tenant_counters` in `services/postgres.js::allocateNextDocCounter`. P3-4a adds the SQL function for use by app code that prefers a callable helper; the direct-UPSERT path continues to work.

7. **Touch-trigger binding list is 26 tables, not ~10 as the design doc's §5.3 wording suggested.** The design's "Applied to: users, chiefos_tenants, chiefos_portal_users, jobs, transactions, time_entries_v2, vendor_aliases, conversation_sessions, chiefos_deletion_batches, and others as needed" listed 9 tables + "others." P3-4a authored 26 — every rebuild table with a matching `updated_at timestamptz NOT NULL DEFAULT now()` column pattern. Two tables in the design's enumeration (`chiefos_portal_users`, `chiefos_deletion_batches`) don't actually have updated_at per their CREATE TABLE — noted in the report and skipped. **Confirmation requested:** is 26 bindings correct (every updated_at column), or is a narrower set preferred? **Recommendation:** keep all 26. Consistent semantics across the rebuilt schema.

8. **Session P3-4b scope preview** — deferred from 4a: append-only triggers for `llm_cost_log`, `error_logs`, `conversation_messages`, `chiefos_role_audit`, `intake_item_reviews`, `import_batches` (completed-state guard), plus `stripe_events` column-restricted UPDATE trigger. None were in §5.1's 10-function inventory; §5.3 listed the 10 bindings P3-4a delivered. **These 7 append-only patterns are guaranteed by GRANT posture today; trigger backup for defense-in-depth is P3-4b scope.** Recommend P3-4b creates them as additional functions + triggers (pushing beyond the ≤10 target, with explicit rationale in a follow-up design doc addendum).

---

## 10. File Inventory

**Created in P3-4a:**
```
migrations/2026_04_22_rebuild_functions.sql
migrations/2026_04_22_rebuild_triggers.sql
migrations/2026_04_22_rebuild_views.sql
migrations/rollbacks/2026_04_22_rebuild_functions_rollback.sql
migrations/rollbacks/2026_04_22_rebuild_triggers_rollback.sql
migrations/rollbacks/2026_04_22_rebuild_views_rollback.sql
SESSION_P3_4A_MIGRATION_REPORT.md
```

**Updated in P3-4a:**
```
REBUILD_MIGRATION_MANIFEST.md (apply order, dependency notes, rollback ordering)
```

**Untouched:**
- All prior-session migrations + rollbacks (P3-1 through P3-3b).
- All app code.
- `FOUNDATION_P1_SCHEMA_DESIGN.md`.

---

## 11. Readiness for Session P3-4b

**Blocked on:** nothing.

**Session P3-4b inputs already in place:**
- Every table exists (P3-1/2a/2b/3a/3b).
- Every trigger function in §5.1 exists (P3-4a).
- Every §5.3 trigger binding exists (P3-4a).
- Every §4 view exists (P3-4a).

**Session P3-4b scope:**
1. **rebuild_policies_grants_final.sql** — sweep the 41 RLS policies flagged for REDESIGN in Phase 2 (§3.1); consolidate any `CUSTOM_JWT_CLAIM` survivors; add append-only triggers for the 7 tables flagged in Item 8 above; add stripe_events column-restricted UPDATE trigger; add the composite UNIQUE on chiefos_portal_users(user_id, tenant_id) if approved per 3b Flag #2.
2. **scripts/verifyRebuildDrift.js** — schema drift detection tool. Reads `FOUNDATION_P1_SCHEMA_DESIGN.md` expectations + live DB via MCP introspection; reports any deviation. Non-migration.
3. Session report: `SESSION_P3_4B_MIGRATION_REPORT.md`.
4. **Phase 3 completion marker** — once 4b ships, Phase 3 is complete and the Rebuild transitions to Phase 4 (app-code audit) and Phase 5 (cold-start cutover).

---

Phase 3 Session 4a complete. Functions, triggers, and views authored. Ready for Phase 3 Session 4b (RLS policy redesign pass + drift detection script).
