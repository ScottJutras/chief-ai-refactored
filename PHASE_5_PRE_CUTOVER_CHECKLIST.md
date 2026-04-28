# Phase 5 Pre-Cutover Checklist

**Purpose:** items to verify or run against production **before** applying the rebuild migrations during Phase 5 cutover. Every item that could cause a migration to fail at apply time (CHECK constraint violation from existing data, missing extension, etc.) belongs here.

**Status:** growing document. Items added as sessions surface them.

---

## 1. CHECK-constraint value verification

The rebuild migrations add CHECK constraints to several columns that production has as free-text. Any production row with a value outside the new enum will reject at cutover. Spot-check production data before applying migrations.

### Added in P1A-2 (supplier catalog)

```sql
-- supplier_users.role — rebuild adds CHECK (role IN ('owner','admin','editor'))
SELECT DISTINCT role, COUNT(*) FROM public.supplier_users GROUP BY role;

-- catalog_price_history.change_source — rebuild adds CHECK IN ('manual','ingestion','api','migration')
SELECT DISTINCT change_source, COUNT(*) FROM public.catalog_price_history GROUP BY change_source;

-- suppliers.status — rebuild adds CHECK IN ('pending','active','suspended','archived')
SELECT DISTINCT status, COUNT(*) FROM public.suppliers GROUP BY status;

-- suppliers.supplier_type — rebuild adds CHECK IN ('manufacturer','distributor','retailer','other')
SELECT DISTINCT supplier_type, COUNT(*) FROM public.suppliers GROUP BY supplier_type;

-- suppliers.catalog_update_cadence — rebuild adds CHECK IN ('weekly','monthly','quarterly','annually','on_change')
SELECT DISTINCT catalog_update_cadence, COUNT(*) FROM public.suppliers GROUP BY catalog_update_cadence;

-- suppliers.region — rebuild adds CHECK IN ('canada','usa','international')
SELECT DISTINCT region, COUNT(*) FROM public.suppliers GROUP BY region;

-- catalog_products.price_type — rebuild adds CHECK IN ('list','contractor','distributor','promo')
SELECT DISTINCT price_type, COUNT(*) FROM public.catalog_products GROUP BY price_type;

-- catalog_ingestion_log.status — rebuild adds CHECK IN ('pending','processing','completed','failed','partial')
SELECT DISTINCT status, COUNT(*) FROM public.catalog_ingestion_log GROUP BY status;

-- catalog_ingestion_log.source_type — rebuild adds CHECK IN ('xlsx_upload','csv_upload','email_attachment','api','manual')
SELECT DISTINCT source_type, COUNT(*) FROM public.catalog_ingestion_log GROUP BY source_type;
```

**For any value outside its CHECK set:** either widen the CHECK in the migration OR migrate those rows to a valid value pre-cutover. Document whichever approach in the R1 remediation session notes.

### Added in P1A-3 (RAG knowledge)

No new free-text → CHECK tightenings in P1A-3. The rebuild does NOT add CHECK constraints to `docs.source` (preserving production flexibility) or to `tenant_knowledge.kind` (expected-growth enum; see manifest Forward Flag 19). The only new CHECKs introduced (`doc_chunks.idx >= 0`, `tenant_knowledge.seen_count >= 1`, `tenant_knowledge.confidence` range, not-blank CHECKs) operate on columns with server-controlled defaults or sentinel-safe values — no pre-cutover production verification needed.

### Added in future sessions
(Add CHECK constraint spot-check queries here as subsequent sessions introduce them.)

---

## 2. Extension verification

Rebuild migrations that require PG extensions beyond the Supabase default set. Confirm each extension is installed in production's target schema.

- `pgcrypto` — used by `gen_random_uuid()` across nearly all rebuild tables. Should already be installed on Supabase.
- `vector` (pgvector) — used by `doc_chunks.embedding` in the RAG §3.14 amendment (P1A-3 authoring). Must be installed before `2026_04_22_amendment_rag_docs.sql` applies.

Query:
```sql
SELECT extname, extversion FROM pg_extension WHERE extname IN ('pgcrypto','vector');
```

---

## 3. Orphan-row dependency checks

Rebuild adds foreign keys that production lacks. Any production rows with dangling references would reject at cutover.

### Added in P1A-2

- `supplier_users.auth_uid → auth.users(id)`:
  ```sql
  SELECT su.auth_uid FROM public.supplier_users su
  LEFT JOIN auth.users au ON au.id = su.auth_uid
  WHERE au.id IS NULL;
  ```
  Any rows → either delete the orphan supplier_users row, or recreate the auth user, before cutover.

- `tenant_supplier_preferences.tenant_id → chiefos_tenants(id)`:
  ```sql
  SELECT tsp.tenant_id FROM public.tenant_supplier_preferences tsp
  LEFT JOIN public.chiefos_tenants t ON t.id = tsp.tenant_id
  WHERE t.id IS NULL;
  ```

---

## 4. Data migrations that aren't schema migrations

Columns that rename or restructure across the rebuild need data backfill if production has rows. Captured from session reports:

- `cil_drafts` — pre-rebuild shape (bigint id, varchar columns, `status`/`kind`/`actor_phone`/`actor_user_id`) → rebuild shape (uuid id, text columns, `cil_type`/`validated_at`/`committed_at` timestamps). P3-3a Flag #2. See `docs/_archive/sessions/SESSION_P3_3A_MIGRATION_REPORT.md` §5 Flag 2 for the coercion recipe.
- `intake_item_reviews.reviewed_by_auth_user_id` → `reviewed_by_portal_user_id`. Same identity value, different column name. Trivial UPDATE during cutover.
- `llm_cost_log.query_kind` → `feature_kind`, `cost_usd` → `cost_cents`. Rename + unit conversion (multiply USD × 100).
- `tasks.type` → `kind`. Column rename.
- `tenant_knowledge.owner_id` (uuid → text). P1A-3 drift correction. Production row count = 0 (the text-digit-string INSERT from `services/learning.js` has never succeeded against the uuid column). **No data to migrate — the type change is transparent at cutover.** Documented in migration header and in `REBUILD_MIGRATION_MANIFEST.md` §5 Forward Flag 19.

### Added from P3-1 retrospective (users table column drops)

The rebuilt `users` table drops 29 columns from production (54 → 25 columns per the CREATE TABLE block in `2026_04_21_rebuild_identity_tenancy.sql` §2 — NOT "54 → 21" as earlier revisions of this checklist stated; the P1 §3.1 design was revised to add `signup_status` and the 4 Receipt Parser §7 auto-assign columns, yielding 25). Post-P1A-4 the target count is 26 (adds `auth_user_id`). Most drops are non-impacting (columns with zero production data, legacy experimental fields), but the following need spot-check review before cutover to identify any live dependencies:

```sql
-- Dashboard token — Q6 resolution said surface is orphaned, but verify no active rows:
SELECT COUNT(*) FROM public.users WHERE dashboard_token IS NOT NULL;
-- Expected: 0 (if non-zero, investigate which users still have active dashboard sessions)

-- Subscription tier — if non-null, these users' plan info needs migration to plan_key:
SELECT DISTINCT subscription_tier, paid_tier, COUNT(*)
FROM public.users
WHERE subscription_tier IS NOT NULL OR paid_tier IS NOT NULL
GROUP BY subscription_tier, paid_tier;
-- Plan: map these values to rebuild's plan_key before cutover; document mapping in remediation

-- Onboarding state — users mid-onboarding lose state at cutover:
SELECT COUNT(*) FROM public.users WHERE onboarding_in_progress = true;
-- If non-zero, either complete their onboarding pre-cutover or document state-loss acceptance

-- Trial windows — Beta users with active trials:
SELECT COUNT(*), MIN(trial_end), MAX(trial_end)
FROM public.users
WHERE trial_end IS NOT NULL AND trial_end > now();
-- If non-zero, decide whether trial state migrates or resets
```

Reference: P3-1 migration `2026_04_21_rebuild_identity_tenancy.sql` for the full column drop list.

Resolution: either migrate non-null values to rebuild-compatible columns, or document explicit acceptance of data loss in remediation notes.

### Added from P1A-4 (portal↔WhatsApp linkage)

The P1A-4 amendment adds `public.users.auth_user_id uuid NULL REFERENCES auth.users(id)` to preserve portal↔WhatsApp pairings across cutover. Without backfill, every currently-paired owner becomes un-paired and whoami returns `hasWhatsApp: false` for all users post-cutover (employees will need to re-pair regardless — see footnote).

**Required pre-cutover backfill:** run `migrations/phase5/phase5_backfill_users_auth_user_id.sql` (authored during P1A-4) against production **after** all rebuild migrations apply, **before** opening portal + WhatsApp writes.

**Spot-check queries to validate pre-backfill inventory (dev DB values from P1A-4 V8, 2026-04-23):**

```sql
-- Owner-role public.users rows expected to become paired:
SELECT COUNT(*) FROM public.users WHERE role = 'owner';
-- Dev observed (pre-rebuild shape, users has role nullable): use chiefos_tenants as proxy:
SELECT COUNT(*) FROM public.chiefos_tenants;                              -- Dev V8: 5

-- Currently-paired owners (via chiefos_portal_users):
SELECT COUNT(*) FROM public.chiefos_portal_users WHERE role = 'owner';    -- Dev V8: 2

-- DISCARDed table row counts:
SELECT COUNT(*) FROM public.chiefos_link_codes WHERE used_at IS NOT NULL; -- Dev V8: 27 used of 28 total — BUT NO phone_digits column; not usable as backfill source
SELECT COUNT(*) FROM public.chiefos_identity_map;                         -- Dev V8: 0
SELECT COUNT(*) FROM public.chiefos_user_identities;                      -- Dev V8: 0
SELECT COUNT(*) FROM public.chiefos_phone_active_tenant;                  -- Dev V8: 0
```

**Post-backfill verification:**

```sql
SELECT COUNT(*) FROM public.users WHERE auth_user_id IS NOT NULL;
SELECT COUNT(*) FROM public.users WHERE role = 'owner' AND auth_user_id IS NULL;
-- Near-zero expected; nonzero = owners who never set up portal access (valid state).
```

**Employee re-pairing footnote:** V8 introspection found the chain `chiefos_link_codes → chiefos_identity_map → chiefos_user_identities` cannot be used to recover employee phone↔auth linkage on the pre-rebuild dev DB (link_codes lacks a phone_digits column; the two downstream tables are empty). Non-owner employees will need to re-pair via the R2.5 OTP flow (`portal_phone_link_otp`) after cutover. If production inspection finds different data (e.g., populated `chiefos_identity_map`), reopen Step 3 / Step 3b of the backfill script (templates left in commented form).

**Reference:** migration `2026_04_23_amendment_p1a4_users_auth_user_id.sql`; backfill script `migrations/phase5/phase5_backfill_users_auth_user_id.sql`.

### Added from R3a (chiefos_tenant_actors disposition + crew cluster blocker)

**`chiefos_tenant_actors` table:** DISCARD per FOUNDATION_P1_SCHEMA_DESIGN.md §6.1 row 2780 / Decision 12. Not in rebuild migration manifest — vanishes at cutover.

Dev-DB state (R3a V4 introspection, 2026-04-24):

```sql
SELECT COUNT(*) FROM public.chiefos_tenant_actors;                         -- Dev V4: 1 row
SELECT tenant_id, actor_id, role FROM public.chiefos_tenant_actors;
-- Dev V4 row: tenant_id=86907c28-a9ea-4318-819d-5a012192119b (Mission Exteriors),
--             actor_id=f2a98850-34be-4cc1-b02e-b85d77352f0a (orphan — no auth.users match),
--             role='employee'
-- Classification: likely test data. No FK references from other tables (verified).
-- R3a deferred deletion (no founder sign-off in session); approve before cutover.
```

**Pre-cutover action:**

```sql
-- Approve deletion of the 1 test-data row (documented above):
DELETE FROM public.chiefos_tenant_actors
 WHERE actor_id = 'f2a98850-34be-4cc1-b02e-b85d77352f0a';
-- Re-verify:
SELECT COUNT(*) FROM public.chiefos_tenant_actors;  -- expected: 0
```

If production has nonzero `chiefos_tenant_actors` rows at pre-cutover, each must be reviewed individually: migrate to `public.users` (ingestion actor) or `chiefos_portal_users` (portal actor), or classify as test-data and delete.

**Table drop:** occurs implicitly when the rebuild schema applies (the rebuild DOES NOT recreate this table).

### Added from R3a (crew cluster Phase 5 blocker)

**R3b is a hard pre-cutover blocker.** The crew cluster (`services/crewControl.js`, `routes/crewControl.js`, `routes/crewReview.js`) writes to columns and tables that do not exist in the rebuild schema:

- Columns removed in §3.11: `log_no`, `type`, `content_text`, `structured`, `status`, `source_msg_id`, `created_by_actor_id`, `reviewer_actor_id`, `reviewed_by_actor_id`, `reviewed_at`, `updated_at` on `chiefos_activity_logs`.
- Tables removed: `chiefos_activity_log_events`, `chiefos_tenant_actors`, `chiefos_actor_identities`, `chiefos_tenant_actor_profiles`.

R3a investigated migration and halted per directive §10.4 (no spec `action_kind` mapping for `needs_clarification`) + §10.8 (crew submission model is a stateful inbox; §3.11 is a pure audit log — semantic redesign not plumbing).

**R3b founder-decisions required before migration:**
1. Dedicated crew-submission table vs. pending-state on canonical tables (`time_entries_v2.submission_status`, `tasks.submission_status`)?
2. `needs_clarification` mapping to 9-action_kind enum (or amendment to add a 10th value)?
3. `log_no` derivation strategy (query-time window function vs. payload field vs. external counter)?

**Pre-cutover verification:**

```sql
-- Crew cluster files must not emit against DISCARDed shape at cutover.
-- If any of these still exist in live routes at cutover, DO NOT apply rebuild:
-- 1. Grep services/ routes/ for `chiefos_activity_log_events`:
--    Expected post-R3b: zero hits outside documentation/comments.
-- 2. Grep services/ routes/ for direct INSERT/UPDATE on chiefos_activity_logs:
--    Expected post-R3b: zero hits outside services/activityLog.js.
-- 3. Grep services/ routes/ for chiefos_tenant_actors:
--    Expected post-R3b: zero hits in live code.
```

**Reference:** `docs/_archive/sessions/SESSION_R3A_REMEDIATION_REPORT.md` §1 (scope analysis), §3 (R3b open questions).

### Added from P1A-5 (submission_status on crew-writable canonical tables)

P1A-5 amendment (`migrations/2026_04_24_amendment_p1a5_submission_status.sql`) adds `submission_status text NOT NULL DEFAULT 'approved'` + 4-value CHECK + partial pending-review index to `time_entries_v2` and `tasks`. Resolves R3a §F2 / Option B (crew submissions land in pending state on canonical rows; no separate inbox table needed). Unblocks R3b crew-cluster call-site migration.

**No pre-cutover backfill required.** Column add with NOT NULL DEFAULT fills any existing rows with `'approved'` automatically — preserves pre-rebuild semantics where every row was implicitly approved (no review workflow existed). Crew-submitted rows will be explicitly set to `'pending_review'` by R3b call-site code at INSERT time, post-cutover.

**Distinct from `transactions.submission_status`** which has its own 3-value enum (`'confirmed','pending_review','voided'` — financial-row lifecycle, predates P1A-5). Both share `'pending_review'` value because the inbox query predicate is the same shape across clusters; otherwise different domains, intentionally separate enums.

**Verification post-cutover:**

```sql
-- Confirm column + CHECK + index present:
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema='public'
   AND table_name IN ('time_entries_v2','tasks')
   AND column_name = 'submission_status';
-- Expected: 2 rows, both data_type=text, is_nullable=NO, default='approved'::text

SELECT conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conname IN ('time_entries_v2_submission_status_chk','tasks_submission_status_chk');
-- Expected: 2 rows, both CHECK with 4-value enum

SELECT indexname FROM pg_indexes
 WHERE tablename IN ('time_entries_v2','tasks')
   AND indexname IN ('time_entries_v2_pending_review_idx','tasks_pending_review_idx');
-- Expected: 2 rows.
```

**Blocks rollback ordering:** if R3b ships and is later rolled back, P1A-5 rollback must wait — R3b call sites depend on the column existing. See `REBUILD_MIGRATION_MANIFEST.md` §6 rollbacks list.

### Added from P1A-6 (chiefos_portal_users status soft-delete column)

P1A-6 amendment (`migrations/2026_04_25_amendment_p1a6_portal_users_status.sql`) adds `status text NOT NULL DEFAULT 'active'` + 2-value CHECK + partial active-membership index to `chiefos_portal_users`. Unblocks F1 crewAdmin rewrite which requires a soft-delete target without losing public.users financial attribution.

**No pre-cutover backfill required.** Column add with NOT NULL DEFAULT fills any existing rows with `'active'` automatically — preserves pre-rebuild semantics where every portal member was implicitly active. F1's deactivate route will explicitly transition rows to `'deactivated'` post-cutover.

**Why portal_users not public.users:** portal access (the thing being revoked) is gated by `chiefos_portal_users` membership; `chiefos_role_audit.target_portal_user_id` already FKs to portal_users; `public.users` carries financial attribution that must survive deactivation intact (per CLAUDE.md "never lose financial history"). WhatsApp-only employees (no portal_users row) are out of scope for portal-side deactivation.

**Verification post-cutover:**

```sql
-- Confirm column + CHECK + index present:
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema='public'
   AND table_name='chiefos_portal_users'
   AND column_name='status';
-- Expected: 1 row, data_type=text, is_nullable=NO, default='active'::text

SELECT conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conname='chiefos_portal_users_status_check';
-- Expected: 1 row, CHECK ((status IN ('active','deactivated')))

SELECT indexname FROM pg_indexes
 WHERE tablename='chiefos_portal_users'
   AND indexname='chiefos_portal_users_active_idx';
-- Expected: 1 row.

-- Confirm all existing rows defaulted to 'active':
SELECT status, COUNT(*) FROM public.chiefos_portal_users GROUP BY status;
-- Expected: only 'active' rows; zero 'deactivated' (those come post-F1).
```

**Blocks rollback ordering:** if F1 ships and is later rolled back, P1A-6 rollback must wait — F1 crewAdmin code depends on the column existing.

### Added from R4b (RAG schema compliance)

R4b audit (`docs/_archive/sessions/SESSION_R4B_REMEDIATION_REPORT.md`) confirmed RAG live code (`services/tools/rag.js`, `services/rag_search.js`, `services/ragTerms.js`, `scripts/ingestRAG.js`) is schema-compatible with P1A-3 amendments. No call-site migration required at cutover.

**Pre-cutover verifications:**

```sql
-- rag_terms: rebuild adds UNIQUE on lower(term). Pre-cutover, verify no dupes:
SELECT lower(term), COUNT(*)
  FROM public.rag_terms
 GROUP BY 1
HAVING COUNT(*) > 1;
-- Expected: zero rows. Any dupes must be resolved before cutover (rebuild
-- migration's UNIQUE INDEX rag_terms_lower_term_unique would reject them).

-- docs + doc_chunks: column shape preserved across rebuild. No data migration
-- needed. If production has rows, they transfer transparently.
SELECT (SELECT COUNT(*) FROM public.docs)             AS docs_count,
       (SELECT COUNT(*) FROM public.doc_chunks)       AS chunks_count,
       (SELECT COUNT(*) FROM public.rag_terms)        AS terms_count,
       (SELECT COUNT(*) FROM public.tenant_knowledge) AS knowledge_count;
-- Record baseline counts for post-cutover verification.

-- tenant_knowledge: see Forward Flag 19 entry above for owner_id uuid → text
-- drift correction. No data migration needed (production row count = 0
-- pre-rebuild because text-digit-string INSERTs always rejected against uuid).
```

**F2 status (resolved in R4b-finalize, 2026-04-24):** `services/tools/rag.js` `searchRag` / `answer` / `ragTool.__handler` now fail-closed throw `TENANT_BOUNDARY_MISSING` if `ownerId` is missing. The previous `'GLOBAL'` default could leak cross-tenant data because the module's own `pg.Pool` connects as superuser (bypasses RLS). Tool spec parameter description updated to reflect agent-loop injection. Caller audit verified the only live importer (`services/agent/index.js:526`) injects `args.owner_id` from request context — fail-closed throw never fires under normal operation.

**Post-Beta RAG hardening deferred items (not cutover blockers, tracked in R4b §11):**
- F1: `services/learning.js` dead surface (zero live importers; references non-existent `user_profiles`)
- F2 option (b): consolidate `services/tools/rag.js` to use shared `services/postgres.js` query helper instead of own pg.Pool (would eliminate RLS-bypass concern entirely)
- F3: RAG dual-implementation (vector `services/tools/rag.js` + tsvector `services/rag_search.js`) — consolidate post-Beta
- F4: `scripts/ingestRAG.js` re-run safety (`ON CONFLICT (id)` never fires; P1A-3 `lower(term)` UNIQUE will reject re-run duplicates)

---

## 5. General cutover checks (pre-Phase-5 run)

- [ ] `npm run schema:drift-check:baseline` → captures the pre-cutover drift snapshot
- [ ] Run all per-section spot-check queries in §1 above, resolve any CHECK violations
- [ ] Verify all extensions in §2 are installed
- [ ] Run orphan-row queries in §3, resolve any dangling FKs
- [ ] Review data migration recipes in §4 and plan their execution order
- [ ] Verify `rag_terms` has no `lower(term)` duplicates per §4 "Added from R4b" subsection. Rebuild migration adds UNIQUE; duplicates would reject.
- [ ] Run P1A-4 pairing-data backfill (`migrations/phase5/phase5_backfill_users_auth_user_id.sql`) AFTER all rebuild migrations apply, BEFORE opening portal + WhatsApp writes. Verify post-backfill counts per §4 "Added from P1A-4" subsection.
- [ ] Resolve `chiefos_tenant_actors` row-level state per §4 "Added from R3a" subsection (DELETE approved test-data rows).
- [ ] **R3b complete (crew cluster rewrite)** — crew code must not emit against DISCARDed schema shape at cutover. See §4 "Added from R3a (crew cluster Phase 5 blocker)".
- [ ] Full database backup before applying any rebuild migration
- [ ] Disable WhatsApp + portal writes during the apply window (cutover is a maintenance event)

---

## 6. Transport / apply-mechanism notes

Supabase MCP `apply_migration` strips trailing newlines and may normalize whitespace runs inside DDL column-alignment padding. SQL is PG-functionally equivalent to source (verified via byte-level spot-check across 5 representative files post-V2 apply, 2026-04-26). Schema state confirmed intact. Future V2 retries should expect ~1-byte divergences per migration; this is not drift, it's transport normalization.

---

**This document grows as sessions surface new pre-cutover concerns. Keep it current.**
