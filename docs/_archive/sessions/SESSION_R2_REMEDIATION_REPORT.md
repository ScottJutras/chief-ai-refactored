# Session R2 — Identity Resolver Migration Report

**Date:** 2026-04-23
**Scope:** Replace all app-code references to the 5 DISCARDed identity-resolution objects with direct queries against `public.users` / `chiefos_portal_users` / `chiefos_tenants`.
**Prerequisite:** R1 complete (feature-safe deletions + Phase 1 amendments).
**Next:** R3 — actor cluster refactor (`crewAdmin` / `crewReview` / `crewControl` + `services/crewControl.js`, `chiefos_activity_logs` emission flattening).

---

## 1. Call-Site Inventory (Before-State)

All live call sites found via `grep` of `v_actor_identity_resolver | v_identity_resolver | chiefos_phone_active_tenant | chiefos_user_identities | chiefos_identity_map` across `*.{js,ts,jsx,tsx}` (excluding `node_modules`, `.claude/worktrees`, `archive`):

| File | Lines (before) | DISCARDed object | Purpose |
|---|---|---|---|
| `middleware/userProfile.js` | 116 | `chiefos_phone_active_tenant` | Lookup of the active tenant for a multi-tenant phone |
| `middleware/userProfile.js` | 176 | `v_actor_identity_resolver` | Primary phone → (tenant, role, actor_id) resolver (hot path) |
| `middleware/userProfile.js` | 225, 248, 444, 454 | `chiefos_user_identities` | Direct fallback resolver (+ log labels) |
| `middleware/requirePortalUser.js` | 127 | `v_actor_identity_resolver` | Resolve portal `actor_id` from email at auth time |
| `services/postgres.js` | 195 | `v_actor_identity_resolver` | `getTenantIdForOwnerDigits()` primary lookup |
| `services/postgres.js` | 216 | `v_identity_resolver` | `getTenantIdForOwnerDigits()` alternate-name fallback |
| `handlers/media.js` | 307 (+319, 328) | `chiefos_user_identities` | `resolveTenantIdForMedia()` — WhatsApp-side media tenant resolution |
| `routes/webhook.js` | 358 | `chiefos_identity_map` | `redeemLinkCodeToTenant()` — cache the phone→tenant pairing |
| `routes/webhook.js` | 2570 | `chiefos_phone_active_tenant` | Multi-tenant "use N" command handler — upsert active tenant |
| `routes/portal.js` | 147 | `chiefos_user_identities` | `whoami` — check whether portal user has a linked WhatsApp identity |
| `routes/account.js` | 59 | `chiefos_user_identities` | `resolveTenantAndOwner()` fallback path for owner digits |
| `routes/account.js` | 137 | `chiefos_user_identities` | `POST /delete` cleanup |

Totals: 13 live call sites across 7 files, covering all 5 DISCARDed objects.

---

## 2. Per-Site Resolution Strategy

The rebuild schema (`migrations/2026_04_21_rebuild_identity_tenancy.sql`) enforces:

- `public.users.user_id` is the **phone-digit PK** — one phone ↔ one tenant by PK uniqueness
- `public.users` carries `owner_id`, `tenant_id`, `role`, `plan_key`, `sub_status`, `tz` directly
- `public.chiefos_tenants.owner_id` is **UNIQUE** — single-row lookup per owner
- `public.chiefos_portal_users` = `(user_id uuid = auth.uid()) → tenant_id, role`

This makes several directive patterns simpler than originally described and eliminates the pre-rebuild multi-tenant-phone case entirely.

| Call site | Pattern | Replacement |
|---|---|---|
| `userProfile.js` — main resolver | A (phone → identity tuple) | `SELECT u.user_id, u.owner_id, u.tenant_id, u.role, u.plan_key, u.sub_status, coalesce(u.tz, t.tz) AS tz FROM public.users u JOIN public.chiefos_tenants t ON t.id = u.tenant_id WHERE u.user_id = $1 LIMIT 1` |
| `userProfile.js` — multi-tenant branch | N/A in rebuild | Deleted; `req.multiTenant` / `req.multiTenantChoices` always set to `false` / `[]` |
| `userProfile.js` — legacy `public.users` fallback | N/A in rebuild | Deleted (primary resolver already hits `public.users`; fallback is redundant) |
| `requirePortalUser.js` — email → actor_id | None (actor concept collapses) | Lookup removed; `req.actorId` initialized null. `chiefos_tenant_actors` fallback kept — R3 scope. |
| `services/postgres.js` — `getTenantIdForOwnerDigits` | Single chiefos_tenants lookup | `SELECT id AS tenant_id FROM public.chiefos_tenants WHERE owner_id = $1 LIMIT 1` (UNIQUE index used) |
| `handlers/media.js` — WhatsApp-side tenant | A (phone → tenant_id) | `SELECT tenant_id FROM public.users WHERE user_id = $1 LIMIT 1` |
| `routes/webhook.js` — `redeemLinkCodeToTenant` cache | Upsert ingestion identity | `INSERT INTO public.users (user_id, owner_id, tenant_id, role) SELECT $2, t.owner_id, $1::uuid, 'employee' FROM public.chiefos_tenants t WHERE t.id = $1::uuid ON CONFLICT (user_id) DO UPDATE …` |
| `routes/webhook.js` — "use N" multi-tenant handler | N/A in rebuild | Deleted; rebuild PK prevents multi-tenant phones |
| `routes/portal.js` — `hasWhatsApp` on whoami | Owner-only approximation (flagged — §9) | `SELECT 1 FROM public.users WHERE tenant_id = $1::uuid AND user_id = $2` — runs only when `req.portalRole === 'owner'`; non-owners return `false` |
| `routes/account.js` — owner-digits fallback | Tenant lookup | `SELECT owner_id FROM public.chiefos_tenants WHERE id = $1::uuid` |
| `routes/account.js` — `POST /delete` cleanup | Users-table delete | `DELETE FROM public.users WHERE tenant_id = $1::uuid AND user_id = $2` (ownerId digits) |

---

## 3. Middleware Changes

### `middleware/userProfile.js` (hot path — every authenticated WhatsApp request)

**Preserved output shape** — every downstream consumer sees the same `req` fields it did before:

- `req.from`, `req.tenantId`, `req.ownerId`, `req.isOwner`, `req.tz`, `req.actorId`, `req.userProfile`, `req.ownerProfile`, `req.dbDegraded` — unchanged
- `req.userProfile.plan`, `req.ownerProfile.plan_key`, `req.ownerProfile.sub_status` — still resolved via `resolveOwnerPlan()` (untouched — already queries `public.users`)
- `req.multiTenant` / `req.multiTenantChoices` — always `false` / `[]` in rebuild (schema eliminates the case)

**Deleted helpers:** `getActiveTenantForPhone`, `resolveActorIdentities`, `resolveWhatsAppIdentityDirect`, `resolveLegacyUser`, `loadTenantNames`. All superseded by the single direct-query `resolveWhatsAppIdentity()`.

**Cache change:** the cache fast-path no longer requires `actorId` to accept a hit. Previously the cache rejected entries missing `actorId`, which in rebuild would be *every* entry (actorId is always null until R3). Without this fix, the cache was effectively disabled for the entire hot path — a silent performance regression. Cache now accepts any positive `(tenantId, ownerId)` mapping.

**Query-plan note:** the new single JOIN uses the `users` PK (on `user_id`) + `chiefos_tenants` PK (on `id`) — both covered indexes. Expected plan: `Index Scan` + `Index Scan`, sub-millisecond on a warm pool. No index patch needed (§5).

### `middleware/requirePortalUser.js`

`v_actor_identity_resolver` email → actor_id lookup removed. `chiefos_tenant_actors` fallback (lines 143–160) **intentionally preserved** — that's R3's scope (actor cluster refactor). Until R3 lands, portal `req.actorId` remains null for most portal requests; callers already tolerate null.

`withPlanKey()` still references `subscription_tier` / `paid_tier` on `public.users`, which are **dropped columns** in the rebuild. That's **R8 scope** per §5 of the handoff (column renames, dropped-column cleanup). Out of R2.

---

## 4. Service-Layer Changes

### `services/postgres.js` — `getTenantIdForOwnerDigits`

Collapsed from two view lookups to one `chiefos_tenants` lookup. The rebuild's UNIQUE constraint on `chiefos_tenants.owner_id` guarantees at most one match, so the fallback is structurally unnecessary. Function signature unchanged — returns `tenant_id::text | null`.

Callers at `services/postgres.js:435` + `:1598` (`resolveTenantIdForOwner`) continue to work without modification.

### `handlers/media.js` — `resolveTenantIdForMedia`

The primary phone-digit lookup now hits `public.users` directly. The secondary fallback (chiefos_tenants by owner_id) was already rebuild-compatible and is unchanged. Return shape unchanged.

### `routes/portal.js` — `whoami`

`hasWhatsApp` check narrowed to portal-role `owner` only (see §9 flagged item). Non-owner portal users now always receive `hasWhatsApp: false` until R3 provides a durable auth.uid() → phone-digit linkage.

### `routes/account.js` — `resolveTenantAndOwner` + `POST /delete`

Fallback owner-digit resolution reshoed from `chiefos_user_identities` to `chiefos_tenants.owner_id`. `/delete` now cleans up the `public.users` row (instead of chiefos_user_identities). Membership removal from `chiefos_portal_users` unchanged.

### `routes/webhook.js` — two changes

1. `redeemLinkCodeToTenant` `chiefos_identity_map` INSERT replaced with an UPSERT into `public.users`. **Note:** the enclosing function also calls `chiefos_link_codes` (line 335) which is separately DISCARDed — the end-to-end link-code redemption flow will still fail at cutover until that table is handled. That's out of R2 scope (scheduled for the `chiefos_link_codes` cleanup, likely R8 or earlier per the audit's BLOCKING list).

2. Multi-tenant "use N" gate at line 2552 (which wrote to `chiefos_phone_active_tenant`) deleted entirely. userProfile now always sets `req.multiTenant = false`, making the branch unreachable. Replaced with a brief comment pointing future readers at the schema constraint.

---

## 5. Index-Patch Migration

**Not needed.** Every column used in the replacement queries is already indexed by `2026_04_21_rebuild_identity_tenancy.sql`:

- `public.users.user_id` — primary key
- `public.users.owner_id` — `users_owner_idx`
- `public.users.tenant_id` — `users_tenant_idx`
- `public.chiefos_tenants.id` — primary key
- `public.chiefos_tenants.owner_id` — `chiefos_tenants_owner_idx` + `chiefos_tenants_owner_id_unique` constraint
- `public.chiefos_portal_users.user_id` — primary key
- `public.chiefos_portal_users.tenant_id` — `chiefos_portal_users_tenant_idx`

No `CREATE INDEX` patch authored.

---

## 6. Regression Check Outcomes

- `node --check` — PASS for all 7 refactored files (`middleware/userProfile.js`, `middleware/requirePortalUser.js`, `services/postgres.js`, `handlers/media.js`, `routes/webhook.js`, `routes/portal.js`, `routes/account.js`).
- `require()` resolution — PASS for all 6 loadable modules (everything except `routes/webhook.js`, which is mounted via `cil.js` and not standalone-requireable).
- Blast-radius grep — CLEAN. All 5 DISCARDed object names appear only in documentation comments in live code (3 comment hits across webhook/account/requirePortalUser); the remaining hits are inside `.claude/worktrees/*` (isolated worktree copies, not live code).

---

## 7. Identity Resolution Test Cases (Documented, Not Executed)

The following tests should run against dev DB (`xnmsjdummnnistzcxrtj`) before Phase 5 cutover. Not executed in this session because dev DB does not yet have the rebuild schema applied.

| Case | Input | Expected |
|---|---|---|
| Owner WhatsApp ingest | phone digits = owner's user_id | returns `{tenant_id, owner_id=self, role='owner', tz}` |
| Employee WhatsApp ingest | phone digits of employee row | returns `{tenant_id, owner_id=tenant root, role='employee', tz}` |
| Unknown phone | digits not in `users` | returns null; middleware sets all identity req.* to null |
| Portal auth → tenant | `auth.uid()` with membership | `requirePortalUser` populates tenant_id, ownerId (from `chiefos_tenants.owner_id`), portalRole |
| Portal auth → `getTenantIdForOwnerDigits` | owner digits | returns tenant_id (single row via UNIQUE) |
| Cross-tenant leak | auth.uid() of tenant A asking for tenant B resources | RLS on `chiefos_portal_users` blocks (schema-level, no app-layer test needed) |
| `hasWhatsApp` for owner | portalRole='owner' | returns true if `users` row exists with `user_id = tenant.owner_id` |
| `hasWhatsApp` for non-owner | portalRole='employee' or 'board_member' | always false (see §9 flag) |

---

## 8. Performance Observations

Not measured in dev DB (schema not yet applied). Theoretical:

- Old userProfile hot-path: 1–2 view scans (`v_actor_identity_resolver`, optional `chiefos_user_identities` fallback) + 1 `chiefos_phone_active_tenant` scan on multi-tenant. Views likely JOIN at least 2 tables each.
- New userProfile hot-path: 1 indexed lookup on `users.user_id` (PK) with a nested loop join to `chiefos_tenants` by PK.

Expected to be faster, not slower. If any resolution takes >50ms in dev benchmarking, flag for post-cutover investigation; nothing currently suggests it will.

---

## 9. Flagged Items for Founder Review

### F1 — Non-owner portal `hasWhatsApp` approximation (routes/portal.js)

The rebuild schema has **no durable `auth.uid()` → phone-digit mapping**. For portal users who are not the tenant owner (employees, board members), we cannot determine whether their phone is linked to WhatsApp. Current code returns `hasWhatsApp: false` for non-owners — this is a regression from pre-rebuild behavior.

**Possible remediation (post-R2):**
- Add a `chiefos_portal_users.wa_user_id text NULL` column referencing `public.users.user_id`
- Or add a reverse lookup: store `auth_user_id uuid` on the `users` row when pairing completes via `portal_phone_link_otp`
- Either would require a schema amendment (Phase 1 scope gap). Suggest reviewing whether the whoami's `hasWhatsApp` signal is load-bearing on the portal UI; if it isn't, the approximation is acceptable.

### F2 — `redeemLinkCodeToTenant` dependency on DISCARDed `chiefos_link_codes`

The function's primary dependency (`chiefos_link_codes`) is separately DISCARDed and not in R2 scope. R2 replaced the downstream `chiefos_identity_map` INSERT with a rebuild-compatible `public.users` UPSERT, but the outer function will still fail at cutover until the `chiefos_link_codes` flow is replaced (likely via `portal_phone_link_otp`). Per audit §2.4 there are 3 hits on `chiefos_link_codes` — routes/webhook.js + 2 chiefos-site files.

Recommendation: schedule a `chiefos_link_codes` remediation session (probably bundled with R8 column-rename/cleanup, or a dedicated linking-flow session).

### F3 — `withPlanKey` references dropped columns

`middleware/requirePortalUser.js` line 192 selects `subscription_tier, paid_tier` from `public.users`. Those columns are dropped in the rebuild (see §5 R8 in the handoff). Out of R2 scope but worth noting so R8 has a pre-existing catch.

### F4 — `actorId` concept collapses in rebuild

`req.actorId` is now always null in both middleware files (except when the surviving `chiefos_tenant_actors` fallback hits — R3 scope). No callers I've checked strictly depend on a non-null actorId, but if any downstream consumer branches on `req.actorId` being set, that path is now dormant. Worth a light audit during R3 to confirm no latent bugs (grep showed 8 files using `req.actorId`; they all appear to treat null as acceptable).

### F5 — Unchanged: `chiefos_tenant_actors` remains in `requirePortalUser` as R3 scope

Not a regression — just a reminder that the middleware's actor fallback still references a DISCARDed table. R3 will replace this.

---

## 10. Tenant-Boundary Integrity Check

Every replacement query preserves or tightens tenant isolation vs. the original:

- `users.user_id = $1 LIMIT 1` returns a row whose `tenant_id` becomes the boundary. Cannot leak across tenants because `user_id` is PK (one tenant per row).
- `chiefos_tenants.owner_id = $1 LIMIT 1` — UNIQUE constraint prevents cross-tenant ambiguity.
- `public.users WHERE tenant_id = $1 AND user_id = $2` (portal whoami + account-delete) — explicit two-field scope.
- `chiefos_portal_users.user_id = $1::uuid` — membership is keyed on auth.uid(), which is the caller's own identity; RLS-safe.

No query loosened boundary. All writes scope both `tenant_id` and (where applicable) `owner_id` / `user_id`.

---

## 11. Readiness for R3

R2 completion criteria (per directive):

- [x] Zero references to the 5 DISCARDed objects in live code (main-tree; comments only remain)
- [x] `middleware/userProfile.js` output shape preserved
- [x] `middleware/requirePortalUser.js` output shape preserved
- [x] Service-layer function signatures preserved
- [x] No index-patch migration needed (all indexes already exist)
- [x] `node --check` clean across all refactored files
- [x] `require()` resolution passes
- [x] Blast-radius grep clean
- [x] Session report produced
- [x] No commits

**R3 entry point:** actor cluster refactor in `crewAdmin.js`, `crewReview.js`, `crewControl.js`, `services/crewControl.js`, and the `chiefos_tenant_actors` fallback still present in `middleware/requirePortalUser.js` + the `actor_id`-reading middleware paths. R3 will also flatten `chiefos_activity_log_events` emission into `chiefos_activity_logs`.

---

R2 identity resolver migration complete. 13 call sites refactored, 2 middleware files updated. Ready for R3 (actor cluster).
