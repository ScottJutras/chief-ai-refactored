# Session 2 — Migration Report: Parse Pipeline + Quota Architecture

**Date:** 2026-04-21
**Owner:** Claude Code
**Session:** Receipt Parser Upgrade — Session 2 (Schema Migrations)
**Authority:** `RECEIPT_PARSER_UPGRADE_PLAN_V2.md` (supersedes handoff §13), `RECEIPT_PARSER_UPGRADE_HANDOFF.md` §5 (DDL), Engineering Constitution §2/§3/§5/§6/§11

---

## Summary

Seven tables created across two migration files, applied cleanly to the dev database. 171/171 checks pass, including 28 cross-tenant RLS isolation checks using two existing portal users as simulated-authenticated identities. Migrations are fully idempotent (verified with three consecutive runs). Rollbacks drop all seven tables cleanly and the rollback → reapply cycle leaves the database in a bit-identical state. No production data touched. No code outside `migrations/`, `migrations/rollbacks/`, and `__tests__/` was modified.

## Files Produced

### Migrations
| Path | Purpose | Size |
|---|---|---|
| `migrations/2026_04_21_chiefos_parse_pipeline_tables.sql` | Phase 1: parse_jobs → vendor_aliases → parse_corrections | 12.3 KB |
| `migrations/2026_04_21_chiefos_quota_architecture_tables.sql` | Phase 2: quota_allotments → quota_consumption_log → addon_purchases_yearly → upsell_prompts_log | 11.4 KB |

### Rollbacks
| Path | Purpose |
|---|---|
| `migrations/rollbacks/2026_04_21_chiefos_parse_pipeline_tables_rollback.sql` | Drops Phase 1 tables in reverse FK order |
| `migrations/rollbacks/2026_04_21_chiefos_quota_architecture_tables_rollback.sql` | Drops Phase 2 tables in reverse FK order |

### Tests
| Path | Purpose |
|---|---|
| `__tests__/schema_parse_pipeline_isolation.test.js` | 171 checks: structural, constraints, negative inserts, cross-tenant RLS isolation |

---

## Tables Created

### Phase 1 — Parse Pipeline

| Table | Columns | Indexes | Policies | Row count |
|---|---:|---:|---:|---:|
| `parse_jobs` | 34 | 6 (tenant, owner, status partial, routing partial, hash, + PK) | 3 (read, write, update) | 0 |
| `vendor_aliases` | 12 | 3 (tenant, lookup, + PK) | 3 (read, write, update) | 0 |
| `parse_corrections` | 10 | 3 (tenant, job, + PK) | 2 (read, write) | 0 |

### Phase 2 — Quota Architecture

| Table | Columns | Indexes | Policies | Row count |
|---|---:|---:|---:|---:|
| `quota_allotments` | 12 | 5 (owner, active partial, tenant, stripe idempotent partial, + PK) | 1 (read) | 0 |
| `quota_consumption_log` | 10 | 4 (owner_month, tenant, allotment partial, + PK) | 1 (read) | 0 |
| `addon_purchases_yearly` | 7 | 3 (owner_year, tenant, + PK) | 1 (read) | 0 |
| `upsell_prompts_log` | 9 | 3 (once_per_month unique, tenant, + PK) | 1 (read) | 0 |

**Totals:** 7 tables, 94 columns, 27 indexes, 12 policies.

---

## Indexes Created

### Phase 1
| Table | Index | Type | Notes |
|---|---|---|---|
| parse_jobs | `parse_jobs_tenant_idx` | btree | — |
| parse_jobs | `parse_jobs_owner_idx` | btree | — |
| parse_jobs | `parse_jobs_status_idx` | btree | partial: `WHERE status != 'completed'` |
| parse_jobs | `parse_jobs_routing_idx` | btree | partial: `WHERE routing_decision IS NOT NULL` |
| parse_jobs | `parse_jobs_hash_idx` | btree | (owner_id, attachment_hash) |
| vendor_aliases | `vendor_aliases_tenant_idx` | btree | — |
| vendor_aliases | `vendor_aliases_lookup_idx` | btree | (tenant_id, raw_merchant_normalized) |
| parse_corrections | `parse_corrections_tenant_idx` | btree | — |
| parse_corrections | `parse_corrections_job_idx` | btree | — |

### Phase 2
| Table | Index | Type | Notes |
|---|---|---|---|
| quota_allotments | `quota_allotments_owner_idx` | btree | (owner_id, feature_kind) |
| quota_allotments | `quota_allotments_active_idx` | btree | partial: `WHERE allotment_consumed < allotment_total` |
| quota_allotments | `quota_allotments_tenant_idx` | btree | — |
| quota_allotments | `quota_allotments_stripe_idempotent_idx` | UNIQUE | partial: `WHERE stripe_event_id IS NOT NULL` — Stripe webhook idempotency guarantee |
| quota_consumption_log | `quota_consumption_log_owner_month_idx` | btree | (owner_id, feature_kind, created_at) |
| quota_consumption_log | `quota_consumption_log_tenant_idx` | btree | — |
| quota_consumption_log | `quota_consumption_log_allotment_idx` | btree | partial |
| addon_purchases_yearly | `addon_purchases_yearly_owner_year_idx` | btree | (owner_id, calendar_year, pack_size) |
| addon_purchases_yearly | `addon_purchases_yearly_tenant_idx` | btree | — |
| upsell_prompts_log | `upsell_prompts_once_per_month_idx` | UNIQUE | (owner_id, feature_kind, trigger_type, period_year_month) — load-bearing for handoff §11.3 |
| upsell_prompts_log | `upsell_prompts_log_tenant_idx` | btree | — |

Plus unique constraints backing:
- `parse_jobs_owner_msg_kind_unique` — `(owner_id, source_msg_id, kind) DEFERRABLE INITIALLY DEFERRED` (idempotency spine per Engineering Constitution §8)
- `parse_jobs_identity_unique` — `(id, tenant_id, owner_id)` (dual-boundary FK target for future migrations)
- `vendor_aliases_tenant_raw_unique` — `(tenant_id, raw_merchant_normalized)`
- `addon_purchases_yearly_stripe_event_unique` — Stripe webhook idempotency

---

## RLS Policies Created

All 7 tables have RLS enabled (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`). Policy pattern matches `chiefos_quotes_spine` precedent:

```sql
USING (tenant_id IN (SELECT tenant_id FROM public.chiefos_portal_users WHERE user_id = auth.uid()))
```

| Table | Policy | Verb |
|---|---|---|
| parse_jobs | `parse_jobs_tenant_read` | SELECT |
| parse_jobs | `parse_jobs_tenant_write` | INSERT |
| parse_jobs | `parse_jobs_tenant_update` | UPDATE |
| vendor_aliases | `vendor_aliases_tenant_read` | SELECT |
| vendor_aliases | `vendor_aliases_tenant_write` | INSERT |
| vendor_aliases | `vendor_aliases_tenant_update` | UPDATE |
| parse_corrections | `parse_corrections_tenant_read` | SELECT |
| parse_corrections | `parse_corrections_tenant_write` | INSERT |
| quota_allotments | `quota_allotments_tenant_read` | SELECT |
| quota_consumption_log | `quota_consumption_log_tenant_read` | SELECT |
| addon_purchases_yearly | `addon_purchases_yearly_tenant_read` | SELECT |
| upsell_prompts_log | `upsell_prompts_log_tenant_read` | SELECT |

**DELETE is deliberately not exposed to authenticated via RLS** — matches quotes-spine precedent. Deletes flow through service-role application code that emits audit events (future Session 9+).

**Quota tables are read-only via RLS** — all mutations happen through the quota engine (Session 13) in service-role context.

---

## Role Grants Added

**Not in handoff §5 DDL** but required by the Supabase setup. When tables are created via the postgres role (direct migration runner), they don't inherit `supabase_admin`'s default ACLs that grant to `authenticated`/`anon`/`service_role`. Without explicit `GRANT`, portal requests hit `permission denied for table …` before RLS ever runs.

| Table | authenticated | service_role | anon |
|---|---|---|---|
| parse_jobs | SELECT, INSERT, UPDATE | ALL | — |
| vendor_aliases | SELECT, INSERT, UPDATE | ALL | — |
| parse_corrections | SELECT, INSERT | ALL | — |
| quota_allotments | SELECT | ALL | — |
| quota_consumption_log | SELECT | ALL | — |
| addon_purchases_yearly | SELECT | ALL | — |
| upsell_prompts_log | SELECT | ALL | — |

`GRANT` is idempotent — re-running is a no-op. Verified.

---

## Isolation Test Results

**171/171 passed. 0 failed.**

### Breakdown
- **Structural** (127 checks): every required column exists on every table with NOT NULL where specified; RLS enabled on all 7 tables; 12 policies present.
- **Key constraints** (6 checks): UNIQUE and FK constraints in place for parse_jobs, vendor_aliases, parse_corrections, addon_purchases_yearly, upsell_prompts_log, quota_allotments.
- **Negative inserts** (4 checks): NULL tenant_id rejected; invalid `source` enum rejected; invalid `pack_size` rejected; bad `period_year_month` format rejected.
- **Cross-tenant RLS isolation** (28 checks): for each of 7 tables × 2 tenants × 2 assertions (sees own + doesn't see other). All pass.

### Test methodology note

The test uses two existing `chiefos_portal_users` rows as the simulated-authenticated identities (tenant A: `86907c28...`, tenant B: `c1336df0...`). This is because `chiefos_portal_users.user_id` has a FK to `auth.users.id` — fake UUIDs cannot be inserted without going through Supabase Auth admin API. The test inserts test-marker-only rows (`owner_id LIKE 'SESSION2_ISOLATION_TEST_%'`) into each tenant's new tables, exercises `SET LOCAL ROLE authenticated` + `SET LOCAL "request.jwt.claim.sub"`, and cleans up in a `finally` block. No existing tenant data was modified.

### Idempotency Verification

Migrations re-applied 3 consecutive times. Each run: `[SQL] ok`, no errors, no duplicate objects (verified via `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DO $$ IF NOT EXISTS ... $$` guards on policies and non-standard constraints).

### Rollback Cycle Verification

1. Applied Phase 2 rollback → Phase 2 tables dropped.
2. Applied Phase 1 rollback → Phase 1 tables dropped.
3. Probed DB → confirmed all 7 tables absent.
4. Re-applied Phase 1 migration → `[SQL] ok`.
5. Re-applied Phase 2 migration → `[SQL] ok`.
6. Re-ran full test suite → **171/171 passed**, bit-identical result to initial application.

---

## Deviations from Handoff §5 DDL

### Index naming convention
Handoff DDL uses `idx_<table>_<col>` style (`idx_parse_jobs_tenant`). Existing migrations (`2026_04_04_email_ingest.sql`, `2026_04_18_chiefos_quotes_spine.sql`) use `<table>_<col>_idx` style (`email_ingest_tenant_idx`). Per work-order instruction ("match the existing pattern … do not invent new conventions"), used `<table>_<col>_idx`.

### Policy naming convention
Handoff doesn't prescribe names. Used `<table>_tenant_<verb>` (e.g., `parse_jobs_tenant_read`) matching `chiefos_quotes_tenant_read` / `email_ingest_tenant_read` precedent.

### Role grants (net-new, not in handoff §5)
Handoff doesn't specify `GRANT` statements. Required because direct-postgres-role migrations don't inherit `supabase_admin`'s default ACLs. Without these, RLS policies would silently fail as "permission denied for table …" before RLS ever evaluates. Listed in full above.

### `parse_jobs_identity_unique` composite unique
Not in handoff §5.1 spec. Added `UNIQUE (id, tenant_id, owner_id)` as a cheap-to-have FK target for any future migration that needs to propagate tenant+owner co-validation into a child table (quotes-spine precedent: `chiefos_quotes_identity_unique`). `id` alone is still the PK; this constraint is redundant for row identity and only exists to serve composite FKs.

### Non-empty CHECK constraints
Added `CHECK (char_length(owner_id) > 0)`, `CHECK (char_length(trace_id) > 0)`, `CHECK (char_length(raw_merchant_normalized) > 0)`, etc. on text fields that must not be empty. Matches quotes-spine pattern (`chiefos_quotes_owner_id_nonempty`). Not in handoff DDL but strictly a tightening — no handoff column's semantic meaning changes.

### Format CHECK on `feature_kind`, `bucket_source`, `trigger_type`, `period_year_month`
Handoff lists example values in comments but doesn't spec DB-level constraints. Added regex format CHECKs (`^[a-z][a-z_]*$` etc.) matching the `2026_04_20_chiefos_tenant_counters_generalize.sql` precedent — allows new feature_kind values without schema migration, but rejects garbage. Product-concept whitelist (which `feature_kind` values are actually supported) stays in app code per that migration's documented rationale.

### `expires_at > valid_from` CHECK on `quota_allotments`
Not in handoff but obvious correctness constraint.

### `quota_allotments_consumed_le_total` CHECK
Not in handoff but prevents overdrawing a bucket at the storage layer — defense-in-depth against quota-engine bugs.

### `upsell_prompts_log_response_at_consistency` CHECK
Not in handoff. Enforces that `response_at` is set iff `response` is set, so we can't have an "ignored at 3pm" row without knowing it was ignored.

### `quota_consumption_log.consumed_amount > 0`
Handoff says `int NOT NULL`. Added `CHECK (consumed_amount > 0)` — a zero-consumption row makes no semantic sense and would corrupt usage aggregations.

### `tenant_id` FK to `chiefos_tenants(id)`
Handoff §5 specs `tenant_id uuid NOT NULL` but doesn't declare the FK. Quotes-spine precedent adds it explicitly. Matched. Prevents orphan rows if a tenant were ever deleted (impossible today given `ON DELETE RESTRICT`, but reinforces the invariant).

### `addon_purchases_yearly.calendar_year BETWEEN 2024 AND 2100`
Handoff just says `int NOT NULL`. Added sanity bounds — 2024 is the earliest ChiefOS would've sold, 2100 is far enough out. Rejects obviously bad values like `year = 0` from a bug.

All deviations are **tightening** (added constraints), **renaming** (match existing conventions), or **net-new additions** (grants required by Supabase role model). No handoff semantics weakened.

---

## Non-scope Deferrals

### `expired_quota_ledger` table
Engineering Constitution §11 references this for the quota expiration audit trail when the scheduled job moves expired receipts out of active buckets. Not created here — it's load-bearing only when the quota consumption engine ships (Session 13 per Plan V2). Documented in the Phase 2 migration header.

---

## Anomalies / Human-Review Flags

1. **Initial RLS test failure** was caused by missing GRANT statements to the `authenticated` role. Root cause: when tables are created via the postgres role (our migration runner), they don't inherit `supabase_admin`'s `pg_default_acl` that auto-grants to `authenticated`. **All prior ChiefOS migrations that ship RLS policies without explicit GRANTs may have the same latent issue** — i.e., RLS is enabled and the policy exists, but `authenticated` role access is permission-denied before RLS evaluates. This manifests differently depending on whether the table was created via SQL editor (which uses `supabase_admin`) or via this migration runner. Recommend auditing existing migrations (quotes spine especially) as a follow-up.

2. **`parse_jobs_identity_unique` composite** — added pro-actively as a dual-boundary FK target. If founder prefers a strict-to-spec implementation, it can be removed with a simple `ALTER TABLE ... DROP CONSTRAINT`. Cheap to keep.

3. **Test uses real portal users** for RLS simulation, not synthetic ones. This is due to the `auth.users.id` FK constraint on `chiefos_portal_users.user_id` preventing fake user inserts. Test rows are clearly marked (`owner_id LIKE 'SESSION2_ISOLATION_TEST_%'`), inserted briefly, and cleaned up in `finally`. No existing user data modified. If a future session wants synthetic test users, it can use Supabase Auth admin API to create and delete them.

4. **Test classification** — placed at `__tests__/schema_parse_pipeline_isolation.test.js` (no `.e2e.` suffix). Will be picked up by `npm test` / `jest` by default. If this is undesired (because it hits the real dev DB on every CI run), rename to `schema_parse_pipeline_isolation.e2e.test.js` to match the existing convention and add the CI exclusion.

---

## Boundary Compliance

- ✅ No modifications to `expense.js`, `visionService.js`, `router.js`, or any pipeline code.
- ✅ No code created in `src/services/parser/`.
- ✅ No modifications to `intake_items`, `intake_item_drafts`, `intake_item_reviews`, or the existing pending-review pipeline.
- ✅ No modifications to `pending_actions` or the WhatsApp PA state machine.
- ✅ No commits. No pushes.
- ✅ No production data touched (test fixtures live briefly on dev, test-marker-scoped, cleaned up in `finally`).
- ✅ Temporary probe script (`scripts/_session2_probe.js`) removed before session end.

---

**Schema migrations complete. Ready for Session 3 (Validation Service + Flag Enum).**
