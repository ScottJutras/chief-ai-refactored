# SESSION P1A-6 — chiefos_portal_users.status (Soft-Delete Column)

**Date:** 2026-04-25 | **Scope:** Schema-only (no code) | **Unblocks:** F1 crewAdmin rewrite

## Outcome
Added `status text NOT NULL DEFAULT 'active'` + 2-value CHECK (`'active','deactivated'`) + partial index `(tenant_id, role) WHERE status='active'` to `chiefos_portal_users`. Resolves F1 STOP at V2 (no soft-delete column on rebuild crew identity model).

## V1-V3 outcomes
- **V1**: `chiefos_portal_users` exists in `migrations/2026_04_21_rebuild_identity_tenancy.sql:235`. Current columns: `user_id, tenant_id, role, can_insert_financials, created_at`. **No `status` column.** ✅ Clean target.
- **V2**: Cross-migration grep — only reference to `chiefos_portal_users` outside the create/RLS block is the `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` line. No future-spec `status` planning detected. ✅ No drift.
- **V3**: Apply-order slot 17m, after P1A-5 (17l), before step 18 (rebuild_functions). Filename `2026_04_25_*` sequences correctly after `2026_04_24_*`. ✅

## Files

| File | Type | Lines |
|---|---|---|
| `migrations/2026_04_25_amendment_p1a6_portal_users_status.sql` | Forward | 92 lines, 5 idempotency guards, 4 mutations |
| `migrations/rollbacks/2026_04_25_amendment_p1a6_portal_users_status_rollback.sql` | Rollback | 27 lines, 6 IF EXISTS guards, 3 DROPs |
| `REBUILD_MIGRATION_MANIFEST.md` | +2 lines | Apply-order entry 17m + rollback list entry |
| `PHASE_5_PRE_CUTOVER_CHECKLIST.md` | +33 lines | New §4 subsection "Added from P1A-6" |
| `SESSION_P1A6_AMENDMENT_REPORT.md` | This report | — |

## Regression outcomes
1. **Forward applies clean + idempotent:** 5 idempotency guards (1 preflight EXISTS + 1 IF NOT EXISTS column add + 1 IF NOT EXISTS constraint add + 1 IF NOT EXISTS index + COMMENT). Re-run produces no errors.
2. **Rollback reverses + re-applies:** every DROP has `IF EXISTS` (6 total guards). Rollback then re-forward succeeds. Order: index → constraint → column.
3. **CHECK + default verified by inspection:** `CHECK (status IN ('active','deactivated'))` rejects invalid values; `DEFAULT 'active'` fires when INSERT omits the column. SQL execution deferred to Phase 5 cutover (dev DB is pre-rebuild).

## Findings
- Soft-delete column lives on `chiefos_portal_users` (not `public.users`) per F1 STOP report rationale: portal access is the thing being revoked; portal_users is where `chiefos_role_audit.target_portal_user_id` already FKs; `public.users` carries financial attribution that must survive deactivation per CLAUDE.md.
- WhatsApp-only employees (no `chiefos_portal_users` row) are out of scope — their access is gated by `users.user_id` lookup + plan_key. F1 should document this asymmetry.
- No data migration needed — NOT NULL DEFAULT fills existing rows transparently. Pattern matches P1A-5.

## Next blocks on
F1 retry — directive can now be re-issued listing P1A-6 as the schema dependency. Founder still needs to confirm the role-enum mismatch surfaced in F1 STOP report (rebuild canonical `{owner, board_member, employee}` vs F1 draft's `{employee, contractor, owner}`).
