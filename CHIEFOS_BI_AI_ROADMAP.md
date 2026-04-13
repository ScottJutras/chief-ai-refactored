# ChiefOS — Conversational BI & AI Intelligence Roadmap

**Version:** 1.0
**Date:** April 2026
**Author:** Claude Code (Strategic Technical Plan)

---

## Executive Summary

ChiefOS is not a bookkeeping app with a chat widget bolted on. The conversational interface **is** the BI interface. The entire product thesis is that a contractor on a job site — hands dirty, phone in a pocket — can get CFO-level financial intelligence through the same channel they already use: WhatsApp. No dashboards to open, no reports to run, no learning curve.

This document maps the path from what ChiefOS already has (which is substantial) to a full conversational intelligence platform. The north star is: every insight a CFO would pull from a BI tool — margin trends, labour utilisation, cost overruns, cash flow forecasting — should be deliverable via a WhatsApp message, proactively or on demand, in plain language a tradesperson can act on in 30 seconds.

The existing architecture is well-positioned for this. The data is there: transactions, jobs, time entries, overhead, crew rates, mileage. The transport is there: Twilio/WhatsApp, an agent loop, tool-calling, CIL pipeline. What's missing is the intelligence layer that turns that data into proactive, opinionated, conversational financial analysis.

---

## Current State Assessment

### What's Already Built (and good)

**Data Layer — Strong Foundation**

The transaction table is the canonical financial spine. Every dollar in and out is in `transactions`, scoped by `tenant_id`, linked to `job_id`, categorised by CRA/IRS codes. Time entries are in `time_entries_v2` with GPS, job allocation, and crew rates in `chiefos_crew_rates`. Overhead is tracked with monthly confirmation flows. Mileage is logged with deductible calculations. This is not MVP data — this is production-grade financial data that a CFO would use.

**AI Agent — Functional but Reactive**

`services/agent/index.js` has a working tool-calling loop with `search_transactions`, `get_spend_summary`, `get_job`, and `search_tasks`. The agent can answer natural language queries like "how much did we spend on materials last month?" today. The gap is that it only responds — it never initiates. There is no proactive intelligence, no anomaly detection, no scheduled dispatch of insights. The agent also lacks job-level P&L tools, labour cost analysis, and cash flow projection tools.

**WhatsApp Webhook — Production-Grade**

The webhook handler is mature: idempotency via `source_msg_id`, interactive list pickers, pending action state machine, plan gating, and a clean CIL pipeline. Adding proactive outbound messages (scheduled digests, anomaly alerts) requires only calling Twilio's Messages API from a background worker — the infrastructure to do so already exists.

**KPI Services — Underused**

`services/kpis.js`, `services/jobsKpis.js`, and `services/computeFinanceKpis.js` compute profit margins, revenue vs expenses, labour costs, and category breakdowns. These are called from portal routes but are **never surfaced via WhatsApp or the AI agent**. This is the biggest immediate gap: there's computed intelligence sitting unused.

### What's Missing

| Gap | Impact |
|-----|--------|
| No proactive WhatsApp dispatch | Users must ask; Chief never initiates |
| Agent has no job P&L tool | Can't answer "is Job 12 profitable?" |
| Agent has no labour cost tool | No crew utilisation analysis |
| No anomaly detection | Cost overruns discovered at invoice time |
| No scheduled digest worker | No weekly/monthly summaries |
| No predictive costing | Every job estimate starts from scratch |
| No margin monitoring | Job can go underwater without alert |
| No receivables tracking | No invoice follow-up automation |
| No voice input pipeline | Field workers type on small screens |
| No budget vs actual tracking | Budgets captured but never compared |

---

## Architecture for the Intelligence Layer

Before detailing features, it's worth naming the architectural pattern that makes all of them possible: **the Insight Dispatch Loop**.

```
┌─────────────────────────────────────────────────────┐
│                 Insight Dispatch Loop                 │
│                                                       │
│  Cron / Event Trigger                                 │
│         │                                             │
│         ▼                                             │
│  Compute Signal (SQL query or KPI function)           │
│         │                                             │
│         ▼                                             │
│  Evaluate Rule (is this worth sending?)               │
│         │                                             │
│         ▼                                             │
│  Generate Message (LLM → plain language)              │
│         │                                             │
│         ▼                                             │
│  Dispatch via Twilio outbound                         │
│         │                                             │
│         ▼                                             │
│  Store in insight_log (dedup + audit)                 │
└─────────────────────────────────────────────────────┘
```

Every proactive feature in this roadmap is an instance of this pattern. The loop runs as a Vercel Cron Job (or persistent background worker) and evaluates signals on a schedule. The LLM is only called when a signal crosses a threshold — keeping LLM costs proportional to actionable events, not time elapsed.

A new table, `insight_log`, tracks what was sent to whom and when, preventing duplicate alerts and enabling drill-down follow-up.

```sql
CREATE TABLE insight_log (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  owner_id     text NOT NULL,
  kind         text NOT NULL,  -- 'weekly_digest' | 'margin_alert' | 'anomaly' | etc.
  signal_key   text,           -- dedup key (e.g., 'job_123_margin_alert_2026_04')
  payload      jsonb,          -- data used to generate message
  message_text text,           -- what was actually sent
  sent_at      timestamptz DEFAULT now(),
  acknowledged_at timestamptz, -- user tapped "got it" or replied
  UNIQUE(owner_id, signal_key) -- prevents re-sending same alert
);
```

This single table is a dependency for all proactive features. Build it first.

---

## Phase 1 — Quick Wins (2–4 weeks)

These features require no new data collection, no structural changes to the AI agent, and no new infrastructure. They unlock immediate value from data that already exists.

### 1.1 Weekly Financial Digest (WhatsApp)

**What it is:** Every Friday afternoon, Chief sends a plain-language summary of the week's financial activity — revenue logged, expenses by category, hours worked, margin on active jobs. No dashboard required.

**Why it matters:** Most contractors don't open dashboards. A message they receive unprompted, in the channel they already use, turns passive data into active awareness. This is the Tableau Pulse insight for contractors.

**Technical approach:**

Create `workers/weeklyDigest.js`. This worker:

1. Runs via Vercel Cron (`vercel.json`) every Friday at 4pm local time (tz from `chiefos_portal_users.tz`)
2. Queries `transactions` for the ISO week: revenue, expenses by category, profit
3. Queries `time_entries_v2` for total hours + estimated labour cost (from `chiefos_crew_rates`)
4. Calls `services/computeFinanceKpis.js` for margin calculation
5. Builds a structured data object and passes it to Claude (claude-haiku-4-5 for cost) with a system prompt: *"You are Chief, a plain-language CFO for contractors. Summarise this week's numbers in 4–6 lines. Be specific. Flag anything worth attention. Sound like a trusted advisor, not a spreadsheet."*
6. Sends via `services/twilio.js` outbound
7. Logs to `insight_log` with `signal_key = 'weekly_digest_${year}_${week}'`

**Upgrade from the original idea:** Don't just send numbers — have the LLM generate a single "watch out" line if anything is unusual. E.g.: *"Labour was 68% of revenue this week — your target is usually under 40%. You may want to review Job 7's hours."* This turns a digest into an advisory.

**Cost:** ~$0.003 per digest (haiku, low token count). For 1,000 users, $3/week.

**Dedup:** `UNIQUE(owner_id, signal_key)` on `insight_log` prevents double-send if the cron fires twice.

---

### 1.2 Job P&L Tool for the AI Agent

**What it is:** Add a `get_job_pnl` tool to the agent so "how is Job 7 looking?" returns a structured P&L: revenue logged, materials, labour, overhead allocation, margin %.

**Why it matters:** Job profitability is the single most important financial question a contractor has. The data is all in `transactions` and `time_entries_v2` — the agent just doesn't have a tool to aggregate it.

**Technical approach:**

Add to `services/agent/index.js`:

```js
{
  name: "get_job_pnl",
  description: "Get profit and loss for a specific job. Returns revenue, expenses by category, labour cost, and margin.",
  parameters: {
    type: "object",
    properties: {
      job_id: { type: "string" },
      job_no: { type: "integer" },
      date_from: { type: "string", description: "ISO date, optional" },
      date_to: { type: "string", description: "ISO date, optional" }
    }
  }
}
```

The tool handler queries:
- `transactions` WHERE `job_id = $1` for revenue and expense totals, grouped by `category`
- `time_entries_v2` paired with `chiefos_crew_rates` for labour cost (hours × rate)
- `job_phases` for phase-level breakdown if phases exist
- Returns: `{ revenue_cents, materials_cents, labour_cents, other_expense_cents, profit_cents, margin_pct, phase_breakdown }`

The agent then synthesises: *"Job 7 (Kitchen Reno) is currently at 34% margin. You've logged $8,400 in revenue against $5,540 in costs. Labour is running a bit high at $2,100 — that's 38% of revenue. Overall you're on track if you stick to the original scope."*

**This is the most high-leverage single change in Phase 1.** It makes the existing agent dramatically more useful with a few hours of work.

---

### 1.3 Smart Margin Alert

**What it is:** When an active job's margin drops below a configurable threshold (default: 20%), Chief sends a WhatsApp alert. Not once a week — within hours of the job going underwater.

**Why it matters:** The worst time to discover a job is a loss is when you send the invoice. Catching it mid-job gives the contractor time to adjust: reduce scope, have a change order conversation, or at minimum set expectations.

**Technical approach:**

Add to `workers/marginMonitor.js` (runs every 6 hours via cron):

1. Fetch all active jobs for each tenant
2. For each job: run the same P&L query as `get_job_pnl`
3. If `margin_pct < threshold` AND this alert hasn't been sent in the last 7 days:
   - Generate plain-language alert via Claude
   - Send WhatsApp with a quick-reply: `[View Breakdown]` / `[Got it]`
   - Log to `insight_log` with `signal_key = 'margin_alert_${job_id}_${year}_${month}'`
4. If `[View Breakdown]` tapped: trigger `get_job_pnl` and send full breakdown

**Threshold storage:** Add a `settings` column (jsonb) to `chiefos_tenants` for per-tenant thresholds. Default `{ "margin_alert_threshold_pct": 20 }`.

**Upgrade:** Add a trend check — alert not just when margin is low, but when it's declining rapidly over 7 days even if still above threshold. Pattern: *"Job 12's margin dropped from 41% to 28% this week. It's still positive but moving fast in the wrong direction."*

---

### 1.4 End-of-Day Job Summary

**What it is:** At 6pm on any day where a job has activity (transactions logged, time entries, photos), Chief sends a one-paragraph summary of the day's work on that job. This summary is forwardable to the client.

**Why it matters:** Two use cases: (1) owner gets a daily briefing on what happened across jobs without opening a portal; (2) the summary can be forwarded directly to the client as a professional daily update. Contractors who send daily updates retain clients and charge higher margins.

**Technical approach:**

`workers/dailyJobSummary.js` (runs at 6pm local time):

1. Query `transactions` and `time_entries_v2` for today, grouped by `job_id`
2. Query `job_photos` for photos taken today (by `taken_at` date)
3. For each job with activity: build a structured payload (hours worked, materials bought, tasks completed, photos taken)
4. Pass to Claude: *"Generate a professional 3–4 sentence site update for this contractor's client. Describe what was accomplished today. Include materials used, hours on site, and any notable progress. Professional but readable, not jargon-heavy."*
5. Send WhatsApp with the message + button: `[Forward to Client]`
6. If `[Forward to Client]` tapped: trigger the existing job document sharing flow (SMS/email to customer)

**Upgrade:** Pull `job_phases` to include the current phase name in the summary. *"Day 4 of rough framing: 6.5 hours on site, $340 in lumber from Home Depot. Framing is roughly 70% complete."*

---

## Phase 2 — Core Intelligence Layer (4–8 weeks)

These features require new tools in the agent, new SQL queries, or light schema additions. They build on Phase 1's dispatch infrastructure.

### 2.1 Anomaly Detection & Proactive Flagging

**What it is:** Chief automatically flags unusual patterns — a vendor charging 40% more than usual, a category of spending that's double the monthly average, a job where expenses are logged faster than revenue. No user asks required.

**Why it matters:** Anomalies are invisible until they compound. A subcontractor invoice that doubled, a fuel spend that tripled because someone's logging personal fill-ups — these should surface immediately.

**Technical approach:**

Add `services/anomalyDetector.js`. This service implements three detection functions:

**Vendor price anomaly:**
```sql
-- Compare current invoice to 90-day average for same vendor
SELECT
  vendor,
  AVG(amount_cents) as avg_90d,
  STDDEV(amount_cents) as stddev_90d
FROM transactions
WHERE owner_id = $1
  AND kind = 'expense'
  AND date >= NOW() - INTERVAL '90 days'
GROUP BY vendor
```
Flag if new transaction > avg + 2.5σ. Send: *"New expense from Home Depot ($340) is 3x your usual Home Depot spend ($112 avg). Was this a large order or possibly a duplicate?"*

**Category spike:**
- Compare MTD spend per category vs. trailing 3-month monthly average
- Flag at 150% of average
- Include comparison context in message

**Revenue/expense imbalance on active jobs:**
- Flag jobs where cumulative expenses > 80% of total quoted revenue with less than 50% of estimated hours used
- Signals early scope creep or budget error

**LLM role:** Not for detection (SQL handles that) but for generating a natural-language alert with context and a suggested action. Keep haiku — the detection logic is deterministic, the LLM only formats the message.

**Rate limiting:** Maximum 3 anomaly alerts per day per tenant. Store in `insight_log` with `kind = 'anomaly'`. Batch same-day anomalies into a single message.

---

### 2.2 Labour Utilisation Analysis

**What it is:** A set of agent tools and a periodic report on crew efficiency — billable hours vs. total hours, cost per billable hour, revenue generated per crew member, idle time patterns.

**Why it matters:** Labour is typically 35–60% of a contractor's costs and the hardest to optimise. Current ChiefOS tracks hours and has crew rates, but never computes utilisation metrics.

**Technical approach:**

Add `get_labour_utilisation` tool to agent:

```js
{
  name: "get_labour_utilisation",
  parameters: {
    date_from: "ISO date",
    date_to: "ISO date",
    employee_name: "string, optional — filter to one crew member"
  },
  // Returns: hours by employee, billable %, cost, revenue contribution
}
```

SQL backbone:
```sql
SELECT
  te.employee_name,
  SUM(
    EXTRACT(EPOCH FROM (te_out.timestamp - te_in.timestamp)) / 3600
  ) as total_hours,
  cr.hourly_rate_cents,
  -- join to transactions to get revenue on those job/days
  SUM(t_rev.amount_cents) as revenue_during_hours
FROM time_entries_v2 te_in
JOIN time_entries_v2 te_out ON ...  -- clock_in/clock_out pair matching
LEFT JOIN chiefos_crew_rates cr ON ...
LEFT JOIN transactions t_rev ON t_rev.job_id = te_in.job_id
GROUP BY te.employee_name, cr.hourly_rate_cents
```

The agent then summarises: *"This week: Mike logged 38 hours at $45/hr ($1,710 cost). He was on Job 7 for 32 of those hours where you logged $4,200 in revenue — that's a strong 59% labour margin on his time. The 6 hours on Tuesday with no job assigned are worth looking at."*

**Monthly utilisation digest:** Add to the weekly digest a crew section that shows top performer and any employee with >20% unallocated hours.

---

### 2.3 Natural Language Querying — Enhanced

**What it is:** Expand the agent's existing NLQ capability with richer tools and better prompt engineering to handle the full range of CFO-style questions a contractor might ask.

**Current gaps in the agent:**
- No job P&L tool (addressed in Phase 1)
- No labour cost tool (addressed above)
- No cash flow tool (see below)
- No "compare period" capability (this month vs last month)
- No "top N" queries (top 5 jobs by margin, top 3 vendors by spend)

**New tools to add:**

`compare_periods` — takes two date ranges and a metric (revenue, expenses, margin, hours), returns structured comparison:
```
Q: "How does this month compare to last month?"
A: "March revenue was $18,400, up 23% from February's $14,950. Expenses were nearly flat ($9,200 vs $8,800). Your margin improved from 41% to 50% — strong month."
```

`get_top_n` — ranked queries:
```
Q: "What are my top jobs this year by profit?"
A: "1. Job 3 (Smith Kitchen) — $8,200 profit (44% margin)
    2. Job 7 (Office Reno) — $5,100 profit (38% margin)
    3. Job 12 (Basement Finish) — $3,400 profit (29% margin)"
```

`get_receivables` — outstanding invoices and revenue gaps:
```
Q: "What am I still waiting to get paid for?"
A: "You have $14,500 in revenue logged against Job 5 (Henderson) but no corresponding payment confirmed. Job 9 also has $3,200 in outstanding deposits."
```

**Prompt engineering improvement:** The system prompt currently treats all financial queries the same. Add a "CFO framing" instruction: *"You are the Chief Financial Officer for this contracting business. Your job is not to read back numbers — it's to interpret them. When you share financial data, always include: (1) whether this is good or concerning, (2) a comparison benchmark (prior period, target, or industry norm), (3) one suggested action if anything is off-track."*

---

### 2.4 Voice Input Pipeline

**What it is:** WhatsApp voice messages (audio notes) transcribed and routed through the existing command/agent flow.

**Why it matters:** Field workers type slowly, especially on site. Voice is the natural interface for a contractor drilling, welding, or painting. "Expense eighty-five dollars lumber yard today job seven" takes 3 seconds to say and 30 seconds to type.

**Current state:** No voice handling exists. The webhook checks for `MediaContentType` to detect images but doesn't handle audio.

**Technical approach:**

In `routes/webhook.js`, add detection for audio media types:
```js
const isAudio = mediaContentType?.startsWith('audio/') ||
                mediaContentType === 'audio/ogg' ||  // WhatsApp voice notes
                mediaContentType === 'audio/mpeg';
```

If audio detected:
1. Download the voice note from `MediaUrl0` using Twilio credentials
2. Pass to OpenAI Whisper (`whisper-1` model) for transcription
3. Take the transcription text and route it through the existing command parser / agent — exactly as if the user had typed it
4. Optionally echo back: *"I heard: 'expense eighty-five lumber yard job seven' — confirming $85 at Lumber Yard for Job 7?"*

Cost: Whisper is $0.006/minute. A typical voice expense log is under 10 seconds — roughly $0.001/message.

**The agent already handles the rest.** This is purely an input layer change, not an intelligence change.

**Upgrade:** For longer voice messages (> 30 seconds), detect if it's a status update or instruction rather than a log command, and route to the agent for interpretation rather than the fast-path parser.

---

### 2.5 Budget vs. Actual Tracking

**What it is:** Activate the budget tracking infrastructure that exists (quote line items, job document amounts) and surface variance in the agent and in alerts.

**Current state:** `quote_line_items` stores labour, materials, and other budget estimates per job. `transactions` stores actuals. The comparison is never made.

**Technical approach:**

Add `get_job_budget_vs_actual` tool:
```sql
SELECT
  q.category,
  SUM(q.qty * q.unit_price_cents) as budgeted_cents,
  SUM(t.amount_cents) as actual_cents,
  (SUM(t.amount_cents) - SUM(q.qty * q.unit_price_cents)) as variance_cents
FROM quote_line_items q
LEFT JOIN transactions t ON t.job_id = q.job_id
  AND t.category = q.category
  AND t.kind = 'expense'
WHERE q.job_id = $1
GROUP BY q.category
```

Output:
```
Job 7 Budget vs. Actual:
• Labour: $4,200 budgeted / $3,100 spent — $1,100 under ✓
• Materials: $2,800 budgeted / $3,340 spent — $540 over ✗
• Subcontractors: $1,500 budgeted / $0 spent — not started
```

**Alert hook:** If materials or labour variance exceeds 15% of budget, trigger the margin alert flow. This is the "opinionated contractor dashboard" made conversational.

---

## Phase 3 — Advanced Predictive & Proactive Intelligence (8–16 weeks)

These features require historical pattern analysis, cross-job learning, and more sophisticated ML/AI beyond the current agent.

### 3.1 Predictive Job Costing

**What it is:** When a contractor creates a new quote, Chief automatically suggests budget ranges for labour, materials, and subcontractors based on historical performance on similar jobs.

**Why it matters:** Estimating is where contractors lose money. Most quote from gut feel or copy-paste from the last job. Historical actuals, not estimates, are the most accurate predictor of cost.

**Technical approach:**

Create `services/jobCostPredictor.js`:

1. **Similarity scoring:** When a new job is created or a quote line item is being entered, find historical jobs with similar:
   - Job name keywords (fuzzy match on `job_name`)
   - Scale proxy: total quoted or billed revenue
   - Seasonal timing (jobs in same month historically)

2. **Cost distribution:** For matched jobs, compute:
   ```
   P25, P50, P75 for: materials, labour, subcontractors, overhead_allocation
   ```

3. **Suggest via WhatsApp when job is created:**
   *"New job created: Basement Reno (est. $15,000). Based on your last 4 basement projects, here's what to budget: Labour $4,200–$6,100 (35–41%), Materials $2,800–$3,900 (19–26%), Subcontractors $1,200–$2,400. Does that match your estimate? Reply with your line items and I'll track against these benchmarks."*

4. **Outlier detection at quote stage:** If a quote line item is >50% above P75 of historical actuals, flag: *"Your materials estimate of $6,200 is higher than any similar job you've done. Is this a larger scope or did costs change?"*

**Minimum viable dataset:** This feature needs at least 5 completed jobs with full transaction history to generate useful predictions. Add a `prediction_confidence` flag — if fewer than 5 comparable jobs, say so.

---

### 3.2 Cash Flow Forecasting

**What it is:** A forward-looking cash position estimate for the next 30/60/90 days based on open jobs, scheduled overhead, historical payment lag, and pipeline.

**Why it matters:** Contractors regularly have profitable businesses run out of cash because they pay subs before clients pay them. Seeing the cash gap 30 days out is the difference between a line of credit conversation and a crisis.

**Technical approach:**

Add `get_cash_flow_forecast` tool + a monthly proactive report:

**Inputs:**
- Active jobs and their estimated remaining revenue (quote total minus revenue logged)
- Historical payment lag: `AVG(days between revenue logged and payment confirmed)` per client type
- Overhead scheduled payments (from `overhead_items` frequency + amounts)
- Open subcontractor invoices (subcontractor expense category, partially-confirmed transactions)
- Crew payroll estimate (weekly hours × rates)

**Model (simple but effective):**
```
Projected inflows (next 30 days):
  = Σ(remaining_job_revenue × historical_collection_probability)

Projected outflows (next 30 days):
  = overhead_scheduled + estimated_labour + est_materials_from_active_jobs

Net cash position = current_balance + projected_inflows - projected_outflows
```

Note: ChiefOS doesn't have a bank balance — this requires either user input ("what's your current bank balance?") or integration. Short-term: ask the user once and store in tenant settings. Longer-term: Plaid integration.

**Output:**
*"30-day cash forecast: You have roughly $22,000 coming in (Job 7 final invoice + Job 9 deposit) against $14,800 going out (crew, overhead, pending materials). That's a positive $7,200 cushion. Watch Job 5 — the Henderson final invoice of $8,400 is 45 days past your typical collection time."*

---

### 3.3 Receivables Intelligence & Invoice Follow-Up

**What it is:** Track the gap between work completed (revenue logged) and actual payment confirmed, and automatically follow up on overdue invoices via WhatsApp.

**Current gap:** Revenue is logged when work is done, but there's no "paid" confirmation workflow and no receivables aging report.

**Schema addition:**
```sql
ALTER TABLE transactions ADD COLUMN payment_status text
  DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'partial', 'written_off'));
ALTER TABLE transactions ADD COLUMN payment_confirmed_at timestamptz;
ALTER TABLE transactions ADD COLUMN customer_id uuid REFERENCES customers(id);
```

**Flows:**

*Logging revenue:* When revenue is confirmed, status is `pending` by default.

*Payment confirmation:* WhatsApp: *"Did you receive payment for Job 7's $4,200 invoice?"* → Yes → mark `paid`. User can also say "revenue $4200 job 7 paid" as a fast-path command.

*Aging report (weekly digest addition):* Add a receivables section to the weekly digest showing total outstanding, oldest invoice, and any that have crossed 30/60/90 days.

*Proactive follow-up nudge:* If a revenue entry is > 30 days old with `payment_status = 'pending'`, send: *"Job 5 has $8,400 in unpaid invoices — the oldest is 47 days. Want me to draft a follow-up message for the client?"* → Yes → generate professional follow-up text the contractor can copy-paste or forward.

---

### 3.4 Opinionated Industry Benchmarks

**What it is:** Context-aware comparisons of a contractor's metrics against industry norms for their trade, delivered conversationally when relevant.

**Why it matters:** A 35% gross margin sounds good until you know your trade averages 45%. Benchmarks turn raw numbers into meaning.

**Technical approach:**

Create a static `services/benchmarks.js` with industry data sourced from CIBC Small Business, Statistics Canada (for Canadian contractors), and NAHB (for US). Structure:

```js
const BENCHMARKS = {
  general_contractor: {
    gross_margin_pct: { p25: 18, median: 28, p75: 38 },
    labour_pct_of_revenue: { p25: 30, median: 40, p75: 52 },
    materials_pct_of_revenue: { p25: 25, median: 35, p75: 45 }
  },
  electrician: { ... },
  plumber: { ... },
  painter: { ... }
}
```

Trade is set during onboarding (or asked if missing): *"What type of work do you primarily do? This helps me give you better context on your numbers."*

**Integration into existing agent responses:** When the agent returns a margin percentage, check against benchmarks: *"Your 34% gross margin is right at the median for general contractors (industry median: 28–38%). You're tracking well."* vs. *"Your 19% gross margin is below the bottom quartile for general contractors. Let's look at where the costs are running high."*

This doesn't require a new tool — it's a post-processing step in the agent's synthesis pass.

---

### 3.5 Tax Readiness Summaries

**What it is:** Quarterly (and year-end) summaries formatted for the contractor's accountant, showing income, deductions by CRA/IRS category, mileage, and HST/GST collected.

**Why it matters:** This directly saves accountant fees. A clean categorised summary means the accountant spends an hour filing instead of three hours untangling.

**Technical approach:**

`workers/taxReadiness.js` runs quarterly (March 31, June 30, Sept 30, Dec 31):

1. Query `transactions` grouped by `category` and `expense_category`
2. Sum `mileage_logs` for total deductible km/miles
3. Sum `overhead_payments` for recurring business expenses
4. Identify uncategorised transactions (prompt user to categorise)
5. Generate structured summary with CRA line numbers (already mapped in the `expense_categories` migration)

WhatsApp delivery: *"Q1 tax summary ready. Here's what your accountant needs: Revenue $48,200, Business expenses $29,100 (breakdown below), Mileage 2,340 km ($894 deductible), HST collected est. $6,266. 4 expenses are uncategorised — want to fix those now?"*

**Portal download:** The same data renders as a formatted PDF via the existing document generation infrastructure.

---

## Feature Dependency Map

```
insight_log table (FOUNDATION — build first)
        │
        ├── Weekly Digest (1.1)
        │       └── Labour Utilisation addition (2.2)
        │       └── Receivables addition (3.3)
        │
        ├── Margin Monitor (1.3)
        │       └── Budget vs Actual (2.5)
        │       └── Anomaly Detection (2.1)
        │
        └── Daily Job Summary (1.4)

get_job_pnl tool (Phase 1.2 — prerequisite for)
        ├── Margin Monitor signals (1.3)
        ├── Budget vs Actual (2.5)
        ├── Cash Flow Forecast (3.2)
        └── Predictive Job Costing (3.1)

Voice Input (2.4)
        └── No dependencies — pure input layer
        └── Unlocks all features for field workers

Receivables schema (3.3)
        └── Cash Flow Forecast depends on payment status (3.2)

Benchmarks service (3.4)
        └── Can be added to any agent response — no dependencies
```

---

## Implementation Order (Recommended)

| Sprint | Feature | Effort | Value |
|--------|---------|--------|-------|
| 1 | `insight_log` table + dispatch infrastructure | 1 day | Unblocks everything |
| 1 | `get_job_pnl` agent tool | 1 day | Highest immediate user value |
| 1 | Weekly digest worker | 2 days | Proactive engagement |
| 2 | Margin alert monitor | 2 days | Direct loss prevention |
| 2 | Smart anomaly detection | 3 days | Trust/retention driver |
| 2 | Voice input pipeline | 1 day | Field usability |
| 3 | Labour utilisation tool | 2 days | Pro-tier differentiator |
| 3 | Budget vs actual tool | 2 days | Quote accuracy |
| 3 | NLQ enhancements (compare_periods, get_top_n) | 3 days | Depth of analysis |
| 4 | Daily job summary worker | 2 days | Client-facing value |
| 4 | Receivables schema + payment confirmation | 3 days | Cash flow visibility |
| 5 | Cash flow forecasting | 4 days | Strategic awareness |
| 5 | Predictive job costing | 4 days | Estimation intelligence |
| 6 | Industry benchmarks service | 2 days | Context and meaning |
| 6 | Tax readiness worker | 3 days | Accountant cost savings |

---

## LLM Cost Model

All proactive intelligence features should default to `claude-haiku-4-5-20251001` for message generation — it's fast, cheap, and the structured data doing the work, not the model. Reserve `claude-sonnet-4-6` for interactive queries where the user is waiting for an answer and depth matters.

| Feature | Model | Est. tokens/call | Est. cost/call |
|---------|-------|-----------------|---------------|
| Weekly digest | Haiku | ~800 | $0.003 |
| Margin alert | Haiku | ~400 | $0.0015 |
| Anomaly alert | Haiku | ~400 | $0.0015 |
| Daily summary | Haiku | ~600 | $0.002 |
| NLQ response | Sonnet | ~1,500 | $0.015 |
| Job P&L query | Sonnet | ~1,200 | $0.012 |
| Tax summary | Haiku | ~1,200 | $0.005 |

At 500 active users: weekly digest costs ~$1.50/week. Margin alerts (assuming 5% of jobs trigger) ~$0.38/week. Total proactive intelligence cost: under $5/week for 500 users — well within product margins.

Track all spend in the existing `llm_cost_log` table with appropriate `query_kind` values for each feature.

---

## Beyond the List: Architectural Opportunities

Two bigger opportunities worth naming even if not in immediate scope:

**Multi-Modal Receipt Intelligence**

The current receipt pipeline (photo → DocumentAI/GPT-4o → line items → confirm) is reactive: user sends photo, system parses. An upgrade: when a photo arrives at a job site, Chief automatically checks if the job has an active quote and says *"I see you bought $340 in lumber at Home Depot. Your Job 7 materials budget has $1,200 remaining — you're still within scope."* This requires combining the photo pipeline with the budget tool — both of which will exist after Phase 2.

**WhatsApp as the Portal (Progressive Replacement)**

The portal exists for users who want a screen. But for a contractor who only ever uses WhatsApp, the portal adds friction. As the conversational layer deepens, consider: every portal screen should have a conversational equivalent. Job list → "list my jobs." Job detail → "how is Job 7?" Expense upload → photo in chat. The portal becomes the power user tool; WhatsApp becomes the default interface. Phase 1 and 2 build the tools to make this real.

---

## Success Metrics

For each phase, the right metrics to track:

**Phase 1:**
- Weekly digest open rate (WhatsApp read receipts)
- "How is Job X?" query volume after `get_job_pnl` ships
- Margin alert acknowledgement rate (% of alerts where user replies)

**Phase 2:**
- Anomaly alert false positive rate (user dismisses without action = likely false positive)
- Voice message volume as % of total inputs
- Labour utilisation query volume

**Phase 3:**
- Estimate accuracy improvement: compare predicted ranges to actuals over time
- Receivables collection lag change (did follow-up nudges accelerate payment?)
- Tax time: did categorisation improve? (fewer uncategorised transactions)

---

*This document reflects the codebase state as of April 2026. The architecture is production-grade and the data model is sound — the work ahead is intelligence, not infrastructure.*
