-- Migration: 2026_04_22_amendment_rag_docs.sql
--
-- PHASE 1 AMENDMENT (Session P1A-3, Part 1 of 3) for Foundation Rebuild V2.
--
-- Gap source: Phase 4.5 classification §3.14 RAG Knowledge — founder confirmed
-- preserve. RAG (Retrieval-Augmented Generation) spine for Chief: the
-- brain reads from here every conversation.
--
-- Tables in this file (2): docs, doc_chunks — the document + chunked-with-
-- embedding pair that backs vector search in services/tools/rag.js and
-- keyword search in services/rag_search.js.
--
-- Production introspection findings (xnmsjdummnnistzcxrtj, 2026-04-21):
--   - docs: owner_id text NOT NULL (supports 'GLOBAL' sentinel + digit-strings)
--     NO tenant_id. Extra `file_hash text NULL` column (distinct from `sha`) —
--     preserved as-is.
--   - doc_chunks: embedding is typed `vector(1536)` — matches
--     OpenAI text-embedding-3-small output. FK doc_id → docs(id) ON DELETE
--     CASCADE. UNIQUE (doc_id, idx).
--   - Production has TWO ivfflat indexes on embedding (duplicate) and TWO
--     btree indexes on owner_id (duplicate). Rebuild consolidates to one of
--     each.
--   - Production RLS: permissive public-role GLOBAL-only policies on docs and
--     doc_chunks. Rebuild replaces with proper role scoping: authenticated can
--     SELECT GLOBAL or own-tenant rows; writes are service_role only (backend
--     ingests docs via DATABASE_URL pool, bypassing RLS anyway — service_role
--     grant is explicit documentation of that contract).
--
-- Consumer patterns (services/tools/rag.js + services/rag_search.js):
--   - Vector search: `ORDER BY c.embedding <=> $2::vector LIMIT k` on
--     doc_chunks, JOINed to docs for title/path. Filters by owner_id, default
--     'GLOBAL'. Cosine distance operator → ivfflat vector_cosine_ops index.
--   - Keyword search: `to_tsvector('english', content) @@ plainto_tsquery(...)`
--     computed on the fly. No materialized tsvector column in production or
--     rebuild. (If volume grows we'd add one — not yet justified.)
--
-- Extension requirements: pgvector (already installed in production as
-- version 0.8.0) and pgcrypto (for gen_random_uuid()).
--
-- Dependencies:
--   - public.chiefos_tenants (Session P3-1) — for owner_id → tenant_id resolution
--   - public.chiefos_portal_users (Session P3-1) — for RLS
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname='vector') THEN
    RAISE EXCEPTION 'Requires pgvector extension (CREATE EXTENSION vector)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_tenants') THEN
    RAISE EXCEPTION 'Requires public.chiefos_tenants';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_portal_users') THEN
    RAISE EXCEPTION 'Requires public.chiefos_portal_users';
  END IF;
END
$preflight$;

-- ============================================================================
-- 1. docs — the document root
--
-- owner_id is TEXT to support both the 'GLOBAL' sentinel (system-wide docs
-- readable by all tenants) and digit-string tenant owner ids (per-tenant SOPs).
-- No tenant_id column — RAG uses the owner_id ingestion boundary directly.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.docs (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     text         NOT NULL,
  source       text         NOT NULL,
  title        text,
  path         text         NOT NULL,
  mime         text,
  sha          text         NOT NULL,
  file_hash    text,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT docs_owner_path_sha_unique UNIQUE (owner_id, path, sha)
);

CREATE INDEX IF NOT EXISTS docs_owner_idx
  ON public.docs (owner_id);
CREATE INDEX IF NOT EXISTS docs_owner_created_idx
  ON public.docs (owner_id, created_at DESC);

ALTER TABLE public.docs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- authenticated SELECT: GLOBAL docs OR own-tenant docs (owner_id → tenant)
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='docs'
                   AND policyname='docs_authenticated_select') THEN
    CREATE POLICY docs_authenticated_select
      ON public.docs FOR SELECT
      TO authenticated
      USING (
        owner_id = 'GLOBAL'
        OR owner_id IN (
          SELECT t.owner_id FROM public.chiefos_tenants t
           WHERE t.id IN (SELECT tenant_id FROM public.chiefos_portal_users
                          WHERE user_id = auth.uid())
        )
      );
  END IF;

  -- Writes are service_role only (backend ingestion via DATABASE_URL).
  -- No authenticated INSERT/UPDATE/DELETE policies — those routes go through
  -- service_role which bypasses RLS.
END $$;

GRANT SELECT ON public.docs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.docs TO service_role;

COMMENT ON TABLE public.docs IS
  'RAG document root. owner_id text supports ''GLOBAL'' (system SOPs) and per-tenant digit-string owner ids. UNIQUE (owner_id, path, sha) enforces dedupe on content+location. Writes are service_role only via backend ingestion.';
COMMENT ON COLUMN public.docs.source IS
  'Free-text source label (e.g., ''google_drive'', ''upload'', ''manual''). Not CHECK-constrained — production has none, rebuild preserves flexibility.';
COMMENT ON COLUMN public.docs.file_hash IS
  'Optional second hash distinct from sha. Purpose: file-level hash vs normalized-content hash. Preserved from production; keep both columns to avoid data loss.';

-- ============================================================================
-- 2. doc_chunks — the vectorized chunks
--
-- embedding dimension is vector(1536) — matches OpenAI text-embedding-3-small
-- used in services/tools/rag.js.
--
-- Index strategy:
--   - Single ivfflat index on embedding with vector_cosine_ops + lists=100
--     (production had two — duplicate consolidation).
--   - UNIQUE (doc_id, idx) enforces chunk ordering per doc.
--   - btree(owner_id) for cheap non-vector filtering.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.doc_chunks (
  id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id       uuid          NOT NULL
    REFERENCES public.docs(id) ON DELETE CASCADE,
  owner_id     text          NOT NULL,
  idx          integer       NOT NULL,
  content      text          NOT NULL,
  metadata     jsonb,
  embedding    vector(1536),
  sha          text,
  created_at   timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT doc_chunks_idx_nonneg CHECK (idx >= 0),
  CONSTRAINT doc_chunks_doc_idx_unique UNIQUE (doc_id, idx)
);

CREATE INDEX IF NOT EXISTS doc_chunks_doc_id_idx
  ON public.doc_chunks (doc_id);
CREATE INDEX IF NOT EXISTS doc_chunks_owner_idx
  ON public.doc_chunks (owner_id);
CREATE INDEX IF NOT EXISTS doc_chunks_embedding_ivfflat_idx
  ON public.doc_chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

ALTER TABLE public.doc_chunks ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='doc_chunks'
                   AND policyname='doc_chunks_authenticated_select') THEN
    CREATE POLICY doc_chunks_authenticated_select
      ON public.doc_chunks FOR SELECT
      TO authenticated
      USING (
        owner_id = 'GLOBAL'
        OR owner_id IN (
          SELECT t.owner_id FROM public.chiefos_tenants t
           WHERE t.id IN (SELECT tenant_id FROM public.chiefos_portal_users
                          WHERE user_id = auth.uid())
        )
      );
  END IF;
END $$;

GRANT SELECT ON public.doc_chunks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.doc_chunks TO service_role;

COMMENT ON TABLE public.doc_chunks IS
  'Chunked document content with pgvector embeddings. Vector search via <=> cosine distance in services/tools/rag.js. owner_id duplicated from parent docs row for cheap filtering without JOIN. Writes are service_role only.';
COMMENT ON COLUMN public.doc_chunks.embedding IS
  'vector(1536) — matches OpenAI text-embedding-3-small output. ivfflat index with vector_cosine_ops + lists=100.';
COMMENT ON COLUMN public.doc_chunks.idx IS
  'Zero-based chunk position within parent doc. UNIQUE (doc_id, idx) enforces ordering.';

COMMIT;
