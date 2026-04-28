# Receipt Parser Upgrade — Component Audit Notes

**Date:** 2026-04-20
**Auditor:** Claude Code
**Session:** Receipt Parser Upgrade — Session 1 (Audit)
**Authority:** `RECEIPT_PARSER_UPGRADE_HANDOFF.md`, `03_CHIEFOS_ENGINEERING_CONSTITUTION.md`, `01_CHIEFOS_NORTH_STAR.md`, `02_CHIEFOS_EXECUTION_PLAYBOOK.md`, `04_CHIEFOS_MONETIZATION_AND_PRICING.md`

---

## Summary

The current receipt-parsing pipeline has the right-shaped bones (ingestion, a draft queue, a CIL scaffold, a normalization step) but is significantly diverged from the production-grade target in the handoff. **The three canonical tables in the handoff spec (`parse_jobs`, `vendor_aliases`, `parse_corrections`) do not exist** — the system is instead running on an `intake_items` / `intake_item_drafts` / `intake_item_reviews` pipeline that serves a similar role but with different semantics. **The LLM auditor does not exist in any form** (OCR → direct confirm UI → transactions write, with no auditor layer between OCR and user). **The correction flow does not exist as a dedicated artifact** — edits land in the confirm endpoint as a whole-record update with no per-field correction log and no `vendor_aliases` upsert, meaning the enrichment moat is not being built. **`expense.js` (9,240 lines) is fragile and violates CIL enforcement** — it calls `pgSvc.insertTransaction()` directly rather than routing through `domain/transactions.js::logExpense()`. **The confirm-vs-logged template bug is confirmed**: the confirm message reads `draft.store` (pre-normalization) while the logged-expense message reads `data.store` (post-normalization via `extractReceiptStore()` recovery logic in `normalizeExpenseData()`), producing the "Unknown 🏪 Rona" vs "Store: RONA" divergence.

## Severity Legend

- **CRITICAL** — production risk or violates a binding rule in the Engineering Constitution; must be addressed before shipping the upgrade
- **HIGH** — imminent fragility or a significant trust/accuracy issue; address early in the build sequence
- **MEDIUM** — technical debt or architectural drift; address during integration
- **LOW** — cosmetic or minor; address if time permits

## Findings Summary Table

| # | Component | Highest severity | CRIT / HIGH / MED / LOW | Build-session recommendation |
|---|---|---|---|---|
| 1 | `expense.js` | CRITICAL | 4 / 5 / 5 / 0 | Do NOT attempt a full rewrite in one session. Extract receipt-parse + confirm flow into a dedicated module fronted by the new auditor + validation services. Preserve the PA state machine as-is (it works). Migrate direct `insertTransaction()` calls to route through `domain/transactions.js::logExpense()`. |
| 2 | Confirm-Message Template | CRITICAL | 1 / 1 / 0 / 0 | Unify with logged-expense template by reading from `audited.result.merchant.value` post-auditor. Lock the calendar icon to the same formatted date field. Add a unit test asserting parity. |
| 3 | Logged-Expense Template | MEDIUM | 0 / 0 / 2 / 0 | Same remediation as Component 2 — unify both templates against a single canonical `AuditedReceiptDraft`. The logged template is "accidentally correct" because of `normalizeExpenseData()` recovery; post-fix it should not need recovery logic. |
| 4 | Pending Review Queue | CRITICAL | 7 / 3 / 2 / 0 | **Decision needed before build:** keep `intake_items` as canonical or migrate to `parse_jobs` per handoff §5.1. Either way, add per-field edit endpoint and wire confirm through CIL + idempotency check. |
| 5 | Confidence Router | CRITICAL | 3 / 0 / 0 / 0 | **Does not exist.** Build from scratch as `services/parser/confidenceRouter.js`. Hard-limit output to `pending_review` \| `rejected`. No auto-accept branch. |
| 6 | CIL Draft Transformation | CRITICAL | 2 / 0 / 3 / 0 | Extend `LogExpense` schema with nested `{ value, confidence, source }` fields + `validation_flags` array. Build an `auditedReceiptToCIL()` adapter. Retire duplicate `cil.js` vs `schemas/cil.js` confusion. |
| 7 | Correction Flow | CRITICAL | 6 / 1 / 0 / 0 | **Does not exist.** Build `parse_corrections` table, per-field edit endpoint, and `vendor_aliases` upsert logic. This is the enrichment moat — blocking. |
| 8 | Deterministic Validation | CRITICAL | 3 / 1 / 3 / 0 | **Does not exist as a service.** Build `services/parser/validation.js` with `VALIDATION_FLAGS` enum and `validateReceiptDraft()` function. Centralize scattered checks. |
| 9 | Normalization Service | CRITICAL | 1 / 1 / 3 / 1 | EXIF rotation works; everything else missing. Add resolution normalization (1024–2048px long edge), format standardization (HEIC→JPEG), and fail-closed error handling. |
| 10 | Schema (parse_jobs, vendor_aliases, parse_corrections) | CRITICAL | 19 / 0 / 1 / 0 | Full rebuild required on all seven spec tables (three receipt tables + four quota tables). Follow existing idempotent migration patterns established by quotes-spine and tenant-counters migrations. |

**Total counts:** CRITICAL: 46, HIGH: 11, MEDIUM: 19, LOW: 1

---

## Component 1: `expense.js`

### File Location & Metrics

- **Path:** `C:\Users\scott\Documents\Sherpa AI\Chief\handlers\commands\expense.js`
- **Line count:** 9,240 lines
- **Primary export:** `handleExpense(from, input, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId, twilioMeta)` at line 5106

### Current Responsibilities (End-to-End)

1. **Ingress:** receives WhatsApp messages (text, media, list picks, quick replies) via Twilio, normalizes metadata (MessageSid, ListRowId, InteractiveResponseJson, NumMedia) at lines 5116–5158
2. **Parsing:** extracts receipt fields via regex — total (line 2541), tax (line 2656), date (line 2866), store (line 2928), line items (line 2085); fallback `parseReceiptBackstop()` at line 4088
3. **Pending action (PA) state machine:** confirm drafts stored via `upsertPA()` / `getPA()` with DB + SQL fallback (lines 103–105, 245–277, 298–308)
4. **Confirmation UX:** sends confirm messages via `sendConfirmExpenseOrFallback()` (line 519); handles YES / EDIT / CANCEL
5. **Edit handling:** normalizes edited text (`normalizeEditedExpense`, line 157), reparses (`maybeReparseConfirmDraftExpense`, line 1052), extracts explicit dates (line 209)
6. **Job assignment:** job picker list via `sendJobPickList()` (line 3696); resolves UUID/job_no/name/index via `bestEffortResolveJobFromText()` (line 1344); persists active job (line 3964)
7. **CIL build:** `buildExpenseCIL_LogExpense()` at line 4005, Legacy fallback at line 4020, validated via Zod `validateCIL()` at line 4066
8. **DB write:** `insertExpenseBestEffort()` at line 5029 → routes through multiple helper names (`insertExpense`, `createExpense`, `logExpense`, `insertTransaction`) at lines 5031–5068; `buildInsertPayload()` at line 7672–7705 resolves `tenant_id` from `userProfile?.tenant_id` or `ownerProfile?.tenant_id`
9. **WhatsApp send:** `sendWhatsAppTemplate()` (line 567), `sendWhatsApp()` (line 580), `sendWhatsAppInteractiveList()` (line 3837)
10. **Plan gating:** effective plan resolution at line 5252 (`getEffectivePlanFromOwner`); employee self-log capability check at line 89

### Call Graph

```
handleExpense()
├─ getPA() → pg.getPendingActionByKind() OR SQL fallback
├─ getInboundTextExpense() → raw inbound text extraction
├─ extractReceiptTotal/Date/Store/TaxBreakdown() → draft fields (regex)
├─ parseReceiptBackstop() → fallback amount/date/store
├─ upsertPA() → pg.upsertPendingAction() OR SQL INSERT/ON CONFLICT
├─ sendConfirmExpenseOrFallback() → sendWhatsAppTemplate() → twilioSvc
├─ parseExpenseEditOverwrite() / maybeReparseConfirmDraftExpense()
├─ bestEffortResolveJobFromText() / listOpenJobsDetailed() → pg.query() jobs
├─ sendJobPickList() → sendWhatsAppInteractiveList()
├─ persistActiveJobFromExpense() → pg.query() users UPDATE
├─ buildExpenseCIL_LogExpense() / buildExpenseCIL_Legacy()
├─ validateCIL() → cilMod.validateCIL() (Zod)
├─ upsertCilDraftForExpenseConfirm() → pg.query() cil_drafts
├─ insertExpenseBestEffort() → pgSvc.insertTransaction() → public.transactions   ⚠️ bypasses CIL
├─ sendWhatsApp() → twilioSvc.sendWhatsApp() (final logged notification)
└─ console.info/warn (diagnostic telemetry)
```

### Control Flow — Happy Path and Branches

**Happy path:** owner sends receipt photo + text → text parsed + media stored → confirm shown → YES → job resolved/picked → `insertTransaction()` → logged notification sent.

**Branches observed:**
- **Image attached:** `NumMedia > 0` → media metadata extracted (line 5156), but **no OCR call is visible in this file** — OCR must happen upstream or was never wired
- **Edit after confirm:** `applyEditPayloadToConfirmDraft()` at line 4593 → reparses → re-shows confirm
- **Job ambiguous:** job picker shown → owner selects from numbered list
- **Employee submission:** `ownerProfile?._employeeSubmission` sets `submission_status = 'pending_review'` (line 7703), otherwise `confirmed`
- **PA expired race:** falls back to `resendConfirmExpense()` (line 760); no explicit locking — possible double-confirm race

### Error Handling

| Scenario | Handling | Severity |
|---|---|---|
| Missing `ownerId` | Gated by router upstream; fail-closed | HIGH |
| Invalid amount | `parseReceiptBackstop()` returns null → manual entry | MEDIUM |
| No store detected | Defaults to "Unknown Store" (lines 2941, 5048) | MEDIUM |
| No date detected | Defaults to today (lines 2866, 4094) | MEDIUM |
| Job lookup fails | Caught, logged `warn`, continues (line 1736: `.catch(() => null)`) | MEDIUM |
| Missing `tenant_id` | `insertTransaction()` throws at `postgres.js:1791` (late, during cols/vals build) | **CRITICAL** |
| PA lookup fails | SQL fallback, returns null (lines 274–276) | MEDIUM |
| `validateCIL()` fails | Falls back to Legacy CIL variant (lines 4069–4072) | MEDIUM |
| `sendWhatsApp` fails | Logged `warn`, no retry (lines 3850, 7968) | MEDIUM |
| DB write timeout (>4s) | PA already upserted, handler shows "⚠️ Timeout" but **does NOT roll back** | HIGH |

### Tenant Safety (Engineering Constitution §2)

**Safe patterns observed:**
- Pending actions filtered by `(owner_id, user_id, kind)` (lines 264, 308, 319)
- Jobs filtered by `owner_id` (lines 1703, 3358)
- `tenant_id` passed through to `insertTransaction` from profile (lines 5058, 7674)

**Issues:**
- Tenant resolution depends on `resolveTenantIdForOwner()` inside `postgres.js` (line 1598); if that function is wrong, writes could leak to the wrong tenant
- Missing tenant_id check fires **late** at `postgres.js:1791` during cols/vals building, not at query entry — stack traces are hard to trace to `expense.js`
- Media asset handling inside `upsertCilDraftForExpenseConfirm()` does not enforce tenant boundary directly; assumes `insertTransaction` will catch it

### Idempotency (Engineering Constitution §8)

**Primary mechanism — `source_msg_id`:**
- Stored on insert (line 5057)
- Pre-check at `postgres.js:1773–1778`: `SELECT id FROM public.transactions WHERE owner_id=$1 AND source_msg_id=$2 LIMIT 1`

**Secondary mechanism — `dedupe_hash` (content-based):**
- Per-kind dedupe (`postgres.js:1761`); hash from `owner, kind, date, amountCents, source, description, jobNo, jobName` (line 1767)
- Per-item inserts (`:i<N>` suffix) skip hash to avoid blocking (line 1764)

**Issues:**
- PA state machine has a race: YES received after confirm PA expires (TTL 10 min) → PA deleted but message still inbound → handler falls back to `resendConfirmExpense()`; no explicit lock prevents double-confirm if two inbound messages race. Severity: MEDIUM.

### CIL Compliance (Engineering Constitution §7)

**🚨 CRITICAL VIOLATION.** `expense.js` builds a `LogExpense` CIL (line 4005) and validates it (line 4066), but then calls `pgSvc.insertTransaction()` **directly** (line 5037) with a **hybrid payload** (mixes CIL fields with raw expense handler fields, including duplicate keys like `source: p.store, store: p.store`).

The domain wrapper `domain/transactions.js::logExpense(cil, ctx)` exists and wraps `insertTransaction` correctly. `expense.js` does not call it. This is a direct violation of Engineering Constitution §7:

> "All ingestion must follow: Ingress → CIL Draft → Validation → Domain Mutation. No direct ingestion-to-database designs."

### Code Quality Concerns

| # | Concern | Location | Severity |
|---|---|---|---|
| 1 | 9,240-line monolithic file handles ingress + parsing + UI + job resolution + DB write + error recovery in one module | Whole file | HIGH |
| 2 | Direct `insertTransaction()` call bypasses domain mutation layer | Line 5037 | **CRITICAL** |
| 3 | No LLM auditor integration (no Document AI / Textract / Anthropic / OpenAI calls in file) | N/A | **CRITICAL** |
| 4 | Regex extraction for total/date/store/tax is undocumented, untested visibly, fragile at edge cases | Lines 2541, 2656, 2866, 2928, 2085 | HIGH |
| 5 | `tenant_id` missing check fires late (postgres.js:1791), hard to diagnose | Postgres.js | **CRITICAL** |
| 6 | Race condition in PA state machine (no explicit locking on confirm transitions) | Lines 760–842 | MEDIUM |
| 7 | Fallback function resolution cascade via `typeof pg.X === 'function'` (lines 42–47, 50–59) — if pg interface changes, silent fallback to defaults | Lines 42–86 | HIGH |
| 8 | Silent fallback in job resolution swallows DB errors (`resolveJobRow().catch(() => null)`) | Line 1736 | MEDIUM |
| 9 | Two CIL variants (LogExpense + Legacy) — unclear which is canonical; Legacy hardcodes currency to `'CAD'` | Lines 4005, 4020; domain/transactions.js:44 | MEDIUM |
| 10 | Magic numbers — PA_TTL_MIN=10, timeoutMs=4000, various inline thresholds; no env-backed configuration | Lines 87, 103, 5035 | MEDIUM |
| 11 | No visible test coverage for parse functions, CIL build, or job resolution | N/A | HIGH |
| 12 | Weak identity normalization — `DIGITS_ID` strips non-digits but doesn't validate E.164 | Lines 122, 130 | MEDIUM |
| 13 | Hybrid insert payload (mixes CIL fields + raw handler fields, duplicate keys) | Lines 5037–5067 | HIGH |
| 14 | No deterministic validation of parsed fields before CIL build (future date, amount > $1M, "Unknown" store all pass through silently) | N/A | HIGH |

### Recommendations for Build Phase

1. **Do not attempt a full rewrite.** 9,240 lines cannot be safely replaced in one session. Extract the receipt/expense flow (parse → confirm → CIL → write) into a new module (`services/expensePipeline.js` or equivalent) and have `expense.js` delegate to it.
2. **Route all writes through `domain/transactions.js::logExpense()`.** Remove direct `pgSvc.insertTransaction()` calls from `expense.js`. This satisfies CIL enforcement.
3. **Replace regex extraction with auditor call.** Once Component 5 (auditor service) lands, `extractReceiptTotal/Date/Store/TaxBreakdown` become fallback-only; primary parsing is auditor output.
4. **Fail-closed on tenant resolution at entry.** Add tenant_id validation at `handleExpense` entry, not deep inside `insertTransaction`.
5. **Preserve the PA state machine.** It works. Do not refactor the pending-action mechanics during this upgrade.
6. **Move magic numbers to env-backed config.** At minimum: TTLs, timeouts, retry counts.

---

## Component 2: Confirm-Message Template (WhatsApp)

### File Locations

- **Primary:** `C:\Users\scott\Documents\Sherpa AI\Chief\handlers\commands\expense.js` lines **661–758** (`buildExpenseSummaryLine()`) and lines **790–839** (`resendConfirmExpense()`)
- **Send layer:** `C:\Users\scott\Documents\Sherpa AI\Chief\services\twilio.js` lines 358–367 (`sendWhatsAppTemplate()`)
- **Twilio Content Template:** `C:\Users\scott\Documents\Sherpa AI\Chief\twilio_content_HX0227161750ca6425e274bc289cf00819.json` — single variable template `{1: summaryLine}`

### Template Source & Data Shape

`buildExpenseSummaryLine({ amount, item, store, date, jobName, subtotal, tax, total, taxLabel, tz })` accepts a flat object sourced from the confirm PA payload. The template is assembled as a multi-line string and passed as `{1}` into the Twilio Content Template.

### The Bug — Merchant Field Divergence

**Confirm message reads `draft.store` at line 799** (inside `resendConfirmExpense()`):
```js
store: draft.store,  // line 799 — raw from PA payload, pre-normalization
```
Then rendered at line 750:
```js
lines.push(`🏪 ${st}`);
```
Where `st` defaults to `"Unknown Store"` at line 712 if `draft.store` is empty.

**Logged-expense template reads `data.store` at line 7922** (post-`normalizeExpenseData()`):
```js
const confirmedStore = String(data?.store || draftForSubmit?.store || '').trim();
```
The critical difference: `normalizeExpenseData()` at lines 1824–1826 has **recovery logic** that re-runs `extractReceiptStore()` on the raw receipt text if `draft.store` is weak:
```js
if (storeWeak && src && typeof extractReceiptStore === 'function') {
  const receiptStore = extractReceiptStore(src);
  if (receiptStore) d.store = receiptStore;
}
```

**Result:** confirm renders the original (weak) `draft.store` value, logged renders the recovered value. User sees "Unknown 🏪 Rona" at confirm, then "Store: RONA" after YES.

### Date Icon Handling

- Calendar emoji `📅` is **hardcoded** at line 751: `lines.push(\`📅 ${dt}\`);`
- `dt` = `formatDisplayDate(date, tz)` at line 714
- Both the icon and the text come from the same `draft.date` field — **the icon is not reading a separate field**
- **Root cause of "FEB 24" vs "Mar 14, 2026" mismatch is most likely Twilio-side rendering** (timezone coercion in the Content Template render, or WhatsApp's own calendar-emoji text rendering layered on the emoji), not a code-level field-mapping bug
- Confidence on this diagnosis: moderate — recommend testing with different date values and capturing Twilio's raw payload vs. the rendered WhatsApp message before assuming the template code is correct

### All Fields Currently Rendered (Confirm Message)

| Variable | Source field | Line | Fallback |
|---|---|---|---|
| Amount (💸) | `draft.amount` | 797 | formatted via `formatMoneyDisplay()` |
| Item | `draft.item` | 798 | "Unknown" (line 705) |
| **Merchant (🏪)** | **`draft.store` (pre-normalize)** | **799** | **"Unknown Store" (line 712) ← BUG** |
| Date (📅) | `draft.date` | 800 | formatted via `formatDisplayDate()` |
| Job | `draft.jobName` | 801 | omitted if empty |
| Subtotal | `draft.subtotal` | 804 | omitted if empty |
| Tax | `draft.tax` | 805 | omitted if empty |
| Total | `draft.total` | 806 | omitted if empty |
| Tax Label | `draft.taxLabel` | 807 | omitted if empty |

### Severity & Recommendations

| Issue | Severity |
|---|---|
| Merchant field divergence between confirm and logged templates | **CRITICAL** |
| Date icon appearing mismatched (likely Twilio render, needs verification) | HIGH |

**Recommendations:**
1. **Unify against `AuditedReceiptDraft`.** Post-auditor integration, both templates read from `audited.result.merchant.value` (or the CIL `merchant.value` if a nested schema is adopted in Component 6).
2. **Add a unit test.** Assert that for a given audited receipt, `buildConfirmSummary()` and `buildLoggedSummary()` produce the same merchant and date strings.
3. **Verify date icon source.** Before implementing any fix, capture raw Twilio payload vs. rendered message for a known receipt and confirm the diagnosis (Twilio render vs. code).
4. **Add per-field confidence markers** per handoff §8 — if a field has `confidence < 0.70`, prepend ⚠️ and add the "tap EDIT to verify" note.

---

## Component 3: Logged-Expense Template (WhatsApp)

### File Locations

- **Primary:** `C:\Users\scott\Documents\Sherpa AI\Chief\handlers\commands\expense.js` lines **7872–7978** (YES handler logged confirmation)
- **Normalization dependency:** `normalizeExpenseData()` at lines 1732–1895, specifically the store-recovery branch at lines 1824–1826

### Template Source & Data Shape

Built inline in the YES handler. Uses a mix of:
- `data.store`, `data.item`, `data.date`, `data.jobName`, `data.category` (normalized values)
- `draftForSubmit?.subtotal`, `draftForSubmit?.tax`, `draftForSubmit?.total` (raw draft values)
- `confirmedSubtotalNum`, `confirmedTaxNum`, `confirmedTotalNum` (computed)

### Why This Template Is (Accidentally) Correct

`normalizeExpenseData()` runs at line 7571 just before the logged message is built. Its `storeWeak` check (lines 1817–1822) and recovery call (lines 1824–1826) to `extractReceiptStore()` re-extract the store from raw receipt text if the draft value is empty/unknown. The logged template then reads the recovered value.

### Divergence From Confirm Template

| Field | Confirm reads | Logged reads | Why they diverge |
|---|---|---|---|
| **Merchant** | `draft.store` (pre-normalize) | `data.store` (post-normalize, with `extractReceiptStore()` recovery) | Normalization only runs before submit, not before confirm |
| Amount | `draft.amount` | `confirmedSubtotalNum` (derived) | Different arithmetic; logged has fallback chain |
| Date | `draft.date` (formatted) | `data.date` (normalized, formatted) | Same semantic source but may differ in tz handling |
| Item | `draft.item` | `data.item` | Same semantic source, different cleanup logic |
| Job | `draft.jobName` | `jobName` (from earlier handler context) | Consistent source, different variable names |
| Category | not shown | `categoryStr` | Only surfaced in logged |
| Subtotal | `draft.subtotal` | `confirmedSubtotalNum` | Different arithmetic |
| Tax | `draft.tax` | `confirmedTaxNum` | Different arithmetic |
| Total | `draft.total` | `confirmedTotalNum` (has fallback) | Logged has fallback chain, confirm uses draft directly |

### Severity & Recommendations

| Issue | Severity |
|---|---|
| "Accidentally correct" behavior depends on `normalizeExpenseData()` recovery logic | MEDIUM |
| Arithmetic divergence between templates (different `subtotal`/`tax`/`total` computation paths) | MEDIUM |

**Recommendations:**
1. **Canonical field list for unification (both templates should read these after the upgrade):**
   - `audited.result.merchant.value`
   - `audited.result.date.value`
   - `audited.result.total_cents.value`
   - `audited.result.subtotal_cents.value`
   - `audited.result.tax_cents.value`
   - `audited.result.tax_label.value`
   - `audited.result.currency`
   - `audited.job.id` + `audited.job.name` (from auto-assign or enrichment)
   - `audited.category`
2. **After unification, `normalizeExpenseData()` recovery can be deprecated** — the auditor produces canonical values once, both templates consume the same object.

---

## Component 4: Pending Review Queue

### File Locations

**Backend (portal):**
- `C:\Users\scott\Documents\Sherpa AI\Chief\chiefos-site\app\api\intake\items\route.ts` — list endpoint
- `C:\Users\scott\Documents\Sherpa AI\Chief\chiefos-site\app\api\intake\items\[id]\confirm\route.ts` (853 lines) — confirm endpoint
- `C:\Users\scott\Documents\Sherpa AI\Chief\chiefos-site\app\api\intake\items\[id]\delete\route.ts` — delete endpoint

**Frontend (portal):**
- `C:\Users\scott\Documents\Sherpa AI\Chief\chiefos-site\app\app\pending-review\page.tsx` — **stub only** (redirects to `/app/uploads?tab=review`)
- `C:\Users\scott\Documents\Sherpa AI\Chief\chiefos-site\app\app\uploads\page.tsx` — actual review UI lives inline here
- `C:\Users\scott\Documents\Sherpa AI\Chief\chiefos-site\app\app\components\intake\ReviewConveyor.tsx` — review widget

**WhatsApp:** none — WhatsApp pending-state uses `pending_actions` table (separate pipeline), not `intake_items`.

### Schema Backing the Queue

**The queue is NOT backed by `parse_jobs` as the handoff specifies.** It uses:

| Table | Purpose |
|---|---|
| `intake_batches` | groups upload sessions (kinds: receipt_image_batch, voice_batch, pdf_batch, mixed_batch, email_batch) |
| `intake_items` | per-item row (kinds: receipt_image, voice_note, pdf_document, unknown, email_lead; status: pending_review → persisted) |
| `intake_item_drafts` | OCR result, `confidence_score`, `draft_amount_cents`, `draft_vendor`, `draft_event_date`, `draft_job_name`, `validation_flags`, `raw_model_output` |
| `intake_item_reviews` | audit trail of confirm actions (action: `confirm` \| `edit_confirm`) |

**The handoff tables (`parse_jobs`, `parse_corrections`, `vendor_aliases`) do not exist.**

### Flow

```
Upload (portal/WhatsApp/email) → intake_batch created
  → intake_items created (status: pending_review)
    → intake_item_drafts populated with OCR + validation_flags
      → Portal renders in /app/uploads (review tab)
        → User POSTs to /api/intake/items/{id}/confirm
          → Transaction inserted directly into public.transactions (source='upload')
          → intake_items.status → 'persisted'
          → intake_item_reviews logged (action: 'confirm' or 'edit_confirm')
```

### Per-Field Editing

**Not explicitly supported.** The confirm endpoint at lines 150–206 accepts a request body with edited fields (vendor, eventDate, jobName, amountCents, etc.), bundles them into one transaction write, and logs `action: 'edit_confirm'` if `body.edited` was true. But there is:
- **No separate per-field edit endpoint**
- **No per-field audit row** (no `parse_corrections` table exists)
- **No `vendor_aliases` upsert when merchant is corrected**

### Correction Capture

**Does not exist.** Edits are captured at confirm time as a whole-record mutation. The correction signal is lost — next receipt from the same vendor will not benefit from the learned correction.

### Tenant Safety

**Correct.** Confirm endpoint at lines 155–157:
```ts
.from("intake_items")
.eq("tenant_id", ctx.tenantId)  // ✅ tenant boundary enforced
.eq("id", itemId)
```
Portal access control at lines 138–144: role check (owner/admin/board) via `getPortalContext()` (lines 46–78).

### Identified Gaps vs. Handoff §6 (Pipeline Flow)

| Pipeline stage | Handoff requires | Current | Status |
|---|---|---|---|
| Ingress | WhatsApp / Email / Portal | Portal ✓, WhatsApp (separate `pending_actions`), Email partial | ⚠️ split pipelines |
| Evidence Capture | hash + `parse_jobs` row | `intake_items` instead | ⚠️ different table |
| Normalization | yes | EXIF rotation only | ❌ incomplete |
| Primary OCR with confidence gate | yes | stored in draft, no gate | ❌ |
| Fallback OCR (Textract) | if <0.50 | not implemented | ❌ |
| LLM Auditor | primary + fallback | not implemented | ❌ CRITICAL |
| Deterministic Validation | math, date, merchant, currency | `validation_flags` stored, not enforced | ❌ |
| Tenant Enrichment | alias lookup, default_job_hint | no `vendor_aliases` | ❌ |
| Auto-Assign Resolution | AUTO mode | not implemented | ❌ |
| Confirmation Message (per-field confidence) | yes | not surfaced | ❌ |
| Owner Confirms or Edits → `parse_corrections` + upsert `vendor_aliases` | yes | confirm only, no corrections | ❌ CRITICAL |
| CIL Draft → transactions | idempotent write | direct write, no CIL wrapper | ❌ |
| Quota consumption | per-bucket order | not implemented | ❌ |
| Upsell prompt | 80% / 100% / approaching-cap | not implemented | ❌ |

### Severity & Recommendations

| Concern | Severity |
|---|---|
| No `parse_jobs` table (intake_items used instead) | **CRITICAL** |
| No `parse_corrections` table | **CRITICAL** |
| No `vendor_aliases` table | **CRITICAL** |
| No per-field edit endpoint | **CRITICAL** |
| Direct `transactions` write bypasses CIL + no idempotency check | **CRITICAL** |
| No LLM auditor integration | **CRITICAL** |
| No per-field confidence surfacing in UI | HIGH |
| Role-based access control (not user-scoped) — portal admin can confirm another user's receipts | HIGH |
| Validation flags stored but override via `force=true` allows bypass | HIGH |
| No auto-assign mode | MEDIUM |
| Frontend `/app/pending-review/page.tsx` is a stub redirect | MEDIUM |

**Recommendations:**
1. **Decide before build: `intake_items` vs `parse_jobs`.** The handoff spec calls for `parse_jobs`. Option A: create `parse_jobs` and deprecate `intake_items` with a view alias during transition. Option B: update the handoff to adopt `intake_items` and add the missing columns (`ocr_primary_confidence`, `llm_auditor_result`, `bypass_reason`, `routing_decision`, `trace_id`, etc.). **Recommend Option A** — the handoff names `parse_jobs` for a reason (it's receipt-pipeline-specific, not a generic intake surface).
2. **Build a dedicated review page.** The `/app/pending-review` stub must become a real queue UI with per-field inline editing.
3. **Wire confirm endpoint through CIL.** Replace direct `transactions.insert` with `domain/transactions.js::logExpense(cil, ctx)`.
4. **Enforce idempotency** — add unique constraint `(owner_id, source_msg_id, kind)` on `transactions` and pre-check before insert.

---

## Component 5: Confidence Router

### Current State

**Does not exist.** The file `services/llm/router.js` (95 lines) does exist but is the **wrong component** — it is a query-intent router that decides Anthropic vs OpenAI for financial analysis queries based on keyword regexes (`FINANCIAL_SIGNAL_RE`, `STRUCTURED_TASK_RE`), with a rollout gate `LLM_ROUTER_ANTHROPIC_PERCENT`. It has no connection to receipt confidence, OCR results, or routing decisions for parsed receipts.

### Current Implicit Routing Behavior

Every receipt that parses goes straight to the confirm UI (via `sendConfirmExpenseOrFallback()` in `expense.js:519`) or the Pending Review portal surface. There is no confidence gate, no auto-accept branch, and no auditor output to route on.

**Implicitly, the current behavior is "all-auto-accept-pending-confirmation"** — no receipt is ever rejected before reaching the owner.

### CRITICAL CHECK: Auto-Accept Bypass

**Result:** No explicit auto-accept code path exists. The implicit behavior is that all receipts reach the owner via confirm UI / Pending Review, so the handoff's requirement ("no auto-accept enabled in this upgrade") is accidentally satisfied today — but once an auditor is introduced, a confidence-based skip-confirm branch will be tempting and must be explicitly prohibited.

### Severity & Recommendations

| Concern | Severity |
|---|---|
| No confidence router exists | **CRITICAL** |
| No `routing_decision` field anywhere in the data model | **CRITICAL** |
| No explicit guard against future auto-accept branches | **CRITICAL** |

**Recommendations:**
1. **Create `services/parser/confidenceRouter.js`.** Accepts `AuditedReceiptDraft` + `parse_jobs` row context. Returns `{ routing_decision: 'pending_review' \| 'rejected', reason_code, reason_text, fields_flagged }`.
2. **Hard-code the enum to two values.** `pending_review` and `rejected`. No auto-accept. Document that future auto-accept (high-confidence bypass) is behind a feature flag per handoff §4 and defaults off.
3. **Threshold policy (starter defaults):**
   - Any critical-field (merchant/date/total/tax) confidence < 0.50 → `rejected`
   - All critical fields ≥ 0.50 but any < 0.70 → `pending_review` with ⚠️ markers
   - All critical fields ≥ 0.70 → `pending_review` (no warning)
   - `rejected` means routed to a dead-letter surface, not silently dropped
4. **Log every routing decision.** `trace_id`, confidence scores per field, threshold values used, final decision — feeds the Developer Observability Dashboard.

---

## Component 6: CIL Draft Transformation

### File Locations

- `C:\Users\scott\Documents\Sherpa AI\Chief\cil.js` (root, 190 lines) — legacy CIL with more types
- `C:\Users\scott\Documents\Sherpa AI\Chief\schemas\cil.js` (49 lines) — newer, simpler subset
- `C:\Users\scott\Documents\Sherpa AI\Chief\domain\transactions.js` — wraps CIL for insert (`logExpense`, `logRevenue`)
- `C:\Users\scott\Documents\Sherpa AI\Chief\domain\receipt.js` — `logReceipt`
- `C:\Users\scott\Documents\Sherpa AI\Chief\handlers\commands\expense.js:4005` — `buildExpenseCIL_LogExpense()` builder

### Current Input Shape (LogExpense CIL)

Flat schema, no confidence nesting, no validation flags:

```js
{
  type: 'LogExpense',
  job: string | undefined,
  item: string (min 1),
  amount_cents: int nonneg,
  store: string | undefined,
  date: string | undefined,  // ISO
  category: string | undefined,
  media_url: string url | undefined,
}
```

### Current Output & Domain Path

```
expense.js buildExpenseCIL_LogExpense()
  ↓ CIL object
cil.js validateCIL() (Zod)
  ↓ validated CIL
domain/transactions.js logExpense(cil, ctx)
  ↓ extracts fields + ctx metadata
postgres.js insertTransaction()
```

**But:** `expense.js` does not actually call `domain/transactions.js::logExpense()` — it builds the CIL, validates it, then calls `pgSvc.insertTransaction()` directly with a hybrid payload (see Component 1). The CIL validation is a ceremony step that doesn't gate the write path.

### Target Shape (from Handoff §3, §5)

`AuditedReceiptDraft` requires per-field `{ value, confidence, source }` objects for merchant, date, subtotal_cents, tax_cents, total_cents, tax_label — plus `validation_flags`, `line_items`, `confidence_summary`, `receipt_kind`, `currency`.

### Gaps

| Gap | Severity |
|---|---|
| No per-field confidence nesting in LogExpense schema | **CRITICAL** |
| No `validation_flags` array in LogExpense | **CRITICAL** |
| No `line_items` array | MEDIUM |
| Missing `receipt_kind` enum and `currency` field | MEDIUM |
| No fallback handling for low-confidence fields in domain layer | MEDIUM |
| Two CIL files (`/cil.js` and `/schemas/cil.js`) — unclear which is authoritative | MEDIUM |

### Recommendations for Build Phase

1. **Extend LogExpense schema** with optional nested-confidence fields alongside the existing flat fields (for backwards compatibility during transition):
   ```js
   merchant: z.object({ value, confidence, source }).optional(),
   date: z.object({ value, confidence, source }).optional(),
   total_cents: z.object({ value, confidence, source }).optional(),
   subtotal_cents: z.object({ value, confidence, source }).optional(),
   tax_cents: z.object({ value, confidence, source }).optional(),
   tax_label: z.object({ value, confidence, source }).optional(),
   validation_flags: z.array(z.string()).optional(),
   receipt_kind: z.enum(['receipt','invoice','unknown']).optional(),
   currency: z.string().default('CAD'),
   line_items: z.array(z.object({...})).optional(),
   ```
2. **Build `auditedReceiptToCIL()` adapter** in `services/parser/auditedReceiptToCIL.js`. Pure transformation from auditor output to LogExpense CIL.
3. **Update `domain/transactions.js::logExpense()`** to accept both flat and nested shapes during the transition (`cil?.merchant?.value ?? cil?.store`).
4. **Retire `/cil.js` or `/schemas/cil.js`.** Decide which is canonical and remove the other (or re-export from one to the other).

---

## Component 7: Correction Flow

### Current State

**Does not exist.** Search for `parse_corrections`, `correction`, `vendor_aliases`, `upsert.*vendor` across `.js` / `.ts` files (excluding `node_modules`, `.next`) returns zero matches.

The only correction-adjacent behavior is `intake_item_reviews.action = 'edit_confirm'` at `confirm/route.ts:785`, which is a single log row per confirm — not a per-field correction log, not a vendor-alias writer.

### What Should Exist (per Handoff §2 item 7, §5.2, §5.3, §6)

- `parse_corrections` table capturing per-field edits (tenant_id, owner_id, parse_job_id, field_name, original_value, corrected_value, original_source)
- `vendor_aliases` table (tenant-scoped merchant normalization memory)
- Correction endpoint: `POST /api/intake/items/{id}/field-edit` that writes a `parse_corrections` row and upserts `vendor_aliases` with `confirmation_count + 1` and `last_confirmed_at = now()` whenever the merchant field is corrected

### Critical Failure: Enrichment Moat Not Being Built

Every owner correction in the current system is a one-shot whole-record fix. The correction knowledge is discarded. The next receipt from the same vendor starts from zero OCR quality again. This is the enrichment moat described in handoff §9 (Suggested-Job Logic) and §10 ("Chief's Confidence" widget) — and it is not being built today.

### Severity & Recommendations

| Concern | Severity |
|---|---|
| `parse_corrections` table does not exist | **CRITICAL** |
| `vendor_aliases` table does not exist | **CRITICAL** |
| No per-field edit endpoint | **CRITICAL** |
| No `vendor_aliases` upsert on merchant correction | **CRITICAL** |
| No per-field audit trail — enrichment moat not being built | **CRITICAL** |
| Idempotency on confirm not explicitly enforced (relies on downstream unique constraints that may not exist) | **CRITICAL** |
| No tenant isolation tests for correction path (component missing entirely) | HIGH |

**Recommendations:**
1. **Create `parse_corrections` table** per handoff §5.3.
2. **Create `vendor_aliases` table** per handoff §5.2 (includes `default_job_hint`, load-bearing for §9 Suggested-Job Logic).
3. **Build field-edit endpoint.** Accepts `{ field_name, corrected_value }`. Writes `parse_corrections` row. Does NOT confirm — owner still needs to confirm the full record after editing.
4. **Build `vendor_aliases` upsert.** On confirm (after any merchant correction): upsert with `ON CONFLICT (tenant_id, raw_merchant_normalized) DO UPDATE SET canonical_merchant, confirmation_count = confirmation_count + 1, last_confirmed_at = now()`.
5. **Two-tenant isolation test** required before rollout per Engineering Constitution §6.

---

## Component 8: Deterministic Validation Layer

### Current State

**No dedicated validation service exists.** Search for `services/validation.js`, `services/parser/validation.js`, or equivalent returns nothing.

### Implicit Validation Rules (Scattered)

| Rule | Location | Flag? | Notes |
|---|---|---|---|
| Amount must be positive integer cents | `postgres.js:1548` | No — throws | Halts insert |
| Date coerced to ISO or today | `domain/transactions.js:4–15` | No — silent coercion | Hides bad dates |
| Vendor normalized | `expense.js:1507` (`normalizeVendorSource`) | No | Not tracked as a flag |
| Source poison values ("job …", "on", "off") | `postgres.js:1510–1518` | Logged `[TXN_SOURCE_GARBAGE]` | Not flagged in output |
| Job name poison (commands, error keywords) | `postgres.js:1611–1642` | Logged `[TXN] dropping poison resolvedJobName` | Not flagged in output |

### Missing Validation Rules (per Handoff §6, §8)

| Flag | Purpose | Status |
|---|---|---|
| `MATH_MISMATCH` | subtotal + tax ≠ total (> 5 cents) | **missing** |
| `DATE_OUT_OF_RANGE` | > 90 days past or > 30 days future | **missing** |
| `AMOUNT_SANITY` | ≤ 0 or > $9.99M | partial (throws at insert) |
| `MERCHANT_MISSING` | value is "Unknown Store" or blank | **missing** (silent default) |
| `INVALID_CURRENCY` | not in ISO 4217 list | **missing** (hardcoded to CAD) |
| `TAX_MISMATCH` | declared tax rate doesn't match math | **missing** |
| `DUPLICATE_RECEIPT` | same merchant/amount/date within 24h | **missing** (dedupe exists but not flagged) |
| `INVALID_LINE_ITEM` | malformed line item | **missing** |

### Severity & Recommendations

| Concern | Severity |
|---|---|
| No validation service exists | **CRITICAL** |
| No flag constants enum (`VALIDATION_FLAGS`) defined | **CRITICAL** |
| Math reconciliation (`MATH_MISMATCH`) not implemented | **CRITICAL** |
| Validation logic scattered across 3+ files, no single source of truth | HIGH |
| No observability (parse_jobs.validation_flags not populated) | MEDIUM |
| Short-circuit behavior undefined (should a flag block confirm or just surface?) | MEDIUM |
| No duplicate-receipt flag (dedupe silent) | MEDIUM |

**Recommendations:**
1. **Create `services/parser/validation.js`** with `VALIDATION_FLAGS` enum and `validateReceiptDraft(draft, ctx)` pure function returning a string array.
2. **Rule order (deterministic):** math reconciliation → date range → amount sanity → merchant sanity → currency sanity → duplicate check → line item validation. All rules run (no short-circuit); all flags accumulate.
3. **Fail-open.** Validation surfaces flags, it does not block confirm. The owner decides with flags visible in the UI.
4. **Store flags** in `parse_jobs.validation_flags` for observability.

---

## Component 9: Normalization Service

### File Location

- `C:\Users\scott\Documents\Sherpa AI\Chief\utils\visionService.js` (318 lines)
- Exports: `{ extractTextFromImage }`
- Key function: `normalizeOrientation(buf)` at lines 41–49

### Current Operations

**Only EXIF auto-rotation** via `sharp(buf).rotate().toBuffer()`:

```js
async function normalizeOrientation(buf) {
  if (!sharp || !buf) return buf;
  try {
    return await sharp(buf).rotate().toBuffer();
  } catch (e) {
    console.warn('[visionService] normalizeOrientation failed (ignored):', e?.message || e);
    return buf;  // ← FAIL-OPEN
  }
}
```

### Operations NOT Implemented

- Resolution normalization (1024–2048px long edge per handoff §3)
- Deskew
- Contrast / brightness adjustment
- Format conversion (HEIC → JPEG for iOS photos)
- Downscaling / upscaling
- Blur / glare / darkness detection
- Perspective correction
- Quality reduction for large images (OCR token cost)

### OCR Path

`extractTextFromImage()` attempts Document AI first, falls back to Google Vision at `visionService.js:300–311`. Both succeed or both return `{ text: '' }` silently — **no confidence gate**, **no Textract fallback** (which handoff §3 specifies for <0.50 confidence primary).

### Failure Modes

**Fail-open on rotation error.** If `sharp` module is missing or rotation throws, the original unrotated buffer is returned and passed to OCR. Sideways receipt text then produces low-confidence OCR output that flows downstream silently. This violates Engineering Constitution §9 (safe-fail with user-facing message, not silent-degrade).

### Severity & Recommendations

| Concern | Severity |
|---|---|
| Fail-open on normalization error | **CRITICAL** (violates Constitution §9) |
| No resolution normalization (wastes OCR tokens, inconsistent input quality) | HIGH |
| No format standardization (HEIC compatibility issues) | MEDIUM |
| No Textract fallback | MEDIUM |
| No blur/glare/darkness detection for validation_flags feed | MEDIUM |
| EXIF rotation works correctly | LOW (noted positive) |

**Recommendations:**
1. **Add resolution normalization.** Measure long edge, downscale to 2048px if >2048, optionally upscale to 1024px if <1024.
2. **Add format conversion.** HEIC → JPEG at 85–90% quality for all non-transparent images.
3. **Fail-closed on rotation error.** Return an error envelope (not the raw buffer) when rotation or normalization fails. Log to parse_jobs with a `normalization_status` flag.
4. **Export a single public function** `normalizeImageForOCR({ buffer, mediaType })` returning `{ normalized_buffer, resolution_long_edge, format, quality_flags }`.
5. **Add Textract fallback** in the OCR path (separate from normalization but in the same service boundary).

---

## Component 10: Schema — `parse_jobs`, `vendor_aliases`, `parse_corrections`

### Current State

**All three tables do not exist.** Confirmed by searching `migrations/` and `schemas/` directories. Existing migration file naming convention: `YYYY_MM_DD_snake_case_description.sql` (e.g., `2026_04_18_chiefos_quotes_spine.sql`). Existing patterns use `CREATE TABLE IF NOT EXISTS`, `DO $preflight$ ... BEGIN ... RAISE EXCEPTION` preflight blocks, and explicit `CREATE POLICY` with idempotent wrappers.

### Equivalent Tables in Current Schema

The receipt-parsing pipeline uses a different set of tables:

| Handoff Spec Table | Current Equivalent (if any) | Role overlap |
|---|---|---|
| `parse_jobs` | `intake_items` + `intake_item_drafts` | job row + OCR draft, but missing ~15 spec columns |
| `vendor_aliases` | — | **none** |
| `parse_corrections` | `intake_item_reviews` (partial) | logs confirm/edit_confirm action but not per-field |

### Gap Against Handoff §5.1 (`parse_jobs`)

**Full rebuild required.** Target has 29 columns including:

Required columns: `id, tenant_id, owner_id, user_id, source, source_msg_id, media_asset_id, attachment_hash, kind, normalization_status, ocr_primary_result, ocr_primary_confidence, ocr_fallback_result, ocr_fallback_confidence, llm_auditor_result, llm_auditor_model, llm_auditor_provider, llm_auditor_tokens_in, llm_auditor_tokens_out, llm_auditor_cached_tokens, bypass_reason, validation_flags, enrichment_applied, cil_draft, final_confidence, routing_decision, status, error_code, error_detail, trace_id, created_at, updated_at, completed_at`

Required constraints: `UNIQUE (owner_id, source_msg_id, kind) DEFERRABLE INITIALLY DEFERRED`; CHECK on `source`, `kind`, `routing_decision`, `status`.

Required indexes: `idx_parse_jobs_tenant`, `idx_parse_jobs_owner`, `idx_parse_jobs_status (partial)`, `idx_parse_jobs_routing`, `idx_parse_jobs_hash`.

**Migration scope: Full rebuild required.** 29 columns, 1 unique constraint, 4 CHECK constraints, 5 indexes, RLS policies to add.

### Gap Against Handoff §5.2 (`vendor_aliases`)

**Full rebuild required.** Target has 10 columns including `default_job_hint` (load-bearing for handoff §7 Auto-Assign and §9 Suggested-Job Logic):

Required: `id, tenant_id, owner_id, raw_merchant_normalized, canonical_merchant, default_category, default_tax_treatment, default_job_hint, confirmation_count, last_confirmed_at, created_at, updated_at`

Required constraint: `UNIQUE (tenant_id, raw_merchant_normalized)`.
Required indexes: `idx_vendor_aliases_tenant`, `idx_vendor_aliases_lookup`.

**Migration scope: Full rebuild required.**

### Gap Against Handoff §5.3 (`parse_corrections`)

**Full rebuild required.** Target has 9 columns with FK to `parse_jobs(id)`:

Required: `id, tenant_id, owner_id, user_id, parse_job_id, field_name, original_value, corrected_value, original_source, created_at`

Required indexes: `idx_parse_corrections_tenant`, `idx_parse_corrections_job`.

**Migration scope: Full rebuild required.** Must be created AFTER `parse_jobs` (FK dependency).

### Quota Architecture Tables (Handoff §5.4, Constitution §11)

Also missing — all four:
- `quota_allotments` — **missing, CRITICAL** (blocking quota enforcement)
- `quota_consumption_log` — **missing, CRITICAL** (blocking observability)
- `addon_purchases_yearly` — **missing, CRITICAL** (blocking 1,000-pack annual limit)
- `upsell_prompts_log` — **missing, CRITICAL** (blocking once-per-trigger dedupe)

### Identity Model Compliance (Dual-Boundary)

All seven target tables correctly specify both `tenant_id (uuid)` and `owner_id (text)` per Engineering Constitution §2. Ready for implementation with RLS policies following the existing pattern from quotes-spine migrations.

### Severity & Recommendations

| Concern | Severity |
|---|---|
| `parse_jobs` missing | **CRITICAL** |
| `vendor_aliases` missing (blocks §7, §9, §10) | **CRITICAL** |
| `parse_corrections` missing | **CRITICAL** |
| RLS policies undefined (all three tables) | **CRITICAL** |
| Indexes undefined (all three tables, 10+ indexes total) | **CRITICAL** |
| Quota tables missing (all four, Constitution §11) | **CRITICAL** |
| FK dependency: `parse_corrections` → `parse_jobs` must be in correct migration order | **CRITICAL** |
| `default_job_hint` column (load-bearing for Auto-Assign + Suggested-Job) | **CRITICAL** |
| Preflight blocks and idempotency patterns well-established in existing migrations | MEDIUM (positive — easy to follow) |

**Recommendations:**
1. **Two-phase migration strategy:**
   - **Phase 1 — Receipt tables:** `parse_jobs` → `vendor_aliases` → `parse_corrections` (FK order)
   - **Phase 2 — Quota tables:** `quota_allotments` → `quota_consumption_log` → `addon_purchases_yearly` → `upsell_prompts_log`
2. **Follow existing patterns** from `2026_04_18_chiefos_quotes_spine.sql` and `2026_04_20_chiefos_tenant_counters_generalize.sql`: `DO $preflight$` blocks, `CREATE TABLE IF NOT EXISTS`, `DO` blocks around `CREATE POLICY` for idempotency.
3. **RLS policy pattern** (from existing docs): portal SELECT/INSERT/UPDATE gated by `tenant_id IN (SELECT tenant_id FROM chiefos_portal_users WHERE user_id = auth.uid())`.
4. **Cross-tenant isolation test** required before production per Engineering Constitution §6 — two tenants, overlapping `owner_id` digits, confirm no leakage.
5. **Transition plan for `intake_items`:** decide whether to deprecate (view alias during transition), keep as separate surface, or migrate data into `parse_jobs`. See Open Questions.

---

## Cross-Component Dependencies

| # | Dependency | Affected components | Resolution required |
|---|---|---|---|
| 1 | **`parse_corrections` FK → `parse_jobs`** | 7, 10 | Migration order: `parse_jobs` before `parse_corrections`. |
| 2 | **`vendor_aliases.default_job_hint`** is load-bearing for auto-assign (§7) and suggested-job (§9) logic | 4, 7, 10 | Schema must include this column in initial migration; cannot be added later without migrating existing rows. |
| 3 | **Correction flow (Component 7) writes to `vendor_aliases`** — but `vendor_aliases` doesn't exist | 7, 10 | Schema migration must land before correction endpoint implementation. |
| 4 | **Confidence router (Component 5) writes `routing_decision` to `parse_jobs`** — but `parse_jobs` doesn't exist | 5, 10 | Schema migration must land before router implementation. |
| 5 | **CIL adapter (Component 6) consumes `AuditedReceiptDraft`** — but no auditor exists yet | 6, + future Auditor service (Session 2) | CIL schema extension and adapter creation must happen alongside or before auditor service. |
| 6 | **Confirm/logged template unification (Components 2, 3) depends on canonical auditor output** | 2, 3, + future Auditor service | Template fixes should land alongside auditor integration, not before — otherwise the "canonical" field list has nothing canonical to read from. |
| 7 | **`expense.js` refactor to route through `domain/transactions.js`** touches the DB insert path | 1 | Can land independently but must coordinate with Component 4's portal confirm refactor (both paths need the same CIL route). |
| 8 | **Idempotency unique constraint `(owner_id, source_msg_id, kind)` on `transactions`** | 1, 4 | Must be verified or added before enabling any new write path. |
| 9 | **`intake_items` vs `parse_jobs` naming decision** | 4, 10 | **Requires founder decision before Session 2.** |
| 10 | **Normalization service (Component 9) feeds blur/glare/darkness flags to validation (Component 8)** | 8, 9 | Build order: validation service first (with flag enum), normalization integrates later. |

---

## Recommended Build Sequence

Adjusted from handoff §13 based on audit findings. **Most handoff ordering is preserved**; notable changes flagged inline.

1. **Session 1 — Audit (this session).** ✅ Complete.
2. **Session 2 — Schema migrations (Phase 1 receipt + Phase 2 quota).** Create all seven target tables with RLS, indexes, and preflight blocks. Run cross-tenant isolation tests. **← Same as handoff §13 item 5; moved earlier because every other component depends on these tables.**
3. **Session 3 — Validation service + flag enum.** Build `services/parser/validation.js` with `VALIDATION_FLAGS` constants and pure `validateReceiptDraft()` function. No integration yet — standalone + unit-tested.
4. **Session 4 — LLM auditor service (with prompt caching).** Build per handoff §3 with Claude Sonnet 4.5 primary + GPT-4o fallback + prompt caching integrated from the start. Standalone + unit-tested.
5. **Session 5 — Normalization service upgrade + Textract fallback.** Add resolution normalization, format conversion, fail-closed error handling. Wire Textract as OCR fallback for <0.50 primary confidence.
6. **Session 6 — CIL schema extension + `auditedReceiptToCIL()` adapter.** Extend LogExpense with nested confidence + validation_flags. Retire duplicate CIL file.
7. **Session 7 — Confidence router.** Build `services/parser/confidenceRouter.js` with hard-coded `pending_review | rejected` output. No auto-accept branch.
8. **Session 8 — Pipeline integration in `expense.js` + portal confirm.** Replace direct `insertTransaction` with `domain/transactions.js::logExpense()`. Wire OCR → normalization → auditor → validation → router → CIL → confirm. Both WhatsApp and portal paths converge here.
9. **Session 9 — Correction flow + vendor_aliases upsert.** Per-field edit endpoint, `parse_corrections` writes, `vendor_aliases` upsert on merchant correction.
10. **Session 10 — Template unification (confirm + logged).** Both templates read from canonical `audited.result.*` fields. Add per-field confidence markers. Unit test for field parity.
11. **Session 11 — Auto-assign mode + suggested-job logic.** AUTO / STOP AUTO / CHANGE JOB commands; vendor_aliases.default_job_hint lookup; portal toggle.
12. **Session 12 — Quota consumption engine.** Separate buckets, newest-pack-first consumption, fail-closed plan lookup.
13. **Session 13 — Stripe add-on checkout + webhook.** Purchase flow, idempotent credit, 1,000-pack annual limit enforcement.
14. **Session 14 — Upsell prompts + Chief's Confidence widget.** 80% / 100% / approaching-cap triggers with once-per-month enforcement; Decision Center widget.
15. **Session 15 — Developer Observability Dashboard.** Per-tenant + aggregate metrics, alerts.
16. **Session 16 — High-confidence bypass flag (off by default).** Config wiring + telemetry hooks. Do not enable until dashboard proves safety.
17. **Session 17 — End-to-end production validation.** Two-tenant isolation, failure injection, idempotency, cost verification, 500-receipt blind accuracy test.

**Notable adjustments from handoff §13:**
- Audit step confirmed as Session 1 (same).
- **Doc drop-ins (handoff §13 items 2–4) already completed** in prior sessions — removed from sequence.
- **Schema migrations moved to Session 2** (was §13 item 5) because they are blocking dependencies for every other component.
- **Validation service moved to Session 3** (was implicit in §13 item 7) because it's a standalone pure function and unblocks the auditor integration.
- Template unification (§13 item 6) moved **later** (Session 10) because it depends on the auditor output shape being finalized — fixing templates first would just paper over the real bug.

---

## Open Questions for the Founder

1. **`intake_items` vs `parse_jobs` naming decision.** The portal currently uses `intake_items` / `intake_item_drafts` as its pending-review backbone. The handoff specifies `parse_jobs`. Options:
   - **(A) Keep `intake_items` as canonical** and update the handoff spec — would require adding ~15 columns to `intake_item_drafts` (ocr_primary_confidence, llm_auditor_result, bypass_reason, routing_decision, trace_id, etc.) and deprecating several non-receipt kinds (voice_note, pdf_document, email_lead) from the receipt pipeline.
   - **(B) Create `parse_jobs`** as a new, receipt-specific table per handoff, and keep `intake_items` for non-receipt flows (voice, email lead). Temporary view alias during transition.
   - **(C) Create `parse_jobs`** and migrate existing receipt-kind `intake_items` rows into it as a one-time backfill, then drop receipt kinds from `intake_items`.
   - **Recommend: Option B.** It preserves existing upload/review UX without a risky backfill while aligning receipt parsing with the handoff spec. Non-receipt intake flows stay on `intake_items`.
   - **Blocking for Session 2.**

2. **Confirm-message date icon root cause.** The audit diagnosed the "FEB 24 vs Mar 14" mismatch as likely Twilio-side rendering rather than a code bug, but could not confirm without capturing raw Twilio payload vs. rendered message. Should we budget a diagnostic step in Session 10 (template unification) to verify before fixing, or proceed with the assumption that unifying both templates' date source resolves it?

3. **`expense.js` refactor scope.** 9,240 lines. The audit recommends extracting the receipt-parse + confirm flow into a dedicated module rather than a full rewrite. Is a partial extraction acceptable, or do you want a more aggressive refactor with `expense.js` split into ~5 smaller modules (ingress, parse, confirm, jobs, write)?

4. **Retention of `intake_item_reviews` after correction flow lands.** Once `parse_corrections` exists and captures per-field edits, does `intake_item_reviews` become redundant? Or do we keep it as a higher-level audit trail of confirm/reject actions?

5. **`cil.js` vs `schemas/cil.js`.** Two files exist. Which is canonical going forward? Recommend consolidating into `schemas/cil.js` (newer) and removing root `cil.js`, but this touches the quotes spine as well and should be a deliberate decision.

---

**Audit complete. Ready for Session 2 (LLM Auditor Service drop-in) or Session 2-alt (Schema Migration), depending on founder preference.**
