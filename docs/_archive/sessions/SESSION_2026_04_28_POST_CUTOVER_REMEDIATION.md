# Session 2026-04-28 — Path α + Post-Cutover Cleanup + Phase 1 Stage Gates

**Duration:** ~14 hours.
**Status:** Closed. Phase 1 schema migrations deferred to next session.

## Outcomes

### PRs merged

| PR | Repo | Title |
|---|---|---|
| #3 | chief-ai-refactored | Path α — onboarding RPC refactor (P1A-7 through P1A-11) |
| #4 | chief-ai-refactored | Post-cutover stale-work cleanup (R4 + R3b + R4b + R1 + CLAUDE.md surgical fix + P1A-12) |
| #5 | chief-ai-refactored | docs: methodology bullet 7 — submodule SHA reachability |
| #1 | chiefos-site | Path α + R2.5 phone-link + R3b crew + /api/log rewrite |

### Production state

- **chief-ai-refactored production:** main HEAD `1a79eab2` (PR #5 merge). Includes Path α RPC + R3b crew rewrite + R4 reminders + R4b RAG fail-closed + R1 dead-code deletions + /api/log rewrite + 6 P1A migrations + audit methodology bullet 7.
- **chiefos-site production:** merge commit `8a23ae6` containing api-log-rewrite tip `a8e2b40`. Includes Path α onboarding (un-gated signup + finish-signup + tester-access) + R2.5 phone-link refactor + R3b crew inbox UI pivot + /api/log full handler.

### Schema migrations applied to production (`tctohnzqxzrfijdufrss`)

| Migration | Purpose |
|---|---|
| P1A-7 | `chiefos_finish_signup` RPC — atomic onboarding spine |
| P1A-8 | RLS recursion fix (3 policies on `chiefos_portal_users` + `supplier_users`) via SECURITY DEFINER helpers |
| P1A-9 | `UNIQUE (tenant_id, auth_user_id)` on `chiefos_legal_acceptances` for ON CONFLICT idempotency |
| P1A-10 | `GRANT UPDATE ON chiefos_legal_acceptances TO service_role` (parity with peer tables) |
| P1A-11 | Schema-side COMMENT documenting the deliberate DELETE-grant asymmetry from P1A-10 |
| P1A-12 | `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO service_role` + ALTER DEFAULT PRIVILEGES |

### Stage-gate results — all PASS

| Gate | Result | Detail |
|---|---|---|
| 1. MVP regression | PASS | 881/905 tests pass. 24 failures all pre-existing test debt (timecalc.test.js × 4 worktree copies + quotes.test.js Phase A 5 integration block). Zero today-introduced regressions. |
| 2. Twilio 11200 | PASS | 0 hits over 7 days; acceptance <10. |
| 3. Plan fail-closed | PASS (schema-stronger-than-test) | `users.plan_key NOT NULL + CHECK in {free,starter,pro,enterprise}` prevents the corruption vector entirely. Free-tier gate verified live during Path α step-7 retest. |
| 4. Stripe webhook signature | PASS | Malformed-signature POST returned HTTP 400; `stripe_events` row delta = 0; signature rejection fired pre-DB-write. |
| 5. Backup recency | PASS | Last Supabase physical backup: 2026-04-28 07:14 UTC; acceptance ≤24h. |

**Verdict: PROCEED to Phase 1 schema migrations.** Deferred to next session per founder fatigue + spec-not-in-repo gate.

## Surfaced today

### 12 R2.5-class "uncommitted-but-claimed-shipped" instances

The session-reports audit caught 6 of these; the other 6 surfaced via adjacent-work discovery (production bug investigation, link-phone diagnosis, working-tree characterization, branch-level audit). Pattern indicates session-reports audit alone is insufficient — `P1B-comprehensive-working-tree-audit` methodology updated to add 7 bullets including grep-all-supabase.from() and verify-submodule-SHA-reachable-from-main.

| # | Surface | Resolved this session |
|---|---|---|
| 1 | R2.5 chiefos-site phone-link refactor (3 files) | yes (chiefos-site `7f2b0eb`) |
| 2 | chief-ai-refactored identity rewrites (`middleware/userProfile.js` + 2 others) | yes (`f6efcd68`) |
| 3 | R4 reminders + memory rewrite (5 files) | yes (`f58f6a33`) |
| 4 | R3b crew rewrite (4 files + 1 chiefos-site) | yes (`a1cb5315`) |
| 5 | R4b RAG fail-closed (1 file) | yes (`0070c616`) |
| 6 | R1 dead-code deletions (10 files) | yes (`dcc0f31d`) |
| 7 | Phase A Session 5 ReissueQuote (5 files) | tracker filed; tests fail with fixture issue |
| 8 | schema-drift-check script (1 file untracked + package.json) | tracker filed |
| 9 | R4c-migrate actor-memory→conversation_sessions (5 files) | tracker filed |
| 10 | CLAUDE.md discipline rewrite | surgical `<TABLE>` fix shipped; rewrite tracker filed |
| 11 | api-log-rewrite + ancestor branches not merged to chiefos-site main | yes (chiefos-site PR #1) |
| 12 | Beta Delta Appendix Quote-spine cleanup (4 files) | tracker filed |

### 6 schema-side bug classes surfaced

1. **Missing UNIQUE for ON CONFLICT** (P1A-9 fix) — `chiefos_legal_acceptances` lacked the arbiter; same class as the chiefos_beta_signups upsert caught earlier.
2. **Self-referential RLS subqueries** (P1A-8 fix) — `chiefos_portal_users` + `supplier_users` policies subqueried their own table, 42P17 infinite recursion under authenticated client load.
3. **Missing GRANT to service_role on table-level mutation** (P1A-10 fix) — `chiefos_legal_acceptances` lacked UPDATE.
4. **Missing GRANT to service_role on sequence USAGE** (P1A-12 fix) — 7 public sequences had zero service_role grants; bigserial INSERTs 42501'd until granted.
5. **CHECK constraint vocabulary divergence** — `transactions.submission_status {confirmed/pending_review/voided}` vs `tasks/time_entries_v2 {approved/pending_review/needs_clarification/rejected}` and `accepted_via {portal/whatsapp/email/api}` vs FE-emitted `signup/tester_signup` lifecycle terms. Tracker filed.
6. **Stale-schema-reference in committed code** — `chiefos_user_identities` (chief-ai-refactored), `chiefos_link_codes` (chiefos-site), `jobs.job_name` + `jobs.active` (chiefos-site jobs FE), all DROPPED post-rebuild. Multiple instances; pattern-level audit methodology added.

### 13 P1B trackers filed (running tally)

1. P1B-user-memory-kv-rebuild-target-decision
2. P1B-phase-a-5-reissuequote-deferred
3. P1B-schema-drift-check-script-commit
4. P1B-beta-delta-appendix-quote-spine-cleanup
5. P1B-r4c-migrate-actor-memory-conversation-sessions
6. P1B-email-ingest-defensive-fixes
7. P1B-claude-md-discipline-doc-rewrite
8. P1B-comprehensive-working-tree-audit (meta-tracker; 7 methodology bullets)
9. P1B-source-msg-id-unique-on-task-time-reminder
10. P1B-submission-status-vocabulary-normalization
11. P1B-jobs-fe-stale-schema-references
12. P1B-api-log-idempotency-conflict-response-code
13. P1B-tmts-spec-commit-to-repo

Plus follow-ups from stage-gate validation:
- P1B-timecalc-test-fixture-update
- P1B-jest-worktree-exclusion

## Tomorrow's queue

1. **Commit/paste TMTS spec into repo** (`P1B-tmts-spec-commit-to-repo`) — required precondition for §4.1 + §4.2 migration authoring.
2. **Phase 1 schema migrations** per TMTS §4.1 + §4.2:
   - `2026_04_NN_001_add_trial_lifecycle_columns.sql` — lifecycle_state + trial/extension/read_only/archived timestamps + founding_member_slot fields + partial indexes.
   - `2026_04_NN_002_update_plan_keys.sql` — extend `users.plan_key` CHECK to include trial-era values while preserving `'free'` for migration backward-compat.
3. Phase 1 is **non-destructive schema-only**; no application code changes. Phase 2 (new-signup behavior) and Phase 3 (existing-Free-user grandfather migration) are separate workstreams.

## Process lessons

- **Verification-first discipline catches drift but not absence.** The session-reports audit found uncommitted work where the report claimed it. It missed 4 cases where the work was uncommitted but no report existed (or the report mentioned related-but-different work). Working-tree characterization is the complementary methodology.
- **Branch-level uncommitted work is a distinct bug class.** Pushing feature branches without opening PRs leaves submodule pointers as ghost references — the parent build resolves the SHA but the submodule's own production deploy follows main only.
- **Schema migrations land cleanly when verified pre-write.** Every P1A migration today (7 through 12) included introspection of current production schema before authoring INSERT/CHECK/GRANT semantics. Zero post-apply rollbacks needed.
- **Auto-mode + per-commit gates is the right balance.** Founder approved each commit's diff before push; auto-mode handled mechanical follow-up (push, PR creation, tracker filing). Surface granularity calibrated to stakes.
