# Session P1A-4 — Amendment Migration Report

**Date:** 2026-04-23
**Scope:** Add `public.users.auth_user_id` reverse pointer (uuid, nullable, FK to `auth.users`) for portal↔WhatsApp linkage. Author (not execute) Phase 5 pairing-data backfill SQL.
**Prerequisite:** R1 + R2 complete (see `SESSION_R2_REMEDIATION_REPORT.md` §9 F1 + F2 for flagged items this amendment addresses).
**Outcome:** 1 forward migration, 1 rollback, 1 Phase 5 backfill script, 4 document updates, 0 code changes, 7 regression checks passed.

---

## 1. Verification Outcomes (V1–V8)

Run against dev DB `xnmsjdummnnistzcxrtj` (single Chief project per `list_projects`).

| Check | Expected | Observed | Result |
|---|---|---|---|
| V1 — column absent | 0 rows | 0 rows | PASS |
| V2 — `REFERENCES auth.users(id)` idiom established | ≥3 matches | 3 (chiefos_portal_users:236, chiefos_legal_acceptances:309, portal_phone_link_otp:383) | PASS — note deviation: P1A-4 uses `ON DELETE SET NULL` whereas all 3 existing FKs use `ON DELETE CASCADE`. Rationale documented in migration IDIOM NOTE (preserve financial history). |
| V3 — `portal_phone_link_otp` shape | 5 cols in order: auth_user_id, phone_digits, otp_hash, expires_at, created_at | Exact match | PASS |
| V4 — `public.users` constraints (target state) | PK on user_id, users_owner_user_unique, 4 CHECKs (post-rebuild); no auth_user_id references | Verified against migration file `2026_04_21_rebuild_identity_tenancy.sql` §2. Dev DB currently holds pre-rebuild shape, so introspection against dev not authoritative — migration file is. | PASS (no collision with new `users_auth_user_id_unique`) |
| V5 — RLS policies on `public.users` | `users_tenant_select` + `users_tenant_update_owner`, gated on `chiefos_portal_users` membership | Verified against migration file lines 204–223. The new column inherits existing tenant boundary; no new policies needed. | PASS |
| V6 — filename collision | no `2026_04_23_*` in `migrations/` | none | PASS |
| V7 — column count reconciliation | A (25) / B (25→21 via later drops) / C (other → STOP) | **Observed 54 (pre-rebuild).** New **scenario D**: dev DB not yet migrated; rebuild schema lands at Phase 5 cutover. Migration-file comment at line 132 of rebuild_identity_tenancy says "54 → 25". Checklist §4 said "54 → 21" — **stale**, now corrected (scenario A, adjusted wording). | INFO — checklist corrected |
| V8 — DISCARDed pairing-data row counts + shapes | Various | **SURPRISE** (see §7 F1): `chiefos_link_codes` 28 rows / 27 used but **no `phone_digits` column** (cols: id, tenant_id, portal_user_id, code, expires_at, used_at, created_at). `chiefos_identity_map` 0 rows. `chiefos_user_identities` 0 rows. `chiefos_phone_active_tenant` 0 rows. `chiefos_portal_users` 3 rows (2 owners). `users` 605 rows. `chiefos_tenants` 5 rows. | FLAGGED — Step 2 of directive's backfill template not authorable (no phone column on link_codes); employee re-pairing must come from R2.5 OTP flow |

**No STOP conditions triggered.** V7 scenario D is distinct from scenario C ("unknown state") — the pre-rebuild state is well-understood, and the authoring target is the post-rebuild migration file, so authoring proceeds.

---

## 2. Migration Inventory

| File | Lines | Purpose |
|---|---|---|
| `migrations/2026_04_23_amendment_p1a4_users_auth_user_id.sql` | 102 | Forward: adds column + partial index + UNIQUE + COMMENT |
| `migrations/rollbacks/2026_04_23_amendment_p1a4_users_auth_user_id_rollback.sql` | 53 | Rollback: drop constraint → drop index → drop column |
| `migrations/phase5/phase5_backfill_users_auth_user_id.sql` | 161 | Phase 5 data migration: Step 1 implicit owner linkage (authored); Steps 2/3/3b left commented with explanation |

All three files follow existing project conventions:
- Rollbacks go to `migrations/rollbacks/` subdirectory (not `migrations/` root — the directive suggestion to colocate would have violated the established pattern).
- Phase 5 scripts are new territory — created `migrations/phase5/` subdirectory.

---

## 3. Apply-Order Position

Labeled `17k` in `REBUILD_MIGRATION_MANIFEST.md`, filename-sorted between `2026_04_22_amendment_trigger_extensions.sql` (17j) and any future entries. Because the migration only depends on `public.users` (step 1), it can run any time after step 1 — the 17k label groups it semantically with the other Phase 1 amendments. Documented in manifest entry.

No dependency on `rebuild_triggers`, `rebuild_functions`, or `rebuild_views` — the new column has no trigger binding, no function dependency, and no view consumer in this amendment (R2.5 will add application-code consumers).

---

## 4. Doc Updates

| File | Section | Change |
|---|---|---|
| `REBUILD_MIGRATION_MANIFEST.md` | §3 apply-order list | Added `17k. amendment_p1a4_users_auth_user_id` entry after `24. remediation_drop_users_dashboard_token` line. Includes rationale for `ON DELETE SET NULL` deviation and R2.5 rollback dependency. |
| `PHASE_4_5_DECISIONS_AND_HANDOFF.md` | §5 Remediation Sequence | Renumbered to 11 items; R1+R2 marked COMPLETE; P1A-4 inserted as item 3 (COMPLETE); R2.5 inserted as item 4 (NEXT). R3–R9 renumbered 5–11. |
| | §11.1 Migration Inventory | 30 → 31; amendment session count 3 → 4; added P1A-4 row; added "Paired Phase 5 data migrations" subsection referencing backfill script. |
| | §11.5 Cross-Session Discipline Record | Expanded from 5 → 7 catches; added R2 resolver simplification (entry 6) and P1A-4 V8/V7 findings (entry 7). |
| | §11.8 | Renamed from "R1 Remediation Entry Point" to "Remediation Status + R2.5 Entry Point"; marked R1/R2/P1A-4 complete; listed R2.5 scope + prerequisites. |
| `PHASE_5_PRE_CUTOVER_CHECKLIST.md` | §4 "Added from P3-1 retrospective" heading paragraph | Fixed stale wording: "54 → 21 columns" → "54 → 25 columns per CREATE TABLE block" + post-P1A-4 note (target 26). |
| | §4 new subsection "Added from P1A-4 (portal↔WhatsApp linkage)" | Spot-check queries with dev V8 values inline; pre-/post-backfill verification queries; employee re-pairing footnote pointing at R2.5. |
| | §5 General cutover checks | Added backfill-run checkbox between "Review data migration recipes in §4" and "Full database backup". |

---

## 5. Backfill SQL Authoring

V8 drove the authoring decisions:

- **Step 1 (implicit owner linkage)** — AUTHORED. Primary path. Uses `chiefos_portal_users role='owner' → chiefos_tenants.owner_id → public.users.user_id`. Idempotency guard on `u.auth_user_id IS NULL`.
- **Step 2 (`chiefos_link_codes`)** — NOT AUTHORED. The directive template referenced `lc.phone_digits` + `lc.used_by_auth_uid`; V8 confirmed neither exists on this table (only `portal_user_id + tenant_id + code + used_at`). No phone digit-string is recoverable from link_codes alone. Block left in the file with a NOT APPLICABLE comment explaining why, so a future operator inspecting production at Phase 5 time has the context to reopen it if production's schema differs.
- **Step 3 (`chiefos_identity_map`)** — NOT AUTHORED. 0 rows in dev. Template left commented (with a correction to the directive's JOIN shape: `chiefos_identity_map` has no `auth_user_id` column, so the join must pass through `chiefos_user_identities` to recover auth linkage). Ready to uncomment if production differs.
- **Step 3b (`chiefos_user_identities`)** — NOT AUTHORED. 0 rows. Template left commented as a simpler standalone fallback path.
- **Step 4 (verification)** — AUTHORED. Reports paired_total / owner_total / unpaired_owners counts via RAISE NOTICE.

The directive's original placeholder column names (`lc.used_by_auth_uid`, `im.auth_user_id`) were corrected to real column shapes where applicable.

---

## 6. Regression Check Outcomes

All 7 checks PASS, executed against dev DB in an isolated `p1a4_test` schema (cleaned up on completion):

1. **Syntactic apply** — column / index / constraint created as expected. FK resolves to `auth.users(id)` with `ON DELETE SET NULL`.
2. **Idempotency** — re-running the three DO blocks yields 1/1/1 counts, no errors.
3. **Rollback** — constraint / index / column dropped cleanly.
4. **Re-apply after rollback** — 1/1/1 counts, cycle complete.
5. **Backfill dry-run** — seeded (tenant, owner portal_user, users row) → Step 1 updated 1 row. paired=1, unpaired=0.
6. **Backfill idempotency** — re-running Step 1 updated 0 rows (`WHERE auth_user_id IS NULL` guard effective).
7. **UNIQUE constraint enforcement** — attempt to insert a second `users` row with a duplicate `auth_user_id` raised `unique_violation` as expected.

RLS regression: existing `users_tenant_select` / `users_tenant_update_owner` policies are `tenant_id`-gated. Since the new column is scoped under an existing `tenant_id` boundary, no policy changes required. Not separately tested against a live `authenticated` role in dev because dev's `public.users` is pre-rebuild shape; the rebuild-schema policies only take effect post-cutover.

Blast-radius grep: new column name `auth_user_id` appears in:
- 3 new files authored this session (expected).
- 4 doc files updated this session (expected).
- 10 pre-existing migrations / reports referencing unchanged `auth_user_id` on `chiefos_legal_acceptances`, `portal_phone_link_otp`, or `intake_item_reviews.reviewed_by_auth_user_id` (all unchanged).
- 8 chiefos-site route files using the term in pre-existing contexts (supplier portal auth, intake flows) — unchanged.

No unexpected application-code references. R2.5 will introduce those explicitly.

---

## 7. R2.5 Entry Point

R2.5 application-code work can proceed immediately. Concrete call sites confirmed:

| File | Current behavior | R2.5 target |
|---|---|---|
| `routes/webhook.js` → `redeemLinkCodeToTenant()` | Upserts `public.users` on link-code redemption (R2-era). Still references DISCARDed `chiefos_link_codes`. | Rewrite to consume `portal_phone_link_otp` + write `users.auth_user_id = auth_uid`. Delete `chiefos_link_codes` reference. |
| `chiefos-site/app/app/welcome/WelcomeClient.tsx`, `chiefos-site/app/app/connect-whatsapp/page.tsx` | 3 hits on `chiefos_link_codes` (INSERT + SELECT). | Replace with `portal_phone_link_otp` INSERT (service_role) to generate the OTP. |
| `routes/portal.js` `whoami` | Checks owner role only for `hasWhatsApp`. | Replace with `SELECT 1 FROM public.users WHERE auth_user_id = req.portalUserId`. |
| `middleware/requirePortalUser.js` | Does not expose a pairing signal. | Add `req.isPhonePaired` boolean + exported `requirePhonePaired` middleware helper. |

Prerequisites all met: column exists, UNIQUE + index enforce correctness, backfill script ready, manifest + handoff + checklist updated.

---

## 8. Flagged Items for Founder Review

### F1 — V8 SURPRISE: `chiefos_link_codes` has no `phone_digits` column

The directive's §4 backfill template assumed `chiefos_link_codes` carried `(phone_digits, tenant_id, used_by_auth_uid)`. V8 showed the real shape: `(id, tenant_id, portal_user_id, code, expires_at, used_at, created_at)`. The phone digit-string is stored **elsewhere** — historically in `chiefos_identity_map` (the INSERT was in `routes/webhook.js:358` pre-R2). But that table has **0 rows** on dev, and so does `chiefos_user_identities`. The 27 used link-code redemptions are orphaned from any recoverable phone linkage.

**Implication:** non-owner employees who paired pre-rebuild will need to re-pair post-cutover via the R2.5 OTP flow. Only tenant owners can be backfilled (via implicit linkage). This is acceptable for the beta scale (3 auth users, 2 owners on dev). Production inspection at Phase 5 time may reveal different row counts — the backfill script's commented Steps 3/3b templates are ready to uncomment if populated.

**Question for founder:** is this acceptable, or should we consider a middleware-side auto-pair prompt for employees whose WhatsApp phone lands without a known `auth_user_id` mapping? R2.5 scope could bundle this.

### F2 — `ON DELETE SET NULL` deviates from existing FK idiom

The 3 pre-existing `auth.users(id)` FKs in the rebuild all use `ON DELETE CASCADE`. P1A-4 uses `ON DELETE SET NULL`. Rationale: cascading would orphan ingestion rows and break composite FK chains on `transactions.owner_id` / `time_entries_v2.owner_id`. The deviation is intentional and documented in the migration's IDIOM NOTE; no founder action needed unless this reasoning is questioned.

### F3 — V7 4th scenario (pre-rebuild state)

Directive V7 assumed post-rebuild state. Dev DB is pre-rebuild (54 cols). The literal interpretation (scenario C: "unknown") would have halted the session, but the state is well-understood — dev DB has simply not had the rebuild applied yet. Treating this as scenario D (pre-rebuild, authoring target is migration file) was the pragmatic call. **Recommendation:** future directives that include V7-style counts should explicitly allow for "pre-rebuild on dev" as a valid starting state.

### F4 — Checklist §4 stale wording fixed

`PHASE_5_PRE_CUTOVER_CHECKLIST.md` §4 said "54 → 21 columns per P1 §3.1". The rebuild migration file's top comment says "54 → 25 cols". Fixed the checklist to "54 → 25" with a note on the P1 §3.1 revision history (signup_status + 4 auto-assign columns). Post-P1A-4 target is 26.

### F5 — Rollbacks directory path differs from directive

The directive said rollback file path should be `migrations/2026_04_23_amendment_p1a4_users_auth_user_id_rollback.sql`. Repo convention is `migrations/rollbacks/...`. Used the repo convention. Worth noting so the next directive author knows the rollback subdirectory exists.

---

## 9. Open Questions

1. **F1 — employee re-pairing at scale.** If production has more than a trivial number of currently-paired employees (>10), the "everyone must re-pair" answer may be painful for beta users. Options:
   - Accept as-is (R2.5 OTP flow is the same for new and re-pairing users).
   - Surface a per-employee auto-prompt in whoami when `auth_user_id IS NULL`.
   - Investigate whether the production `chiefos_identity_map` has rows (dev may have been reset); if yes, uncomment backfill Step 3.

2. **Column-count discipline.** Should subsequent amendments tracking column deltas on `public.users` be catalogued in a single authoritative place (manifest or checklist)? Currently tracked across three documents with now-consistent wording.

No open questions block R2.5 from starting.

---

## 10. Completion Criteria (per Directive §9)

- [x] V1–V8 verification outcomes documented with V7 scenario (D — pre-rebuild) and V8 row counts + column shapes
- [x] Migration inventory: 3 files with line counts
- [x] Apply-order position confirmed (17k)
- [x] Doc updates: manifest + handoff §5/§11 + checklist §4/§5 — with locations
- [x] Backfill SQL: V8-driven decisions made (Step 1 authored; Steps 2/3/3b left commented with explanations)
- [x] Regression checks: 7/7 passed
- [x] R2.5 entry point confirmed with specific call sites
- [x] Flagged items listed for founder review (F1–F5)
- [x] Open questions listed (2 items; neither blocks R2.5)
- [x] No code changes to application layer
- [x] No commits

---

P1A-4 amendment complete. `public.users.auth_user_id` column + constraints + Phase 5 backfill authored and regression-tested. Ready for R2.5 (call-site migration + OTP flow).
