# Phase A Session 2 — ViewQuote Handoff

**Last updated:** 2026-04-23 (Session 2 closeout)
**Purpose:** Single-document context transfer for any fresh Claude Code
session resuming Phase A. Paste-ready after `/clear`; no other context needed
except the referenced files.

This document is load-bearing. Read it **first** after `/clear`, before
proposing any work.

---

## 1. Role of this chat session

Fresh Claude Code instance working in the `Chief` repo
(`C:\Users\scott\Documents\Sherpa AI\Chief`), Windows 11 + bash.
Product: **ChiefOS** — AI-native WhatsApp-first operating system for small
businesses. One reasoning seat per business (the Owner via Chief); ingestion
identities scaled as "senses." See `CLAUDE.md` for full architecture rules.

**Active work:** Phase A of the Quote-spine build. Phase A is "five CIL
handlers that close the Quote state machine" — CreateQuote, SendQuote,
SignQuote, ViewQuote, then the three remaining (LockQuote, VoidQuote,
ReissueQuote). ViewQuote closed 2026-04-23; next session opens one of the
remaining three (likely LockQuote + VoidQuote combined).

**Partner role (user):** founder of ChiefOS. Reviews session proposals before
implementation; treats the two-chat split (Chief Claude Code = this repo;
Foundation Rebuild Claude Code = separate sessions) as an explicit
architectural boundary. Cross-session decisions land in this handoff's §6.

**Session-level discipline:** propose-before-implement on architectural
sessions (handler design, formalizations, ceremonies). Execute-directly on
mechanical work the founder has already scoped. Surface handoff gaps
rather than paper over them.

---

## 2. Current project state

**Branch:** `main`. 66 commits ahead of `origin/main` (nothing pushed; Phase
A development is local). Pre-push territory — `git commit --amend` safe
when needed.

**Test baseline:** 317/317 passing at `--testTimeout=30000`
(311 `src/cil/quotes.test.js` + 6 `__tests__/ceremony_shared.test.js`).
30-second timeout required to avoid pre-existing cold pg-pool-init flakes;
documented under §8.4 as a forward item.

**Stack:** Node 20, Express, Supabase Postgres + Storage. Deployed via
Vercel. CIL handlers live in `src/cil/`. Tests via jest.

**Recent Phase A commits** (chronological, oldest first):

| SHA | One-line |
|---|---|
| `fd49f702` | Foundation Rebuild §3.5: Quotes spine documented (Phase 1 Session 2) |
| `0beb6327` | Phase A Session 1: SendQuote `correlation_id` backfill |
| `367d4895` | ViewQuote Section 1: `ViewQuoteCILZ` schema + 36 tests |
| `58c5d30f` | ViewQuote Section 2: `VIEW_LOAD_COLUMNS` + `loadViewContext` + 17 tests |
| `92fef9e0` | `generateShareToken` short-output production bug fix |
| `056d61aa` | ViewQuote Section 3: `markQuoteViewed` + `emitLifecycleCustomerViewed` + 12 tests |
| `0dedea58` | Fix `markQuoteSent` version.status='draft' leak (§3.3 co-transition) |
| `20b015c4` | ViewQuote Section 4: handler + composers + 13 tests |
| `b81708d3` | ViewQuote Section 5: composer unit tests (+26) |
| `289f78ca` | ViewQuote Section 6: router + §28 ceremony + §17.23/§17.24/§17.25 + §3A |
| `0a18dd31` | Refactor ceremony share_token derivation to shared helper (§17.22 closure) |

Full lineage: `git log --oneline -15`.

---

## 3. Phase plan — Path B locked

**Phase sequence** (decided 2026-04-22, unchanged):

| Phase | Scope |
|---|---|
| **A** | Quote spine — five CIL handlers. **Current.** |
| **B** | Quote editing (draft only; sent use ReissueQuote) + tenant logos + template system (`chiefos_quote_templates` table) + warranty/payment structured fields + line-item polymorphic source_type (§6.1) |
| **C** | Leads spine (pre-quote capture + qualification) |
| **D** | Deposit receipts + payment tracking (first wiring into `public.transactions`) |
| **E** | Change Orders spine (separate 6-table spine mirroring Quote — see §6.2; not fold-in) |
| **F** | Invoices spine (generates from signed quote + accepted change orders) |
| **G** | Final receipts + polish |

**Option 1 locked:** signed quote IS the contract. No separate Contracts
spine. `chiefos_quote_signatures` + signed-status quote = legal artifact.

**Phase A session count:** ViewQuote took **2 sessions** (Session 1 =
SendQuote backfill; Session 2 = ViewQuote through §28 ceremony + ceremony
infra refactor). Three handlers remaining:

- **LockQuote** — small. Likely combinable with VoidQuote in one session.
- **VoidQuote** — small. Likely combinable with LockQuote.
- **ReissueQuote** — heavy (supersession wiring, new-version-creation
  pattern). Standalone session expected.

Rough remaining cadence: 2 more sessions (Lock+Void combined, then Reissue
standalone). Phase A closes when all five handlers routable + each has a
ceremony artifact in the decisions-log.

---

## 4. Current Phase A status

ViewQuote complete across all 6 sections + one infrastructure refactor.

| Section | Status | SHA | Notes |
|---|---|---|---|
| **Section 1** | ✅ LANDED | `367d4895` | `ViewQuoteCILZ` schema. `source` narrowed to `z.literal('web')`. `source_msg_id` optional per §17.23. 36 Zod tests. |
| **Section 2** | ✅ LANDED | `58c5d30f` | `VIEW_LOAD_COLUMNS` (21 cols) + `loadViewContext` (two-query helper). SUP.2 posture B. 17 tests. |
| **Section 3** | ✅ LANDED | `056d61aa` | `markQuoteViewed` (single helper, header-first dual-row UPDATE) + `emitLifecycleCustomerViewed` (correlation_id wired day one). 12 tests incl. SAVEPOINT-based regression lock. |
| **Section 4** | ✅ LANDED | `20b015c4` | `handleViewQuote` orchestration + `buildViewQuoteReturnShape` + `alreadyViewedReturnShape`. Posture A concurrent-transition. 13 tests (3 pre-BEGIN + 10 integration). |
| **Section 5** | ✅ LANDED | `b81708d3` | 26 composer unit tests (13 per composer; symmetric coverage). Block 2 Test 11 `toBeInstanceOf(Date)` hardening. |
| **Section 6** | ✅ LANDED | `289f78ca` | Router registration + §28 ceremony + §17.23/§17.24/§17.25/§3A formalizations + CHIEFOS plan update. |
| **Ceremony refactor** | ✅ LANDED | `0a18dd31` | `deriveDeterministicShareToken` shared helper with bounded retry. §17.22 infrastructure exposure closure. +6 tests. |

Prerequisite fix (discovered during Section 4, landed pre-ceremony):

| Commit | Scope |
|---|---|
| `0dedea58` | `markQuoteSent` version.status='draft' leak fix (§3.3 co-transition). One-line production change + SendQuote Section 7 regression test. |

**ViewQuote is closed.** Three handlers remaining in Phase A (see §3).

---

## 5. Architectural patterns established

### 5.1 §17.N formalizations (Phase A Session 2 close)

All three formalizations landed in `docs/QUOTES_SPINE_DECISIONS.md` at
Section 6 commit `289f78ca`:

- **§17.23** — State-driven idempotency + post-rollback re-read recovery.
  **Bundled.** Original §17.24-proposed (post-rollback re-read) collapsed
  into §17.23 as the recovery half per composition watchpoint. First
  exerciser: ViewQuote. Expected future exercisers: LockQuote, VoidQuote.
  ReissueQuote caveat: may surface a §17.26 sub-amendment if the
  `superseded_by_version_id` column write pattern reveals a regime §17.23
  doesn't cover — do NOT force-fit.

- **§17.24** — Header-first ordering for dual-row state transitions.
  (Renumbered from the original §17.25 proposal after §17.24-proposed was
  bundled into §17.23.) First exerciser: `markQuoteViewed`. Regression-
  locked by SAVEPOINT test in Section 3.

- **§17.25** — Echo-if-present posture for Zod-optional audit fields.
  (Renumbered from original §17.26 proposal.) First exerciser:
  `emitLifecycleCustomerViewed`. Strict `!== undefined` check, not
  truthiness, not defensive filter.

- **§3A amendment** — Co-transition between header and version status;
  voided-is-header-only asymmetry. Supersedes narrative "§3.3 co-transition
  asymmetry" references from earlier handoff drafts — canonical reference
  is §3A. See §10.5 for the lesson about forward-referencing vs. narrative
  shorthand.

**§17.26 remains free** for ReissueQuote's supersession-specific sub-
amendment if that handler surfaces new patterns.

### 5.2 Numbering discipline (two-track)

`docs/QUOTES_SPINE_DECISIONS.md` uses a two-track numbering scheme.
Preserve this when composing future ceremonies/formalizations.

**Track 1 — Top-level §N:** architectural ceremonies. One per production-
exercise of a new handler:

- §25 — Phase 2A storage architecture
- §26 — Phase 2C storage ceremony
- §27 — Phase 3 SignQuote ceremony
- **§28 — ViewQuote ceremony** (landed 2026-04-23)
- §30 — expected LockQuote ceremony
- §31 — expected VoidQuote ceremony
- §32 — expected ReissueQuote ceremony
- §29 — reserved for Cross-quote pointer enforcement (renumbered from the
  original §28 placeholder after ViewQuote claimed §28)

**Track 2 — §17.N subsections:** CIL architecture principles derived from
ceremonies:

- §17.19–§17.22 — Phase 3 origination (SignQuote)
- §17.23/§17.24/§17.25 — Phase A Session 2 origination (ViewQuote)
- §17.26 — reserved for ReissueQuote supersession sub-amendment (if warranted)

Phase 3 originated four subsections from one ceremony; ViewQuote originated
three (after composition bundling). Future ceremonies may similarly
originate multiple subsections.

### 5.3 Dual-boundary identity (never collapse)

From `CLAUDE.md`, enforced across all Phase A code:

- **`tenant_id` (uuid)** — portal/RLS boundary. All portal queries filter
  by `tenant_id`. Resolved via membership table.
- **`owner_id` (digits string)** — ingestion/audit boundary. All
  WhatsApp/backend writes include `owner_id`. Must resolve deterministically
  to `tenant_id`.
- **`user_id` (digits string)** — actor identity. Scoped under `owner_id`.
  NEVER used as tenant boundary.
- **UUIDs** — row identifiers only. Never tenant boundary, user identity,
  or owner identity.

If tenant resolution is ambiguous → **FAIL CLOSED** (block write, log
error, treat as Free tier).

Every ViewQuote handler query enforces this. See §17.17 for ctx preflight
discipline.

### 5.4 Handler test discipline

Established through Phase A:
- **Pre-BEGIN rejection tests** (unit, no DB): ctx.owner_id / ctx.traceId /
  Zod-invalid rejections. Exit at Step 0-1 of handler sequence.
- **Integration tests** (DB-gated, seed real quote via handler chain for
  state realism; direct SQL for terminal-state rejection tests).
- **Composer unit tests** (pure, no DB): exact-key-match regression locks
  on return entity shapes (version = N keys, share_token = N keys) to
  prevent silent drift.
- **Ceremony script** per handler: deterministic identity namespace
  (`cNcN-cNcN-cNcN` per phase), SQL INSERT seed, real handler invocation,
  captured artifacts pinned in decisions-log.

**End-to-end test suite** (cross-handler chain tests — Create→Send→View,
Create→Send→Sign, etc.) remains flagged for Phase A closure. Listed under
§8.4.

### 5.5 Amend-paradox note

`0beb6327` (SendQuote correlation_id backfill) references `e8e4a1f7` in
`docs/QUOTES_SPINE_DECISIONS.md` §17.21's "asymmetry closed" paragraph.
`e8e4a1f7` was orphaned by `git commit --amend` that substituted the
pre-amend SHA into text — amending changed the tree hash, which changed
the commit hash. Final amended SHA (`0beb6327`) differs from the substituted
SHA (`e8e4a1f7`).

**Posture chosen:** reference points to the orphaned commit as narrative
anchor; reflog preserves it. For future sessions: write decisions-log
references in a FOLLOW-ON commit that cites the already-landed SHA.
Eliminates the paradox.

---

## 6. Cross-session routing state

From `fd49f702` (Foundation Rebuild session) and subsequent cross-session
discussion. Chief Claude Code head after ceremony refactor: `0a18dd31`.

### 6.1 Phase A spine foundation (source of truth)

`FOUNDATION_P1_SCHEMA_DESIGN.md` §3.5 at approximately line 979 contains
the ~140-line Quote-spine architectural refresher. Skim if context is
missing on why the header/versions/line-items/share-tokens/events/signatures
six-table spine exists.

### 6.2 Cross-session decisions (complete load-bearing set for Phase A/B)

Two decisions landed via Foundation Rebuild session that directly affect
Chief Claude Code's work:

**Q3 — Polymorphic line-item source_type** (Phase B migration):

`pricing_items` table preserved. Three line-item source types:
- `supplier_catalog` — from `catalog_products`
- `pricing_item` — from `pricing_items` (tenant-customizable markup table)
- `free_text` — contractor-typed one-off

Wired into `chiefos_quote_line_items` via:
- `source_type text CHECK (source_type IN (...))`
- `source_ref_id uuid` (nullable; points at pricing_item / catalog_product)
- `source_snapshot jsonb` (preserves source state at line-item creation)

**Migration lands in Phase B**, not Phase A. No current Phase A handler
touches this — it's a forward-plan column set.

**Q4 — Separate `chiefos_change_orders` spine** (Phase E):

Not fold-in to Quotes. 6-table architecture mirrors Quote spine:
`chiefos_change_orders`, `_versions`, `_line_items`, `_signatures`,
`_events`, `_share_tokens`. **Phase E scope.** Not part of Phase A or B.

### 6.3 Cross-session decision completeness

Q3 and Q4 are the complete load-bearing set from Foundation Rebuild's
cross-session routing round as of this handoff's last review. If the
cleared session discovers additional cross-session decisions referenced
elsewhere (commit messages, other docs) that aren't captured here, surface
as "handoff gap detected" per §12.

**Known bounded scope:** only routing decisions affecting Phase A or B
directly. Deep-phase decisions (e.g., Phase E change orders architecture
beyond "6-table mirror of Quotes") intentionally omitted — those surface
in their own phase-scoped handoffs.

### 6.4 Deferred items awaiting Foundation Rebuild input

KPI graphs work (Q6) — awaiting a Foundation Rebuild sub-audit. Not
blocking Phase A.

---

## 7. Production bugs caught during Phase A implementation

Three pattern-worthy bugs discovered and closed during Phase A. Listed
here so future sessions can recognize the pattern surface.

### 7.1 `generateShareToken` short-output (§17.22 origination)

`92fef9e0` (pre-Phase-A). `bs58.encode(crypto.randomBytes(16))` produces
21 chars instead of 22 ~2.83% of the time. Migration 3's
`chiefos_qst_token_format` CHECK requires exactly 22. Fix: bounded retry
loop (20 iterations). §17.22 invariant-assertion discipline formalized in
response.

**Recurrence in ceremony infrastructure.** Same pattern resurfaced in
`scripts/_phase3_constants.js` and `scripts/_phase_a_session2_constants.js`
— both hand-rolled `bs58.encode(sha256(seedString).subarray(0, 16))` with
no retry. §28 ceremony's v1 seed produced 21 chars (caught at module load
during Section 6 implementation). Closed in `0a18dd31` via shared helper
`scripts/_ceremony_shared.js` with bounded retry + deterministic seed
iteration. **Lesson:** §17.22's bug pattern recurs across layers where
infrastructure mirrors production primitives without inheriting their
robustness disciplines. See §8.5 for the broader audit flag.

### 7.2 `markQuoteSent` version.status leak (§3.3 co-transition)

`0dedea58` (discovered during Section 4; landed pre-ceremony). SendQuote's
`markQuoteSent` flipped `chiefos_quotes.status` to 'sent' but only wrote
`issued_at` + `sent_at` on the version row — `version.status` stayed
'draft'. Every real SendQuote left DB state in §3A co-transition violation.

**Undetected because:** SignQuote integration tests used a Phase 2C
ceremony-seed signature (hand-crafted `version.status='sent'`), never the
real Create→Send chain. SendQuote's own Section 7 tests didn't cross-check
`version.status` post-commit. Caught by ViewQuote Section 4's
`loadViewContext` §3A invariant enforcement.

**Lesson:** invariant-assertion discipline (§17.22) protects only when
downstream consumers actually enforce the invariant. §3A co-transition
was dormant from SendQuote's landing until ViewQuote's `loadViewContext`
became its first enforcer. End-to-end Create→Send→(Sign|View) integration
coverage would have caught this earlier. See §8.4.

### 7.3 Composer entity-count miscounting (documentation drift)

Handoff document §4.5 originally claimed `buildSendQuoteReturnShape` had
"4 entities" — actual is 3 (quote, share_token, meta); the count included
`ok:true` as a top-level key, not a data entity. Inconsistency with
`buildSignQuoteReturnShape` which correctly counts 5 entities. Corrected
in `fba89663` handoff patch.

**Lesson:** entity counts in prose documentation drift silently without
mechanical checks. Exact-key-match tests on return shapes (Section 4 Test
13, Section 5 Tests 12-13) catch code-side drift; documentation drift
needs its own review cadence.

---

## 8. Open questions

### 8.1 Session 2 closure

**Closed.** ViewQuote complete; three-commit sequence
(`0dedea58` → `20b015c4` → `fba89663` → `b81708d3` → `289f78ca` → `0a18dd31`)
landed cleanly. No mid-state hangs. Phase A continues with three handlers
remaining.

### 8.2 Three handlers remaining in Phase A Quote spine

- **LockQuote** — small handler. Signed→locked transition on external
  event (e.g., cooling-period expiry). Second §17.23 exerciser.
- **VoidQuote** — small handler. Sent/viewed/signed/locked → voided
  (header-only per §3A). Third §17.23 exerciser.
- **ReissueQuote** — heavy handler. Voided → new draft version with
  `superseded_by_version_id` pointer on old share_tokens. May surface a
  §17.26 sub-amendment to §17.23 per the ReissueQuote caveat.

**Likely session split:** LockQuote + VoidQuote combined in one session
(small state-transition handlers, high architectural symmetry); ReissueQuote
standalone (supersession wiring is the wildcard that may surface new
patterns).

### 8.3 Phase B scope under Option A

Phase B scope was expanded at handoff patch `f839ed51` to include quote
editing + tenant logos + template system + warranty/payment structured
fields + line-item polymorphic source_type. **Explicit decision on Phase
B opening order still required** (which sub-item ships first vs. second,
whether template system blocks quote editing, etc.). Not blocking
Phase A close.

### 8.4 End-to-end test suite

Cross-handler chain integration tests (Create→Send→View, Create→Send→Sign,
Create→Send→View→Sign, etc.) remain flagged for Phase A closure. Current
integration tests exercise individual handlers against seeded state;
cross-handler chains would catch bugs like §7.2 before they reach
ceremony.

Also: `--testTimeout=30000` is currently required due to cold pg-pool-init
flakes. A test-setup warmup hook would eliminate the need and reveal
genuine performance regressions. Not Phase A scope; forward-flag for
Phase A closure pass.

### 8.5 Ceremony-infrastructure drift audit (new)

§7.1's §17.22 recurrence in ceremony seed code is one known instance of
ceremony infrastructure re-implementing production primitives without
inheriting their robustness disciplines. At Phase A closure or Phase B
opening, audit whether ceremony seeds re-implement any OTHER production
primitives that could drift:

- **UUID generation** — ceremony scripts use `crypto.randomUUID()`?
  Hardcoded `00000000-cNcN-cNcN-cNcN-...` identifiers? Matches production
  discipline or bypasses?
- **Password/secret generation** — any ceremony seeds that mint
  credentials?
- **Event-row synthesis** — seeds manually insert `lifecycle.sent` events
  with `payload.ceremony_synthetic=true`. Is the payload shape fully
  compliant with Migration 2 CHECK constraints, or does seed-side logic
  diverge from `emitLifecycleSent`?
- **Timestamp conventions** — ceremony seeds use `NOW()` vs.
  `data.occurred_at` parity with production emissions?

Proactive check before more ceremonies land. Low effort; prevents future
§17.22-analog recurrences.

---

## 9. Key handoff documents and decisions-log artifacts

### 9.1 This handoff

`docs/PHASE_A_SESSION_2_VIEWQUOTE_HANDOFF.md` — paste-ready context for
fresh Claude Code instances resuming Phase A. Maintained per §12 rule.

### 9.2 Canonical decisions-log

`docs/QUOTES_SPINE_DECISIONS.md` — ~4800 lines. All formalized Phase A
decisions land here. Key Phase A Session 2 entries:

- **§3A** — Co-transition between header and version status (amended
  2026-04-23 by §28). Approximately line 155.
- **§17.23** — State-driven idempotency + post-rollback re-read recovery.
  Approximately line 4384.
- **§17.24** — Header-first ordering for dual-row state transitions.
- **§17.25** — Echo-if-present posture for Zod-optional audit fields.
- **§28** — Phase A Session 2 ViewQuote ceremony. Line 4810 (verified
  2026-04-23).

Landed at commit `289f78ca`; no drift from this handoff's references.

### 9.3 Schema-design reference

`FOUNDATION_P1_SCHEMA_DESIGN.md` §3.5 at approximately line 979 — Quote-
spine architecture refresher from Foundation Rebuild session. Cross-
session source-of-truth for six-table spine rationale.

### 9.4 Execution plan

`CHIEFOS_EXECUTION_PLAN.md` §1.2 — Quote-to-Actual Loop status. Contains
per-handler `[x]` status lines; ViewQuote marked complete at Section 6
commit (`289f78ca`).

### 9.5 Ceremony scripts

- `scripts/_ceremony_shared.js` — shared helper `deriveDeterministicShareToken`
  (ceremony-only; DO NOT import in production per docblock)
- `scripts/_phase3_constants.js` — §27 SignQuote ceremony identity
- `scripts/_phase_a_session2_constants.js` — §28 ViewQuote ceremony identity
- `scripts/ceremony_seed_phase_a_session2.js` — §28 seed
- `scripts/real_view_quote_ceremony.js` — §28 ceremony runner with 10
  inline anomaly-stop checks

---

## 10. Discipline patterns the new chat should preserve

Meta-disciplines that surfaced during Phase A sessions. Preserve through
LockQuote/VoidQuote/ReissueQuote.

### 10.1 Propose-before-implement for architectural sessions

Handler design, §17.N formalizations, and ceremony structure get proposed
to the founder BEFORE implementation. Mechanical work (refactors with
scoped approval, bug fixes with clear root-cause) executes directly.

### 10.2 Surface handoff gaps; don't paper over

When a handoff reference doesn't match current code, surface as "handoff
gap detected" and fill it before proceeding. Examples caught during
Phase A Session 2: `data.tenant_id` vs. `ctx.owner_id` resolution
(investigated before Section 4 coding); `buildSendQuoteReturnShape`
entity miscount (corrected at `fba89663`); "§3.3" narrative reference
that had no canonical home (resolved as §3A in Section 6).

### 10.3 Ceremony runs BEFORE decisions-log text

§28's ceremony captured actual production values (correlation_id,
timestamps, event sequence) BEFORE §28 text was drafted. Documentation
cites real artifacts, not intended values. Anomaly-stop checks halt the
ceremony runner if Section-4-expected behavior diverges.

### 10.4 Composition watchpoint on §17.N formalizations

When drafting multiple §17.N subsections, evaluate whether two proposed
subsections are actually one discipline. Section 6 collapsed proposed
§17.24 (post-rollback re-read) into §17.23 (state-driven idempotency) —
the recovery path only fires in response to the detection signal, never
independently. Don't force four standalone numbers if the patterns
collapse to three.

### 10.5 Narrative shorthand vs. canonical section numbers

**New discipline (Section 6 lesson).** When a handoff document uses
narrative shorthand for a pattern that doesn't yet exist in canonical
docs, use explicit language like **"the co-transition asymmetry, to be
formalized in Section 6"** rather than forward-referencing a section
number like **"§3.3 co-transition asymmetry."** The latter collides with
real section numbers at formalization time — `§3.3` has no canonical home
in `docs/QUOTES_SPINE_DECISIONS.md`; handoffs that cited it forced a
naming decision at formalization (resolved as §3A).

**Rule of thumb:** section numbers in prose docs refer to CANONICAL
entries in the decisions-log. Pre-canonical references use descriptive
English, not section numbers.

### 10.6 Cross-session decision capture

Decisions made in Foundation Rebuild sessions that affect Phase A land in
this handoff's §6. Decisions made here that affect Foundation Rebuild
propagate via the founder (no direct chat-to-chat channel). If either
side discovers uncaptured cross-session decisions, surface per §10.2.

---

## 11. Reading order for new chat

After `/clear`, before any work:

1. **Read this handoff** in full. All 12 sections are load-bearing.
2. **Verify git state** — `git log --oneline -15` — confirm §2's commit
   table matches HEAD lineage.
3. **Run test baseline** — `npx jest src/cil/quotes.test.js
   __tests__/ceremony_shared.test.js --testTimeout=30000` — expect
   317/317 passing. Flaky >1/5? Investigate pg-pool warmup (§8.4) before
   coding.
4. **Skim canonical decisions-log entries** from §9.2 that reference
   Phase A Session 2: §3A, §17.23, §17.24, §17.25, §28.
5. **Confirm next-session scope with founder.** Likely: LockQuote +
   VoidQuote combined session, or ReissueQuote standalone. Propose
   handler design BEFORE implementation per §10.1.

Expected first founder action: **"Open LockQuote session"** (or analogous
framing). Fresh agent's first action: read this handoff, verify git state,
confirm test baseline, then request design proposal for the chosen
handler.

---

## 12. Handoff maintenance rule

**If decisions evolve between handoff write and next `/clear`:** update
this document in place and commit immediately. Do not rely on chat
context carrying forward.

**If the cleared session discovers this handoff is incomplete or wrong:**
surface to the founder as "handoff gap detected: [what's missing]"
before proceeding with work. Fill the gap, re-commit handoff, then
proceed.

**At session closeout:** update handoff to reflect landed state. Final
section of the session's work is always the handoff update — the commit
that makes the handoff paste-ready for the next fresh Claude Code
instance.

---

**Last-confirmed state (2026-04-23):** Phase A Session 2 closed cleanly.
ViewQuote complete across all 6 sections + ceremony-seed refactor.
317/317 passing. Six commits landed:
`0dedea58`, `20b015c4`, `fba89663`, `b81708d3`, `289f78ca`, `0a18dd31`.
Next session: LockQuote (likely combined with VoidQuote). Open cleanly;
no mid-state hangs.
