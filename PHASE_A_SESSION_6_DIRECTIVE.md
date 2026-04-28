# Phase A Session 6 — A.5 Slice 1 (V1 Resolver + V2 WhatsApp Commands) — Implementation Directive

**Authority:** Project Instructions v4.0 (Tier 6), Execution Playbook v4.0 (Tier 3), Engineering Constitution v4.0 (Tier 1), `CLAUDE.md`, `PHASE_A5_INVESTIGATION.md` (ACTIVE; §0.3 Decisions A–D APPROVED 2026-04-26 at commit `0fbb97c1`), `PHASE_A_CLOSE_HANDOFF.md`.
**Anchored at commit:** main HEAD as of session start (Phase A surface complete; ReissueQuote shipped at `812ac55f`).
**Closes:** Phase A.5 Slice 1 (WhatsApp surface).
**Unblocks:** Session 7 (A.5 Slice 2 — Portal surface).

---

## Preamble — directive shape note

This directive departs from the single-artifact rule the /schedule spec normally produces. The four Session-5 follow-ups did not run between Phase A close (2026-04-25) and Session 6 opening (2026-04-26 verification). Founder elected to fold all four into Session 6 as **Phase 6.0 opening tasks** rather than fix-in-place via separate work.

A second deviation followed the first: a parallel Claude Code session ran the Phase 5 cutover migration sequence into a new Supabase project (`tctohnzqxzrfijdufrss` / "CHiefOS") between 12:21–13:02 UTC on 2026-04-26 while this session was authoring artifacts. Coordination contract was resolved at end of authoring (founder relayed parallel-session answers); a new §6.0.0 hard gate (cutover handoff verification via sentinel commit) protects Session 6 against acting on stale or in-flight cutover state. See §1.5 inter-session write protocol.

This directive therefore carries:

- A new top-level **§0 OPENING TASKS** section (full content of `SESSION_6_OPENING_TASKS.md` integrated by reference; do not duplicate)
- A new **§1.5 inter-session write protocol** section (interim location until promoted; see §11)
- A new **§1.6 namespace allocation registry** section (interim location until promoted; see §11)
- A new **§1.7 known post-cutover state** section (V6.B integrity-service drift awareness)
- A dependency graph showing which opening tasks block which V1/V2 implementation steps (§5)
- The standard Slice 1 implementation contract (§1–§4, §6–§10)

---

## §0. Opening Tasks (Phase 6.0 — execute first)

Full task specs live in `SESSION_6_OPENING_TASKS.md`. Summary + sequencing here:

| Task | Gate | What | Verification | Sequence |
|---|---|---|---|---|
| **6.0.0** | NEW | Cutover handoff verification — poll for sentinel `docs/PHASE_5_CUTOVER_COMPLETE.md` on main; confirm schema-frozen declaration + namespace registry | `git log main --oneline -- docs/PHASE_5_CUTOVER_COMPLETE.md` returns at least one commit; sentinel content includes schema-frozen declaration | **First — HARD GATE.** Until sentinel commits, every other 6.0.x task that touches CHiefOS is blocked. |
| 6.0.4 | (d) | Add `portal: 'portal'` entry to `CIL_TO_EVENT_ACTOR_SOURCE` map at `src/cil/quotes.js:105` | grep returns 2 `'portal'` lines; tighten ReissueQuote integration test #9 | Second (lowest risk; pure code; can run in parallel with 6.0.0 polling) |
| 6.0.3 | (c) | Rewrite `seedVoidedQuote` (~`src/cil/quotes.test.js:11189-11221`) to use existing `setupQuotePreconditions` helper; resolves varchar(20) overflow | 9 ReissueQuote integration tests green | Third (template for Slice 1 tests; can run in parallel with 6.0.0 polling) |
| 6.0.1 | (a) | Verify migration on CHiefOS via 3-artifact probe AFTER sentinel commits; document Chief disposition (decommission vs apply migration as parallel staging) | `chiefos_quote_versions.source_msg_id` column + `chiefos_qv_source_msg_unique` index + `trg_chiefos_qv_source_msg_immutable` trigger all return true on `tctohnzqxzrfijdufrss`; Chief decision recorded | Fourth (re-verification via Supabase MCP read; migration was applied during parallel cutover work) |
| 6.0.2 | (b) | Run `node scripts/real_reissue_quote_ceremony.js` against **CHiefOS only** (`tctohnzqxzrfijdufrss`); capture transcript; append actual output to `docs/QUOTES_SPINE_CEREMONIES.md` §32.3 | Exit 0 first run + exit 0 with `meta.already_existed=true` second run | Fifth (depends on 6.0.0 + 6.0.1) |

**Phase 6.0 close criterion:** all five gates green before Phase 6.1 implementation begins. If any opening task surfaces unexpected drift (e.g., 6.0.3 reveals new failure types beyond varchar(20); 6.0.1 reveals schema state diverging from sentinel claim), fold the surprise into Phase 6.0 as additional opening sub-tasks per the founder's pivot directive — do NOT stop and escalate unless the drift implicates Beta Pause Rule criteria OR the parallel cutover session's schema-frozen declaration is invalidated.

**Gate (a) classification:** CONDITIONAL PASS. Migration is observed applied on CHiefOS (probed at post-coordination snapshot ~03:00 UTC; column + index + trigger all present; recorded as migration version `20260426130216`). Conditional on sentinel `docs/PHASE_5_CUTOVER_COMPLETE.md` landing on main and declaring the parallel cutover session done. Migration apply landed during the parallel cutover commit chain `f2bdc650 → fe67cbc1 → eb46a3be → 971ca0ea → 4dec6ddb → faa0da41 → 886b3044 → a39f2c06`.

---

## §1. Decisions Carried Forward (verbatim from `PHASE_A5_INVESTIGATION.md` §0.3)

Re-stated here to reduce cross-doc lookup during implementation.

### Decision A — Schema widening: `LockQuoteCILZ.source` and `VoidQuoteCILZ.source`

| Field | Value |
|---|---|
| Decision | Widen `LockQuoteCILZ.source` and `VoidQuoteCILZ.source` from `z.literal('system')` to `z.enum(['portal','whatsapp','system'])` |
| Recommendation | APPROVE — already commented as Phase A.5 intent in source (`src/cil/quotes.js:3946-3950`, `4618-4622`) |
| Tradeoff | Trivial widening; no behavioral change to existing system callers; unblocks both A.5 surfaces |
| Founder status | **APPROVED 2026-04-26.** Already commented as Phase A.5 intent in source. Required for portal action API to invoke Lock/Void handlers without source-spoofing. Slice 1 schema task. |

### Decision B — Portal action API idempotency

| Field | Value |
|---|---|
| Decision | Client-supplied `Idempotency-Key` header → CIL `source_msg_id` |
| Recommendation | APPROVE the header strategy |
| Tradeoff | Lock/Void are state-machine-idempotent already so the key buys traceability not safety; Reissue (Session 5) needs it for the source_msg_id unique constraint and benefits properly. Alternative server-issued nonces add a round-trip with no correctness gain. |
| Founder status | **APPROVED 2026-04-26.** State-machine idempotency on Lock/Void is the safety net; the header buys traceability and forward-compatibility with Reissue's source_msg_id unique constraint shipped in Session 5. Reject server-issued action-id nonces — header pattern is industry-standard and gives clients deterministic retry semantics. |

(Decision B is a Session 7 [V4] concern. Captured here for Slice 1 implementer awareness; do not implement portal action API in Session 6.)

### Decision C — Portal action API endpoint shape

| Field | Value |
|---|---|
| Decision | REST `POST /api/quotes/:quoteId/{lock,void,reissue}` (matching `routes/jobsPortal.js` pattern) |
| Recommendation | APPROVE REST |
| Tradeoff | Matches existing portal mutation pattern (jobsPortal.js, crewAdmin.js); RPC alternative would diverge from precedent without benefit |
| Founder status | **APPROVED 2026-04-26.** Matches existing routes/jobsPortal.js pattern. Consistency with established portal action surface outweighs RPC ergonomics. Reject RPC POST /api/quotes/action body-dispatch — would create a second action-routing pattern in the portal API and increase cognitive load. |

(Decision C is a Session 7 concern. Carried for Slice 2 directive.)

### Decision D — `chiefos_portal_quotes` view scope

| Field | Value |
|---|---|
| Decision | SECURITY INVOKER, joins `chiefos_quotes + chiefos_quote_versions + chiefos_quote_line_items + customers + jobs`, RLS via `chiefos_portal_users` membership |
| Recommendation | APPROVE the join shape (column list in §V3 of investigation doc) |
| Tradeoff | Matches `chiefos_portal_expenses` precedent (`migrations/2026_04_22_rebuild_views.sql:57`); SECURITY INVOKER means the underlying RLS policies do the work |
| Founder status | **APPROVED CONDITIONALLY 2026-04-26.** View concept and join shape (chiefos_quotes + chiefos_quote_versions + chiefos_quote_line_items + customers + jobs) approved. SECURITY INVOKER + tenant_id boundary via membership confirmed. Column list requires final founder review before migration ships in Session 7 — flag any column that surfaces PII beyond existing customer view exposure pattern, or any column that would create implicit trust-surface expansion. Session 6 (Slice 1) is unblocked regardless; this Decision only gates Session 7 implementation. |

(Decision D is a Session 7 concern. Carried for Slice 2 directive.)

**Carried-forward summary:** Decision A binds Session 6 (schema widening must land in Phase 6.1). Decisions B, C, D bind Session 7. Slice 1 work proceeds independently of B/C/D.

---

## §1.5 Inter-session write protocol (interim — promote per §11)

Two Claude Code sessions have been operating against the same logical workspace (CHiefOS Supabase project `tctohnzqxzrfijdufrss` + this git repo):

- **This session:** authored Session 5 ReissueQuote handler + Session 6 opening artifacts. Read-only against CHiefOS.
- **Parallel cutover session:** authored Phase 5 cutover migrations apply + V3-V6 schema work + synthetic seed + cutover-checklist commits.

The two sessions had no shared context. CLAUDE.md does not document an inter-session write protocol. Until promoted to a permanent location (see §11), Session 6 operates under this interim protocol:

1. **Sentinel-based handoff.** No CHiefOS write from Session 6 until parallel cutover session declares done via committing `docs/PHASE_5_CUTOVER_COMPLETE.md` to main. Poll command: `git log main --oneline -- docs/PHASE_5_CUTOVER_COMPLETE.md`. Expected commit message pattern: `docs(phase-5): cutover complete — production live on tctohnzqxzrfijdufrss`. Sentinel content includes: cutover datetime, production project ref, schema state summary (77 tables / 8 views / 133 functions / 56 triggers / 170 policies), known post-cutover items, schema-frozen declaration.
2. **Namespace allocation registry.** Each session that writes UUID-prefixed seed/ceremony rows declares its namespace prefix in §1.6 BEFORE writing rows under it. Collision-prevention by construction.
3. **Schema-frozen contract.** Once cutover sentinel commits, the parallel session declares CHiefOS schema frozen — no further `ALTER` / `CREATE` / `DROP` from cutover work. Future amendments follow dedicated P1A-N session pattern (single-purpose schema commit, manifest update, rollback file). Not bundled with feature work. Session 6 builds against post-cutover state as-is.
4. **Read-only posture before sentinel.** This session may continue reading CHiefOS via Supabase MCP `execute_sql` (SELECT only) for verification probes. No `apply_migration`, `create_branch`, or write SQL.
5. **Co-existence with synthetic seed.** Production DB has V3-V5 synthetic seed (1 tenant, 5 users, 5 jobs, 20 transactions, intentional + non-conflicting + small). Session 6 implementation work either coexists with seed (recommended) or scopes its own seed to UUIDs distinct from §1.6 V3 prefix table.
6. **No backfill or data migration gating Session 6.** Sentinel commit unblocks Session 6 immediately upon landing; no parallel-session data-prep work outstanding.

---

## §1.6 Namespace allocation registry (interim — promote per §11)

Append-only. Each session reserves prefixes BEFORE writing UUID-prefixed seed/ceremony rows. Collision-prevention authority lives here until promoted.

| Prefix | Owner / Purpose | Reserved by |
|---|---|---|
| `00000000-0000-4000-8000-...` | tenants | Parallel cutover session (V3-V5 seed) |
| `10000000-0000-4000-8000-...` | auth.users + portal_users | Parallel cutover session (V3-V5 seed) |
| `20000000-0000-4000-8000-...` | transactions | Parallel cutover session (V3-V5 seed) |
| `40000000-0000-4000-8000-...` | tasks | Parallel cutover session (V3-V5 seed) |
| `50000000-0000-4000-8000-...` | role_audit correlation_ids | Parallel cutover session (V3-V5 seed) |
| `60000000-0000-4000-8000-...` | activity_logs correlation_ids | Parallel cutover session (V3-V5 seed) |
| `70000000-0000-4000-8000-...` | conversation_sessions | Parallel cutover session (V3-V5 seed) |
| `80000000-0000-4000-8000-...` | V5 additional activity_log corr_ids | Parallel cutover session (V5) |
| `90000000-0000-4000-8000-...` | V5.6 correlation_id thread test | Parallel cutover session (V5.6) |
| `c4c4-c4c4-c4c4-...` | Phase A Session 2 ViewQuote ceremony | Phase A Session 2 |
| `c5c5-c5c5-c5c5-...` | Phase A Session 3 LockQuote ceremony | Phase A Session 3 |
| `c6c6-c6c6-c6c6-...` | Phase A Session 4 VoidQuote ceremony | Phase A Session 4 |
| `c7c7-c7c7-c7c7-...` | Phase A Session 5 ReissueQuote ceremony | Phase A Session 5 |
| _(reserve here as Session 6 needs them)_ | TBD — append BEFORE writing | Session 6 |

**Session 6 obligation:** if any new test or ceremony work writes UUID-prefixed seed/ceremony rows, append the prefix + purpose to this table BEFORE the write lands. Most likely Slice-1 commands won't need new prefixes (they reuse Phase A Session 5 ceremony scaffolding); flag if surfaced.

**Parallel cutover session zero quote-spine writes (confirmed via coordination contract):** the V3-V6 work touched ZERO quote-spine tables (`chiefos_quotes`, `chiefos_quote_versions`, `chiefos_quote_line_items`, `chiefos_quote_events`, `chiefos_quote_share_tokens`, `chiefos_quote_signatures` all empty post-cutover). c7c7-c7c7-c7c7 namespace fully unused; ReissueQuote ceremony has clean room.

---

## §1.7 Known post-cutover state (Session 6 awareness, not blocker)

- **V6.B integrity-service drift.** `services/integrity.js` has field-set drift; integrity endpoints are 503-gated until fix. NOT a Session 6 blocker (Session 6 is WhatsApp commands + resolver — no integrity-service touch). **If any Session 6 implementation work touches `services/integrity.js` or its callers, coordinate with the V6.B fix first.**

---

## §2. V1 — Resolver implementation contract

**File to author:** `src/cil/quoteResolver.js` (sibling to `src/cil/quotes.js` and `src/cil/router.js`).
**Tests:** `src/cil/quoteResolver.test.js` following the unit/integration split (`describeIfDb` for DB-backed tests).

### §2.1 Public API

```js
async function resolveQuoteRef(rawText, { ownerId, tenantId, tz }) {
  // Returns one of:
  //   { kind: 'resolved',  quote_id, human_id, version_id }
  //   { kind: 'ambiguous', candidates: [{ quote_id, human_id, customer_name, total_cents, status, created_at }] }
  //   { kind: 'not_found', tried: ['human_id'|'customer'|'date'|'compound'] }
}
```

Every internal query MUST scope by `owner_id = $1` as the first predicate per `CLAUDE.md` fail-closed posture. Cross-tenant resolution is impossible by construction.

### §2.2 Deterministic ladder (per investigation §1.3)

| Rung | Strategy | Query shape | Action on result |
|---|---|---|---|
| 1 | `human_id` exact-regex extract | `WHERE owner_id=$1 AND human_id=$2` | 1 row → resolved; 0 rows → not_found (don't fall through; user typed explicit ID and was wrong) |
| 2 | Customer-name extract → ILIKE | `WHERE owner_id=$1 AND v.customer_snapshot->>'name' ILIKE $2 ORDER BY q.created_at DESC LIMIT 5` | 1 row → resolved; 2-5 → ambiguous; 0 → fall through |
| 3 | Date extract via `chrono-node` (existing dep) | `WHERE owner_id=$1 AND DATE(q.created_at AT TIME ZONE $tz) = $date` (or `qv.sent_at` if intent is "I sent") | 1 row → resolved; >1 → ambiguous; 0 → fall through |
| 4 | Compound: name + date | Apply rungs 2 + 3 together to narrow | Same disposition as rungs 2/3 |
| 5 | LLM scoring fallback (only if rungs 1-4 returned 0 OR >5 candidates) | LLM receives candidate list (top 5 by `created_at DESC` from rung 2); LLM scores; LLM does NOT query DB | Score → resolved; LLM rejection → ambiguous |

**Compliance:** North Star §14 (deterministic retrieval first; LLM never queries DB freely).

### §2.3 Stopword + extraction posture

- Strip command tokens and possessives: `["the", "a", "an", "lock", "void", "reissue", "quote", "for", "from", "'s"]` before name match
- Date extraction: pass raw text to `chrono-node` with `forwardDate: false` (interpret "Tuesday" as last Tuesday, not next)
- Both extractions run in parallel; resolver passes both to rung 4 if individual rungs returned ambiguous

### §2.4 Failure modes

| Mode | Behavior |
|---|---|
| `ownerId` missing | Throw `Error('owner_id required')` synchronously — caller bug; do not fail silently |
| `tenantId` provided but mismatches `ownerId`'s resolved tenant | Out of scope for resolver — caller is responsible for dual-boundary resolution upstream |
| LLM fallback unavailable (rate limit / network) | Return `kind: 'ambiguous'` with deterministic top-5 candidates; owner picks manually |
| `chrono-node` parse failure | Skip rung 3, continue to rung 4. Don't fail the whole resolution |
| Ambiguous reply not `1`/`2`/`3`/etc. | Caller's responsibility (resolver doesn't manage state); commands handler re-prompts once then cancels pending state |

### §2.5 Test plan (resolver)

| Block | Tests | DB? |
|---|---|---|
| Unit: stopword + extraction | 4-6 cases per arm | No |
| Unit: rung dispatch | "QT-…" → rung 1; "Anderson" → rung 2; "Tuesday" → rung 3; etc. — mock pg.query | No |
| Integration: rung 1 (human_id) | 1 hit / 0 hits | Yes |
| Integration: rung 2 (customer ILIKE) | 1 hit / 3 ambiguous / 0 hits | Yes |
| Integration: rung 3 (date) | sent vs created_at branch; 1 hit / 0 hits | Yes |
| Integration: rung 4 (compound) | name + date narrows ambiguous to 1 | Yes |
| **Cross-tenant isolation (BLOCKING)** | tenantA's ownerId cannot resolve tenantB's quote | Yes |
| LLM fallback (mocked) | candidate list passed without DB access | No |

Target: ~25 cases total.

---

## §3. V2 — WhatsApp command implementation contract

**File to author:** `handlers/commands/quoteSpine.js` (NEW; do NOT extend existing `handlers/commands/quote.js` per investigation §2.6 recommendation — the legacy file's `quote for ...` handler is documented as not persisting and conflicts conceptually with new `/command` slash syntax).
**Tests:** appended to `handlers/commands/quoteSpine.test.js` OR if the codebase pattern is one test file per handler, follow that.

### §3.1 Four commands per investigation §2.4 spec

| Command | Intent rule | Resolver use | CIL draft type | Target handler | Confirm flow |
|---|---|---|---|---|---|
| `/quote` (CreateQuote) | `/^\/quote\b/i` OR existing `^quote\s+for\b` (preserve back-compat) | Job + customer name lookup (existing `customers` and `jobs` tables) | `CreateQuote` | `handleCreateQuote` (registered `router.js:34`) | Render line-item summary + total. Owner replies `yes/edit/cancel` before `applyCIL` runs. |
| `/lock` (LockQuote) | `/^\/lock\s+/i` OR `/^lock\s+(quote\b\|QT-)/i` | Fuzzy `quoteResolver` | `LockQuote` | `handleLockQuote` (registered `router.js:38`) | "Lock QT-…-NNNN ($X, Customer)? This is irreversible. Reply yes/cancel." |
| `/void` (VoidQuote) | `/^\/void\s+/i` | Fuzzy `quoteResolver` | `VoidQuote` | `handleVoidQuote` (registered `router.js:39`) | "Void QT-…-NNNN? Reason: '<extracted reason>'. Reply yes/cancel." If no reason extracted, prompt: "Why? Reply with a brief reason or 'cancel'." |
| `/reissue` (ReissueQuote) | `/^\/reissue\s+/i` | Fuzzy `quoteResolver` (typically resolves to a voided quote) | `ReissueQuote` | `handleReissueQuote` (registered `router.js:40`) | "Reissue QT-…-NNNN as new draft? Reply yes/cancel." |

### §3.2 Confirm/edit flow (per investigation §2.3)

State key in `stateManager`: `pendingQuoteAction: { action, quote_id, human_id, voided_reason?, draft? }`. Stored under **`owner_id` (NOT `from`)**, per `CLAUDE.md` owner-boundary rule.

Decision-token regex (existing pattern at `handlers/commands/index.js:348-350`): `/^(yes|y|edit|cancel|cancel that|abort)\b/i`. Quote-spine handlers consume their pending-state decision tokens themselves (parallel to `handlers/commands/expense.js`, `revenue.js` posture) before the dispatcher's generic block runs.

### §3.3 Schema widening prerequisite (Decision A — Slice 1 schema task)

`src/cil/quotes.js:3946-3950` (LockQuoteCILZ) and `src/cil/quotes.js:4618-4622` (VoidQuoteCILZ) currently:

```js
source: z.literal('system'),  // Widens in Phase A.5 to z.enum(['portal','whatsapp','system'])
```

Change both to:

```js
source: z.enum(['portal', 'whatsapp', 'system']),
```

Plus update Zod tests in `quotes.test.js` for both schemas — one test per schema asserting all three values pass and `'email'` fails.

No data migration needed; `chiefos_quote_events.actor_source` is already `text` and accepts any string.

### §3.4 Pro-gate narrowing (per investigation §2.2)

`handlers/commands/index.js:330-341` currently has a regex `/agent|quote|metrics.../i` that blocks all quote text from non-Pro tiers. Two-pass split:

1. **Command pre-filter pass:** `/^\/(?:quote|lock|void|reissue|...)\b/i` — these route to handlers regardless of plan tier; the handlers themselves call plan checks if needed (G6 follow-through; CreateQuote already gates internally).
2. **Prose Pro-gate pass:** existing regex (preserved as-is for non-command quote text intent).

Order: command pass first; prose pass second; both before any handler dispatch.

### §3.5 CIL_TO_EVENT_ACTOR_SOURCE map widening (Slice 1 — task 6.0.4)

Already specified in §0 / Task 6.0.4. Also bind into V2 commands: when `data.source = 'whatsapp'` (the new commands' source), the existing `whatsapp: 'whatsapp'` map entry handles it. The `portal: 'portal'` entry is forward-compat for Session 7. Both must land in Phase 6.0 / 6.1 to ensure audit chain integrity.

### §3.6 Test plan (commands)

Per command, BLOCKING tests:
- **Cross-tenant isolation:** `req.tenantId` from middleware filters resolver scope; tenantA's command cannot affect tenantB's quote
- **Idempotency replay:** WhatsApp delivers same Twilio MessageSid twice; second call returns `meta.already_existed=true` (CreateQuote/Reissue) or `meta.already_locked=true` / `meta.already_voided=true` (Lock/Void state-machine path)

Per command, additional cases:
- Confirm-flow happy path (yes)
- Confirm-flow cancel (cancel)
- Confirm-flow timeout / state expiry
- Resolver miss (not_found) → user-facing error; no mutation
- Resolver ambiguous → disambiguation prompt; no mutation until reply
- State-machine illegal: `/lock` on draft → handler returns ILLEGAL_STATE; commands handler renders user-facing error
- Pro-gate split correctness (`/quote` in free tier still routes through handler; handler enforces plan gate; non-command "quote" prose still gated)

Target per command: 6-8 cases × 4 commands = ~30 cases.

---

## §4. Production rollout posture (replaces ceremony §)

A.5 Slice 1 has no formal §-numbered ceremony in the QUOTES_SPINE_CEREMONIES.md sense (commands are user-facing wrappers around already-ceremonialized handlers). Rollout posture instead:

1. **Internal staging:** Founder triggers each command from a personal WhatsApp conversation against staging (`xnmsjdummnnistzcxrtj`); verifies confirm flow + execution + audit row; captures one transcript per command.
2. **Beta cohort (after staging green):** Roll to 1-3 beta tenants for a 48-hour soak. Watch `chiefos_quote_events` for anomalies. Watch Twilio logs for 11200s.
3. **Beta Pause Rule check:** If any of (tenant isolation, idempotency, plan gating, transport stability) regresses during the 48-hour window, pause Session 6 close until restored.
4. **Full beta:** Enable for all beta tenants once 48-hour soak is clean.

Rollout transcript captured in a new `docs/_archive/sessions/SESSION_PHASE_A_6_SLICE_1.md` at session close.

---

## §5. Dependency graph (opening tasks → V1/V2)

```
                 ┌──────────────────────────────┐
                 │ §0.3 Decisions A–D APPROVED  │
                 │      (commit 0fbb97c1)       │
                 └────────────┬─────────────────┘
                              │
                              ▼
                 ┌──────────────────────────────┐
                 │ Task 6.0.0 — HARD GATE       │
                 │ Cutover handoff verification │
                 │ Sentinel:                    │
                 │   docs/PHASE_5_CUTOVER_      │
                 │   COMPLETE.md commits        │
                 └────────────┬─────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────────┐
│ Task 6.0.4   │    │ Task 6.0.3   │    │ Task 6.0.1       │
│ Map widen    │    │ seedVoided   │    │ Verify migration │
│ (no DB)      │    │ Quote fix    │    │ on CHiefOS +     │
│              │    │ (no DB)      │    │ Chief disposition│
└──────┬───────┘    └──────┬───────┘    └────────┬─────────┘
       │                   │                     │
       │                   │                     ▼
       │                   │            ┌──────────────────┐
       │                   │            │ Task 6.0.2       │
       │                   │            │ Ceremony first-  │
       │                   │            │ run on CHiefOS   │
       │                   │            └────────┬─────────┘
       │                   │                     │
       └───────┬───────────┴───────────┬─────────┘
               │                       │
               ▼                       ▼
       ┌───────────────────────────────────────┐
       │ Phase 6.1 — V1 + V2 implementation    │
       │                                       │
       │   6.1.1 Decision A schema widening    │ ← blocks /lock, /void from WhatsApp source
       │   6.1.2 src/cil/quoteResolver.js (V1) │ ← blocks all 4 commands' resolver use
       │   6.1.3 handlers/commands/quoteSpine  │ ← blocks command surface
       │   6.1.4 Pro-gate narrowing            │ ← blocks command dispatch in free tier
       └────────────────┬──────────────────────┘
                        │
                        ▼
       ┌───────────────────────────────────────┐
       │ Phase 6.2 — Tests + rollout posture   │
       │                                       │
       │   6.2.1 Resolver tests (~25 cases)    │
       │   6.2.2 Command handler tests         │
       │           (~30 cases)                 │
       │   6.2.3 Slice 1 commands rollout      │
       │           transcript                  │
       └───────────────────────────────────────┘
```

**Critical-path sequencing:**
- 6.0.0 (cutover sentinel) is a HARD GATE on every CHiefOS-touching task. 6.0.3 and 6.0.4 are repo-only and may run in parallel with 6.0.0 polling.
- 6.0.4 (map) is a prerequisite for `actor_source` to write correctly when 6.1.1 (schema widening) lands. If 6.1.1 lands without 6.0.4, integration tests with `source: 'portal'` will write `null` to `actor_source` and fail audit-chain assertions.
- 6.0.3 (fixture) is the test-pattern template for 6.2.2's command tests. Land before authoring command tests.
- 6.0.1 (verification + Chief disposition) is required for `/reissue` runtime. Migration was applied during parallel cutover; this is re-verification post-sentinel. 6.1.3 can implement the command shell first; only the integration test path requires 6.0.1 confirmed.
- 6.0.2 (ceremony, CHiefOS only) is independent of 6.1.x; can run in parallel once 6.0.0 + 6.0.1 land.

---

## §6. Out of scope

- V3 portal quote detail page (`chiefos-site/app/app/quotes/[quoteId]/page.tsx`) — Session 7
- V4 portal action API (`routes/quotesPortal.js`) — Session 7
- `chiefos_portal_quotes` view migration — Session 7 (Decision D conditionally approved; column-list review still pending founder)
- `mustOwner` middleware promotion to `middleware/requireOwnerRole.js` — Session 7
- New CIL types beyond Phase A's seven (`Create/Send/Sign/View/Lock/Void/Reissue`)
- Crew cluster modifications (quarantined; pending R3b)
- Actor-memory cluster modifications (quarantined; pending R4c)
- EditDraft handler (out of Phase A.5 scope per investigation; future phase)

---

## §7. STOP conditions

Halt and report to founder if:

- **§6.0.0 cutover sentinel does NOT commit within reasonable time.** If founder doesn't surface the sentinel within Session 6's working window, Session 6 is blocked — do not proceed to 6.1 implementation against CHiefOS without it.
- **§6.0.0 sentinel commits but CHiefOS schema is observed not-frozen** (new ALTER detected after sentinel). Re-coordinate before any 6.0.1+ work. Schema-frozen contract violation invalidates the handoff.
- **Namespace registry §1.6 catches a collision** during Session 6 work (e.g., a quote-spine row appears under a non-c7c7 prefix that wasn't reserved). Halt; investigate; reserve before continuing.
- Any opening task surfaces a Beta Pause Rule trigger (transport, isolation, idempotency, plan-gating regression)
- Decision A schema widening reveals an unexpected downstream consumer of `LockQuoteCILZ.source` or `VoidQuoteCILZ.source` that hard-codes `'system'` (grep should preempt this; if surfaced post-grep, halt)
- Pro-gate narrowing breaks an existing prose-quote-gated free-tier flow (existing tests must still pass; new split-gate tests must land in same PR as the narrowing)
- Resolver design surfaces a column the schema doesn't expose (e.g., the resolver needs `chiefos_quote_versions.sent_at` but the column doesn't exist as documented — verify against current schema before authoring)
- **V6.B integrity-service drift surfaces in any Session 6 implementation work** (per §1.7). Coordinate with V6.B fix before continuing.
- Integration tests for new commands cascade-fail post-6.0.3 fix (means the fixture template fix is incomplete; do NOT chase patches in Session 6 — fold into Session 7 pre-flight)
- Any of the four V1/V2 specs in `PHASE_A5_INVESTIGATION.md` materially conflict with current code state (handler signature drift, router shape change, etc.) — verify before authoring

---

## §8. Success criteria (definition of done)

### Phase 6.0 (opening tasks)

- [ ] **Cutover sentinel `docs/PHASE_5_CUTOVER_COMPLETE.md` observed on main** (poll `git log main --oneline -- docs/PHASE_5_CUTOVER_COMPLETE.md`); schema-frozen declaration confirmed in content
- [ ] Namespace registry §1.6 cross-checked against parallel-session prefixes; any new prefix observed during cutover appended before 6.0.x writes
- [ ] `src/cil/quotes.js:105` map widened with `portal: 'portal'` entry
- [ ] ReissueQuote integration test #9 tightened from `[null, 'portal']` to strict `'portal'` and passing
- [ ] `seedVoidedQuote` rewritten to use `setupQuotePreconditions`; 9 ReissueQuote integration tests green
- [ ] Migration `2026_04_25_chiefos_quote_versions_source_msg_id.sql` verified on `tctohnzqxzrfijdufrss` (CHiefOS) via 3-artifact probe (column + index + trigger). Applied during parallel cutover; this is post-sentinel re-verification.
- [ ] Chief disposition decision recorded (decommission `xnmsjdummnnistzcxrtj` vs apply migration as parallel staging)
- [ ] `node scripts/real_reissue_quote_ceremony.js` first-run captured against **CHiefOS** (`tctohnzqxzrfijdufrss`); transcript appended to `docs/QUOTES_SPINE_CEREMONIES.md` §32.3 (replace template with actual output)
- [ ] Idempotent re-run verified (exit 0 with `meta.already_existed=true`)

### Phase 6.1 (V1 + V2 implementation)

- [ ] Decision A schema widening: `LockQuoteCILZ.source` + `VoidQuoteCILZ.source` → `z.enum(['portal','whatsapp','system'])`
- [ ] `src/cil/quoteResolver.js` authored per §2 (deterministic ladder)
- [ ] `handlers/commands/quoteSpine.js` authored per §3 (4 commands)
- [ ] `handlers/commands/index.js:330` Pro-gate split into command-pass + prose-pass
- [ ] All four commands wire through to existing Phase A handlers (CreateQuote / LockQuote / VoidQuote / ReissueQuote); no logic duplication

### Phase 6.2 (tests + rollout)

- [ ] Resolver tests (~25 cases) authored; cross-tenant isolation BLOCKING test passes
- [ ] Command handler tests (~30 cases) authored; cross-tenant + idempotency BLOCKING tests per command pass
- [ ] Internal staging transcript captured for each of the four commands
- [ ] 48-hour beta-cohort soak clean (or beta paused per §7 STOP if any regression)
- [ ] `docs/_archive/sessions/SESSION_PHASE_A_6_SLICE_1.md` session report (≤50 lines) authored
- [ ] `CHIEFOS_EXECUTION_PLAN.md` updated with Slice 1 close marker
- [ ] `PHASE_A5_INVESTIGATION.md` Addendum §8 extended with Slice 1 implementation deltas (or "no deltas" note)

---

## §9. Files anticipated to touch

**New:**
- `src/cil/quoteResolver.js`
- `src/cil/quoteResolver.test.js`
- `handlers/commands/quoteSpine.js`
- `handlers/commands/quoteSpine.test.js` (or appended to existing)
- `docs/_archive/sessions/SESSION_PHASE_A_6_SLICE_1.md`

**Modified:**
- `src/cil/quotes.js` — Decision A widening (LockQuoteCILZ + VoidQuoteCILZ source); CIL_TO_EVENT_ACTOR_SOURCE map widening
- `src/cil/quotes.test.js` — Zod tests for widened schemas; tighten ReissueQuote integration test #9; rewrite `seedVoidedQuote`
- `handlers/commands/index.js` — Pro-gate split + new command registration
- `docs/QUOTES_SPINE_CEREMONIES.md` — §32.3 actual first-run transcript
- `CHIEFOS_EXECUTION_PLAN.md` — Slice 1 close checkbox
- `PHASE_A5_INVESTIGATION.md` — Addendum §8 Slice 1 deltas

**Out of scope (verify NOT touched):**
- `routes/portal.js`, `routes/quotesPortal.js` (doesn't exist; Session 7)
- `chiefos-site/**` (Session 7)
- `migrations/**` (no new migrations in Session 6 unless an opening task surfaces drift requiring schema change)
- Crew or actor-memory cluster files (quarantined)

---

## §10. Pre-flight (before opening Session 6)

- Verify current main HEAD includes Phase A close commit (`812ac55f`) — done as of this directive's authoring
- Verify `PHASE_A5_INVESTIGATION.md` §0.3 cells flipped to APPROVED (commit `0fbb97c1`) — done
- **Poll for cutover sentinel `docs/PHASE_5_CUTOVER_COMPLETE.md`** before any 6.0.x task that touches CHiefOS — see §6.0.0 in `SESSION_6_OPENING_TASKS.md`
- Read `SESSION_6_OPENING_TASKS.md` (sibling file) for full opening task specs
- Read this directive's §1 Decisions Carried Forward for verbatim approval text — eliminates cross-doc lookup during 6.1 implementation
- Read this directive's §1.5 inter-session write protocol + §1.6 namespace registry + §1.7 known post-cutover state — these gate ALL CHiefOS interactions
- Light-touch read of `PHASE_A5_INVESTIGATION.md` §1 (V1 resolver) and §2 (V2 commands) for spec details not duplicated here
- DO NOT load `docs/QUOTES_SPINE_DECISIONS.md` (large; not needed for Slice 1 — no new §17.N formalizations expected)

---

## §11. Follow-up: protocol promotion (post-Session-6)

The §1.5 inter-session write protocol + §1.6 namespace allocation registry + §6.0.0 sentinel-handoff pattern are interim disciplines, currently scoped to Session 6 artifacts because they emerged organically from the parallel-session coordination during this session. They should be promoted to a permanent home AFTER Session 6 lands so future sessions inherit them automatically.

### Recommendation

**Promote to a new file: `docs/MULTI_SESSION_COORDINATION.md`.**

Rationale: CLAUDE.md is already the canonical context-budget-binding doc and runs ~250 lines after the Pass 2 token-bloat cleanup. Inlining inter-session coordination protocol there would re-bloat it. A dedicated `docs/MULTI_SESSION_COORDINATION.md` (referenced from CLAUDE.md by a one-line pointer) keeps CLAUDE.md focused on its identity-model + CIL-discipline core while making coordination protocol discoverable.

### Promotion plan

1. **Trigger:** post-Session-6 close (after Slice 1 ships and the protocol has been exercised once in production).
2. **Scope:** create `docs/MULTI_SESSION_COORDINATION.md` containing:
   - Inter-session write protocol (six rules from §1.5 — sentinel handoff, namespace registry, schema-frozen contract, read-only posture, co-existence with seed, no backfill gating)
   - Namespace allocation registry (live-tracked table; canonical authority for UUID prefix reservations across all sessions)
   - Sentinel commit pattern spec (commit message format, content requirements, poll command)
   - Schema-frozen contract definition (what counts as frozen, what counts as breaking the freeze)
3. **CLAUDE.md change:** add a one-line pointer to the new file under "Current Reference Docs" section. Mark as "load only when running concurrent Claude Code sessions against shared resources."
4. **Session 6 directive cleanup:** after promotion, replace §1.5 / §1.6 in this directive with a one-line pointer to `docs/MULTI_SESSION_COORDINATION.md`. §1.7 (known post-cutover state) stays inline because it's session-specific awareness, not a reusable protocol.
5. **Single small commit:** `docs(coordination): extract inter-session write protocol from Session 6 directive`. No code changes; pure doc extraction.

### Why not promote now (before Session 6 ships)

- The protocol hasn't been exercised under load. Session 6 is the first concrete test. If Phase 6.0.0 sentinel poll fails or the namespace registry misses a collision case, we'll learn something the doc would otherwise need to be revised for.
- Founder has Option 1/2/3 review pending on this directive. Promotion is a post-review optimization, not a prerequisite for Session 6 implementation.
- Keeping protocol inline during Session 6 increases its visibility to whoever opens the directive — they read the protocol once, in context. Once promoted, it becomes background discipline.

### Acceptance criterion for promotion

After Session 6 closes (Slice 1 shipped + soak clean), founder confirms:
- The §6.0.0 sentinel handoff worked as specified (no cutover-state ambiguity surfaced during 6.0.x execution)
- Namespace registry caught no collisions (or any collisions caught surfaced cleanly via the registry's append-before-write rule)
- Protocol additions/refinements (if any) folded back into the promoted version

If any of these fail, refine the protocol in-place at the §1.5/§1.6 location for one more session, then re-attempt promotion.
