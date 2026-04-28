# Session P1A-3 Migration Report

**Date:** 2026-04-22
**Scope:** Phase 1 Amendment Session 3 — RAG knowledge cluster (§3.14)
**Status:** DELIVERED

---

## 1. Production introspection findings

Ran before authoring. Used production as the authoritative spec (same discipline as P1A-2).

### docs
- `id uuid PK DEFAULT gen_random_uuid()`
- `owner_id text NOT NULL` (no tenant_id)
- `source text NOT NULL`, `title text`, `path text NOT NULL`, `mime text`, `sha text NOT NULL`
- **`file_hash text NULL`** — extra column not in any prior spec; unclear purpose (likely file-level hash vs normalized-content hash). Preserved.
- `created_at timestamptz DEFAULT now()`; no `updated_at` in production — rebuild ADDS it for touch trigger.
- UNIQUE (owner_id, path, sha) — production has it, preserved.
- RLS enabled; permissive public-role `owner_id='GLOBAL'` policies (non-standard; backend bypasses via service_role anyway).

### doc_chunks
- `id uuid PK`, `doc_id uuid NOT NULL FK → docs(id) ON DELETE CASCADE`, `owner_id text NOT NULL`
- `idx integer NOT NULL`, `content text NOT NULL`, `metadata jsonb`
- **`embedding vector(1536)`** — dimension confirmed via `format_type(atttypid, atttypmod)`. Matches OpenAI `text-embedding-3-small`.
- `sha text`, `created_at timestamptz`
- UNIQUE (doc_id, idx); no CHECK on `idx >= 0` in production — rebuild ADDS.
- **Duplicate indexes in production:** two ivfflat on embedding (one default, one `WITH (lists='50')`); two btree on owner_id. Rebuild consolidates to one of each (`lists=100`).

### rag_terms
- `id uuid PK`, `term text NOT NULL`, `meaning text`, `cfo_map text`, `nudge text`, `source text`, `created_at timestamptz`
- No tenant/owner scoping. Fully GLOBAL.
- **16 rows in production** (non-empty — live glossary data).
- Index: btree on `lower(term)` (non-unique). Rebuild UPGRADES to UNIQUE index on `lower(term)`.
- RLS disabled in production — rebuild ENABLES with `USING (true)` for authenticated.

### tenant_knowledge
- PK (owner_id, kind, key) — no surrogate id column. Preserved.
- **`owner_id uuid`** in production — **TYPE DRIFT**. `services/learning.js` passes `ctx.owner_id` (text digit-string) into an INSERT. Text → uuid cast would fail on every row.
- **Row count: 0.** Confirms the code path has never succeeded. Rebuild corrects to `owner_id text` transparently (no data migration needed).
- `first_seen`, `last_seen`, `seen_count integer DEFAULT 1`, `confidence real DEFAULT 0.6`.
- RLS disabled in production — rebuild ENABLES with standard owner-scoped policy.

### Extensions
- `pgcrypto 1.3` ✅ installed
- `vector 0.8.0` ✅ installed
- Rebuild preflight calls `CREATE EXTENSION IF NOT EXISTS vector` explicitly — guards cold-start targets.

---

## 2. Consumer code audit (short form)

- **services/tools/rag.js** — vector search via `ORDER BY c.embedding <=> $::vector LIMIT k` on `doc_chunks` JOINed to `docs` for title/path. Default `ownerId='GLOBAL'`. Connects via `DATABASE_URL` Pool → bypasses RLS.
- **services/rag_search.js** — keyword search via `to_tsvector('english', content) @@ plainto_tsquery(...)` computed on the fly. No materialized tsvector column. Dynamic column introspection for future owner_id/tenant_id scoping.
- **services/ragTerms.js** — `SELECT term, meaning, cfo_map, nudge FROM rag_terms WHERE lower(term) = $1 LIMIT 1`. Pure exact-match case-insensitive lookup.
- **services/learning.js** — UPSERT into `tenant_knowledge` from validated CIL events. Kinds: `job_name` (Clock), `vendor` (Expense), `material` + `customer` (Quote).

---

## 3. Migrations authored

| File | Tables | Notes |
|------|--------|-------|
| `2026_04_22_amendment_rag_docs.sql` | docs, doc_chunks | `CREATE EXTENSION IF NOT EXISTS vector` in preflight; ivfflat `lists=100`; `vector(1536)`. |
| `2026_04_22_amendment_rag_terms.sql` | rag_terms | GLOBAL; UNIQUE on `lower(term)`; CHECK not-blank. |
| `2026_04_22_amendment_tenant_knowledge.sql` | tenant_knowledge | **owner_id drift-corrected uuid→text**; standard owner-scoped RLS. |

Matching rollback files in `migrations/rollbacks/`. Extensions are **not** dropped by rollback (additive and safe to leave installed).

---

## 4. Design decisions resolved (see FOUNDATION_P1_SCHEMA_DESIGN.md §3.14)

- **F**: GLOBAL + per-owner hybrid on docs/doc_chunks (owner_id text supports `'GLOBAL'` + digit-strings; no tenant_id column).
- **G**: embedding dimension pinned at `vector(1536)` — matches OpenAI text-embedding-3-small.
- **H**: rag_terms fully GLOBAL — no scoping, case-insensitive UNIQUE, service_role writes only.
- **I**: tenant_knowledge.owner_id drift corrected uuid→text. Production 0 rows, transparent.
- **J**: ivfflat index consolidation — one index per column instead of production's duplicates.

---

## 5. Flagged items for founder review

1. **tenant_knowledge.owner_id type drift** — rebuild corrects to text. Production row count 0 confirms the code path has never succeeded. Listed in `PHASE_5_PRE_CUTOVER_CHECKLIST.md` §4 and `REBUILD_MIGRATION_MANIFEST.md` §5 Forward Flag 19.
2. **docs.file_hash** — preserved from production. Purpose distinct from `sha` is unclear. Keeping both avoids data loss; founder confirmation on whether `file_hash` is safe to drop in a later cleanup is not blocking for cutover.
3. **ivfflat lists=100** — round-number default. After seeding the rebuilt DB, a `REINDEX INDEX doc_chunks_embedding_ivfflat_idx` once chunk count stabilizes is prudent per pgvector guidance. Noted as Forward Flag 20.
4. **No materialized tsvector on doc_chunks.content** — matches production (on-the-fly `to_tsvector('english', content)`). Will add if keyword-search volume warrants; not yet justified.
5. **No CHECK on tenant_knowledge.kind** — known kinds (`job_name`, `vendor`, `material`, `customer`) are documented in the migration's COMMENT. Leaving the column free-text allows new kinds without migration churn.
6. **Embedding dimension lock** — if the product swaps to `text-embedding-3-large` (3072) or another provider, DB migration + regeneration required. Noted as Forward Flag 21.

---

## 6. Manifest updates applied

- Session history line added for P1A-3.
- Apply-order entries 17g/17h/17i added between 17f and 18.
- Touch-trigger note updated: 11 → 13 amendment tables need `chiefos_touch_updated_at` bindings in P3-4c (adds docs + rag_terms; doc_chunks and tenant_knowledge do not have `updated_at`).
- Forward Flags 19–21 added (drift correction, ivfflat reindex, embedding dimension lock).
- Rollback posture §6 lists all 9 amendment rollback files (P1A-1 + P1A-2 + P1A-3).

---

## 7. FOUNDATION_P1_SCHEMA_DESIGN.md updates

- Phase 4.5 amendment bullet for §3.14 changed from "deferred to Session P1A-3" → "delivered in Session P1A-3" with migration file references.
- New §3.14 section added with 4 design pages (3.14.1 docs, 3.14.2 doc_chunks, 3.14.3 rag_terms, 3.14.4 tenant_knowledge), Decisions F–J narrative, and consumer-side touch-point list.

---

## 8. Next session handoff

Phase 1 amendments are now complete across three sessions (P1A-1 + P1A-2 + P1A-3). 16 tables authored across 7 amendment migration files. All 9 rollback files in place.

Next sessions (order not prescribed here):
- **P3-4c**: touch-trigger bindings for 13 amendment tables + hard column-restriction triggers for 8 append-only tables (including `catalog_price_history`).
- **R1-R9 remediation** (pre-cutover): resolve any CHECK-value violations surfaced by the `PHASE_5_PRE_CUTOVER_CHECKLIST.md` §1 queries.
- **Phase 5 cutover**: rebuild apply sequence per manifest §3 against emptied `public` schema.

Pre-cutover checklist entries added:
- §4 data-migration entry for `tenant_knowledge.owner_id` drift (noted as zero-row, transparent).
- §1.3 note confirming no new CHECK-value spot-checks needed from P1A-3.
