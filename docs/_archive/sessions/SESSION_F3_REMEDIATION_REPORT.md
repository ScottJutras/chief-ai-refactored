# SESSION F3 — Sister Timeclock Endpoints submission_status Pattern

**Date:** 2026-04-24 | **Scope:** mechanical pattern application | **Closes:** R3b F3 follow-up

## Outcome
Of the 4 sister endpoints, 2 needed the pattern (INSERT to a P1A-5 table); 2 are pattern-N/A by structure. Applied R3b's `target.is_self && target.role === 'employee' → 'pending_review'` derivation to `/segment` (start branch INSERT) and `/tasks` (POST INSERT). Fixed pre-existing tenant_id absence on `/tasks` INSERT incidentally (rebuild requires NOT NULL, would fail at cutover otherwise).

## V1-V3 outcomes
- **V1**: R3b's pattern at `routes/timeclock.js:402-409` — single derivation expression based on `target.is_self && target.role === 'employee'`, threaded into INSERT param list. Mechanical, no conditional surprises.
- **V2**: 4 sisters classified:
  - `/clock-out`: UPDATE-only, no INSERT — **pattern N/A** (per directive STOP-as-expected example).
  - `/segment`: INSERT in `start` branch only (`stop` branch is UPDATE) — applied to start path.
  - `/mileage`: INSERTs to `mileage_logs` — **NOT in P1A-5 scope** (P1A-5 covered only `time_entries_v2` + `tasks`). Skipped, flagged.
  - `/tasks` (POST): INSERTs to `tasks` — applied. Pre-existing missing `tenant_id` in INSERT also added (rebuild NOT NULL).
- **V3**: None of the sisters emit via `emitActivityLog` today — they use the legacy `logTimeEntry()` dual-write helper exclusively. Same pattern as `/clock-in` pre-R3b. No regression vs R3a/R3b — not a bug introduced by F3, just a known gap. Not in F3 scope to add.

## Per-endpoint before/after

| Endpoint | INSERT? | Action |
|---|---|---|
| `/clock-out` (line 453) | UPDATE only | **Pattern N/A** — submission_status inherited from /clock-in row |
| `/segment` start (line 603) | INSERT to time_entries_v2 | **Applied** — added `submission_status` derived + threaded |
| `/segment` stop (line 617) | UPDATE only | **Pattern N/A** — modifies existing row |
| `/mileage` (line 742) | INSERT to mileage_logs | **Skipped** — table not in P1A-5 (flagged §F3.1) |
| `/tasks` POST (line 838) | INSERT to tasks | **Applied** — added `submission_status` + `tenant_id` (was missing) |
| `/tasks/:id` PATCH (line 867) | UPDATE only | Out of scope (state lifecycle, not submission) |

## Files changed

| File | Change |
|---|---|
| `routes/timeclock.js` | 2 INSERT sites updated: `/segment` start (lines 603-613) + `/tasks` POST (lines 838-855). Net: +18 / –6 lines across the file. |

## Regression outcomes
1. ✅ `node --check routes/timeclock.js` clean.
2. ✅ Both modified INSERT sites include `submission_status` column + bound parameter (verified by grep — 3 INSERT statements now reference submission_status: clock-in from R3b, segment start, tasks POST).
3. ✅ Each new derivation matches R3b literally: `target.is_self && String(target.role || "").toLowerCase() === "employee" ? "pending_review" : "approved"`. Same 4-line block at 3 sites.
4. ✅ Tenant boundary present on every modified INSERT — both `/segment` and `/tasks` INSERTs lead with `(tenant_id, owner_id, ...)`. The `/tasks` INSERT added tenant_id to the column list and bound params (was missing pre-F3 — would have rejected at cutover against rebuild's NOT NULL).

End-to-end testing deferred to Phase 5 cutover.

## Flagged items
- **§F3.1** — `/api/timeclock/mileage` writes to `mileage_logs` which is NOT in P1A-5's scope (P1A-5 added submission_status only to `time_entries_v2` + `tasks`). If crew-mileage-review is a desired Beta feature, two paths: (a) extend P1A-5 with a P1A-5b amendment adding submission_status to `mileage_logs`, then re-run F3 logic on this endpoint; or (b) accept that all crew-submitted mileage is auto-approved (current behavior continues post-cutover; no review workflow for trips). Recommend (b) for Beta — mileage entries are typically post-fact reimbursement claims, not a workflow needing pre-approval. Founder decision.
- **§F3.2** — `/tasks` POST INSERT had pre-existing missing `tenant_id` (would have failed at cutover against rebuild's `tenant_id NOT NULL`). Fixed incidentally as part of F3 since the regression check requires tenant boundary on every modified INSERT. Worth noting: other rebuild-required columns (e.g., `created_by_portal_user_id`/`created_by_user_id` per migration §3.12) are still not populated by this INSERT — those are a separate cleanup, not in F3 scope.
- **§F3.3** — None of the sister endpoints (or `/clock-in` from R3b) emit via `emitActivityLog`. They write to a legacy log via `logTimeEntry()` only. Not a regression — pre-existing gap. Worth a follow-up to thread canonical emission, but well outside F3 scope.

## Next blocks on
Phase 5 cutover (end-to-end multi-handler testing) + founder decision on §F3.1 (mileage review workflow). F3 closes the second of three remaining R3b follow-ups; F1 (crewAdmin actor-cluster cleanup) remains.
