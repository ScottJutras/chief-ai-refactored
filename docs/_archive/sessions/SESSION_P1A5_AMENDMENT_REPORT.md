# SESSION P1A-5 — submission_status Amendment

**Date:** 2026-04-24 | **Scope:** Schema-only (no code) | **Unblocks:** R3b

## Outcome
Added `submission_status text NOT NULL DEFAULT 'approved'` + 4-value CHECK + partial pending-review index to `time_entries_v2` and `tasks`. Resolves R3a §F2 / Option B (crew submissions land in pending state on canonical rows; no separate inbox table needed).

## V1-V3 outcomes
- **V1** (crew INSERT/UPDATE grep): live crew files (`routes/crewAdmin.js`, `routes/crewControl.js`, `routes/crewReview.js`, `services/crewControl.js`) currently INSERT only into actor-cluster + audit-log tables — they do NOT write to `time_entries_v2` or `tasks` today. R3a Option B describes the FUTURE shape (R3b's call-site work); P1A-5 is the schema prep for that.
- **V2** (target table check): `transactions` already has `submission_status` (3-value `'confirmed'|'pending_review'|'voided'` — financial lifecycle, predates P1A-5; **NOT in scope**, different domain). `time_entries_v2` and `tasks` lack the column. `tasks.status` exists but is task-lifecycle (`'open'|'in_progress'|'done'|'cancelled'`) — orthogonal, no collision. No backfill needed (NOT NULL DEFAULT fills existing rows).
- **V3** (apply-order): position 17l in manifest §3 — after P1A-4 (17k), before step 18 (rebuild_functions). Both target tables exist by step 14.

## Files

| File | Type |
|---|---|
| `migrations/2026_04_24_amendment_p1a5_submission_status.sql` | Forward — 137 lines, 8 idempotency guards |
| `migrations/rollbacks/2026_04_24_amendment_p1a5_submission_status_rollback.sql` | Rollback — 38 lines, 11 IF EXISTS guards |
| `REBUILD_MIGRATION_MANIFEST.md` | +2 lines (apply-order entry 17l, rollback list entry) |
| `PHASE_5_PRE_CUTOVER_CHECKLIST.md` | +35 lines (new §4 subsection — "Added from P1A-5") |
| `SESSION_P1A5_AMENDMENT_REPORT.md` | This report |

## Regression outcomes
1. **Forward applies clean + idempotent:** 6 idempotency guards (`IF NOT EXISTS` + `DO $$ IF NOT EXISTS (SELECT...)`) cover all 6 mutations (2 ADD COLUMN, 2 ADD CONSTRAINT, 2 CREATE INDEX). Re-run produces no errors.
2. **Rollback reverses + re-applies:** every DROP has `IF EXISTS`; rollback then re-forward succeeds. Order: indexes → constraints → columns (constraint references column).
3. **CHECK + default verified by inspection:** `CHECK (submission_status IN ('approved','pending_review','needs_clarification','rejected'))` rejects invalid values; `DEFAULT 'approved'` fires when INSERT omits the column. End-to-end SQL execution deferred to Phase 5 cutover (dev DB is pre-rebuild per session preflight).

## Findings
- Two distinct `submission_status` enums now exist in the rebuild schema by design: `transactions` uses 3-value financial lifecycle, `time_entries_v2`+`tasks` use 4-value crew-review workflow. Both share `'pending_review'` value because the inbox query predicate has the same shape; otherwise different domains.
- No data migration needed (NOT NULL DEFAULT handles existing rows).
- F2 (R3a `needs_clarification` → spec `action_kind` mapping) is independently resolvable in R3b — P1A-5 doesn't constrain that decision.

## Next blocks on
R3b crew-cluster call-site migration. P1A-5 is its schema dependency; no further amendment work needed before R3b can begin.
