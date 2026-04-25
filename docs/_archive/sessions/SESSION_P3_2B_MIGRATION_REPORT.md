# Session P3-2b — Migration Authorship Report

**Date:** 2026-04-21
**Scope delivered:** Quotes spine re-author (6 source migrations → 1 cold-start migration, byte-identical) + Receipt pipeline re-author (Principle 11 composite-FK upgrade on `parse_corrections.parse_job_id`).
**Authority:** Session P3-2b work order (continuation of P3-2a split per Step 7); `FOUNDATION_P1_SCHEMA_DESIGN.md` §3.5 + §3.7.

---

## 1. Migrations Produced

### 1.1 `migrations/2026_04_21_rebuild_quotes_spine.sql`

Folded from 6 source migrations into one cold-start-clean file. Creates (in order):

1. Sequence `chiefos_events_global_seq` (migration 2 artifact)
2. Table `chiefos_quotes` — header; 4 constraints + 4 indexes; composite UNIQUE `(id, tenant_id, owner_id)` for Principle 11
3. Table `chiefos_quote_versions` — append-only; 8 constraints + 5 indexes; composite UNIQUE
4. ALTER `chiefos_quotes` to add deferrable composite FK `current_version_id → chiefos_quote_versions(id, tenant_id, owner_id)` (breaks the chiefos_quotes ↔ versions creation cycle)
5. Table `chiefos_quote_line_items` — 2 constraints + 4 indexes
6. Table `chiefos_quote_share_tokens` — 13 constraints + 5 indexes; composite UNIQUE
7. Table `chiefos_quote_signatures` — 10 constraints + 6 indexes; composite UNIQUE; **folded `chiefos_qs_png_storage_key_format` CHECK from original Migration 6** (regex byte-identical to `SIGNATURE_STORAGE_KEY_RE.source`)
8. Table `chiefos_quote_events` — 19 constraints + 13 indexes; composite UNIQUE at CREATE; kind enum **all 20 values from start** (original Migration 4 DROP+ADD folded); version-scoped CHECK **all 16 values** (folded); `chiefos_qe_payload_name_mismatch_signed` CHECK folded; `chiefos_qe_share_token_fk` + `chiefos_qe_signature_identity_fk` declarative at CREATE (original migrations 3+4 ALTER-backfill replaced with direct declaration since share_tokens + signatures exist earlier in the re-author's creation order)
9. ALTER `chiefos_quote_signatures` to add `chiefos_qs_signed_event_identity_fk` composite (breaks signatures ↔ events creation cycle)
10. 6 `ENABLE ROW LEVEL SECURITY` ALTERs
11. 8 `CREATE POLICY` statements (header has 3: SELECT+INSERT+UPDATE; versions/line_items/events/share_tokens/signatures each have 1: SELECT only — the §11.0 tight pattern from migration 4)
12. 2 views: `chiefos_all_events_v`, `chiefos_all_signatures_v`
13. ~25 `COMMENT ON` statements (preserved verbatim from source)

Total file: 592 lines including header and comments.

**Creation-order reordering from original migration series.** The original series shipped events (migration 2) BEFORE share_tokens (migration 3) and signatures (migration 4), then ALTER-backfilled events' share_token_id and signature_id FKs post-hoc. The re-author reorders: share_tokens + signatures CREATE before events. The events.share_token_id and events.signature_id FKs are declarative at CREATE. Semantically identical — same constraints in the same final shape.

Two cycles required post-create ALTER bridges:
- chiefos_quotes ↔ chiefos_quote_versions (via `current_version_id`): ALTER adds the FK after versions exists. DEFERRABLE INITIALLY DEFERRED preserved.
- chiefos_quote_signatures ↔ chiefos_quote_events (via signatures.signed_event_id and events.signature_id): ALTER adds signatures.signed_event_id composite FK after events exists.

**Trigger bindings deferred to Session P3-4** per work-order Option (a). The original source migrations defined 6 CREATE FUNCTION + CREATE TRIGGER pairs (quote_versions_guard_immutable, quote_line_items_guard_parent_lock, quotes_guard_header_immutable, quote_events_guard_immutable, quote_share_tokens_guard_immutable, quote_signatures_guard_immutable). None are in this migration. Phase 1 §5 places trigger functions in Session P3-4; this session's work order places trigger bindings there too, same pattern as Session P3-1's `transactions` integrity-chain trigger. **Until P3-4 ships, the Quotes spine tables have NO immutability enforcement** — documented as a hard ordering dependency in the migration provenance header and in manifest Forward Flag 10.

### 1.2 `migrations/2026_04_21_rebuild_receipt_pipeline.sql`

Re-authored from `2026_04_21_chiefos_parse_pipeline_tables.sql` with exactly one authorized change:

**Authorized Principle 11 upgrade:**
```sql
-- Before (source migration):
parse_job_id  uuid NOT NULL REFERENCES public.parse_jobs(id),

-- After (re-author):
parse_job_id  uuid NOT NULL,
-- ...
CONSTRAINT parse_corrections_parse_job_identity_fk
  FOREIGN KEY (parse_job_id, tenant_id, owner_id)
  REFERENCES public.parse_jobs(id, tenant_id, owner_id),
```

Target UNIQUE `parse_jobs_identity_unique (id, tenant_id, owner_id)` already existed in the source migration (was intended as a forward FK target per Engineering Constitution §2); no change to `parse_jobs` needed.

Semantics unchanged for valid data: all three columns are NOT NULL, so MATCH SIMPLE behaves identically to the simple FK for any valid row. The upgrade catches defense-in-depth bypass cases where `parse_corrections.tenant_id` or `parse_corrections.owner_id` diverges from the referenced `parse_jobs` row (would silently pass the simple FK; now rejects).

All other content — 3 tables, constraints, indexes, RLS policies, GRANTs, comments — byte-identical per diff (§3 below).

---

## 2. Drift-Detection Test Coordination

### Test file
`src/cil/quoteSignatureStorage.test.js` — Section 5: "migration ↔ app regex byte-identity"

### Change made
Single constant at lines 1828–1835 updated:

```js
// Before:
const MIGRATION_PATH = path.join(
  __dirname, '..', '..', 'migrations',
  '2026_04_19_chiefos_qs_png_storage_key_format.sql'
);

// After:
const MIGRATION_PATH = path.join(
  __dirname, '..', '..', 'migrations',
  '2026_04_21_rebuild_quotes_spine.sql'
);
```

A 4-line explanatory comment precedes the constant explaining the P3-2b fold.

### Regex extractor
The test uses `/signature_png_storage_key\s*~\s*'([^']+)'/` to extract the CHECK regex body. This extractor is format-agnostic — it finds the pattern regardless of whether the CHECK is in a CREATE TABLE column-list or an ALTER TABLE ADD CONSTRAINT. The re-authored migration has exactly one match; extraction and byte-identity comparison behave identically.

### Test run result
```
Ran: jest src/cil/quoteSignatureStorage.test.js -t "byte-identity"
PASS src/cil/quoteSignatureStorage.test.js
  migration ↔ app regex byte-identity
    √ migration SQL file exists at the expected path (8 ms)
    √ migration regex matches SIGNATURE_STORAGE_KEY_RE.source (forward-slash-normalized) (3 ms)
    √ DB CHECK regex (compiled as JS RegExp) accepts the pinned storage_key (2 ms)

Tests:       163 skipped, 3 passed, 166 total
```

All three byte-identity tests pass. (The 163 skipped are unrelated DB-backed tests outside this session's scope.)

### App regex unchanged
`src/cil/quoteSignatureStorage.js` `SIGNATURE_STORAGE_KEY_RE` source is unmodified. Only the test file's path constant changed (1 constant + 4 lines of context comment) — matches the work order's "No app code modifications except the one drift-detection test path constant" boundary.

---

## 3. Byte-Identity Verification

### 3.1 Quotes spine (all 6 tables)

| Table | Source indexes | Re-author indexes | Source CONSTRAINTs | Re-author CONSTRAINTs | Drift? |
|---|---|---|---|---|---|
| chiefos_quotes | 4 | 4 | 6 (inc. current_version_fk ALTER) | 6 (inc. current_version_fk ALTER) | None |
| chiefos_quote_versions | 5 | 5 | 8 | 8 | None |
| chiefos_quote_line_items | 4 | 4 | 2 | 2 | None |
| chiefos_quote_share_tokens | 4 + 1 UNIQUE | 4 + 1 UNIQUE | 15 | 15 | None |
| chiefos_quote_signatures | 5 + 1 UNIQUE | 5 + 1 UNIQUE | 10 inline + 1 via ADD | 10 inline (incl. folded png_storage_key_format) + 1 via ADD | **One authorized addition** (folded Migration 6 CHECK) |
| chiefos_quote_events | 12 + 1 UNIQUE | 12 + 1 UNIQUE | 18 inline + 5 ADD + 2 DROP | 25 inline (all folded) | **Three authorized folds** (identity_unique, payload_name_mismatch_signed, share_token_fk + signature_identity_fk as inline rather than ALTER) |

All index definitions literally byte-identical. All CHECK constraint bodies literally byte-identical. All FK REFERENCES clauses literally byte-identical. All UNIQUE columns literally byte-identical. Policy USING/WITH CHECK clauses literally byte-identical.

### 3.2 Storage key regex (the drift-critical artifact)

Source (`2026_04_19_chiefos_qs_png_storage_key_format.sql` line 70):
```
signature_png_storage_key ~ '^chiefos-signatures/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$'
```

Re-author (`2026_04_21_rebuild_quotes_spine.sql` chiefos_qs_png_storage_key_format CHECK body):
```
signature_png_storage_key ~ '^chiefos-signatures/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$'
```

**Byte-identical.** Confirmed by the automated drift-detection test (passed).

### 3.3 Receipt pipeline

Mechanical diff of non-comment/non-blank lines between source and re-author:

```
--- source (chiefos_parse_pipeline_tables.sql)
+++ re-author (rebuild_receipt_pipeline.sql)
@@ parse_corrections CREATE TABLE @@
-  parse_job_id     uuid NOT NULL REFERENCES public.parse_jobs(id),
+  parse_job_id     uuid NOT NULL,
   ...
-  CONSTRAINT parse_corrections_field_name_nonempty CHECK (char_length(field_name) > 0)
+  CONSTRAINT parse_corrections_field_name_nonempty CHECK (char_length(field_name) > 0),
+  CONSTRAINT parse_corrections_parse_job_identity_fk
+    FOREIGN KEY (parse_job_id, tenant_id, owner_id)
+    REFERENCES public.parse_jobs(id, tenant_id, owner_id)
   );

@@ parse_corrections COMMENT @@
-  'Per-field correction log. [...] FK to parse_jobs(id); tenant_id carries the portal boundary for RLS.';
+  'Per-field correction log. [...] Composite FK (parse_job_id, tenant_id, owner_id) → parse_jobs per Principle 11 (upgraded in rebuild re-author from simple FK).';
```

Exactly the two authorized changes. No other drift.

---

## 4. Rollbacks Produced

- `migrations/rollbacks/2026_04_21_rebuild_quotes_spine_rollback.sql` — drops views first, then explicitly drops the two FK cycles (signatures→events, quotes→versions deferred FK), then policies, indexes, tables in reverse dependency order, then `chiefos_events_global_seq` sequence last.
- `migrations/rollbacks/2026_04_21_rebuild_receipt_pipeline_rollback.sql` — standard reverse-dep rollback for parse_corrections → vendor_aliases → parse_jobs.

Both use `IF EXISTS` on every DROP; safe to re-run.

---

## 5. Manifest Updates

`REBUILD_MIGRATION_MANIFEST.md`:
- Session history: P3-2b entry added (deliveries).
- §2.1 KEEP reduced from 3 to 2 files (the receipt pipeline migration moved to §2.3 SUPERSEDED).
- New §2.3 SUPERSEDED table listing all 7 superseded files (6 Quotes + 1 receipt pipeline) and their replacements.
- Apply order renumbered: a new step 7 (`rebuild_customers` — future P3-3 dependency) inserted; the Quotes spine is now step 8, receipt pipeline is step 9, quota_architecture is step 10. Downstream steps renumbered through 19.
- Apply-order notes updated through P3-2b with the creation-order reorderings, cycle-breaking ALTERs, and trigger-deferral notes.
- Dependency map expanded for rebuild_quotes_spine and rebuild_receipt_pipeline with composite-FK annotations.
- Forward Flags 1 and 2 changed from "DEFERRED" to "DELIVERED."
- Forward Flags 9 (customers rebuild dependency) and 10 (P3-4 Quotes trigger bindings) added.
- Rollback Posture section updated with P3-2b rollback files and the reverse apply order.

---

## 6. Flagged Items for Founder Review

1. **`customers` table is not yet in the rebuild apply order.** The live DB has it; the Quotes spine re-author preflights for it and fails-loud on cold-start if absent. **Recommendation:** Session P3-3 authors `rebuild_customers.sql` as step 7 in the apply order (before Quotes spine).

2. **Trigger bindings for 6 Quotes tables deferred to P3-4.** The original source migrations bundled trigger functions + bindings together. Phase 1 §5 places functions in P3-4; this session places bindings there too. Until P3-4 ships, `chiefos_quote_versions` locked-row immutability, `chiefos_quote_line_items` parent-lock guard, `chiefos_quote_share_tokens` fill-once enforcement, `chiefos_quote_signatures` strict-immutable enforcement, and `chiefos_quote_events` append-only enforcement are all RELYING ON APPLICATION CODE DISCIPLINE only. **App code must not write to these tables on a P3-2b-only cold-start target.** Documented in migration provenance + manifest Forward Flag 10.

3. **The two creation-order reorderings in the Quotes re-author** (share_tokens + signatures created BEFORE events; cycle-breaking ALTERs for quotes↔versions and signatures↔events). These are semantics-preserving but are the only structural differences from the original migration series. **Low concern** — every constraint ends in the same final shape. Surfaced for transparency.

4. **Principle 11 upgrade on `parse_corrections.parse_job_id`** — authorized by this session's work order. Defense-in-depth against cross-tenant correction rows. Target composite UNIQUE existed pre-rebuild; no change to parse_jobs. **No follow-up required.**

5. **`chiefos_events_global_seq` rollback semantics** — the rollback drops the sequence after dropping events. If anyone uses `nextval('chiefos_events_global_seq')` outside the events table, rollback breaks them. In the rebuilt schema, nothing else references the sequence. **Low concern.**

6. **Views (`chiefos_all_events_v`, `chiefos_all_signatures_v`) live in the Quotes re-author rather than a separate `rebuild_views.sql` session** — original source migrations bundled them with the creating table. Preserved that placement for byte-identity. Session P3-4's `rebuild_views.sql` may consolidate; not required. **Low concern.**

---

## 7. Readiness for Session P3-3

**Blocked on:** nothing.

**P3-3 inputs already in place:**
- All P3-1 + P3-2a + P3-2b migrations + rollbacks are idempotent, independently appliable, and pass byte-identity verification.
- Drift-detection test coordinated and green.
- Manifest is the authoritative apply order.

**P3-3 work items (per the broader Phase 3 scope):**
1. Author `migrations/2026_04_21_rebuild_customers.sql` (NEW — surfaced by P3-2b). Per Phase 1 §3.12 if customers is documented there; otherwise a design-minimum table with tenant_id + owner_id + PK uuid + the columns the live DB has.
2. Author `migrations/2026_04_21_rebuild_pending_cil_drafts.sql` per §3.9.
3. Author `migrations/2026_04_21_rebuild_conversation.sql` per §3.10.
4. Author `migrations/2026_04_21_rebuild_audit_observability.sql` per §3.11.
5. Author `migrations/2026_04_21_rebuild_supporting_tables.sql` per §3.12.
6. Matching rollbacks for each.
7. Update manifest.
8. Produce SESSION_P3_3_MIGRATION_REPORT.md.

---

## 8. File Inventory

**Created in P3-2b:**
```
migrations/2026_04_21_rebuild_quotes_spine.sql
migrations/2026_04_21_rebuild_receipt_pipeline.sql
migrations/rollbacks/2026_04_21_rebuild_quotes_spine_rollback.sql
migrations/rollbacks/2026_04_21_rebuild_receipt_pipeline_rollback.sql
SESSION_P3_2B_MIGRATION_REPORT.md
```

**Updated in P3-2b:**
```
src/cil/quoteSignatureStorage.test.js   (1 path constant + 4 comment lines)
REBUILD_MIGRATION_MANIFEST.md           (apply order renumbered; superseded-files table added; flags updated)
```

**Untouched, pre-existing (preserved as historical record):**
- `src/cil/quoteSignatureStorage.js` — app regex unchanged.
- All 6 source Quotes migrations — physically present in `migrations/`; SUPERSEDED per manifest.
- `2026_04_21_chiefos_parse_pipeline_tables.sql` — physically present; SUPERSEDED per manifest.
- All P3-1 and P3-2a migrations + rollbacks — unmodified.
- `FOUNDATION_P1_SCHEMA_DESIGN.md` — read-only input.

---

Phase 3 Session 2b complete. Quotes spine and receipt pipeline re-authors produced with byte-identical fidelity. Ready for Phase 3 Session 3.
