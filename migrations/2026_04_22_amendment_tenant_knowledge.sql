-- Migration: 2026_04_22_amendment_tenant_knowledge.sql
--
-- PHASE 1 AMENDMENT (Session P1A-3, Part 3 of 3) for Foundation Rebuild V2.
--
-- Gap source: Phase 4.5 classification §3.14 RAG Knowledge — founder confirmed
-- preserve. Accumulated durable facts (job names, vendors, materials, customer
-- names) extracted from validated CIL events by services/learning.js.
--
-- Single table: tenant_knowledge — per-owner knowledge store.
--
-- ============================================================================
-- DRIFT CORRECTION (flagged for founder review):
--
-- Production schema has `owner_id uuid NOT NULL`. This is incompatible with
-- the dual-boundary model (owner_id is always a TEXT digit-string) and with
-- the actual consumer services/learning.js which passes `ctx.owner_id` (a
-- text digit-string) into an INSERT:
--
--   INSERT INTO tenant_knowledge(owner_id,kind,key) VALUES ($1,$2,$3)
--     ON CONFLICT (owner_id,kind,key) DO UPDATE SET ...
--
-- A text-digit-string owner_id cannot be cast to uuid, so this code path
-- cannot have been exercised successfully in production — confirmed by
-- introspection: production row count = 0.
--
-- Rebuild CORRECTS owner_id → text. No production data to preserve; the
-- correction is transparent at cutover. Documented in PHASE_5_PRE_CUTOVER_
-- CHECKLIST.md §4 "Data migrations that aren't schema migrations" (new entry
-- added by this session's report).
-- ============================================================================
--
-- Production introspection findings (2026-04-21):
--   - PK = (owner_id, kind, key) — no surrogate id column. Preserved.
--   - Columns: first_seen, last_seen (timestamptz NOT NULL DEFAULT now()),
--     seen_count integer DEFAULT 1, confidence real DEFAULT 0.6.
--   - No UNIQUE beyond the PK.
--   - No CHECK constraints.
--   - RLS disabled in production. Rebuild ENABLES RLS.
--   - 0 rows.
--
-- Known `kind` values used by services/learning.js: 'job_name', 'vendor',
-- 'material', 'customer'. Rebuild does NOT add CHECK constraint — new kinds
-- are expected as the product expands, and the cost of CHECK churn exceeds
-- the value of enum safety here.
--
-- Dependencies:
--   - public.chiefos_tenants (Session P3-1) — owner_id → tenant_id resolution
--   - public.chiefos_portal_users (Session P3-1) — RLS
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
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

CREATE TABLE IF NOT EXISTS public.tenant_knowledge (
  owner_id      text         NOT NULL,
  kind          text         NOT NULL,
  key           text         NOT NULL,
  first_seen    timestamptz  NOT NULL DEFAULT now(),
  last_seen     timestamptz  NOT NULL DEFAULT now(),
  seen_count    integer      NOT NULL DEFAULT 1,
  confidence    real         NOT NULL DEFAULT 0.6,

  CONSTRAINT tenant_knowledge_pkey PRIMARY KEY (owner_id, kind, key),
  CONSTRAINT tenant_knowledge_seen_count_positive
    CHECK (seen_count >= 1),
  CONSTRAINT tenant_knowledge_confidence_range
    CHECK (confidence >= 0.0 AND confidence <= 1.0),
  CONSTRAINT tenant_knowledge_kind_not_blank
    CHECK (length(btrim(kind)) > 0),
  CONSTRAINT tenant_knowledge_key_not_blank
    CHECK (length(btrim(key)) > 0)
);

CREATE INDEX IF NOT EXISTS tenant_knowledge_owner_lastseen_idx
  ON public.tenant_knowledge (owner_id, last_seen DESC);
CREATE INDEX IF NOT EXISTS tenant_knowledge_owner_kind_idx
  ON public.tenant_knowledge (owner_id, kind);

ALTER TABLE public.tenant_knowledge ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Portal SELECT: authenticated users can see their own tenant's knowledge
  -- (owner_id → tenant_id resolution via chiefos_tenants).
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tenant_knowledge'
                   AND policyname='tenant_knowledge_authenticated_select') THEN
    CREATE POLICY tenant_knowledge_authenticated_select
      ON public.tenant_knowledge FOR SELECT
      TO authenticated
      USING (
        owner_id IN (
          SELECT t.owner_id FROM public.chiefos_tenants t
           WHERE t.id IN (SELECT tenant_id FROM public.chiefos_portal_users
                          WHERE user_id = auth.uid())
        )
      );
  END IF;
  -- Writes are service_role only (services/learning.js runs on the backend
  -- via DATABASE_URL pool, bypassing RLS).
END $$;

GRANT SELECT ON public.tenant_knowledge TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_knowledge TO service_role;

COMMENT ON TABLE public.tenant_knowledge IS
  'Accumulated durable facts per tenant (owner_id). Populated by services/learning.js from validated CIL events — see switch cases for Onboarding/Clock/Expense/Quote. Known kinds: job_name, vendor, material, customer. owner_id is TEXT (not uuid — drift-corrected at rebuild). PK (owner_id, kind, key) doubles as dedupe key for UPSERT.';
COMMENT ON COLUMN public.tenant_knowledge.kind IS
  'Free-text category. No CHECK constraint — new kinds expected as product expands. Known values: job_name, vendor, material, customer (see services/learning.js).';
COMMENT ON COLUMN public.tenant_knowledge.key IS
  'Canonicalized value (lowercased, trimmed by learning.js before UPSERT). One row per (owner_id, kind, key).';
COMMENT ON COLUMN public.tenant_knowledge.confidence IS
  'Float 0.0-1.0. Default 0.6 (new entries). Future: raise with seen_count growth, decay over time.';

COMMIT;
