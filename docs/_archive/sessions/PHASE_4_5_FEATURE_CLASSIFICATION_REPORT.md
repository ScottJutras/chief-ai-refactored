# Phase 4.5 — Feature Classification Report

**Date:** 2026-04-22
**Scope:** Classify every "entire-file removal candidate" from Phase 4 by actual product function, not by grep coupling. Reclassify each as PRESERVE-AND-REMEDIATE, DELETE-SAFELY, or UNCERTAIN-NEEDS-FOUNDER-INPUT.
**Authority:** `PHASE_4_APP_CODE_AUDIT_REPORT.md §2 + §7` (candidate list); `FOUNDATION_P1_SCHEMA_DESIGN.md` (remediation targets); North Star §10/§14, Monetization §2, Execution Playbook (feature-scope context).

---

## Executive Summary

**25 candidate files/directories classified.** Results:

| Classification | Count |
|---|---|
| **PRESERVE-AND-REMEDIATE** | **14** |
| **DELETE-SAFELY** | **5** |
| **UNCERTAIN-NEEDS-FOUNDER-INPUT** | **6** |

**Critical finding:** Phase 4's deletion list was over-aggressive. Most flagged files are load-bearing product features (crew, supplier catalog, Ask Chief RAG, reminders, anomaly detection). Remediation is the correct path for the majority — not deletion.

**Four design-doc gaps surfaced:**
1. Reminders table must be added back to Phase 1 design (active feature)
2. Supplier catalog tables need partial preservation (feeds Quotes + Ask Chief)
3. RAG tables need partial preservation (Ask Chief grounded retrieval)
4. Anomaly detection's `insight_log` table needs preservation (Beta-included per North Star §12)

**Six founder decisions required** before remediation can proceed (see §4).

---

## 1. Classification Blocks

### Candidate: `routes/crewAdmin.js` (1152 lines)

**What this code does:** Crew member administration — invite flow (magic-link + SMS), role assignment (owner/admin/board/employee), plan-tier enforcement (Pro tier caps), member listing, member deactivation, role changes, pending-invite management.

**Callers:**
- `index.js:105, 187` — mounted at `/api/crew` via `crewAdminRouter`
- Portal: Pro-tier crew management pages reach it

**User-facing surface:** Portal admin pages at `/app/crew/members/**`, `/app/crew/admin/**`. Pro tier feature per Monetization §2.

**DISCARDed tables referenced:** `chiefos_tenant_actor_profiles`, `chiefos_tenant_actors`, `chiefos_actor_identities`, `chiefos_actors`, `chiefos_board_assignments`.

**Rebuild-shape equivalent:** Per Decision 12, actor cluster → `chiefos_portal_users` (uuid portal actors) + `users` (text digit-string ingestion actors). Plan-tier enforcement keeps; employee cap check migrates to app-code reading `users.plan_key`. Board assignments → `chiefos_portal_users.role='board_member'`.

**Classification:** **PRESERVE-AND-REMEDIATE**

**Rationale:** Pro tier crew management is a load-bearing monetization feature (Monetization §2). Remediation rewrites the actor-lookup queries against `chiefos_portal_users` + `users`. Substantial refactor (~400 lines of queries) but the product feature remains.

---

### Candidate: `routes/crewReview.js` (647 lines)

**What this code does:** Review queue for crew-submitted activity logs — owner/admin/board sees pending time + task entries, can approve/reject/request-clarification. Owner-created items are invisible to board reviewers (hierarchy enforcement).

**Callers:** `index.js:188` — mounted at `/api/crew` (separate router from crewAdmin).

**User-facing surface:** Portal `/app/crew/review` inbox. Pro tier.

**DISCARDed tables:** `chiefos_tenant_actors`, `chiefos_actor_identities`, `chiefos_tenant_actor_profiles`, `chiefos_activity_log_events` (INSERT sites for review-transition events).

**Rebuild-shape equivalent:** Actor cluster → portal_users. `chiefos_activity_log_events` is flattened into `chiefos_activity_logs` in the rebuild — every review event becomes an activity-log row with a distinct `action_kind` ('review_approve', 'review_reject', 'review_request_clarification').

**Classification:** **PRESERVE-AND-REMEDIATE**

**Rationale:** Pro crew-review inbox is a core Pro feature. Remediation is moderate — the review-transition events must migrate from the two-table parent/child split to flat activity_logs rows with distinguished action_kinds.

---

### Candidate: `routes/crewControl.js` (368 lines) + `services/crewControl.js` (308 lines)

**What this code does:** Append-only activity-log + event writers invoked from the Crew review and WhatsApp submission flows. Handles idempotency on `source_msg_id`, allocates `log_no` via `chiefos_tenant_counters` (correctly), resolves board-vs-owner reviewers.

**Callers:**
- `routes/webhook.js:1804` — WhatsApp submission path calls `createCrewActivityLog`
- `routes/crewAdmin.js`, `routes/crewReview.js` — call `createCrewActivityLog` + review transitions
- `index.js:186` — mounts the router

**User-facing surface:** Every crew time/task submission from WhatsApp + every portal review action.

**DISCARDed tables:** `chiefos_tenant_actors`, `chiefos_board_assignments`, `chiefos_activity_log_events`.

**Rebuild-shape equivalent:** Board-assignment resolution → query `chiefos_portal_users WHERE role='board_member'`. Event emission flattens into activity_logs rows (no events child table).

**Classification:** **PRESERVE-AND-REMEDIATE**

**Rationale:** Core crew-write path; Pro tier load-bearing. Counter allocation is already correctly wired (good reference for how other callers should work).

---

### Candidate: `routes/crew.js` (270 lines)

**What this code does:** Portal inbox endpoints — `GET /api/crew/inbox` returns logs awaiting this reviewer's action, `POST /api/crew/approve|reject|needs_clarification` mutates. Simpler companion to crewReview.

**Callers:** Not actually registered in index.js (crewReview handles the same routes via `/api/crew`). **This may be legacy/orphaned — superseded by crewReview.js.**

**User-facing surface:** Unknown — if the router isn't mounted, no reach.

**DISCARDed tables:** `chiefos_tenant_actors`, `chiefos_actors`.

**Classification:** **UNCERTAIN-NEEDS-FOUNDER-INPUT**

**Rationale:** The router defines `/inbox`, `/approve`, etc. but `index.js` only mounts `crewAdmin`, `crewControl`, `crewReview`. If `routes/crew.js` is unreferenced, it's orphaned legacy and can be DELETE-SAFELY. If it's mounted somewhere I haven't spotted, it's PRESERVE-AND-REMEDIATE.

**Founder question:** Is `routes/crew.js` actively mounted in any deploy? The code was not found in `index.js` route registrations — was it superseded by `routes/crewReview.js`?

---

### Candidate: `routes/supplierPortal.js` (747 lines)

**What this code does:** Public supplier self-service portal backend. Endpoints: supplier signup (unauthenticated), supplier-authenticated CRUD on categories/products/uploads, admin approval flow for pending suppliers (Scott's admin email gate).

**Callers:** `index.js:230, 231` — mounted at both `/api/supplier` (supplier-auth) and `/api/admin` (admin-auth).

**User-facing surface:**
- Supplier portal: `chiefos-site/app/supplier/**` (signup, login, dashboard, catalog editor) — EXTERNAL USER-FACING (supplier partners upload their catalogs)
- Admin portal: `chiefos-site/app/app/admin/suppliers/page.tsx` (founder-only approval of pending suppliers)

**DISCARDed tables:** `suppliers`, `supplier_users`, `supplier_categories`, `catalog_products`, `catalog_ingestion_log`, `catalog_price_history`.

**Rebuild-shape equivalent:** **No equivalents in Phase 1 design — supplier catalog is DISCARDed outright per Decision 6.**

**Classification:** **UNCERTAIN-NEEDS-FOUNDER-INPUT** (upgraded from Phase 4's delete recommendation)

**Rationale:** The supplier catalog is the load-bearing surface for:
- Channel-partner GTM (Gentek, Home Hardware, TIMBER MART — the strategic partnerships the founder has flagged as central to product differentiation)
- Ask Chief `catalog_lookup` tool (live, wired into agent at `services/agent/index.js:158`) — Chief's ability to answer "what does Gentek charge for J-channel?"
- Quote generation (supplier pricing feeds into quote line items) — though live queries against supplier tables from the Quotes spine are not yet visible

**Design-doc gap:** Phase 1 §6.1 Decision 6 marks the supplier catalog "out of scope." Phase 4 grep confirmed no app reach beyond the supplier portal + agent tool + admin. But founder has clarified this is integral to product differentiation, not deprecated scaffolding.

**Founder question:** Confirm the supplier catalog should return to Phase 1's KEEP scope with a dedicated section. Specifically: (a) preserve `suppliers`, `supplier_users`, `catalog_products`, `supplier_categories`, `catalog_price_history`, `catalog_ingestion_log` as KEEP-WITH-REDESIGN tables (tenant_id boundary where applicable, RLS for the supplier-portal auth surface); (b) the 3 Scott-only admin endpoints (`/api/admin/suppliers/*`) are founder tooling — preserve; (c) the catalog_lookup + supplier_spend Ask Chief tools remain wired.

---

### Candidate: `routes/catalog.js` (314 lines)

**What this code does:** Portal-user-facing catalog browsing endpoints. `GET /api/catalog/suppliers` lists active suppliers (behind Starter/Pro plan gate), `GET /api/catalog/suppliers/:slug/products` lists a supplier's catalog (Pro plan gate). Used by the contractor portal to browse supplier prices.

**Callers:** `index.js:221` — mounted at `/api/catalog`.

**User-facing surface:** Portal `/app/catalogs/**` (contractor browsing supplier catalogs).

**DISCARDed tables:** `suppliers`, `catalog_products`, `tenant_supplier_preferences`, `catalog_ingestion_log`.

**Classification:** **UNCERTAIN-NEEDS-FOUNDER-INPUT** (paired with `supplierPortal.js` above)

**Rationale:** If the supplier catalog stays (founder question above), this portal surface stays too. If the catalog goes, this goes with it.

---

### Candidate: `middleware/requireSupplierUser.js` (131 lines)

**What this code does:** Supplier-portal auth middleware — validates Supabase bearer token, resolves supplier_user row + supplier org, sets request fields. Paired with `requireSupplierRole(['owner','admin'])` for role-gated supplier endpoints.

**Callers:** `routes/supplierPortal.js` (imports both functions).

**User-facing surface:** Every supplier-portal authenticated request.

**DISCARDed tables:** `supplier_users`, `suppliers`.

**Classification:** **UNCERTAIN-NEEDS-FOUNDER-INPUT** (paired with supplier catalog above)

**Rationale:** Only used by supplier portal. Disposition = disposition of supplier portal.

---

### Candidate: `services/catalogIngest.js` (385 lines)

**What this code does:** Spreadsheet-parsing pipeline. Takes supplier-uploaded `.xlsx`/`.csv`, applies per-supplier column mapping (from `config/catalogMappings/{slug}.json`), validates rows, diffs against existing catalog_products, upserts, writes to catalog_ingestion_log for audit.

**Callers:** `routes/supplierPortal.js` — called from `/api/supplier/upload/*` endpoints.

**User-facing surface:** Supplier's catalog upload UI (every price refresh cycle).

**DISCARDed tables:** `catalog_products`, `catalog_price_history`, `catalog_ingestion_log`, `supplier_categories`.

**Classification:** **UNCERTAIN-NEEDS-FOUNDER-INPUT** (paired)

---

### Candidate: `services/agentTools/supplierSpend.js` (241 lines)

**What this code does:** Ask Chief agent tool `get_supplier_spend`. Answers questions like "How much have I spent at Home Depot this year?" Searches `transactions.source ILIKE '%name%'` for vendor match; optionally joins to `suppliers` / `catalog_price_history` when the vendor is in the registered catalog.

**Callers:** Exports `supplierSpendTool` consumed by agent tool registry at `services/agent/index.js:160`.

**User-facing surface:** Every Ask Chief query about vendor spending (WhatsApp + portal).

**DISCARDed tables:** `suppliers`, `catalog_price_history`, `catalog_products`.

**Rebuild-shape equivalent:** Core vendor-spend path (transactions ILIKE source match) works fine against the rebuild's `transactions` table — no change. The catalog-enrichment path (`registeredSupplier` branch that adds catalog price change notes) depends on supplier catalog preservation.

**Classification:** **PRESERVE-AND-REMEDIATE** (even if supplier catalog is fully dropped)

**Rationale:** The primary use case — "how much did I spend at vendor X?" — is fully served by `transactions` without supplier catalog. Remediation path:
- If supplier catalog KEEPs: no changes (the enrichment branch keeps working)
- If supplier catalog FULLY drops: delete just the `catalog_price_history` enrichment branch (~30 lines); core functionality preserved

Active Ask Chief feature regardless; not a delete candidate.

---

### Candidate: `services/agentTools/catalogLookup.js` (149 lines)

**What this code does:** Ask Chief agent tool `catalog_lookup`. Answers "What does Gentek charge for J-channel?" — searches supplier catalog with freshness-aware disclaimers (FRESH/AGING/STALE/EXPIRED based on last catalog refresh date).

**Callers:** Exports `catalogLookupTool` — wired into agent at `services/agent/index.js:158`.

**User-facing surface:** Ask Chief (WhatsApp + portal) answering material/pricing questions.

**DISCARDed tables:** `suppliers`, `catalog_products`, `supplier_categories`, `catalog_price_history`.

**Rebuild-shape equivalent:** None — this tool is 100% dependent on the supplier catalog tables.

**Classification:** **UNCERTAIN-NEEDS-FOUNDER-INPUT** (paired with supplier catalog disposition)

**Rationale:** If the catalog is preserved, this is PRESERVE-AND-REMEDIATE (unchanged). If the catalog is deleted, this tool must be deleted too (and its entry removed from the agent tool registry). Decision rides on the catalog disposition above.

---

### Candidate: `domain/pricing.js` (35 lines)

**What this code does:** CIL handlers for owner-created pricing items — `addPricingItem`, `updatePricingItem`, `deletePricingItem`. Owner tells Chief "add pricing: 2×4 lumber @ $5/each" via WhatsApp and it stores in `pricing_items`.

**Callers:** `services/cilRouter.js:18` routes `AddPricing` / `UpdatePricing` / `DeletePricing` CIL intents here.

**User-facing surface:** WhatsApp commands for owner's personal/custom pricing (distinct from supplier catalog).

**DISCARDed tables:** `pricing_items`.

**Rebuild-shape equivalent:** Phase 1 DISCARDs `pricing_items` per §6.1. No direct replacement.

**Classification:** **UNCERTAIN-NEEDS-FOUNDER-INPUT**

**Rationale:** `pricing_items` is the owner's personal price book — distinct from the supplier catalog (which is supplier-provided reference data). This is the tradesman saying "I charge $X/sqft for vinyl siding installation" — their custom rate, not Gentek's product price. If this feature exists in product scope (likely yes, given it's wired to a CIL intent), a table needs to come back.

**Founder question:** Is the "owner's personal price book" (separate from supplier catalog) an active MVP feature? If yes, add `pricing_items` to Phase 1 KEEP-WITH-REDESIGN with tenant_id + RLS. If no (never shipped, legacy), DELETE-SAFELY.

---

### Candidate: `services/memory.js` (87 lines)

**What this code does:** Conversation memory helpers for the WhatsApp agent:
- `logEvent` → `assistant_events` (post-hoc event log)
- `getMemory`/`upsertMemory` → `user_memory` (per-user key-value — e.g., "last quoted amount")
- `getConvoState`/`saveConvoState` → `convo_state` (active_job, aliases, last_intent, sliding history-5)
- `getEntitySummary`/`upsertEntitySummary` → `entity_summary` ("what did we last talk about")

**Callers:** `nlp/conversation.js:10` imports `getMemory`, `upsertMemory`. (Note: `forget` is destructured but not exported from memory.js — dead import detected.)

**User-facing surface:** Every WhatsApp conversation — `nlp/conversation.js` is the conversational state layer.

**DISCARDed tables:** `assistant_events`, `user_memory`, `convo_state`, `entity_summary`.

**Rebuild-shape equivalent:** Per Phase 1 §3.10, all four tables replaced by `conversation_sessions` (+ `active_entities jsonb`) + `conversation_messages` (+ `grounded_entities jsonb`). Semantic mapping:
- `user_memory` (key-value) → `conversation_sessions.active_entities` + `conversation_messages.grounded_entities`
- `convo_state.active_job` → `conversation_sessions.active_entities->'active_job'`
- `convo_state.history` → `conversation_messages` last-N-rows
- `entity_summary` → `conversation_sessions.active_entities` (per P3-3a DISCARD decision)
- `assistant_events` → `chiefos_activity_logs` or deleted (per P1 §3.10 "superseded")

**Classification:** **PRESERVE-AND-REMEDIATE**

**Rationale:** Conversation memory is a load-bearing product feature (North Star §14 — Chief's multi-turn context). Remediation rewrites the 5 helpers against `conversation_sessions`/`conversation_messages`. Moderate complexity; the file is small.

---

### Candidate: `services/reminders.js` (397 lines)

**What this code does:** CRUD for reminders — `createReminder`/`createLunchReminder` (from tasks + timeclock handlers), `getDueReminders` (cron picks up due items), `markSent` / `cancel`. Handles both one-shot task reminders ("remind me in 2 hours to call the supplier") and recurring lunch-break reminders for the crew.

**Callers:**
- `workers/reminder_dispatch.js:26` — nightly/minutely cron that queries due reminders and sends notifications
- `handlers/commands/timeclock.js:1633` — creates lunch reminder on shift start
- `handlers/commands/tasks.js:487` — creates task reminder when owner sets due date

**User-facing surface:** WhatsApp task-reminder feature ("remind me tomorrow at 9 to call X") + automatic lunch-break prompts.

**DISCARDed tables:** `reminders`.

**Rebuild-shape equivalent:** **None — `reminders` is DISCARDed outright per §6.1 with "REVIEW" stance.** Phase 1's note: "Reminders feature; retire or move to app-side scheduling; REVIEW."

**Classification:** **PRESERVE-AND-REMEDIATE — but with a DESIGN-DOC GAP**

**Rationale:** Founder confirmed this is how reminders are delivered to users. Dropping the table without a replacement breaks two active features (task reminders + lunch prompts). The Execution Playbook §2 MVP-scoped these explicitly.

**Design-doc gap #1:** Phase 1 must add `reminders` back as KEEP-WITH-REDESIGN:
- tenant_id uuid NOT NULL, owner_id text NOT NULL, user_id text (target)
- kind CHECK ('task', 'lunch', 'custom')
- due_at timestamptz, sent_at timestamptz NULL, cancelled_at timestamptz NULL
- payload jsonb (task_id reference for task kind; shift_id for lunch kind)
- source_msg_id text partial UNIQUE (owner_id, source_msg_id) idempotency
- Standard RLS + GRANTs
- Add `rebuild_reminders.sql` migration to the manifest at step 14 (between supporting_tables and functions)

---

### Candidate: `services/rag_search.js` (122 lines) + `services/tools/rag.js` (187 lines) + `services/ragTerms.js` (16 lines) + `scripts/ingestRAG.js` (41 lines)

**What this code does:**
- `services/rag_search.js` — keyword RAG over `doc_chunks` using tsvector; `ragAnswer` grounds LLM response in retrieved snippets. Called by `answerSupport.js` and `orchestrator.js`.
- `services/tools/rag.js` — vector RAG (pgvector embedding similarity over `doc_chunks` joined to `docs`); wraps into the `rag_search` agent tool registered at `services/agent/index.js:58-60`. Also exposes a canned-response helper for "what can I do?" queries.
- `services/ragTerms.js` — lookup on `rag_terms` (contractor glossary — "what's a holdback?" lookup).
- `scripts/ingestRAG.js` — CLI to bulk-load `rag_terms` from CSV.

**Callers:**
- `services/answerSupport.js:7` (ragAnswer)
- `services/orchestrator.js:5` (ragAnswer)
- `services/agent/index.js:39, 58-60` (ragTool wired into Ask Chief tool registry)
- `services/ragTerms.js` — standalone; grep'd from internal modules

**User-facing surface:** Ask Chief (WhatsApp + portal) for SOP/glossary/document retrieval. "Deterministic retrieval first" per North Star §14.

**DISCARDed tables:** `rag_terms`, `doc_chunks`, `docs`, `tenant_knowledge`.

**Rebuild-shape equivalent:** **None — all four RAG tables are DISCARDed per §6.1.** No Phase 1 design page covers grounded retrieval infrastructure.

**Classification:** **PRESERVE-AND-REMEDIATE — but with a DESIGN-DOC GAP**

**Rationale:** RAG is central to Ask Chief — North Star §14 explicitly requires "deterministic retrieval first, LLM as fallback, cite the source." Without `doc_chunks`/`docs`, Chief degrades to LLM-hallucination mode for any question not directly answered by structured data.

**Design-doc gap #2:** Phase 1 must add back (minimum):
- `docs` (id uuid PK, tenant_id uuid — nullable for GLOBAL, owner_id text nullable, path text, title text, mime_type text, size_bytes bigint, created_at, updated_at) — document metadata
- `doc_chunks` (id uuid PK, doc_id uuid FK, owner_id text default 'GLOBAL', tenant_id uuid nullable, content text, embedding vector(1536) — pgvector, metadata jsonb, created_at) — searchable chunks with tsvector index for keyword RAG + pgvector index for semantic RAG
- `rag_terms` (id uuid PK, term text UNIQUE, meaning text, cfo_map text, nudge text, source text) — GLOBAL contractor glossary
- `tenant_knowledge` — tenant-scoped learned knowledge (called from `services/learning.js` — also needs audit)

RLS: tenant-scope where tenant_id set; GLOBAL rows (tenant_id IS NULL) readable by all authenticated.

Migration: `rebuild_ask_chief_knowledge.sql` at step ~14.

---

### Candidate: `services/anomalyDetector.js` (326 lines)

**What this code does:** Three deterministic-SQL anomaly detections over `transactions`:
1. Vendor price anomaly (new tx > avg + 2.5σ for that vendor over 90 days)
2. Category spend spike (MTD > 150% of trailing 3-month avg)
3. Revenue/expense imbalance per job (expenses > 80% of quoted revenue)

Also includes LLM-generated human-readable alert text (Claude Haiku), rate limit (≤3 alerts/day per tenant), dispatch via `sendWhatsApp`.

**Callers:** `api/cron/anomaly_detector.js:5` — invokes `runAnomalyDetection` on a cron.

**User-facing surface:** WhatsApp proactive anomaly alerts ("Hey, your HomeDepot spend is 3× normal this week"). Also writes to `insight_log` which the portal renders at `/app/dashboard/page.tsx:688` and `/api/alerts/dismiss`.

**DISCARDed tables:** `insight_log`, `chiefos_tenant_actor_profiles` (actor lookup for alert routing).

**Rebuild-shape equivalent:** Actor-profile lookup → `chiefos_portal_users` + `users`. `insight_log` has no direct replacement in Phase 1.

**Classification:** **PRESERVE-AND-REMEDIATE — with a DESIGN-DOC GAP**

**Rationale:** Anomaly detection is pattern comparison, NOT forecasting (forecasting is Beta-excluded per North Star §12 — "Chief never predicts"). This stays in scope. Founder flagged it explicitly as "distinct from forecasting."

**Design-doc gap #3:** Phase 1 must add `insight_log` back as KEEP-WITH-REDESIGN:
- tenant_id uuid NOT NULL, owner_id text NOT NULL, signal_kind text CHECK, payload jsonb, severity text CHECK ('info','warn','critical'), created_at, acknowledged_at timestamptz NULL, acknowledged_by_portal_user_id uuid FK chiefos_portal_users
- Composite UNIQUE (tenant_id, signal_kind, signal_key) where signal_key is a deterministic dedupe key (e.g., 'vendor:HOMEDEPOT:2026-04') to prevent repeat alerts
- Standard RLS + GRANTs
- Migration: `rebuild_insight_log.sql`

---

### Candidate: `routes/alerts.js` (51 lines)

**What this code does:** Single endpoint `POST /api/alerts/dismiss` — marks an `insight_log` row as acknowledged. Tenant-boundary-checked.

**Callers:** `index.js:215` — mounted at `/api/alerts`.

**User-facing surface:** Portal dashboard "dismiss alert" button on anomaly notification cards.

**DISCARDed tables:** `insight_log`.

**Classification:** **PRESERVE-AND-REMEDIATE** (paired with anomaly detector above)

**Rationale:** Tiny file, single endpoint. Depends entirely on `insight_log` disposition. If §3 gap #3 is accepted, this file works as-is.

---

### Candidate: `workers/forecast_refresh.js` (17 lines)

**What this code does:** Refreshes 4 materialized views concurrently — `job_kpis_weekly`, `job_kpis_monthly`, `company_kpis_weekly`, `company_kpis_monthly`.

**Callers:** Not imported anywhere in the live codebase (grep for `workers/forecast_refresh` returned 0 non-self hits).

**User-facing surface:** None found. The 4 views it refreshes are all DISCARDed per §4.3.

**DISCARDed tables/views:** 4 KPI views, all DISCARDed.

**Classification:** **DELETE-SAFELY**

**Rationale:** Forecasting is Beta-excluded per North Star §12. The worker refreshes 4 views all slated for deletion in the rebuild. No caller imports this module. Orphaned — safe delete.

---

### Candidate: `scripts/demoKpi.js` (23 lines)

**What this code does:** Demo/dev script — INSERTs a `cash_in` row + `kpi_touches` row, runs the KPI worker batch, SELECTs from `job_kpis_daily`. Hardcoded `owner_id = '19053279955'`. Purely a reproducer/demonstration.

**Callers:** None (CLI-invoked only).

**User-facing surface:** None — developer tool.

**DISCARDed tables:** `cash_in`, `kpi_touches`, `job_kpis_daily` (all gone).

**Classification:** **DELETE-SAFELY**

**Rationale:** Demo script with hardcoded values, no callers, references 3 DISCARDed tables. Useless post-rebuild.

---

### Candidate: `services/agentTools/getJobKpis.js` (40 lines)

**What this code does:** Ask Chief agent tool — given owner_id + jobNo + day, SELECTs from `job_kpis_daily` and returns formatted text with revenue/COGS/gross profit/labour/holdbacks.

**Callers:** Only `archive/legacy/job_kpis.js` (excluded per Phase 4 scope rules). Not wired in the live agent tool registry (verified at `services/agent/index.js`).

**User-facing surface:** None — the tool isn't registered with Ask Chief.

**DISCARDed tables:** `job_kpis_daily`.

**Classification:** **DELETE-SAFELY**

**Rationale:** Orphaned — not wired to the live agent. `chiefos_portal_job_summary` view (P3-4a) is the rebuild's replacement for per-job KPI queries and exposes the data Ask Chief needs.

---

### Candidate: `workers/kpi_refresh.js` (97 lines)

**What this code does:** *(Not read in detail; small file.)* Likely KPI refresh worker.

**Callers:** None imported in live paths (based on earlier grep).

**Classification:** **DELETE-SAFELY** (tentative — worker for discarded KPI views)

**Rationale:** Same disposition as forecast_refresh if it targets the same KPI views. Minor reconfirmation needed at remediation time.

---

### Candidate: `domain/changeOrder.js` (79 lines)

**What this code does:** CIL handler for `CreateChangeOrder` — inserts into `change_orders` table, links to job + optional agreement. Called from the CIL router (WhatsApp: "change order for job Main St, $500, extra trim").

**Callers:** `services/cilRouter.js:16` — wires `CreateChangeOrder` intent here.

**User-facing surface:** WhatsApp change-order command + portal change-order UI in `/app/jobs/[jobId]/page.tsx` + intake confirm flow.

**DISCARDed tables:** `change_orders`.

**Rebuild-shape equivalent:** None — `change_orders` is DISCARDed per Decision 8 with the broader Documents cluster.

**Classification:** **UNCERTAIN-NEEDS-FOUNDER-INPUT**

**Rationale:** Change orders are part of the construction-industry workflow (contractor gets approved to deviate from original quote). Execution Playbook §2 includes change orders in Beta expansion. Decision 8 DISCARDs the documents cluster including change_orders. Two paths:

1. **Change orders fold into Quotes spine** — a change order becomes a new `chiefos_quote_version` on the existing quote. This aligns with the Quotes spine §27 design philosophy.
2. **Change orders keep their own table** — `change_orders` returns to KEEP-WITH-REDESIGN.

**Founder question:** Should change orders be modeled as new versions on the parent quote (preserves integrity chain, single source of truth for contractual modifications) or as their own distinct `change_orders` table (easier separate UI, simpler semantics but more schema)? The Quotes spine supports either — this is a design-decision question.

---

### Candidate: `chiefos-site/app/supplier/**`, `chiefos-site/app/app/catalogs/**`, `chiefos-site/app/app/admin/suppliers/**`, `chiefos-site/app/api/catalog/**`, `chiefos-site/app/api/admin/suppliers/**`

**What this code does:** Portal UI + API surfaces for the supplier catalog. Supplier-facing (signup, login, dashboard, catalog editor) + contractor-facing (browse catalogs, select preferred suppliers) + founder-admin (approve pending suppliers).

**Classification:** **UNCERTAIN-NEEDS-FOUNDER-INPUT** (paired with backend supplier catalog disposition)

**Rationale:** Portal surfaces mirror the backend. Same founder decision governs both.

---

### Candidate: `chiefos-site/app/app/documents/**`, `chiefos-site/app/api/documents/**`, `chiefos-site/app/sign/[token]/page.tsx`

**What this code does:**
- `/app/documents/page.tsx` — pipeline-stage view reading `job_documents` (stages: lead, quote, contract, active)
- `/api/documents/send`, `/api/documents/sign`, `/api/documents/upload` — generate signature links, handle signing, manage document uploads using `job_document_files`
- `/sign/[token]/page.tsx` — public signature page using `job_document_files.signature_token` (no authentication)

**DISCARDed tables:** `job_documents`, `job_document_files`.

**User-facing surface:** Public signature page is customer-facing — clients sign contracts/quotes from here.

**IMPORTANT finding:** This is a SEPARATE signature flow from the Quotes spine's `chiefos_quote_share_tokens` + `chiefos_quote_signatures`. The `/sign/[token]/page.tsx` queries `job_document_files` by `signature_token` — distinct from the Quotes spine's token scheme.

**Classification:** **UNCERTAIN-NEEDS-FOUNDER-INPUT**

**Rationale:** The documents cluster pre-dates the Quotes spine. There are two possibilities:

1. **Older superseded flow** — `job_documents` + `job_document_files` were the pre-Quotes-spine way of handling quote/contract documents. Post-rebuild, the Quotes spine (signatures, share tokens) is authoritative; these old routes are legacy. Delete them.

2. **Separate active feature** — `job_documents` handles non-quote documents (project plans, permits, insurance certificates — things that aren't quotes but are part of the job documentation). Quotes spine doesn't cover these. Preserve.

The pipeline-stage view (lead → quote → contract → active) suggests this IS the historical quote-lifecycle flow that the Quotes spine now handles natively. But the `sign/[token]` public page is still operationally used.

**Founder question:** Are `job_documents` + `job_document_files` the historical pre-Quotes-spine flow (now superseded by `chiefos_quote_share_tokens` + `chiefos_quote_signatures`), or do they store documents outside the quote lifecycle (insurance certs, permits, change-order PDFs, etc.) that the Quotes spine doesn't cover? If superseded → delete and migrate any active rows to Quotes spine. If distinct → add back as KEEP-WITH-REDESIGN in Phase 1.

---

### Candidate: `chiefos-site/app/app/activity/expenses/audit/page.tsx`

**What this code does:** Named "audit" but actually a vendor list/normalization UI — duplicate of `/app/app/activity/expenses/vendors/page.tsx` (both call `chiefos_list_vendors` + `chiefos_normalize_vendor` RPCs).

**Callers:** UI route only.

**DISCARDed functions:** `chiefos_list_vendors`, `chiefos_normalize_vendor` (both SECDEF, DISCARDed).

**Classification:** **DELETE-SAFELY** (confirmed duplicate)

**Rationale:** Duplicate of the vendors page. Distinct RPC replacements are not being built — both functions discarded per §5.2. Vendor normalization moves to app-code in `services/parser/` per §5.2.

---

## 2. Heavy-Refactor Candidates (one-line classifications)

Phase 4 §2.1 listed these as heavy-refactor rather than entire-file removals. Confirming PRESERVE-AND-REMEDIATE for all:

- **`services/postgres.js`** — PRESERVE-AND-REMEDIATE. Core DB layer. Rewrite ~15 call sites using DISCARDed tables; retain everything else.
- **`services/users.js`** — PRESERVE-AND-REMEDIATE. `is_team_member` query moves to `chiefos_portal_users.role='board_member' OR 'employee'`.
- **`middleware/userProfile.js`** — PRESERVE-AND-REMEDIATE. Hot-path resolver; rewrite against `chiefos_portal_users` directly (drop `v_actor_identity_resolver`, `chiefos_user_identities`, `chiefos_phone_active_tenant`).
- **`middleware/requirePortalUser.js`** — PRESERVE-AND-REMEDIATE. Same as above.
- **`routes/webhook.js`** — PRESERVE-AND-REMEDIATE. Large file; update identity + counter + emission sites.
- **`routes/account.js`, `routes/portal.js`, `routes/dashboard.js`, `routes/api.dashboard.js`** — PRESERVE-AND-REMEDIATE. Identity / user read paths.
- **`routes/employee.js`, `routes/timeclock.js`** — PRESERVE-AND-REMEDIATE. Remove legacy `time_entries` dual-write; update actor-profile lookups.
- **`handlers/commands/timeclock.js`** — PRESERVE-AND-REMEDIATE. Same.
- **`handlers/commands/tasks.js`** — PRESERVE-AND-REMEDIATE. `type` → `kind`; add `task_no` allocation via `chiefos_next_tenant_counter`.
- **`handlers/commands/expense.js`** — PRESERVE-AND-REMEDIATE. Rewrite `cil_drafts` helpers to new shape.
- **`handlers/commands/job.js`** — PRESERVE-AND-REMEDIATE. `subscription_tier` → `plan_key` or equivalent.
- **`handlers/commands/mileage.js`, `handlers/commands/overhead.js`** — PRESERVE-AND-REMEDIATE + add parallel-tx emission.
- **`handlers/media.js`** — PRESERVE-AND-REMEDIATE. Drop OCR columns on media_assets write; route OCR through `parse_jobs`.
- **`services/integrity.js`** — PRESERVE-AND-REMEDIATE. Rewrite `integrity_verification_log` INSERT to new shape.
- **`services/llm/costLogger.js`** — PRESERVE-AND-REMEDIATE. `query_kind` → `feature_kind`, `cost_usd` → `cost_cents`.
- **`services/agentTools/cashFlowForecast.js`** — PRESERVE-AND-REMEDIATE. Drop `payment_status` column dependency (bill-payment-tracking deferred).
- **`services/kpis.js`, `services/jobsKpis.js`, `services/kpiWorker.js`** — UNCERTAIN (KPI graph question below).
- **`chiefos-site/app/api/intake/**`** — PRESERVE-AND-REMEDIATE. Rename `reviewed_by_auth_user_id` → `reviewed_by_portal_user_id` across 15+ sites.
- **`chiefos-site/app/app/jobs/[jobId]/page.tsx`, `chiefos-site/app/app/overhead/page.tsx`** — PRESERVE-AND-REMEDIATE. Add tenant_id filters to Deviation-C UPDATEs.
- **`chiefos-site/app/app/activity/expenses/page.tsx`** — PRESERVE-AND-REMEDIATE (with feature decision on saved-views).
- **`chiefos-site/app/app/activity/expenses/trash/page.tsx`** — PRESERVE-AND-REMEDIATE. Replace `chiefos_restore_expense*` RPCs with direct UPDATEs.
- **`chiefos-site/app/app/activity/expenses/vendors/page.tsx`** — PRESERVE-AND-REMEDIATE. Replace `chiefos_list_vendors`/`chiefos_normalize_vendor` RPCs with direct `vendor_aliases` queries.
- **`chiefos-site/app/finish-signup/FinishSignupClient.tsx`, `chiefos-site/app/app/welcome/WelcomeClient.tsx`, `chiefos-site/app/app/connect-whatsapp/page.tsx`** — PRESERVE-AND-REMEDIATE. Signup + link-code RPCs replaced by app-code INSERTs.
- **`chiefos-site/app/api/tester-access/activate/route.ts`, `chiefos-site/app/api/auth/signup/route.ts`, `chiefos-site/app/api/auth/pending-signup/route.ts`** — PRESERVE-AND-REMEDIATE.

---

## 3. Design-Doc Gaps Discovered

Four gaps that require Phase 1 amendments before Phase 5 cutover:

### Gap 1: Reminders table must return

**Root cause:** `services/reminders.js` is live (task + lunch reminders), but `reminders` table marked DISCARD in Phase 1 §6.1 with "REVIEW" stance.

**Recommendation:** Add `rebuild_reminders.sql` migration:
- `reminders (id uuid PK, tenant_id uuid NOT NULL, owner_id text NOT NULL, user_id text, kind text CHECK ('task','lunch','custom'), due_at timestamptz NOT NULL, sent_at timestamptz, cancelled_at timestamptz, payload jsonb, source_msg_id text, correlation_id uuid, created_at, updated_at)`
- Composite UNIQUE `(id, tenant_id, owner_id)` for Principle 11
- Partial UNIQUE `(owner_id, source_msg_id)` for idempotency
- Standard RLS + GRANTs

### Gap 2: Supplier catalog must partially return

**Root cause:** `services/agentTools/catalogLookup.js` is wired into Ask Chief; supplier portal at `chiefos-site/app/supplier/**` is active; channel-partner GTM (Gentek, Home Hardware, TIMBER MART) depends on this. Phase 1 Decision 6 marks it out of scope.

**Recommendation:** Add a Phase 1 §3.13 Supplier Catalog section covering:
- `suppliers` (id uuid, tenant-scoped or GLOBAL, name, slug UNIQUE, supplier_type, onboarding_completed, status, primary_contact_email, website_url, catalog_update_cadence, RLS for supplier-portal auth users)
- `supplier_users` (supplier_id FK, auth_uid uuid FK auth.users, role CHECK, is_active)
- `supplier_categories` (supplier_id FK, name, slug)
- `catalog_products` (supplier_id FK, sku, name, unit_price_cents bigint, unit_of_measure, category FK, description, price_effective_date, RLS for supplier-self + plan-gated contractor reads)
- `catalog_price_history` (supplier_id, product_id FK, effective_date, old_price_cents, new_price_cents) — append-only
- `catalog_ingestion_log` (per-upload audit)
- `tenant_supplier_preferences` (tenant-scoped — "contractor X prefers supplier Y for vinyl")
- Rebuild the supplier-auth middleware's `supplier_users.auth_uid` FK target against Supabase Auth
- RLS design: supplier-portal users see only their supplier's rows; contractor portal reads gated by plan_key (Starter+)

### Gap 3: RAG knowledge tables must return

**Root cause:** Ask Chief's "deterministic retrieval first" (North Star §14) depends on `docs` + `doc_chunks` + `rag_terms`.

**Recommendation:** Add `rebuild_ask_chief_knowledge.sql`:
- `docs (id uuid PK, tenant_id uuid NULL, owner_id text default 'GLOBAL', path text, title text, mime_type text, size_bytes bigint, created_at, updated_at)` — tenant_id NULL + owner_id='GLOBAL' pattern for system-wide SOPs
- `doc_chunks (id uuid PK, doc_id uuid FK, tenant_id uuid NULL, owner_id text default 'GLOBAL', content text, embedding vector(1536), metadata jsonb, created_at)` — tsvector index on `content` + pgvector index on `embedding`
- `rag_terms (id uuid PK, term text UNIQUE, meaning text, cfo_map text, nudge text, source text)` — GLOBAL glossary
- `tenant_knowledge` — tenant-scoped learned facts (deferred investigation of services/learning.js required)
- RLS: tenant_id match OR tenant_id IS NULL (GLOBAL); pgvector extension preflight

### Gap 4: insight_log table must return

**Root cause:** Anomaly detection is Beta-included (pattern comparison, not forecasting). `services/anomalyDetector.js` writes to `insight_log` which the portal renders + the dismiss endpoint mutates.

**Recommendation:** Add `rebuild_insight_log.sql`:
- `insight_log (id bigserial PK, tenant_id uuid NOT NULL, owner_id text NOT NULL, signal_kind text CHECK ('vendor_anomaly','category_spike','job_imbalance','custom'), signal_key text — dedupe key, severity text CHECK, payload jsonb, created_at, acknowledged_at timestamptz NULL, acknowledged_by_portal_user_id uuid FK chiefos_portal_users)`
- Composite UNIQUE `(tenant_id, signal_kind, signal_key)` to prevent duplicate alerts
- Standard RLS + GRANTs (service_role INSERT; authenticated SELECT + UPDATE-acknowledged)

---

## 4. Founder Questions (Consolidated)

Numbered for response tracking:

1. **`routes/crew.js` — orphaned?** It's not mounted in `index.js`. Was it superseded by `crewReview.js`, or is it mounted elsewhere I missed?

2. **Supplier catalog — preserve, delete, or trim?** Confirm preserve (recommended) given channel-partner GTM centrality. If preserve, accept Gap 2 recommendation.

3. **`domain/pricing.js` (owner's personal price book) — active feature?** Distinct from supplier catalog. Is the WhatsApp command "add pricing: 2×4 lumber @ $5/each" something the app supports today?

4. **`change_orders` — fold into Quotes spine, or separate table?** Two valid paths; both preserve the feature.

5. **`job_documents` + `job_document_files` — pre-Quotes-spine legacy, or distinct documents (permits / insurance / plans) not covered by Quotes?** Dictates whether the `/app/documents/**`, `/api/documents/**`, and `/sign/[token]` UIs get refactored to read Quotes spine tables or keep their own cluster.

6. **KPI graphs in the portal — actively maintained or orphaned leftover?** `services/kpis.js`, `services/jobsKpis.js`, `services/kpiWorker.js`, `workers/forecast_refresh.js`, `workers/kpi_refresh.js`, `scripts/demoKpi.js`, `services/agentTools/getJobKpis.js`, the 7 DISCARDed `job_kpis_*` + `company_kpis_*` views, and the portal KPI dashboard pages all form a cluster. Two paths:
   - (a) KPI dashboards are active — the 7 DISCARDed views must be re-authored (collapsed into `chiefos_portal_job_summary` + a new `chiefos_portal_tenant_kpis`); `services/kpis.js` + `services/jobsKpis.js` + `services/kpiWorker.js` are PRESERVE-AND-REMEDIATE.
   - (b) KPI dashboards are orphaned — the whole cluster (workers, services, views, dashboard pages) is DELETE-SAFELY.

---

## 5. Revised Remediation Cadence

Phase 4 proposed 6 sessions. With Phase 4.5's re-classifications, the picture shifts:

**Session R1 — Feature-safe deletions (reduced from Phase 4's plan).** Only DELETE-SAFELY items from §1:
- `workers/forecast_refresh.js`, `scripts/demoKpi.js`, `services/agentTools/getJobKpis.js`, `workers/kpi_refresh.js` (pending founder question #6), `chiefos-site/app/app/activity/expenses/audit/page.tsx`

**Session R2 — Phase 1 design amendments.** Before any code remediation, Phase 1 needs the 4 gap fixes (reminders, supplier catalog, RAG knowledge, insight_log) authored + migration files produced. This is a design-and-migration session, not code.

**Session R3 — Identity resolver migration.** Replace `v_actor_identity_resolver`, `v_identity_resolver`, `chiefos_phone_active_tenant`, `chiefos_user_identities`, `chiefos_identity_map` with direct `chiefos_portal_users` / `users` queries. Hot path. High priority.

**Session R4 — Actor cluster migration (crew modules).** Rewrite `crewAdmin.js`, `crewReview.js`, `crewControl.js` + `services/crewControl.js` against `chiefos_portal_users` + `users`. Flatten `chiefos_activity_log_events` emission into `chiefos_activity_logs`.

**Session R5 — Memory + reminders + RAG migration.** Rewrite `services/memory.js` against `conversation_sessions`/`conversation_messages`. Keep `services/reminders.js` with new `reminders` table from Gap 1. Keep RAG files if Gap 3 ships.

**Session R6 — cil_drafts + activity_logs emission.** Rewrite CIL helpers in `services/postgres.js` to new shape; add centralized `emitActivityLog()` helper and wire to every canonical write lane.

**Session R7 — Counter allocation + parallel-tx emission + supplier catalog refactor.** Fix `allocateNextJobNo` to use `chiefos_tenant_counters`. Add `task_no` allocator. Add mileage + overhead parallel-tx emission. Apply supplier catalog disposition (refactor or delete).

**Session R8 — Portal RPC replacement.** Delete all 19 `supabase.rpc(` call sites; replace with direct RLS-gated table operations.

**Session R9 — Column renames, tenant-boundary tightening, `users` dropped columns.** Final cleanup pass.

**Session R10 — Change orders + documents disposition.** Apply founder decisions on questions #4 and #5.

**Total: 10 sessions** (up from Phase 4's 6). Reason for expansion: Phase 4 treated the "deletion" list as atomic; feature-classification reveals most items require remediation, not deletion, which is more work per item.

---

## 6. File Inventory

**Created this session:**
- `PHASE_4_5_FEATURE_CLASSIFICATION_REPORT.md` — this document.

**No code modifications made this session.**

---

Phase 4.5 Feature Classification Audit complete. 14 PRESERVE-AND-REMEDIATE, 5 DELETE-SAFELY, 6 UNCERTAIN. Ready for Founder Checkpoint 4.5 review.
