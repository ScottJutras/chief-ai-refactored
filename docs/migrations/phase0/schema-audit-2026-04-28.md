# Schema Audit — Business State Fields
**Date:** 2026-04-28
**Spec reference:** docs/ChiefOS_Trial_Architecture_Spec_v1.1.md §4
**Auditor:** Phase 0 Explore agent

## Summary

| Field | Schema locations | Canonical source | Drift detected? | Consolidation needed? |
|---|---|---|---|---|
| business_name | `public.chiefos_tenants.name` | `public.chiefos_tenants.name` | No | No |
| timezone | `public.chiefos_tenants.tz` + `public.users.tz` | `public.chiefos_tenants.tz` | Minor | Yes — deprecate `users.tz` |
| tax_region | `public.chiefos_tenants.{country, province, tax_code, region}` | Split across 4 columns | Yes — schema design | Yes — consolidate to single identifier |
| paid_breaks_policy | None — field missing entirely | Not implemented | Critical | Yes — requires migration + design |
| phone_number | Not stored; derived as `public.chiefos_tenants.owner_id` | Distributed (auth.users + owner_id) | Critical — lossy storage | Yes — add `phone_e164` column |
| email | `public.users.email` + `auth.users.email` | Split between schema and auth | Yes — dual sources + portal.js bug | Yes — consolidate + fix portal.js query |

## Per-field findings

### business_name

**Schema locations:**
- `public.chiefos_tenants.name` (text NOT NULL) — defined in `migrations/2026_04_21_rebuild_identity_tenancy.sql:54`

**Write paths:**
- `migrations/2026_04_29_amendment_p1a7_chiefos_finish_signup_rpc.sql:196-201` — RPC `chiefos_finish_signup()` writes `chiefos_tenants.name` from `auth.users.raw_user_meta_data->>'company_name'`

**Read paths:**
- Portal tenant context queries read from `public.chiefos_tenants`
- `src/config/tenantProfiles.js:36-60` — temporary bootstrap config (not relational schema; for quotes rendering)

**Canonical source:** `public.chiefos_tenants.name`

**Drift:** None.

**Consolidation needed:** No.

---

### timezone

**Schema locations:**
- `public.chiefos_tenants.tz` (text NOT NULL DEFAULT 'America/Toronto') — `migrations/2026_04_21_rebuild_identity_tenancy.sql:55`
- `public.users.tz` (text, nullable) — `migrations/2026_04_21_rebuild_identity_tenancy.sql:119`

**Write paths:**
- Signup RPC does not explicitly write `tz`; defaults to `chiefos_tenants.tz` default
- No active write paths to `users.tz` found

**Read paths:**
- `public.chiefos_tenants.tz` — primary (tenant-level context)
- `public.users.tz` — legacy column; no active read paths found

**Canonical source:** `public.chiefos_tenants.tz`

**Drift:** Minor — `users.tz` is a legacy duplicate column.

**Consolidation needed:** Yes — `users.tz` should be deprecated and eventually removed after confirming no legacy code reads it.

---

### tax_region

**Schema locations:**
- `public.chiefos_tenants.tax_code` (text NOT NULL DEFAULT 'NO_SALES_TAX') — `migrations/2026_04_21_rebuild_identity_tenancy.sql:59`
- `public.chiefos_tenants.region` (text, nullable) — `migrations/2026_04_21_rebuild_identity_tenancy.sql:60`
- `public.chiefos_tenants.country` (text NOT NULL DEFAULT 'CA') — `migrations/2026_04_21_rebuild_identity_tenancy.sql:56`
- `public.chiefos_tenants.province` (text, nullable) — `migrations/2026_04_21_rebuild_identity_tenancy.sql:57`

**Write paths:**
- `migrations/2026_04_29_amendment_p1a7_chiefos_finish_signup_rpc.sql:196-202` — RPC writes `country` and `province` from auth metadata; `tax_code` and `region` left to defaults

**Read paths:**
- Multiple columns read independently for locale/jurisdiction context
- `tax_code` consumed by financial export flows (implied by column presence)
- `region` appears unused (no active read paths found)

**Canonical source:** `public.chiefos_tenants.{country, province, tax_code, region}` — dispersed across 4 columns

**Drift:** Yes — spec expects `tax_region` as single field (e.g., "CA-ON"); schema uses 4 separate columns.

**Consolidation needed:** Yes — add migration to either (A) create computed view/helper for "CA-ON" format, (B) add dedicated `tax_region` column, or (C) document 4-column pattern as canonical. Option A recommended (least intrusive).

---

### paid_breaks_policy

**Schema locations:**
- **None.** Field does not exist in any table.

**Write paths:**
- None found.

**Read paths:**
- None found.

**Canonical source:** Not defined.

**Drift:** Critical — field is entirely unimplemented.

**Consolidation needed:** Yes — requires migration to add column (recommend `public.chiefos_tenants.paid_breaks_policy TEXT DEFAULT 'unpaid' CHECK (paid_breaks_policy IN ('paid', 'unpaid'))`), update signup RPC to capture and persist, and implement onboarding UI integration per spec §14.2.

---

### phone_number

**Schema locations:**
- **No phone_number column anywhere.** Full phone is not persisted in ChiefOS schema post-signup.
- `public.chiefos_tenants.owner_id` (text, digits-only) — `migrations/2026_04_21_rebuild_identity_tenancy.sql:53` — derived from phone (lossy; digits only, no country code or formatting)
- `public.portal_phone_link_otp.phone_digits` (text, digits-only) — `migrations/2026_04_21_rebuild_identity_tenancy.sql:401` — temporary OTP pairing table; stores digits not E.164 format

**Write paths:**
- Phone comes from `auth.users.raw_user_meta_data.owner_phone` at signup (`migrations/2026_04_29_amendment_p1a7_chiefos_finish_signup_rpc.sql:158, 173`)
- RPC **extracts digits** to derive `owner_id`, but **does not persist the original phone** in `chiefos_tenants` or `users`

**Read paths:**
- `public.chiefos_tenants.owner_id` — read for tenant identification, but this is derived (lossy)
- Reverse lookup requires hitting `auth.users` or external Twilio/WhatsApp state

**Canonical source:** Distributed — no single relational source in ChiefOS. Original phone lives in:
1. `auth.users.raw_user_meta_data` (at signup only; not persisted post-signup)
2. `auth.users.phone` (if Supabase phone verification is configured; external to ChiefOS)
3. Derived as `owner_id` (lossy — digits only)

**Drift:** Critical — spec expects phone as "canonical source for owner_id derivation," implying bidirectional lookup. Current schema only supports forward (phone → owner_id), not reverse (owner_id → phone).

**Consolidation needed:** Yes — add migration to store E.164-formatted phone:
```sql
ALTER TABLE public.chiefos_tenants ADD COLUMN phone_e164 TEXT;
ALTER TABLE public.chiefos_tenants ADD CONSTRAINT chiefos_tenants_phone_e164_format
  CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+\d{7,}$');
CREATE UNIQUE INDEX chiefos_tenants_phone_e164_unique_idx
  ON public.chiefos_tenants (phone_e164) WHERE phone_e164 IS NOT NULL;
```
Update amendment P1A-7 RPC to persist `phone_e164` from auth metadata. This unblocks spec §9 (WhatsApp matching) and §7 (lifecycle state transitions).

---

### email

**Schema locations:**
- `public.users.email` (text, nullable) — `migrations/2026_04_21_rebuild_identity_tenancy.sql:116`
- `auth.users.email` (Supabase managed; external to audit scope but referenced in RPC)
- No `public.chiefos_tenants.email` or `public.chiefos_portal_users.email` columns

**Write paths:**
- `migrations/2026_04_29_amendment_p1a7_chiefos_finish_signup_rpc.sql:153-156, 229` — RPC reads `auth.users.email` and writes to `public.users.email` once at signup

**Read paths:**
- `public.users.email` — read for portal profile + Stripe context
- `routes/portal.js:132-146` — **BUG**: queries `chiefos_portal_users.email` (column does not exist; table only has `user_id, tenant_id, role, can_insert_financials`). Query returns NULL always.
- `auth.users.email` — read implicitly by Supabase auth for password reset, magic links, etc.

**Canonical source:** Ambiguous — split between:
- Auth provider (`auth.users.email`) for login/recovery
- ChiefOS schema (`public.users.email`) for business context (written once at signup)

**Drift:** Yes — (1) dual sources with different update cadences; (2) portal.js has live bug reading from non-existent column.

**Consolidation needed:** Yes — two actions:
1. Fix portal.js bug: change query from `chiefos_portal_users` to `public.users` to correctly retrieve email (line 132-146).
2. Document: `public.users.email` is canonical for ChiefOS business context (Stripe, portal); `auth.users.email` is for auth provider. If business email (distinct from owner personal email) is needed, add new column `chiefos_tenants.business_email`.

---

## Cross-cutting findings

1. **Phone-number gap is a phase blocker.** The trial spec (§7.2, §9.3) assumes account lookup by phone (landing page form capture, WhatsApp inbound matching). Current schema does not support reverse lookups (owner_id → phone). The fix (add `phone_e164` column) is straightforward and must be done before Phase 1.

2. **Dual-boundary identity model is correctly enforced** (tenant_id ≠ owner_id ≠ user_id separation maintained throughout). No collapse detected.

3. **`paid_breaks_policy` is entirely missing** and is referenced in spec §4.1 and §14.2 (portal onboarding wizard). This is a prerequisite for onboarding flow implementation.

4. **Business state configuration is partially external:** `src/config/tenantProfiles.js` holds quote-rendering metadata (legal_name, brand_name, address, phone, email, web, HST registration) that do not exist in the relational schema. This is intentionally temporary per file header (§20 migration path to DB-backed table when quotes ship). No immediate issue, but this should be on the Phase 1 design agenda for de-duplication.

5. **RLS policies are consistently applied.** All business-state tables correctly restrict portal access via tenant_id membership.

---

## Recommendations for Phase 1

1. **CRITICAL — Phone storage (blocks §9 acquisition flow):**
   - Create `2026_04_30_add_phone_storage.sql` to add `phone_e164` to `chiefos_tenants`
   - Update amendment P1A-7 to populate `phone_e164` from auth metadata
   - Add index + UNIQUE constraint per findings above
   - Implement read path: query by phone for Twilio webhook matching

2. **HIGH — Implement paid_breaks_policy (blocks §14 onboarding):**
   - Add column to `chiefos_tenants`
   - Update signup RPC to persist from auth metadata
   - Implement portal UI for onboarding wizard capture

3. **MEDIUM — Consolidate tax_region:**
   - Choose design (computed view vs dedicated column vs document 4-column pattern)
   - Update or clarify startup/onboarding flows if needed

4. **MEDIUM — Fix portal.js email query (bug fix):**
   - `routes/portal.js:132-146` — read from `users` not `chiefos_portal_users`

5. **LOW — Deprecate `users.tz`:**
   - Audit for active read paths; if none found, document as deprecated

---

## Confidence

**High.** All schema tables fully read. Migration files comprehensively audited. Signup RPC examined end-to-end. Portal routes spot-checked. No hidden duplicate columns believed to exist.

**Exclusions:** Crew cluster and actor-memory cluster quarantined per CLAUDE.md; not audited per rebuild protocol.
