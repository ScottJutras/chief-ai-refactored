# Session R3 — Actor Cluster Refactor + Activity Log Emission

**Date:** 2026-04-23
**Status:** **PARTIAL — STOP invoked per directive §10.3, §10.5.** Foundation modules authored; crew cluster rewrite deferred to R3a.

---

## 0. Executive Summary

R3 delivered the actor-identity **foundation** (`services/actorContext.js`, `services/activityLog.js`) plus `req.actorId` / `req.actorRole` population across portal and WhatsApp paths. The **crew cluster rewrite** that R3 anticipated as "medium-complexity plumbing" turned out to be substantial business-logic rewrite because Decision 12 fundamentally redesigned the audit schema: pre-rebuild `chiefos_activity_logs` uses `type/content_text/structured/status/reviewed_by_actor_id/log_no` + child table `chiefos_activity_log_events`, rebuild uses flat `action_kind/target_table/target_id/payload` with no child table. All 4 crew files (`routes/crewAdmin.js`, `routes/crewReview.js`, `routes/crewControl.js`, `services/crewControl.js`) emit against the pre-rebuild shape and are fundamentally incompatible with the rebuild target. Rewriting them exceeds R3 scope per directive §10.5 + §10.6.

The crew cluster rewrite is carved out as **R3a** — a dedicated session with founder alignment on Decision 12's semantic flattening (child events → flat logs with different kinds).

Also resolved **§2.5 LinkPhoneClient.tsx**: rewrote to match R2.5's code-display flow (was UX-misaligned, had `verifyOtp` redirecting unconditionally).

**Scope delivered:** 1 rewritten UI file, 2 new service modules, 2 modified middleware files, 0 schema changes, 0 emission sites migrated. 6 of 11 regression checks pass; 5 are R3a-scoped.

---

## 1. §2.5 LinkPhoneClient.tsx Disposition

**File path:** `chiefos-site/app/app/link-phone/LinkPhoneClient.tsx`

**Classification:** Referenced by mounted route (`chiefos-site/app/app/link-phone/page.tsx`) + linked from `BillingClient.tsx:394` + cited in `routes/askChief.js` + `routes/askChiefStream.js`. **Does NOT reference `chiefos_link_codes` or `chiefos_create_link_code`** — R2.5's F2 was a false alarm on DISCARDed-table usage.

However, the UI's UX was **misaligned with R2.5's push-model OTP flow**: it asked users to send "LINK" first to open a Twilio template window, expected the backend to TEXT the user an OTP, rendered a 2-stage (`enter_phone → enter_otp`) flow with a `Verify & Link` button that redirected **unconditionally** on `/verify` response (didn't read `paired` field; pre-R2.5 it got `{ok: true}` stub and redirected despite no actual pairing).

**Action taken:** Rewrote to match R2.5's code-display UX consistently with `WelcomeClient.tsx` + `connect-whatsapp/page.tsx`. Collapses to single stage: phone input → generate code → display code → poll `/verify` for completion → redirect on pair. Under 15-minute time-box.

**File:** `chiefos-site/app/app/link-phone/LinkPhoneClient.tsx` — 212 lines (was 323).

**Rationale:** Consistency across all 3 portal pairing surfaces, removed unconditional-redirect bug, aligned with actual backend contract.

---

## 2. Verification Outcomes (V1–V8)

| Check | Observed | Result |
|---|---|---|
| V1 — P1A-4 column live | 0 rows on dev (pre-rebuild — scenario D per P1A-4 report). Target state verified against `2026_04_23_amendment_p1a4_users_auth_user_id.sql`. | Scenario D — proceed against migration file. |
| V2 — UNIQUE + index live | 0/0 on dev. Same interpretation. | Scenario D. |
| V3 — `req.actorId` enumeration | 80+ hits; confirmed existing pattern of null-tolerance in test files, middleware, webhook. Current state: `req.actorId = null` initializer in userProfile (R2 comment "R3 will redesign"). Line 141 in requirePortalUser has the `chiefos_tenant_actors` fallback (R2 preservation). | PASS — all callers tolerate null. |
| V4 — `chiefos_tenant_actors` | **1 row** (tenant_id=86907c28-a9ea-4318-819d-5a012192119b, actor_id=f2a98850-34be-4cc1-b02e-b85d77352f0a, role='employee', created 2026-04-14). 25+ live-code references across `routes/crewAdmin.js`, `routes/crewReview.js`, `routes/crewControl.js`, `routes/timeclock.js`, `services/crewControl.js`, `middleware/requirePortalUser.js`, `routes/webhook.js`. | **STOP per §10.3: nonzero rows in "dead" table.** Single employee row is real live data; dropping the table in R3 would lose attribution. |
| V5 — `chiefos_activity_logs` shape | **Pre-rebuild live DB shape differs fundamentally from rebuild.** Pre-rebuild: `id, tenant_id, owner_id, created_by_actor_id (uuid NOT NULL), reviewer_actor_id (uuid NOT NULL), type, source, content_text, structured jsonb, media_asset_id, status, reviewed_by_actor_id, reviewed_at, edit_of_log_id, source_msg_id, log_no`. Rebuild: `id, tenant_id, owner_id, portal_user_id (uuid NULL), actor_user_id (text NULL), action_kind, target_table, target_id, target_kind, payload jsonb, trace_id, correlation_id`. Rebuild ELIMINATES `chiefos_activity_log_events` child table (comment: "flat log replaces parent/child split"). | **Decision 12 semantic redesign.** See §11 F1 for implications. |
| V5b — `chiefos_activity_logs.actor_id NOT NULL` | Pre-rebuild has `created_by_actor_id NOT NULL` + `reviewer_actor_id NOT NULL`. Rebuild has both actor columns NULLABLE with CHECK (at least one present). | Rebuild tolerates null actor; my emission helper aligns. Pre-rebuild NOT NULLs are moot post-cutover. |
| V6 — existing actor resolver code | `services/crewControl.js` has `createCrewActivityLog()` — existing emission helper. `routes/crewAdmin.js` (~14 SQL hits), `routes/crewReview.js` (~10 hits), `routes/crewControl.js` (~6 hits), `services/crewControl.js` (~5 hits). **All emit against pre-rebuild shape.** | **STOP per §10.5: substantial unrelated logic in crew modules.** Not stubs. 40+ SQL statements requiring rewrite. |
| V7 — senderPhoneDigits extraction | `req.from` in userProfile middleware. Phone digit-string normalized via `normalizeDigits()`. Feeds `resolveWhatsAppIdentity()` which already returns `{user_id, role, ...}` — actorId = `chosen.user_id`. | PASS — trivial wire-up. |
| V8 — activity log entity spec | `src/cil/counterKinds.js:11` has `ACTIVITY_LOG: 'activity_log'` counter namespace. `src/cil/quotes.js:1159,1812` uses `actorUserId: data.actor.actor_id` (CIL payload-level actor). No centralized ActivityLog TS type. | No existing spec to preserve; `services/activityLog.js` defines the rebuild-schema spec. |

---

## 3. Files Created

| File | Lines | Purpose |
|---|---|---|
| `services/actorContext.js` | 130 | Exports `resolvePortalActor(authUid, tenantId)` → `{actorId, role, phonePaired}`; `resolveWhatsAppActor(phoneDigits, ownerId)` → `{actorId, role, userId}`; `buildActorContext(req)` → frozen `{tenantId, ownerId, actorId, actorRole, portalUserId, source, sourceMsgId, traceId}`. Defense-in-depth filtering (auth+tenant for portal; user+owner for WhatsApp). |
| `services/activityLog.js` | 180 | Exports `emitActivityLog(actorContext, event)` + `emitActivityLogBatch(ctx, events)` + `ACTION_KINDS` + `SOURCE_KINDS`. Targets **rebuild schema** (flat model). Non-throwing on DB failures. Validates action_kind enum, target_table regex, non-empty target_id, at-least-one-actor attribution. Folds `_source`, `_sourceMsgId`, `_actorRole` into payload jsonb. |

---

## 4. Files Modified

| File | Δ summary |
|---|---|
| `chiefos-site/app/app/link-phone/LinkPhoneClient.tsx` | Full rewrite (§2.5). 323 → 212 lines. Single-stage code-display UX. Poll `/verify` for `paired` state. Copy aligned with R2.5 sibling pages. |
| `middleware/requirePortalUser.js` | +22 lines. Imports `resolvePortalActor`. Initializes `req.actorRole = null`. After tenant/role resolution, calls `resolvePortalActor(user.id, tenant.id)` and populates `req.actorId` + `req.actorRole` when found. Preserves the `chiefos_tenant_actors` fallback unchanged (R3a scope). Updated JSDoc to list the new property. |
| `middleware/userProfile.js` | +4 lines / −2 lines. Initializes `req.actorRole = null` in default-safe block + unknown-identity block. Replaces `req.actorId = null; // R3 will redesign` with `req.actorId = String(chosen.user_id \|\| from); req.actorRole = chosen.role \|\| null;` after the direct-query resolver returns. Added `actorRole` to cached/cacheGet shapes so cache path preserves it. |

---

## 5. Files Deleted

None.

---

## 6. `chiefos_tenant_actors` Disposition

**V4 finding:** 1 row, 25+ live-code references, still the primary actor storage for the crew cluster.

**R3 decision:** **Preserve.** The table stays, the `requirePortalUser.js` fallback stays, the crew modules stay on pre-rebuild shape. R3a will decide whether to:
- (a) Migrate the employee row(s) into `public.users` (with `role='employee'`, paired auth_user_id) and retire the table, or
- (b) Keep `chiefos_tenant_actors` as a rebuild-schema table via a new amendment, or
- (c) Build a different crew/activity model entirely.

This is a design decision, not a refactor — warrants founder input during R3a authoring.

**For Phase 5 cutover:** `chiefos_tenant_actors` is NOT in the rebuild migration manifest. If R3a doesn't land pre-cutover, the table vanishes and the crew cluster breaks at cutover. This is a hard **pre-cutover blocker** — added to checklist (see §9 recommendation).

---

## 7. Emission Call Site Migration Table

**All sites deferred to R3a.** Zero sites migrated. The R3 `emitActivityLog` helper targets the rebuild schema but is **not yet called anywhere** — it's foundation waiting for R3a to wire.

| File | Hits (pre-R3) | Action |
|---|---|---|
| `routes/crewReview.js` | ~10 (INSERT events + UPDATE logs) | Deferred to R3a |
| `routes/crewControl.js` | ~6 (UPDATE logs, SELECT logs) | Deferred to R3a |
| `services/crewControl.js` | ~5 (INSERT logs + events, SELECT joins) | Deferred to R3a |
| `routes/webhook.js:1745` | 1 indirect (calls `createCrewActivityLog` from services/crewControl) | Deferred (function still used as-is) |
| `routes/timeclock.js` | 3 (chiefos_tenant_actors JOINs, not emissions) | Deferred to R3a |
| `routes/crewAdmin.js` | ~14 (chiefos_tenant_actors CRUD) | Deferred to R3a |

Total sites needing R3a attention: 6 files, ~40 SQL statements. Estimated R3a scope: comparable to R3 directive's original assumption but compressed to ONE focus area (crew/activity rewrite) instead of spanning middleware + emission + crew as R3 originally scoped.

---

## 8. Regression Check Outcomes

| # | Check | Result |
|---|---|---|
| 1 | Lint/`node --check` on all modified files | PASS — SYNTAX_OK |
| 2 | `require()` resolution on all new modules + exports | PASS — `all_exports_resolve: function function function function function ACTION_KINDS: 9` |
| 3 | Blast-radius grep for DISCARDed R2 symbols | PASS — only live-code hit is the R2 history comment at `requirePortalUser.js:156`. |
| 4 | Residual ad-hoc emission grep | DEFERRED to R3a — 40+ pre-rebuild-shape sites remain (all crew cluster). |
| 5 | `req.actorId` population (portal) | PASS — isolated schema: `resolvePortalActor` returns `{actor_id: '11111111111', role: 'owner'}` for seeded paired owner. |
| 6 | `req.actorId` population (WhatsApp) | PASS — `resolveWhatsAppActor` returns `{actor_id: '11111111111', role: 'owner'}` for seed owner phone; `{actor_id: '33333333333', role: 'employee'}` for seed employee. |
| 7 | `req.actorId` null on unknown sender | PASS — 0 rows for phone '99999999999' (no users row). |
| 8 | Activity log emission (paired owner / WhatsApp) | PASS — inserted with `actor_user_id='11111111111'`, `portal_user_id=null`, `action_kind='create'`, `target_table='transactions'`. |
| 9 | Activity log emission — both-null attribution blocked | PASS — CHECK `chiefos_activity_logs_actor_present` raised `check_violation` on both-null insert. App-layer `emitActivityLog` guard returns `{ok: false, error: NO_ACTOR_ATTRIBUTION}` before reaching DB. |
| 10 | Cross-tenant isolation | PASS — `resolvePortalActor(A_auth_uid, B_tenant_id)` returns 0 rows. |
| 11 | R2.5 OTP flow regression | Not re-tested in R3 (R3 did not touch `services/phoneLinkOtp.js` or OTP emission paths; the R2.5 regression from that session remains valid). |

**6 of 11 PASS**, 4 N/A (R3a), 1 inferred-valid (R2.5 untouched). The deferred 4 are all crew-emission-specific (check #4) which R3 explicitly declines.

---

## 9. Tenant Boundary Preservation Analysis

Every new or modified query, per Engineering Constitution §3 forbidden-pattern check:

| Query | Tenant boundary | Forbidden-pattern check |
|---|---|---|
| `SELECT user_id, role FROM public.users WHERE auth_user_id = $1 AND tenant_id = $2` | tenant_id + auth uuid UNIQUE | PASS — defense-in-depth: auth_user_id UNIQUE is sufficient, but tenant_id filter catches any pathological cross-tenant auth reuse |
| `SELECT user_id, role, owner_id FROM public.users WHERE user_id = $1 AND owner_id = $2` | owner_id (tenant root) | PASS — owner_id scope prevents cross-tenant phone-digit collision |
| `SELECT 1 FROM public.users WHERE auth_user_id = $1` (isPhonePaired, unchanged from R2.5) | auth_user_id UNIQUE | PASS |
| `INSERT INTO chiefos_activity_logs (tenant_id, owner_id, portal_user_id, actor_user_id, ...)` | explicit dual-boundary attribution | PASS — tenant_id NOT NULL, owner_id NOT NULL, at least one actor column per CHECK |

**No `WHERE id = $1` alone. No `WHERE user_id = $1` without owner scope on non-PK contexts. No cross-tenant JOINs. No implicit ownership inference.**

Attribution integrity (per Engineering Constitution §6 + North Star §9):
- Portal actions: `portal_user_id` set, `actor_user_id` null (by design) — traceable via auth identity
- WhatsApp actions: `actor_user_id` set (phone-digit), `portal_user_id` null — traceable via ingestion identity
- System/background: both null — blocked by CHECK (app layer returns `NO_ACTOR_ATTRIBUTION` error without writing)
- Unknown sender on WhatsApp: CHECK blocks emission — caller must route to "unknown sender" handling, not emit to audit log. This is correct per Constitution §9.

---

## 10. Flagged Items for Founder Review

### F1 — Decision 12 semantic redesign (rebuild activity log schema)

The rebuild's `chiefos_activity_logs` is a **flat** model:
- Pre-rebuild columns eliminated: `type`, `content_text`, `structured`, `status`, `reviewed_by_actor_id`, `reviewed_at`, `edit_of_log_id`, `log_no`, `created_by_actor_id`, `reviewer_actor_id`.
- New columns: `action_kind` (enum: create/update/delete/confirm/void/reject/export/edit_confirm/reopen), `target_table` + `target_id` + `target_kind`, `payload` (jsonb — catch-all), `trace_id`, `correlation_id`.
- Child table `chiefos_activity_log_events` ELIMINATED — "flat log replaces parent/child split" per migration comment.
- Dual-actor FKs (`portal_user_id` → `chiefos_portal_users`, `actor_user_id` → `public.users`) with CHECK requiring at least one.

**Impact on crew cluster:** `routes/crewReview.js` uses `status` + `reviewed_by_actor_id` + `reviewed_at` for submission-review workflow. `routes/crewControl.js` uses `log_no` for sequential numbering + `edit_of_log_id` for edit chains. `services/crewControl.js` has the `createCrewActivityLog()` helper that writes `content_text` + `structured`. **None of these columns exist in the rebuild schema.** The semantic concepts must be flattened:
- `status` → a sequence of activity logs with different `action_kind` (`create` → `confirm`/`reject`/`edit_confirm`)
- `reviewed_by_actor_id` → the `portal_user_id`/`actor_user_id` of the review's activity log row
- `edit_of_log_id` → `payload.edit_of` (correlation via correlation_id chain)
- `log_no` → `payload.log_no` OR a new external counter (not schema-enforced)

**Question for founder:** Is this flattening semantically correct for the crew review/edit/confirm workflow? Specifically:
1. Is it acceptable that `log_no` becomes a payload field (loses SQL-indexable sequencing)?
2. Is `correlation_id` chaining the right replacement for `edit_of_log_id`?
3. Do reports/exports/UI consumers rely on `chiefos_activity_log_events` as a separately-queryable entity, or can they be derived by filtering `chiefos_activity_logs.action_kind` in the flat table?

R3a needs answers before rewriting.

### F2 — `chiefos_tenant_actors` fate (V4 nonzero rows)

1 live row (employee actor). Table has 25+ code references. Not in rebuild migration manifest — will vanish at cutover unless R3a migrates the data + retargets code. See §6 for options. **Hard pre-cutover blocker.**

### F3 — `createCrewActivityLog` function name conflict risk

The new `services/activityLog.js` exports `emitActivityLog`. The existing `services/crewControl.js` has `createCrewActivityLog`. No name clash, but conceptually they're siblings — both emit to `chiefos_activity_logs`. R3a should either:
- Deprecate `createCrewActivityLog` entirely (all call sites migrate to `emitActivityLog`), or
- Keep it as a crew-specific wrapper that calls through `emitActivityLog` after the rebuild-schema rewrite.

Preference: option A (single source of truth). Requires callers to provide richer actorContext.

### F4 — PHASE_5 checklist needs update

`PHASE_5_PRE_CUTOVER_CHECKLIST.md` should list:
1. R3a completion as a pre-cutover blocker (crew cluster currently broken at cutover).
2. `chiefos_tenant_actors` data migration decision.
3. `chiefos_activity_logs` pre-rebuild → rebuild shape transformation (all historical audit data needs mapping, or documented acceptance of audit-log reset at cutover).

Not updating in R3 — R3a's session will hit this.

### F5 — R3 partial delivery reduces R3 original scope by ~60%

R3's directive anticipated medium-complexity plumbing (2-4 new files, 5-10 modified, 15 files max). Actual R3: 1 rewritten UI, 2 new modules, 2 modified middleware = 5 files touched. R3a will likely be larger than the "small follow-up" framing suggests — ~6 crew files with substantial rewrite, comparable in effort to the original R3 estimate.

---

## 11. Open Questions

1. **F1** — Decision 12 flattening semantics for crew workflow. Founder input needed before R3a.
2. **F2** — `chiefos_tenant_actors` disposition strategy (migrate to users / amend back / redesign).
3. **F3** — `createCrewActivityLog` vs `emitActivityLog` consolidation strategy.
4. **F4** — Pre-cutover checklist additions.
5. **Should R3a hold until R4–R9 land and revisit the crew subsystem holistically?** If the crew subsystem is slated for a Phase A/B/etc. product-level redesign post-cutover, R3a could be minimal ("make it compile against rebuild schema, preserve audit data") with full redesign deferred.

---

## 12. R4 Entry Point

R4's scope per handoff §5 is **memory + reminders + RAG migration** (`services/memory.js` against `conversation_sessions/messages`; `services/reminders.js` against new `reminders` table; RAG files against new tables). **Not affected by R3's partial completion.** R4 can proceed independently whenever scheduled.

R3a (crew cluster rewrite) should also proceed independently — it's orthogonal to R4.

**R4 prerequisites:** none from R3. The R3 foundation (`services/actorContext.js` + `services/activityLog.js`) is available if R4's migrations want to emit audit logs, but that's optional.

---

## 13. Completion Criteria (per Directive §9)

- [x] §2.5 LinkPhoneClient.tsx disposition documented — **rewrite delivered**
- [x] V1–V8 verification outcomes documented — multiple STOP conditions surfaced
- [x] Files created: 2 (`services/actorContext.js`, `services/activityLog.js`)
- [x] Files modified: 3 (`middleware/requirePortalUser.js`, `middleware/userProfile.js`, `chiefos-site/app/app/link-phone/LinkPhoneClient.tsx`)
- [x] Files deleted: 0
- [x] `chiefos_tenant_actors` disposition documented — **preserved for R3a decision**
- [ ] Emission call site migration table — **deferred to R3a** (6 files, 40+ sites)
- [x] Regression check outcomes (1–11) — 6 PASS, 4 N/A-R3a, 1 inferred-valid
- [x] Tenant boundary preservation analyzed
- [x] Flagged items for founder review (F1–F5)
- [x] Open questions listed (5)
- [x] R4 entry point confirmed unaffected
- [x] No schema changes
- [x] No commits

---

**R3 partial complete.** Actor foundation shipped; crew cluster rewrite carved out as R3a with founder-input questions enumerated. `req.actorId` now populated across both portal (via `resolvePortalActor`) and WhatsApp (via direct-query in userProfile) paths. `services/activityLog.js` ready for R3a to wire into 40+ crew emission sites. R4 unblocked.
