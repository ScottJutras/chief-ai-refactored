# ChiefOS — Receipt & Invoice Parser Upgrade Plan V2

**Status:** Authoritative sequencing document. Supersedes `RECEIPT_PARSER_UPGRADE_HANDOFF.md` §13 (Build Sequencing).
**Date:** 2026-04-21
**Owner:** Scott Jutras
**Informed by:** `RECEIPT_PARSER_AUDIT_NOTES.md` (Session 1)

---

## 1. Why This Document Exists

`RECEIPT_PARSER_UPGRADE_HANDOFF.md` was written before the audit of the existing codebase. Session 1 (Audit) surfaced that several components the handoff assumed existed either do not exist (`parse_jobs`, `vendor_aliases`, `parse_corrections`, the LLM auditor, the correction flow, the confidence router, the validation service) or exist in a form that violates the Engineering Constitution (`expense.js` calling `pgSvc.insertTransaction()` directly, bypassing CIL per §7).

This document supersedes the handoff's sequencing, scope, and assumptions. Every other section of the handoff (component specifications, target interfaces, schema DDL, pipeline flow, success criteria, non-goals) remains authoritative.

The product vision has not changed. The implementation path has.

---

## 2. What the Audit Changed

| Assumption in handoff | Reality per audit | Consequence for plan |
|---|---|---|
| All 10 components exist in some form; upgrade is enhancement | 6 of 10 components do not exist; 2 violate Constitution | Reframed as rebuild with strategic preservation |
| Schema tables exist; verify columns | All 7 target tables missing; receipt pipeline runs on `intake_items` family | Schema migration is Session 2, not Session 5 |
| `expense.js` is fragile but usable | 9,240 lines; violates CIL §7; hybrid insert payload | Partial extraction, not in-place refactor |
| Confirm-message bug is a 10-minute template fix | Two-shape data contract (`draft.store` vs `data.store`) bug | Fix lands alongside template unification, after auditor output is canonical |
| Auditor slots into existing router | No receipt router exists; `services/llm/router.js` is query-intent routing | Build confidence router from scratch |

---

## 3. Answered Open Questions

Per founder decision on 2026-04-21:

1. **`intake_items` vs `parse_jobs`:** Option B. Create `parse_jobs` as receipt-pipeline canonical. Keep `intake_items` for non-receipt intake (voice, PDFs, email leads). No data migration.
2. **Confirm-message date icon bug:** Diagnose before fixing. Budget the diagnostic in Session 11 (template unification).
3. **`expense.js` refactor scope:** Partial extraction into `services/expensePipeline.js`. Preserve PA state machine, job resolution, WhatsApp send layer. Route DB writes through `domain/transactions.js::logExpense()`.
4. **Retention of `intake_item_reviews`:** Keep it. Action-level audit (`confirm` / `edit_confirm` / `reject`) is distinct from per-field corrections (`parse_corrections`).
5. **`cil.js` vs `schemas/cil.js`:** Consolidate into `schemas/cil.js`. Remove `/cil.js`. Touches quotes spine; handled in Session 7.

---

## 4. Revised Session Sequence

All sessions are documentation-complete: each produces a concrete deliverable, has explicit completion criteria, and ends with a checkpoint. The Regression Pause Rule (Execution Playbook §3) is permanent — if any existing-system regression is detected during a session, that session pauses until restored.

### Foundation Sessions (Unblocks Everything Downstream)

#### Session 2 — Schema Migrations (Phase 1 Receipt + Phase 2 Quota)
**Deliverable:** Two migration files following the `YYYY_MM_DD_snake_case_description.sql` naming convention and existing idempotency patterns from `2026_04_18_chiefos_quotes_spine.sql`.

- **Phase 1 — Receipt tables (single migration file):**
  - `parse_jobs` per handoff §5.1
  - `vendor_aliases` per handoff §5.2 (including `default_job_hint`)
  - `parse_corrections` per handoff §5.3 (with FK to `parse_jobs`)
- **Phase 2 — Quota tables (single migration file):**
  - `quota_allotments`, `quota_consumption_log`, `addon_purchases_yearly`, `upsell_prompts_log` per handoff §5.4 and Constitution §11

Both migrations use `CREATE TABLE IF NOT EXISTS`, `DO $preflight$` blocks, idempotent `CREATE POLICY` wrappers. RLS policies gate portal access by `tenant_id IN (SELECT tenant_id FROM chiefos_portal_users WHERE user_id = auth.uid())`.

**Completion criteria:** Migrations applied to dev; cross-tenant isolation test per Engineering Constitution §6 passes (two tenants with overlapping `owner_id` digits, no leakage); rollback SQL produced and reviewed; no writes to production.

---

#### Session 3 — Validation Service + Flag Enum
**Deliverable:** `services/parser/validation.js` with `VALIDATION_FLAGS` enum and pure `validateReceiptDraft(draft, ctx) → string[]` function. Standalone, unit-tested, no integration yet.

Rules (deterministic, all run, no short-circuit):
- `MATH_MISMATCH` — subtotal + tax ≠ total (> 5¢)
- `DATE_OUT_OF_RANGE` — > 90 days past or > 30 days future
- `AMOUNT_SANITY` — ≤ 0 or > $9,999,999.99
- `MERCHANT_MISSING` — value is empty, "Unknown Store", or < 2 chars
- `CURRENCY_UNSUPPORTED` — not 'CAD' or 'USD'
- `DUPLICATE_SUSPECTED` — same merchant/amount/date within 24h for this tenant
- `INVOICE_NUMBER_MISSING` — kind='invoice' but no invoice number
- `IMAGE_QUALITY_LOW` — normalization service flagged blur/glare (wired later)
- `TAX_BREAKDOWN_UNCLEAR` — tax_cents present but breakdown not readable

Fail-open: flags surface, they do not block confirm. Store in `parse_jobs.validation_flags`.

**Completion criteria:** Unit tests for every flag; 100% branch coverage; imports cleanly; no side effects.

---

#### Session 4 — LLM Auditor Service (with Prompt Caching)
**Deliverable:** The 8 files per handoff §3 in `src/services/parser/auditor/`. Claude Sonnet 4.5 primary with prompt caching integrated from the start. GPT-4o fallback on provider failure.

Files:
- `index.js` (main entry: `auditReceipt()`)
- `providers/anthropic.js` (with `cache_control: { type: 'ephemeral' }` on system prompt + tool schema)
- `providers/openai.js` (json_schema mode)
- `providers/index.js` (failover logic)
- `prompts/auditor-system-prompt.js`
- `schema.js` (AUDITED_RECEIPT_SCHEMA)
- `errors.js` (typed AuditorError)
- `README.md`

**Completion criteria:** Unit tests against fixture receipts (mocked provider layer); integration test against real Anthropic + OpenAI APIs with 5 sample receipts; token usage logged; prompt caching hit rate > 80% on second call for same tenant.

---

#### Session 5 — Normalization Service Upgrade + Textract Fallback
**Deliverable:** Replace current EXIF-only normalization in `utils/visionService.js` with a proper normalization module. Fail-closed on error. Add Textract as OCR fallback for <0.50 primary confidence.

- New export: `normalizeImageForOCR({ buffer, mediaType }) → { normalized_buffer, resolution_long_edge, format, quality_flags }`
- Operations: EXIF rotation (already works), format conversion (HEIC → JPEG at 85%), resolution normalization (downscale > 2048px long edge; upscale to 1024px if < 1024), blur/glare/darkness detection feeding `quality_flags`
- **Fail-closed:** on any normalization error, return an error envelope, do not pass raw buffer to OCR
- Textract fallback: `services/parser/textractFallback.js` — triggered when Document AI confidence < 0.50 on critical fields

**Completion criteria:** All normalization error paths return typed errors; fixture test with intentionally rotated, blurry, and HEIC images; Textract fallback fires correctly on low-confidence primary.

---

### Integration Sessions (Wire the Foundation Together)

#### Session 6 — `expense.js` CIL Compliance Fix (Standalone Violation Fix)
**Deliverable:** `expense.js` routes all writes through `domain/transactions.js::logExpense(cil, ctx)`. No direct `pgSvc.insertTransaction()` calls remain. The hybrid-payload issue is resolved at the write boundary.

This session does **not** add the auditor or change the parsing logic. It is a Constitution §7 compliance fix, standalone and small in scope.

**Why this is a dedicated session:** the CIL violation has been running in production. Per the Regression Pause Rule, this is a standing regression. Fix it before building more infrastructure on top of it.

**Completion criteria:** Grep for `pgSvc.insertTransaction` in `expense.js` returns zero results; all writes flow through `logExpense()`; existing receipts still get logged correctly; idempotency check preserved.

---

#### Session 7 — CIL Schema Extension + `auditedReceiptToCIL()` Adapter + File Consolidation
**Deliverable:** Three things in one session (they're tightly coupled):

1. Extend `LogExpense` Zod schema in `schemas/cil.js` with optional nested-confidence fields: `merchant`, `date`, `total_cents`, `subtotal_cents`, `tax_cents`, `tax_label` each as `{ value, confidence, source }` objects; plus `validation_flags: string[]`, `receipt_kind: enum`, `currency: string` default 'CAD', `line_items: array`.
2. Build `services/parser/auditedReceiptToCIL.js` — pure function from auditor output → LogExpense CIL.
3. Consolidate `/cil.js` into `/schemas/cil.js`. Update imports across repo (includes quotes spine). Remove root `/cil.js`.

**Completion criteria:** `schemas/cil.js` is the single source of truth for all CIL types; no imports from `/cil.js` remain; `auditedReceiptToCIL()` unit-tested.

---

#### Session 8 — Confidence Router
**Deliverable:** `services/parser/confidenceRouter.js` with hard-coded output `{ routing_decision: 'pending_review' | 'rejected', reason_code, reason_text, fields_flagged }`. No auto-accept branch.

Thresholds (starter defaults, tunable post-telemetry):
- Any critical-field confidence < 0.50 → `rejected` (dead-letter surface, not silently dropped)
- All critical fields ≥ 0.50 but any < 0.70 → `pending_review` with ⚠️ markers
- All critical fields ≥ 0.70 → `pending_review` (no warning)

Every routing decision logs to `parse_jobs` with `trace_id`, per-field confidences, threshold values, final decision.

**Completion criteria:** Unit tests for all threshold branches; explicit assertion that `auto_accept` is not a valid output value; decision log populated in `parse_jobs`.

---

#### Session 9 — Pipeline Integration (WhatsApp + Portal)
**Deliverable:** Both capture paths (WhatsApp via `expense.js` and portal via `/api/intake/items/[id]/confirm/route.ts`) converge on the same pipeline:

```
Ingress → Evidence Capture → Normalization → Primary OCR (Document AI)
  → Confidence Gate
    → [if < 0.50] Fallback OCR (Textract)
    → LLM Auditor (Claude Sonnet 4.5 → GPT-4o fallback)
      → Deterministic Validation
        → Tenant Enrichment (alias lookup, default_job_hint)
          → Auto-Assign Resolution (if active)
            → Confirmation Message Build
              → WhatsApp / Portal Confirm UX
                → Owner Confirms or Edits
                  → [if edit] parse_corrections + vendor_aliases upsert (Session 10)
                  → CIL Draft → domain/transactions.js::logExpense()
                    → Quota consumed (Session 13)
```

Extract the receipt-parse + confirm flow from `expense.js` into `services/expensePipeline.js`. Preserve the PA state machine, job resolution, and WhatsApp send layer in place. Portal confirm endpoint wires through the same pipeline module.

**Completion criteria:** End-to-end test: send a fixture receipt via WhatsApp → pipeline runs all stages → lands in Pending Review → owner confirms → transaction written via CIL. Same flow works for portal upload.

---

### Enrichment Sessions (Build the Moat)

#### Session 10 — Correction Flow + `vendor_aliases` Upsert
**Deliverable:** Per-field edit endpoint and correction capture. This is the enrichment moat.

- `POST /api/intake/items/{id}/field-edit` — accepts `{ field_name, corrected_value }`. Writes `parse_corrections` row. Does NOT confirm the record.
- On confirm (after any merchant correction): upsert `vendor_aliases` with `ON CONFLICT (tenant_id, raw_merchant_normalized) DO UPDATE SET canonical_merchant, confirmation_count = confirmation_count + 1, last_confirmed_at = now()`.
- Portal UI: inline per-field editing in the Pending Review surface (edits land as `parse_corrections` rows, visible in the UI before confirm).

**Completion criteria:** Editing any field writes a `parse_corrections` row with `original_value`, `corrected_value`, `original_source` populated; merchant edits upsert `vendor_aliases`; two-tenant isolation test passes (tenant A's corrections do not affect tenant B's parser output).

---

#### Session 11 — Template Unification + Confirm-Message Bug Diagnosis
**Deliverable:** Confirm-message and logged-expense templates read from the same canonical `audited.result.*` fields. Per-field confidence markers (⚠️) surface in the confirm message when any field confidence < 0.70.

First task: diagnose the `FEB 24` vs `Mar 14, 2026` calendar icon bug. Capture raw Twilio payload + rendered message. If Twilio-side rendering, document the workaround; if code bug, fix at the template layer.

**Completion criteria:** Confirm message and logged-expense message show identical merchant, date, total for the same audited receipt (unit test asserts parity); per-field confidence markers surface correctly; calendar icon bug root cause documented and fixed.

---

#### Session 12 — Auto-Assign Mode + Suggested-Job Logic
**Deliverable:** Per handoff §7 and §9.

- WhatsApp commands: `AUTO`, `AUTO [job]`, `STOP AUTO`, `CHANGE JOB`
- Portal toggle: "Use Active Job as Auto-Assign" in settings
- Daily re-confirmation prompt when auto-assign is active
- Job-close-triggered deactivation
- Suggested-job logic: vendor_aliases.default_job_hint → single active job → recent activity → picker fallback
- Conversational overlay: mid-capture questions answered by Chief without breaking the flow

**Completion criteria:** Auto-assign persists across receipts until explicitly deactivated; re-confirmation prompt fires once per new calendar day; suggested job appears in confirmation message with transparent reasoning.

---

### Business Economics Sessions (Enforce Monetization)

#### Session 13 — Quota Consumption Engine
**Deliverable:** `services/quotas/consumption.js` with separate buckets per feature kind, newest-pack-first consumption, fail-closed plan lookup.

Consumption order:
1. Plan allotment
2. Add-on allotments (newest purchase first)
3. Soft overage (if permitted by plan and within threshold)
4. `OVER_QUOTA` error with upgrade path surfaced

Every consumption writes to `quota_consumption_log`.

**Completion criteria:** Unit tests for consumption order edge cases (empty plan + valid addon, expired addon, multiple addons of different ages); fail-closed on plan lookup failure verified.

---

#### Session 14 — Stripe Add-On Checkout + Webhook
**Deliverable:** Stripe checkout flow for 100/250/500/1,000 add-on packs. Webhook handler with signature verification, idempotency by `stripe_event_id`, quota crediting in a single transaction.

1,000-pack annual limit enforcement:
- 3 purchases per `(owner_id, calendar_year)` maximum
- 3rd purchase: soft Enterprise advisory message
- 4th attempt: block, auto-create Enterprise lead

**Completion criteria:** End-to-end purchase test with Stripe test mode; duplicate webhook delivery does not double-credit; 4th 1,000-pack attempt blocks correctly and creates lead.

---

#### Session 15 — Upsell Prompts + "Chief's Confidence" Widget
**Deliverable:**

- Upsell prompt system: 80%, 100%, approaching-cap triggers. Once-per-(owner, feature, trigger, month) enforcement via unique index on `upsell_prompts_log`. Prompts surface in portal and in WhatsApp.
- "Chief's Confidence" Decision Center widget: receipts captured this month, first-try-correct %, trained vendors count, accuracy trend vs. last month. Available on all tiers including Free.

**Completion criteria:** Upsell prompts fire at correct thresholds; never fire twice in a month for the same trigger; widget populated from `parse_jobs` + `parse_corrections` aggregations; no raw confidence scores or token counts surfaced to owner.

---

### Observability + Rollout Sessions

#### Session 16 — Developer Observability Dashboard
**Deliverable:** Dev-only internal admin page (Supabase-powered initially; Grafana later) with:

- Per-tenant: OCR usage vs cap, soft overage rate, hard cap hits, add-on purchase frequency, upsell conversion rate, bypass rate
- Aggregate: usage distribution by tier, add-on revenue, margin per tenant, Free→Starter→Pro conversion funnel
- Alerts: tenant cost > revenue for 2+ months, hard cap hits, webhook failures, usage spikes, Enterprise auto-leads
- Monthly rollup: blended COGS/margin per tier, cap-approach %, add-on attach rate

**Completion criteria:** Dashboard deployed to dev; all metrics populated from real data; at least 3 alerts wired and firing in test.

---

#### Session 17 — High-Confidence Bypass Flag (Off by Default)
**Deliverable:** Config flag `high_confidence_bypass_enabled` per tenant, default OFF. Telemetry hooks in place to track bypass rate and bypassed-receipt correction rate.

Bypass conditions (all must be true):
- Document AI confidence ≥ 0.95 on merchant, date, subtotal, tax, total
- Merchant matches `vendor_aliases` entry with `confirmation_count ≥ 10`
- Zero validation flags
- Tenant has `high_confidence_bypass_enabled = true`

Even when bypass fires, receipt still routes through Pending Review. No true auto-accept.

**Completion criteria:** Bypass flag wired, off by default; telemetry captures bypass decisions; unit test confirms bypass does not produce `auto_accept` routing decision.

---

#### Session 18 — End-to-End Production Validation
**Deliverable:** Full validation gate before public rollout.

- Two-tenant isolation test (overlapping identifiers, same vendor, different corrections → no leakage)
- Failure injection at each pipeline stage → verify fail-closed behavior, no writes to transactions without owner confirmation
- Idempotency test (re-send same receipt 5x → one parse_job, one transaction, no duplicates)
- Cost verification (per-receipt cost matches model within 20%)
- Accuracy test (500 blind receipts across Canadian and US merchants → ≥ 90% merchant/date/total correct first-pass)
- Pending Review UX (owner confirms on mobile in < 10 seconds)
- Founder confidence test (Execution Playbook §11)

**Completion criteria:** All validation items pass; full test report produced; no CRITICAL or HIGH severity items outstanding.

---

## 5. Dependency Map

```
Session 2 (Schema) ──────┬─────────────────────────────────────────────────┐
                         │                                                 │
                         ▼                                                 ▼
                Session 3 (Validation)                          Session 6 (CIL Compliance Fix)
                         │                                                 │
                         ├──────────────────────┐                          │
                         ▼                      ▼                          │
                Session 4 (Auditor)    Session 5 (Normalization)           │
                         │                      │                          │
                         └──────────┬───────────┘                          │
                                    ▼                                      │
                           Session 7 (CIL Extend/Adapter) ◄────────────────┘
                                    │
                                    ▼
                           Session 8 (Confidence Router)
                                    │
                                    ▼
                           Session 9 (Pipeline Integration)
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
          Session 10 (Correction)  Session 11     Session 12
                                   (Templates)    (Auto-Assign)
                                    │
                                    ▼
                          Session 13 (Quota Engine)
                                    │
                                    ▼
                          Session 14 (Stripe Add-Ons)
                                    │
                                    ▼
                          Session 15 (Upsell + Widget)
                                    │
                                    ▼
                          Session 16 (Observability)
                                    │
                                    ▼
                          Session 17 (Bypass Flag)
                                    │
                                    ▼
                          Session 18 (Production Validation)
```

**Critical path:** Sessions 2 → 4 → 7 → 9 unblock the end-to-end parse. Session 6 (CIL compliance fix) runs in parallel because it's a standalone Constitution repair.

---

## 6. What Stays From the Original Handoff

These sections of `RECEIPT_PARSER_UPGRADE_HANDOFF.md` remain authoritative and are referenced from this plan:

- §3 LLM Auditor Service Specification (8 files, prompt caching)
- §4 High-Confidence Audit Bypass (conditions, flag architecture)
- §5 Schema DDL (table definitions)
- §6 Pipeline Flow (end-to-end diagram)
- §7 Auto-Assign Mode (policy and data model)
- §8 Confirmation Message Template Fix (spec, not timing)
- §9 Suggested-Job Logic (fallback order)
- §10 "Chief's Confidence" Widget (metrics and rules)
- §11 Pricing and Quota Implementation
- §12 Developer Observability Dashboard
- §14 Production Gate criteria
- §15 Non-Goals
- §17 Authority and Conflict Resolution

What this plan replaces: §13 (Build Sequencing) and §16 (What I Need From This Session).

---

## 7. Boundaries Across All Sessions

- The Regression Pause Rule (Execution Playbook §3) applies at every checkpoint.
- No session touches production data.
- No session skips the cross-tenant isolation test before a schema is considered shippable.
- No session enables true auto-accept. Routing decision is restricted to `pending_review | rejected` throughout.
- Every session produces a concrete deliverable file or test artifact.
- Every session ends with a short status report matching the Session 1 format.
- If any session reveals new architectural concerns, flag for plan revision — do not improvise.

---

## 8. Founder Checkpoints

Three decision points in the plan where I'll want founder input before continuing:

1. **After Session 2 (Schema):** Review migration diffs and isolation test results before production deploy.
2. **After Session 9 (Pipeline Integration):** End-to-end test results — is the parser producing output the founder trusts?
3. **After Session 18 (Production Validation):** Go/no-go on public rollout of the upgraded parser.

---

**End of Plan V2.**
