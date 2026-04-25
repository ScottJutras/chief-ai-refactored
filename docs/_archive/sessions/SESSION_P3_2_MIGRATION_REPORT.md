# Session P3-2a — Migration Authorship Report

**Date:** 2026-04-21
**Scope delivered:** clean-sheet migrations for Jobs spine, Time spine, and Intake (non-receipt) pipeline.
**Scope deferred to Session P3-2b:** Quotes spine re-author (6-migrations → 1), Receipt pipeline re-author.
**Authority:** Session P3-2 work order; `FOUNDATION_P1_SCHEMA_DESIGN.md` §3.3–§3.4 and §3.6; Step 7 split-authorization clause.

---

## 1. Split Decision and Rationale

Per Step 7 of the work order: "if quality at risk, split the session."

**Decision taken:** deliver clean-sheet migrations in P3-2a; defer the two mechanical re-authors to P3-2b.

**Rationale:**
- The Quotes spine re-author is ~800 lines of byte-identical transcription folded from 6 source migrations (quotes_spine, quote_events, quote_share_tokens, quote_signatures, qs_png_storage_key_format, tenant_counters_generalize). It requires extreme care: composite FKs move from post-create ALTER backfills to CREATE-time definitions, the `chiefos_qe_kind_enum` merges its expanded form (with `integrity.name_mismatch_signed`) into its initial creation rather than a DROP+CREATE, trigger bodies must remain verbatim, and the storage-key regex at `src/cil/quoteSignatureStorage.test.js:1830` must be coordinated with the new filename.
- The Receipt pipeline re-author is smaller (3 tables) but introduces a deliberate Principle 11 composite-FK upgrade on `parse_corrections → parse_jobs`. That's a founder-review item, not a mechanical transcription.
- The clean-sheet work (Jobs, Time, Intake) is independent of those re-authors: nothing in Sessions P3-2b depends on Jobs/Time/Intake being delivered together with it.
- Split cost: one extra session boundary.
- Split benefit: Jobs/Time/Intake receive uncompromised attention; Quotes re-author receives uncompromised attention in its own session; byte-fidelity is preserved where it matters most.

**Outcome:** P3-2a ships 3 fresh migrations + 3 rollbacks. P3-2b will ship 2 re-authors + 2 rollbacks + 1 test-path update.

---

## 2. Migrations Produced

### 2.1 `migrations/2026_04_21_rebuild_jobs_spine.sql`

Tables created:
- `chiefos_tenant_counters` — per-(tenant, counter_kind) shared counter table; created here in final generalized form (rather than activity-log-specific first then ALTERed). Used by Jobs (`counter_kind='job'`), Quotes (`human_id` allocation), and any future numbered surface.
- `jobs` — integer PK retained (design §3.3); `tenant_id uuid NOT NULL` added (critical delta vs. current); `status` CHECK tightened to `('active','on_hold','completed','cancelled')`; composite UNIQUE `(id, tenant_id, owner_id)` for Principle 11.
- `job_phases` — composite FK to `jobs`; full RLS policies (SELECT/INSERT/UPDATE/DELETE).
- `job_photos` — specialized per Decision 4 (kept distinct from `media_assets`); unique on `(tenant_id, storage_path)`.
- `job_photo_shares` — customer-facing share tokens; 30-day default expiry; `expires_at > created_at` check.

FKs wired (deferred from Session P3-1):
- `transactions.job_id → jobs(id)` ON DELETE SET NULL
- `users.auto_assign_active_job_id → jobs(id)` ON DELETE SET NULL

### 2.2 `migrations/2026_04_21_rebuild_time_spine.sql`

Tables created:
- `time_entries_v2` — canonical timeclock entries; `tenant_id uuid NOT NULL` (was nullable); `job_id integer` (resolves uuid→integer drift per §3.4); integrity-chain columns (`record_hash`, `previous_hash`, `hash_version`, `hash_input_snapshot`) present but unpopulated until Session P3-4 trigger; composite UNIQUE `(id, tenant_id, owner_id)`; tightened `kind` CHECK enum of 9 values; `end_at_utc > start_at_utc` CHECK; self-FK on `parent_id` for shift assembly; simple FK on `job_id → jobs(id)` ON DELETE SET NULL.
- `timeclock_prompts` — 24h TTL; backend-only (service_role); no portal surface.
- `timeclock_repair_prompts` — owner-initiated repairs; RLS enabled (was disabled); FKs on `entry_id` and `shift_id` to `time_entries_v2(id)` per §3.4.
- `timesheet_locks` — `tenant_id NOT NULL` added; unique on `(tenant_id, employee_name, start_date, end_date)`; status CHECK `('locked','pending','released')`.
- `states` — per-user WhatsApp conversational state; `owner_id` and `tenant_id` added (design §3.4 dual-boundary coherence); `tenant_id` intentionally nullable pending onboarding tightening (see Forward Flag 7 in manifest).
- `locks` — duplicate `lock_key` column dropped per §3.4; only `key` retained; backend-only.
- `employees` — `tenant_id NOT NULL` added; `role` CHECK added `('owner','employee','contractor','board_member')`; partial unique index on `(owner_id, lower(name))` WHERE active.
- `employer_policies` — `owner_id` type fixed `uuid → text` (was a drift bug per §3.4); `tenant_id NOT NULL` added; overtime_mode CHECK `('weekly','daily','none')`.

### 2.3 `migrations/2026_04_21_rebuild_intake_pipeline.sql`

Tables created:
- `intake_batches` — `kind` CHECK drops `'receipt_image_batch'` (enforces receipt pipeline separation per §3.6); composite UNIQUE `(id, tenant_id, owner_id)`.
- `intake_items` — `kind` CHECK drops `'receipt_image'`; composite FK `(batch_id, tenant_id, owner_id) → intake_batches`; composite self-FK `(duplicate_of_item_id, tenant_id, owner_id) → intake_items`; simple FK `job_int_id → jobs(id)`; composite UNIQUE `(id, tenant_id, owner_id)`; idempotency via `(owner_id, source_msg_id)` and `(owner_id, dedupe_hash)` partial uniques.
- `intake_item_drafts` — composite FK to `intake_items`; **new `draft_kind` column** added with source-extraction enum `('voice_transcript','pdf_text','email_body_parse','email_lead_extract')` per §3.6; retained `draft_type` for business-intent classification; explicit design note in comment block confirming "Receipt OCR does not flow through this table."
- `intake_item_reviews` — composite FK to `intake_items`; **actor FK redesigned** from `reviewed_by_auth_user_id` to `reviewed_by_portal_user_id` targeting `chiefos_portal_users(user_id)` per Decision 12; `correlation_id uuid NOT NULL DEFAULT gen_random_uuid()` per §17.21; action CHECK `('confirm','reject','edit_confirm','reopen')` per design; append-only enforcement = INSERT-only GRANT to `authenticated` in this migration + BEFORE UPDATE/DELETE trigger deferred to Session P3-4.

---

## 3. Rollbacks Produced

All in `migrations/rollbacks/`:

- `2026_04_21_rebuild_jobs_spine_rollback.sql` — drops tables in reverse dep order; **also drops the deferred FKs** (`transactions_job_fk`, `users_auto_assign_active_job_fk`) so the tables survive without dangling references; drops `chiefos_tenant_counters` last (shared infra — noted in file header that it may fail if counter rows exist from another spine).
- `2026_04_21_rebuild_time_spine_rollback.sql` — drops all 8 tables in reverse dep order; idempotent (`IF EXISTS` everywhere).
- `2026_04_21_rebuild_intake_pipeline_rollback.sql` — drops all 4 tables in reverse dep order; idempotent.

All rollbacks use explicit `DROP POLICY` / `DROP INDEX` calls before `DROP TABLE` (auditable) — matches Session P3-1 style.

---

## 4. Manifest Updates

`REBUILD_MIGRATION_MANIFEST.md` updated:
- Session history note added (P3-1, P3-2a delivered; P3-2b pending).
- Apply-order list renumbered: steps 1–6 now delivered; steps 7 (quotes_spine) and 8 (receipt_pipeline) shown as DEFERRED to P3-2b; step 9 (quota_architecture) carries the unchanged KEEP migration; step numbering downstream unchanged.
- Apply-order notes added specific to P3-2a: counter creation, FK wiring, kind/draft_kind semantics.
- Dependency Map expanded to show all P3-2a tables.
- Forward Flags updated: flags 1 and 2 now describe the P3-2b deferred work explicitly; flags 3, 4, 5, 6 cover P3-4 follow-ups; flags 7, 8 are new P3-2a posture notes.
- Rollback Posture section lists all rollbacks in place after P3-2a plus the recommended reverse apply order.

---

## 5. Flagged Items for Founder Review

1. **time_entries_v2 per-employee RLS policy** (design §3.4 calls for board-reads-all / employees-read-own-only) — currently standard tenant-membership SELECT. Tightening requires a WA-user_id ↔ portal-auth-user_id mapping column. **Recommend: defer to P3-4** after a brief onboarding-path audit to confirm where the mapping should land.

2. **states.tenant_id nullable** — design specifies NOT NULL but existing pre-tenant state rows exist. **Recommend: keep nullable through P3-4; promote to NOT NULL after onboarding tightening.**

3. **intake_item_drafts has BOTH `draft_kind` and `draft_type`** — the design doc introduces `draft_kind` with a source-extraction enum; the current schema has only `draft_type` with a business-intent enum. P3-2a kept both (interpreted as additive per the distinct enum semantics). **Request founder confirmation:** is two-column retention correct, or was the design intent a rename?

4. **Receipt pipeline composite-FK upgrade** (Principle 11) on `parse_corrections.parse_job_id → parse_jobs` — not yet done. **Decision deferred to P3-2b** (work order's receipt re-author scope).

5. **chiefos_tenant_counters created by P3-2a jobs-spine migration** — shared infrastructure lives at the Jobs spine file rather than a standalone infrastructure migration. This is deliberate because counters are first-needed by Jobs, and design §3.3 groups them with Jobs. P3-2b Quotes re-author MUST NOT recreate this table; it consumes the existing one. **Noted as Forward Flag 1 in the manifest.**

6. **Rollback ordering when `chiefos_tenant_counters` has rows from multiple spines**: if Quotes spine is applied (future P3-2b) and then the jobs_spine_rollback is run, the DROP of `chiefos_tenant_counters` will fail if quote-counter rows exist. **Acceptable risk** — rollbacks are for clean-state recovery, not partial teardown. Documented in the rollback file header.

---

## 6. Readiness for Session P3-2b

**Blocked on:** nothing. All P3-2a deliverables are idempotent and can be applied or un-applied independently.

**Session P3-2b inputs already in place:**
- `chiefos_tenant_counters` table will exist (created by `rebuild_jobs_spine`); the Quotes re-author must consume it, not recreate.
- `jobs.id` has the composite UNIQUE `(id, tenant_id, owner_id)` — Quotes tables that reference jobs use composite FKs.
- `chiefos_portal_users` is stable from P3-1.

**Session P3-2b work items:**
1. Author `migrations/2026_04_21_rebuild_quotes_spine.sql` folding 6 source migrations. Byte-identical §27 patterns. Kind enum includes all 20 values at CREATE. Preflight blocks become no-ops (tables don't pre-exist on cold start).
2. Author `migrations/2026_04_21_rebuild_receipt_pipeline.sql` re-authoring parse_jobs/vendor_aliases/parse_corrections. Decide composite-FK upgrade on `parse_corrections`.
3. Author matching rollbacks.
4. Update `src/cil/quoteSignatureStorage.test.js:1830` if the storage-key migration filename reference needs to change (or preserve the old migration filename as an artifact if the test path stays pinned).
5. Update manifest: move step 7 and step 8 from DEFERRED to DELIVERED.
6. Produce `SESSION_P3_2B_MIGRATION_REPORT.md`.

---

## 7. File Inventory

**Created in P3-2a:**
```
migrations/2026_04_21_rebuild_jobs_spine.sql
migrations/2026_04_21_rebuild_time_spine.sql
migrations/2026_04_21_rebuild_intake_pipeline.sql
migrations/rollbacks/2026_04_21_rebuild_jobs_spine_rollback.sql
migrations/rollbacks/2026_04_21_rebuild_time_spine_rollback.sql
migrations/rollbacks/2026_04_21_rebuild_intake_pipeline_rollback.sql
SESSION_P3_2_MIGRATION_REPORT.md
```

**Updated in P3-2a:**
```
REBUILD_MIGRATION_MANIFEST.md
```

**Untouched, pre-existing:**
- All Session P3-1 migrations and rollbacks.
- All archived pre-rebuild migrations.
- `FOUNDATION_P1_SCHEMA_DESIGN.md` (read-only input).

---

**End of Session P3-2a report.** Next session: P3-2b, Quotes + Receipt re-authors.
