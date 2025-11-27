// routes/deepDive.js
// Deep-dive API for dashboard + future analysis endpoints.
//
// POST /deep-dive/dashboard
//   Body: { ownerId, question, period? }
//   Returns: { ok, answer, debug? }
//
// This uses:
//   - services/kpis.getCompanyKpis         → company-level KPIs
//   - services/jobsKpis.getJobKpiSummary   → job-level KPIs
//   - OpenAI                               → Chief's voice

const express = require('express');
const router = express.Router();

const { getCompanyKpis } = require('../services/kpis');
const { getJobKpiSummary } = require('../services/jobsKpis');

let OpenAI;
try {
  OpenAI = require('openai');
} catch {
  OpenAI = null;
}

/* ------------ Helpers ------------ */

function summariseCompanyMetrics(metrics = {}) {
  const cents = (v) => (v == null ? null : Number(v));
  const num = (v) => (v == null ? null : Number(v));

  const revenue = cents(metrics.invoiced_amount_period);
  const netProfit = cents(metrics.net_profit);
  const grossMarginPct = num(metrics.gross_margin_pct);
  const ar = cents(metrics.total_accounts_receivable);
  const ap = cents(metrics.total_accounts_payable);
  const cash = cents(metrics.cash_in_bank);
  const wc = cents(metrics.working_capital);
  const debtorDays = num(metrics.average_debtor_days);

  const fmtMoney = (v) =>
    v == null ? '—' : `$${(v / 100).toLocaleString('en-CA', { maximumFractionDigits: 0 })}`;
  const fmtPct = (v) => (v == null ? '—' : `${v.toFixed(1)}%`);

  const lines = [
    `Revenue (invoiced): ${fmtMoney(revenue)}`,
    `Net profit: ${fmtMoney(netProfit)}`,
    `Gross margin: ${fmtPct(grossMarginPct)}`,
    `Cash in bank: ${fmtMoney(cash)}`,
    `Accounts receivable (AR): ${fmtMoney(ar)}`,
    `Accounts payable (AP): ${fmtMoney(ap)}`,
    `Working capital: ${fmtMoney(wc)}`,
    `Average debtor days: ${debtorDays ?? '—'} days`,
  ];

  return lines.join('\n');
}

function summariseTopJobs(jobs = [], limit = 5) {
  if (!jobs.length) return 'No job KPIs yet.';

  const fmtMoney = (v) =>
    v == null ? '—' : `$${(Number(v) / 100).toLocaleString('en-CA', { maximumFractionDigits: 0 })}`;

  const topByProfit = [...jobs]
    .sort((a, b) => Number(b.gross_profit_cents || 0) - Number(a.gross_profit_cents || 0))
    .slice(0, limit);

  const lines = topByProfit.map((j) => {
    const name = j.job_name || `Job #${j.job_no}`;
    const profit = fmtMoney(j.gross_profit_cents);
    const margin = j.gross_margin_pct != null ? `${Number(j.gross_margin_pct).toFixed(1)}%` : '—';
    const holdback = fmtMoney(j.holdback_cents);
    const slip = j.slippage_cents != null ? Number(j.slippage_cents) : null;
    let slipLabel = '';
    if (slip != null) {
      const sign = slip > 0 ? 'above' : slip < 0 ? 'below' : 'at';
      slipLabel = ` | vs estimate: ${fmtMoney(Math.abs(slip))} ${sign}`;
    }
    return `- ${name}: profit ${profit} at ${margin} margin | holdbacks ${holdback}${slipLabel}`;
  });

  return lines.join('\n');
}

function getOpenAIClient() {
  if (!OpenAI) return null;
  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_API_TOKEN;
  if (!apiKey) return null;
  return new OpenAI({ apiKey });
}

/* ------------ Routes ------------ */

// Simple ping
router.get('/', (req, res) => {
  res.json({
    ok: true,
    routes: ['POST /deep-dive/dashboard'],
  });
});

// Dashboard Q&A endpoint
router.use(express.json({ limit: '1mb' }));

router.post('/dashboard', async (req, res) => {
  const { ownerId, question, period } = req.body || {};

  if (!ownerId || !question) {
    return res.status(400).json({
      ok: false,
      error: 'ownerId and question are required',
    });
  }

  const started = Date.now();

  try {
    // 1) Load metrics
    const [kpiBundle, jobs] = await Promise.all([
      getCompanyKpis({ ownerId, period }),
      getJobKpiSummary(ownerId),
    ]);

    const metrics = kpiBundle?.metrics || {};
    const companySummary = summariseCompanyMetrics(metrics);
    const jobsSummary = summariseTopJobs(jobs);

    // 2) If OpenAI not configured, fall back to a simple textual summary
    const client = getOpenAIClient();
    if (!client) {
      return res.json({
        ok: true,
        answer:
          `Chief (offline mode) — I don’t have access to the AI brain right now,\n` +
          `but here’s a quick snapshot based on your data:\n\n` +
          `Company overview:\n${companySummary}\n\n` +
          `Top jobs:\n${jobsSummary}\n\n` +
          `Your question was:\n"${question}"\n\n` +
          `Once OPENAI_API_KEY is set on the server, this endpoint will answer in full CFO detail.`,
        debug: {
          period: period || 'default',
          jobCount: jobs.length,
        },
      });
    }

    // 3) Call OpenAI with CFO-style prompt
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    const systemPrompt = `
You are "Chief", a no-nonsense construction CFO and job-costing expert.

Audience: small construction contractors (roofing, siding, GC, trades).
Education: aim at Grade 10-11 financial literacy. Avoid jargon unless you explain it in plain language.

You are connected to the contractor's actual numbers. You will receive:
- Company-level KPIs (in cents where applicable)
- Job-level KPIs for multiple jobs

Your goals:
1) Answer the user's question directly and clearly.
2) Use their actual numbers (revenue, profit, AR, AP, cash, margins, holdbacks, slippage).
3) Give 2–4 concrete actions (e.g. "call this customer", "raise price on this job type", "tighten crew hours").
4) Keep replies under about 250–300 words. Use short paragraphs and bullets.

If numbers look weak, be honest but encouraging. Focus on "here's what to fix next week", not judgement.
`.trim();

    const userContext = `
Owner ID: ${ownerId}
Period: ${period || 'not specified'}

Company KPIs:
${companySummary}

Job KPIs (top jobs):
${jobsSummary}

Question from owner:
"${question}"
`.trim();

    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContext },
      ],
      temperature: 0.3,
    });

    const answer = completion.choices?.[0]?.message?.content?.trim() || '';

    return res.json({
      ok: true,
      answer,
      debug: {
        period: period || 'default',
        jobCount: jobs.length,
      },
    });
  } catch (err) {
    console.error('[DEEP-DIVE] dashboard error:', err);
    return res.status(500).json({
      ok: false,
      error: 'Deep-dive error',
    });
  } finally {
    const ms = Date.now() - started;
    if (ms > 3000) {
      console.warn('[DEEP-DIVE] slow dashboard response', { ms });
    }
  }
});

module.exports = router;
