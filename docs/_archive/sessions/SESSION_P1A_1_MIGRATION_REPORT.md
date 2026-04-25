# Session P1A-1 — Migration Authorship Report

**Date:** 2026-04-22
**Scope delivered:** Phase 1 Amendment Session 1 — 5 simple amendment tables.
**Authority:** `PHASE_4_5_DECISIONS_AND_HANDOFF.md` §3 + §8 + §9; Phase 3 Session 3b/3a pattern templates.

---

## 1. Files Produced

**Migrations (3 files, 5 tables):**
- `migrations/2026_04_22_amendment_reminders_and_insight_log.sql` — 2 tables (Gap 1 + Gap 4)
- `migrations/2026_04_22_amendment_pricing_items.sql` — 1 table (Gap 5)
- `migrations/2026_04_22_amendment_documents_flow.sql` — 2 tables (Gap 6)

**Rollbacks (3 files):**
- `migrations/rollbacks/2026_04_22_amendment_reminders_and_insight_log_rollback.sql`
- `migrations/rollbacks/2026_04_22_amendment_pricing_items_rollback.sql`
- `migrations/rollbacks/2026_04_22_amendment_documents_flow_rollback.sql`

**Docs updated:**
- `REBUILD_MIGRATION_MANIFEST.md` — apply-order entries 17a/17b/17c added between step 17 (financial_observability) and step 18 (rebuild_functions); touch-trigger follow-up note appended
- `FOUNDATION_P1_SCHEMA_DESIGN.md` — minimal amendment note appended after Phase 1 Session 3 completion marker

**File grouping rationale:** 3 files instead of 5 — reminders and insight_log share the "notification / signaling" theme and one preflight block. pricing_items stands alone (unique logical scope — owner's rate book). Documents flow bundles job_documents + job_document_files (parent/child FK relationship; shared preflight). Each file has a coherent single-concept header. Rollbacks mirror 1:1.

---

## 2. Per-Table Authoring Notes

### reminders (Gap 1)

Schema matches handoff §3 exactly. Added one CHECK not specified in the spec but implied by the state model: `reminders_sent_cancel_exclusive` — `sent_at` and `cancelled_at` cannot both be set (a reminder is sent OR cancelled, not both).

Three indexes authored:
- Idempotency: partial UNIQUE on `(owner_id, source_msg_id)` WHERE non-null
- Cron due-now: partial on `(tenant_id, due_at)` WHERE sent_at IS NULL AND cancelled_at IS NULL — supports `workers/reminder_dispatch.js` polling
- Per-user upcoming: partial on `(owner_id, user_id, due_at)` WHERE not-yet-fired

RLS: tenant-membership SELECT + UPDATE only. No authenticated INSERT policy — reminders are system-created from task + timeclock handlers via service_role. Authenticated can cancel own-tenant reminders via UPDATE to set `cancelled_at`.

GRANTs: `authenticated = SELECT, UPDATE; service_role = ALL`.

### insight_log (Gap 4)

Schema matches handoff §3. Added `insight_log_ack_pair` CHECK: acknowledged_at and acknowledged_by_portal_user_id must transition together (at least the timestamp; FK may be NULL if the portal user was later deleted — the `ON DELETE SET NULL` handles that).

Dedupe UNIQUE `(tenant_id, signal_kind, signal_key)` prevents duplicate alerts for the same anomaly fingerprint (e.g., `signal_key = 'vendor:HOMEDEPOT:2026-04'` means one alert per Home Depot per month regardless of detector runs).

Composite identity UNIQUE `(id, tenant_id, owner_id)` added per Principle 11 even though no current table FK-references insight_log — future-proofing.

RLS: tenant-membership SELECT + UPDATE. No INSERT for authenticated — anomaly detector runs via service_role. UPDATE gates strictly at RLS level but relies on app-code discipline for column-level restriction (only `acknowledged_at` + `acknowledged_by_portal_user_id` should mutate). **Hard UPDATE-column-restriction trigger deferred to Session P3-4b** per manifest Forward Flag 11 pattern — noted in migration header.

GRANTs: `authenticated = SELECT, UPDATE; service_role = SELECT, INSERT, UPDATE` (append-only — no DELETE for service_role).

### pricing_items (Gap 5)

Schema matches handoff §3 with one augmentation: `source` column added with CHECK (`'whatsapp' | 'portal' | 'api'`) for origin tracking (the WhatsApp "add pricing" command needs to be distinguishable from portal-created items for later analytics). Not specified in handoff §3 but consistent with other CIL-captured tables' pattern.

Composite UNIQUE `(id, tenant_id, owner_id)` is load-bearing: Phase B's `chiefos_quote_line_items.source_ref_id` polymorphic reference (deferred per handoff §8 Schema Evolution note) will target this UNIQUE when line-item source_type work lands. Establishing the constraint now means Phase B's FK addition is a pure ALTER with no schema reshuffle.

Soft-archive pattern: partial UNIQUE on `(owner_id, lower(name))` WHERE `active = true` — permits name re-use after archive. No DELETE policy for authenticated; DELETE reserved for service_role.

GRANTs: `authenticated = SELECT, INSERT, UPDATE; service_role = ALL`.

### job_documents (Gap 6, part 1)

Schema matches handoff §8 with one material design choice: `job_id` is `integer` (not `uuid` as §8 wrote). **Design-doc drift corrected to match code reality:** `public.jobs.id` is `serial` (integer) per P1 §3.3; the handoff's `uuid` was a typo. FK target type must match — same drift-correction Session P3-2a applied to `time_entries_v2.job_id`, `tasks.job_id`, `mileage_logs.job_id`. Flagged below.

Composite FK to jobs is `(job_id, tenant_id, owner_id) → jobs(id, tenant_id, owner_id)` per Principle 11; `ON DELETE SET NULL` preserves lead-stage rows if the job is later deleted. Same pattern for customers composite FK (both nullable for lead-stage rows that haven't been linked yet).

Partial UNIQUE `(tenant_id, job_id)` WHERE job_id IS NOT NULL — one pipeline row per job. This matches the portal upsert pattern in `chiefos-site/app/app/jobs/[jobId]/page.tsx:448` (`ensureJobDoc` helper).

GRANTs: `authenticated = SELECT, INSERT, UPDATE; service_role = ALL`.

### job_document_files (Gap 6, part 2) — most complex

Schema matches handoff §8 with two additions:
- `job_id integer` added (convenient for query-by-job; FK composite to jobs with `ON DELETE SET NULL`). The production live schema has this; handoff §8 omitted it.
- `sent_via text` added with CHECK (`'email' | 'whatsapp' | 'portal'`). Production has this; tracks delivery channel.

Signed-state consistency enforced via two CHECKs:
- `signed_pair` — signature_data + signed_at move together
- `token_cleared_on_sign` — once signed, signature_token MUST be NULL (enforces single-use)

**Non-standard anon signing RLS — most careful part of this session.**

Anon role gets TWO policies, both gated strictly:

```sql
CREATE POLICY job_document_files_anon_sign_select
  ON public.job_document_files FOR SELECT
  TO anon
  USING (
    signature_token IS NOT NULL
    AND signed_at IS NULL
    AND (signed_url_expires_at IS NULL OR signed_url_expires_at > now())
  );

CREATE POLICY job_document_files_anon_sign_update
  ON public.job_document_files FOR UPDATE
  TO anon
  USING (<same predicate as above>)
  WITH CHECK (
    signature_data IS NOT NULL
    AND signed_at IS NOT NULL
  );
```

The `TO anon` role clause is critical — without it the policy would apply to every role. With it, authenticated users don't match the policy (they match the tenant-membership policy instead).

The WITH CHECK on the UPDATE enforces the transition shape: when anon updates, they MUST be setting both signature_data and signed_at. Combined with the `token_cleared_on_sign` CHECK (which rejects any row where signed_at is set but signature_token is not NULL), the signing flow is atomic at the DB layer: either a successful transition from (token, unsigned) → (NULL, signed) happens, or nothing happens.

Security posture — token entropy: the token is generated app-side via `crypto.randomUUID()` (122 bits). Same posture as `chiefos_quote_share_tokens.token` which uses base58(16 random bytes) (128 bits). Acceptable.

Partial UNIQUE on `signature_token` WHERE non-null ensures global uniqueness of live tokens (collisions astronomically unlikely with 122-bit entropy, but the UNIQUE makes them impossible by construction).

GRANTs: `anon = SELECT, UPDATE; authenticated = SELECT, INSERT, UPDATE; service_role = ALL`.

Five secondary indexes: tenant-membership reads, per-parent document, per-kind listings, signature-token lookup (the hot path for /sign/[token] — partial unique index serves this directly), pending-signature cron queries.

---

## 3. RLS Summary

| Table | authenticated verbs | anon verbs | service_role verbs | Policies |
|---|---|---|---|---|
| reminders | SELECT, UPDATE | — | ALL | 2 (select + update) |
| insight_log | SELECT, UPDATE | — | SELECT, INSERT, UPDATE | 2 (select + update) |
| pricing_items | SELECT, INSERT, UPDATE | — | ALL | 3 (select + insert + update) |
| job_documents | SELECT, INSERT, UPDATE | — | ALL | 3 (select + insert + update) |
| job_document_files | SELECT, INSERT, UPDATE | SELECT, UPDATE | ALL | 5 (3 tenant + 2 anon sign) |

Total: **5 tables, 15 policies** (13 tenant-membership + 2 anon signing).

**RLS enabled on all 5 tables.**

---

## 4. Manifest Update Summary

**Insertion point:** between step 17 (`rebuild_financial_observability`) and step 18 (`rebuild_functions`). Numbered 17a, 17b, 17c:

- 17a — `amendment_reminders_and_insight_log`
- 17b — `amendment_pricing_items`
- 17c — `amendment_documents_flow`

This places amendments after all Phase 3 table creation but before Phase 3 Session 4a's functions/triggers/views. P3-4a's touch-trigger bindings need extension to cover the 5 amendment tables — flagged in the manifest with the "Phase 1 amendment tables' touch triggers" note.

**Forward-dependency flag on touch triggers:** 5 amendment tables have `updated_at` columns. Until P3-4a extension ships, app code must set `updated_at = now()` explicitly on UPDATEs. This is a follow-up session item for R1 (remediation session 1) or sooner.

---

## 5. Flagged Items for Founder Review

1. **job_id type drift in handoff §8.** Handoff said `job_id uuid NULL` for job_documents; production (and P1 §3.3) uses `integer` (serial). Migration authored with `integer` to match. **Recommendation:** correct §8 in handoff (or add a note) to avoid confusion; no migration change needed.

2. **Additional columns on job_document_files (`job_id`, `sent_via`).** Production live schema has both; handoff §8 omitted them. Migration authored with both present (defensive — matches prod shape). **No action needed;** surfacing for transparency.

3. **Additional column on pricing_items (`source`).** Handoff §3 didn't specify a source column; added for consistency with every other CIL-capturable table. Format CHECK (`'whatsapp'|'portal'|'api'`). **Low risk;** surfacing for transparency.

4. **insight_log column-level UPDATE restriction.** RLS allows UPDATE broadly; app-code must restrict to `acknowledged_at` + `acknowledged_by_portal_user_id` only. Hard trigger for defense-in-depth is Session P3-4b scope per manifest Forward Flag 11. **Acceptable;** documented in migration header.

5. **Touch-trigger bindings for all 5 tables deferred to follow-up session.** Non-blocking for cutover if app code sets `updated_at = now()` explicitly (it already does in most services per Phase 4 audit). **Acceptable;** documented in manifest forward note.

6. **Anon signing RLS — operational caveat.** The two anon policies on job_document_files grant unauthenticated UPDATE capability strictly gated by a cryptographically-random token + unsigned state + non-expiry. Mirrors the Quotes spine's `chiefos_quote_share_tokens` pattern. **Policy shape reviewed in detail in §2 above.** Recommend verification in a staging env with a real token-signing flow before Phase 5 cutover.

---

## 6. Readiness for Session P1A-2

**Blocked on:** nothing.

**P1A-2 scope (supplier catalog §3.13 — 7 tables):**
- `suppliers`, `supplier_users`, `supplier_categories`, `catalog_products`, `catalog_price_history`, `catalog_ingestion_log`, `tenant_supplier_preferences`
- Non-standard RLS (supplier-portal auth via `auth.users` directly, not `chiefos_portal_users` membership)
- Plan-gated contractor reads (Starter+ plan CHECK)
- GLOBAL-vs-tenant scoping on `suppliers` (handoff §8 flags this as resolved-in-P1A-2)

**P1A-3 scope (RAG §3.14 — 4 tables):**
- `docs`, `doc_chunks`, `rag_terms`, `tenant_knowledge`
- pgvector extension preflight
- GLOBAL-vs-tenant pattern (tenant_id NULL + owner_id='GLOBAL')

After P1A-3: Phase 1 amendments complete. R1 (remediation session 1) begins, starting with the 5 DELETE-SAFELY files + 9 KPI-cluster files confirmed in Phase 4.5b.

---

## 7. File Inventory

**Created in P1A-1:**
```
migrations/2026_04_22_amendment_reminders_and_insight_log.sql
migrations/2026_04_22_amendment_pricing_items.sql
migrations/2026_04_22_amendment_documents_flow.sql
migrations/rollbacks/2026_04_22_amendment_reminders_and_insight_log_rollback.sql
migrations/rollbacks/2026_04_22_amendment_pricing_items_rollback.sql
migrations/rollbacks/2026_04_22_amendment_documents_flow_rollback.sql
SESSION_P1A_1_MIGRATION_REPORT.md
```

**Updated in P1A-1:**
```
REBUILD_MIGRATION_MANIFEST.md       (entries 17a/17b/17c + touch-trigger note)
FOUNDATION_P1_SCHEMA_DESIGN.md      (minimal amendment note appended)
```

**Untouched:**
- All Phase 3 migrations (no existing migration modified)
- All app code
- `PHASE_4_5_DECISIONS_AND_HANDOFF.md` (read-only reference)

---

Phase 1 Amendment Session P1A-1 complete. 5 simple amendment tables authored. Ready for Session P1A-2 (Supplier Catalog §3.13).
