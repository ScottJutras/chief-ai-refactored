# CLAUDE CODE HANDOFF — ChiefOS Receipt & Invoice Parser Upgrade

**Project root:** `C:\Users\scott\Documents\Sherpa AI\Chief`
**Session guardrails:** `CLAUDE.md` in project root (already in place)
**Authoritative docs (read first):**
1. `01_CHIEFOS_NORTH_STAR.md` — identity model, architecture, principles
2. `02_CHIEFOS_EXECUTION_PLAYBOOK.md` — sequencing, production readiness standard
3. `03_CHIEFOS_ENGINEERING_CONSTITUTION.md` — identity layers, query patterns, migration rules (BINDING)
4. `04_CHIEFOS_MONETIZATION_AND_PRICING.md` — plan gating, quota enforcement
5. `05_CHIEFOS_CREATIVE_AND_GTM_BRIEF.md` — positioning
6. `06_CHIEFOS_PROJECT_INSTRUCTIONS.md` — how to work in this project

**Stage posture:** Production-grade, industry-leading. There is no "MVP version" or "Beta version." Every feature ships to the Production Readiness Standard or does not ship. The Regression Pause Rule is permanent.

---

## 1. Context and Scope

This handoff specifies the complete receipt and invoice parser upgrade for ChiefOS. The goal is to make the receipt parser the most accurate, trustworthy, and accountant-ready receipt parser in the contractor software market — the "magic moment" that brings users in and the compounding-accuracy moat that keeps them.

The upgrade has three parts, working in tandem:

1. **Parser accuracy** — LLM auditor layer on top of Document AI, with Textract fallback, tenant-scoped correction memory, per-field confidence, and honest uncertainty.
2. **User experience** — streamlined WhatsApp flow with auto-assign mode, per-field confidence surfacing, auto-suggested jobs, and the "Chief's Confidence" transparency widget.
3. **Business economics** — Free tier OCR (20/month) to unlock acquisition, production-grade quota architecture, paid add-on packs for overflow, tight soft overage, telemetry-driven observability, and an Enterprise escalation path.

The doc updates for item 3 have already been specified — they will be applied to the monetization doc and Engineering Constitution as drop-in replacements before implementation begins.

---

## 2. What Already Exists (Must Review Before Building)

The following components exist in some form and must be reviewed for correctness before integration or modification. The current build is acknowledged as fragile in places — particularly `expense.js`. Audit thoroughly; do not assume anything works correctly until verified.

1. **`expense.js`** — current receipt/expense pipeline code (flagged as fragile, high priority)
2. **Confirm-message template** — currently produces incorrect output (`"Unknown 🏪 Rona"` where merchant should be "RONA") and a calendar icon mismatch (shows "FEB 24" next to "Mar 14, 2026"). Likely a field-mapping bug between the OCR result and the template renderer.
3. **Logged-expense template** — produces correct output ("Store: RONA") but uses a different canonical field than the confirm-message template. Must read from the same source of truth.
4. **Pending Review Queue** — exists; review for completeness and correctness against the audited receipt schema specified below
5. **Confidence router** — exists; may need threshold adjustments based on the new LLM auditor output
6. **CIL draft transformation** — exists; ensure it accepts the new `AuditedReceiptDraft` shape
7. **Correction flow** — exists; must verify it writes to `parse_corrections` and upserts `vendor_aliases` on every edit
8. **Deterministic validation layer** — exists; review against the validation flag list in the auditor schema
9. **Normalization service** — exists; review for output quality (resolution target: 1024–2048px long edge)
10. **Parse schema** (parse_jobs, vendor_aliases, parse_corrections or equivalents) — exists; verify columns match the schema specified in Section 5 of this handoff

**Audit order (most fragile first):**
1. `expense.js`
2. Confirm-message and logged-expense templates
3. Parse schema (migration files)
4. `vendor_aliases` schema (confirm `default_job_hint` field exists or plan migration)
5. Deterministic validation layer
6. Normalization service
7. Correction flow

For each component, produce a short audit note stating: (a) current state, (b) what's correct, (c) what needs to change to support this upgrade, (d) proposed change with code drop-in.

---

## 3. The LLM Auditor Service (Already Specified — Implement as Drop-In)

**Location:** `src/services/parser/auditor/` (adjust path to match existing project structure)

**Files to create:**

```
src/services/parser/auditor/
├── index.js                           # Main entry: auditReceipt()
├── providers/
│   ├── anthropic.js                   # Claude Sonnet 4.5 with tool-use + prompt caching
│   ├── openai.js                      # GPT-4o fallback with json_schema
│   └── index.js                       # Provider selection + failover
├── prompts/
│   └── auditor-system-prompt.js       # System prompt builder with tenant alias injection
├── schema.js                          # AUDITED_RECEIPT_SCHEMA (JSON Schema)
├── errors.js                          # AuditorError + AUDITOR_ERROR_CODES
└── README.md                          # Usage, interface, cost model
```

The full code for all files was delivered in the prior planning session. Reference the auditor service files as the canonical spec. Key properties to verify during implementation:

**Interface (public):**
```javascript
const { auditReceipt } = require('./services/parser/auditor');

const audited = await auditReceipt({
  imageBuffer,           // Buffer (required)
  imageMediaType,        // 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf'
  ocrPrimary,            // Google Document AI structured result (required)
  ocrFallback,           // AWS Textract result (optional — pass when primary was low-confidence)
  tenantAliases,         // [{ raw_merchant_normalized, canonical_merchant, default_category }]
  knownJobs,             // [{ id, name }] — active jobs for this tenant
  traceId,               // string (required — from parse_jobs.trace_id)
  logger,                // optional
});

// audited = {
//   result: AuditedReceiptDraft,
//   provider: 'anthropic' | 'openai',
//   model: string,
//   usage: { input_tokens, output_tokens },
//   trace_id: string,
//   duration_ms: number,
// }
```

**Non-negotiable properties:**
- Pure function: no database writes, no routing decisions, no CIL transformation
- Provider-abstracted: caller doesn't know which LLM ran
- Schema-validated: the LLM cannot return malformed output (enforced by Claude tool-use and OpenAI json_schema)
- Fail-closed: AuditorError with typed codes on every failure path
- Anthropic primary; OpenAI fallback on timeout, rate limit, or unavailability only

**Prompt caching (integrate at build time):**

Add prompt caching to `providers/anthropic.js`. This cuts input token costs ~90% on the cached portion at steady state.

- Use the `prompt-caching-2024-07-31` beta header on every Anthropic call
- Mark the system prompt as `cache_control: { type: 'ephemeral' }`
- Mark the tool schema as cacheable
- The image and OCR result are NOT cached (they're unique per call)

Per the Anthropic SDK, this looks like:

```javascript
// In providers/anthropic.js, adjust the client.messages.create call:
const response = await client.beta.promptCaching.messages.create({
  model: MODEL,
  max_tokens: MAX_TOKENS,
  system: [
    {
      type: 'text',
      text: systemPrompt,
      cache_control: { type: 'ephemeral' },
    },
  ],
  messages: [{ role: 'user', content: userContent }],
  tools: [
    {
      name: 'submit_audit',
      description: 'Submit the audited receipt or invoice draft. Always call this tool exactly once.',
      input_schema: AUDITED_RECEIPT_SCHEMA,
      cache_control: { type: 'ephemeral' },
    },
  ],
  tool_choice: { type: 'tool', name: 'submit_audit' },
});
```

Verify the SDK version supports prompt caching. If using an older SDK that requires the raw API header, add `betas: ['prompt-caching-2024-07-31']` to the request.

**Environment variables:**
- `ANTHROPIC_API_KEY` — required
- `OPENAI_API_KEY` — required for fallback

**Dependencies to install:**
```bash
npm install @anthropic-ai/sdk openai
```

---

## 4. High-Confidence Audit Bypass (Config Flag)

Add a config flag that allows skipping the LLM auditor for extremely high-confidence Document AI results from well-established vendors. **Off by default. Must be telemetry-validated before enabling.**

**Bypass conditions (all must be true):**
- Document AI confidence ≥ 0.95 on merchant, date, subtotal, tax, and total
- Merchant matches a `vendor_aliases` entry for this tenant with `confirmation_count >= 10`
- Zero validation flags from Document AI structured output
- Tenant has `high_confidence_bypass_enabled = true` in settings

**When bypass fires:**
- Skip the LLM auditor call entirely
- Construct the audited receipt draft directly from Document AI output with `source: 'ocr_confirmed'` on every field
- Log the bypass in `parse_jobs` with `llm_auditor_result = null` and a flag `bypass_reason: 'high_confidence_established_vendor'`
- Still run deterministic validation
- Still route through Pending Review (no auto-accept in the production build)

**Impact on telemetry:**
- Track bypass rate per tenant
- Track whether bypassed receipts get corrected by the owner (if they do, something is wrong and the bypass threshold should tighten)
- Surface bypass accuracy in the Developer Observability Dashboard

This is a cost-optimization lever for when a tenant's vendor memory has deeply established patterns. Do not enable by default. Ship the flag off, turn it on tenant-by-tenant after the dashboard proves it's safe.

---

## 5. Schema Verification and Migrations

Before writing any new code, verify the existing database schema matches what this upgrade requires. Produce a migration for any gaps.

### 5.1 parse_jobs table (required)

```sql
CREATE TABLE public.parse_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  owner_id text NOT NULL,
  user_id text,
  source text NOT NULL CHECK (source IN ('whatsapp','email','portal','api')),
  source_msg_id text,
  media_asset_id uuid NOT NULL,
  attachment_hash text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('receipt','invoice','unknown')),
  normalization_status text,
  ocr_primary_result jsonb,
  ocr_primary_confidence numeric,
  ocr_fallback_result jsonb,
  ocr_fallback_confidence numeric,
  llm_auditor_result jsonb,
  llm_auditor_model text,
  llm_auditor_provider text,
  llm_auditor_tokens_in int,
  llm_auditor_tokens_out int,
  llm_auditor_cached_tokens int,
  bypass_reason text,
  validation_flags jsonb,
  enrichment_applied jsonb,
  cil_draft jsonb,
  final_confidence numeric,
  routing_decision text CHECK (routing_decision IN ('pending_review','rejected')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','processing','completed','failed')),
  error_code text,
  error_detail text,
  trace_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (owner_id, source_msg_id, kind) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX idx_parse_jobs_tenant ON public.parse_jobs(tenant_id);
CREATE INDEX idx_parse_jobs_owner ON public.parse_jobs(owner_id);
CREATE INDEX idx_parse_jobs_status ON public.parse_jobs(status) WHERE status != 'completed';
CREATE INDEX idx_parse_jobs_routing ON public.parse_jobs(routing_decision);
CREATE INDEX idx_parse_jobs_hash ON public.parse_jobs(owner_id, attachment_hash);
```

Note: `routing_decision` only includes `pending_review` and `rejected`. Auto-accept is NOT enabled in this upgrade. Every parsed receipt routes to Pending Review.

### 5.2 vendor_aliases table

Verify this exists and contains `default_job_hint`. If not, migrate:

```sql
CREATE TABLE public.vendor_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  owner_id text NOT NULL,
  raw_merchant_normalized text NOT NULL,
  canonical_merchant text NOT NULL,
  default_category text,
  default_tax_treatment text,
  default_job_hint text,  -- 'active_job' or specific job_id
  confirmation_count int NOT NULL DEFAULT 1,
  last_confirmed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, raw_merchant_normalized)
);

CREATE INDEX idx_vendor_aliases_tenant ON public.vendor_aliases(tenant_id);
CREATE INDEX idx_vendor_aliases_lookup ON public.vendor_aliases(tenant_id, raw_merchant_normalized);
```

### 5.3 parse_corrections table

```sql
CREATE TABLE public.parse_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  owner_id text NOT NULL,
  user_id text,
  parse_job_id uuid NOT NULL REFERENCES public.parse_jobs(id),
  field_name text NOT NULL,
  original_value text,
  corrected_value text NOT NULL,
  original_source text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_parse_corrections_tenant ON public.parse_corrections(tenant_id);
CREATE INDEX idx_parse_corrections_job ON public.parse_corrections(parse_job_id);
```

### 5.4 Quota architecture tables (new)

The quota system needs separate buckets per feature kind. Add:

```sql
CREATE TABLE public.quota_allotments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  owner_id text NOT NULL,
  feature_kind text NOT NULL,  -- 'ocr_plan', 'ocr_addon', 'ocr_soft_overage', 'voice_plan', 'askchief_plan'
  bucket_source text NOT NULL,  -- 'plan' | 'addon_pack_100' | 'addon_pack_250' | 'addon_pack_500' | 'addon_pack_1000' | 'soft_overage'
  allotment_total int NOT NULL,
  allotment_consumed int NOT NULL DEFAULT 0,
  valid_from timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  stripe_event_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_quota_allotments_owner ON public.quota_allotments(owner_id, feature_kind);
CREATE INDEX idx_quota_allotments_active ON public.quota_allotments(owner_id, feature_kind, expires_at) 
  WHERE allotment_consumed < allotment_total AND expires_at > now();
CREATE UNIQUE INDEX idx_quota_allotments_stripe_idempotent 
  ON public.quota_allotments(stripe_event_id) WHERE stripe_event_id IS NOT NULL;

CREATE TABLE public.quota_consumption_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  owner_id text NOT NULL,
  feature_kind text NOT NULL,
  quota_allotment_id uuid REFERENCES public.quota_allotments(id),
  bucket_source text NOT NULL,
  consumed_amount int NOT NULL,
  remaining_in_bucket int NOT NULL,
  trace_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_quota_consumption_owner_month 
  ON public.quota_consumption_log(owner_id, feature_kind, created_at);

CREATE TABLE public.addon_purchases_yearly (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  owner_id text NOT NULL,
  pack_size int NOT NULL,  -- 100, 250, 500, 1000
  calendar_year int NOT NULL,
  stripe_event_id text NOT NULL UNIQUE,
  purchased_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_addon_purchases_owner_year 
  ON public.addon_purchases_yearly(owner_id, calendar_year, pack_size);

CREATE TABLE public.upsell_prompts_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  owner_id text NOT NULL,
  feature_kind text NOT NULL,
  trigger_type text NOT NULL,  -- '80_percent' | '100_percent' | 'approaching_cap' | 'enterprise_signal'
  period_year_month text NOT NULL,  -- 'YYYY-MM'
  prompted_at timestamptz NOT NULL DEFAULT now(),
  response text,  -- 'accepted' | 'declined' | 'ignored'
  response_at timestamptz
);

CREATE UNIQUE INDEX idx_upsell_prompts_once_per_month 
  ON public.upsell_prompts_log(owner_id, feature_kind, trigger_type, period_year_month);
```

All tables above must pass the Tenant Data Checklist from Engineering Constitution §6 before deployment. Run the two-tenant isolation test documented in the Engineering Constitution.

---

## 6. Pipeline Flow (End to End)

The canonical flow, post-upgrade:

```
Ingress (WhatsApp / Email / Portal)
  → Evidence Capture (hash, store, parse_jobs row created)
    → Normalization
      → Primary OCR (Document AI)
        → Confidence Gate
          → [if < 0.50] Fallback OCR (Textract)
          → [if ≥ 0.95 AND established vendor AND bypass enabled] Skip auditor
            → Otherwise: LLM Auditor (Claude Sonnet 4.5 → GPT-4o fallback)
              → Deterministic Validation (math, date, merchant, currency, amount)
                → Tenant Enrichment (alias lookup, default_job_hint)
                  → Auto-Assign Resolution (if auto-assign mode active)
                    → Confirmation Message Build
                      → WhatsApp / Portal Confirm UX
                        → Owner Confirms or Edits
                          → [if edit] Write parse_corrections row + upsert vendor_aliases
                          → CIL Draft → transactions table write (Expense service)
                            → Quota consumed (ocr_plan → ocr_addon → ocr_soft_overage)
                              → Upsell prompt check (80%, 100%, approaching-cap)
```

Every stage is idempotent. Failures route to Pending Review with the error flag; nothing silently drops.

---

## 7. Auto-Assign Mode

**Activation paths:**
- WhatsApp command: `AUTO` (uses tenant's current active job, fails closed if zero or multiple active jobs) or `AUTO [job name or partial match]`
- Portal toggle: "Use Active Job as Auto-Assign" in settings (persists across sessions)

**Deactivation paths:**
- WhatsApp command: `STOP AUTO`
- WhatsApp command: `CHANGE JOB` on any receipt (exits auto-assign entirely, prompts for new job assignment on current receipt)
- Portal toggle: off
- Automatic: target job is closed/archived → auto-assign deactivates, Chief confirms: *"Job closed. Auto-assign is off. Next receipt will ask for a job."*

**Duration:**
- **No automatic time-based expiry.** Auto-assign stays on indefinitely until explicitly deactivated.
- **Daily re-confirmation prompt:** On the first receipt of each new calendar day while auto-assign is active, the confirm message prominently displays: *"🔒 Still auto-assigning to [Job Name]. Reply STOP AUTO if that's wrong."* This is a reminder, not an expiry — the receipt still processes normally.
- **Optional: "Reset auto-assign every 24 hours" toggle** in portal settings, off by default, for owners who prefer daily re-activation.

**Confirmation message format (when auto-assign is active):**
```
🔒 Auto-assigned to 349 Brock St, London
💵 $58.65 — RONA — Mar 14, 2026
Category: Materials

Reply YES to confirm, EDIT to change fields,
CHANGE JOB to override and exit auto-assign,
or STOP AUTO to exit auto-assign mode.
```

**Conversational overlay:** If the owner asks a question mid-receipt-submission ("did job 45 make money?"), Chief answers the question and resumes the capture flow. Capture is context, not a modal lock. This preserves the always-available reasoning seat posture from the North Star.

**Data model:**

```sql
ALTER TABLE public.users ADD COLUMN auto_assign_active_job_id uuid;
ALTER TABLE public.users ADD COLUMN auto_assign_activated_at timestamptz;
ALTER TABLE public.users ADD COLUMN auto_assign_daily_reset boolean NOT NULL DEFAULT false;
ALTER TABLE public.users ADD COLUMN auto_assign_last_daily_prompt_date date;
```

---

## 8. Confirmation Message Template Fix (Critical Trust Issue)

The current WhatsApp confirm message displays `"Unknown 🏪 Rona"` where the merchant is correctly parsed as RONA. This is a template-level field-mapping bug. The logged-expense message (sent after owner confirms) correctly displays `"Store: RONA"` — meaning the templates are reading from different fields.

**Required fix:**

1. Audit both templates to identify which field each reads from (likely one reads `vendor_name`, the other reads `merchant` or `store`).
2. Unify both templates to read from `audited.result.merchant.value` as the single source of truth.
3. Same audit for the date field — confirm message shows a mismatched calendar icon ("FEB 24" next to "Mar 14, 2026"). The icon should derive from the parsed date, not be hardcoded or read a different field.
4. Add a unit test that asserts the confirm message and logged-expense message produce consistent merchant and date strings for the same audited receipt.

**New template format (confirm message):**

```
✅ Confirm expense
💵 $58.65 — RONA
📅 Mar 14, 2026
📍 349 Brock St, London
🏷️ Category: Materials
💰 Subtotal: $51.90, GST/HST: $6.75, Total: $58.65

Reply YES to confirm, EDIT to change fields, or CANCEL.
```

**Per-field confidence surfacing:**

If any field has `confidence < 0.70` from the auditor, the template adds a ⚠️ marker and a note:

```
✅ Confirm expense
💵 $58.65 — RONA
📅 ⚠️ Mar 14, 2026 (date unclear — tap EDIT to verify)
📍 349 Brock St, London
🏷️ Category: Materials
```

**Rules:**
- Low-confidence merchant: *"(merchant unclear — tap EDIT to verify)"*
- Low-confidence date: *"(date unclear — tap EDIT to verify)"*
- Low-confidence total: *"(total unclear — tap EDIT to verify)"*
- Low-confidence tax: *"(tax breakdown unclear — tap EDIT to verify)"*
- Two or more low-confidence fields: one consolidated note at the bottom: *"(multiple fields uncertain — please verify before confirming)"*

This is the "trust over cleverness" principle made visible.

---

## 9. Suggested-Job Logic

When NOT in auto-assign mode, Chief suggests a job in the confirmation message rather than asking separately. Fallback order:

1. **Vendor-specific memory.** If `vendor_aliases.default_job_hint` matches a specific job_id for this merchant + tenant, and that job is still active → suggest it.
2. **Single active job.** If the tenant has exactly one active job → suggest it.
3. **Recent activity.** If the tenant logged an expense OR clocked in on a specific job within the last 48 hours → suggest that job.
4. **No suggestion.** Fall back to the current job picker flow.

When a suggestion exists, the confirmation message format:

```
✅ Confirm expense
💵 $58.65 — RONA
📅 Mar 14, 2026
🎯 Suggested job: 349 Brock St, London (you usually assign RONA receipts here)
🏷️ Category: Materials

Reply YES to confirm, EDIT to change fields, CHANGE JOB to pick a different job, or CANCEL.
```

The reasoning for the suggestion is surfaced in plain language ("you usually assign RONA receipts here" vs. "your only active job" vs. "your most recent job"). This is the transparency the "trust over cleverness" principle requires.

---

## 10. "Chief's Confidence" Portal Widget

A Decision Center widget on the portal that makes the enrichment moat visible to the owner.

**Data source:** aggregations from `parse_jobs` and `parse_corrections` for the current tenant.

**Widget content:**

```
Chief's Confidence — [Month Name]

[N] receipts captured this month
[X] right on the first try ([X/N]%)
[Y] needed your help

You've trained Chief on [M] vendors.
Accuracy is [improving / holding steady / declining] vs. last month.
```

**Metric definitions:**
- "Right on the first try" = `parse_jobs` where the owner confirmed without writing any `parse_corrections` rows
- "Needed your help" = `parse_jobs` where at least one `parse_corrections` row exists
- "Trained Chief on N vendors" = distinct `vendor_aliases` with `confirmation_count >= 3` for this tenant
- "Accuracy trend" = compare first-try-correct rate for current month vs. previous month; only show trend line if tenant has at least 2 months of data

**Rules:**
- Available on all tiers including Free (transparency is not gated)
- Never inflates the numbers — if the parser is failing, the widget says so
- Never shows raw confidence scores, LLM token counts, or validation flag names (those are developer telemetry)

---

## 11. Pricing and Quota Implementation

### 11.1 Plan tiers (from revised Monetization doc)

| | Free | Starter | Pro | Enterprise |
|---|---|---|---|---|
| **Price** | $0 | $59/mo | $149/mo | Contact sales |
| **OCR monthly** | 20 (hard cap) | 300 + 30 overage → 500 hard cap | 1,000 + 100 overage → 2,000 hard cap | Custom |
| **Voice** | disabled | per current doc | per current doc | Custom |
| **Ask Chief** | disabled | per current doc | per current doc | Custom |
| **Exports** | disabled | enabled | enabled | Custom |
| **Crew self-log** | no | no | yes (≤150) | Custom |
| **Approvals** | no | no | yes | Custom |
| **Retention** | 90 days | 3 years | 7 years | Custom |

### 11.2 Add-on packs (Starter and Pro only)

| Pack | Receipts | Price | Per-receipt |
|---|---|---|---|
| +100 | 100 | $12 USD | $0.12 |
| +250 | 250 | $25 USD | $0.10 |
| +500 | 500 | $45 USD | $0.09 |
| +1,000 | 1,000 | $80 USD | $0.08 |

**1,000-pack annual limit:** 3 purchases per `(owner_id, calendar_year)`. On the 3rd: soft warning about Enterprise. On the 4th: blocked with Enterprise lead auto-created in the developer dashboard and Chief replies: *"You've purchased three 1,000-receipt packs this year — that's Enterprise territory. We'll be in touch within one business day to set up a custom plan."*

**Rollover:** All add-on receipts expire exactly 30 days from purchase date. Not calendar-month aligned. Deterministic expiration via scheduled job that moves expired receipts from `quota_allotments` to an audit ledger.

**Consumption order:**
1. Plan allotment
2. Add-on allotments (newest pack first — so older packs don't expire unused; within a pack, linear consumption)
3. Soft overage (if within threshold)
4. Hard cap → block with upsell

### 11.3 Upsell triggers

Surfaced in the portal and in WhatsApp messages. Each trigger fires **at most once per `(owner_id, feature_kind, trigger_type, period_year_month)`** (enforced by unique index on `upsell_prompts_log`).

| Trigger | Condition | Message (example for Pro OCR) |
|---|---|---|
| 80% of plan | 800 of 1,000 consumed | *"You've used 800 of 1,000 receipts this month. Add 250 more for $25?"* |
| 100% of plan | 1,000 of 1,000 consumed | *"You've hit 1,000 receipts. Soft overage active up to 1,100. Want to lock in 250 more for $25?"* |
| Approaching hard cap | 1,800 of 2,000 consumed | *"200 receipts left before hard cap. Add 500 for $45?"* |
| Enterprise signal | 3rd 1,000-pack purchase in year | *"You're consistently running enterprise volume. Want a custom plan with dedicated support?"* |

### 11.4 Free-tier abuse prevention

At signup:
- Phone uniqueness: reject duplicate phone across all tenants
- Email uniqueness: reject duplicate email across all tenants
- Disposable email blocklist: maintain in config; reject mailinator, guerrilla, temp-mail, and similar
- IP rate limit: 3 Free signups per IP per 24 hours (paid signups not rate-limited)

At runtime:
- LLM-rejected captures (`kind='rejected'` from the auditor) do NOT consume quota — prevents quota exhaustion via junk image spam
- Suspicious-volume alert: Free tenant exceeds 15 receipts in any 7-day window → internal alert

---

## 12. Developer Observability Dashboard

Build a dev-only dashboard (not owner-facing) surfacing the following metrics. Initial implementation can be a Supabase-powered internal admin page; Grafana or similar is fine as an upgrade.

### 12.1 Per-tenant metrics
- OCR usage this month vs. plan cap vs. add-ons purchased
- Soft overage consumption rate
- Hard cap hits (should be near zero; alert if non-zero)
- Add-on purchase frequency and pack size distribution
- Upsell prompt conversion rate (prompted, accepted, declined)
- Upsell fatigue (repeated declines — stop prompting)
- Bypass rate (if high-confidence bypass is enabled)
- Bypassed-receipt correction rate (should be near zero; if not, tighten bypass threshold)

### 12.2 Aggregate metrics
- Distribution of Pro usage: <500, 500–1000, 1000–1500, 1500–2000, 2000+
- Distribution of Starter usage: same buckets scaled down
- Add-on revenue per month per tier
- Add-on conversion rate by trigger type
- Gross margin per tenant per month (revenue − actual COGS)
- Soft overage consumption vs. add-on purchases ratio (indicator of whether caps are right)
- Free-to-paid conversion rate (by trigger: hit OCR cap, asked a question, attempted export)

### 12.3 Alerts
- Tenant cost > tenant revenue for 2+ consecutive months
- Hard cap hits (investigate abuse, legit heavy user, or bug)
- Add-on purchase webhook failures
- Unusual usage spikes (Free tenant >15 in 7 days, Starter >100 in 2 days, Pro >300 in 2 days)
- Enterprise auto-leads (4th 1,000-pack purchase attempt in year)

### 12.4 Monthly rollup
- Blended COGS per tier (actual)
- Blended margin per tier (actual)
- % of Pro users approaching caps (signal for pricing revision)
- Add-on attach rate (% of paid users who buy at least one add-on per month)
- Full conversion funnel: Free → Starter → Pro → Add-ons → Enterprise lead

---

## 13. Build Sequencing (Dependency-Ordered)

This is the order to build. Do not skip ahead.

1. **Audit existing components** (Section 2 of this handoff). Produce the audit notes before writing new code.
2. **Apply monetization doc drop-in** to `04_CHIEFOS_MONETIZATION_AND_PRICING.md` — new tiers, add-ons, 1,000-pack annual limit, Enterprise "contact us" tier.
3. **Apply Engineering Constitution §11** — new quota architecture section.
4. **Apply stage-language reframe** to North Star, Execution Playbook, GTM Brief, Project Instructions — "production-grade" framing per the drop-ins delivered in the prior session.
5. **Schema migrations** — parse_jobs (ensure columns match Section 5.1), vendor_aliases (add default_job_hint if missing), parse_corrections (create if missing), quota_allotments, quota_consumption_log, addon_purchases_yearly, upsell_prompts_log. Run cross-tenant isolation tests before deployment.
6. **Fix confirm-message and logged-expense templates** — unify field sources, add per-field confidence markers, verify consistency.
7. **Build LLM auditor service** with prompt caching integrated from the start.
8. **Build Textract fallback** — triggered when Document AI confidence < 0.50 on critical fields.
9. **Wire auditor into the pipeline** — replace the direct OCR → template call with OCR → auditor → template.
10. **Build auto-assign mode** — commands, portal toggle, daily re-confirmation, job-close-triggered deactivation, conversational overlay.
11. **Build suggested-job logic** — vendor memory → single active job → recent activity → fallback to picker.
12. **Build quota consumption engine** — separate buckets, newest-pack-first consumption, fail-closed on lookup failure.
13. **Build add-on Stripe checkout flow** — webhook handler with signature verification, idempotency by stripe_event_id, quota crediting in a single transaction.
14. **Build 1,000-pack annual limit enforcement** — per-year counter, soft warning at 3, block + Enterprise lead at 4.
15. **Build upsell prompt system** — 80%/100%/approaching-cap triggers with once-per-month enforcement via unique index.
16. **Build "Chief's Confidence" widget** — Decision Center component with the aggregations specified in Section 10.
17. **Build Developer Observability Dashboard** — all metrics from Section 12.
18. **Build high-confidence audit bypass** (config flag, off by default). Do not enable until dashboard shows it's safe.
19. **Run end-to-end production validation:**
    - Two-tenant isolation test (overlapping identifiers, same vendor, different corrections → no leakage)
    - Failure injection at each pipeline stage → verify fail-closed behavior, no writes to transactions without owner confirmation
    - Idempotency test (re-send same receipt 5x → one parse_job, one transaction, no duplicates)
    - Cost verification (per-receipt cost matches model within 20%)
    - Accuracy test (500 blind receipts across Canadian and US merchants → ≥90% merchant/date/total correct first-pass)
    - Pending Review UX (owner confirms on mobile in <10 seconds)

---

## 14. Production Gate (Before Public Rollout)

All of the following must pass before the upgraded receipt parser is enabled for real tenants:

**System safety:**
- No Twilio 11200s
- Tenant isolation verified (dual-boundary model)
- LLM auditor fails gracefully (no silent drops, no crashes)
- Quota enforcement fail-closed verified under plan lookup failure
- Export stability unaffected
- Portal compatibility views unaffected

**Monetization integrity:**
- Stripe webhook signatures verified
- Add-on purchases idempotent on retry
- Quota credits never drift between Stripe and DB
- Upsell prompts fire at most once per trigger per month per owner
- 1,000-pack annual limit enforced correctly
- Free-tier abuse prevention active and tested

**Accuracy floor:**
- 90%+ merchant/date/total correct first-pass across a blind 500-receipt test set
- Zero cross-tenant parse result leakage (tested)
- LLM auditor schema conformance 100% (tool-use enforcement verified)
- Deterministic validation flags fire correctly on constructed edge cases

**Observability:**
- Dashboard live, populated, alerts wired
- Correction rate trending observable per tenant
- COGS per tenant visible
- Enterprise auto-leads creating correctly

**Founder confidence test (from Execution Playbook §11):**
- Would I trust this with my own books?
- Would I show this to a paying contractor tomorrow?
- Does Free show value but push upgrade naturally?
- Does Pro justify its price?

If any answer is no, fix before rollout.

---

## 15. Non-Goals (Do Not Build)

Explicitly out of scope for this upgrade:

- **Auto-accept** without owner confirmation. All parsed receipts route to Pending Review. No exceptions.
- **Multi-OCR voting** (running three OCRs and voting). The LLM auditor is the arbiter; stacking OCRs is not.
- **Per-tenant fine-tuned models.** Post-Beta decision. The `parse_corrections` table collects the dataset; no training happens in this upgrade.
- **Cross-tenant training data.** The correction dataset is tenant-scoped; the global-vs-per-tenant training question is a policy decision for later.
- **Forecasting or predictive analytics.** Non-goal per the doc.
- **Silent data mutation** of any kind.
- **1,000-pack without the annual limit.** The limit is the architecture, not a bolt-on.

---

## 16. What I Need From This Session

At the end of the Claude Code session, produce:

1. **Audit notes** for all 10 existing components (Section 2), with proposed changes
2. **Migration SQL** for any schema gaps
3. **The LLM auditor service** (8 files per Section 3, with prompt caching integrated)
4. **The confirm-message and logged-expense template fixes** with unit tests
5. **Auto-assign mode implementation** (commands, portal toggle, daily prompt, job-close handler)
6. **Suggested-job logic** integrated into the confirmation builder
7. **Quota consumption engine** with separate buckets and fail-closed lookups
8. **Add-on Stripe checkout flow** with webhook handler
9. **Upsell prompt system** with once-per-month enforcement
10. **Chief's Confidence widget** component
11. **Developer Observability Dashboard** (can be v1 — basic metrics first, alerts can follow)
12. **High-confidence bypass config flag** (off by default, telemetry hooks in place)
13. **End-to-end production validation checklist results**

Each deliverable should reference the authoritative doc sections it satisfies, and call out any deviations with justification.

---

## 17. Authority and Conflict Resolution

If any instruction in this handoff conflicts with the authoritative docs (North Star, Execution Playbook, Engineering Constitution, Monetization, GTM, Project Instructions), **the docs win**. Flag the conflict, explain the risk, propose a compliant alternative, and do not silently comply.

If any instruction in this handoff is unclear or contradicts itself, stop and ask. Do not guess on anything touching tenant identity, canonical finance spines, quota enforcement, or idempotency. Silent guesses on these are the class of bug that takes a brand down.

The Regression Pause Rule is permanent and applies throughout this build: if transport stability, tenant isolation, idempotent writes, or plan/quota enforcement regress at any point, pause all feature work and restore before continuing.

**End of handoff.**

---

## Appendix A — Author's Notes (Meta-Context for Future Sessions)

*These notes are meta-context for whoever picks up this work. They describe how to approach the handoff itself, not instructions to execute. Skim before starting; don't treat as requirements.*

**1. This is a big handoff.** It's the accurate scope of what was designed, and there's no shorter version that doesn't silently drop something. Claude Code can handle it, but don't expect it all in one session — it's 4–8 sessions of focused work depending on how much of the existing code needs rewriting vs. extending. Plan to run the audit step (Section 2) as its own session first, then build from the audit notes forward.

**2. The schema changes in Section 5 are the biggest risk area.** If the existing schema differs meaningfully from what's specified, migrations need to be carefully written to avoid downtime or data loss. Produce migration plans with rollback SQL before applying anything.

**3. Apply the doc drop-ins BEFORE building.** The updated Monetization doc, new Engineering Constitution §11, and the stage-language reframe are the authoritative context read from in every session. If code is built first and docs updated after, there'll be code built against stale docs and a confused next session.

**4. The auditor service code from the prior session is ready to drop in as-is** with one addition: the prompt caching integration specified in Section 3. Everything else is written. The 8 files can be pasted into a new `src/services/parser/auditor/` directory as a starting point while the audit work proceeds in parallel. That's a good way to de-risk the first session.

**5. Final policy locks** (reference for pricing decisions made in the planning session):

- **1,000-pack annual limit:** 3 per `(owner_id, calendar_year)`. 3rd purchase shows soft Enterprise warning. 4th is blocked and auto-creates an Enterprise lead in the developer dashboard.
- **Enterprise tier:** Listed as a visible tier with "Contact us" — no public price. Not self-serve.
- **Add-on rollover:** Exactly 30 days from purchase date. Not calendar-month aligned.
- **Soft overage posture:** Tight from day one (Posture B). Starter 300+30→500 hard. Pro 1,000+100→2,000 hard. Tight expectations are loosenable; generous ones aren't revocable without trust damage.

**End of appendix.**
