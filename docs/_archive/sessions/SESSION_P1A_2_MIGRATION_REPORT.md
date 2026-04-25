# Session P1A-2 — Migration Authorship Report

**Date:** 2026-04-22
**Scope delivered:** Phase 1 Amendment Session 2 — 7 supplier catalog tables across 3 migration files.
**Authority:** `PHASE_4_5_DECISIONS_AND_HANDOFF.md` §8 Gap 2; live production schema at `xnmsjdummnnistzcxrtj.public.*` (authoritative for detailed column shapes per P1A-1 drift-correction precedent).

---

## 1. Production Schema Introspection Findings

Ran catalog queries against live Supabase dev DB for all 7 tables. Key findings that shape authoring:

### suppliers
- **No `tenant_id` column.** Confirms Decision A: fully GLOBAL. All suppliers visible to all contractor tenants.
- Rich column set: slug UNIQUE, name, description, public_description, website_url, logo_storage_key, contact_email, primary_contact_{name,email,phone}, company_phone, company_address, city, region (default 'canada'), supplier_type (default 'manufacturer'), catalog_update_cadence (default 'quarterly'), status (default 'active'), is_active, onboarding_completed, approved_at, approved_by (text, not uuid FK), created_at, updated_at.

### supplier_users
- `auth_uid uuid NOT NULL` — production lacks FK to auth.users. **Rebuild adds FK** for referential integrity (handoff §8 intent preserved).
- **UNIQUE (auth_uid)** — one auth user belongs to exactly one supplier.
- `role text NOT NULL DEFAULT 'owner'` — no production CHECK; rebuild adds CHECK (`owner`/`admin`/`editor`).

### supplier_categories
- Self-FK `parent_category_id → supplier_categories(id)`.
- UNIQUE (supplier_id, slug) — slug scoped to supplier.
- sort_order + is_active for hierarchical browsing.

### catalog_products
- **`unit_price_cents integer`** (not bigint) — matches production. Max ~$21M per line item is adequate.
- `price_type text DEFAULT 'list'` — rebuild adds CHECK (`list`/`contractor`/`distributor`/`promo`).
- `price_effective_date date NOT NULL`, `price_expires_date date NULL`, `min_order_quantity integer DEFAULT 1`.
- `discontinued_at timestamptz NULL` paired with `is_active boolean`.
- `metadata jsonb DEFAULT '{}'::jsonb`.
- UNIQUE (supplier_id, sku).

### catalog_price_history
- Append-only: no updated_at column.
- `old_price_cents integer NULL` (first-record rows have no prior), `new_price_cents integer NOT NULL`.
- `change_source text NOT NULL` — rebuild adds CHECK (`manual`/`ingestion`/`api`/`migration`).

### catalog_ingestion_log
- Append-only: no updated_at.
- Rich counter set: products_added, products_updated, products_discontinued, prices_changed, errors.
- `error_details jsonb DEFAULT '[]'::jsonb`.
- `status text DEFAULT 'pending'` — rebuild adds CHECK.

### tenant_supplier_preferences
- **Production lacks FK on `tenant_id`.** Rebuild adds FK to chiefos_tenants.
- **`is_preferred boolean`** (not 3-way enum as handoff §3 speculated). Corrects handoff assumption.
- `discount_percentage integer DEFAULT 0` — rebuild adds CHECK (0-100).
- **No `owner_id` column** — tenant-only scope (preferences are a tenant-level business decision).
- UNIQUE (tenant_id, supplier_id).

---

## 2. Files Produced

**Migrations (3 files, 7 tables):**
- `migrations/2026_04_22_amendment_supplier_catalog_root.sql` — suppliers + supplier_users + supplier_categories (identity/structure root)
- `migrations/2026_04_22_amendment_supplier_catalog_products.sql` — catalog_products + catalog_price_history + catalog_ingestion_log (products + append-only history + ingestion audit)
- `migrations/2026_04_22_amendment_tenant_supplier_preferences.sql` — tenant_supplier_preferences (tenant-scoped opt-in)

**Rollbacks (3 files):**
- `migrations/rollbacks/2026_04_22_amendment_supplier_catalog_root_rollback.sql`
- `migrations/rollbacks/2026_04_22_amendment_supplier_catalog_products_rollback.sql`
- `migrations/rollbacks/2026_04_22_amendment_tenant_supplier_preferences_rollback.sql`

**Docs updated:**
- `REBUILD_MIGRATION_MANIFEST.md` — apply-order entries 17d/17e/17f; session-history entry; touch-trigger note extended to cover 11 amendment tables (5 from P1A-1 + 6 from P1A-2) + 8 append-only tables for P3-4c.
- `FOUNDATION_P1_SCHEMA_DESIGN.md` — new §3.13 Supplier Catalog section with full per-table design pages (3.13.1 through 3.13.7). Updated Phase 4.5/4.5b amendment note to point to §3.13 for Gap 2.

---

## 3. Per-Table Authoring Notes

### suppliers — fully GLOBAL
Schema matches production + CHECK constraints added (`status`, `supplier_type`, `catalog_update_cadence`, `region`, `slug format`). Note: production has NO `tenant_id`, confirming Decision A. No composite `(id, tenant_id, owner_id)` UNIQUE — not applicable to GLOBAL tables; `id` alone (PK) is sufficient.

Three RLS policies:
- `suppliers_authenticated_select_active` — any authenticated user SELECTs active suppliers. Plan-gating (Starter+) is applied at the route layer (Decision C), not RLS.
- `suppliers_supplier_portal_select` — supplier-portal users SELECT their own row regardless of status.
- `suppliers_supplier_portal_update` — supplier owner/admin UPDATEs own row.

INSERT/DELETE: service_role only (admin approval flow at route layer).

### supplier_users — parallel auth surface
FK `auth_uid → auth.users(id) ON DELETE CASCADE` added (production lacked this FK — rebuild tightens).

Three RLS policies:
- `supplier_users_self_select` — user sees own membership.
- `supplier_users_co_supplier_select` — co-supplier team members see each other.
- `supplier_users_self_update` — user updates own profile (name/email touch, last_login_at).

INSERT (team-member add) + DELETE: service_role only for this rebuild — supplier owner adding team members flows through a route-layer endpoint with admin-email or supplier-owner validation.

### supplier_categories — hierarchical
Self-FK `parent_category_id → supplier_categories(id) ON DELETE SET NULL`. Two indexes: supplier-scoped active browsing, parent-child traversal. CRUD policies all supplier-portal-scoped via supplier_users membership; DELETE requires owner/admin role.

### catalog_products — GLOBAL with plan gate at route
`unit_price_cents integer` preserved. Added CHECKs: price_type enum, min_order_quantity positive, price_expires_date ≥ price_effective_date, discontinued_at requires is_active=false.

Five RLS policies:
- `catalog_products_authenticated_select_active` — contractor read (plan-gated at route).
- `catalog_products_supplier_portal_select` — supplier-portal SELECTs all own products (including inactive).
- `catalog_products_supplier_portal_insert/update/delete` — supplier-portal CRUD.

Delete requires owner/admin role.

### catalog_price_history — append-only (Decision E)
Two SELECT policies (contractor read for active suppliers; supplier-portal read own). **No INSERT/UPDATE/DELETE policies** — append-only enforced by GRANT posture:
- authenticated = SELECT only
- service_role = SELECT + INSERT only (no UPDATE/DELETE even for service_role)

Hard column-restriction trigger (blocking ANY UPDATE + blocking DELETE entirely) deferred to **Session P3-4c** alongside the other 7 append-only tables identified in P3-4a. Until P3-4c, the append-only guarantee is GRANT-posture-only.

### catalog_ingestion_log — supplier-side audit
One SELECT policy (supplier-portal own-history only). Not visible to contractor portal. INSERT/UPDATE service_role only (ingestion pipeline writes).

### tenant_supplier_preferences — tenant-scoped (contractor side)
Only tenant-scoped table in the cluster. FK to chiefos_tenants added (production gap closed). Four policies:
- `tenant_supplier_preferences_tenant_select` — standard tenant membership.
- `_owner_board_insert/update/delete` — role-gated (preferences = tenant-level decision, not per-owner).

---

## 4. RLS Policy Summary

Total: **18 policies** across 7 tables.

| Table | authenticated verbs | Policies |
|---|---|---|
| suppliers | SELECT, UPDATE | 3 (authenticated SELECT active; supplier-portal SELECT/UPDATE own) |
| supplier_users | SELECT, UPDATE | 3 (self SELECT; co-supplier SELECT; self UPDATE) |
| supplier_categories | SELECT, INSERT, UPDATE, DELETE | 4 (authenticated SELECT active; supplier-portal CRUD; DELETE role-gated) |
| catalog_products | SELECT, INSERT, UPDATE, DELETE | 5 (contractor SELECT active; supplier-portal SELECT/INSERT/UPDATE/DELETE) |
| catalog_price_history | SELECT only (no INSERT/UPDATE/DELETE policies) | 2 (contractor SELECT; supplier-portal SELECT own) |
| catalog_ingestion_log | SELECT only | 1 (supplier-portal SELECT own) |
| tenant_supplier_preferences | SELECT, INSERT, UPDATE, DELETE | 4 (tenant SELECT; owner/board CRUD) |

**Non-standard patterns preserved:**
- Supplier-portal auth uses `supplier_users.auth_uid = auth.uid()` subquery (NOT `chiefos_portal_users` membership)
- GLOBAL suppliers visible to all authenticated users (plan gate at route)
- Append-only `catalog_price_history` by GRANT posture

---

## 5. Manifest Update Summary

**Apply-order additions (after P1A-1's 17a/17b/17c):**
- 17d — `amendment_supplier_catalog_root`
- 17e — `amendment_supplier_catalog_products`
- 17f — `amendment_tenant_supplier_preferences`

**Forward-dependency flags updated:**
- Touch-trigger bindings now total **11 amendment tables** (5 P1A-1 + 6 P1A-2). Append-only tables for P3-4c expand from 7 to **8** (adding `catalog_price_history`).
- Session P3-4c now has a clear scope: 11 touch-trigger bindings + 8 append-only column-restriction triggers + `insight_log` column restriction = ~20 triggers total.

---

## 6. Design Document Update Summary

Authored new **§3.13 Supplier Catalog** section in `FOUNDATION_P1_SCHEMA_DESIGN.md` covering:
- Why the catalog matters (Quotes line-items, Ask Chief catalog_lookup, channel-partner GTM)
- Five design decisions (A-E) resolved during P1A-2 authoring
- Per-table design pages §3.13.1 through §3.13.7

Total addition: ~60 lines of structured documentation. Treats the cluster as a first-class design section consistent with §3.1–§3.12.

---

## 7. Flagged Items for Founder Review

1. **FK addition on `supplier_users.auth_uid → auth.users(id)`.** Production lacks this FK; rebuild tightens referential integrity. **Decision taken during authoring** (matches handoff §8 intent). Non-breaking — any orphaned production rows would have been broken anyway. **Recommendation: accept.**

2. **FK addition on `tenant_supplier_preferences.tenant_id → chiefos_tenants(id)`.** Same pattern — production gap closed. **Recommendation: accept.**

3. **`tenant_supplier_preferences.is_preferred boolean`** (not 3-way enum). Corrects handoff §3 assumption. **Production shape was correct; handoff §3 had a minor spec drift.** Documented in §3.13.7; no other downstream effect.

4. **Role enum tightening on `supplier_users.role`.** Production has `text DEFAULT 'owner'` with no CHECK. Rebuild adds `CHECK (role IN ('owner','admin','editor'))`. Could reject existing production rows if any have a role outside this set — **worth spot-checking production data before cutover** (query: `SELECT DISTINCT role FROM public.supplier_users`). If production has other values, widen the CHECK or migrate those rows pre-cutover.

5. **Plan-gating stays at route layer, not RLS.** Decision C preserves production posture. Alternative (RLS-layer plan gate) would require every `catalog_products_authenticated_select_active` and `suppliers_authenticated_select_active` policy to join through `chiefos_portal_users` → `users.plan_key`. Complexity not justified when `requireCatalogAccess` middleware already exists. **Flagged for founder awareness** — if future "free plan can browse for upgrade-prompting" is desired, RLS stays permissive (only status=active check) and route layer handles plan-specific UX.

6. **Admin approval flow (supplier `status='pending' → 'active'`)** uses service_role via route-layer email check (`CHIEFOS_ADMIN_EMAIL`). No admin-role RLS. **Consistent with production.** Post-cutover, if multi-admin support becomes needed, an explicit admin role in RLS can be added without breaking existing flow.

7. **Append-only `catalog_price_history` via GRANT posture, hard trigger deferred to P3-4c.** Same pattern as 7 other P3-4a append-only tables. **Accepted.**

---

## 8. Readiness for Session P1A-3

**Blocked on:** nothing.

**P1A-3 scope (RAG Knowledge §3.14 — 4 tables):**
- `docs`, `doc_chunks`, `rag_terms`, `tenant_knowledge`
- **Critical infrastructure:** pgvector extension preflight (ensure `CREATE EXTENSION IF NOT EXISTS vector`)
- **Special indexing:** tsvector GIN on `doc_chunks.content` (keyword RAG); pgvector ivfflat or hnsw on `doc_chunks.embedding` (semantic RAG — embedding dim 1536)
- **GLOBAL-vs-tenant pattern:** `tenant_id uuid NULL` + `owner_id text DEFAULT 'GLOBAL'` pattern for system-wide SOPs vs tenant-specific docs
- **RLS:** `tenant_id match OR tenant_id IS NULL` visibility

After P1A-3: Phase 1 amendments complete. 12-16 amendment tables total across 3 sessions (5 + 7 + 4). Then **Session P3-4c** authors touch-trigger extensions + append-only column-restriction triggers for all amendment + previously-flagged append-only tables. Then remediation R1-R9.

---

## 9. File Inventory

**Created in P1A-2:**
```
migrations/2026_04_22_amendment_supplier_catalog_root.sql
migrations/2026_04_22_amendment_supplier_catalog_products.sql
migrations/2026_04_22_amendment_tenant_supplier_preferences.sql
migrations/rollbacks/2026_04_22_amendment_supplier_catalog_root_rollback.sql
migrations/rollbacks/2026_04_22_amendment_supplier_catalog_products_rollback.sql
migrations/rollbacks/2026_04_22_amendment_tenant_supplier_preferences_rollback.sql
SESSION_P1A_2_MIGRATION_REPORT.md
```

**Updated in P1A-2:**
```
REBUILD_MIGRATION_MANIFEST.md       (17d/17e/17f entries + forward-dep flag)
FOUNDATION_P1_SCHEMA_DESIGN.md      (§3.13 Supplier Catalog added; 7 design pages)
```

**Untouched:**
- All Phase 3 migrations
- P1A-1 amendments
- `PHASE_4_5_DECISIONS_AND_HANDOFF.md`
- All app code

---

Phase 1 Amendment Session P1A-2 complete. 7 supplier catalog tables authored. Ready for Session P1A-3 (RAG Knowledge §3.14).
