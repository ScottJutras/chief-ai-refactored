# ChiefOS — Execution Plan (Gap-Closing Sprint)

Version: 1.4
Status: Active — Phase 1 🔄 PARTIAL (§1.2 re-opened 2026-04-18) | Phase 2 ✅ COMPLETE | Phase 3 IN PROGRESS
Owner: Scott Jutras
Last Updated: 2026-04-18
Depends on: North Star v4.0, Execution Playbook v4.0, Engineering Constitution v4.0

---

## Purpose

This plan exists to close the gap between what ChiefOS is today and what it must be to replace the fragmented SaaS stack contractors currently pay for. The positioning is clear: CRMs track customers. ChiefOS tracks whether those customers made you money.

To own that positioning, ChiefOS must absorb the best, most useful features from the tools contractors actually use — Expensify, timeclock apps, spreadsheets, CompanyCam, QuickBooks basics, payroll visibility, invoicing tools, and quote builders — without becoming bloated. Every feature must tie back to jobs and financial reality.

**Working rule:** If Claude Code suggests work outside the current phase, refuse it. Mark it for a future phase and continue. No drift.

---

## How To Use This Plan

1. This file lives in the project root alongside CLAUDE.md
2. CLAUDE.md must reference this file so every Claude Code session knows the current phase
3. At the start of each session, state which phase and which item you are working on
4. Mark items ✅ as completed, with the date
5. Never skip ahead to a later phase unless every item in the current phase is ✅ or explicitly deferred with a reason
6. Each phase ends with a "Phase Gate" — conditions that must be true before moving on
7. Weekly review: Every Sunday, read this file top to bottom. Ask: "Am I still in the right phase? Is anything blocking the phase gate?"

---

## Phase 1 — Financial Reality Engine ✅ COMPLETE

**Goal:** Make ChiefOS the single place a contractor needs to understand whether their jobs make money. This is the product promise. Nothing else matters until this works.

### 1.1 — Job Profitability Summary (Ask Chief)
- ✅ Deterministic job financial summary tool: total revenue, total expenses, total labor cost, net margin — per job *(2026-04-10 — `services/agentTools/jobPnl.js`)*
- ✅ Labor cost calculation using owner-configured hourly rates per employee *(2026-04-10 — joins `chiefos_crew_rates` in `job_kpis.js`)*
- ✅ Natural language response: "Job 47 brought in $8,200 against $3,100 in materials and $2,800 in labor. You netted $2,300 — a 28% margin." *(2026-04-10)*
- ✅ Handle missing data gracefully: "Set labor rates with `set rate [name] $X/hour` for full job P&L" *(2026-04-10)*
- ✅ Multi-job summary: "How did I do this week?" returns jobs with margin breakdown *(2026-04-10 — agent ask() fallback)*
- ✅ Comparative context: "That's below your average of 34% across similar jobs" *(2026-04-10 — `services/agentTools/ownerBenchmarks.js`, auto-called after job P&L answers)*

### 1.2 — Quote-to-Actual Loop (🔄 RE-OPENED 2026-04-18 per Beta Delta Appendix)

The pre-sprint Quotes spine was a ghost build: tables existed, portal UI was wired up,
`/api/documents/{upload,send,sign}` endpoints shipped, but the tables were never
populated in production (verified: 0 rows across `quote_line_items`, `job_documents`,
`job_document_files`, `change_orders`, `customers`, legacy `public.quotes`). The
`domain/quote.js` write path was broken (referencing columns that didn't exist on
the legacy table). The customer flow used to close Darlene MacDonald's job was built
in a separate standalone repo (`mission-quote-standalone`), not inside ChiefOS.

This item is re-opened. The new spine is being built per the Beta Delta Appendix:
  - Dual-boundary identity (`tenant_id` uuid + `owner_id` text) on every new table.
  - Header + immutable versions model; signed/locked versions protected by DB triggers.
  - Server-authoritative SHA-256 hash over a canonical serialization of each version.
  - Token-based share links (single-purpose, expiring) replacing slug-as-secret.
  - CIL enforcement on sign: Ingress → CIL Draft → Validation → Domain Mutation.
  - Starter+-only plan gating with monthly quota in `usage_monthly_v2`.
  - Dedicated events table (`chiefos_quote_events`) — first in the repo.

Reference: `C:\Users\scott\Documents\mission-quote-standalone\QUOTES_HANDOFF_TO_CHIEFOS.md`
for the UX/visual spec. Nothing is ported from the pre-sprint schema; the only
known reader (`services/agentTools/compareQuoteVsActual.js`) is rewritten in the
same PR as the first migration.

Architectural decisions locked for this work: see `docs/QUOTES_SPINE_DECISIONS.md`.

Items:
- [x] `compare_quote_vs_actual` agent tool (joins quotes × actuals × time_entries) — WORKS against the new spine after rewrite *(2026-04-10, rewritten 2026-04-18)*
- [x] Pattern detection ("Your last 5 bathroom renos averaged 15% over quoted labor") — unchanged *(2026-04-10 — `services/agentTools/jobPatternTrends.js`)*
- [x] Migration 1: `chiefos_quotes`, `chiefos_quote_versions`, `chiefos_quote_line_items`, triggers (immutability + cross-table parent-lock + header identity), composite dual-boundary FKs, tenant-scoped RLS *(2026-04-18 — applied as `chiefos_quotes_spine_20260418`; 12/12 verification tests passed; see `docs/QUOTES_SPINE_DECISIONS.md` §10)*
- [x] Migration 2 (events): `chiefos_quote_events` (append-only audit stream), global sequence, scoped-immutability trigger (DELETE forbidden, `prev_event_hash`/`triggered_by_event_id` fill-once on UPDATE), dual-boundary composite FKs, `chiefos_all_events_v` cross-doc view *(2026-04-18 — applied as `chiefos_quote_events_20260418`; 10/10 verification tests passed; see `docs/QUOTES_SPINE_DECISIONS.md` §13)*
- [x] Migration 3 (share tokens): `chiefos_quote_share_tokens` with bearer-token model (128-bit base58, 30-day absolute expiry, timestamp-derived state, recipient snapshot, dual-boundary composite FKs, fill-once lifecycle trigger); backfilled deferred FK `chiefos_qe_share_token_fk` on `chiefos_quote_events` *(2026-04-18 — applied as `chiefos_quote_share_tokens_20260418`; 16/16 verification tests passed; see `docs/QUOTES_SPINE_DECISIONS.md` §15)*
- [x] Migration 4 (signatures): `chiefos_quote_signatures` with strict-immutability, composite dual-boundary FKs to version + event + share token, `name_match_at_sign` + `recipient_name_at_sign` + `share_token_id NOT NULL`; `chiefos_all_signatures_v` view (excludes PNG + source_msg_id); backfilled composite FK `chiefos_qe_signature_identity_fk`; extended `chiefos_qe_kind_enum` with `integrity.name_mismatch_signed`; RLS harmonization on versions + line_items per §11.0. Correction 4b: relaxed `chiefos_qe_payload_signed` CHECK (signature_id ceremonial per §14.10) *(2026-04-18 — applied as `chiefos_quote_signatures_20260418` + `chiefos_qe_payload_signed_relax_20260418`; 20/20 verification tests passed; see `docs/QUOTES_SPINE_DECISIONS.md` §16)*
- [x] **CIL platform architecture (pre-CreateQuote scaffolding)**: created `src/cil/router.js` facade per §17.4–§17.7 + §17.12 (static `Object.freeze`-sealed new-idiom map, legacy delegation via runtime `require`); created `src/cil/utils.js` with `classifyUniqueViolation(err, {expectedSourceMsgConstraint})` per §17.10; migrated caller imports (`handlers/commands/index.js`) from `services/cilRouter` → `src/cil/router` per §17.7; wired Constitution §9 error envelope at both routers per §17.6 *(2026-04-18 — applied in commits `d87c59b9` (scaffolding) + `e87ad05a` (§17.12 refactor to frozen map); 17 tests passing; see `docs/QUOTES_SPINE_DECISIONS.md` §17.12)*
- [x] **CreateQuote design decisions locked (C4/C5/C6/C7 session — 2026-04-19).** Input contract per §20 (customer either/or no-auto-match; job required resolved in-transaction; line items min 1; title required + scope optional; `tax_rate_bps` required no default with totals server-computed; payment terms caller-supplied; snapshots split with `TenantSnapshotZ`/`CustomerSnapshotZ` shapes defined). Plan gating per §19/§17.16 (`canCreateQuote` + `gateNewIdiomHandler` helper; Starter 50/mo, Pro 500/mo; counter `quote_created`). Return shape per §17.15 (`{ ok, <entity>, meta }` family-wide contract; `meta.traceId` non-null; `meta.already_existed` source_msg_id-granular idempotency). Actor gating per §17.17 (owner-only, handler-runtime enforcement). Pre-transaction validation sequence: Zod → §17.16 plan gate → §17.17 actor check → §17.14 transaction. C7 grep completed — `public.audit` has no quote-relevant consumers. Commits: `f8bd732d` (C5+C7+§17.16+§19), `dff8a71c` (C4+§17.17+§20), *(this commit)* (C6+§17.15).
- [x] **Migration 5 — `chiefos_tenant_counters` generalization (APPLIED 2026-04-20).** Added `counter_kind` discriminator, renamed `next_activity_log_no` → `next_no`, composite PK `(tenant_id, counter_kind)`, format-only CHECK per §18.4. Replaced `allocateNextActivityLogNo` with generic `allocateNextDocCounter(tenantId, counterKind, client)` in `services/postgres.js`; added `COUNTER_KINDS` frozen constant at `src/cil/counterKinds.js`. `bumpTenantCounterToMax` correctness fix applied at `services/crewControl.js:53-54` (required under composite PK). 10/10 SQL verification tests passed + T12 `bumpTenantCounterToMax` correctness-fix verification. Discovered MCP parse-time limitation (documented §18.5); applied via split `execute_sql` calls rather than single `apply_migration` blob. *(Service code committed locally as `94516acb`, push pending user action; Migration SQL source-of-truth at `migrations/2026_04_20_chiefos_tenant_counters_generalize.sql`; see `docs/QUOTES_SPINE_DECISIONS.md` §18 applied record.)*
- [x] **CreateQuote handler (COMPLETE 2026-04-19).** `src/cil/quotes.js` with `handleCreateQuote` + `CreateQuoteCILZ` + `TenantSnapshotZ` + `CustomerSnapshotZ` fully implemented across 7 sections: (1) customer resolution per §20 Q1 no-auto-match, (2) job resolution per §20 Q2 + §17.17 addendum 3 unified-error pattern, (3) `computeTotals` + `allocateQuoteHumanId` (`QT-YYYY-MM-DD-NNNN`) + snapshot composition, (4) header + version + line-items INSERTs per §17.14 NULL-then-UPDATE, (5) `current_version_id` UPDATE pointer swing, (6) `lifecycle.created` + `lifecycle.version_created` event emission per §17.14 step 5, (7) classifyCilError 4-kind outer catch + post-commit counter increment + §17.15 return shape + §17.12 frozen-map registration. 72 tests passing; first real quote **`QT-2026-04-19-0001`** persisted in Mission Exteriors tenant via `scripts/real_create_quote_mission.js` (commit `e6b856d7` + `5fd11647`; see `docs/QUOTES_SPINE_DECISIONS.md` §21 for full commit chain + verification dump).
- [x] **SendQuote handler (COMPLETE 2026-04-19).** Second new-idiom handler. 7 sections across commits `c2c889dd` → `476eff27` (+ `534a1422` bs58 dep): (1) SendQuoteCILZ + QuoteRefInputZ, (2) loadDraftQuote with dual-boundary scope + QUOTE_NOT_DRAFT state check, (3) resolveRecipient (override > snapshot > RECIPIENT_MISSING), (4) generateShareToken (bs58.encode(randomBytes(16)) → 22-char base58) + insertShareToken (30-day absolute expiry per §14), (5) markQuoteSent (header + version UPDATEs) + emitLifecycleSent, (6) Postmark dispatch with paired notification.sent/notification.failed post-commit (Refinement B — do NOT rethrow on Postmark failure), (7) orchestration + multi-entity §17.15 return shape `{quote, share_token, meta}` + router registration. 101 tests passing. First real SendQuote delivered **`QT-2026-04-19-0001` to scott.tirakian@gmail.com** (Postmark MessageID `a52b14f7-eb77-4929-a2db-6d4e167303b8`, share URL `https://app.usechiefos.com/q/XPtBaAPL5VAm7zRRJb9onA`) via `scripts/real_send_quote_mission.js`. See `docs/QUOTES_SPINE_DECISIONS.md` §22 for full commit chain + verification dump + three candidate principles flagged for SignQuote validation.
- [x] **SignQuote Phase 1 — canonical-serialization algorithm (COMPLETE 2026-04-19).** `computeVersionHash` + frozen field lists + string-arithmetic `qtyToThousandths` + defensive-assertion preconditions implemented in `src/cil/quoteHash.js`. §4 exhaustive clarification (§4.A–§4.K) committed. 52 unit tests passing including cross-version regression lock. Pinned hex: `e9088c36066a73a9cee9efcdb59f2748b4ca5040134d21ba5cb37e8327e77d51`. Commits `914ad319` (§4), `94ad0b39` (impl+tests).
- [x] **SignQuote Phase 2A — Storage architecture decisions locked (COMPLETE 2026-04-19).** Seven question-rounds (Q1–Q7) established ChiefOS-wide convention for audit-kind artifact storage: dedicated bucket per kind + tenant-first path + combined self-describing storage_key (Q1); unified proxied-streaming access posture with 60s server-internal TTL (Q2); helper-built + helper-parsed format with DB CHECK mirror + strict-immutable write-path sequencing (Q3); four-invariant audit-kind upload checklist — structural validation + size bounds + content integrity + immutability (Q4); retrieval helper contract with "NEVER returns signed URLs to callers" invariant + two-query split for public path + enumeration-minimizing error taxonomy (Q5); indefinite retention + two-direction orphan handling + pre-declared `integrity.storage_missing` event schema + privacy-erasure runbook flag (Q6); module shape `src/cil/quoteSignatureStorage.js` + DI posture + bucket provisioning contract (Q7). §25 composed in `docs/QUOTES_SPINE_DECISIONS.md` — ~500 lines of prose-form rationale covering all seven sub-sections. Rules template forward to future audit-kind artifacts (PDFs, logos) without feature-specific bias.
- [x] **SignQuote Phase 2B — Storage helper implementation (COMPLETE 2026-04-19/20).** `src/cil/quoteSignatureStorage.js` + test suite (158 passing) across 6 section commits: constants + format helpers (Section 1), PNG validation + SHA-256 (Section 2), upload + cleanup + Supabase error classifier (Section 3), retrieval helpers portal + public (Section 4), DB CHECK micro-migration with drift-detection test (Section 5), module surface finalization with Q7 contract test (Section 6). Migration 6 applied to production via Supabase MCP; `chiefos_qs_png_storage_key_format` CHECK live. `chiefos-signatures` bucket provisioned via Supabase dashboard: private, 2 MB limit, `image/png`-only MIME, no RLS. See `docs/QUOTES_SPINE_DECISIONS.md` §25 for architectural spec; Section commits `eec849bc` → `a11e6bd4` → `f595fea1` → `545ea54b` → `94d12c0e` → `c12f4a76`.
- [x] **SignQuote Phase 2C — Storage pipeline ceremony (COMPLETE 2026-04-20).** Four ceremony scripts (`scripts/ceremony_*_phase2c.js`) exercise `uploadSignaturePng` + `getSignatureForOwner` + `getSignatureViaShareToken` end-to-end against production Supabase Storage + Postgres with synthetic ceremony rows. Fixture: real 137-byte 1×1 grayscale PNG with tEXt metadata self-labeling the file. SHA-256 `7d4f0f5664e7e5942629cb6c8ccdeff04ad95178c2da98f8197056f8bad0d977` verified byte-identical on upload, portal retrieve, and public retrieve. Audit context fields populated correctly on public path. Two FK / type issues surfaced (jobs.owner_id FK to users; jobs varchar/text param-reuse) — both fixed in seed script. See §26 for full artifact record.
- [x] **SignQuote Phase 3 — handler implementation + real-write ceremony (COMPLETE 2026-04-21).** Third new-idiom CIL handler, first customer-initiated handler in production. Six commits across six sections: schema + SIG_ERR extensions (Section 1), name-match module (Section 2), loadSignContext + shared share-token resolver (Section 3), transaction-body helpers (Section 4), handler orchestration with 23-step sequence + post-commit paired events (Section 5), router registration + production ceremony (Section 6). Production ceremony verified: signature `8b9b982d-6268-4da8-b25e-5cf29228d197` committed with server_hash `1e12cc5287c6edc79c9990a3aee47dab30598ddafea0816ea25b058e8b648485` (first Phase-1-to-Phase-3 integration artifact), correlation_id `06cc4c9e-6406-4ffe-8de3-40f5c0af362d` threaded through `lifecycle.signed` + `notification.sent` events, Postmark MessageID `37336e10-0bd5-43f3-9b2d-e31f73ff7a2a`. Six session-close formalizations landed in decisions log: §17.19 (post-commit paired notifications), §17.20 (pre-BEGIN external write for strict-immutable INSERT), §17.21 (correlation_id wiring), §17.22 (invariant-assertion discipline), §14.11 (customer actor role auth-orthogonal), §14.12 (customer actions not plan-gated), §11a refinement (NAME_MATCH_RULE_ID in payload). See `docs/QUOTES_SPINE_DECISIONS.md` §27 for full ceremony artifact. Section commits: `ba731315` → `4ba05486` → `3353011c` → `7db945e2` → `45ea71d1` → `3c5b6e9d` (Commit 1 router+scripts) + Commit 2 §27+formalizations+storage_key fix.
- [x] **ViewQuote handler (COMPLETE 2026-04-23).** Fourth new-idiom CIL handler, second customer-initiated handler in production. Sent→viewed state transition via share-token resolution. 311 tests passing (Section 4: 13 handler tests; Section 5: 26 composer unit tests). Router-registered in `src/cil/router.js` `NEW_IDIOM_HANDLERS`. Production ceremony validated: correlation_id `c83f405d-e8e6-4d70-9dd1-f33e0b7a909c` threaded through `lifecycle.customer_viewed` event; quote + version co-transitioned atomically (`quote.updated_at === version.viewed_at` — single-txn coherence). Prerequisite: SendQuote `markQuoteSent` version.status leak fixed pre-ceremony at `0dedea58`. Three new decisions-log formalizations landed at session close: §17.23 (state-driven idempotency + post-rollback re-read recovery; first exerciser ViewQuote), §17.24 (header-first ordering for dual-row state transitions), §17.25 (echo-if-present posture for Zod-optional audit fields); plus §3A amendment (co-transition between header and version status; voided-is-header-only asymmetry). See `docs/QUOTES_SPINE_DECISIONS.md` §28 for full ceremony artifact.
- [ ] **Next session candidates (flagged 2026-04-23; no decision required).** Three handlers remaining in the Quote state machine:
    1. *LockQuote handler* — signed → locked cosmetic transition. Small handler. Second §17.23 exerciser.
    2. *VoidQuote handler* — draft/sent/viewed/signed/locked → voided (terminal, header-only per §3A). Small-medium; third §17.23 exerciser.
    3. *ReissueQuote handler* — voided → new draft version. Triggers §17.20 again; populates `superseded_by_version_id`. Medium-size; may surface a §17.26 sub-amendment to §17.23 per ceremony caveat.
- [ ] CIL types remaining in quote spine: LockQuote, VoidQuote, ReissueQuote *(all extend `src/cil/schema.js::BaseCILZ` per §17.1; CIL-retry dedup via `(owner_id, source_msg_id)` UNIQUE on root entities per §17.8–§17.11; return shape family-wide per §17.15)*

#### Quote Spine — Product Extensions (Post Core Handlers)

Named future tracks surfaced during 2026-04-19 planning. NOT active
work — captured here so they don't get lost during the remaining
quote-spine handler sessions.

- **Ext 1 — Payment schedule in quote.** Structured dated milestone
  payments inside the quote version (e.g., "30% on acceptance, 40%
  at midpoint, 30% on completion"). Either folds into existing
  `payment_terms` JSONB or adds a `payment_schedule` field via
  migration. **Sized: small.** Rationale: helps contractors maintain
  cash flow without midstream begging for payment. **Target:**
  extension session after SendQuote lands, or folded into SendQuote
  session if time permits.

- **Ext 2 — Pro-tier Board + Admin can create quotes.** Revises
  §17.17 to make actor role checks plan-aware (currently owner-only
  for CreateQuote; Pro tier should admit Board Members and Admins).
  **Sized: medium.** Architectural decision touches every handler
  in the chain (SendQuote, SignQuote, LockQuote, VoidQuote,
  ReissueQuote all need consistent role-gating). **Target:**
  dedicated session after core handler chain lands — principles
  revise after the family exercises them, not before.

- **Ext 3 — Deposit Paid receipt.** New document type parallel to
  Invoice/Receipt. Own state machine, own human_id sequence
  (`DR-YYYY-MMDD-NNNN`), own handlers (CreateDepositReceipt,
  SendDepositReceipt). **Sized: large.** New CIL types, new
  migration, new handlers. Rationale: deposits are paid before work
  starts (covering materials); the receipt is a professional
  acknowledgment. **Target:** after quote chain complete, alongside
  invoice-spine work.

- **Ext 4 — Lead → Quote data flow.** When a Lead becomes a Quote,
  Lead's customer info pre-populates the quote. Primarily
  transport-layer (caller composes CreateQuoteCILZ from Lead data).
  **Sized: dependent on Leads work.** **Target:** after Leads spine
  lands (Beta Playbook item 7).

- **Ext 5 — Logo / branding upload.** Tenant uploads a logo that
  renders on customer-facing documents. Real tenant-profile DB
  table (replaces `src/config/tenantProfiles.js` bootstrap per §20
  addendum), Supabase storage for logo files, portal upload UI,
  signed-URL retrieval at render time. **Sized: multi-session
  track.** **Target:** after core handler chain + before heavy GTM
  push (logos are load-bearing for customer-facing artifact
  professionalism).

**Sequencing lean:**

1. SendQuote (this session)
2. Payment schedule (folded into SendQuote if time/scope aligns, else
   next session after SendQuote)
3. SignQuote, LockQuote, VoidQuote, ReissueQuote (sequential sessions)
4. Pro-tier Board/Admin quote creation (revises §17.17 across the
   family — after the family exists)
5. Tenant-profile DB table + logo upload (after handler chain; before
   GTM)
6. Deposit Paid receipt (parallel with or after invoice spine)
7. Lead → Quote flow (dependent on Leads spine)

Preserves the architectural discipline: revise principles after the
handler family exercises them, not before.
- [ ] Portal: quote builder UI wired to new spine, customer-facing view at `/q/:token`
- [ ] Plan gating: Starter+ entitlement in `src/config/planCapabilities.js`, quota counter in `usage_monthly_v2`
- [ ] Server PDF render on sign; Postmark email (contractor + customer); signed PDF stored in Supabase Storage

#### CIL migration tracking (per §17.3)

Visible count of legacy handlers still extending `cil.js::baseCIL`. When this
table reaches zero rows, `cil.js` is deleted and removal is logged in
`docs/QUOTES_SPINE_DECISIONS.md`. No deadline — reality indicator only.
`§17.2` migration trigger applies: any non-trivial change to a listed
handler migrates it to `src/cil/schema.js::BaseCILZ` as part of the same
change.

**Legacy handler inventory as of 2026-04-18 (six files, ten CIL types):**

| File | Legacy CIL types | Audit pattern | Migrated? |
|---|---|---|---|
| `domain/lead.js` | CreateLead | `public.audit` via `ensureNotDuplicate` + `recordAudit` | ☐ |
| `domain/agreement.js` | CreateAgreement | `public.audit` (partially stubbed on `cil.quote_id`) | ☐ |
| `domain/invoice.js` | CreateInvoice | TBD (verify when touched) | ☐ |
| `domain/changeOrder.js` | CreateChangeOrder | `public.audit` | ☐ |
| `domain/transactions.js` | LogExpense, LogRevenue | internal dedup in `insertTransaction` | ☐ |
| `domain/pricing.js` | AddPricingItem, UpdatePricingItem, DeletePricingItem | `ON CONFLICT DO NOTHING` | ☐ |

Retired: `domain/quote.js` (stub, throws `NOT_IMPLEMENTED`) — not counted.
Orphan: `domain/receipt.js` (not dispatched through `cilRouter.js`) — not
counted.

When a handler migrates: check the box above, update the decisions log
with the migration date, ensure tests cover the hardened input. When all
six files are migrated and `cilRouter.js` no longer imports from
`../cil`: delete `cil.js`, log the deletion as a `§17.3` event.

#### Deferred items discovered during CIL work

Small issues surfaced during CIL architecture / scaffolding sessions that
don't block CreateQuote but must not be lost. Each is filed with file:line
so the context survives memory reset.

- **Batch-receipts flow uses unregistered CIL type `CreateExpense`**
  (`handlers/commands/index.js:486`). Legacy `schemaMap` has `LogExpense`,
  not `CreateExpense`. Pre-existing bug: before the §17.6 envelope change
  this failed via thrown `Unsupported CIL type`; the `try/catch` at line
  ~500 silently treated items as failed. After the scaffolding session's
  §17.6 + caller update (envelope-aware `r.ok === false` check), behavior
  is preserved (still treated as failed) but the underlying bug remains.
  **Fix when batch-receipts is next touched:** either (a) change the
  `type:` to `'LogExpense'` and remap the payload shape to match
  `cilSchemas.LogExpense`, or (b) register a `CreateExpense` alias in the
  legacy router. Option (a) is cleaner — matches the rest of the codebase
  naming. Flagged here 2026-04-18 during CIL scaffolding session.

- **Future cleanup: `chiefos_quotes.chiefos_quotes_current_version_fk` is
  currently `DEFERRABLE INITIALLY DEFERRED`.** With §17.14's
  NULL-then-UPDATE pattern, no handler depends on deferral. A future
  migration can tighten this to `IMMEDIATE`, unifying FK behavior across
  the spine. Not blocking any feature; purely architectural cleanup —
  probably bundled with a future schema-hygiene migration, not urgent.
  Flagged 2026-04-18 during C2 decision session (§17.14).

- **SendQuote polish: branded From header.** Current
  `buildSendQuoteEmail` passes the raw address; Gmail displays
  `hello@usechiefos.com` instead of `"Mission Exteriors" <hello@usechiefos.com>`.
  Fix: compose `from` in the handler as `"${tenant_snapshot.brand_name}"
  <${POSTMARK_FROM_EMAIL}>` and pass through to `sendEmail({ from, ... })`
  (the helper already accepts `from`). ~5 lines of handler code + 1 test
  tweak. Low-cost polish; bundle with SignQuote session or a dedicated
  small commit. Flagged 2026-04-19 from SendQuote ceremony feedback.

- **Postmark link-tracking note (informational, not a ticket).** Ceremony
  email had share URLs wrapped by Postmark's click tracker
  (`track.pstmrk.it/...`) — Postmark's default. Wrapped URLs still 302
  to the actual `/q/:token` destination; bonus is click analytics per
  recipient. Configurable at Postmark dashboard → Settings → Outbound →
  Tracking. No code change required; documented here so future sessions
  inspecting delivered-email URLs aren't surprised by the wrapper.

- **C7 completed 2026-04-19 — `public.audit` consumer grep.** Live-tree
  hits: `services/audit.js:15` (`SELECT id FROM public.audit` inside
  `ensureNotDuplicate`) and `services/audit.js:31` (`INSERT INTO
  public.audit` inside `recordAudit`). Callers of the module:
  `domain/lead.js`, `domain/changeOrder.js`, `domain/agreement.js`. No
  quote-relevant consumers (no reader selects from `public.audit`
  expecting Quote operations); no test fixtures; `domain/quote.js` no
  longer calls the audit service. All hits are category (1) — legitimate
  legacy infrastructure; no action required until §17.3 fires
  (services/audit.js retires alongside `cil.js` when all legacy handlers
  migrate per §17.2). Visibility gap per §17.8 confirmed as non-blocking.

### 1.3 — Invoice Spine
- ✅ Invoice generation from quote (quote → invoice flow) *(pre-sprint — fully built)*
- ✅ Invoice PDF generation with branding *(pre-sprint)*
- ✅ Manual mark-paid *(pre-sprint)*
- ✅ Invoice status tracking: draft → sent → paid *(pre-sprint)*
- ✅ Revenue auto-reconciliation: when invoice marked paid, revenue entry created *(pre-sprint)*
- ✅ Change orders: signature required, creates new invoice version *(pre-sprint)*

### 1.4 — Receipt/Expense Capture (Expensify Replacement)
- ✅ Photo → OCR → extracted amount, vendor, date → "Which job?" → confirmed → persisted *(pre-sprint)*
- ✅ OCR accuracy validation *(pre-sprint)*
- ✅ Expense categories: materials, fuel, equipment rental, subcontractor, permits, other *(pre-sprint)*
- ✅ Mileage logging: "Drove 45km to Job 47" → calculated at CRA/IRS rate → attached as expense *(pre-sprint — `handlers/commands/mileage.js`)*
- ✅ Recurring expenses: `recurring $200/month storage unit` → creates `overhead_items` record, daily cron sends WhatsApp reminder on due date *(2026-04-10 — `handlers/commands/recurring.js`, `api/cron/overhead_reminders.js`)*
- ✅ Bulk receipt capture: multiple photos in sequence *(2026-04-10)*
  - ✅ Same-message multi-photo (NumMedia > 1): parallel OCR, numbered summary, job assignment prompt *(2026-04-10 — `handlers/media.js` `handleBulkMedia`, `routes/webhook.js`)*
  - ✅ Sequential batch mode: "batch receipts" → send photos one at a time → "done" → job assignment → bulk create *(2026-04-10 — `handlers/commands/batchReceipts.js`, `handlers/commands/index.js`)*
  - ✅ Portal multi-file upload UI: drag-and-drop panel on Inbox page, multi-select, deduplication, refresh on complete *(2026-04-10 — `chiefos-site/app/app/uploads/page.tsx`)*

### 1.5 — Labor Hour Tracking (Timeclock App Replacement)
- ✅ Timeclock v2 fully validated: clock in/out, break/lunch/drive, undo, repair prompts, overlap detection *(pre-sprint — BETA-ready)*
- ✅ Policy-aware paid time calculations (paid breaks, paid lunch configurable) *(pre-sprint)*
- ✅ Owner-set hourly cost rates per employee *(2026-04-10)*
  - ✅ WhatsApp command: `set rate [name] $X/hour` → upserts to `chiefos_crew_rates` *(2026-04-10 — `handlers/commands/rates.js`)*
  - ✅ `set my rate $X/hour` for owner self-rate *(2026-04-10)*
  - ✅ `job_kpis.js` updated: join `time_entries_v2 × chiefos_crew_rates` → labor as dollars per employee *(2026-04-10)*
  - ✅ Weekly digest updated: labor cost in dollars using rates table *(2026-04-10 — `workers/weeklyDigest.js`)*
  - ✅ Graceful fallback when rates not set *(2026-04-10)*
- ✅ Timesheet summary with dollar values via WhatsApp: `payroll this week` → per-employee hours + gross pay *(2026-04-10 — `handlers/commands/payroll.js`)*
- ✅ Overtime awareness: flag hours over 40/week at clock-out, cost impact in payroll summary *(2026-04-10 — `handlers/commands/timeclock.js` + `payroll.js`)*
- ✅ `get_overtime_report` agent tool for Ask Chief queries *(2026-04-10 — `services/agentTools/overtimeReport.js`)*
- ✅ Timesheet approval flow: employee submits (`submit timesheet [last week]`), owner reviews (`pending timesheets`), approves/rejects (`approve timesheet [name]`, `reject timesheet [name] [note]`); approved periods locked — undo blocked at timeclock with user-facing message; bidirectional WhatsApp notifications *(2026-04-10 — `handlers/commands/timesheetApproval.js`)*

### 1.6 — Export Pack (Spreadsheet/QuickBooks Replacement)
- ✅ XLSX export: all expenses by job, date range, category *(2026-04-10)*
- ✅ XLSX export: all revenue by job, date range *(2026-04-10)*
- ✅ XLSX export: timesheet by employee, by job, with dollar values *(2026-04-10)*
- ✅ PDF job profitability report: single job or batch — revenue, expenses, labor, margin *(2026-04-10)*
- ✅ Year-end pack v1: P&L snapshot, expense totals by category, revenue totals, receipt bundle — now also includes QuickBooks CSV in the ZIP *(2026-04-10)*
- ✅ CSV export for direct QuickBooks import: `POST /api/exports/expenses-csv` — columns include QuickBooks Account, CRA T2125 line, IRS Schedule C line *(2026-04-10)*
- ✅ Tax-ready categorization: `TAX_CATEGORY_MAP` in `exportsPortal.js` maps 16 ChiefOS categories to QB account, CRA T2125, and IRS Schedule C lines; added as columns to both XLSX and CSV exports *(2026-04-10)*

### Phase 1 Gate — ✅ PASSED 2026-04-10
- ✅ Owner can create a job, quote it, capture expenses, track crew time with dollar values, close the job, ask "how did this job do?", get a clear profitability answer, and export for their accountant
- ✅ All data ties back to a job
- ✅ Ask Chief returns grounded, accurate answers
- ✅ All writes are idempotent and tenant-isolated
- ✅ All exports are owner-scoped and plan-gated
- ✅ `set rate [employee]` persists to `chiefos_crew_rates` and survives replay
- ✅ Job KPI summary includes labor cost as dollars; graceful fallback when rates not set

---

## Phase 2 — Operational Capture ✅ COMPLETE

**Goal:** Absorb the daily operational tools contractors use so they stop context-switching between apps. Every feature here must attach to jobs.

### 2.1 — Job Site Photos (CompanyCam Replacement)
- ✅ Photo upload via WhatsApp: photos stored and attached to job *(pre-sprint)*
- ✅ Photo upload via portal: file picker to job detail page *(pre-sprint)*
- ✅ Photo metadata: timestamp, who uploaded, job attachment, optional caption *(pre-sprint)*
- ✅ Ask Chief: "Show me photos from Job 123" → returns gallery link *(2026-04-10 — `services/agentTools/photoQuery.js`)*
- ✅ Photo export: shareable link with all photos for a job, valid 30 days *(pre-sprint — `api/jobs/:jobId/photos/share`)*
- ✅ Before/after organization: owner tags photos as "before", "during", "after" *(2026-04-10)*
  - ✅ WhatsApp: captions containing "before", "after", "during", "progress", "wip" auto-tag the photo *(2026-04-10 — `handlers/media.js`)*
  - ✅ Portal upload: phase selector (Before / During / After) in upload form *(2026-04-10 — job detail page)*
  - ✅ Portal gallery: phase filter tabs + phase badge overlaid on each thumbnail + badge in lightbox *(2026-04-10)*
- ✅ Storage via signed URLs (Supabase Storage), plan-gated *(pre-sprint)*

### 2.2 — Task Management (Enhanced)
- ✅ Task assignment with due dates *(pre-sprint)*
- ✅ Task attachment to jobs *(pre-sprint)*
- ✅ Task status: to-do → in progress → done *(pre-sprint)*
- ✅ Task notifications via WhatsApp: "Reminder: [task] is due soon" *(pre-sprint — `workers/reminder_dispatch.js`)*
- ✅ Owner task dashboard on portal *(pre-sprint)*
- ✅ Crew can mark tasks done via WhatsApp *(pre-sprint)*

### 2.3 — Customer Records (Lightweight CRM Layer)
- ✅ Customer record: name, phone, email, address, notes *(pre-sprint)*
- ✅ Customer ↔ job linking *(pre-sprint)*
- ✅ Customer history via Ask Chief: "Show me all jobs for John Smith" *(2026-04-10 — `services/agentTools/customerHistory.js`)*
- ✅ Repeat customer detection: "John Smith has 3 completed jobs. Average margin: 31%." *(2026-04-10)*
- ✅ Customer communication log: append-only notes log on each customer record — portal UI on job detail page below client card; GET/POST/DELETE via `/api/customers/:id/notes`; migration `2026_04_10_customer_notes.sql` *(2026-04-10)*

### 2.4 — Supplier Cost Tracking
- ✅ Supplier records: name, contact, materials categories *(pre-sprint — supplier portal + catalog)*
- ✅ Supplier catalog integration: spreadsheet ingestion, tenant-scoped snapshots *(pre-sprint)*
- ✅ Expense-to-supplier linking *(2026-04-10 — `supplier_id` UUID FK on `transactions`; BEFORE INSERT trigger auto-links source text → `public.suppliers`; backfill applied)*
- ✅ Ask Chief: "How much have I spent at Home Depot this year?" *(2026-04-10 — `get_supplier_spend` agent tool; source-text ILIKE match works for any vendor; FK match for registered suppliers)*
- ✅ Price tracking over time *(2026-04-10 — `get_supplier_spend` returns month-by-month breakdown + 3-month trend direction; catalog price history surfaced for registered suppliers)*

### 2.5 — Payroll Visibility (Not Payroll Processing)
- ✅ Owner sets pay rates per employee (`set rate [name] $X/hour`) *(2026-04-10 — `handlers/commands/rates.js`)*
- ✅ Payroll summary via WhatsApp: `payroll this week` / `payroll summary` → per-employee hours + gross pay *(2026-04-10 — `handlers/commands/payroll.js`)*
- ✅ Custom date range: `payroll 2026-04-01 to 2026-04-07` *(2026-04-10)*
- ✅ Overtime flagging: hours > 40/week flagged at 1.5×, cost shown in payroll summary *(2026-04-10)*
- ✅ Ask Chief payroll tool: `get_payroll_summary` agent tool for chat-based queries *(2026-04-10 — `services/agentTools/payrollSummary.js`)*
- ✅ Explicit positioning: "ChiefOS calculates your labour numbers. Your payroll provider handles deductions, taxes, and direct deposits." *(2026-04-10)*
- ✅ Payroll export: XLSX and CSV via `POST /api/exports/payroll` — per-employee regular hours, OT hours at 1.5×, gross pay; optional date range; portal UI with date pickers on Exports page *(2026-04-10)*

### 2.6 — Weekly Business Pulse (Proactive Intelligence)
- ✅ Scheduled weekly summary sent to owner via WhatsApp (Friday 4PM UTC) *(pre-sprint — `workers/weeklyDigest.js`)*
- ✅ Contents: total revenue, total expenses, total labor hours/cost, jobs completed, jobs in progress *(pre-sprint + 2026-04-10 labor cost added)*
- ✅ One insight per week: top job, expense spikes, unbilled hours *(pre-sprint)*
- ✅ Quarterly trend comparison: weekly digest detects first week of new quarter, fetches prior quarter totals, adds QoQ revenue/margin/job-count insight to Friday message *(2026-04-10 — `workers/weeklyDigest.js`)*
- ✅ Configurable day/time/metrics: per-owner `digest.send_day` / `digest.send_hour` / `digest.enabled` in `public.settings`; WhatsApp commands "digest day friday", "digest time 4pm", "digest on/off", "digest settings"; cron changed from `0 16 * * 5` → `0 * * * *` (hourly) with per-owner day+hour gate in `runWeeklyDigest()` *(2026-04-10 — `handlers/commands/digestSettings.js`, `workers/weeklyDigest.js`)*

### Phase 2 Gate — ✅ PASSED 2026-04-10
- ✅ Contractor can capture expenses, track time, manage tasks, document job sites with photos (including before/after), track customers, and see payroll numbers — entirely within ChiefOS
- ✅ Every data point ties back to a job
- ✅ Weekly pulse delivers at least one insight the owner didn't already know
- ✅ No features violate One Mind, Many Senses

---

## Phase 3 — Onboarding & Conversational Intelligence Polish 🔄 IN PROGRESS

**Goal:** Make the first 7 days feel inevitable. Refine Ask Chief so it feels like talking to a CFO, not querying a database.

### 3.1 — Onboarding Flow

**WhatsApp side**
- ✅ Collect: business name, timezone, tax region, break/lunch policy, currency *(pre-sprint)*
- ✅ First job creation guided *(pre-sprint)*
- ✅ After first job created, send contextual nudge: "Now try logging your first expense…" *(2026-04-10 — `handlers/commands/onboarding.js`)*
- ✅ After first expense confirmed, send mini snapshot *(2026-04-10)*
- ✅ After 3+ expenses on a job with revenue: proactively send job P&L — the magic moment *(2026-04-10)*
- ✅ Workflow preference question: new `workflow_pref` onboarding stage after job creation asks "How does your team work? Reply 1 (crew together) / 2 (techs independent)"; stores `onboarding.workflow_pref` in `public.settings` *(2026-04-10 — `handlers/commands/onboarding.js`)*

**Portal side**
- ✅ Portal welcome screen (`/app/welcome`, shown once post-signup): 3-step checklist with CTA *(2026-04-10 — `chiefos-site/app/app/welcome/`)*
- ✅ YouTube video links on welcome screen (env var-driven, renders when URLs set) *(2026-04-10)*
- ✅ Feature cards ("What to try first") on welcome screen *(2026-04-10)*
- ✅ Empty-state redesign: dashboard with no data shows actionable guidance *(2026-04-10)*
- ✅ Onboarding progress widget visible on dashboard until all 3 steps complete: `OnboardingWidget` component on dashboard; auto-hides when account + WhatsApp + expense all done; dismissible *(2026-04-10 — `chiefos-site/app/app/components/OnboardingWidget.tsx`)*
- ✅ First Ask Chief prompt surfaced contextually after 3+ data points: `AskChiefNudge` inline on dashboard when txCount ≥ 3; links to `/app/chief`; dismissible *(2026-04-10 — `chiefos-site/app/app/dashboard/page.tsx`)*

**Both**
- ✅ Onboarding completion tracking: skip buttons on WhatsApp (reply "skip") and portal steps 2 and 3; skip state stored in localStorage; skipped steps shown as "Skipped" not missing *(2026-04-10 — `OnboardingWidget.tsx` + `onboarding.js`)*

### 3.2 — Ask Chief Conversational Depth ✅ COMPLETE
- ✅ Multi-turn context: WhatsApp rolling conversation history (last 3 Q&A pairs stored in `actorMemory.conversation_history`, included in LLM seed); portal: last 10 messages already wired *(2026-04-10 — `buildHistorySlice()`, `trimMsg()` in `services/agent/index.js`)*
- ✅ Date range understanding: "this week", "last month", "Q1", "year to date" *(2026-04-10 — `parseDateRange()` utility in agent/index.js; date + timezone injected into WhatsApp system prompt)*
- ✅ Entity references: "that job", "the last one", "same job" + "same period", "that month", "same range" *(2026-04-10 — `hasEntityRef()` + `hasPeriodRef()` substitute stored job/date context before LLM call)*
- ✅ `last_job_name` persisted after first answer: DB lookup on `jobs.job_int_id` → stored in actorMemory so follow-ups show job name not just number *(2026-04-10)*
- ✅ Cross-domain queries: "Which jobs had the most overtime?" *(partial — overtimeReport + jobPnl tools exist)*
- ✅ Comparative context: "That's below your average of 34%" *(2026-04-10 — `get_owner_benchmarks` tool; LLM instructed to call it automatically after job answers)*
- ✅ Pattern detection: "Your last 5 bathroom renos averaged 15% over quoted labor" *(2026-04-10 — `get_job_pattern_trends` tool; `services/agentTools/jobPatternTrends.js`)*
- ✅ Uncertainty handling *(2026-04-10 — uncertainty script added to `CHIEF_SYSTEM_PROMPT` and `FINANCIAL_SYSTEM_ADDENDUM`; scripted phrases for no-data, partial-data, missing-rates, confident cases)*
- ✅ Streaming response with fast first token — WhatsApp *(2026-04-10 — `looksLikeReasoningQuery()` heuristic; immediate "⏳" TwiML ack + async `sendWhatsApp` push in `routes/webhook.js`)*
- ✅ Streaming response with fast first token — Portal SSE *(2026-04-10 — `routes/askChiefStream.js` tool phase + synthesis stream; Next.js SSE proxy at `app/api/ask-chief/stream/route.ts` pipes `ReadableStream` directly; `ChiefClient.tsx` consumes token/done events with blinking-cursor streaming UI)*
- ✅ Fallback message on LLM failure *(2026-04-10 — `(llm offline)` sentinel caught in `runToolsLoop` and `ask()` in `services/agent/index.js`; cross-provider fallback already in `LLMProvider.chat()`)*

### 3.3 — Portal Decision Center (Dashboard)
- ✅ Cash in / cash out (current period) *(pre-sprint)*
- ✅ Active jobs with status indicators *(pre-sprint)*
- ✅ Labour today (hours, cost) *(pre-sprint)*
- ✅ Unbilled time warning *(pre-sprint)*
- ✅ Top costs this period *(pre-sprint)*
- ✅ Recent activity feed *(pre-sprint)*
- ✅ Ask Chief accessible from dashboard *(pre-sprint)*
- ✅ Date range picker, job filter, search *(pre-sprint)*
- ✅ Margin alert notifications panel on portal dashboard: reads `insight_log` kind=margin_alert, shows dismissible alert cards with job link *(2026-04-10 — `chiefos-site/app/app/dashboard/page.tsx` — `MarginAlertsBanner` component)*

### 3.4 — Crew Self-Query ("My Performance" — Pro Tier) ✅ COMPLETE
- ✅ Tech-scoped read path: employees can query their own hours, jobs, and tasks via WhatsApp *(2026-04-10 — `handlers/commands/crewSelf.js`; all queries filter strictly by `employee_name` resolved from actor phone; plan gate + visibility gate enforced before any query)*
- ✅ Owner-configurable visibility settings *(2026-04-10 — `crew self query on/off` WhatsApp command stores `crew.self_query_enabled` in `public.settings (owner_id, key)`; `crew settings` shows current state; owner-only)*
- ✅ WhatsApp commands for crew: `my hours`, `my hours this week/last week`, `my jobs`, `my jobs this week`, `my tasks` *(2026-04-10 — `isCrewSelfCommand` + `handleCrewSelf`; wired into `handlers/commands/index.js` after payroll block)*
- ✅ Company benchmarks *(2026-04-10 — after `my hours`, returns aggregate team avg hours + employee count for same period; "You're 12% above the team average this week" — aggregate only, no individual names exposed)*
- ✅ Hard boundary: no cross-employee data *(2026-04-10 — every DB query filters `LOWER(employee_name) = LOWER($actorName)` and `owner_id = $ownerId`; actor name resolved from `users` table via phone digits only; team benchmark returns AVG/COUNT aggregate, never rows)*

### 3.5a — Email Lead & Document Ingestion ✅ COMPLETE
- ✅ Email forwarding capture *(2026-04-10 — `routes/emailIngest.js` Postmark inbound webhook at `POST /api/email-ingest`; resolves tenant by `email_capture_token` in To address; protected by `POSTMARK_WEBHOOK_TOKEN`)*
- ✅ Auto-parsed into lead/pending review *(2026-04-10 — body/subject classified as `lead` or `expense` by keyword scoring; lead bodies create `email_lead` intake items at `pending_review` status; expense attachments create items at `uploaded` for OCR/processing)*
- ✅ Voicemail-to-job via email *(2026-04-10 — audio/* MIME attachments (MP3/M4A/WAV/AAC) from VoIP email alerts create `voice_note` intake items with `voice_transcript_low_confidence` flag; land in Pending Review queue same as WhatsApp voice notes)*
- ✅ Document upload via portal *(pre-existing — `app/api/intake/upload/route.ts` multi-file upload to Supabase Storage; images, PDFs, audio all supported)*
- ✅ Pending Review queue *(pre-existing — `/app/uploads` inbox + `/app/pending-review/[itemId]` detail review; confirm/skip/delete per item; batch progress bar; one-tap confirm for high-confidence items)*
- ✅ Dedupe *(pre-existing on portal upload — SHA-256 hash of file content checks against confirmed/persisted items; 2026-04-10 same dedup applied to email attachments via `intake_items.dedupe_hash`; primary email dedup via `email_ingest_events.postmark_msg_id` UNIQUE)*

### 3.5b — Free → Paid Conversion Layer ✅ COMPLETE *(launch-critical)*

- ✅ Ask Chief trial for Free users: 3 queries/month with soft upsell footer; hard paywall on query 4+ *(2026-04-10)*
- ✅ Job limit progress indicator on Jobs page: "X of 3 free jobs used — Upgrade for 25 jobs →" *(2026-04-10 — `chiefos-site/app/app/jobs/page.tsx`)*
- ✅ Job limit upgrade modal: when creating job #4 on Free, show upgrade CTA with `PLAN_LIMIT_REACHED` error handling *(2026-04-10 — `CreateJobForm.tsx`)*
- ✅ 7-day free trial on Starter: Stripe `trial_period_days: 7`, billing page copy updated *(2026-04-10)*
- ✅ Upsell prompts are contextual — appear once per trigger, not spammy *(2026-04-10)*

### 3.6 — Installable PWA ✅ COMPLETE *(basic — eliminates "I don't use WhatsApp" objection)*

- ✅ `chiefos-site/public/manifest.webmanifest` created: name, short_name, start_url, display standalone, theme/bg color, icons *(2026-04-10)*
- ✅ App icons `icon-192.png`, `icon-512.png` in `chiefos-site/public/` *(pre-existing)*
- ✅ `<link rel="manifest">` in `chiefos-site/app/layout.tsx` *(pre-existing)*
- ✅ iOS PWA meta tags in `layout.tsx`: apple-mobile-web-app-capable, status-bar-style, touch-icon *(pre-existing)*
- [ ] Verified: Android Chrome shows "Add to Home Screen" prompt on `usechiefos.com` *(needs live test)*
- [ ] Verified: iOS Safari shows "Add to Home Screen" via Share menu *(needs live test)*

### Phase 3 Gate — 🔄 IN PROGRESS
- ✅ Free users encounter at least one contextual upgrade prompt within their first session
- ✅ Portal is installable as a PWA (manifest + icons + meta tags in place)
- ✅ Onboarding welcome screen, guided WhatsApp nudges, and empty states built
- ✅ Onboarding progress widget on dashboard; Ask Chief contextual nudge after 3+ data points
- ✅ Margin alert notifications panel on portal dashboard
- ✅ Quote vs actual comparison via Ask Chief
- ✅ Quarterly trend in weekly digest
- [ ] A new user can go from signup to first meaningful Ask Chief answer in under 15 minutes *(needs end-to-end test with real user)*
- [ ] Ask Chief handles 5–10 unscripted questions with coherent context *(needs test)*
- [ ] PWA install verified on Android Chrome and iOS Safari *(needs live device test)*
- [ ] Onboarding completion rate target: 70%+ log something within 48 hours *(needs live data — post-launch metric)*

**Remaining build work before Phase 3 gate passes:**
1. ✅ Ask Chief multi-turn context and date range understanding (3.2) — COMPLETE 2026-04-10
2. Live PWA install test on a real device

---

## Phase 4 — Full System Testing & Integration Validation

**Goal:** Ensure every feature works end-to-end, WhatsApp to portal, for both users and suppliers. No "coming soon" labels on shipped features.

### 4.1 — Feature Inventory Audit
- [ ] Complete crawl of portal: every page, every button, every link
- [ ] Complete crawl of WhatsApp flows: every command, every capture flow, every Ask Chief query pattern
- [ ] Complete crawl of supplier portal
- [ ] Master feature matrix: feature → status (working / broken / missing / coming soon) → plan tier

### 4.2 — WhatsApp → Portal Integration Testing
- [ ] Expense logged via WhatsApp appears correctly on portal expense page
- [ ] Revenue logged via WhatsApp appears correctly on portal revenue page
- [ ] Time entries via WhatsApp appear correctly on portal timesheet page with dollar values
- [ ] Photos sent via WhatsApp appear on portal job detail page with phase tag when captioned
- [ ] Tasks created/completed via WhatsApp reflect on portal task page
- [ ] Quotes/invoices created via portal can be referenced via Ask Chief on WhatsApp
- [ ] Export triggered via WhatsApp matches export triggered via portal

### 4.3 — Identity & Tenant Isolation Testing
- [ ] Create 2 test tenants with overlapping employee names
- [ ] Confirm zero cross-tenant data leakage on every portal page
- [ ] Confirm zero cross-tenant data leakage in Ask Chief responses
- [ ] Confirm zero cross-tenant data leakage in exports
- [ ] Confirm crew self-query boundary holds
- [ ] Confirm owner-only features are invisible/blocked for crew accounts

### 4.4 — Plan Gating & Monetization Testing
- [ ] Free tier: verify all gated features are blocked with clear upsell messaging
- [ ] Starter tier: verify all Starter features work, Pro features blocked
- [ ] Pro tier: verify all features work
- [ ] Quota enforcement: OCR, voice, Ask Chief — consumed before execution, blocked at limit
- [ ] Fail-closed: simulate plan lookup failure → confirm treated as Free
- [ ] Upsell prompts: shown once per trigger, contextual

### 4.5 — Data Integrity & Edge Cases
- [ ] Duplicate message handling (same expense sent twice → only one entry)
- [ ] Malformed input handling
- [ ] Timezone consistency
- [ ] Currency consistency (cents storage, no rounding errors)
- [ ] Job with no data → Ask Chief responds gracefully
- [ ] Job with partial data → Ask Chief explains what's missing
- [ ] Large data volume: 100+ expenses, 50+ employees, 12 months history

### 4.6 — Export & Accountant Readiness Testing
- [ ] XLSX exports open correctly in Excel, Google Sheets, LibreOffice
- [ ] PDF exports render correctly
- [ ] Year-end pack contains all required components
- [ ] Expense categories map to tax filing categories
- [ ] Export totals match Ask Chief summaries

### 4.7 — Performance & Reliability
- [ ] No Twilio 11200 transport failures
- [ ] Ask Chief first-token under 2 seconds
- [ ] Portal page load under 3 seconds
- [ ] No uncaught exceptions on any user-facing path
- [ ] Graceful degradation: if LLM is slow/down, system still captures data

### Phase 4 Gate
- [ ] Zero "coming soon" labels on any shipped feature
- [ ] Zero known cross-tenant data leakage
- [ ] All plan gating verified
- [ ] All exports verified by someone other than the developer
- [ ] Master feature matrix 100% green on all Phase 1-3 items
- [ ] Founder confidence test: "Would I trust this with my own books today?" = YES

---

## Phase 5 — Multi-Platform Delivery (PWA, Micro-Apps, Native Apps)

**Goal:** Remove all barriers to using ChiefOS. Meet users on every device.

### 5.1 — PWA Full Optimization *(basic installability already done in Phase 3.6)*
- ✅ Portal installable as PWA on iOS and Android *(done in Phase 3.6)*
- ✅ App icon, splash screen, standalone display mode *(done in Phase 3.6)*
- [ ] **Offline capability**: cached dashboard, queued captures sync when online (service worker + background sync)
- [ ] **Push notifications**: weekly pulse, task reminders, pending review alerts
- [ ] Performance: meets Core Web Vitals thresholds (LCP < 2.5s, CLS < 0.1, INP < 200ms)

### 5.2 — Micro-App: Receipt Capture
- [ ] Standalone capture-only app: photo → OCR → job select → confirm → submit
- [ ] Sense only — no reasoning seat, no Ask Chief access
- [ ] Emits CIL drafts to server; server enforces idempotency
- [ ] Minimal footprint, fast load, works on low-end devices
- [ ] Plan-gated (OCR quota applies)

### 5.3 — Native iOS App
- [ ] Core portal functionality replicated
- [ ] Camera integration for receipt/photo capture
- [ ] Push notifications
- [ ] WhatsApp deep-link for Ask Chief (or in-app Ask Chief if scoped)
- [ ] Biometric authentication
- [ ] Offline data caching with sync

### 5.4 — Native Android App
- [ ] Feature parity with iOS app
- [ ] Camera integration for receipt/photo capture
- [ ] Push notifications
- [ ] Offline data caching with sync

### 5.5 — Supplier Portal (if applicable in this phase)
- [ ] Supplier login and dashboard
- [ ] Catalog management: upload/update product catalog
- [ ] Contractor visibility: which contractors are using their products
- [ ] All supplier portal functions tested end-to-end

### Phase 5 Gate
- [ ] PWA installable and functional on iOS Safari and Android Chrome
- [ ] Micro-app works standalone and submits data correctly
- [ ] Native apps feature-complete relative to portal scope
- [ ] All platforms share the same backend — no data divergence

---

## Phase 6 — Multi-Platform Testing

**Goal:** Every platform works as well as the web portal. No second-class experiences.

### 6.1 — PWA Testing
- [ ] Install and use on iOS Safari (iPhone, iPad)
- [ ] Install and use on Android Chrome (phone, tablet)
- [ ] Offline → online sync
- [ ] Push notification delivery and interaction
- [ ] Performance under poor network conditions (3G simulation)

### 6.2 — Micro-App Testing
- [ ] Receipt capture end-to-end: photo → OCR → job → confirm → appears on portal
- [ ] Idempotency: same receipt submitted twice → only one entry
- [ ] Plan gating: OCR quota enforced
- [ ] Works on low-end Android devices

### 6.3 — iOS App Testing
- [ ] Full functional test against master feature matrix
- [ ] Camera capture quality and OCR accuracy
- [ ] Push notification delivery
- [ ] Offline/sync behavior
- [ ] Biometric auth flow
- [ ] Test on iPhone SE, iPhone 15, iPad

### 6.4 — Android App Testing
- [ ] Full functional test against master feature matrix
- [ ] Camera capture quality and OCR accuracy
- [ ] Push notification delivery
- [ ] Offline/sync behavior
- [ ] Test on budget Android, mid-range, flagship
- [ ] Test on Android 12, 13, 14+

### 6.5 — Cross-Platform Data Consistency
- [ ] Expense logged on iOS → visible on portal, Android, and WhatsApp summary
- [ ] Time entry on Android → visible on portal, iOS, and WhatsApp summary
- [ ] Quote created on portal → visible and referenceable on all platforms
- [ ] Export generated on one platform → identical output regardless of platform

### Phase 6 Gate
- [ ] All platforms pass their respective test suites
- [ ] No data inconsistencies across platforms
- [ ] No platform-specific crashes or blocking bugs
- [ ] User experience is consistent

---

## Phase 7 — App Store Submission

**Goal:** Get iOS and Android apps approved and published.

### 7.1 — Pre-Submission Checklist
- [ ] App Store Guidelines compliance review (Apple)
- [ ] Google Play Policy compliance review
- [ ] Privacy policy published and linked
- [ ] Terms of service published and linked
- [ ] App icons, screenshots, and store listing copy prepared
- [ ] App Store description reflects current features only
- [ ] Demo/test account available for app reviewers

### 7.2 — Apple App Store Submission
- [ ] Build signed with production certificate
- [ ] TestFlight beta tested with real users
- [ ] Submit to App Store Connect
- [ ] Respond to any review feedback
- [ ] Approved and published

### 7.3 — Google Play Store Submission
- [ ] Build signed with production keystore
- [ ] Internal/closed testing track validated
- [ ] Submit to Google Play Console
- [ ] Respond to any review feedback
- [ ] Approved and published

### 7.4 — Post-Launch Monitoring
- [ ] Crash reporting active (Sentry or equivalent)
- [ ] App store rating monitoring
- [ ] User feedback collection channel
- [ ] Hotfix deployment pipeline tested

### Phase 7 Gate
- [ ] Both apps live in their respective stores
- [ ] No critical crashes in first 48 hours
- [ ] At least 5 real users have installed and used each app
- [ ] Crash-free rate above 99%

---

## Staying On Target — Rules for Claude Code Sessions

1. **State the phase and item** at the start of every session: "I'm working on Phase 1, Item 1.2 — Quote-to-Actual Loop"
2. **Refuse scope creep.** If Claude Code suggests work outside the current phase, say: "That's a Phase [X] item. We're in Phase [Y]. Save it."
3. **One item at a time.** Don't start 1.3 until 1.2 is checked off or explicitly deferred.
4. **Use Ultraplan for complex items.** Items like 1.1 (Job Profitability Summary), 1.2 (Quote-to-Actual Loop), and 3.2 (Ask Chief Conversational Depth) are architecturally significant — plan them in the cloud before writing code.
5. **Test before checking off.** An item isn't ✅ until it works in WhatsApp AND portal AND passes tenant isolation.
6. **Update this file.** After completing each item, mark it ✅ with the date. This file is the source of truth for progress.
7. **Weekly review.** Every Sunday, read this file top to bottom. Ask: "Am I still in the right phase? Is anything blocking the phase gate?"

---

## CLAUDE.md Integration

```
## Active Execution Plan
Read CHIEFOS_EXECUTION_PLAN.md before starting any work.

Phase 1 🔄 PARTIAL (§1.2 re-opened 2026-04-18) | Phase 2 ✅ COMPLETE | Phase 3 🔄 IN PROGRESS

Current Phase: 3 — Onboarding & Conversational Intelligence Polish
Remaining Phase 3 build items:
  - 3.2: Ask Chief multi-turn context + date range understanding
  - 3.3: Margin alert panel on portal dashboard (insight_log → dismissible alert cards)
  - Live PWA install test (Android Chrome + iOS Safari)

Do not accept work outside Phase 3 unless explicitly approved by the developer.
Before suggesting any new feature or refactor, check if it is already built
(see CHIEFOS_EXECUTION_PLAN.md) to avoid rebuilding working code.
```

---

End of Document — ChiefOS Execution Plan v1.2
