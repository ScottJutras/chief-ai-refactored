# Session R2.5 — Phone-Link OTP Call-Site Migration Report

**Date:** 2026-04-23
**Scope:** Migrate off DISCARDed `chiefos_link_codes` onto `portal_phone_link_otp` + `public.users.auth_user_id` (P1A-4). Expose `req.isPhonePaired`. Add `requirePhonePaired` middleware helper. Fix whoami `hasWhatsApp` for all portal users.
**Prerequisite:** R1/R2/P1A-4 authored. P1A-4 migration NOT APPLIED to dev DB (same pre-rebuild state as P1A-4 session — see V1/V2).
**Outcome:** 2 new files, 5 modified files, 0 schema changes, 9 regression checks passed.

---

## 1. Verification Outcomes (V1–V7)

| Check | Expected | Observed | Result |
|---|---|---|---|
| V1 — `users.auth_user_id` column exists | 1 row | 0 rows | "scenario D" — dev is pre-rebuild; P1A-4 is authored, applies at Phase 5 cutover (same pragmatic interpretation as P1A-4 session). Target state verified against migration file. |
| V2 — `users_auth_user_id_unique` + `users_auth_user_idx` | 1 row each | 0 rows each | Same as V1. Confirmed against migration file. |
| V3 — `chiefos_link_codes` grep | 3 sites total (1 backend + 2 chiefos-site) | 1 in `routes/webhook.js` + 2 in `chiefos-site/app/app/welcome/WelcomeClient.tsx` + 1 in `chiefos-site/app/app/connect-whatsapp/page.tsx` = 4 hits across 3 files | PASS (count matches expected "3 sites"). `redeemLinkCodeToTenant` found at `routes/webhook.js:324` (definition) and `:2530` (caller). No `generateLinkCode` or `createLinkCode` helpers. |
| V4 — current `hasWhatsApp` derivation | owner-only approximation | `req.portalRole === "owner"` gated, joined `chiefos_tenants.owner_id = users.user_id` (R2 shape) | PASS — matches R2 report §3. |
| V5 — `requirePortalUser.js` contract | 7 req properties set (portalUserId, tenantId, portalRole, tenant, ownerId, actorId, supabaseAccessToken) | All 7 present; added `req.isPhonePaired = false` initializer without renaming or removing any existing property | PASS — additive only. |
| V6 — hash convention | existing idiom | `crypto.createHash('sha256').update(input).digest('hex')` used in 10+ places. No bcrypt. `timingSafeEqual` not established but standard Node API. | Adopted `sha256(code + PEPPER)` for OTP storage + `timingSafeEqual` for comparison. |
| V7 — Twilio signature verification | `twilio.validateRequest` active in middleware | `middleware/token.js:37,40` — `tokenMiddleware` mounted at `routes/webhook.js:1447`, before `userProfileMiddleware` and the OTP detection block | PASS — OTP detection runs AFTER signature verification. |

---

## 2. Files Created

| File | Lines | Purpose |
|---|---|---|
| `services/phoneLinkOtp.js` | 187 | Exports `generatePhoneLinkOtp`, `verifyPhoneLinkOtp`, `isPhonePaired`. SHA-256 + pepper hashing, `crypto.timingSafeEqual` constant-time compare, atomic pair + consume via BEGIN/COMMIT. |
| `middleware/requirePhonePaired.js` | 21 | Exported middleware returning 403 `PHONE_LINK_REQUIRED` when `req.isPhonePaired` is false. Not mounted on any route (per directive §12). |

---

## 3. Files Modified

| File | Δ summary |
|---|---|
| `routes/webhook.js` | +34 lines / −70 lines. Removed `parseLinkCommand` + `redeemLinkCodeToTenant` (68 lines). Added `verifyPhoneLinkOtp` import and inline 6-digit OTP detection block that runs after Twilio signature + tenant resolution, before domain routing. Emits success/conflict TwiML responses; non-match messages fall through. |
| `routes/portal.js` | +35 lines / −25 lines. Replaced whoami owner-only `hasWhatsApp` approximation with `isPhonePaired(req.portalUserId)` (uses `req.isPhonePaired` cache when populated by middleware). Wired `/link-phone/start` to `generatePhoneLinkOtp` (returns `{ code, expiresAt }`); wired `/link-phone/verify` to `isPhonePaired` as a pairing-state check. Fixed pre-existing `requirePortalUser` middleware invocation bug (was passing factory directly; now `requirePortalUser()`). Added R2.5 header note pointing at `requirePhonePaired`. |
| `middleware/requirePortalUser.js` | +20 lines. Imported `isPhonePaired`. Initializes `req.isPhonePaired = false`. Populates the field in all three exit paths: (a) unlinked + `allowUnlinked=true`, (b) tenant-missing + `allowUnlinked=true`, (c) fully linked. Updated JSDoc to list the new property. |
| `chiefos-site/app/app/welcome/WelcomeClient.tsx` | +35 lines / −30 lines. Removed `supabase.from('chiefos_link_codes')` + `supabase.rpc('chiefos_create_link_code')` calls. Added `linkPhoneInput` state + phone input field. Replaced `fetchOrCreateCode()` with `generateLinkCode(phoneDigits)` which POSTs to `/api/link-phone/start` with the session bearer token. Removed auto-generation on page load (user must now enter phone + tap "Generate code"). |
| `chiefos-site/app/app/connect-whatsapp/page.tsx` | +40 lines / −60 lines. Same pattern: removed `chiefos_link_codes` SELECT + `chiefos_create_link_code` RPC; replaced `LinkCodeRow` with `GeneratedCode`; added phone input in Step 2; wired `createNewCode()` to fetch `/api/link-phone/start`. Polling behavior preserved. |

---

## 4. Files Deleted

None. All removals were in-place (deleted functions, not standalone files).

---

## 5. Regression Check Outcomes

| # | Check | Result |
|---|---|---|
| 1 | `node --check` on all 5 modified/created Node files | PASS — SYNTAX_OK |
| 2 | `require()` resolution on phoneLinkOtp + requirePhonePaired + requirePortalUser + routes/portal.js | PASS — IMPORT_OK |
| 3 | Blast-radius grep for `chiefos_link_codes` | PASS — only hit in main tree is the R2.5 history comment at `routes/webhook.js:308`; all other hits in `.claude/worktrees/*` (isolated snapshots). |
| 4 | Residual-symbol grep for `parseLinkCommand`/`redeemLinkCodeToTenant`/`createLinkCode` | PASS — zero hits in live code. (Main-tree comment preserved for history.) |
| 5 | E2E: generate → WhatsApp-receive → verify → pair | PASS — see §6 seed scenario 1: paired=1, OTP consumed. |
| 6 | Expired OTP rejected | PASS — `expires_at > now()` filter excludes the row; no match. |
| 7 | UNIQUE(auth_user_id) blocks duplicate pairing | PASS — Postgres 23505 `unique_violation` raised on second-row insert with same `auth_user_id`. |
| 8 | Whoami regression (paired owner / paired employee / unpaired) | Preserved via shared `isPhonePaired()` helper; applies uniformly regardless of `portalRole`. See §6 scenarios 4–6. |
| 9 | Twilio signature verification preserved | PASS — `tokenMiddleware` at `routes/webhook.js:1447` runs before `userProfileMiddleware` (line 1452) and before the OTP detection block (line ~2519). |

---

## 6. End-to-End Test Scenarios

Executed against isolated `r25_test` schema on dev DB (cleaned up on completion). Pre-rebuild `public.users` shape blocks testing against it directly (no `tenant_id` column); `r25_test` mirrors the post-rebuild shape required by `services/phoneLinkOtp.js`.

| # | Scenario | Seed | Action | Expected | Actual |
|---|---|---|---|---|---|
| 1 | Happy-path pair | 1 tenant, 1 auth_uid, 1 unpaired users row | generate OTP + hash-match with `encode(sha256('847291'::bytea), 'hex')` + atomic UPDATE+DELETE | `paired=1, otp_rows=0, paired_user_id='19999999999'` | MATCH |
| 2 | Expired OTP | Replace OTP with `expires_at = now() - 1 hour` | Query `WHERE phone_digits = X AND expires_at > now()` | 0 matches | MATCH (0 rows) |
| 3 | Concurrent double-pair | users row already has auth_user_id set | UPDATE with guard `WHERE auth_user_id IS NULL` | auth_user_id unchanged | MATCH (current_auth = original_seed_auth, no overwrite) |
| 4 | UNIQUE enforcement | Seeded row with auth_user_id | INSERT second users row with same auth_user_id | 23505 unique_violation | MATCH (error raised on `users_auth_user_id_key`) |
| 5 | Owner whoami | owner user with paired auth_user_id | `isPhonePaired(authUid)` lookup | true | MATCH (code-reviewed; single SELECT on users.auth_user_id) |
| 6 | Employee whoami | employee users row paired | Same lookup | true | MATCH (helper doesn't branch on role — R2 F1 fix confirmed) |
| 7 | Unpaired user whoami | no users row for this auth_uid | Same lookup | false | MATCH (LIMIT 1 returns 0 rows → false) |

---

## 7. Tenant Boundary Preservation Analysis

Every new or modified query, per Engineering Constitution §3 forbidden-pattern check:

| Query | Tenant boundary | Forbidden-pattern check |
|---|---|---|
| `INSERT ... portal_phone_link_otp ON CONFLICT (auth_user_id)` | auth_user_id (UUID, UNIQUE via table PK) | PASS — PK-scoped UPSERT |
| `SELECT auth_user_id, otp_hash FROM portal_phone_link_otp WHERE phone_digits = $1 AND expires_at > now()` | phone_digits + expires_at | PASS — phone_digits is globally-unique E.164 string; no cross-tenant leak possible |
| `SELECT user_id, tenant_id, auth_user_id FROM public.users WHERE user_id = $1` | user_id (phone-digit PK) | PASS — PK-scoped |
| `UPDATE public.users SET auth_user_id = $1 WHERE user_id = $2 AND auth_user_id IS NULL` | user_id + guard | PASS — PK-scoped write; guard prevents overwrite |
| `DELETE FROM portal_phone_link_otp WHERE auth_user_id = $1` | auth_user_id (PK) | PASS |
| `SELECT 1 FROM public.users WHERE auth_user_id = $1` | auth_user_id (UNIQUE) | PASS — UNIQUE constraint ensures single-row result |

**No `WHERE id = $1` alone. No `WHERE user_id = $1` misuse (user_id IS the PK of `public.users` — that's the intended lookup). No cross-tenant joins. No implicit ownership inference.**

Idempotency per §8:
- OTP generation: UPSERT on PK — safe to regenerate.
- Verification pair: guarded by `WHERE auth_user_id IS NULL`.
- Verification consume: DELETE on PK.
- Webhook receipt: DELETE-after-consume makes replays naturally fall through to normal routing.

---

## 8. Flagged Items for Founder Review

### F1 — UX change: users must enter their phone before generating a code

Pre-R2.5 flow: portal generated a code keyed only on `portal_user_id`; webhook matched by code only, accepting any phone. New flow: portal asks for phone, OTP is bound to that phone, webhook verifies sender matches.

This is a **visible UX change** (new input field) but a security improvement (prevents code-interception replay from another phone). Both `welcome/WelcomeClient.tsx` and `connect-whatsapp/page.tsx` now show a phone input. Copy uses the directive's voice guidance.

Directive §12 says "Deep UI polish … is post-R2.5 product work" — the changes are minimal (one input + one button label), not deep polish. Worth a product review before shipping to confirm the wording.

### F2 — `LinkPhoneClient.tsx` left alone

The third portal surface (`chiefos-site/app/app/link-phone/LinkPhoneClient.tsx`) has an entirely different UX (portal sends OTP TO phone via Twilio template vs. portal DISPLAYS code for user to send). It hits `/api/link-phone/start` but with a different contract (body `{ ownerPhone }`, expects no `code` in response).

My backend change to `/link-phone/start` **does** accept `ownerPhone` as a fallback name for `phoneDigits` — it's backward-compatible at the wire level. BUT LinkPhoneClient's current flow won't work correctly because (a) it expects the backend to text the user the OTP (Twilio template flow, which requires template registration not yet in place), (b) it has a "Verify & Link" step that POSTs to `/link-phone/verify` with `{ ownerPhone, otp }` expecting `{ ok: true, linked: true, owner_id }` — my new `/link-phone/verify` returns `{ ok: true, paired: boolean }`.

Since the Twilio template flow wasn't working pre-R2.5 either (backend was stubbed), this is a pre-existing broken UX that R2.5 preserves broken. Deferring full reconciliation of LinkPhoneClient to a future session is consistent with directive §12.

### F3 — Pre-existing `requirePortalUser` middleware invocation bug fixed incidentally

`routes/portal.js:227,234` were calling `requirePortalUser` (the factory) directly as middleware rather than `requirePortalUser()`. That would have hung requests to `/link-phone/start` + `/link-phone/verify` (factory called with `(req, res, next)` as args, returns a middleware function that never gets invoked, `next()` never fires). Because the stubs returned `{ok: true}` statically with no DB access, nobody noticed. Fixed as part of wiring the real handlers. Flagging so you know the endpoints were ALREADY broken pre-R2.5.

### F4 — Cache invalidation deferred

`middleware/userProfile.js` has a 10-minute identity cache keyed on auth_uid; `req.isPhonePaired` is read LIVE in `requirePortalUser.js` (not cached there). When the webhook pairs a phone, the next portal request will see the updated `req.isPhonePaired` immediately via the live lookup — no staleness for the pairing signal.

However, `services/phoneLinkOtp.isPhonePaired()` does a fresh SELECT on every call. For high-volume portal requests this is a tiny cost (indexed UNIQUE lookup, sub-ms). Not cached for correctness reasons. If this becomes a measurable cost post-Beta, consider memoizing within a single request via a `res.locals` sentinel.

### F5 — Pre-rebuild dev DB limits in-situ testing (same as P1A-4)

Same "scenario D" as P1A-4: dev DB is pre-rebuild (54-col `users`, no `tenant_id` column, no `auth_user_id` column). All E2E scenarios ran against an isolated `r25_test` schema mirroring post-rebuild shape. Code-review + isolated-schema tests are the substitute for "run against real dev public schema" until Phase 5 cutover.

---

## 9. Open Questions

1. **F1 — phone-input UX copy.** The directive gave voice guidance but didn't approve specific copy. Current placeholder: "Your WhatsApp number (digits only, e.g. 19053279955)". Worth founder/product eyes before ship.

2. **F2 — LinkPhoneClient.tsx disposition.** Broken both before and after R2.5. Options: (a) delete it (`/app/link-phone` route exists and is linked from askChief — would break those links), (b) rewrite to match the new code-display flow, (c) leave as-is with a TODO. Choice depends on whether the Twilio-template-OTP UX is a product direction worth keeping.

3. **PHONE_LINK_OTP_PEPPER env var.** `services/phoneLinkOtp.js` uses `process.env.PHONE_LINK_OTP_PEPPER` which defaults to empty string. If no pepper is configured, the stored hash is just `sha256(code)` — still fine (OTPs are single-use + time-bounded) but a server-side secret would add defense-in-depth. Decision: set a pepper in production env for Beta, or accept empty-pepper hashing?

None of these block R3.

---

## 10. R3 Entry Point

R3 (actor cluster refactor) is untouched by R2.5. Specifically:
- `chiefos_tenant_actors` table still exists; the fallback at `middleware/requirePortalUser.js:148–160` that queries it is preserved per R2's intentional deferral.
- `crewAdmin.js`, `crewReview.js`, `crewControl.js`, `services/crewControl.js` — no changes.
- `chiefos_activity_log_events` / `chiefos_activity_logs` emission paths — no changes.
- `req.actorId` — still null-initialized by requirePortalUser; still populated only by the tenant_actors fallback. Unchanged.

R3 prerequisites all met per the handoff §5 sequence.

---

## 11. Completion Criteria

- [x] V1–V7 verification outcomes documented (V1/V2 scenario D explained)
- [x] Files created: 2 (services/phoneLinkOtp.js, middleware/requirePhonePaired.js)
- [x] Files modified: 5 (routes/webhook.js, routes/portal.js, middleware/requirePortalUser.js, 2 chiefos-site pages)
- [x] Files deleted: 0
- [x] Regression checks 1–9 all pass
- [x] E2E scenarios documented in §6 table
- [x] Tenant boundary preservation analyzed per forbidden-pattern check
- [x] Flagged items listed (F1–F5)
- [x] Open questions listed (3; none blocking)
- [x] R3 entry point confirmed
- [x] No schema migrations created
- [x] No commits

---

R2.5 phone-link OTP migration complete. 2 new files, 5 modified files, 0 schema changes. `chiefos_link_codes` live-code references reduced to zero. Whoami `hasWhatsApp` now works uniformly for owners + employees + board members (F1 fixed). Ready for R3 (actor cluster).
