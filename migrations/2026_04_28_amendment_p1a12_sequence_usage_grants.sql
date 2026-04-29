-- Migration: 2026_04_28_amendment_p1a12_sequence_usage_grants.sql
--
-- PHASE 1 AMENDMENT (Session P1A-12) for Foundation Rebuild V2.
--
-- Gap source: 2026-04-28 /api/log preview testing surfaced 42501
-- "permission denied for sequence time_entries_v2_id_seq" on hours INSERT.
-- service_role has INSERT on the table but NO grants on the underlying
-- sequence. PostgreSQL requires sequence-level USAGE for nextval() during
-- INSERT-with-DEFAULT, and UPDATE for sequence advance, in addition to
-- table-level INSERT.
--
-- Bug class: missing GRANT to service_role on sequences backing serial /
-- bigserial columns. Same class as P1A-10 (missing UPDATE on
-- chiefos_legal_acceptances) but at the sequence level. Caught at runtime
-- only when a service_role INSERT actually exercises the sequence.
--
-- ============================================================================
-- INVENTORY OF AFFECTED SEQUENCES (verified 2026-04-28 via
-- information_schema.role_usage_grants — all 7 had NO service_role GRANT):
--
--   - chiefos_events_global_seq         (used by chiefos_quote_events,
--                                        chiefos_quote_signatures global ordering)
--   - employees_id_seq                  (employees.id PK)
--   - jobs_id_seq                       (jobs.id PK — heavily used)
--   - time_entries_v2_id_seq            (time_entries_v2.id PK — surfaced bug)
--   - timeclock_prompts_id_seq          (timeclock_prompts.id PK)
--   - timeclock_repair_prompts_id_seq   (timeclock_repair_prompts.id PK)
--   - timesheet_locks_id_seq            (timesheet_locks.id PK)
--
-- Each of these would 42501 on service_role INSERT until this migration
-- applies. The hours bug surfaced first because /api/log was the first
-- service-role write path to exercise time_entries_v2 INSERT post-cutover
-- (WhatsApp ingestion uses pg directly with the postgres role, not
-- service_role, so the sequence gap was invisible there).
--
-- ============================================================================
-- WHY GRANT ALL (not just time_entries_v2_id_seq):
-- The targeted-fix-only approach requires re-running this migration for
-- every new sequence-bearing table that gets exercised. The
-- comprehensive approach (`GRANT USAGE ... ON ALL SEQUENCES IN SCHEMA
-- public TO service_role`) matches every existing sequence and is
-- future-proof for any new sequence created in the same schema. Aligns
-- with the comprehensive RLS+GRANT+CHECK+UNIQUE audit tracker
-- (P1B-comprehensive-rls-grant-check-unique-audit). One migration, one
-- behavior change, no recurrence.
--
-- WHY USAGE + SELECT + UPDATE:
-- - USAGE: required for nextval() (advances + reads).
-- - UPDATE: required for setval() and conceptually for sequence advance.
-- - SELECT: required for currval() / lastval() if any code path reads the
--   current value (e.g., for ID-back-reference patterns).
-- All three together cover every sequence interaction service_role might
-- do via /api/* routes.
--
-- ============================================================================
-- ALSO ALTER DEFAULT PRIVILEGES — so future sequences created in this
-- schema (e.g., from new amendment migrations) auto-grant to service_role
-- without requiring another P1A-N. Belt-and-suspenders for the bug class.
--
-- Apply-order: out of band. Phase 5 cutover is COMPLETE; this is a
-- post-cutover P1A-N amendment applied directly to production via
-- mcp__claude_ai_Supabase__apply_migration.
--
-- Rollback: REVOKE the grants. After rollback, service_role INSERTs
-- against any sequence-backed table will 42501 again.
-- ============================================================================

BEGIN;

-- 1. Comprehensive grant on every existing public-schema sequence.
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- 2. Default privileges for sequences created by the postgres role going
--    forward. Matches the apply-flow for amendment migrations (which run
--    as postgres). Future-proofs the bug class for new sequences.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO service_role;

COMMIT;
