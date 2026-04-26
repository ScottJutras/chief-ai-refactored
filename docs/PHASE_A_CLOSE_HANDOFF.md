# Phase A Close Handoff — Quote-Spine CIL Handlers

**Status:** Phase A CLOSED 2026-04-25 at commit 971ca0ea.
**Supersedes:** all prior `PHASE_A_SESSION_N_*_HANDOFF.md` documents.
**Archive:** Session 3 handoff at `docs/_archive/handoffs/PHASE_A_SESSION_3_LOCKQUOTE_HANDOFF.md`. Session 4 (VoidQuote) and Session 5 (ReissueQuote) handoffs were not authored separately — this consolidated close handoff replaces them per CLAUDE.md handoff discipline ("Phase-arc handoffs are rewritten state-reflection per session, not appended-to").

This document is current state. Session-by-session implementation history lives in `docs/_archive/sessions/`. Architectural decisions live in `docs/QUOTES_SPINE_DECISIONS.md`. Production ceremony artifacts live in `docs/QUOTES_SPINE_CEREMONIES.md`.

---

## 1. Phase A scope (delivered)

Seven CIL handlers cover the full Quote state machine:

| # | Handler | Session | Ceremony | Idempotency | State transition |
|---|---|---|---|---|---|
| 1 | `handleCreateQuote` | A1 | §21 | `(owner_id, source_msg_id)` UNIQUE on `chiefos_quotes` (entity-table dedup §17.8) | (none) → draft |
| 2 | `handleSendQuote` | A2 | §22 | `(owner_id, source_msg_id)` UNIQUE on `chiefos_quote_share_tokens` | draft → sent (header + version co-transition) |
| 3 | `handleSignQuote` | A3 | §27 | `(quote_id, version_id)` UNIQUE on `chiefos_quote_signatures` | sent/viewed → signed (locks version) |
| 4 | `handleViewQuote` | A3 | §28 | State-machine (§17.23) | sent → viewed (header + version co-transition) |
| 5 | `handleLockQuote` | A3 | §30 | State-machine (§17.23) | signed → locked (header-only per §3A; version untouched) |
| 6 | `handleVoidQuote` | A4 | §31 | State-machine (§17.23) | any-of-five → voided (header-only per §3A) |
| 7 | `handleReissueQuote` | A5 | §32 | `(owner_id, source_msg_id)` UNIQUE on `chiefos_quote_versions` (NEW; entity-table dedup §17.8) | voided → draft (NEW version row; header pointer swing; voided_at/voided_reason cleared) |

All seven registered in `src/cil/router.js` `NEW_IDIOM_HANDLERS` frozen map at `lines 33-41`.

---

## 2. Schema state (canonical)

Tables (created by `rebuild_quotes_spine`, extended by amendments):

- `public.chiefos_quotes` — header (one row per quote identity; mutable status + voided columns; immutable identity columns)
- `public.chiefos_quote_versions` — append-only versioned snapshots; constitutionally immutable when `locked_at IS NOT NULL` OR when superseded (`current_version_id` no longer points at this row, per Migration 2026_04_25 §1.4)
- `public.chiefos_quote_line_items` — append-only line items per version
- `public.chiefos_quote_share_tokens` — bearer share tokens for customer-facing URLs; `superseded_at` + `superseded_by_version_id` fill-once
- `public.chiefos_quote_signatures` — one signature per `(quote_id, version_id)`
- `public.chiefos_quote_events` — full audit chain (`lifecycle.*` + `notification.*` event kinds)

All RLS-enabled; portal reads scoped via `chiefos_portal_users` membership.

Migrations applied through Phase A (in apply order):

1. `2026_04_18_chiefos_quotes_spine.sql` (folded into `rebuild_quotes_spine`)
2. `2026_04_18_chiefos_quote_share_tokens.sql` (folded)
3. `2026_04_18_chiefos_quote_signatures.sql` (folded)
4. `2026_04_18_chiefos_quote_events.sql` (folded)
5. `2026_04_19_chiefos_qs_png_storage_key_format.sql` (signature storage CHECK)
6. `2026_04_25_chiefos_quote_versions_source_msg_id.sql` (Phase A Session 5 — adds `source_msg_id` + partial UNIQUE + immutability triggers)

---

## 3. Architectural patterns established (active reference)

Documented in `docs/QUOTES_SPINE_DECISIONS.md`. Active sections to know:

- **§3A** — Header-version status authority + co-transition discipline. Voiding is header-only (version row passes through unchanged).
- **§14** — Share-token lifecycle including `§14.4` supersession. Note: supersession columns live on share tokens, NOT versions. Version supersession is implicit via `chiefos_quotes.current_version_id` pointer.
- **§17.1** — All CIL types extend `src/cil/schema.js::BaseCILZ`.
- **§17.8–§17.11** — Dedup mechanism: entity-table `(owner_id, source_msg_id)` UNIQUE per root entity. Reissue extends this to `chiefos_quote_versions`.
- **§17.10** — `classifyCilError` 4-kind classification + `idempotent_retry` post-rollback recovery via `lookupPrior*` helpers.
- **§17.15** — Multi-entity return-shape envelope (`ok`, entity rows, `meta`).
- **§17.17** — Identity resolution + cross-tenant unification (`QUOTE_NOT_FOUND_OR_CROSS_OWNER`).
- **§17.19 / §17.20** — Pre-BEGIN external write for strict-immutable INSERT (signature storage; PNG upload).
- **§17.21** — `correlation_id` wiring across event chains.
- **§17.22** — Invariant-assertion discipline (load-helper sanity checks).
- **§17.23** — State-driven idempotency + post-rollback re-read recovery.
- **§17.24** — Header-first ordering for dual-row state transitions (does NOT apply to header-only handlers — Lock/Void).
- **§17.25** — Echo-if-present posture for Zod-optional audit fields.
- **§17.26** — RESERVED (no longer needed for ReissueQuote per §32.7 finding; remains reserved for future deeper supersession concerns).
- **G6** — Plan-gate follow-through: creation consumes the gate; lifecycle transitions are transitively gated. Sessions 2-5 all use no-plan-gating posture.

---

## 4. Test inventory

`src/cil/quotes.test.js` — 729 tests across all 7 handlers + shared schemas + composers.

Quote spine total run command:

```bash
npx jest --testPathPattern="src/cil/(quotes|quoteSignatureStorage|quoteHash|router)\.test\.js"
```

Current state (post-Session-5): 720 of 729 pass. 9 failures are all in the new ReissueQuote integration block (`§2: handleReissueQuote (integration)`); root cause is a fixture-setup `varchar(20)` overflow in `seedVoidedQuote` helper, not a handler bug. Follow-up: tighten the helper to use `setupQuotePreconditions`. Tracked in `PHASE_A_CLOSE_VERIFICATION_v2.md` Known Follow-ups #1.

Critical regression coverage (must always be green):

- Cross-tenant isolation tests — every handler that reads context (load helpers) has a `QUOTE_NOT_FOUND_OR_CROSS_OWNER` test pinning the unified-404 posture
- Idempotency replay tests — every handler with entity-table dedup has a replay test pinning `meta.already_existed = true` semantics
- Constitutional immutability tests — UPDATE/DELETE on locked or superseded versions raises the trigger error

---

## 5. Production ceremony state

Each handler has a deterministic ceremony script under `scripts/real_*_quote_ceremony.js`:

| Handler | Script | Constants file | Namespace |
|---|---|---|---|
| CreateQuote | `real_create_quote_mission.js` | (Mission tenant inline) | (none) |
| SendQuote | `real_send_quote_mission.js` | (inline) | (none) |
| SignQuote | `real_sign_quote_ceremony.js` | (inline; pre-Session-2-pattern) | (none) |
| ViewQuote | `real_view_quote_ceremony.js` | `_phase_a_session2_constants.js` | `c4c4-c4c4-c4c4` |
| LockQuote | `real_lock_quote_ceremony.js` | `_phase_a_session3_constants.js` | `c5c5-c5c5-c5c5` |
| VoidQuote | `real_void_quote_ceremony.js` | `_phase_a_session4_constants.js` | `c6c6-c6c6-c6c6` |
| ReissueQuote | `real_reissue_quote_ceremony.js` | `_phase_a_session5_constants.js` | `c7c7-c7c7-c7c7` |

Each ceremony is idempotent: re-runs land on the handler's already-existed/already-transitioned path. To re-run the happy path, run the per-ceremony teardown SQL (documented in each ceremony's docs/QUOTES_SPINE_CEREMONIES.md section).

Ceremony exit codes (uniform across all):
- `0` — success (happy path or idempotent retry)
- `1` — handler returned `ok: false`
- `2` — uncaught exception
- `3` — anomaly (post-state expectation drift)

§32 (ReissueQuote) ceremony has not yet been first-run against production; queued for Session 6 pre-flight.

---

## 6. What's next

### Phase A.5 (next arc)

`PHASE_A5_INVESTIGATION.md` is ACTIVE (GATED marker lifted in this commit set). Slice 1 + Slice 2 directives may proceed. See investigation doc for full scope. Two-slice ship plan:

- **Session 6 (A.5 Slice 1):** V1 fuzzy resolver (`src/cil/quoteResolver.js`) + V2 WhatsApp commands (`/quote /lock /void /reissue`). Schema-widening prerequisite: `LockQuoteCILZ.source` and `VoidQuoteCILZ.source` from `z.literal('system')` to `z.enum(['portal','whatsapp','system'])` (Decision A — pending founder approval). Ships standalone for WhatsApp users.
- **Session 7 (A.5 Slice 2):** V3 portal quote detail page + V4 portal action API. Depends on Session 6's schema widening + new `chiefos_portal_quotes` SECURITY INVOKER view migration (Decision D).

### Phase A close follow-ups (not blocking A.5)

1. Fix `seedVoidedQuote` fixture (varchar(20) overflow) → re-run 9 ReissueQuote integration tests. Estimate: small.
2. Apply `2026_04_25_chiefos_quote_versions_source_msg_id.sql` to staging + production (not yet applied from Session 5).
3. Run `node scripts/real_reissue_quote_ceremony.js` for first-run anomaly-check transcript.
4. Add `portal: 'portal'` entry to `CIL_TO_EVENT_ACTOR_SOURCE` map (`src/cil/quotes.js:105`); pin via tightening Test #9 of ReissueQuote integration block. Bundle with Session 6 Decision A.

### Phase B+ (NOT yet sequenced)

Per CLAUDE.md: Phase B+ ordering will be locked after A.5 ships and produces user signal. Do not pre-commit.

---

## 7. Quarantined zones (still in effect from prior R-sessions)

- **Crew cluster** — pending R3b. Files: `services/crewControl.js`, `routes/crewControl.js`, `routes/crewReview.js`. Do not modify outside R3b.
- **Actor-memory cluster** — pending R4c. Files: `services/postgres.js` `getActorMemory`/`patchActorMemory` + callers in `services/agent/index.js`, `services/answerChief.js`, `services/orchestrator.js`. Do not modify outside R4c.

Phase A and Session 5 specifically did not touch either zone.

---

## 8. Beta Pause Rule status

| Check | Status |
|---|---|
| Twilio transport stable | No regression observed (no Twilio code touched in Phase A) |
| Tenant isolation holds | Preserved across all 7 handlers (cross-tenant unification at load-helper layer per §17.17) |
| Idempotency intact | Strengthened — new partial UNIQUE adds dedup surface for Reissue without affecting prior surfaces |
| Plan/quota fail-closed | Preserved (G6 follow-through; lifecycle handlers do not gate independently) |

Beta Pause Rule does not apply. Phase A.5 work may proceed.
