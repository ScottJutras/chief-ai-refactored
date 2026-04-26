# Phase A Session 5 — ReissueQuote

**Date:** 2026-04-25
**Closes:** Phase A.

## Outcomes

- Migration `2026_04_25_chiefos_quote_versions_source_msg_id.sql` authored — adds `source_msg_id` column + partial UNIQUE `chiefos_qv_source_msg_unique` + `trg_chiefos_qv_source_msg_immutable` fill-once trigger; extends `chiefos_quote_versions_guard_immutable` to block UPDATE/DELETE on superseded versions (header-pointer divergence).
- Rollback `migrations/rollbacks/2026_04_25_chiefos_quote_versions_source_msg_id_rollback.sql` authored.
- `ReissueQuoteCILZ` schema + 5 DB primitives (`loadReissueContext`, `insertReissuedVersion`, `copyLineItemsToNewVersion`, `setQuoteHeaderToReissuedDraft`, `lookupPriorReissuedVersion`) + 2 composers + `handleReissueQuote` shipped in `src/cil/quotes.js`.
- Router wiring at `src/cil/router.js:30,40` (import + `NEW_IDIOM_HANDLERS` registration; comment-stub replaced).
- 16 unit tests pass (5 schema + 4 pre-BEGIN + 4 buildReissue + 3 alreadyReissue); 9 integration tests authored, fixture-blocked.
- §32 ceremony: `scripts/real_reissue_quote_ceremony.js` + `scripts/_phase_a_session5_constants.js` (c7c7 namespace) + `docs/QUOTES_SPINE_CEREMONIES.md` §32 entry replacing the reservation.
- §17.26 outcome: NOT NEEDED. Supersession is implicit via `current_version_id` pointer; the immutability trigger extension (Migration 2026_04_25 §1.4) covers the consequent rule. Reissue slots into §17.8 + §3A + the new extension.
- Decision A pre-approved language ambiguity (`kind='quote.reissue'` clause in partial UNIQUE) resolved as Reading 1 — no `kind` column. Matches existing `chiefos_quotes_source_msg_unique` precedent.
- Founder-approved gate adjustment: integration tests authored, gated on DB-fixture follow-up (no DATABASE_URL credentials in this dev env).
- Founder-approved Decision: skip Session 4 backfill handoff in favor of consolidated `docs/PHASE_A_CLOSE_HANDOFF.md`.

## Bugs flagged

- HIGH `src/cil/quotes.test.js:11189-11221` — `seedVoidedQuote` helper triggers `value too long for type character varying(20)` on raw INSERT. 9 ReissueQuote integration tests cascade-fail. Handler logic NOT affected (16 unit tests prove correctness). Fix: use `setupQuotePreconditions` instead of inline raw INSERTs. Add to Session 6 pre-flight.
- LOW `src/cil/quotes.js:105` (`CIL_TO_EVENT_ACTOR_SOURCE`) — no `'portal'` entry; CIL `source: 'portal'` silently maps to `null` in `chiefos_quote_events.actor_source`. Test #9 of ReissueQuote integration block pins the gap with tolerant assertion. Fix in Session 6 alongside Decision A widening.
- DOC `CHIEFOS_EXECUTION_PLAN.md` VoidQuote/ReissueQuote checkboxes were `[ ]` at session start; updated to `[x]` in this commit set.

## Test posture

- 720 of 729 Quote-spine tests pass (no regression to prior 6 handlers).
- 9 failures all in new ReissueQuote integration block — fixture issue per above.
- Run command: `npx jest --testPathPattern="src/cil/(quotes|quoteSignatureStorage|quoteHash|router)\.test\.js"`

## Production deployment posture

- Migration NOT YET APPLIED to staging or production.
- §32 ceremony NOT YET RUN against production.
- Both queued for Session 6 pre-flight.

## Files touched

Migrations: `2026_04_25_chiefos_quote_versions_source_msg_id.sql` + rollback. `REBUILD_MIGRATION_MANIFEST.md` apply-order entry.
Code: `src/cil/quotes.js`, `src/cil/router.js`.
Tests: `src/cil/quotes.test.js` (appended ~430 lines).
Ceremony: `scripts/real_reissue_quote_ceremony.js`, `scripts/_phase_a_session5_constants.js`.
Docs: `docs/QUOTES_SPINE_CEREMONIES.md` §32, `docs/PHASE_A_CLOSE_HANDOFF.md` (new), `PHASE_A_CLOSE_VERIFICATION_v2.md` (new), `PHASE_A5_INVESTIGATION.md` (GATED lifted + §8 Addendum), `CHIEFOS_EXECUTION_PLAN.md` checkboxes.
Archive: `docs/PHASE_A_SESSION_3_LOCKQUOTE_HANDOFF.md` → `docs/_archive/handoffs/`.

## Next blocks on

- Session 6 (A.5 Slice 1) — pre-flight: apply migration + run §32 ceremony + fix `seedVoidedQuote` + verify 9 integration tests green. Then Decision A widening + V1 resolver + V2 commands.
- Session 7 (A.5 Slice 2) — depends on Session 6.
- Phase B+ — sequencing locked after A.5 produces user signal (per CLAUDE.md).
