# ChiefOS — Foundation Rebuild Plan

**Status:** Authoritative governance document. Supersedes `RECEIPT_PARSER_UPGRADE_PLAN_V2.md` Session 3+ until Foundation Rebuild is complete.
**Date:** 2026-04-21
**Owner:** Scott Jutras
**Informed by:**
- `SESSION_2_5_SCHEMA_DRIFT_CATALOG.md` (122 tables total, 72 untracked; 39 user functions with 20 SECURITY DEFINER; 4 PII tables with no RLS; 26 functional GRANT bugs; 21 untracked triggers; 18 untracked views)
- `RECEIPT_PARSER_AUDIT_NOTES.md`, `RECEIPT_PARSER_UPGRADE_HANDOFF.md`, `RECEIPT_PARSER_UPGRADE_PLAN_V2.md`
- `01_CHIEFOS_NORTH_STAR.md`, `02_CHIEFOS_EXECUTION_PLAYBOOK.md`, `03_CHIEFOS_ENGINEERING_CONSTITUTION.md`, `04_CHIEFOS_MONETIZATION_AND_PRICING.md`, `05_CHIEFOS_CREATIVE_AND_GTM_BRIEF.md`, `06_CHIEFOS_PROJECT_INSTRUCTIONS.md`

---

## 1. Why This Plan Exists

Session 2.5 Phase 1 forensic audit of the dev database found that 59% of tables (72 of 122), a majority of views (18 of 23), most user functions (including 20 running as SECURITY DEFINER), and 21 triggers exist in the database but are not created by any tracked migration file. The `migrations/` directory is not the source of truth for the schema.

Additionally, 4 tables containing PII have no row-level security, and 26 tables have missing GRANTs that would cause portal failures on a fresh database setup.

Reconciling the current database in place (Option A) would require producing 70+ corrective migrations, auditing 20 SECURITY DEFINER functions forensically, patching RLS onto 4 PII tables, and permanently maintaining drift detection over a schema whose history tells a story of chaos followed by cleanup.

Rebuilding on clean ground (Option B) is cleaner. Because ChiefOS Beta users have no data that needs to be preserved, the rebuild is operationally feasible. Because the product is pre-public-launch, the rebuild happens before the trust claim is made at scale.

This plan governs the rebuild.

---

## 2. What This Plan Produces

At completion of the Foundation Rebuild:

- A **new, clean dev database** whose schema is 100% defined by tracked migration files
- All ChiefOS features that currently work continue to work (capture, jobs, expenses, revenue, timeclock, quotes spine, portal review)
- No SECURITY DEFINER functions without explicit audit notes documenting what they do, why they require elevated privileges, and how their access is constrained
- No PII table without RLS
- All tables with correct GRANTs to `authenticated` and `service_role`
- Migration history is a clean, deliberate narrative — every object was created by a reviewed migration, not patched in retrospect
- Schema drift detection script (`scripts/schema_drift_check.js`) exits code 0
- Engineering Constitution §5 updated with the binding "single source of truth" rule
- Beta users cut over to the new database with a documented reset
- Old database archived read-only for 30 days, then decommissioned
- `RECEIPT_PARSER_UPGRADE_PLAN_V2.md` Session 3 resumes on the clean foundation

---

## 3. What This Plan Does NOT Do

- Does not preserve Beta user data. All Beta data is disposable by founder decision.
- Does not rebuild features that do not exist today (e.g., the LLM auditor — that is Plan V2 Session 4).
- Does not redesign the product. Every feature that exists today in the North Star, Execution Playbook, and codebase is preserved architecturally. Only the schema foundation changes.
- Does not touch production data until after dev is verified complete. Production cut-over is explicitly sequenced at the end.
- Does not modify the authoritative docs' vision or positioning. Only the Engineering Constitution gains one new binding rule (§5.X single source of truth).

---

## 4. Phase Structure

Seven phases. Each phase produces a concrete deliverable, passes a completion gate, and has an explicit founder checkpoint before the next phase begins. This is not negotiable — the size of the effort demands that founder review happen at every major inflection point.

The Regression Pause Rule applies throughout. If any phase reveals something that changes the plan, the plan pauses for revision.

### Phase Dependency Map

```
Phase 0 (Dev/Prod Divergence Diagnostic)
  │
  ▼
Phase 1 (Schema Design)
  │
  ▼
Phase 2 (SECURITY DEFINER + Trigger + Function Audit)
  │
  ├────────────────────┐
  ▼                    ▼
Phase 3             Phase 4
(Clean Migration    (App Code Audit —
 Authorship)         what depends on
  │                  current schema quirks)
  │                    │
  └──────────┬─────────┘
             ▼
    Phase 5 (Fresh DB Build + Integration Test)
             │
             ▼
    Phase 6 (Beta Cut-Over)
             │
             ▼
    Phase 7 (Old DB Archive + Constitution Update)
             │
             ▼
    Resume Plan V2 Session 3 (Validation Service)
```

---

## 5. Phase Detail

### Phase 0 — Dev / Production Divergence Diagnostic

**Deliverable:** `FOUNDATION_P0_DIVERGENCE_REPORT.md` in project root.

**Scope:** Confirm whether production and dev share the same schema shape. This is the unknown that must be resolved before any migration authorship happens, because the rebuild strategy differs depending on the answer.

**Steps:**

1. Run the Phase 1 catalog queries (same as Session 2.5 Phase 1 but against production) to produce a production object inventory.
2. Diff against the dev inventory.
3. Classify the divergence:
   - **Identical:** production and dev have the same schema objects. Rebuild happens in dev, production cuts over at the end.
   - **Dev ahead:** dev has objects production doesn't. These objects are either (a) receipt parser Session 2 additions, or (b) untracked drift specific to dev.
   - **Prod ahead:** production has objects dev doesn't. Unlikely but possible — would indicate manual production changes.
   - **Diverged:** both directions have unique objects. Worst case — needs careful sequencing.

**Security-first check:** Confirm whether the 4 no-RLS PII tables and the 20 SECURITY DEFINER functions also exist in production with the same ACL / RLS gaps. If yes, and Beta users are actively logged in to production, the exposure is real-time and Phase 0 triggers an emergency lockdown sub-phase before proceeding.

**Completion criteria:**
- Production inventory catalogued
- Divergence diff produced
- Security-first check confirmed
- If emergency lockdown is triggered, it is completed and documented before Phase 1 begins

**Founder Checkpoint 0:** Review the divergence report. Confirm the Phase 1 approach based on what divergence class production is in.

---

### Phase 1 — Schema Design

**Deliverable:** `FOUNDATION_P1_SCHEMA_DESIGN.md` in project root. This document is the master design for the rebuilt database.

**Scope:** Design the clean schema from the authoritative docs forward. Every table, view, function, trigger, and policy that should exist in ChiefOS, with rationale and references to the authoritative docs that require it.

**Sources:**
- `01_CHIEFOS_NORTH_STAR.md` — dual-boundary identity model, canonical financial spine, CIL architecture
- `03_CHIEFOS_ENGINEERING_CONSTITUTION.md` — identity layers, safe query patterns, new table requirements, §11 quota architecture
- `RECEIPT_PARSER_UPGRADE_HANDOFF.md` §5 — the 7 tables from Plan V2 Session 2 (parse_jobs, vendor_aliases, parse_corrections, quota_allotments, quota_consumption_log, addon_purchases_yearly, upsell_prompts_log)
- Existing Session 2 migration files — the DDL that has already been written and tested
- `SESSION_2_5_SCHEMA_DRIFT_CATALOG.md` — the inventory of objects currently in the database, with "keep / redesign / discard" annotations applied during this phase

**Method:**

1. **Start from the authoritative docs, not from the current database.** Design the schema by reading the North Star and Constitution and asking "what tables does this product require?", not by asking "how do I reproduce what exists?"
2. **Then cross-check against the current database.** For every object in the Session 2.5 catalog, annotate it as:
   - **KEEP-AS-IS:** the object is correctly designed; re-create via migration exactly as it exists
   - **KEEP-WITH-REDESIGN:** the object is needed, but the current implementation has issues (missing RLS, missing GRANTs, poor constraints); re-design and re-create
   - **DISCARD:** the object is not needed in the rebuild (experimental, duplicate, legacy)
3. **For every KEEP, confirm the tenant-safety pattern** per Engineering Constitution §2 before including it in the design.
4. **Produce table-by-table design pages.** Each page specifies: table name, purpose, columns, constraints, indexes, RLS policies, GRANTs, cross-tenant isolation test plan, and a reference to the authoritative doc section that motivates the table.

**Completion criteria:**
- Every existing schema object classified (KEEP-AS-IS, KEEP-WITH-REDESIGN, DISCARD)
- Discard list has explicit justification for each item
- Table-by-table design pages produced for every KEEP
- Identity model compliance (tenant_id + owner_id on every table where appropriate) verified
- Quota architecture (Constitution §11) incorporated
- Receipt parser tables (Plan V2 Session 2) incorporated with the exact DDL already tested

**Founder Checkpoint 1:** Review the schema design document. The discard list especially — these are things currently in the database that will not exist in the rebuild. Confirm before anything is built against this design.

---

### Phase 2 — Security-Sensitive Object Audit

**Deliverable:** `FOUNDATION_P2_SECURITY_AUDIT.md` in project root.

**Scope:** Audit every SECURITY DEFINER function, every untracked trigger, and every RLS policy in the current database. Classify each by risk and determine the re-implementation path.

**Methodology for each SECURITY DEFINER function:**

1. **Identity:** function name, schema, owner, return type, arguments
2. **Body:** full `pg_get_functiondef()` output
3. **Purpose:** what does this function do? Read-only lookup? Mutation? Privilege escalation?
4. **Caller analysis:** grep the codebase for every call site. Identify which app paths invoke this function.
5. **Risk classification:**
   - **BENIGN:** function does a bounded operation with no privilege escalation risk (e.g., a helper that reads from a system catalog). Re-implement as SECURITY INVOKER or keep as SECURITY DEFINER with explicit audit note.
   - **LOAD-BEARING:** function is required for correct operation and legitimately needs elevated privileges (e.g., RLS policy helper). Re-implement with tight argument validation, explicit SET search_path, and documentation.
   - **RISKY:** function could be exploited if called with crafted input (e.g., `chiefos_set_user_role` — privilege mutation with insufficient authorization check). Re-implement with hardening OR eliminate entirely and move the logic elsewhere.
   - **DISCARD:** function is dead code. Confirm no callers in app or in other DB objects, then drop.
6. **Re-implementation plan:** for every KEEP, specify the new function body (or structural change). For every DISCARD, confirm the drop is safe.

**Methodology for each trigger:**

1. **Identity:** trigger name, table, event (INSERT/UPDATE/DELETE/TRUNCATE), timing (BEFORE/AFTER), function called
2. **Body:** full definition via `pg_get_triggerdef()`
3. **Purpose:** what does this trigger enforce? Audit logging? Cascading update? Derived field calculation?
4. **Caller analysis:** what table operations invoke this trigger? Is the business logic it encodes documented elsewhere, or is this the only source of truth?
5. **Risk classification:** same BENIGN/LOAD-BEARING/RISKY/DISCARD schema as functions
6. **Re-implementation plan**

**Methodology for RLS policies:**

For every table with RLS enabled, list every policy. Confirm the policy correctly enforces `tenant_id` boundary per Engineering Constitution §2. Flag any policy that:

- Uses `user_id` alone without `tenant_id` context (fails §2)
- Uses `auth.uid()` comparison instead of membership lookup (fragile)
- Has `USING (true)` or `WITH CHECK (true)` (effectively disables RLS)
- Grants write access without matching read access (inconsistent)

For the 4 PII tables with no RLS, design the RLS policies that should have been there.

**Completion criteria:**
- Every SECURITY DEFINER function classified and documented
- Every untracked trigger classified and documented
- Every RLS policy reviewed
- 4 no-RLS PII tables have RLS policies designed
- `chiefos_set_user_role` specifically is reviewed and either hardened or eliminated — this one is flagged explicitly because privilege mutation without tight authorization is the classic vulnerability pattern

**Founder Checkpoint 2:** Review the security audit. Confirm the re-implementation plans for anything classified as LOAD-BEARING or RISKY. Confirm DISCARD lists. This is the phase where the question "should this logic exist at all?" gets answered deliberately, not inherited by accident.

---

### Phase 3 — Clean Migration Authorship

**Deliverable:** A new `migrations_v2/` directory (or equivalent; name TBD) containing a complete, idempotent, reviewable migration history that reproduces the Phase 1 schema design end-to-end. Every migration has a matching rollback file.

**Structure:**

Migrations are sequenced by dependency:

1. **Core identity and tenancy:** users, tenants, chiefos_portal_users (the minimal set that everything else references)
2. **Canonical financial spine:** transactions with tenant_id / owner_id / source_msg_id / dedupe_hash
3. **Jobs spine:** jobs, job_phases, job_photos, job_photo_shares
4. **Time spine:** time_entries_v2 (and related)
5. **Quotes spine:** chiefos_quotes, chiefos_quote_versions, chiefos_quote_line_items, chiefos_quote_events, chiefos_quote_share_tokens, chiefos_quote_signatures (re-created from the design pages, not lifted from the current DB)
6. **Intake pipeline:** intake_batches, intake_items, intake_item_drafts, intake_item_reviews (for non-receipt flows — voice, PDFs, email leads)
7. **Receipt pipeline (Plan V2 Session 2 tables):** parse_jobs, vendor_aliases, parse_corrections
8. **Quota architecture (Constitution §11):** quota_allotments, quota_consumption_log, addon_purchases_yearly, upsell_prompts_log
9. **Views:** compatibility views (chiefos_portal_expenses, etc.) per existing app expectations
10. **Functions:** re-implemented versions of the LOAD-BEARING SECURITY DEFINER functions from Phase 2, with tightened authorization
11. **Triggers:** re-implemented versions of the LOAD-BEARING triggers from Phase 2
12. **Policies:** comprehensive RLS across every table
13. **GRANTs:** comprehensive grants to `authenticated` and `service_role`

**Rules for every migration in this phase:**

- `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DO` blocks around policies — all idempotent
- Every migration has a matching rollback file
- Every migration includes a comment block at the top specifying:
  - What this migration creates
  - Why (reference to Phase 1 design page and the authoritative doc section that requires it)
  - Dependencies (which prior migrations must have run)
- No migration creates an object with SECURITY DEFINER without a matching audit note in the file referencing Phase 2

**Completion criteria:**
- All migrations authored
- All rollback files authored
- Schema drift check script implemented (`scripts/schema_drift_check.js`) per Plan V2 Session 2.5 spec
- Ready to apply to a fresh test database

**Founder Checkpoint 3:** Review the migration set before any test application. Migration files should read like a coherent narrative — a reviewer who didn't know ChiefOS should be able to read them in order and understand the architecture.

---

### Phase 4 — Application Code Audit (Runs in Parallel With Phase 3)

**Deliverable:** `FOUNDATION_P4_APP_DEPENDENCIES.md` in project root.

**Scope:** Before cutting over to the new database, identify every piece of app code that depends on current-schema quirks that the rebuild might change.

Critical audit targets:

1. **Every DB query in the codebase** — does it reference a column, function, trigger, or view that is in the DISCARD list from Phase 1?
2. **Every import of `schemas/cil.js` or `/cil.js`** — these need to resolve correctly against the new schema
3. **Every call to a SECURITY DEFINER function in the app layer** — if the function signature changed in Phase 3, the caller needs to be updated
4. **Portal RLS assumptions** — if Phase 2 tightened any RLS policy, portal code that relied on loose RLS may break
5. **Twilio webhook handlers** — confirm that WhatsApp capture paths still work against the new schema
6. **Migration runner / Supabase CLI configuration** — confirm the new `migrations_v2/` directory is what the runner picks up

**Method:**

- Grep-based scan of the codebase for every table name, column name, function name from the Phase 1 DISCARD list
- Manual review of each match
- Produce a remediation list: "file X line Y references DISCARDED object Z; needs change"
- Classify remediations as BLOCKING (must fix before cut-over), SAFE (can fix after cut-over), or NOT APPLICABLE

**Completion criteria:**
- Every BLOCKING remediation is documented with a proposed fix
- No surprise dependencies remaining

**Founder Checkpoint 4:** Review the app dependency report. Confirm the BLOCKING remediations scope — this is where scope creep is most likely to appear, because every dependency is a chance to find another unplanned issue.

---

### Phase 5 — Fresh Database Build + Integration Test

**Deliverable:** A new dev database, populated by running the Phase 3 migrations in order, with Phase 4's BLOCKING remediations applied to the app. All Session 2 tests passing. End-to-end app walkthroughs successful.

**Steps:**

1. Provision a fresh Supabase project (or equivalent), separate from the current dev database
2. Run all Phase 3 migrations in order against the fresh database
3. Confirm the schema drift check exits code 0
4. Run Session 2's 171-test suite against the fresh database — confirm 171/171 still passing
5. Apply Phase 4's BLOCKING remediations to the app code
6. Point the app at the fresh database (via env var, not by changing deployment)
7. Run end-to-end walkthroughs:
   - WhatsApp: send a receipt photo, confirm it, see it logged
   - Portal: log in, view jobs, view pending review, confirm a receipt, view exports
   - Quotes: create a quote, send it, capture a signature (via test harness)
   - Timeclock: clock in, take a break, clock out, view summary
8. Cross-tenant isolation test on the fresh database (two-tenant scenario)
9. Load test: synthetic receipt ingestion at 10x expected Beta volume to confirm no obvious scaling regressions

**Completion criteria:**
- Fresh database operational
- All 171 Session 2 tests passing
- All four end-to-end app walkthroughs successful
- Cross-tenant isolation confirmed
- Load test passing at 10x Beta volume
- Zero CRITICAL or HIGH severity bugs from the walkthroughs

**Founder Checkpoint 5:** Walk through the app yourself on the fresh database. Does it feel right? Any regressions you can sense? This is the last cheap opportunity to catch something before cut-over.

---

### Phase 6 — Beta Cut-Over

**Deliverable:** Beta users moved to the fresh database. Old database no longer serving the app.

**Steps:**

1. **Beta communication.** Write and send the Beta user notification: *"ChiefOS is undergoing a foundation upgrade. Your current Beta data will be reset on [date]. Please re-onboard after [date + N]. Thank you for being part of the Beta — this upgrade is what makes the production launch trustworthy."* Send 7 days in advance.
2. **Cut-over window.** Schedule a 2-hour maintenance window. Announce it in-app and via Beta email list.
3. **Cut-over execution:**
   - Take the app into maintenance mode (static "we're upgrading" page)
   - Repoint the app env var from old database to fresh database
   - Run the schema drift check one final time against the fresh database (must pass)
   - Run the 171-test suite one final time (must pass)
   - Lift maintenance mode
4. **Post-cut-over monitoring:** watch logs for the first 48 hours. Any error pattern that wasn't present in Phase 5 walkthroughs is investigated immediately.
5. **Beta re-onboarding:** users re-register, re-connect WhatsApp numbers, re-create their first jobs

**Completion criteria:**
- App live on fresh database
- Maintenance window closed successfully
- 48-hour error monitoring clean
- At least 50% of Beta users successfully re-onboarded within 7 days (otherwise, the re-onboarding flow needs review)

**Founder Checkpoint 6:** After 48 hours of clean operation, confirm cut-over is stable before Phase 7 archives the old database.

---

### Phase 7 — Old Database Archive + Constitution Update

**Deliverable:** The old database is retained in read-only mode for 30 days, then decommissioned. The Engineering Constitution is updated with the binding "single source of truth" rule.

**Steps:**

1. **Lock the old database to read-only.** No new writes. Retained for 30 days as a reference artifact in case any forensic question arises ("what was the definition of the untracked function `chiefos_X` before we rebuilt?").
2. **Update `03_CHIEFOS_ENGINEERING_CONSTITUTION.md`** with the new §5.X subsection (text below, already specified in Plan V2 Session 2.5 directive; reproducing here for continuity):

```markdown
### 5.X Single Source of Truth

The `migrations/` directory is the single source of truth for all schema objects
in the database. This is a binding rule with no exceptions.

**Forbidden:**
- Creating, altering, or dropping tables, views, functions, triggers, sequences,
  types, indexes, RLS policies, or grants via Supabase Studio, psql, the Supabase
  SQL Editor, or any other tool that does not produce a tracked migration file
- Applying SQL changes to production or staging that are not first captured in
  a migration file committed to the repository

**Required:**
- Every schema change lands as a tracked, reviewable migration file in `migrations/`
- Every migration file is idempotent
- Every migration file has a rollback file in `migrations/rollbacks/`
- The schema drift detection script (`scripts/schema_drift_check.js`) must pass
  before any migration session is considered complete

**Enforcement:**
- If the schema drift check reports drift, fix the drift before any other work
- Any session that creates schema objects without a migration file is a session
  failure — revert the changes and produce the migration

This rule exists because schema drift makes the system non-deterministic. A
database whose state cannot be reproduced from migrations cannot be safely
restored, cannot be safely cloned for testing, and cannot be safely audited.
Schema drift is the precursor to irrecoverable data incidents.
```

3. **Update `CLAUDE.md`** with a one-line reminder:
> Schema changes only happen via tracked migration files in `migrations_v2/` (or current migration directory). Never via Supabase Studio, psql direct edits, or ad hoc SQL. See Engineering Constitution §5.X for the binding rule.

4. **Produce `FOUNDATION_REBUILD_FINAL_REPORT.md`** documenting:
   - What was found (summary of Session 2.5 Phase 1 catalog)
   - What was rebuilt (summary of Phase 3 migrations)
   - What was discarded and why
   - What Beta metrics look like post-cut-over
   - What rules now prevent recurrence
5. **30-day retention clock starts.** After 30 days, the old database is permanently decommissioned.

**Completion criteria:**
- Old database read-only
- Constitution updated
- CLAUDE.md updated
- Final report produced
- 30-day retention clock set

**Founder Checkpoint 7 (final):** Confirm the project is complete. Plan V2 Session 3 (Validation Service) resumes against the new foundation.

---

## 6. Estimated Duration

Rough estimate in focused Claude Code session count (morning sessions at your pace):

- Phase 0: 1 session
- Phase 1: 2-3 sessions
- Phase 2: 2-3 sessions (this is the one with the real variability — security audit depth is hard to predict)
- Phase 3: 3-4 sessions (migration authorship is the bulk of mechanical work)
- Phase 4: 1-2 sessions (app dependency audit)
- Phase 5: 1-2 sessions (build + test)
- Phase 6: 1 session (cut-over execution) plus 48-hour monitoring
- Phase 7: 1 session

**Total: 12-17 focused Claude Code sessions, plus 48-hour monitoring window and 30-day retention period.**

At a pace of ~3-5 sessions per week of early-morning work, this is **3-6 weeks of elapsed time** before Plan V2 Session 3 resumes.

That is a real cost. It's also, given what the Session 2.5 catalog surfaced, the correct cost.

---

## 7. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Phase 2 security audit surfaces a vulnerability requiring emergency disclosure (unlikely given Beta-only exposure, but possible) | Low | High | Founder notified immediately; external security advisor consulted if needed |
| Phase 4 app dependency audit finds more breakage than expected | Medium | Medium | Each BLOCKING remediation reviewed at Checkpoint 4; scope expansion triggers plan revision |
| Beta users do not re-onboard post-cut-over | Medium | Medium | Clear communication 7 days ahead; simple re-onboarding flow; founder personally reaches out to engaged Beta users |
| Production cut-over (if Phase 0 reveals prod diverges from dev) needs additional care | Medium | High | Phase 0 explicitly sequences prod handling; emergency lockdown sub-phase triggers if needed |
| Load test in Phase 5 reveals scaling issues masked by previous schema | Low | Medium | Load testing happens before cut-over; any regression triggers Phase 3 revision |
| Critical dependency on a DISCARDED object surfaces post-cut-over | Low | High | Grep-based app audit in Phase 4 designed to catch these; 48-hour monitoring catches late-breaking ones |
| Foundation Rebuild scope creeps into product work ("while we're in here, let's also...") | High | Medium | Non-goals section of this plan explicitly enumerates what is out of scope; every session reviews against the plan |

---

## 8. Non-Goals (Do Not Do These Things)

Explicitly out of scope for this rebuild, regardless of how tempting:

- Redesigning product features — this is schema-only work
- Changing the product's positioning, tone, or GTM — the authoritative docs stand as-is
- Adding new capability (e.g., "while we're rebuilding, might as well add X") — every new feature is a new point of failure; add features in Plan V2 sessions after the rebuild lands
- Switching database platforms — stay on Supabase/Postgres
- Modifying Twilio, Stripe, or any external integration — these sit above the schema layer
- Rewriting `expense.js` beyond what Phase 4's BLOCKING remediations require — `expense.js` refactoring is Plan V2 Session 6's responsibility
- Building the LLM auditor — that is Plan V2 Session 4, after the foundation is rebuilt
- Adding new schema objects beyond what Phase 1's design document specifies — any "while we're in here" additions get caught at the checkpoint
- Production cut-over before dev is complete — dev operates on the fresh database for at least 7 days before production is scheduled

---

## 9. Authoritative Decisions Captured Before Plan Begins

Per founder on 2026-04-21:

1. **Option B (rebuild on clean ground) is confirmed.** Reconciliation in place is not pursued.
2. **Beta data is disposable.** The rebuild does not preserve Beta user data.
3. **"Do whatever it takes to make this 100% right."** The plan prioritizes correctness over speed at every trade-off.
4. **Production / dev divergence is unknown** and must be resolved in Phase 0 before the plan proceeds to migration authorship.
5. **Schema drift prevention is a binding rule going forward** (new Engineering Constitution §5.X).

---

## 10. Success Criteria for the Entire Rebuild

The Foundation Rebuild is complete when all of the following are true:

- Fresh database is the operational database for ChiefOS
- Schema drift check exits code 0
- All 171 Session 2 tests pass against the fresh database
- Zero SECURITY DEFINER functions exist without explicit audit notes justifying them
- Zero PII tables exist without RLS
- Zero tables exist without GRANTs to `authenticated` and `service_role`
- Engineering Constitution §5.X binding rule applied
- Beta users have been informed, reset, and re-onboarded
- Old database is archived read-only with 30-day retention scheduled
- Final report documents the what, why, and how for future reference
- Plan V2 Session 3 (Validation Service) has a clear ready-to-start signal

When all of these are true, the receipt parser upgrade resumes on a foundation that earns the trust the product promises to deliver.

---

## 11. What This Earns

A ChiefOS whose claim "your business should be able to tell you that" rests on a database where:

- Every schema object is documented, reviewed, and reproducible
- Every policy has been audited for tenant safety
- Every privileged function has been justified
- Every PII surface is protected
- Every migration history reads as a deliberate narrative
- Every contractor who signs up can trust their data is held correctly from the first receipt they send

This is the foundation the North Star was written for. The receipt parser is how we prove to a contractor that trust is real. The foundation is what makes the parser's answers true in the first place.

---

**End of Foundation Rebuild Plan.**
