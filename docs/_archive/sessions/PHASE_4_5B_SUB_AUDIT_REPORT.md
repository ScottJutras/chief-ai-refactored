# Phase 4.5b — Sub-Audit Report (Q5 + Q6)

**Date:** 2026-04-22
**Scope:** Definitive answers to two unresolved questions from Phase 4.5 via targeted code tracing. File:line evidence only — no speculation.
**Questions:**
- Q5 — Is the `/app/documents/**` + `/sign/[token]` flow pre-Quotes-spine legacy or a distinct active feature?
- Q6 — Which KPI-cluster files are ACTIVE (consumed by live graphs) vs ORPHANED?

---

## Executive Summary

- **Q5 verdict: MIXED — with a critical twist.** The `job_documents` + `job_document_files` flow is **the only active quote/contract/CO lifecycle UI in the portal.** The Quotes spine exists in the database and has WhatsApp CIL handlers, but **zero chiefos-site portal code consumes any `chiefos_quote_*` table.** Deleting the documents flow without building Quotes-spine portal UI would remove ALL portal-facing quote functionality. Additionally, the documents flow supports kinds the Quotes spine doesn't cover (`invoice`, `receipt`) plus the PDF-upload-based signing of externally-produced contracts.
- **Q6 verdict: ALL live portal charts read `transactions` directly. The entire KPI service/view/worker cluster is ORPHANED from the Next.js portal.** The cluster is only consumed by the legacy HTML-dashboard routes (`routes/dashboard.js`, `routes/api.dashboard.js`) which the Next.js portal has superseded. **7 KPI-cluster files DELETE-SAFELY** confirmed.
- **Design-doc gaps: 6** (up from 4) — two new gaps surfaced: (5) Portal Quotes UI missing, (6) Documents-kind-coverage gap (invoices, receipts, contracts, uploaded external PDFs).

---

## Q5 Finding: Documents Flow Disposition

**Verdict: MIXED** — the flow is LEGACY for quote/contract lifecycle (superseded by the Quotes spine at the DB layer) but ACTIVE in the portal (because no portal UI exists for the Quotes spine), AND distinct-feature-supporting for kinds the Quotes spine does not cover.

### Evidence

**`/sign/[token]/page.tsx:26-30`** queries `job_document_files` by `signature_token`:
```
.from("job_document_files")
.select("id, job_id, kind, label, signed_at, storage_bucket, storage_path")
.eq("signature_token", token)
```
The document it presents is a **PDF from Supabase Storage** (line 63-65: `admin.storage.from(fileRec.storage_bucket).createSignedUrl(...)`). The signing UI (`SignClient.tsx:120-126`) generates a signature PNG via canvas, POSTs to `/api/documents/sign`, which UPDATEs `job_document_files.signature_data = <base64 png>` + clears the token (`sign/route.ts:51-58`).

**`/sign/[token]/SignClient.tsx:24`** enumerates the kinds:
```
{ quote: "Quote", contract: "Contract", change_order: "Change Order" }
```

**`/api/documents/send/route.ts:30-36`** adds two more:
```
quote, contract, change_order, invoice, receipt
```

**`/app/documents/page.tsx:340-346`** queries `job_documents` for pipeline stages (`id, stage, lead_notes, lead_source, customer_id, job_id`). Stages observed: `lead`, `quote`, `contract`, `active`, `invoiced` (per intake confirm stage transitions below).

**Nav linkage:**
- NOT in any main-nav component: `app/components/Sidebar.tsx`, `app/components/MobileNav.tsx`, `app/components/DecisionCenterNav.tsx`, `app/nav.tsx` have zero references to `/documents`.
- Only linked from `app/welcome/WelcomeClient.tsx:214` (welcome-page action card).
- Linked as a tab inside job detail pages: `app/jobs/[jobId]/page.tsx` navigates to `?tab=documents`.

**Active INSERT sites for `job_documents`:**
- `app/app/documents/page.tsx:197-206` — portal user creates a new lead manually
- `app/app/jobs/[jobId]/page.tsx:449, 1133` — `ensureJobDoc` helper creates row if missing
- `api/intake/items/[id]/confirm/route.ts:357` — intake confirm creates lead-stage row on new-lead confirm
- `api/intake/items/[id]/confirm/route.ts:402-406` — updates or inserts at quote stage
- `api/intake/items/[id]/confirm/route.ts:491-493` — updates to `invoiced` stage

**Active INSERT sites for `job_document_files`:**
- `api/documents/upload/route.ts:72-83` — user uploads PDF, inserts a file row

**Quotes spine coverage — critical finding:**
- Grepped all of `chiefos-site/app/` for `chiefos_quote`, `SendQuote`, `SignQuote`, `CreateQuote`, `share_tokens`, `chiefos_quote_signatures`: **zero matches.**
- The Quotes spine (`chiefos_quotes`, `chiefos_quote_versions`, `chiefos_quote_line_items`, `chiefos_quote_share_tokens`, `chiefos_quote_signatures`, `chiefos_quote_events`) is used only by WhatsApp CIL handlers at `src/cil/quotes.js`.
- The Next.js portal has no reads, no writes, no UI that consumes the Quotes spine.

**Overlap vs. distinct scope:**
- The Quotes spine covers: structured quotes with versioned line items, server-hashed immutable locked versions, share tokens with strict recipient-snapshot + 30-day expiry, strict-immutable signatures with PNG-storage-key CHECK regex, quote events stream.
- The documents flow covers: `kind IN ('quote','contract','change_order','invoice','receipt')` + PDF upload (base64 from client) + flexible 7-day-signed-URL-send OR signature-token-send. The upload mechanism accepts **pre-generated PDFs from any source** — the UI at `app/jobs/[jobId]/page.tsx` constructs quote PDFs client-side and uploads them. This is fundamentally different from the Quotes spine's "server builds the structured quote then hashes the canonical form" model.

### Recommendation

**MIXED disposition** — neither pure delete nor pure preserve. The path forward depends on a product decision, not a technical one:

**Option A: Preserve documents flow + deprecate portal Quotes-spine ambition.**
- Documents flow stays; add `job_documents` + `job_document_files` as KEEP-WITH-REDESIGN in Phase 1 §3.12
- Quotes spine stays in the DB for WhatsApp CIL handlers (they create rows, they work)
- The portal uses documents for quote lifecycle; the Quotes spine structured rows are backend-only bookkeeping
- Design gap: the portal's quote builder never produces a `chiefos_quotes` row — structural waste. The Quotes spine's integrity chain + signatures are never used by portal signings. Acceptable trade-off if the documents flow meets product needs.

**Option B: Migrate documents flow into Quotes spine + extend Quotes spine for new kinds.**
- Build portal UI for the Quotes spine (CreateQuote, SendQuote, SignQuote via `chiefos_quote_*` tables)
- Extend Quotes spine to support `contract`, `invoice`, `receipt`, `change_order` kinds (§3.5 already flags "Invoices and Contracts are future-scope spines")
- Delete `job_documents` + `job_document_files` tables after migration
- Significant portal rewrite scope. Multiple sessions.

**Option C: Hybrid — keep documents for the "external PDF upload" path; rebuild Quotes portal UI for structured quotes only.**
- Quotes spine gets portal UI for structured quotes (new rebuild from scratch)
- Documents flow survives for contracts/invoices/receipts — items not covered by Quotes spine
- Most work, but clearest separation of concerns

**DECISION DEFERRED TO FOUNDER.** The migration (Phase 5 cutover) cannot land cleanly until one of these options is chosen, because the current portal depends on `job_documents` + `job_document_files` for active UX.

**Immediate remediation implication:** If Option A or Option C, `job_documents` + `job_document_files` need to become KEEP-WITH-REDESIGN tables with rebuild migrations (adds a **new Phase 1 §3.12 sub-section**). If Option B, the tables DELETE-SAFELY but the Quotes-spine portal UI work becomes a multi-session blocker before Phase 5.

---

## Q6 Finding: KPI Graphs Disposition

**Verdict:** All 3 graph components in the Next.js portal read `transactions` directly. **Zero portal charts touch any DISCARDed KPI view.** The entire KPI service/view/worker cluster is ORPHANED from the Next.js portal, consumed only by the legacy HTML-dashboard routes.

### Live graph-rendering portal pages

| File | Graph kind | Data source (final SQL target) | Rebuild equivalent? | Classification |
|---|---|---|---|---|
| `app/app/components/RevenueLineChart.tsx` | Custom SVG line chart (pure presentation) | Receives `txRows` via props | Data source is caller's responsibility | PURE-PRESENTATION |
| `app/app/components/BusinessPulseChart.tsx:156` | Wraps RevenueLineChart | Receives `txRows` via props | Data source is caller's responsibility | PURE-PRESENTATION |
| `app/app/dashboard/page.tsx:493` renders `BusinessPulseChart` | Line chart | `.from("transactions").select(...)` at line 651 | N/A (direct `transactions` — no discarded view) | **ACTIVE-MIGRATABLE (no changes needed)** |
| `app/app/jobs/[jobId]/page.tsx:1075` renders `RevenueLineChart` | Line chart | `.from("transactions").select("id, date, amount_cents, kind, job_name, job_id, created_at")` at line 1029 | N/A (direct `transactions`) | **ACTIVE-MIGRATABLE (no changes needed)** |
| `app/app/jobs/page.tsx:7` (comment) | — | "RevenueLineChart removed — chart lives on the dashboard only" | — | No graph here (comment confirms removal) |

**No portal chart reads `job_kpis_daily`, `job_kpis_weekly`, `job_kpis_monthly`, `company_balance_kpis`, `company_kpis`, `company_kpis_weekly`, `company_kpis_monthly`, `job_kpis_summary`, `v_job_profit_simple_fixed`, `v_cashflow_daily`, or any other DISCARDed KPI view.** Verified via grep: zero matches for `.from("job_kpis` or `.from("company_kpis` or `.from("v_cashflow` or `.from("v_job_profit` in `chiefos-site/app/`.

### Where the KPI cluster is actually consumed

| Consumer | File | Line | Purpose |
|---|---|---|---|
| `routes/dashboard.js` | imports `getCompanyKpis`, `getJobKpiSummary` | 15-16, 120-121 | Legacy `/dashboard` HTML endpoint; auth via `?token=<users.dashboard_token>` (line 33-36) |
| `routes/api.dashboard.js` | imports `getCompanyKpis`, `getJobKpiSummary` | 13-14, 172-173 | Same — older API counterpart |
| `scripts/demoKpi.js` | imports `processBatch` from kpiWorker | 4 | Demo script, hardcoded owner_id |
| `archive/legacy/job_kpis.js` | imports `getJobKpis` from getJobKpis.js | 2 | Excluded (archived) |

**Both `routes/dashboard.js` and `routes/api.dashboard.js` are mounted** (`index.js:212` — `app.use("/api/dashboard", dashboardRouter)`). The chiefos-site portal has **zero calls to `/api/dashboard`** or any endpoint that consumes `users.dashboard_token` for auth. These routes are the pre-Next.js-portal HTML dashboard surface — entirely superseded. Per Phase 4.5 founder question #8 (dashboard_token — the column is also DISCARDed in the rebuild), these routes will fail at cutover regardless.

### Cluster file dispositions

| File | Classification | Rationale |
|---|---|---|
| `services/kpis.js` | **DELETE-SAFELY** | Only consumers: `routes/dashboard.js:15`, `routes/api.dashboard.js:13` — both legacy HTML dashboard superseded by Next.js portal |
| `services/jobsKpis.js` | **DELETE-SAFELY** | Same consumers as above |
| `services/kpiWorker.js` | **DELETE-SAFELY** | Only consumer: `scripts/demoKpi.js` (demo, itself delete-safe). Writes to `job_kpis_daily` (DISCARDed table). Not cron-triggered from live app code — grepped `kpi_refresh` and `forecast_refresh` across all cron/worker files and nothing imports `processBatch` or `kpiWorker` at runtime |
| `workers/kpi_refresh.js` | **DELETE-SAFELY** | Not imported anywhere in live code (`grep -rE "workers/kpi_refresh"` returns zero non-self hits). Reads from `time_entries` (v1 DISCARDed), writes to `timesheet_rollups` (DISCARDed). Orphaned |
| `workers/forecast_refresh.js` | **DELETE-SAFELY** (confirmed from Phase 4.5) | Refreshes 4 DISCARDed views, no importers |
| `scripts/demoKpi.js` | **DELETE-SAFELY** (confirmed from Phase 4.5) | Demo script, hardcoded owner, references 3 DISCARDed tables |
| `services/agentTools/getJobKpis.js` | **DELETE-SAFELY** (confirmed from Phase 4.5) | Not in Ask Chief agent tool registry; only referenced from `archive/legacy/` |
| `routes/dashboard.js` | **DELETE-SAFELY** *(new finding this session)* | Legacy HTML dashboard; auth via DISCARDed `users.dashboard_token`; consumes `services/kpis.js` + `services/jobsKpis.js`. The Next.js portal at `chiefos-site/app/app/dashboard/page.tsx` has superseded this surface entirely |
| `routes/api.dashboard.js` | **DELETE-SAFELY** *(new finding this session)* | Same disposition — companion to `routes/dashboard.js` |

### Recommendation

**No Phase 1 amendment needed.** The chiefos-site portal already migrated its chart code to source from `transactions` directly. No `chiefos_portal_tenant_kpis` view is needed because no live chart consumes tenant-level aggregates.

**Cluster cleanup = 9 files DELETE-SAFELY** (Phase 4.5 flagged 5; this session adds `services/kpis.js`, `services/jobsKpis.js`, `services/kpiWorker.js`, `routes/dashboard.js`, `routes/api.dashboard.js`).

**Remediation step: single-session bulk deletion.** No refactor work. The old dashboard-HTML surface is dead code.

**Important related note:** `routes/dashboard.js` auth path reads `users.dashboard_token` which is also DISCARDed. Even without the KPI-view issue, the legacy HTML dashboard breaks at cutover. Aligns with Phase 4.5 Q8 which asked "does the dashboard_token surface still need to exist?" Answer: No. It's fully orphaned from the active product.

---

## Updated Design-Doc Gap List

Phase 4.5 surfaced 4 gaps. Q5 surfaces 2 more:

| # | Gap | Source | Verdict |
|---|---|---|---|
| 1 | Reminders table must return | Phase 4.5 | CONFIRMED — add `rebuild_reminders.sql` |
| 2 | Supplier catalog must partially return | Phase 4.5 | CONFIRMED — author Phase 1 §3.13 Supplier Catalog |
| 3 | RAG knowledge tables must return | Phase 4.5 | CONFIRMED — add `rebuild_ask_chief_knowledge.sql` |
| 4 | insight_log must return | Phase 4.5 | CONFIRMED — add `rebuild_insight_log.sql` |
| 5 | Documents flow (`job_documents` + `job_document_files`) — disposition decision required | **NEW from Q5** | Pending founder decision between Options A/B/C above |
| 6 | Portal Quotes-spine UI gap: Quotes spine has zero portal consumers | **NEW from Q5** | Related to Gap #5 — part of the same decision |

**Gaps 5 + 6 are not resolvable without a product decision.** Unlike gaps 1–4 which are purely schema fixes, these require choosing a product path.

---

## Final Remediation Readiness Check

### What's ready to remediate right now (no founder input needed)
- All PRESERVE-AND-REMEDIATE items from Phase 4.5 whose rebuild-shape equivalents exist
- All DELETE-SAFELY items (including 4 new confirmations from Q6)
- The ~270 blocking findings from Phase 4 whose remediation paths are mechanical

### What's blocked on founder input (cannot proceed to remediation)
- **Gap 5 + 6 — Documents + Portal Quotes spine:** requires Options A/B/C choice before the team knows whether to add `job_documents` migrations (Option A), invest in portal Quotes UI (Option B), or hybrid (Option C). This blocks any Phase 5 cutover that touches quotes or documents.
- **Phase 4.5 question #2 — Supplier catalog preserve/delete/trim:** the catalog is in Ask Chief's agent tool registry; a decision is needed on the scope of preservation.
- **Phase 4.5 question #3 — Owner's personal price book (`domain/pricing.js`):** is the WhatsApp "add pricing: X @ $Y" command a current feature?
- **Phase 4.5 question #4 — Change orders:** fold into Quotes spine or keep separate table?
- **Phase 4.5 question #1 — `routes/crew.js` orphaned?** Quick founder confirm needed.

### Updated remediation cadence forecast
Phase 4.5 forecast 10 sessions. Q6's finding that the entire KPI cluster DELETE-SAFELYs reduces cluster-remediation work — saves ~0.5 of a session in R1. Q5's MIXED verdict adds potential work (if Option B/C, extra sessions for portal Quotes UI).

**Adjusted forecast: 10-12 sessions,** depending on Q5 Option selected.

---

## File Inventory

**Created this session:**
- `PHASE_4_5B_SUB_AUDIT_REPORT.md` — this document

**No code modifications. No migration modifications. No design-doc edits.**

---

Phase 4.5b sub-audit complete. Q5: MIXED — documents flow is the portal's only quote/contract lifecycle UI despite Quotes spine existing; founder decision required on Options A/B/C. Q6: 2 portal charts ACTIVE-MIGRATABLE (no changes needed), 0 ORPHANED (charts themselves are fine), 9 KPI-cluster files DELETE-SAFELY. Design-doc gaps total: 6. Ready for Phase 1 amendment directive.
