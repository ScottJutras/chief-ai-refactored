# Phase A Session 3 — LockQuote Handoff

**Last updated:** 2026-04-24 (Session 3 closeout)
**Purpose:** Single-document context transfer for any fresh Claude Code
session resuming Phase A after LockQuote. Paste-ready after `/clear`; no
other context needed except the referenced files.

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
SignQuote, ViewQuote, **LockQuote (closed 2026-04-24)**, then VoidQuote and
ReissueQuote remaining. Next session opens VoidQuote (standalone or
combined scope per founder decision).

**Partner role (user):** founder of ChiefOS. Reviews session proposals before
implementation; treats the two-chat split (Chief Claude Code = this repo;
Foundation Rebuild Claude Code = separate sessions) as an explicit
architectural boundary. Cross-session decisions land in this handoff's §6.

**Session-level discipline:** propose-before-implement on architectural
sessions (handler design, formalizations, ceremonies). Execute-directly on
mechanical work the founder has already scoped. Surface handoff gaps
rather than paper over them. Halt-and-surface when pre-implementation
verification detects directive drift from implementation reality (Session 3
exercised this three times — see §10.5).

---

## 2. Current project state

**Branch:** `main`. 69+ commits ahead of `origin/main` (nothing pushed;
Phase A development is local). Pre-push territory — `git commit --amend`
safe when needed.

**Test baseline:** 397/397 passing at `--testTimeout=30000`. 30-second
timeout required to avoid pre-existing cold pg-pool-init flakes; documented
under §8.4 as a forward item.

**Stack:** Node 20, Express, Supabase Postgres + Storage. Deployed via
Vercel. CIL handlers live in `src/cil/`. Tests via jest.

**Recent Phase A commits** (Session 3 chronological, oldest first):

| SHA | One-line |
|---|---|
| `f52e7888` | Phase plan amendment: add Phase A.5 (Quote surface parity sprint) |
| `050372f7` | Phase A Session 3 Section 1: `LockQuoteCILZ` + `loadLockContext` + `markQuoteLocked` + `emitLifecycleLocked` |
| `d6f97bc6` | Phase A Session 3 mid-session checkpoint (pre-/clear) — deleted at close-out |
| `237d8f74` | Phase A Session 3 Section 2: `handleLockQuote` + return-shape composers + 36 tests |
| `<PENDING>` | Phase A Session 3 close-out: router + §30 ceremony + §17.24 correction + handoff |

Full lineage: `git log --oneline -20`.

---

## 3. Phase plan — Path B locked (amended 2026-04-23 to add A.5)

**Phase sequence:**

| Phase | Scope |
|---|---|
| **A** | Quote spine — five CIL handlers (handler-spine only; internal CIL dispatch coverage). **Current.** LockQuote closed; two remaining. |
| **A.5** | Quote surface parity sprint — fuzzy quote resolver (shared), WhatsApp commands (`/lock`, `/void`, `/reissue`, retrofit `/send`), portal quote detail view, portal action API endpoints. Widens source enums to `['portal', 'whatsapp', 'system']` across all Quote-spine handlers. Estimated 3–4 sessions. Closes parity-as-principle for Quote spine: every handler has a human dispatch surface parallel to its internal CIL dispatch. |
| **B** | Quote editing (draft only; sent use ReissueQuote) + tenant logos + template system (`chiefos_quote_templates`) + warranty/payment structured fields + line-item polymorphic source_type (§6.1). Opens post-A.5. |
| **C** | Leads spine (pre-quote capture + qualification) |
| **D** | Deposit receipts + payment tracking (first wiring into `public.transactions`) |
| **E** | Change Orders spine (separate 6-table spine mirroring Quote — §6.2) |
| **F** | Invoices spine (generates from signed quote + accepted change orders) |
| **G** | Final receipts + polish |

**Option 1 locked:** signed quote IS the contract. No separate Contracts
spine. `chiefos_quote_signatures` + signed-status quote = legal artifact.

**Phase A session count so far:** ViewQuote took 2 sessions; LockQuote
took 1 session (Session 3). Two handlers remaining:

- **VoidQuote** — small-medium. Draft/sent/viewed/signed/locked → voided
  (header-only per §3A). Third §17.23 exerciser. May combine with
  ReissueQuote if scope warrants, or standalone.
- **ReissueQuote** — heavy. Voided → new draft version (INSERT new, not
  UPDATE). Supersession wiring via `superseded_by_version_id`. May surface
  a §17.26 sub-amendment to §17.23 per ceremony caveat.

Rough remaining cadence: 1–2 more sessions. Phase A closes when all five
handlers routable + each has a ceremony artifact in the decisions-log.

---

## 4. Current Phase A status

ViewQuote complete; LockQuote complete. Two handlers remaining.

| Handler | Status | Ceremony §  | Section commits |
|---|---|---|---|
| **CreateQuote**   | ✅ LANDED | §21 | `e6b856d7` + `5fd11647` |
| **SendQuote**     | ✅ LANDED | §22 | `c2c889dd` → `476eff27` (+ `534a1422` bs58 dep) |
| **SignQuote**     | ✅ LANDED | §27 | `ba731315` → `4ba05486` → `3353011c` → `7db945e2` → `45ea71d1` → `3c5b6e9d` + close-out |
| **ViewQuote**     | ✅ LANDED | §28 | `367d4895` → `58c5d30f` → `056d61aa` → `20b015c4` → `b81708d3` → `289f78ca` + `0a18dd31` (ceremony refactor) |
| **LockQuote**     | ✅ LANDED | **§30** | `050372f7` → `237d8f74` → `<PENDING>` close-out |
| **VoidQuote**     | 🔲 Pending | §31 | — |
| **ReissueQuote**  | 🔲 Pending | §32 | — |

Prerequisite fixes landed pre-ceremony during prior sessions:

| Commit | Scope |
|---|---|
| `92fef9e0` | `generateShareToken` short-output (§17.22 origination) |
| `0dedea58` | `markQuoteSent` version.status='draft' leak (§3.3 co-transition) |

---

## 5. Architectural patterns established

### 5.1 §17.N formalizations (complete through Phase A Session 3)

All formalizations live in `docs/QUOTES_SPINE_DECISIONS.md`:

- **§17.19** (Phase 3) — post-commit paired notifications (SignQuote)
- **§17.20** (Phase 3) — pre-BEGIN external write for strict-immutable INSERT
- **§17.21** (Phase 3) — correlation_id wiring
- **§17.22** (Phase 3) — invariant-assertion discipline
- **§17.23** (Phase A Session 2 close) — state-driven idempotency + post-rollback
  re-read recovery. **Two exercisers landed:** ViewQuote (first), LockQuote
  (second). ReissueQuote caveat stands: may surface §17.26 sub-amendment if
  `superseded_by_version_id` write pattern reveals a regime §17.23 doesn't
  cover — do NOT force-fit.
- **§17.24** (Phase A Session 2 close; amended Phase A Session 3 close) —
  header-first ordering for dual-row state transitions. **Forward-applicability
  corrected at §30 close-out:** the original "LockQuote — dual-row" bullet
  was drift from §3A post-sign immutability; corrected to "LockQuote —
  header-only per §3A; §17.24 does NOT apply." See §30 discipline note #1.
- **§17.25** (Phase A Session 2 close) — echo-if-present posture for
  Zod-optional audit fields. Two production exercisers: ViewQuote
  (`emitLifecycleCustomerViewed`) and LockQuote (`emitLifecycleLocked`).
- **§3A amendment** (Phase A Session 2 close) — co-transition between header
  and version status; voided-is-header-only asymmetry. **LockQuote §30
  production-verified the post-sign immutability corollary:** first captured
  artifact where version row is byte-identical pre-to-post lock.

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
- §28 — ViewQuote ceremony (Phase A Session 2)
- **§30 — LockQuote ceremony (Phase A Session 3, landed 2026-04-24)**
- §31 — expected VoidQuote ceremony
- §32 — expected ReissueQuote ceremony
- §29 — reserved for Cross-quote pointer enforcement

**Track 2 — §17.N subsections:** CIL architecture principles derived from
ceremonies:

- §17.19–§17.22 — Phase 3 origination (SignQuote)
- §17.23/§17.24/§17.25 — Phase A Session 2 origination (ViewQuote)
- §17.26 — reserved for ReissueQuote supersession sub-amendment

Phase 3 originated four subsections; ViewQuote originated three;
**LockQuote originated zero — Session 2 formalizations consumed cleanly.**
This is a trailing indicator that Session 2's formalizations landed at the
right level of abstraction.

### 5.3 Dual-boundary identity (never collapse)

From `CLAUDE.md`, enforced across all Phase A code:

- **`tenant_id` (uuid)** — portal/RLS boundary
- **`owner_id` (digits string)** — ingestion/audit boundary
- **`user_id` (digits string)** — actor identity, scoped under `owner_id`
- **UUIDs** — row identifiers only

LockQuote is the first system-actor handler (`actor.role='system'` is the
ONLY valid value via `LockQuoteActorZ = z.literal('system')` in Phase A);
§17.17 ctx preflight discipline still applies (owner_id + traceId required
for system-actor just as for customer/portal actors).

### 5.4 Handler test discipline

Established through Phase A and reaffirmed in Session 3:
- **Pre-BEGIN rejection tests** (unit, no DB): ctx.owner_id / ctx.traceId /
  Zod-invalid rejections. Exit at Step 0-1 of handler sequence. (§2 Block 1 = 3 tests.)
- **Integration tests** (DB-gated): happy path, already-X idempotency,
  concurrent-transition recovery via `pg.withClient` stub, wrong-state
  rejection (one per adjacent state), cross-tenant + cross-owner
  fail-closed, return-shape regression guard. (§2 Block 1 = 10 tests.)
- **Composer unit tests** (pure, no DB): exact-key-match regression locks
  on return entity shapes. (§2 Block 2+3 = 23 tests.)
- **Ceremony script** per handler: deterministic identity namespace
  (`cNcN-cNcN-cNcN` per phase), SQL INSERT seed, real handler invocation,
  captured artifacts pinned in decisions-log.

**End-to-end test suite** (cross-handler chain tests) remains flagged for
Phase A closure. See §8.4.

### 5.5 Path B no-plan-gating posture

LockQuote applies NO plan gating — creation consumes the plan gate;
downstream lifecycle actions (send, sign, view, lock, void, reissue) are
transitively gated via creation per G6 follow-through. Matches SendQuote,
SignQuote, and ViewQuote posture. If Phase A.5+ develops independent
gating semantics (e.g., owner-initiated vs. system-initiated lock with
different counter economics), formalize at the next-free §17.N slot. §2
handler inline comment reserves the slot.

---

## 6. Cross-session routing state

Cross-session decisions landed via Foundation Rebuild session(s) affecting
Chief Claude Code's work. Q3 and Q4 are the complete load-bearing set as of
this handoff's last review.

### 6.1 Phase A spine foundation (source of truth)

`FOUNDATION_P1_SCHEMA_DESIGN.md` §3.5 at approximately line 979 contains
the ~140-line Quote-spine architectural refresher.

### 6.2 Cross-session decisions

**Q3 — Polymorphic line-item source_type** (Phase B migration):
`pricing_items` table preserved. Three line-item source types —
`supplier_catalog`, `pricing_item`, `free_text` — wired into
`chiefos_quote_line_items` via `source_type` + `source_ref_id` +
`source_snapshot`. Lands in Phase B, not Phase A.

**Q4 — Separate `chiefos_change_orders` spine** (Phase E): 6-table
architecture mirrors Quote spine. Phase E scope.

### 6.3 Cross-session decision completeness

Q3 and Q4 are complete load-bearing set as of this handoff. If cleared
session discovers additional cross-session decisions referenced elsewhere
that aren't captured here, surface as "handoff gap detected" per §12.

### 6.4 Deferred items awaiting Foundation Rebuild input

KPI graphs work (Q6) — awaiting a Foundation Rebuild sub-audit. Not
blocking Phase A.

---

## 7. Production bugs caught during Phase A implementation

No new production bugs discovered during Session 3 — clean arc. Prior
bugs from Sessions 0-2:

### 7.1 `generateShareToken` short-output (§17.22 origination)

`92fef9e0`. bs58 encoding produces 21 chars ~2.83% of the time; Migration 3
CHECK requires 22. Fix: bounded retry loop. Recurred in ceremony seed code;
closed at `0a18dd31` via `deriveDeterministicShareToken` shared helper.
**Lesson:** §17.22's bug pattern recurs across layers where infrastructure
mirrors production primitives without inheriting robustness.

### 7.2 `markQuoteSent` version.status leak (§3.3 co-transition)

`0dedea58` (discovered during ViewQuote Section 4). SendQuote's
`markQuoteSent` flipped `chiefos_quotes.status` to 'sent' but left
`version.status` at 'draft'. **Lesson:** invariant-assertion discipline
protects only when downstream consumers enforce the invariant. §3A
co-transition was dormant until ViewQuote's `loadViewContext` became its
first enforcer.

### 7.3 Composer entity-count miscounting (documentation drift)

Handoff document §4.5 originally claimed `buildSendQuoteReturnShape` had
"4 entities" — actual is 3. Corrected in `fba89663` handoff patch.
**Lesson:** entity counts in prose documentation drift silently without
mechanical checks.

---

## 8. Open questions

### 8.1 Session 3 closure

**Closed.** LockQuote complete; four-commit sequence
(`f52e7888` → `050372f7` → `d6f97bc6` → `237d8f74` → `<PENDING>`)
landed cleanly. Mid-session `/clear` exercised the checkpoint
discipline (see §10.4). Phase A continues with two handlers remaining.

### 8.2 Two handlers remaining in Phase A Quote spine

- **VoidQuote** — small-medium. Header-only per §3A. Third §17.23 exerciser.
- **ReissueQuote** — heavy. Voided → new draft version. Supersession wiring
  is the wildcard that may surface new patterns (§17.26 reserved).

**Likely session split:** VoidQuote standalone OR combined with ReissueQuote
per founder scope decision at next-session opening. ReissueQuote alone is
heaviest remaining handler — standalone is the safer default.

### 8.3 Phase B scope

Expanded at handoff patch `f839ed51` to include quote editing + tenant
logos + template system + warranty/payment structured fields + line-item
polymorphic source_type. **Phase B opens post-A.5**, not post-A. Explicit
decision on Phase B opening order still required — not blocking Phase A
close.

### 8.4 End-to-end test suite

Cross-handler chain integration tests (Create→Send→View, Create→Send→Sign,
Create→Send→Sign→Lock, etc.) remain flagged for Phase A closure. Current
integration tests exercise individual handlers against seeded state;
cross-handler chains would catch bugs like §7.2 before they reach ceremony.

Also: `--testTimeout=30000` is currently required due to cold pg-pool-init
flakes. A test-setup warmup hook would eliminate the need. Not Phase A
scope; forward-flag for Phase A closure pass.

### 8.5 Ceremony-infrastructure drift audit

§7.1's §17.22 recurrence in ceremony seed code is one known instance of
ceremony infrastructure re-implementing production primitives without
inheriting robustness disciplines. Forward-flag audit remains open —
check `storage_key` format, UUID generation, signature row synthesis,
etc. Session 3's seed surfaced a small version of this (storage_key
format string had to be byte-identical to Migration 6 regex; caught at
seed-time by the CHECK).

### 8.6 SIG_ERR rename backlog (new)

`SIG_ERR` has become a misnomer — houses `QUOTE_NOT_SIGNED`, `QUOTE_VOIDED`,
`QUOTE_NOT_SENT` (none sign-related). Consider renaming to `QUOTE_ERR` or
`LOAD_ERR` in a post-Phase-A housekeeping pass after VoidQuote +
ReissueQuote ship and the right name is clearer. Do not rename inline
during handler work. See §30 discipline note #3.

---

## 9. Key handoff documents and decisions-log artifacts

### 9.1 This handoff

`docs/PHASE_A_SESSION_3_LOCKQUOTE_HANDOFF.md` — paste-ready context for
fresh Claude Code instances resuming Phase A post-LockQuote. Maintained
per §12 rule.

### 9.2 Canonical decisions-log

`docs/QUOTES_SPINE_DECISIONS.md` — all formalized Phase A decisions.
Key Session 3 entries:

- **§3A** production-verification captured at §30 (version row byte-identical
  pre-to-post lock — first captured artifact)
- **§17.24** forward-applicability correction at §30 close-out (LockQuote
  bullet updated: header-only per §3A, does NOT apply)
- **§30** — Phase A Session 3 LockQuote ceremony. **Landed `<PENDING>`.**

No new §17.N subsection landed in Session 3 — Session 2's formalizations
consumed cleanly.

### 9.3 Schema-design reference

`FOUNDATION_P1_SCHEMA_DESIGN.md` §3.5 — Quote-spine architecture refresher.

### 9.4 Execution plan

`CHIEFOS_EXECUTION_PLAN.md` §1.2 — per-handler `[x]` status lines.
LockQuote marked complete 2026-04-24 at close-out commit.

### 9.5 Ceremony scripts

- `scripts/_ceremony_shared.js` — shared `deriveDeterministicShareToken`
- `scripts/_phase3_constants.js` — §27 SignQuote
- `scripts/_phase_a_session2_constants.js` — §28 ViewQuote
- `scripts/_phase_a_session3_constants.js` — §30 LockQuote **(new)**
- `scripts/ceremony_seed_phase_a_session3.js` — §30 seed **(new)**
- `scripts/real_lock_quote_ceremony.js` — §30 ceremony runner with
  13 inline anomaly-stop checks including 3 CRITICAL §3A invariants
  (version row unchanged) **(new)**

---

## 10. Discipline patterns the new chat should preserve

Meta-disciplines that surfaced during Phase A sessions. Preserve through
VoidQuote/ReissueQuote.

### 10.1 Propose-before-implement for architectural sessions

Handler design, §17.N formalizations, ceremony structure — proposed to
founder BEFORE implementation. Mechanical work executes directly.

### 10.2 Surface handoff gaps; don't paper over

When a handoff reference doesn't match current code, surface as "handoff
gap detected" and fill it before proceeding.

### 10.3 Ceremony runs BEFORE decisions-log text

§30's ceremony captured production values (correlation_id, event sequence,
pre/post state diff) BEFORE §30 text was drafted. Anomaly-stop checks halt
the runner if expected behavior diverges. Documentation cites real
artifacts, not intended values.

### 10.4 Composition watchpoint on §17.N formalizations

When drafting multiple §17.N subsections, evaluate whether two proposed
subsections are actually one discipline. Session 2 collapsed proposed
§17.24 (post-rollback re-read) into §17.23 (state-driven idempotency).
Session 3 consumed prior formalizations without originating new ones —
confirmation that the Session 2 collapse was the right call.

### 10.5 Narrative shorthand vs. canonical section numbers

When a handoff uses narrative shorthand for a pattern that doesn't yet
exist in canonical docs, use explicit language ("the co-transition
asymmetry, to be formalized in Section 6") rather than forward-referencing
a section number like "§3.3." The latter collides with real section
numbers at formalization.

**Rule of thumb:** section numbers in prose docs refer to CANONICAL
entries. Pre-canonical references use descriptive English, not section
numbers.

### 10.6 Cross-session decision capture

Decisions made in Foundation Rebuild sessions that affect Phase A land
in this handoff's §6. If either side discovers uncaptured cross-session
decisions, surface per §10.2.

### 10.7 Schema-verify forward-applicability (new — Session 3 lesson)

Future §17.N formalizations that list forward exercisers must
schema-verify each listed handler before commit. The §17.24 LockQuote
dual-row bullet was drafted in Session 2 before §3A post-sign immutability
was canonical; corrected at §30 close-out after §2 implementation revealed
drift. Drafting multiple forward bullets simultaneously without per-handler
schema check is how incoherence enters the decisions log.

### 10.8 Surface-enum questions are product-level (new)

When a handler decision involves surface enumeration (`source`,
`actor.role`, `channel`), surface the product-intent question before the
technical-implementation question. Mid-session scope expansion often
indicates a missing phase or missing principle in the plan, not a missing
handler detail. Session 3's parity-principle discussion produced Phase A.5
as a named phase — the right answer was "elevate to plan," not "absorb into
handler scope."

### 10.9 Mid-session checkpoint discipline (new)

When a Claude Code session must `/clear` mid-arc, the outgoing session
commits a `_CHECKPOINT.md` document summarizing scope lockdowns,
implementation-time nuances, and approved-but-unstarted work. Distinct
from `_HANDOFF.md`. Fresh session reads checkpoint before accepting
directives; checkpoint is deleted when arc closes. Session 3 exercised
this cleanly (`d6f97bc6` introduction → deletion in the close-out commit).

### 10.10 Directives are proposals, not ground truth (new)

Pre-implementation verification — grepping actual source, reading actual
handler precedents, checking actual schema constraints — is the contract.
Halt-and-surface when drift detected. Session 3 LockQuote arc caught three
directive corrections this way (QuoteRefInputZ at-least-one contract,
plan-gating precedent, `ctx.versionServerHash` field naming); verification
prevented silent incoherence in production code.

### 10.11 SIG_ERR rename backlog (new — tracked not actioned)

`SIG_ERR` in `src/cil/utils.js` has become a misnomer (houses
non-sign-related codes). Consider renaming post-Phase-A. Do not rename
inline during handler work. See §8.6.

---

## 11. Reading order for new chat

After `/clear`, before any work:

1. **Read this handoff** in full. All 12 sections are load-bearing.
2. **Verify git state** — `git log --oneline -20` — confirm §2's commit
   table matches HEAD lineage.
3. **Run test baseline** — `npx jest src/cil/quotes.test.js
   __tests__/ceremony_shared.test.js --testTimeout=30000` — expect
   397/397 passing. Flaky >1/5? Investigate pg-pool warmup (§8.4) before
   coding.
4. **Skim canonical decisions-log entries** from §9.2 that reference
   Phase A Session 3: §3A, §17.24 (amended), §30.
5. **Confirm next-session scope with founder.** Likely: VoidQuote
   standalone, or combined with ReissueQuote per scope decision. Propose
   handler design BEFORE implementation per §10.1.

Expected first founder action: **"Open VoidQuote session"** (or analogous
framing). Fresh agent's first action: read this handoff, verify git state,
confirm test baseline, then request design proposal for the chosen
handler.

---

## 12. Handoff maintenance rule

**If decisions evolve between handoff write and next `/clear`:** update
this document in place and commit immediately.

**If the cleared session discovers this handoff is incomplete or wrong:**
surface to the founder as "handoff gap detected: [what's missing]"
before proceeding with work. Fill the gap, re-commit handoff, then
proceed.

**At session closeout:** update handoff to reflect landed state. Final
section of the session's work is always the handoff update — the commit
that makes the handoff paste-ready for the next fresh Claude Code
instance.

---

**Last-confirmed state (2026-04-24):** Phase A Session 3 closed cleanly.
LockQuote complete across all sections + production ceremony. 397/397
passing. Four Session 3 commits landed: `050372f7`, `d6f97bc6` (deleted
at close), `237d8f74`, `<PENDING>` close-out. Next session: VoidQuote
(standalone or combined with ReissueQuote per founder decision).
