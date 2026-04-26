-- Migration: 2026_04_22_amendment_rag_terms.sql
--
-- PHASE 1 AMENDMENT (Session P1A-3, Part 2 of 3) for Foundation Rebuild V2.
--
-- Gap source: Phase 4.5 classification §3.14 RAG Knowledge — founder confirmed
-- preserve. Glossary of ChiefOS-specific terms consulted by the brain layer
-- during conversations.
--
-- Single table: rag_terms — fully GLOBAL (no tenant_id, no owner_id). Shared
-- dictionary across all tenants. Pattern parallels suppliers (also GLOBAL) but
-- simpler: no per-supplier dimension, just a single shared glossary.
--
-- Production introspection findings (2026-04-21):
--   - 16 rows in production
--   - No tenant/owner scoping columns
--   - Existing btree index on lower(term) — case-insensitive lookup
--   - RLS disabled in production
--   - No UNIQUE constraint in production (rebuild ADDS UNIQUE on lower(term)
--     to enforce one-entry-per-term)
--
-- Consumer (services/ragTerms.js):
--   SELECT term, meaning, cfo_map, nudge FROM public.rag_terms
--    WHERE lower(term) = $1 LIMIT 1
--
--   Pure case-insensitive exact-match lookup. No fuzzy/similarity search yet.
--
-- RLS posture: GLOBAL-read pattern. All authenticated users can SELECT. Writes
-- are service_role only (curated glossary — no user-contributed terms).
--
-- Dependencies: none beyond pgcrypto (for gen_random_uuid).
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.rag_terms (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  term         text         NOT NULL,
  meaning      text,
  cfo_map      text,
  nudge        text,
  source       text,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT rag_terms_term_not_blank CHECK (length(btrim(term)) > 0)
);

-- Case-insensitive UNIQUE on term (rebuild addition; production had a
-- non-unique btree on lower(term) only).
CREATE UNIQUE INDEX IF NOT EXISTS rag_terms_lower_term_unique
  ON public.rag_terms (lower(term));

ALTER TABLE public.rag_terms ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- All authenticated users can read the global glossary
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rag_terms'
                   AND policyname='rag_terms_authenticated_select') THEN
    CREATE POLICY rag_terms_authenticated_select
      ON public.rag_terms FOR SELECT
      TO authenticated
      USING (true);
  END IF;
  -- No authenticated write policies — curated by service_role only
END $$;

GRANT SELECT ON public.rag_terms TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.rag_terms TO service_role;

COMMENT ON TABLE public.rag_terms IS
  'GLOBAL glossary of ChiefOS-specific terms (SOP vocabulary, owner aliases, contractor jargon). Shared across all tenants — no scoping columns. Consumed by services/ragTerms.js via case-insensitive exact-match lookup. Writes are service_role only (curated dictionary).';
COMMENT ON COLUMN public.rag_terms.cfo_map IS
  'Brain-layer mapping hint: how this term maps to a canonical CFO concept. E.g., term=''cash on hand'' → cfo_map=''liquidity''.';
COMMENT ON COLUMN public.rag_terms.nudge IS
  'Optional coaching-style hint to surface to the operator when this term appears. Used by insights_v0 / answerChief layers.';

COMMIT;
