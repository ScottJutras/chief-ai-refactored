# Post-Cutover Punchlist

Items deferred from the Phase 5 cutover session (2026-04-26). All non-blocking but must land before downstream feature work assumes a clean baseline.

---

## P1 — services/integrity.js field-set alignment (V6.B)

**Status:** verify endpoints currently return 503 (`routes/integrity.js`, commit `73321bfb`). On-disk integrity chain stamped by trigger `chiefos_integrity_chain_stamp` is intact and continues stamping new INSERTs correctly. JS verifier in `services/integrity.js` references stale field set, would mark every row invalid if called.

**Drift surfaces:**

`buildTransactionHashInput` (services/integrity.js:22): currently uses pre-rebuild field set. Update to match trigger:
```
amount_cents, created_at, currency, date, id, kind, owner_id,
previous_hash, source, source_msg_id, tenant_id
```
Drop: `description`, `job_id`, `user_id`. Add: `currency`, `date`, `id`.

`buildTimeEntryHashInput` (services/integrity.js:45): currently uses pre-rebuild field set. Update to match trigger:
```
created_at, end_at_utc, id, kind, owner_id, previous_hash,
source_msg_id, start_at_utc, tenant_id, user_id
```
Drop: `clock_in`, `clock_out`, `job_id`, `total_work_minutes`. Add: `end_at_utc`, `id`, `kind`, `source_msg_id`, `start_at_utc`, `tenant_id`.

**Hash algorithm note:** trigger uses `encode(sha256(jsonb_value::text::bytea), 'hex')`. JS uses `crypto.createHash('sha256').update(JSON.stringify(fields, sortedKeys), 'utf8').digest('hex')`. To match, the JS side must serialize the same key→value pairs with the same canonical form Postgres `jsonb::text` produces (jsonb sorts keys by length-then-alphabetical and emits without trailing whitespace). Verify byte-equivalence with a small fixture before shipping.

**Required tasks:**

1. Update `buildTransactionHashInput` and `buildTimeEntryHashInput` to align field sets.
2. Adjust `verifyRecord` callers and snapshot-comparison logic for the new field shape.
3. Add a regression test (`test/integrity.fieldsets.test.js` or similar) asserting JS hash-input field sets exactly match the trigger's `jsonb_build_object` field sets — parse the trigger SQL or store expected sets as a fixture, and fail the test if either side drifts.
4. Verify the JS-recomputed hash matches the trigger-stamped hash on a sample row pulled from production (proves canonical serialization aligns).
5. Remove the 503 gate from `routes/integrity.js` once verifier alignment ships.

**Reference:** Phase 5 V6 verification finding, 2026-04-26.

---

## P2 — Other deferred items

- **Admin role build** — `chiefos_portal_users.role` enum is `{owner, board_member, employee}`. No `admin` value. When admin tier is needed post-Beta, add a P1A-7-style amendment migration extending the role enum + adding any needed `chiefos_role_audit.action` value (`admin_grant`/`admin_revoke`).
- **GitGuardian secret leaks (3)** — founder is identifying secrets in parallel to cutover. Track resolution separately.
- **Untracked documentation artifacts at repo root** — `01_*` through `06_*` strategy docs, `FOUNDATION_P*_*` reports, `PHASE_*_*` checkpoints. Sweep and commit (or move to `docs/_archive/`) in a dedicated docs-housekeeping commit after cutover settles.
- **Board assignment re-implementation** — post-cutover feature work, not in scope for this session.
- **Voice response sequence** — F2 voice work, post-cutover.

---

**This punchlist closes when every P1 item is resolved.** P2 items are tracked individually with their own owners/timelines.
