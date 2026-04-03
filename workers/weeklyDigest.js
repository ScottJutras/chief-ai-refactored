'use strict';

/**
 * workers/weeklyDigest.js
 * Phase 1.1 — Weekly Financial Digest
 *
 * Runs every Friday at 4 PM UTC.
 * For each tenant owner, computes the week's financial summary and sends a
 * plain-language WhatsApp advisory via Claude Haiku.
 */

const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const { sendWhatsApp } = require('../services/twilio');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function toInt(x) { const n = Number(x); return Number.isFinite(n) ? Math.trunc(n) : 0; }

function isoWeek(d) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
}

function isoWeekRange(d) {
  const dt = new Date(d);
  const day = dt.getUTCDay() || 7;
  const monday = new Date(dt);
  monday.setUTCDate(dt.getUTCDate() - (day - 1));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return {
    from: monday.toISOString().slice(0, 10),
    to:   sunday.toISOString().slice(0, 10),
  };
}

async function fetchWeeklyData(ownerId, { from, to }) {
  const txResult = await pool.query(`
    SELECT kind, category, SUM(amount_cents) AS total
    FROM public.transactions
    WHERE owner_id::text = $1
      AND date >= $2::date
      AND date <= $3::date
    GROUP BY kind, category
    ORDER BY kind, total DESC
  `, [String(ownerId), from, to]).catch(() => null);

  let revenueCents = 0;
  let expensesByCategory = {};
  let totalExpenseCents = 0;

  for (const row of (txResult?.rows || [])) {
    const cents = toInt(row.total);
    if (row.kind === 'revenue') {
      revenueCents += cents;
    } else if (row.kind === 'expense') {
      const cat = row.category || 'Uncategorised';
      expensesByCategory[cat] = (expensesByCategory[cat] || 0) + cents;
      totalExpenseCents += cents;
    }
  }

  const labourResult = await pool.query(`
    SELECT
      SUM(EXTRACT(EPOCH FROM (COALESCE(clock_out, NOW()) - clock_in)) / 3600.0) AS total_hours,
      COUNT(DISTINCT employee_name) AS crew_count
    FROM public.time_entries_v2
    WHERE owner_id::text = $1
      AND clock_in >= $2::timestamptz
      AND clock_in <= ($3::date + interval '1 day')::timestamptz
  `, [String(ownerId), `${from}T00:00:00Z`, to]).catch(() => null);

  const totalHours = Math.round((Number(labourResult?.rows?.[0]?.total_hours) || 0) * 10) / 10;
  const crewCount  = toInt(labourResult?.rows?.[0]?.crew_count);

  const jobsResult = await pool.query(`
    SELECT
      j.id, j.name, j.job_no,
      SUM(CASE WHEN t.kind = 'revenue' THEN t.amount_cents ELSE 0 END) AS rev,
      SUM(CASE WHEN t.kind = 'expense' THEN t.amount_cents ELSE 0 END) AS exp
    FROM public.jobs j
    LEFT JOIN public.transactions t
      ON t.job_id = j.id
      AND t.date >= $2::date
      AND t.date <= $3::date
    WHERE j.owner_id::text = $1
      AND j.status NOT IN ('archived', 'cancelled')
    GROUP BY j.id, j.name, j.job_no
    HAVING SUM(t.amount_cents) > 0
    ORDER BY SUM(t.amount_cents) DESC
    LIMIT 3
  `, [String(ownerId), from, to]).catch(() => null);

  const activeJobs = (jobsResult?.rows || []).map(r => ({
    name:       r.name,
    job_no:     r.job_no,
    revenue:    toInt(r.rev),
    expenses:   toInt(r.exp),
    margin_pct: toInt(r.rev) > 0 ? Math.round(((toInt(r.rev) - toInt(r.exp)) / toInt(r.rev)) * 100) : null,
  }));

  const profitCents = revenueCents - totalExpenseCents;
  const marginPct   = revenueCents > 0 ? Math.round((profitCents / revenueCents) * 100) : null;

  const labourCents = Object.entries(expensesByCategory)
    .filter(([k]) => /labour|labor|wages|payroll/i.test(k))
    .reduce((s, [, v]) => s + v, 0);
  const labourPct = revenueCents > 0 ? Math.round((labourCents / revenueCents) * 100) : null;

  return {
    week_from: from, week_to: to,
    revenue_cents: revenueCents, total_expense_cents: totalExpenseCents,
    profit_cents: profitCents, margin_pct: marginPct,
    expenses_by_category: expensesByCategory,
    labour_cents: labourCents, labour_pct: labourPct,
    total_hours: totalHours, crew_count: crewCount,
    active_jobs: activeJobs,
  };
}

async function generateDigestMessage(data) {
  const client = new Anthropic();

  const topExpenses = Object.entries(data.expenses_by_category)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([cat, cents]) => `${cat}: $${(cents / 100).toFixed(0)}`).join(', ');

  const jobLines = data.active_jobs.map(j =>
    `Job ${j.job_no} (${j.name}): rev $${(j.revenue / 100).toFixed(0)}, margin ${j.margin_pct !== null ? j.margin_pct + '%' : 'n/a'}`
  ).join('; ');

  const systemPrompt = [
    'You are Chief, a plain-language CFO for contractors.',
    'Summarise this week\'s numbers in 4–6 lines. Be specific. Flag anything worth attention.',
    'Sound like a trusted advisor, not a spreadsheet.',
    'Include one "watch out" line if anything is unusual (labour over 40% of revenue, margin below 20%, unusually high spend category).',
    'WhatsApp format: use *bold* sparingly, short lines. No bullet overload.',
  ].join(' ');

  const userMsg = [
    `Week: ${data.week_from} to ${data.week_to}`,
    `Revenue: $${(data.revenue_cents / 100).toFixed(2)}`,
    `Total expenses: $${(data.total_expense_cents / 100).toFixed(2)}`,
    `Profit: $${(data.profit_cents / 100).toFixed(2)} (${data.margin_pct !== null ? data.margin_pct + '% margin' : 'margin n/a'})`,
    `Top expense categories: ${topExpenses || 'none'}`,
    `Labour cost: $${(data.labour_cents / 100).toFixed(2)}${data.labour_pct !== null ? ` (${data.labour_pct}% of revenue)` : ''}`,
    `Hours logged: ${data.total_hours}h across ${data.crew_count} crew`,
    `Active job activity: ${jobLines || 'no job-linked transactions this week'}`,
  ].join('\n');

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{ role: 'user', content: userMsg }],
    system: systemPrompt,
  });

  return response.content?.[0]?.text?.trim() || '';
}

async function runWeeklyDigest() {
  const now    = new Date();
  const week   = isoWeek(now);
  const year   = now.getUTCFullYear();
  const range  = isoWeekRange(now);

  const ownersResult = await pool.query(`
    SELECT DISTINCT owner_id, phone_digits, tz
    FROM public.chiefos_tenant_actor_profiles
    WHERE phone_digits IS NOT NULL AND phone_digits != ''
  `).catch(() => null);

  const owners = ownersResult?.rows || [];
  let processed = 0, sent = 0, errors = 0;

  for (const owner of owners) {
    const signalKey = `weekly_digest_${year}_${week}`;

    try {
      const existing = await pool.query(
        `SELECT id FROM public.insight_log WHERE owner_id = $1 AND signal_key = $2 LIMIT 1`,
        [String(owner.owner_id), signalKey]
      ).catch(() => null);

      if (existing?.rows?.length) continue;

      processed++;
      const data = await fetchWeeklyData(owner.owner_id, range);

      if (data.revenue_cents === 0 && data.total_expense_cents === 0 && data.total_hours === 0) continue;

      const message = await generateDigestMessage(data);
      if (!message) continue;

      const fullMessage = `📊 *Weekly Chief Digest — Week ${week}*\n\n${message}`;
      await sendWhatsApp(`+${owner.phone_digits}`, fullMessage);
      sent++;

      const tenantResult = await pool.query(
        `SELECT tenant_id FROM public.chiefos_tenant_actor_profiles WHERE owner_id = $1 LIMIT 1`,
        [String(owner.owner_id)]
      ).catch(() => null);
      const tenantId = tenantResult?.rows?.[0]?.tenant_id || '00000000-0000-0000-0000-000000000000';

      await pool.query(`
        INSERT INTO public.insight_log (tenant_id, owner_id, kind, signal_key, payload, message_text)
        VALUES ($1, $2, 'weekly_digest', $3, $4, $5)
        ON CONFLICT (owner_id, signal_key) DO NOTHING
      `, [tenantId, String(owner.owner_id), signalKey, JSON.stringify(data), fullMessage])
        .catch(e => console.error('[weeklyDigest] insight_log insert failed:', e?.message));

      console.log(`[weeklyDigest] sent digest to ${owner.owner_id} (week ${week})`);

    } catch (err) {
      errors++;
      console.error(`[weeklyDigest] error for owner ${owner.owner_id}:`, err?.message);
    }
  }

  return { processed, sent, errors };
}

module.exports = { runWeeklyDigest };
