# SESSION F1 — STOP at V2 (Schema Gap)

**Date:** 2026-04-25 | **Status:** Halted before rewrite per directive STOP rule | **Blocks:** F1

## Outcome
F1 directive's V2 step requires "a soft-delete column on `public.users`" to honor the architectural rule "deactivation sets a status column on public.users; does NOT delete the row." **No such column exists in the rebuild schema** for either `public.users` or `chiefos_portal_users`. Per directive: STOP and escalate. No code modified.

## V1-V4 outcomes (V5 not reached)

- **V1** ✅ — 10 routes inventoried (matches R3a estimate, no scope drift):
  | # | Route | Intent |
  |---|---|---|
  | 1 | GET /admin/members | List crew members |
  | 2 | GET /admin/assignments | List board↔employee assignments |
  | 3 | POST /admin/members | Add new crew member |
  | 4 | PATCH /admin/members/:actorId/role | Change member role |
  | 5 | PATCH /admin/members/:actorId | Update name/contact |
  | 6 | DELETE /admin/members/:actorId | Remove (soft-delete intent) |
  | 7 | GET /admin/members/export.csv | CSV export |
  | 8 | POST /admin/assign | Assign employee↔board |
  | 9 | POST /admin/invite | Send invite email/SMS |
  | 10 | GET /admin/invites | List pending invites |

- **V2** ❌ **STOP** — soft-delete column gap confirmed:
  - `public.users` columns scanned (migration `2026_04_21_rebuild_identity_tenancy.sql:137-173`): `user_id, owner_id, tenant_id, name, email, role, plan_key, tz, stripe_*, sub_status, current_period_*, cancel_at_period_end, terms_accepted_at, onboarding_completed, can_edit_time, signup_status, auto_assign_*, created_at, updated_at`. **No `status`, `active`, `is_active`, `deactivated_at`, or `deleted_at`.**
  - `signup_status` (line 157) has CHECK `IN ('pending_auth','pending_onboarding','complete')` — adding `'deactivated'` requires ALTER on the CHECK = schema work.
  - `chiefos_portal_users` (line 235-241) columns: `user_id, tenant_id, role, can_insert_financials, created_at`. **No soft-delete column either.**
  - Hard-deleting `chiefos_portal_users` is blocked by `chiefos_role_audit.target_portal_user_id ON DELETE RESTRICT` (any prior role-audit history pins the row).

- **V3** ✅ — `chiefos_role_audit` shape matches spec §3.11. Key fields:
  - `acted_by_portal_user_id uuid NOT NULL` (FK chiefos_portal_users)
  - `target_portal_user_id uuid NOT NULL` (FK chiefos_portal_users, ON DELETE RESTRICT)
  - `previous_role text`, `new_role text`, `action text NOT NULL`
  - CHECK action IN `('promote','demote','deactivate','reactivate')` ← requires the `deactivate` flip to write a corresponding state somewhere; without a status column on users/portal_users, the audit row records the intent but the actual access-revocation has no target field to mutate.
  - `correlation_id uuid NOT NULL`, `reason text`
  - **Important**: role audit operates on `chiefos_portal_users` (UUID auth user), not `public.users` (digit-string). Role enum is `('owner','board_member','employee')` per portal_users CHECK — different from F1 directive's `'employee', 'contractor', 'owner'` (no `'contractor'` value in rebuild; `'board_member'` instead). Directive-spec mismatch.

- **V4** ✅ — `services/phoneLinkOtp.js` exports `generatePhoneLinkOtp(authUserId, phoneDigits, options)` and `verifyPhoneLinkOtp(phoneDigits, candidateCode)`. Use `generatePhoneLinkOtp` for new-employee invites.

## Pre-rebuild semantics (for context)
The existing `DELETE /admin/members/:actorId` handler hard-deletes from `chiefos_tenant_actors` + `chiefos_tenant_actor_profiles` (DISCARDed actor cluster). Soft-delete is a NEW architectural rule introduced by F1's directive, not a behavior preserved from pre-rebuild.

## Recommended unblocker — P1A-6 amendment

Tight, additive amendment matching prior P1A-* idioms (~50 lines):

```sql
-- migrations/2026_04_25_amendment_p1a6_user_deactivation.sql
BEGIN;

DO $preflight$ ... ensure public.users + chiefos_portal_users exist ... END $preflight$;

-- Option A (recommended): add status to chiefos_portal_users
-- (portal_users is the right scope: deactivation revokes portal/WhatsApp access
-- but preserves the auth.users row + audit history)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='chiefos_portal_users'
      AND column_name='status') THEN
    ALTER TABLE public.chiefos_portal_users
      ADD COLUMN status text NOT NULL DEFAULT 'active';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname='chiefos_portal_users_status_chk'
      AND conrelid='public.chiefos_portal_users'::regclass) THEN
    ALTER TABLE public.chiefos_portal_users
      ADD CONSTRAINT chiefos_portal_users_status_chk
      CHECK (status IN ('active','deactivated'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS chiefos_portal_users_active_idx
  ON public.chiefos_portal_users (tenant_id)
  WHERE status = 'active';

COMMIT;
```

Default `'active'` fills existing rows transparently; no Phase 5 backfill needed (pattern matches P1A-5 submission_status).

**Why portal_users not public.users:**
1. Crew portal access (the thing being revoked) is gated by `chiefos_portal_users` membership, not by `public.users` row existence
2. WhatsApp-only employees with no portal account aren't represented in chiefos_portal_users; their access is gated by `users.user_id` lookup — but they're not "crew portal members" to begin with, so DELETE/deactivate semantics don't apply
3. `chiefos_role_audit.target_portal_user_id` already FKs to chiefos_portal_users — keeping the deactivation column on the same row aligns audit trail + access-state
4. `public.users` row stays intact for financial history (per CLAUDE.md: never lose financial history)

## Spec-vs-directive mismatch flagged
F1 directive lists allowed roles as `{employee, contractor, owner}`. Rebuild `chiefos_portal_users.role` CHECK is `{owner, board_member, employee}` — `contractor` is not in rebuild; `board_member` is. Founder confirmation needed before F1 ships:
- (a) Update F1 to use `{employee, board_member, owner}` (matches rebuild)
- (b) Amend rebuild to add `contractor` (separate amendment)

Recommend (a) — simpler, matches existing rebuild and §3.11 spec.

## Files modified
**Zero.** Per directive STOP, no code touched.

## Founder decisions needed before F1 retry
1. **P1A-6 schema amendment** — approve the small additive amendment above (or pick alternative: add to public.users instead, or use a different deactivation mechanism)
2. **Role enum mismatch** — confirm `{owner, board_member, employee}` (rebuild canonical) vs F1's `{employee, contractor, owner}` (directive draft)
3. **WhatsApp-only employee scope** — F1's "remove crew member" semantic was intended for portal members (per V2 reasoning); WhatsApp-only employees (users without chiefos_portal_users row) are out of scope for portal-side deactivation and continue to be gated by their `users` row plus plan_key. Confirm.

## Next blocks on
- Founder approval of P1A-6 amendment (small, ~50 lines, additive, no backfill)
- Founder confirmation of role enum (rebuild canonical `{owner, board_member, employee}`)
- After both: F1 directive can be re-issued with P1A-6 listed as the schema dependency (similar to how P1A-5 unblocked R3b)
