-- Migration: 2026_04_22_remediation_drop_users_dashboard_token.sql
--
-- R1 REMEDIATION — drop orphaned users.dashboard_token column.
--
-- Rationale: Q6 sub-audit (PHASE_4_5B_SUB_AUDIT_REPORT.md) confirmed the only
-- consumers of users.dashboard_token were routes/dashboard.js and routes/api.dashboard.js,
-- both deleted in R1. The legacy HTML dashboard surface is entirely orphaned from the
-- Next.js portal. No replacement auth path needed — option (c) from Phase 4 Open Question #8.
--
-- Depends on: R1 deletion of routes/dashboard.js and routes/api.dashboard.js (source consumers).
-- Apply-order: after all Phase 3 + Amendment + P3-4c migrations (step 20+ in manifest).

BEGIN;

ALTER TABLE public.users
  DROP COLUMN IF EXISTS dashboard_token;

COMMIT;
