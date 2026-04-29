# Phase 0 Schema Audit Re-Run — 2026-04-29

**Audit run:** 2026-04-29
**Predecessor:** `docs/migrations/phase0/schema-audit-2026-04-28.md` (NOT GREEN)
**Authority:** `docs/specs/TMTS_v1.1.md` §4 (Phase 0 prerequisite)
**Production target verified:** Supabase project `tctohnzqxzrfijdufrss` (CHiefOS)
**Verdict:** ✅ **GREEN**

## Context

The original Phase 0 audit (2026-04-28) produced 4 blockers + 1 deferred finding and a NOT GREEN verdict. Per v1.1 spec §4.4, Phase 1 schema migrations cannot proceed until Phase 0 is GREEN.

This re-run, executed against current production schema state and post-wipe baseline, verifies:
1. Each original blocker has been resolved by the corresponding remediation PR
2. Phase 0 work added the v1.1-required schema correctly (affirmative checks)
3. No regressions or new findings have surfaced
4. Post-wipe production state is clean

## Original Findings vs Current State

| Severity | Field | Original Finding | Resolution | Current State |
|---|---|---|---|---|
| 🔴 CRITICAL | `phone_number` | Not persisted post-signup | PR #9 + applied (e113d040) | ✅ `chiefos_tenants.phone_e164` present + CHECK + UNIQUE INDEX + RPC integrates |
| 🔴 CRITICAL | `paid_breaks_policy` | Field does not exist | PR #10 + applied (ffcffb4b) | ✅ `chiefos_tenants.paid_breaks_policy` text NOT NULL DEFAULT 'unpaid' + CHECK |
| 🟡 MEDIUM | `tax_region` | Schema mismatch (4 cols vs 1) | PR #10 + applied (ffcffb4b) | ✅ `chiefos_tenants.tax_region` GENERATED ALWAYS AS (country \|\| '-' \|\| province) STORED |
| 🟡 MEDIUM | `email` | portal.js bug — query against non-existent column | PR #8 + deployed (44c5314d) | ✅ `routes/portal.js:131-145` queries `public.users` keyed by `auth_user_id` (canonical) |
| 🟢 LOW | `timezone` | `users.tz` legacy duplicate of canonical `chiefos_tenants.tz` | DEFERRED (post-Phase-1) | 🟢 Still deferred — both columns present; no app-code reads `users.tz` per recon |
| ✅ CLEAN | `business_name` | Single canonical source (`chiefos_tenants.name`) | n/a | ✅ Single source confirmed; `business_name` absent from all `public` tables |

## Affirmative Phase 0 Verification

Schema additions from Phase 0 work confirmed present in production via Supabase MCP introspection:

### `chiefos_tenants.phone_e164`
- **Column shape:** `text` NULL ✓
- **CHECK constraint:** `chiefos_tenants_phone_e164_format_chk` — `phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9]\d{6,14}$'` ✓
- **Partial UNIQUE INDEX:** `chiefos_tenants_phone_e164_unique_idx` — `CREATE UNIQUE INDEX ... USING btree (phone_e164) WHERE (phone_e164 IS NOT NULL)` ✓
- **RPC integration:** `chiefos_finish_signup` body contains `phone_e164` references ✓ (per P1A-13 amendment)

### `chiefos_tenants.paid_breaks_policy`
- **Column shape:** `text` NOT NULL DEFAULT `'unpaid'::text` ✓
- **CHECK constraint:** `chiefos_tenants_paid_breaks_policy_check` — `paid_breaks_policy = ANY (ARRAY['paid'::text, 'unpaid'::text])` ✓

### `chiefos_tenants.tax_region`
- **Column shape:** `text`, `is_generated = ALWAYS` ✓
- **Expression:** `((country || '-'::text) || province)` ✓
- **Distinct from `tax_code`:** `tax_code` retained (`text NOT NULL DEFAULT 'NO_SALES_TAX'`) — different concept (tax-math regime vs geographic identifier) ✓

### `chiefos_tenants.region`
- **Status:** Column **ABSENT** from `information_schema.columns` ✓ (dropped in PR #10)

### `chiefos_tenants.province`
- **Nullability:** `is_nullable = NO` ✓
- **Format CHECK:** `chiefos_tenants_province_format_chk` — `province ~ '^[A-Z]{2}$'` ✓

## Post-Wipe State Verification

| Table | Row Count | Expected | ✓/✗ |
|---|---|---|---|
| `auth.users` | 0 | 0 | ✓ |
| `public.chiefos_tenants` | 0 | 0 | ✓ |
| `public.users` | 0 | 0 | ✓ |
| `public.chiefos_portal_users` | 0 | 0 | ✓ |

Production is at pre-launch zero-row baseline. Next signup will exercise the v1.1 onboarding spine end-to-end as the live integration test.

## Stale-Query Bug Pattern Recheck

Recheck for the bug pattern that produced PR #8 (queries against non-existent columns):

| Pattern | Result |
|---|---|
| `chiefos_tenants.region` readers in app code | 0 matches ✓ |
| `chiefos_portal_users.email` readers in app code | 0 matches ✓ |
| Combined multiline grep across `*.js` / `*.ts` | 0 matches ✓ |

No new instances of the stale-query bug class detected. The existing P1B trackers (`P1B-employer-policies-policy-jsonb-column-missing`, `P1B-tenant-debug-command-broken-columns`) remain filed for post-Phase-1 cleanup; not regressions, just pre-existing instances of the same pattern documented in PR #10's commit message.

## Cross-cutting findings

1. **Email column proliferation (informational, not a blocker):** `email` columns exist on `public.users` (canonical for ChiefOS business context), `auth.users` (Supabase auth), `public.chiefos_beta_signups`, `public.customers`, `public.supplier_users`. The latter three are domain-specific (beta capture form, customer records, supplier users) and intentional — not duplicates of the owner email. No remediation needed.
2. **`users.tz` LOW finding remains DEFERRED.** Both `chiefos_tenants.tz` (canonical) and `users.tz` (legacy) exist. Per recon, no app code reads `users.tz`. Deferred to post-Phase-1 cleanup as originally scheduled.

## Verdict

✅ **GREEN.** All original blockers closed; affirmative Phase 0 work confirmed in production schema; no new findings; no regressions; post-wipe state clean.

**Phase 1 schema migrations per v1.1 §5.1, §5.2, §5.4 may now proceed.**

## Next Workstream

Phase 1 schema migrations:
- **v1.1 §5.1** — lifecycle columns: `lifecycle_state`, `trial_started_at`, `trial_ends_at`, `read_only_started_at`, `read_only_ends_at`, `archived_at`, `data_deletion_eligible_at`, activation tracking (`first_whatsapp_message_at`, `first_portal_login_at`, `first_capture_at`, `first_job_created_at`), `reminders_sent` JSONB, plus indexes on lifecycle state/expiry. **Placement note:** v1.1 spec literal places these on `users`, but recon during Phase 0 phone_e164 work established that `users` is multi-actor-per-owner (one row per crew member under an owner_id); per-business state correctly belongs on `chiefos_tenants` (1:1 with business). Final placement to be determined during Phase 1 recon, with the same multi-actor consideration that drove `phone_e164` to `chiefos_tenants` (PR #9 + spec amendment) likely applying.
- **v1.1 §5.2** — `users.plan_key` CHECK constraint update to v1.1 enum (`trial`, `starter`, `pro`, `enterprise`, `read_only`).
- **v1.1 §5.4** — new `acquisition_events` table for funnel tracking from landing-page click to paid conversion.

Lifecycle reconciliation cron (v1.1 §8) and lifecycle transition functions (v1.1 §7) are subsequent application-code workstreams; the schema migrations come first.

## P1B trackers (filed; not blocking Phase 1)

- `P1B-whoami-test-coverage` (PR #8)
- `P1B-finish-signup-rpc-test-coverage` (PR #9)
- `P1B-employer-policies-policy-jsonb-column-missing` (PR #10)
- `P1B-tenant-debug-command-broken-columns` (PR #10)
- `P1B-systematic-stale-query-audit` (PR #10) — codebase-wide audit for the stale-query bug pattern
- `users.tz` LOW deferred finding — track alongside the stale-query audit

## Confidence

**High.** All schema introspection performed via Supabase MCP `execute_sql` against the live production database (`tctohnzqxzrfijdufrss`). All affirmative checks return the expected shapes. No data modifications were made by this audit (read-only). Stale-query grep covers the bug pattern that produced PR #8.

---

*End of Phase 0 audit re-run — 2026-04-29*
