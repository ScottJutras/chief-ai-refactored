-- Rollback for: 2026_04_28_amendment_p1a12_sequence_usage_grants.sql
--
-- After rollback, service_role INSERTs against sequence-backed tables
-- (time_entries_v2, jobs, employees, timeclock_prompts, etc.) will 42501.
-- Only roll back if the comprehensive grant proves problematic — no
-- expected scenario.

BEGIN;

REVOKE USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public FROM service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE USAGE, SELECT, UPDATE ON SEQUENCES FROM service_role;

COMMIT;
