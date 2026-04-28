'use strict';

/**
 * workers/taxReadiness.js
 * Phase 3.5 — Quarterly Tax Readiness Summary
 *
 * Runs quarterly (Jan 1, Apr 1, Jul 1, Oct 1 at 9AM UTC).
 * Generates a structured tax summary and sends via WhatsApp.
 */

const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const { sendQuickReply } = require('../services/twilio');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function toInt(x) { const n = Number(x); return Number.isFinite(n) ? Math.trunc(n) : 0; }
function fmt(cents) { return `$${(Math.abs(cents) / 100).toFixed(2)}`; }

const HST_RATE = 0.13;

function getLastCompletedQuarter() {
  const now = new Date();
  const m   = now.getUTCMonth();
  const y   = now.getUTCFullYear();

  if (m === 0)           return { year: y - 1, q: 4, from: `${y - 1}-10-01`, to: `${y - 1}-12-31` };
  if (m >= 1 && m <= 3) return { year: y,     q: 1, from: `${y}-01-01`,     to: `${y}-03-31` };
  if (m >= 4 && m <= 6) return { year: y,     q: 2, from: `${y}-04-01`,     to: `${y}-06-30` };
  if (m >= 7 && m <= 9) return { year: y,     q: 3, from: `${y}-07-01`,     to: `${y}-09-30` };
  return { year: y, q: 4, from: `${y}-10-01`, to: `${y}-12-31` };
}

async function fetchTaxData(ownerId, { from, to }) {
  const o = String(ownerId);

  const revResult = await pool.query(`
    SELECT COALESCE(category, 'Revenue') AS category, SUM(amount_cents) AS total
    FROM public.transactions
    WHERE owner_id::text = $1 AND kind = 'revenue' AND date >= $2::date AND date <= $3::date
    GROUP BY category ORDER BY total DESC
  `, [o, from, to]).catch(() => null);

  const revenueByCategory = {};
  let totalRevenue = 0;
  for (const r of (revResult?.rows || [])) {
    revenueByCategory[r.category] = toInt(r.total);
    totalRevenue += toInt(r.total);
  }

  const expResult = await pool.query(`
    SELECT COALESCE(category, 'Uncategorised') AS category, SUM(amount_cents) AS total, COUNT(*) AS tx_count
    FROM public.transactions
    WHERE owner_id::text = $1 AND kind = 'expense' AND date >= $2::date AND date <= $3::date
    GROUP BY category ORDER BY total DESC
  `, [o, from, to]).catch(() => null);

  const expensesByCategory = {};
  let totalExpenses = 0, uncategorisedCount = 0, uncategorisedCents = 0;

  for (const r of (expResult?.rows || [])) {
    expensesByCategory[r.category] = { total: toInt(r.total), count: toInt(r.tx_count) };
    totalExpenses += toInt(r.total);
    if (r.category === 'Uncategorised') {
      uncategorisedCount = toInt(r.tx_count);
      uncategorisedCents = toInt(r.total);
    }
  }

  const mileageResult = await pool.query(`
    SELECT SUM(distance_km) AS total_km, SUM(deductible_amount_cents) AS deductible_cents
    FROM public.mileage_logs
    WHERE owner_id::text = $1 AND date >= $2::date AND date <= $3::date
  `, [o, from, to]).catch(() => null);

  const totalKm          = Math.round(Number(mileageResult?.rows?.[0]?.total_km) || 0);
  const mileageDeductible = toInt(mileageResult?.rows?.[0]?.deductible_cents);

  const overheadResult = await pool.query(`
    SELECT SUM(amount_cents) AS total
    FROM public.overhead_payments
    WHERE owner_id::text = $1 AND paid_at::date >= $2::date AND paid_at::date <= $3::date
  `, [o, from, to]).catch(() => null);

  const overheadPaid = toInt(overheadResult?.rows?.[0]?.total);
  const hstCollected = Math.round(totalRevenue * HST_RATE);

  return {
    period_from: from, period_to: to,
    total_revenue: totalRevenue, revenue_by_category: revenueByCategory,
    total_expenses: totalExpenses, expenses_by_category: expensesByCategory,
    mileage_km: totalKm, mileage_deductible: mileageDeductible,
    overhead_paid: overheadPaid, hst_collected_est: hstCollected,
    uncategorised_count: uncategorisedCount, uncategorised_cents: uncategorisedCents,
    net_income: totalRevenue - totalExpenses,
  };
}

async function generateTaxSummary(data, quarter) {
  const client = new Anthropic();

  const topExpenses = Object.entries(data.expenses_by_category)
    .filter(([k]) => k !== 'Uncategorised')
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 6)
    .map(([cat, { total }]) => `${cat}: ${fmt(total)}`).join(', ');

  const dataLines = [
    `Quarter: Q${quarter.q} ${quarter.year} (${data.period_from} to ${data.period_to})`,
    `Total Revenue: ${fmt(data.total_revenue)}`,
    `Total Expenses: ${fmt(data.total_expenses)}`,
    `Net Income: ${fmt(data.net_income)}`,
    `Top expense categories: ${topExpenses || 'none'}`,
    `Mileage: ${data.mileage_km} km (est. deductible: ${fmt(data.mileage_deductible)})`,
    `Overhead payments: ${fmt(data.overhead_paid)}`,
    `HST/GST collected (estimate at 13%): ${fmt(data.hst_collected_est)}`,
    data.uncategorised_count ? `Uncategorised transactions: ${data.uncategorised_count} (${fmt(data.uncategorised_cents)}) — need categorising` : null,
  ].filter(Boolean).join('\n');

  const system = [
    'You are Chief, a plain-language CFO for contractors.',
    'Summarise this quarter\'s tax data in 5–7 lines for a contractor.',
    'Highlight: total income, major deduction categories, mileage, HST collected.',
    'If there are uncategorised items, urgently flag them — they affect deductions.',
    'End with: "I can send a detailed breakdown to share with your accountant."',
    'WhatsApp format. No bullet overload.',
  ].join(' ');

  const response = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages:   [{ role: 'user', content: dataLines }],
    system,
  });

  return response.content?.[0]?.text?.trim() || '';
}

async function runTaxReadiness() {
  const quarter = getLastCompletedQuarter();
  const signalSuffix = `${quarter.year}_Q${quarter.q}`;

  // Post-rebuild canonical owner registry: public.users
  // (chiefos_tenant_actor_profiles DISCARDed per Decision 12).
  // user_id is the digits PK = phone_digits.
  const ownersResult = await pool.query(`
    SELECT owner_id, user_id AS phone_digits, tenant_id
      FROM public.users
     WHERE role = 'owner'
  `).catch(() => null);

  const owners = ownersResult?.rows || [];
  let processed = 0, sent = 0, errors = 0;

  for (const owner of owners) {
    const signalKey = `tax_readiness_${owner.owner_id}_${signalSuffix}`;

    try {
      const existing = await pool.query(
        `SELECT id FROM public.insight_log WHERE owner_id = $1 AND signal_key = $2 LIMIT 1`,
        [String(owner.owner_id), signalKey]
      ).catch(() => null);
      if (existing?.rows?.length) continue;

      const data = await fetchTaxData(owner.owner_id, { from: quarter.from, to: quarter.to });
      if (data.total_revenue === 0 && data.total_expenses === 0) continue;

      processed++;

      const summary = await generateTaxSummary(data, quarter);
      if (!summary) continue;

      const header  = `🧾 *Q${quarter.q} ${quarter.year} Tax Summary*\n\n`;
      const fullMsg = header + summary;

      await sendQuickReply(`+${owner.phone_digits}`, fullMsg, ['Send to Accountant', 'Got it']);
      sent++;

      await pool.query(`
        INSERT INTO public.insight_log (tenant_id, owner_id, kind, signal_key, payload, message_text)
        VALUES ($1, $2, 'tax_readiness', $3, $4, $5)
        ON CONFLICT (owner_id, signal_key) DO NOTHING
      `, [owner.tenant_id, String(owner.owner_id), signalKey, JSON.stringify({ quarter, data }), fullMsg])
        .catch(() => {});

      console.log(`[taxReadiness] sent Q${quarter.q} summary to ${owner.owner_id}`);

    } catch (err) {
      errors++;
      console.error(`[taxReadiness] error for ${owner.owner_id}:`, err?.message);
    }
  }

  return { quarter: `Q${quarter.q} ${quarter.year}`, processed, sent, errors };
}

module.exports = { runTaxReadiness, fetchTaxData };
