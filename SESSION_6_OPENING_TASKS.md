# Session 6 Opening Tasks

**Date:** 2026-04-26 (last revision)
**Author:** Claude Code (foreground execution of /schedule pre-flight + drafting; revised after parallel-session coordination contract resolved)
**Source:** Mixed verification of Session-5 follow-ups + parallel cutover-session coordination.
**Pivot:** Founder elected to fold all four follow-ups into Session 6 as opening tasks (Phase 6.0) rather than fix-in-place via separate work.

---

## Verification snapshot (2026-04-26)

Two snapshots are tracked because state changed during this session as the parallel cutover session ran additional schema-apply work in CHiefOS:

| Gate | Status (gate-verification snapshot, ~14:00 UTC) | Status (post-coordination snapshot, ~03:00 UTC next day) | Evidence |
|---|---|---|---|
| Pre-flight: §0.3 Decisions A–D APPROVED | **PASS** | **PASS** | All four cells flipped at commit `0fbb97c1`; verified verbatim against source on main |
| (a) Migration applied to staging | **FAIL** | **CONDITIONAL PASS** (pending sentinel) | At gate-verification: "Chief" (`xnmsjdummnnistzcxrtj`) had 36 `chiefos_*` tables but no source_msg_id column/index/trigger; "CHiefOS" (`tctohnzqxzrfijdufrss`) had zero `chiefos_*` tables. **At post-coordination probe: CHiefOS has 23 `chiefos_*` tables, 37 migrations recorded including `2026_04_25_chiefos_quote_versions_source_msg_id` (version 20260426130216), source_msg_id column + chiefos_qv_source_msg_unique index + trg_chiefos_qv_source_msg_immutable trigger ALL present. Migration apply landed during parallel cutover-session work.** Conditional on sentinel commit `docs/PHASE_5_CUTOVER_COMPLETE.md` landing on main. |
| (b) Ceremony first-run captured | **FAIL** | **FAIL** | No commit matching `ceremony.*ReissueQuote` since 2026-04-25; `docs/QUOTES_SPINE_CEREMONIES.md` §32.3 contains only the spec template ("Expected first-run output (anonymized)"); no new file under `docs/_archive/sessions/`. |
| (c) Fixture fix + 9 integration tests | **FAIL** | **FAIL** | No commit to `src/cil/quotes.test.js` since 2026-04-25 (last touches are Session 4 work). Fix not landed; integration tests therefore still blocked. |
| (d) Map gap docket entry | **PASS** | **PASS** | Map at `src/cil/quotes.js:105` NOT widened (still `{whatsapp, web, system}`), but four docs reference the gap as Session 6 task: `docs/PHASE_A_CLOSE_HANDOFF.md:135`, `docs/_archive/sessions/SESSION_PHASE_A_5_REISSUEQUOTE.md:22`, `PHASE_A5_INVESTIGATION.md:603`, `PHASE_A_CLOSE_VERIFICATION_v2.md:117`. Second-signal criterion satisfied. |

Two FAILs + one CONDITIONAL PASS + two PASS = improved from initial mixed read; cutover handoff verification (§6.0.0) gates the final state.

---

## §0.5 Inter-session write protocol (new)

Two Claude Code sessions have been operating against the same logical workspace (CHiefOS Supabase project `tctohnzqxzrfijdufrss` + this git repo):

- **This session:** authored the Session 5 ReissueQuote handler + Session 6 opening artifacts. Read-only against CHiefOS.
- **Parallel cutover session:** authored Phase 5 cutover migrations apply + V3-V6 schema work + synthetic seed + cutover-checklist commits.

The two sessions had no shared context. CLAUDE.md does not document an inter-session write protocol. Until that protocol is promoted to a permanent location (see Directive §11 follow-up), Session 6 operates under this interim protocol:

1. **Sentinel-based handoff.** No CHiefOS write from Session 6 until parallel cutover session declares done via committing `docs/PHASE_5_CUTOVER_COMPLETE.md` to main. Poll command: `git log main --oneline -- docs/PHASE_5_CUTOVER_COMPLETE.md`.
2. **Namespace allocation registry.** Each session that writes UUID-prefixed seed/ceremony rows declares its namespace prefix in the registry (see §0.6) BEFORE writing rows under it. Collision-prevention by construction.
3. **Schema-frozen contract.** Once cutover sentinel commits, the parallel session declares CHiefOS schema frozen — no further `ALTER` / `CREATE` / `DROP` from cutover work. Session 6 builds against post-cutover state as-is.
4. **Read-only posture before sentinel.** This session may continue reading CHiefOS via Supabase MCP `execute_sql` (SELECT only) for verification probes. No `apply_migration`, `create_branch`, or write SQL.
5. **Co-existence with synthetic seed.** Production DB has V3-V5 synthetic seed (1 tenant, 5 users, 5 jobs, 20 transactions). Session 6 implementation work either coexists with seed (recommended) or scopes its own seed to UUIDs distinct from the §0.6 registry's V3 prefixes.

---

## §0.6 Namespace allocation registry (UUID prefix table)

Tracked across all Claude Code sessions writing UUID-prefixed rows to shared environments. Append-only. Each session reserves prefixes BEFORE writing. Collision-prevention authority lives here until promoted (see Directive §11).

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
| _(reserve here as Session 6 needs them)_ | TBD by Session 6 — append before writing | Session 6 |

**Session 6 obligation:** if any new test or ceremony work writes UUID-prefixed seed/ceremony rows, append the prefix + purpose to this table BEFORE the write lands. Most likely Slice-1 commands won't need new prefixes (they reuse Phase A Session 5 ceremony scaffolding); flag if surfaced.

---

## §0.7 Known post-cutover state (Session 6 awareness, not blocker)

- **V6.B integrity-service drift.** `services/integrity.js` has field-set drift; integrity endpoints are 503-gated until fix. NOT a Session 6 blocker (Session 6 is WhatsApp commands + resolver — no integrity-service touch). If any Session 6 implementation work touches `services/integrity.js` or its callers, **coordinate with the V6.B fix first.**

---

Three FAILs + one PASS = mixed.

---

## Opening tasks (Phase 6.0 — execute first in Session 6)

### Task 6.0.0 — Cutover handoff verification (NEW; hard gate)

**Work required:**
- Poll for the sentinel commit:
  ```bash
  git fetch origin
  git log main --oneline -- docs/PHASE_5_CUTOVER_COMPLETE.md
  ```
  Gate passes when this returns at least one commit. Expected commit message pattern: `docs(phase-5): cutover complete — production live on tctohnzqxzrfijdufrss`.
- Read the sentinel file. Confirm content includes: cutover datetime, production project ref (`tctohnzqxzrfijdufrss`), schema state summary (77 tables / 8 views / 133 functions / 56 triggers / 170 policies), known post-cutover items, schema-frozen declaration.
- Cross-check `list_migrations` against CHiefOS — final migration version should match what the sentinel claims.
- Confirm namespace allocation registry (§0.6) reflects all parallel-session prefixes; if any new prefix landed during cutover that isn't listed, append it before any Session 6 write.

**Verification check:**
- Sentinel commit exists on main: PASS / FAIL
- Schema-frozen declaration explicit in sentinel content: PASS / FAIL
- Namespace registry covers all observed seed prefixes: PASS / FAIL

**Dependency relationship to V1/V2:**
- HARD GATE on all of 6.0.1 / 6.0.2 / 6.0.3 / 6.0.4 and all 6.1 / 6.2 implementation work that touches CHiefOS.
- Until sentinel commits, this session is read-only against CHiefOS (SELECT-only execute_sql; no apply_migration; no ceremony script execution against staging).
- Founder is the authority that the sentinel = green-light. If sentinel commits but schema is observed not-frozen (new ALTER detected), STOP and re-coordinate.

### Task 6.0.1 — Verify migration on CHiefOS + Chief disposition (gate (a))

**Work required:**
- AFTER sentinel commits (§6.0.0), verify the Session 5 migration is applied on CHiefOS via the 3-artifact probe:
  ```sql
  SELECT
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema='public' AND table_name='chiefos_quote_versions'
              AND column_name='source_msg_id') AS column_exists,
    EXISTS (SELECT 1 FROM pg_indexes
            WHERE schemaname='public' AND tablename='chiefos_quote_versions'
              AND indexname='chiefos_qv_source_msg_unique') AS index_exists,
    EXISTS (SELECT 1 FROM pg_trigger
            WHERE tgname='trg_chiefos_qv_source_msg_immutable') AS trigger_exists;
  ```
  All three must return true. Post-coordination probe (~03:00 UTC) confirmed all three are true; this is a re-verification step against the sentinel-anchored state.
- Migration was applied on CHiefOS during the parallel cutover session — landed via the apply chain `f2bdc650 → fe67cbc1 → eb46a3be → 971ca0ea → 4dec6ddb → faa0da41 → 886b3044 → a39f2c06` per Q1 sentinel content.
- **Chief disposition decision:** founder decides whether to apply the migration to `xnmsjdummnnistzcxrtj` (the legacy environment with 1655 users / 1655 quotes / 0 transactions / 3 portal_users). Two options:
  - (a) Decommission Chief; skip migration apply. Recommend if Chief is being retired post-cutover.
  - (b) Apply migration to Chief as parallel staging. Migration is additive + idempotent + reversible; safe to apply with existing data (1655 quote_versions all source_msg_id=NULL; partial UNIQUE doesn't fire on NULL).
- Document Chief disposition decision in session report.

**Verification check:**
- 3-artifact probe on CHiefOS returns all true (already confirmed at post-coordination snapshot; this is re-verification post-sentinel).
- Chief disposition decision recorded in session report (decommission vs apply).

**Dependency relationship to V1/V2:**
- Blocks `/reissue` WhatsApp command runtime (V2.4 spec table — `/reissue` calls `handleReissueQuote` which expects the partial UNIQUE on `chiefos_quote_versions(owner_id, source_msg_id)` to exist).
- Does NOT block V1 resolver (resolver is read-only; doesn't write to versions).
- Does NOT block `/quote` (CreateQuote uses `chiefos_quotes_source_msg_unique`, already in place pre-Phase-A).
- Does NOT block `/lock` or `/void` (state-machine idempotency, not entity-table dedup).

### Task 6.0.2 — Run §32 ceremony first-pass against CHiefOS (gate (b))

**Work required:**
- AFTER 6.0.0 sentinel commits AND 6.0.1 verifies CHiefOS schema, execute `node scripts/real_reissue_quote_ceremony.js` against CHiefOS (`tctohnzqxzrfijdufrss`).
- **Target is CHiefOS only.** Do NOT run against Chief (`xnmsjdummnnistzcxrtj`) — Chief has 1655 real quote rows; synthetic ceremony rows under c7c7-c7c7-c7c7 namespace would mingle with real-user data and pollute audit/analytics queries. CHiefOS has 0 quote rows post-cutover; ceremony rows would be the first quote-spine data and are safely isolated.
- Capture transcript; expected exit code 0 with `meta.already_existed=false` on first run, `meta.already_existed=true` on second run (idempotent retry path).
- Append anonymized post-state output to `docs/QUOTES_SPINE_CEREMONIES.md` §32.3 (replace the "Expected first-run output" template with actual output).

**Verification check:**
- `git log` shows a commit since the work begins matching `ceremony.*ReissueQuote` OR `ReissueQuote.*ceremony` OR a session-archive file documenting the run.
- Re-running the script (without teardown SQL) returns exit 0 with `meta.already_existed=true`.

**Dependency relationship to V1/V2:**
- Soft-blocks Session 6 close (validates that ReissueQuote works against real production-shaped Postgres before owners hit `/reissue`).
- Does NOT block V1 or V2 implementation work — implementation can begin in parallel; ceremony is a release gate.

### Task 6.0.3 — Fix `seedVoidedQuote` fixture; re-run 9 integration tests (gate (c))

**Work required:**
- Locate `seedVoidedQuote` helper inside `src/cil/quotes.test.js` (in the `ReissueQuote — §2: handleReissueQuote (integration)` describe block, ~line 11189-11221 of the post-Phase-A-close file).
- Root cause is `varchar(20)` column overflow — likely the `human_id` field. Current pattern:
  ```js
  humanId: `QT-2026-04-${Math.floor(Math.random() * 9000 + 1000)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
  ```
  produces `QT-2026-04-XXXX-XXXX` = 20 chars exactly. Edge case at boundary; some random outputs may hit 21+ when 4-char base36 expands non-uniformly. **Recommend rewriting the fixture to use the existing `setupQuotePreconditions` helper** (used by 9 other handler test sections per `grep` evidence at lines 41, 623, 665, 737, 801, 851, 916, 1022, 1063, 1099). That helper uses `pg.allocateNextDocCounter` for human_id allocation — guaranteed conformant.
- After fixture fix lands, run:
  ```bash
  npx jest --testPathPattern="src/cil/quotes\.test\.js" \
    -t "ReissueQuote — §2: handleReissueQuote \(integration\)"
  ```
  All 9 integration tests must pass for clean closure.

**Verification check:**
- `git log --since="2026-04-26" -- src/cil/quotes.test.js` returns at least one commit since work begins.
- Integration test run: 9 of 9 ReissueQuote integration tests green.
- **Tolerance** (per /schedule spec): if fixture fix lands but new failures appear that DO NOT match the varchar(20) root cause, treat as "fixture fix landed but new failures detected" and fold the new failures into Session 6 as additional opening sub-tasks.

**Dependency relationship to V1/V2:**
- Does NOT block V1 or V2 implementation directly. The 9 ReissueQuote integration tests cover the existing handler, not new Slice 1 code.
- DOES block Session 6 close — new commands `/quote`, `/lock`, `/void`, `/reissue` need their own integration tests authored AND running. The `seedVoidedQuote` template will inform fixture design for the new commands' tests; fixing it first prevents copying a broken pattern into Slice 1's test suite.

### Task 6.0.4 — Widen `CIL_TO_EVENT_ACTOR_SOURCE` map (gate (d))

**Work required:**
- Edit `src/cil/quotes.js:105`. Add `portal: 'portal',` entry alongside the existing three:
  ```js
  const CIL_TO_EVENT_ACTOR_SOURCE = Object.freeze({
    whatsapp: 'whatsapp',
    web: 'portal',
    portal: 'portal',  // Phase A.5 Slice 1 — Decision A enum widening
    system: 'system',
  });
  ```
- Tighten ReissueQuote integration test #9 (`source enum widening`) to expect `'portal'` (not the tolerant `[null, 'portal']` pin currently in place). Currently at the bottom of `src/cil/quotes.test.js` ReissueQuote block.

**Verification check:**
- `grep "portal: 'portal'" src/cil/quotes.js` returns 2 lines (the existing `web: 'portal'` plus the new `portal: 'portal'`).
- ReissueQuote integration test #9 passes with strict `expect(rows[0].actor_source).toBe('portal')`.

**Dependency relationship to V1/V2:**
- BLOCKS V2 portal-source CIL event emission. Per Decision A, `LockQuoteCILZ.source` and `VoidQuoteCILZ.source` widen to `z.enum(['portal','whatsapp','system'])` — which means handlers will receive `data.source = 'portal'` from the (future, Session 7) portal action API. Without the map entry, `actor_source` writes as null in `chiefos_quote_events`, breaking the audit chain.
- BLOCKS V2 WhatsApp commands' actor_source for `/lock` and `/void` IF Session 6 also widens those schemas to accept `whatsapp` (which it does — Decision A schema task). The `whatsapp: 'whatsapp'` entry exists already, so this specific path is OK; the gap is the `portal` entry for future Session 7.
- Should land FIRST in Phase 6.0, before Decision A schema widening, so the audit pipeline is intact when widened schemas land.

---

## Recommended Session 6 sequencing

### Phase 6.0 — Opening tasks (gate-cleanup)

Order matters within 6.0:

1. **6.0.0** (cutover handoff verification — NEW HARD GATE) — sentinel poll. Until `docs/PHASE_5_CUTOVER_COMPLETE.md` commits to main, every other 6.0.x task that touches CHiefOS is blocked. This is fail-closed coordination per §0.5.
2. **6.0.4** (map widening) — pure code edit, no DB. Land second; lowest risk; can run in parallel with 6.0.0 polling because it's repo-only.
3. **6.0.3** (fixture fix) — pure test edit, no DB. Land third; required template for Slice 1 test suite. Can also run in parallel with 6.0.0.
4. **6.0.1** (verify migration on CHiefOS + Chief disposition) — re-verification probe AFTER sentinel commits. Land fourth.
5. **6.0.2** (ceremony first-run against CHiefOS) — depends on 6.0.0 + 6.0.1. Land last in 6.0; gates Session 6 close.

### Phase 6.1 — V1 resolver + V2 commands implementation

Per `PHASE_A5_INVESTIGATION.md` §1 (V1) and §2 (V2). Schema widening (Decision A) lands here as part of V2 prerequisite. Pro-gate narrowing at `handlers/commands/index.js:330` (per V2 §2.2).

Suggested commit boundaries within 6.1:
- 6.1.1: Decision A schema widening (`LockQuoteCILZ.source` + `VoidQuoteCILZ.source` → `z.enum(['portal','whatsapp','system'])`)
- 6.1.2: `src/cil/quoteResolver.js` (V1 deterministic ladder)
- 6.1.3: `handlers/commands/quoteSpine.js` (4 new commands `/quote /lock /void /reissue`)
- 6.1.4: Pro-gate narrowing (`handlers/commands/index.js:330` — split into command-pass + prose-pass)

### Phase 6.2 — Tests + ceremony for new commands

- 6.2.1: Resolver unit tests (`src/cil/quoteResolver.test.js`)
- 6.2.2: Command handler tests (`handlers/commands/quoteSpine.test.js` or extension to existing test files) — ~30-40 cases including cross-tenant + idempotency BLOCKING tests per command
- 6.2.3: `/quote` and `/reissue` may warrant their own ceremony scripts if behavior diverges from CreateQuote / ReissueQuote ceremonies (likely not — these are thin wrappers; one combined "Slice 1 commands ceremony" probably sufficient)

---

## Out of scope for Session 6 (Session 7 territory)

- V3 portal quote detail page (`chiefos-site/app/app/quotes/[quoteId]/page.tsx`)
- V4 portal action API (`routes/quotesPortal.js` + `POST /api/quotes/:quoteId/{lock,void,reissue}`)
- `chiefos_portal_quotes` SECURITY INVOKER view migration (Decision D — column list still pending founder review)
- `mustOwner` middleware promotion (`middleware/requireOwnerRole.js`)

These are documented in `PHASE_A5_INVESTIGATION.md` §3 (V3) and §4 (V4); Session 7 directive will draft against those specs once Session 6 ships and produces user signal.
