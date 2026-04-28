# SESSION R4b — RAG Schema Compliance Audit (Partial Scope)

**Date:** 2026-04-24
**Directive Version:** 1
**Scope:** Audit only. Per directive STOP #3, Classification C escalates before any modification.
**Predecessor:** R4 (memory + reminders call-site migration)

---

## 1. Executive Summary

**Classification: C (substantial RAG code).** Six live RAG-adjacent files in the repository, four of them production-wired:
- `services/tools/rag.js` — vector RAG (pgvector), used by Chief agent
- `services/rag_search.js` — tsvector keyword RAG, used by orchestrator + answerSupport
- `services/answerSupport.js` — RAG + Haiku fallback for `/askChiefStream` and orchestrator support routing
- `services/ragTerms.js` — glossary lookup, used by `routes/webhook.js`
- `scripts/ingestRAG.js` — one-shot CSV ingest CLI (not in request path)
- `services/learning.js` — **dead surface** (zero live importers); writes to `tenant_knowledge` AND to `user_profiles` (which does NOT exist in rebuild)

**Headline finding:** The live RAG SQL is **already schema-compatible with P1A-3**. P1A-3 was authored by reading the same producer/consumer code that's still live — this is documented in the migration headers (e.g., `amendment_rag_docs.sql:29`: "Consumer patterns (services/tools/rag.js + services/rag_search.js)..."). Per directive STOP #3, Classification C escalates without modification.

**Recommended option for founder: (b) Preserve as-is for Beta.** Practical migration delta is near-zero. Two flagged items §11 require founder decision: (F1) `services/learning.js` is dead surface AND references non-existent `user_profiles` table — drop or wire back; (F2) `services/tools/rag.js` defaults `ownerId='GLOBAL'`, which can leak cross-tenant data if callers omit ownerId — verify enforcement.

**Zero schema changes. Zero crew touch. Zero actor-memory touch. Zero code modifications in this session** (per Classification C STOP).

---

## 2. V1-V5 Verification Outcomes

### V1 — P1A-3 target tables exist and match spec ✅
- `public.docs` → `migrations/2026_04_22_amendment_rag_docs.sql` (lines 74-87)
- `public.doc_chunks` → same migration (lines 142-156). `vector(1536)` matches OpenAI `text-embedding-3-small` per `services/tools/rag.js:67`.
- `public.rag_terms` → `migrations/2026_04_22_amendment_rag_terms.sql` (lines 37-48). GLOBAL-scoped, no tenant_id.
- `public.tenant_knowledge` → `migrations/2026_04_22_amendment_tenant_knowledge.sql` (lines 66-84). DRIFT-CORRECTED `owner_id uuid → text` per Forward Flag 19.

No spec-vs-migration divergence detected.

### V2 — pgvector ✅ (deferred to cutover)
P1A-3 migration includes `CREATE EXTENSION IF NOT EXISTS vector;` (line 47) and preflights existence (line 52). Production has pgvector 0.8.0 per migration header introspection note. Dev DB state not verified by R4b — pre-cutover concern tracked in `PHASE_5_PRE_CUTOVER_CHECKLIST.md`.

### V3 — Live-code RAG surface grep — **CLASSIFICATION C**

**Live files (excluding worktrees, archive, migrations):**

| File | Lines | Tables touched | Live importers | Production-wired? |
|---|---|---|---|---|
| `services/tools/rag.js` | 188 | `docs`, `doc_chunks` | `services/agent/index.js:39` | ✅ Yes — Chief agent |
| `services/rag_search.js` | 123 | `doc_chunks` | `services/orchestrator.js:5`, `services/answerSupport.js:7` | ✅ Yes — orchestrator + answerSupport |
| `services/answerSupport.js` | 166 | (calls rag_search) | `services/orchestrator.js:512`, `routes/askChiefStream.js:24` | ✅ Yes — `/askChiefStream` route |
| `services/ragTerms.js` | 16 | `rag_terms` | `routes/webhook.js:3872` (`findClosestTerm`) | ✅ Yes — webhook glossary nudge |
| `scripts/ingestRAG.js` | 41 | `rag_terms` | (CLI script, no module importers) | ⚠️ One-shot CLI, not in boot path |
| `services/learning.js` | 62 | `tenant_knowledge`, `user_profiles` | **NONE** (only worktree copies) | ❌ Dead surface |

**Verdict:** 6 live files, ≥4 with production-wired RAG calls + functional embedding pipeline (services/tools/rag.js does OpenAI embeddings + pgvector cosine search end-to-end). **Classification C** per directive §V3.

### V4 — Crew-cluster quarantine check ✅
```
grep "chiefos_activity_logs|crewControl|crewReview|chiefos_activity_log_events" services/tools/rag.js services/rag_search.js services/learning.js services/ragTerms.js services/answerSupport.js scripts/ingestRAG.js
```
Result: zero hits. R3b quarantine intact.

### V5 — Actor-memory cluster avoidance check ✅
```
grep "chief_actor_memory|getActorMemory|patchActorMemory" services/tools/rag.js services/rag_search.js services/learning.js services/ragTerms.js services/answerSupport.js scripts/ingestRAG.js
```
Result: zero hits. RAG layer does not depend on actor-memory cluster. R4c can proceed independently.

---

## 3. Per-File Schema Alignment vs P1A-3

This section documents what *would* need to change IF the founder picks option (a) "expand to migration" — or stays the same under option (b) "preserve as-is." It is informational; no code was modified.

### 3.1 `services/tools/rag.js`

**Live query:**
```sql
select d.title, d.path, c.content, c.metadata
  from doc_chunks c
  join docs d on d.id = c.doc_id
 where c.owner_id = $1
 order by c.embedding <=> $2::vector
 limit $3
```

**P1A-3 alignment:**
- ✅ All columns referenced exist: `docs.title`, `docs.path`, `doc_chunks.content`, `doc_chunks.metadata`, `doc_chunks.doc_id`, `doc_chunks.owner_id`, `doc_chunks.embedding`
- ✅ Cosine `<=>` operator supported by `doc_chunks_embedding_ivfflat_idx` (vector_cosine_ops, lists=100)
- ✅ Embedding dimension `vector(1536)` matches `text-embedding-3-small` used at `rag.js:67`
- ✅ JOIN target exists with proper FK (`doc_chunks.doc_id REFERENCES docs(id) ON DELETE CASCADE`)
- ⚠️ Uses its own `pg.Pool` (line 14-28) instead of the shared `services/postgres.js` query helper. Functional but inconsistent with rebuild app patterns.
- ⚠️ Default `ownerId = 'GLOBAL'` (lines 80, 115, 127, 182). If a caller omits ownerId → cross-tenant + GLOBAL data returned. **Per North Star §14 this is a leakage risk** unless callers are audited.

**Migration delta:** None required for schema correctness. Optional cleanup: switch to shared pg.query, audit ownerId callers.

### 3.2 `services/rag_search.js`

**Live query (with cap-detection):**
```sql
select content, [source | null::text as source]
  from public.doc_chunks
 where to_tsvector('english', content) @@ plainto_tsquery('english', $1)
   [+ owner_id = $2 if hasOwnerId column]
   [+ tenant_id = $3::uuid if hasTenantId column]
 order by id desc
 limit $k
```

**P1A-3 alignment:**
- ✅ `content` column exists
- ✅ `owner_id` exists → `hasOwnerId` cap returns true → filter applies
- ⚠️ `source` column does NOT exist on `doc_chunks` (it exists on `docs`). cap-detection sets `hasSource=false` → falls back to `null::text as source`. Safe — returns null source field.
- ⚠️ `tenant_id` does NOT exist on `doc_chunks` (P1A-3 uses owner_id-only scoping per North Star §14). cap-detection sets `hasTenantId=false` → no tenant predicate. Safe.
- ⚠️ tsvector computed on the fly (`to_tsvector('english', content) @@ plainto_tsquery(...)`). No materialized tsvector index in P1A-3. Functional but slow at scale; flagged in migration header as deferred.
- ⚠️ Default `ownerId = null` (line 87). If neither callers pass ownerId, cap-detected `hasOwnerId=true` filter is skipped (predicate `cols.hasOwnerId && ownerId` is false) → cross-tenant return. **Same leakage risk as 3.1.**

**Migration delta:** None for schema. The cap-detection layer (`getDocChunksColumns`) becomes a permanent passthrough since P1A-3 columns are stable. Could be removed for clarity; not required.

### 3.3 `services/answerSupport.js`

**Live behavior:** No direct DB queries. Calls `ragAnswer({ text, ownerId })` from rag_search.js (line 125). Falls back to Claude Haiku with embedded `CHIEFOS_KNOWLEDGE` constant. No schema concerns.

**Tenant-isolation note:** Passes `ownerId` through to ragAnswer; if upstream `routes/askChiefStream.js:207` or `services/orchestrator.js:513` omits ownerId, leakage risk inherits.

**Migration delta:** None.

### 3.4 `services/ragTerms.js`

**Live query:**
```sql
SELECT term, meaning, cfo_map, nudge
  FROM public.rag_terms
 WHERE lower(term) = $1
 LIMIT 1
```

**P1A-3 alignment:**
- ✅ All columns exist exactly: `term`, `meaning`, `cfo_map`, `nudge`, `source`, `id`, `created_at`, `updated_at`
- ✅ `lower(term)` lookup uses `rag_terms_lower_term_unique` index (P1A-3 ADDS this UNIQUE per migration line 52)
- ✅ Table is GLOBAL (no tenant scoping needed) — North Star §14 compatible (shared glossary, not per-tenant data)

**Migration delta:** None. P1A-3 ADDED the UNIQUE constraint that wasn't present pre-rebuild — this *strengthens* the lookup but doesn't change `findClosestTerm` behavior.

### 3.5 `scripts/ingestRAG.js`

**Live query:**
```sql
INSERT INTO public.rag_terms (term, meaning, cfo_map, nudge, source)
VALUES ($1,$2,$3,$4,$5), ...
ON CONFLICT (id) DO NOTHING
```

**P1A-3 alignment:**
- ✅ Columns match
- ⚠️ `ON CONFLICT (id) DO NOTHING` — `id` is PK uuid with `DEFAULT gen_random_uuid()`. Each insert generates a new id, so this conflict clause never fires. Re-running the script will create duplicate (term, meaning, ...) rows EXCEPT the new P1A-3 unique index `rag_terms_lower_term_unique` will reject duplicates on `lower(term)` — script will FAIL on second run.
- This is technically a behavior change introduced by the rebuild's UNIQUE addition. Pre-rebuild allowed dupes; rebuild rejects them. The script is a one-shot CLI used for the initial 16-row ingest; re-runs are not the expected workflow. Acceptable.

**Migration delta:** Optional cleanup — change `ON CONFLICT (id) DO NOTHING` → `ON CONFLICT (lower(term)) DO NOTHING` (or `ON CONFLICT ON CONSTRAINT rag_terms_lower_term_unique DO NOTHING`) for re-run safety. Not required for cutover.

### 3.6 `services/learning.js` — **DEAD SURFACE**

**Live queries:**
```sql
-- Line 7
UPDATE user_profiles SET last_seen_at=now() WHERE owner_id=$1

-- Lines 41-48
UPDATE user_profiles
   SET preferences = COALESCE(preferences,'{}'::jsonb) || jsonb_build_object($2,$3),
       updated_at = now()
 WHERE owner_id=$1

-- Lines 54-59
INSERT INTO tenant_knowledge(owner_id, kind, key)
VALUES ($1,$2,$3)
ON CONFLICT (owner_id, kind, key)
DO UPDATE SET last_seen=now(), seen_count=tenant_knowledge.seen_count+1
```

**P1A-3 alignment:**
- ✅ `tenant_knowledge`: columns + PK match exactly. Drift correction (uuid → text on owner_id) MAKES THIS WORK — pre-rebuild it was broken (text owner_id rejected by uuid column, production row count = 0 per Forward Flag 19).
- ❌ **`user_profiles` does NOT exist in any rebuild migration.** Searched all `migrations/*.sql` (excluding rollbacks/phase5) — zero CREATE TABLE for user_profiles. If `learnFromEvent` is ever called post-cutover, lines 7 + 41-48 will throw "relation user_profiles does not exist."

**Live importers:** ZERO. `grep -rn "require.*services/learning"` returns only worktree copies. The function is defined but no live code imports it.

**Migration delta:** None NEEDED (dead surface). But:
- If founder wants to revive `learnFromEvent`, the `user_profiles` UPDATE paths must be removed or pointed at a rebuild table (no obvious replacement — `public.users` doesn't have `last_seen_at` or `preferences`)
- If founder wants to delete, remove the file + flag for any future RAG sessions

---

## 4. Founder Decision Required (per directive §3C.2)

The directive STOP #3 specifies escalation. Three options:

### Option (a) — Expand R4b into full RAG design session
**Cost:** Significant. Embedding provider re-evaluation (currently OpenAI text-embedding-3-small + Haiku for support fallback), retrieval pipeline review (vector vs tsvector hybrid), Ask Chief grounding redesign, evaluation harness. Likely 2-4 sessions.
**Benefit:** RAG production hardening BEFORE Beta.
**Recommended only if:** RAG is a Beta blocker (not deferred per Execution Playbook §6 item 7).

### Option (b) — Preserve RAG code as-is for Beta ⭐ **RECOMMENDED**
**Cost:** Near-zero. P1A-3 schema was authored by reading the live code — alignment is already there. Two flagged items §11 (F1 dead-surface learning.js + F2 ownerId default leakage risk) addressed in standalone follow-ups.
**Benefit:** Beta ships with current RAG behavior. No surprises at cutover.
**Risk:** F2 (ownerId default = 'GLOBAL') could leak cross-tenant data if any caller omits ownerId. Mitigation: an audit of `services/agent/index.js`, `services/orchestrator.js`, `services/answerSupport.js`, `routes/askChiefStream.js` callers — confirms whether ownerId is always passed. If yes, no leakage. (Audit is small — fits in a half-session.)
**Best for:** Founder sequencing per Execution Playbook §6 item 7 (RAG sequenced after multi-turn context, post-Beta).

### Option (c) — Disable RAG code paths for Beta (feature-flag)
**Cost:** Add a `RAG_ENABLED` env var; wrap `searchRag`/`ragAnswer`/`answerSupport` calls in early-returns when flag is off. ~10 sites.
**Benefit:** Beta ships without any RAG-related risk surface. Hardening deferred completely.
**Risk:** Disables the support assistant (`answerSupport`'s Haiku fallback path uses RAG layer 1). May want to keep Haiku-only path enabled — meaning a more nuanced flag set.
**Best for:** Founder wants maximum Beta surface reduction at the cost of a richer support experience.

---

## 5. Tenant Data Checklist

Skipped per directive §4 — applies only to §3B path. R4b took §3C path; no new queries authored.

For reference (informs option-(b) audit suggestion in §4): the existing live code uses owner_id scoping (no tenant_id column on docs/doc_chunks/tenant_knowledge per P1A-3). North Star §14 isolation is enforced via:
- ingestion-time owner_id population (assumed correct — not audited in R4b)
- RLS policies on docs/doc_chunks/tenant_knowledge (P1A-3 enables — see migration §3 of each file)
- application-layer ownerId predicate (the leakage risk is HERE — F2 below)

---

## 6. Regression Checks

Per directive §5 §3C path: **No regression checks executed** — session halts before migration.

For completeness:
- ✅ V4 crew quarantine grep: zero hits
- ✅ V5 actor-memory grep: zero hits
- ✅ R4 modules untouched (`services/memory.js`, `services/reminders.js`, `workers/reminder_dispatch.js`)
- ✅ R3/R3a modules untouched (`services/actorContext.js`, `services/activityLog.js`)
- ✅ Crew cluster quarantine intact
- ✅ Zero files modified by R4b

---

## 7. Crew-Cluster Quarantine Affirmation

R4b modified zero files. Quarantined files (`services/crewControl.js`, `routes/crewControl.js`, `routes/crewReview.js`) untouched. R3b boundary intact.

---

## 8. Actor-Memory Cluster Quarantine Affirmation

R4b did not touch `services/postgres.js` `getActorMemory`/`patchActorMemory` or any of their callers (`services/agent/`, `services/answerChief.js`, `services/orchestrator.js`'s actor-memory paths). R4c-investigate scope unaffected.

V5 confirmed no RAG-actor-memory dependency: the RAG layer does not require actor memory. R4c-investigate can proceed independently.

---

## 9. R4c-investigate Entry Point

R4c-investigate's scope (per directive §9 + R4 report F1) is unaffected by R4b:
- ~25+ `patchActorMemory` call sites in `services/agent/index.js`
- callers in `services/answerChief.js`, `services/orchestrator.js`
- classification of session-scoped vs persistent-cross-session usage

R4b touched none of these. R4c-investigate can begin when founder approves.

---

## 10. Phase 5 Pre-Cutover Checklist Updates

R4b suggests two ADDITIVE entries (do not write yet — pending founder option choice):

**If option (b) chosen — under §3 "Code-side cleanup":**
> R4b audit confirmed RAG live code (services/tools/rag.js, rag_search.js, ragTerms.js, ingestRAG.js) is schema-compatible with P1A-3 amendments. No call-site migration required. Two flagged items deferred (F1 services/learning.js dead surface; F2 services/tools/rag.js ownerId='GLOBAL' default — caller audit recommended pre-cutover).

**If option (b) chosen — under §4 "Data migrations that aren't schema migrations":**
> RAG tables (docs, doc_chunks, rag_terms, tenant_knowledge) — see existing entry for tenant_knowledge owner_id type drift (transparent at cutover). For docs + doc_chunks: production has working pre-rebuild data; rebuild preserves the same column shape. NO data migration needed. rag_terms: production has 16 rows; rebuild ADDS a UNIQUE constraint on lower(term) — verify production has no duplicates before cutover (introspection query: `SELECT lower(term), COUNT(*) FROM public.rag_terms GROUP BY 1 HAVING COUNT(*) > 1`).

**If option (a) or (c) chosen — full design + flag work supersedes these.**

---

## 11. Flagged Items for Founder Review

### F1 — `services/learning.js` is dead surface AND broken-on-revival
Like `nlp/conversation.js` from R4 §F2, this file exports `learnFromEvent` but no live code imports it (only worktree copies). Additionally, it references `user_profiles` (lines 7, 41-48) which does NOT exist in any rebuild migration. If a future session wires `learnFromEvent` back into the CIL commit path, lines 7 + 41-48 will throw at runtime.

**Decision needed:**
- (a) Delete `services/learning.js` (safest — explicit removal of dead code)
- (b) Patch lines 7 + 41-48 to no-ops or to a real rebuild target (no obvious target exists; `public.users` lacks `last_seen_at` and `preferences`)
- (c) Leave as-is and trust that any reactivation will be paired with surgery on the user_profiles paths

R4 chose pattern (c) for `nlp/conversation.js`. Consistency suggests same here unless founder wants to act on it.

### F2 — `services/tools/rag.js` `ownerId='GLOBAL'` default — cross-tenant leakage risk
At lines 80, 115, 127, 182, ownerId defaults to `'GLOBAL'`. P1A-3 RLS allows authenticated users to read `owner_id='GLOBAL'` rows OR rows owned by their own tenant. The `services/tools/rag.js` module uses its own pg.Pool (DATABASE_URL) which connects as `postgres` superuser — **bypassing RLS entirely**. So if any caller omits ownerId, the search returns rows from ALL tenants whose data is in `doc_chunks`.

**Mitigation options:**
- (a) Remove the default; throw if ownerId is missing (fail-closed). Caller audit ensures all 3 known callers (`services/agent/index.js:39`, internal `searchRag`, `ragTool.__handler`) pass it explicitly.
- (b) Switch the module to use the shared `services/postgres.js` query helper which presumably runs with a proper role (verify this — the shared helper should NOT also be superuser for this concern to be resolved)
- (c) Document the leak as known and accept it for Beta (high risk — North Star §14 violation)

**Recommended:** (a). Trivial fix, ~5 lines. Could be done as part of option (b) "preserve as-is" without expanding scope into a full design session.

### F3 — RAG dual-implementation (vector + tsvector)
`services/tools/rag.js` does vector RAG (pgvector cosine), `services/rag_search.js` does tsvector keyword RAG. Both target `doc_chunks`. They serve different callers (Chief agent vs orchestrator/answerSupport). Not a pre-cutover blocker — the duplication can stand. Worth consolidating in the post-Beta RAG design session per Execution Playbook §6 item 7.

### F4 — `scripts/ingestRAG.js` re-run safety
The script's `ON CONFLICT (id) DO NOTHING` clause never matches (uuid PK with default = always-unique). The new P1A-3 unique index on `lower(term)` will reject duplicates on re-run. Trivial fix (change conflict target). Not a blocker — script is one-shot for initial 16-row ingest.

---

## 12. Open Questions

1. **Is RAG a Beta feature?** Execution Playbook §6 item 7 sequences "tenant-scoped RAG" after multi-turn context, suggesting post-Beta. But the live code is production-wired into `routes/askChiefStream.js` and `services/agent/index.js` today. Founder should confirm: is RAG enabled for Beta users?
2. **F2 ownerId leak** — does the founder want this addressed in R4b's tail (a small ~5-line fix that doesn't expand session scope), or in a separate hardening session?
3. **`services/tools/rag.js` connection management** — does the founder want this consolidated to `services/postgres.js` for consistency? Cleanup item, not a correctness issue.

---

## 13. R4c-investigate Sequencing Note

After founder picks an option for R4b:
- Option (b) [recommended] → R4c-investigate can start immediately. R4b adds at most ~5 lines (F2 fix) and a Phase 5 checklist note.
- Option (a) → R4c-investigate blocked behind ~2-4 RAG design sessions.
- Option (c) → R4c-investigate can start immediately after the feature-flag work lands.

---

## 14. Files Modified

**ZERO.** Per Classification C STOP #3, no code modified in R4b. Only this report ships.

---

**End of R4b report.** Awaiting founder option selection.
