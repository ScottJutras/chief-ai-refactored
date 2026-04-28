# ChiefOS — Foundation Rebuild Plan V2

**Status:** Authoritative governance document. Supersedes `FOUNDATION_REBUILD_PLAN.md`.
**Date:** 2026-04-21
**Owner:** Scott Jutras
**Version note:** V2 reflects the Phase 0 finding that ChiefOS operates on a single Supabase project (no separate production database) and the founder's confirmation that all data is disposable and Beta users are already informed of the reset.

---

## 1. Why V2

`FOUNDATION_REBUILD_PLAN.md` (V1) assumed separate dev and production databases, Beta users who needed careful cut-over communication, and the possibility that some data would need to be preserved. Phase 0's credential check revealed:

- Only one Supabase project exists (`xnmsjdummnnistzcxrtj`)
- That project is both dev and prod — the app has been operating without environment separation
- The founder has confirmed all data is disposable and Beta users have been informed of the reset

These answers substantially simplify the rebuild. V1's Phases 0, 5, 6, and 7 were scoped to handle the dev/prod separation and careful user cut-over. None of that scope applies. V2 is the appropriately-scoped plan for the actual situation.

The product outcome is identical: a clean, migration-driven, auditable schema foundation on which the receipt parser upgrade (Plan V2) resumes. The path is shorter and cleaner because the surrounding constraints were gentler than V1 assumed.

---

## 2. What This Plan Produces

At completion of the Foundation Rebuild:

- The existing Supabase project has been **reset** — all schema objects dropped, all data wiped, and the database rebuilt from tracked migration files
- **Two Supabase projects exist:** the rebuilt one serving production, and a new one serving as true dev/staging. The operational policy going forward is that schema changes always land in dev first, are tested, and then apply to production
- Schema is defined 100% by tracked migrations; zero untracked objects
- Every feature that exists in ChiefOS today (capture, jobs, expenses, revenue, timeclock, quotes spine, portal review) continues to work
- Every SECURITY DEFINER function is documented and justified; privilege-escalation risks eliminated or tightened
- Every PII table has RLS; every table has correct GRANTs
- Beta users re-onboard onto the clean system
- Engineering Constitution §5.X binding "single source of truth" rule applied
- `RECEIPT_PARSER_UPGRADE_PLAN_V2.md` Session 3 resumes on the clean foundation

---

## 3. What This Plan Does NOT Do

- Does not preserve Beta user data. All data is disposable per founder confirmation.
- Does not build new features. The receipt parser upgrade, the LLM auditor, voice replies — all remain in Plan V2's queue, to be built after the foundation is clean.
- Does not modify the product's positioning, pricing, or GTM. Authoritative docs stand.
- Does not touch external integrations (Twilio, Stripe, Document AI). Those sit above the schema layer.
- Does not refactor `expense.js` beyond what Phase 3's DISCARD list requires. `expense.js` refactoring is Plan V2 Session 6's responsibility.

---

## 4. Phase Structure

Six phases plus one emergency patch. Each phase produces a concrete deliverable and ends at a founder checkpoint.

### Dependency Map

```
Phase 0.5 (Emergency Security Patch on Current DB)
  │  (patches RLS on 4 PII tables; bounded scope)
  ▼
Phase 1 (Schema Design)
  │
  ▼
Phase 2 (SECURITY DEFINER + Function + Trigger Review)
  │
  ├───────────────────────┐
  ▼                       ▼
Phase 3              Phase 4
(Clean Migration     (App Code Audit —
 Authorship)          DISCARD dependencies)
  │                       │
  └───────────┬───────────┘
              ▼
      Phase 5 (Rebuild + Cut-Over)
              │
              ▼
      Phase 6 (Dev Environment + Constitution Update)
              │
              ▼
      Resume Plan V2 Session 3 (Validation Service)
```

---

## 5. Phase Detail

### Phase 0.5 — Emergency Security Patch (Before Rebuild Begins)

**Deliverable:** One small migration file and its rollback, applied to the current (live) database. Fixes the 4 no-RLS PII tables and the most obvious GRANT gaps.

**Rationale:** Even though the rebuild will replace this database in 2-3 weeks, leaving known security holes open in the interim is bad discipline. If anything real were to get into those tables before the rebuild completes, closing the holes afterward doesn't undo the exposure. Close them now.

**Scope:**

1. Enable RLS on the 4 identified PII tables:
   - `chiefos_actor_identities`
   - `chiefos_actors`
   - `chiefos_tenant_actors`
   - `chiefos_tenant_actor_profiles`
2. For each, add baseline tenant-scoped policies following the existing pattern from Session 2's migrations:
   - SELECT allowed when `tenant_id IN (SELECT tenant_id FROM chiefos_portal_users WHERE user_id = auth.uid())` or equivalent membership check
   - INSERT / UPDATE / DELETE tightened per the table's actual access pattern
3. Backfill GRANTs on the 26 tables flagged in Session 3's audit. Use the same pattern Session 2 used.
4. Add a single-line warning comment to each of the 20 SECURITY DEFINER functions: `-- TO BE REVIEWED IN FOUNDATION_REBUILD_V2 PHASE 2. If this function is dropped or replaced, confirm no app dependency.` This comment is informational only; it doesn't change function behavior.

**Not in scope:** Redesigning the SECURITY DEFINER functions, reconciling untracked tables, or any work beyond the immediate security gaps. This is surgical.

**Completion criteria:**
- Migration applied to the live database
- Post-patch verification: re-run the GRANT audit and RLS policy check; the 4 PII tables now have RLS; the 26 GRANT bugs are resolved
- Rollback file exists and has been tested (apply rollback, re-apply migration, confirm clean)
- Session 2's 171 tests still pass (no regression)
- Portal and WhatsApp capture flows verified working (confirm Beta app hasn't broken due to tightened RLS)

**Founder Checkpoint 0.5:** Quick verification that the live app still works after the patch. If any Beta user reports a broken flow, patch immediately or roll back.

**Estimated duration:** 1 Claude Code session, 2-3 hours.

---

### Phase 1 — Schema Design

**Deliverable:** `FOUNDATION_P1_SCHEMA_DESIGN.md` in project root. Master design for the rebuilt database.

**Scope and method:** Identical to V1's Phase 1. Design the clean schema from authoritative docs forward, then cross-check against Session 2.5's catalog to classify every existing object as KEEP-AS-IS, KEEP-WITH-REDESIGN, or DISCARD.

**Sources:**
- `01_CHIEFOS_NORTH_STAR.md`, `03_CHIEFOS_ENGINEERING_CONSTITUTION.md`, `04_CHIEFOS_MONETIZATION_AND_PRICING.md`
- `RECEIPT_PARSER_UPGRADE_HANDOFF.md` §5
- Session 2's successful migration files
- `SESSION_2_5_SCHEMA_DRIFT_CATALOG.md`

**Output format:** Per-table design pages specifying columns, constraints, indexes, RLS policies, GRANTs, isolation test plan, and authoritative-doc reference.

**Completion criteria:**
- Every current schema object classified (KEEP-AS-IS, KEEP-WITH-REDESIGN, DISCARD)
- DISCARD list has explicit justification per item
- Every KEEP has a full design page
- Identity model compliance verified (tenant_id + owner_id where applicable)
- Quota architecture (Constitution §11) incorporated
- Session 2 receipt parser tables incorporated with the already-tested DDL

**Founder Checkpoint 1:** Review the schema design document. Specifically confirm the DISCARD list — these are objects currently in the database that will not exist in the rebuild.

**Estimated duration:** 2-3 Claude Code sessions.

---

### Phase 2 — Security-Sensitive Object Review

**Deliverable:** `FOUNDATION_P2_SECURITY_REVIEW.md` in project root.

**Scope reduced from V1:** V1's Phase 2 treated this as a forensic audit to determine re-implementation paths. Because V2 is rebuilding from scratch without needing to reproduce current behavior exactly, Phase 2 becomes simpler: for every SECURITY DEFINER function, untracked trigger, and non-standard RLS policy in the current database, answer two questions:

1. **Is this object providing functionality the app actually uses?** (If no → DISCARD confidently.)
2. **If yes, what's the cleanest re-implementation?** (Usually: an explicit policy, a SECURITY INVOKER function with tight argument validation, or moving the logic out of the database entirely into app code.)

**Specific high-priority review: `chiefos_set_user_role`.** This function's name suggests privilege mutation. Review its body, determine whether privilege management should happen in the database at all (usually: no, use RLS policies instead), and specify the replacement approach.

**Completion criteria:**
- Every SECURITY DEFINER function has a decision: DISCARD, KEEP-AS-SECDEF-HARDENED, or REIMPLEMENT-AS-INVOKER
- Every untracked trigger has a decision: DISCARD or KEEP-AS-DESIGNED
- Every non-standard RLS policy (uses `auth.uid()` comparison instead of membership, has `USING (true)`, etc.) has a redesign
- `chiefos_set_user_role` specifically has an audit note with the replacement approach

**Founder Checkpoint 2:** Review the security decisions. The DISCARD list in particular — these are things the database currently has that won't be rebuilt. Confirm nothing load-bearing is being dropped.

**Estimated duration:** 2 Claude Code sessions.

---

### Phase 3 — Clean Migration Authorship

**Deliverable:** A complete `migrations/` directory (replacing or superseding the current one) containing every migration file needed to build the Phase 1 schema end-to-end on a fresh database.

**Scope:** Same as V1. Migrations sequenced by dependency (identity → canonical spines → feature tables → views → functions → triggers → policies → grants). Every migration idempotent, every migration with a rollback file, every migration with a comment block citing the authoritative doc source.

**New for V2:** Because the rebuild is a full drop-and-rebuild rather than additive migrations to an existing database, the migration set can be simpler than V1 assumed — no need for `CREATE TABLE IF NOT EXISTS` defensive patterns against existing state, because the state will be empty when migrations run. However, **keep the idempotent patterns anyway**, because:

1. The same migrations will apply to the new dev environment (Phase 6) where idempotency matters
2. Future migration runs need idempotency as a permanent property
3. Session 2's existing pattern is idempotent and should be matched

**Completion criteria:**
- All migrations authored
- All rollback files authored
- Schema drift check script (`scripts/schema_drift_check.js`) implemented
- Dry-run against an empty test database: all migrations apply cleanly, drift check exits code 0

**Founder Checkpoint 3:** Review the migration set. Readable top-to-bottom as a coherent architectural narrative.

**Estimated duration:** 3-4 Claude Code sessions.

---

### Phase 4 — Application Code Audit

**Deliverable:** `FOUNDATION_P4_APP_DEPENDENCIES.md`.

**Scope:** Same as V1. For every object in the Phase 1 DISCARD list, grep the codebase and identify every dependency. Classify each as BLOCKING (must fix before cut-over) or SAFE (can fix post-cut-over). Specify the fix for each BLOCKING dependency.

**Completion criteria:**
- All BLOCKING dependencies documented with fix plans
- No surprise dependencies remaining

**Founder Checkpoint 4:** Confirm the BLOCKING remediation scope.

**Estimated duration:** 1-2 Claude Code sessions.

---

### Phase 5 — Rebuild and Cut-Over (Simpler in V2)

**Deliverable:** The current Supabase project has been reset. All data wiped. Schema rebuilt from the Phase 3 migrations. BLOCKING app remediations from Phase 4 applied. App is operational against the rebuilt database.

**Steps:**

1. **Announce the reset window to Beta users.** They're already expecting it; confirm the date and set expectations (~2 hour maintenance window).
2. **Take the app into maintenance mode** (simple static page at root URL).
3. **Drop everything in the current Supabase project's `public` schema.** Tables, views, functions, triggers, sequences, types — all of it. This is the clean-slate action. If there's hesitation here, that's the signal to double-check that all answers to the original three questions are still accurate.
4. **Apply all Phase 3 migrations** in dependency order against the now-empty database.
5. **Run the schema drift check.** Must exit code 0.
6. **Run Session 2's 171-test suite.** Must pass 171/171.
7. **Apply Phase 4's BLOCKING app remediations.**
8. **Run the four end-to-end walkthroughs** (WhatsApp capture, portal flows, quotes, timeclock) against the rebuilt database.
9. **Cross-tenant isolation test.**
10. **Lift maintenance mode.**
11. **Watch logs for 48 hours.** Any error pattern not seen in walkthroughs gets investigated immediately.

**Completion criteria:**
- Rebuilt database operational
- Schema drift check green
- All 171 Session 2 tests pass
- End-to-end walkthroughs successful
- Cross-tenant isolation confirmed
- 48-hour error monitoring clean
- Beta users can successfully re-onboard when they return

**Founder Checkpoint 5:** After 48 hours of clean operation, confirm stability before moving to Phase 6.

**Estimated duration:** 1-2 Claude Code sessions plus 48-hour monitoring window.

---

### Phase 6 — Dev Environment Provisioning + Constitution Update

**Deliverable:** A new Supabase project serving as dev/staging, with the same migrations applied to it. Engineering Constitution updated with the binding "single source of truth" rule.

**Why this is separate from Phase 5:** V1 collapsed everything into Phase 5. V2 splits dev environment provisioning into its own phase because it's not strictly required for the rebuild to succeed — it's the *permanent operational improvement* that prevents the drift problem from recurring. Getting it right deserves its own focus.

**Steps:**

1. **Provision a second Supabase project** specifically for dev/staging. Name it clearly (e.g., `chiefos-dev` vs. the existing production project).
2. **Apply all Phase 3 migrations to the dev project.** The schema drift check must also pass here.
3. **Establish the operational policy:** every future schema change lands in dev first, is tested, then applies to production. Document this in a new file: `OPERATIONS_RUNBOOK.md` or similar.
4. **Update `03_CHIEFOS_ENGINEERING_CONSTITUTION.md`** with the new §5.X subsection:

```markdown
### 5.X Single Source of Truth + Environment Separation

The `migrations/` directory is the single source of truth for all schema objects
in the database. This is a binding rule with no exceptions.

ChiefOS operates two database environments: dev (staging) and production.
Every schema change applies to dev first, is tested, and then applies to
production. Schema drift detection runs before any migration is considered
complete in either environment.

**Forbidden:**
- Creating, altering, or dropping schema objects via Supabase Studio, psql,
  the Supabase SQL Editor, or any tool that does not produce a tracked
  migration file
- Applying migrations directly to production without first applying and
  testing in dev
- Long-lived divergence between dev and production schemas

**Required:**
- Every schema change lands as a tracked, reviewable migration file
- Every migration is idempotent
- Every migration has a rollback file
- The schema drift check passes in both environments before a migration
  sequence is considered complete

This rule exists because schema drift makes the system non-deterministic,
and environments without separation make drift inevitable.
```

5. **Update `CLAUDE.md`** with a one-line reminder pointing at §5.X.
6. **Produce `FOUNDATION_REBUILD_V2_FINAL_REPORT.md`** documenting the rebuild outcome: what was found, what was rebuilt, what policies now prevent recurrence, and the path forward (Plan V2 Session 3 resumes).

**Completion criteria:**
- Dev Supabase project operational with identical schema
- Constitution updated
- CLAUDE.md updated
- Operations runbook produced
- Final report produced

**Founder Checkpoint 6 (final):** Confirm the project is complete. Plan V2 Session 3 has a clear start signal.

**Estimated duration:** 1 Claude Code session.

---

## 6. Revised Timeline

Summing the phase estimates:

- Phase 0.5: 1 session (~2-3 hours)
- Phase 1: 2-3 sessions
- Phase 2: 2 sessions
- Phase 3: 3-4 sessions
- Phase 4: 1-2 sessions
- Phase 5: 1-2 sessions + 48-hour monitoring
- Phase 6: 1 session

**Total: 11-15 focused Claude Code sessions, plus a 48-hour monitoring window.**

At your pace of ~3-5 sessions per week of early-morning work: **2-4 weeks elapsed time** before Plan V2 Session 3 resumes.

This is shorter than V1's 3-6 week estimate because:
- Phase 0 is eliminated (no divergence to diagnose)
- Phase 6 (Beta Cut-Over) is simpler because users are already informed and data is disposable
- Phase 7 (Archive) is eliminated (the database is dropped, not archived)

---

## 7. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Phase 0.5 security patch breaks portal access for Beta users due to tightened RLS | Low-Medium | Medium | Test on a subset of flows before full patch; have rollback ready; monitor logs for 24h post-patch |
| Phase 2 discovers a SECURITY DEFINER function that is load-bearing in non-obvious ways | Medium | Medium | Phase 4 app audit is a second chance to catch this before cut-over |
| Phase 4 app audit finds more BLOCKING dependencies than expected | Medium | Medium | Checkpoint 4 reviews scope; expansion triggers plan revision |
| Phase 5 cut-over reveals an issue during walkthroughs | Medium | High | Maintenance window is 2 hours; if walkthroughs fail, roll back to the pre-reset state (which still has the Phase 0.5 patches) |
| Beta users don't re-onboard | Medium | Low-Medium | They're already informed; if return rate is low, the product has other problems and you want to know that before public launch |
| Scope creep ("while we're rebuilding, let's also...") | High | Medium | §3 Non-Goals explicit; every session reviews against plan |
| An untracked object turns out to be referenced by a scheduled task (pg_cron, Supabase cron) we didn't know about | Low | Medium | Phase 1 catalog includes pg_cron inventory; Phase 4 app audit cross-checks |

---

## 8. Non-Goals

Out of scope for V2 rebuild:

- Redesigning features or adding new capability
- Migrating or preserving Beta user data (disposable per founder confirmation)
- Rebuilding the receipt parser (that's Plan V2, post-rebuild)
- Refactoring `expense.js` beyond Phase 4 BLOCKING fixes
- Changing external integrations (Twilio, Stripe, Document AI)
- Building the LLM auditor (Plan V2 Session 4)
- Modifying the product's positioning, pricing, or brand posture
- Adding schema objects beyond what Phase 1 specifies
- Any schema change via tools other than tracked migrations (this becomes the permanent policy per §5.X)

---

## 9. Authoritative Decisions Captured Before Plan Begins

Per founder on 2026-04-21:

1. **Option B (rebuild on clean ground) is confirmed.**
2. **Single Supabase project confirmed;** no separate production database exists.
3. **All data is disposable;** no preservation required.
4. **Beta users already informed of the reset;** fresh-start expectation is set.
5. **Schema drift prevention is binding going forward** (new Engineering Constitution §5.X).
6. **Proper dev/prod separation is a rebuild deliverable;** not optional.

---

## 10. Success Criteria

The Foundation Rebuild V2 is complete when:

- Current Supabase project has been reset; schema rebuilt from tracked migrations
- New dev/staging Supabase project exists with the same schema
- Schema drift check exits code 0 in both environments
- All 171 Session 2 tests pass against the rebuilt production
- Zero SECURITY DEFINER functions exist without explicit audit justification
- Zero PII tables without RLS
- Zero tables without GRANTs to `authenticated` and `service_role`
- Engineering Constitution §5.X binding rule applied
- CLAUDE.md and operations runbook updated
- Beta users can successfully re-onboard
- 48-hour post-cut-over monitoring clean
- Final report produced
- Plan V2 Session 3 (Validation Service) has a clear ready-to-start signal

When all are true, the receipt parser upgrade resumes on a foundation that supports the trust claim the product makes.

---

**End of Foundation Rebuild Plan V2.**
