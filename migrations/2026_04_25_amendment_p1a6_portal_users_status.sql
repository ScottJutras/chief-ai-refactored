-- Migration: 2026_04_25_amendment_p1a6_portal_users_status.sql
--
-- PHASE 1 AMENDMENT (Session P1A-6) for Foundation Rebuild V2.
--
-- Gap source: F1 STOP at V2 (see SESSION_F1_STOP_REPORT.md). The crewAdmin
-- rewrite directive requires a soft-delete column on the rebuild crew identity
-- model. Neither public.users nor chiefos_portal_users had one; signup_status'
-- CHECK enum doesn't admit a deactivation value. This amendment adds the
-- minimal soft-delete shape to chiefos_portal_users so F1 can ship without
-- losing financial history (which lives on public.users — left untouched per
-- CLAUDE.md "never lose financial history").
--
-- Why chiefos_portal_users (not public.users):
--   - Crew portal access (the thing being revoked) is gated by portal_users
--     membership, not by public.users row existence
--   - chiefos_role_audit.target_portal_user_id already FKs to portal_users —
--     keeping the deactivation column on the same row aligns audit trail with
--     access state
--   - public.users carries financial attribution (transactions.created_by,
--     time_entries_v2.user_id, etc.) that must survive deactivation intact
--   - WhatsApp-only employees (no portal_users row) are out of scope for
--     portal-side deactivation; their access is gated separately by plan_key
--
-- Default: 'active' — preserves pre-rebuild semantics (existing rows fill
--   transparently). F1's deactivate route explicitly transitions to
--   'deactivated' via UPDATE.
--
-- Partial index rationale: hot path is "list active members in tenant X by
--   role"; partial index on WHERE status='active' keeps that path efficient
--   without bloating the index with rarely-queried deactivated rows.
--
-- No data migration needed: column add with NOT NULL DEFAULT fills existing
-- rows with 'active' automatically.
--
-- Apply-order: position 17m in REBUILD_MIGRATION_MANIFEST.md §3 — after P1A-5
-- (17l), before step 18 (rebuild_functions). Target table exists by step 1
-- (rebuild_identity_tenancy) so any position 1+ works; 17m groups with Phase
-- 1 amendments.
--
-- Idempotency: every mutation guarded with IF NOT EXISTS (matches P1A-5 idiom).
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='chiefos_portal_users') THEN
    RAISE EXCEPTION 'Requires public.chiefos_portal_users (apply rebuild_identity_tenancy first)';
  END IF;
END
$preflight$;

-- ============================================================================
-- 1. Add column with default
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='chiefos_portal_users'
      AND column_name='status'
  ) THEN
    ALTER TABLE public.chiefos_portal_users
      ADD COLUMN status text NOT NULL DEFAULT 'active';
  END IF;
END $$;

-- ============================================================================
-- 2. CHECK constraint
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chiefos_portal_users_status_check'
      AND conrelid = 'public.chiefos_portal_users'::regclass
  ) THEN
    ALTER TABLE public.chiefos_portal_users
      ADD CONSTRAINT chiefos_portal_users_status_check
      CHECK (status IN ('active','deactivated'));
  END IF;
END $$;

-- ============================================================================
-- 3. Partial index for active-membership queries
-- ============================================================================

CREATE INDEX IF NOT EXISTS chiefos_portal_users_active_idx
  ON public.chiefos_portal_users (tenant_id, role)
  WHERE status = 'active';

COMMENT ON COLUMN public.chiefos_portal_users.status IS
  'Soft-delete state for portal access. Deactivated rows preserve auth + role history but block new portal/WhatsApp activity. Default ''active''. Set by F1 crewAdmin deactivate route.';

COMMIT;
