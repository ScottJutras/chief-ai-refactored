-- ============================================================================
-- Migration 5 — chiefos_tenant_counters: generalize to per-tenant per-kind
--
-- Scope: extend chiefos_tenant_counters from single-purpose activity-log
-- storage to generic (tenant_id, counter_kind) shape for all new-idiom
-- document counters (quote, invoice, change_order, receipt, etc.).
--
-- See docs/QUOTES_SPINE_DECISIONS.md §17.13 (sequential-ID strategy),
-- §18 (this migration's design), §18.1-§18.4 (discovery decisions locked
-- 2026-04-20).
--
-- Applied against an empty table (0 rows confirmed at discovery); DEFAULT
-- 'activity_log' on ADD COLUMN is belt-and-suspenders defense against a
-- row appearing in the race window between discovery and apply. DROP
-- DEFAULT immediately after is the principle-enforcing step per §18.1.
-- ============================================================================

BEGIN;

-- ── Preflight (re-verify at apply time) ─────────────────────────────────────
DO $preflight$
DECLARE
  has_old_col boolean;
  has_new_col boolean;
  has_kind_col boolean;
  current_pk text;
  row_count int;
BEGIN
  SELECT EXISTS(SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='chiefos_tenant_counters'
                  AND column_name='next_activity_log_no')
  INTO has_old_col;
  SELECT EXISTS(SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='chiefos_tenant_counters'
                  AND column_name='next_no')
  INTO has_new_col;
  SELECT EXISTS(SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='chiefos_tenant_counters'
                  AND column_name='counter_kind')
  INTO has_kind_col;

  IF NOT has_old_col THEN
    RAISE EXCEPTION 'Preflight failed: expected column next_activity_log_no not found (migration may already be applied)';
  END IF;
  IF has_new_col THEN
    RAISE EXCEPTION 'Preflight failed: column next_no already exists (migration may already be applied)';
  END IF;
  IF has_kind_col THEN
    RAISE EXCEPTION 'Preflight failed: column counter_kind already exists (migration may already be applied)';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO current_pk
  FROM pg_constraint
  WHERE conrelid = 'public.chiefos_tenant_counters'::regclass AND contype = 'p';

  IF current_pk IS NULL OR current_pk <> 'PRIMARY KEY (tenant_id)' THEN
    RAISE EXCEPTION 'Preflight failed: unexpected current PK shape: %', current_pk;
  END IF;

  SELECT COUNT(*) INTO row_count FROM public.chiefos_tenant_counters;
  IF row_count > 0 THEN
    RAISE NOTICE 'Preflight: chiefos_tenant_counters has % row(s) at apply time (0 at discovery); DEFAULT will backfill them.', row_count;
  ELSE
    RAISE NOTICE 'Preflight: chiefos_tenant_counters empty as expected from discovery.';
  END IF;
END
$preflight$;

-- ── Step 1 (§18.1): ADD COLUMN counter_kind + DROP DEFAULT, atomically ──────
-- DEFAULT 'activity_log' is a migration-step convenience only. It backfills
-- any rows that snuck in between discovery and apply (race defense), and
-- permits the NOT NULL constraint to succeed unconditionally. DROP DEFAULT
-- immediately after is the load-bearing step: future INSERTs without an
-- explicit counter_kind will fail loud per §18.1.
ALTER TABLE public.chiefos_tenant_counters
  ADD COLUMN counter_kind text NOT NULL DEFAULT 'activity_log',
  ALTER COLUMN counter_kind DROP DEFAULT;

-- ── Step 2: rename column from domain-specific to generic ────────────────────
-- Step order dependency: RENAME can happen before or after Step 1, but Step 3
-- (composite PK) must come after Step 1 because it references counter_kind.
ALTER TABLE public.chiefos_tenant_counters
  RENAME COLUMN next_activity_log_no TO next_no;

-- ── Step 3 (§18.3): transition PK (tenant_id) → (tenant_id, counter_kind) ───
-- Atomic within one ALTER TABLE statement. Backing index auto-managed.
-- Composite index serves legacy WHERE tenant_id = $1 queries via btree
-- leading-column prefix — no performance regression.
ALTER TABLE public.chiefos_tenant_counters
  DROP CONSTRAINT chiefos_tenant_counters_pkey,
  ADD CONSTRAINT chiefos_tenant_counters_pkey PRIMARY KEY (tenant_id, counter_kind);

-- ── Step 4 (§18.4): format-only CHECK on counter_kind ───────────────────────
-- Whitelist CHECK rejected: would require coordinated three-place update
-- (CHECK migration + COUNTER_KINDS constant + handler code) for every new
-- counter_kind. COUNTER_KINDS in src/cil/counterKinds.js is the source of
-- truth for allowed values; DB layer enforces format only.
--
-- Catches: empty strings, whitespace, capitalization drift, Unicode drift,
-- digit-leading, SQL injection patterns, overly-long values.
-- Does not police: the product-concept set (that's COUNTER_KINDS' job).
ALTER TABLE public.chiefos_tenant_counters
  ADD CONSTRAINT chiefos_tenant_counters_counter_kind_format_chk
    CHECK (counter_kind ~ '^[a-z][a-z_]*$' AND char_length(counter_kind) BETWEEN 1 AND 64);

-- ── Documentation for future readers ────────────────────────────────────────
COMMENT ON COLUMN public.chiefos_tenant_counters.counter_kind IS
  'Per-tenant counter discriminator. One row per (tenant_id, counter_kind). See docs/QUOTES_SPINE_DECISIONS.md §17.13 and §18. Allowed values in src/cil/counterKinds.js.';
COMMENT ON COLUMN public.chiefos_tenant_counters.next_no IS
  'Next integer to allocate for this (tenant, kind) pair. Allocated via UPSERT in services/postgres.js::allocateNextDocCounter. Renamed from next_activity_log_no in Migration 5.';
COMMENT ON CONSTRAINT chiefos_tenant_counters_counter_kind_format_chk
  ON public.chiefos_tenant_counters IS
  'Format-only guard (lowercase snake_case, 1-64 chars). Product-concept whitelist lives in COUNTER_KINDS app-side per §18.4.';

COMMIT;
