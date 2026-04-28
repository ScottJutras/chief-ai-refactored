'use strict';

/**
 * workers/weeklyDigest.js
 * Phase 1.1 — Weekly Financial Digest
 * Phase 2.6 — Configurable day/time per owner
 *
 * Cron now runs every hour. Each owner's preferred send day and hour
 * are read from public.settings (keys: digest.send_day, digest.send_hour).
 * Defaults: Friday at 16:00 UTC.
 *
 * The weekly dedup signal_key (weekly_digest_YYYY_WW) ensures each owner
 * receives at most one digest per ISO week regardless of retries.
 */

const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const { sendWhatsApp } = require('../services/twilio');
const { getDigestConfig } = require('../handlers/commands/digestSettings');

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

function quarterRange(year, q) {
  // q is 1-4
  const startMonth = (q - 1) * 3; // 0,3,6,9
  const endMonth   = startMonth + 2;
  const endDay     = new Date(year, endMonth + 1, 0).getDate(); // last day of end month
  const from = `${year}-${String(startMonth + 1).padStart(2, '0')}-01`;
  const to   = `${year}-${String(endMonth + 1).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;
  return { from, to };
}

function currentQuarter(d) {
  return Math.floor(d.getUTCMonth() / 3) + 1; // 1-4
}

// Is this the first ISO week of a new quarter?
// Returns { isFirstWeekOfQuarter, prevQuarter, prevYear } or null
function detectQuarterStart(now) {
  const q   = currentQuarter(now);
  const yr  = now.getUTCFullYear();

  // First week of a quarter means we're in month (q-1)*3 and within the first 7 days
  const qStartMonth = (q - 1) * 3; // 0,3,6,9
  if (now.getUTCMonth() !== qStartMonth) return null;
  if (now.getUTCDate() > 7) return null;

  const prevQ    = q === 1 ? 4 : q - 1;
  const prevYear = q === 1 ? yr - 1 : yr;
  return { isFirstWeekOfQuarter: true, prevQuarter: prevQ, prevYear };
}

async function fetchQuarterData(ownerId, { from, to }) {
  const txResult = await pool.query(`
    SELECT kind, SUM(amount_cents) AS total
    FROM public.transactions
    WHERE owner_id::text = $1 AND date >= $2::date AND date <= $3::date
    GROUP BY kind
  `, [String(ownerId), from, to]).catch(() => null);

  let revenueCents = 0;
  let expenseCents = 0;
  for (const row of (txResult?.rows || [])) {
    const cents = toInt(row.total);
    if (row.kind === 'revenue') revenueCents += cents;
    else if (row.kind === 'expense') expenseCents += cents;
  }

  const labourResult = await pool.query(`
    SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(te.clock_out, NOW()) - te.clock_in)) / 3600.0 * COALESCE(cr.hourly_rate_cents, 0)) AS labour_cost
    FROM public.time_entries_v2 te
    LEFT JOIN public.chiefos_crew_rates cr
      ON cr.owner_id = te.owner_id::text AND LOWER(cr.employee_name) = LOWER(te.employee_name)
    WHERE te.owner_id::text = $1
      AND te.clock_in >= $2::timestamptz
      AND te.clock_in <= ($3::date + interval '1 day')::timestamptz
  `, [String(ownerId), `${from}T00:00:00Z`, to]).catch(() => null);

  const labourCents  = toInt(labourResult?.rows?.[0]?.labour_cost);
  const totalCost    = expenseCents + labourCents;
  const profit       = revenueCents - totalCost;
  const marginPct    = revenueCents > 0 ? Math.round((profit / revenueCents) * 100) : null;

  const jobsResult = await pool.query(`
    SELECT COUNT(DISTINCT t.job_id) AS job_count
    FROM public.transactions t
    WHERE t.owner_id::text = $1 AND t.date >= $2::date AND t.date <= $3::date AND t.job_id IS NOT NULL
  `, [String(ownerId), from, to]).catch(() => null);

  return {
    revenue_cents: revenueCents,
    profit_cents:  profit,
    margin_pct:    marginPct,
    job_count:     toInt(jobsResult?.rows?.[0]?.job_count),
  };
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
      te.employee_name,
      SUM(EXTRACT(EPOCH FROM (COALESCE(te.clock_out, NOW()) - te.clock_in)) / 3600.0) AS hours,
      COALESCE(cr.hourly_rate_cents, 0) AS rate_cents
    FROM public.time_entries_v2 te
    LEFT JOIN public.chiefos_crew_rates cr
      ON cr.owner_id = te.owner_id::text
      AND LOWER(cr.employee_name) = LOWER(te.employee_name)
    WHERE te.owner_id::text = $1
      AND te.clock_in >= $2::timestamptz
      AND te.clock_in <= ($3::date + interval '1 day')::timestamptz
    GROUP BY te.employee_name, cr.hourly_rate_cents
  `, [String(ownerId), `${from}T00:00:00Z`, to]).catch(() => null);

  let totalHours = 0;
  let labourCostCents = 0;
  const crewNames = new Set();
  for (const row of (labourResult?.rows || [])) {
    const hrs = Number(row.hours) || 0;
    totalHours += hrs;
    labourCostCents += Math.round(hrs * toInt(row.rate_cents));
    if (row.employee_name) crewNames.add(row.employee_name);
  }
  totalHours = Math.round(totalHours * 10) / 10;
  const crewCount = crewNames.size;

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

  const profitCents = revenueCents - totalExpenseCents - labourCostCents;
  const totalCostCents = totalExpenseCents + labourCostCents;
  const marginPct = revenueCents > 0
    ? Math.round((profitCents / revenueCents) * 100)
    : null;
  const labourPct = revenueCents > 0
    ? Math.round((labourCostCents / revenueCents) * 100)
    : null;

  return {
    week_from: from, week_to: to,
    revenue_cents: revenueCents,
    total_expense_cents: totalCostCents,
    material_expense_cents: totalExpenseCents,
    profit_cents: profitCents,
    margin_pct: marginPct,
    expenses_by_category: expensesByCategory,
    labour_cents: labourCostCents,
    labour_pct: labourPct,
    total_hours: totalHours,
    crew_count: crewCount,
    active_jobs: activeJobs,
  };
}

async function generateDigestMessage(data, quarterComparison = null) {
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

  const labourLine = data.labour_cents > 0
    ? `Labour cost (from time entries × rates): $${(data.labour_cents / 100).toFixed(2)}${data.labour_pct !== null ? ` (${data.labour_pct}% of revenue)` : ''}`
    : data.total_hours > 0
      ? `Hours logged: ${data.total_hours}h (no rates set — labour cost not calculated)`
      : `Hours logged: ${data.total_hours}h`;

  const qcLines = [];
  if (quarterComparison) {
    const { prevQuarter, prevYear, current, prior } = quarterComparison;
    const revDiff = current.revenue_cents - prior.revenue_cents;
    const revChg  = prior.revenue_cents > 0 ? Math.round((revDiff / prior.revenue_cents) * 100) : null;
    qcLines.push(
      `QUARTERLY CONTEXT (Q${prevQuarter + 1} vs Q${prevQuarter} ${prevYear}):`,
      `Previous Q${prevQuarter} revenue: $${(prior.revenue_cents / 100).toFixed(0)}, margin: ${prior.margin_pct !== null ? prior.margin_pct + '%' : 'n/a'}, jobs: ${prior.job_count}`,
      `Current quarter so far: revenue $${(current.revenue_cents / 100).toFixed(0)}, margin: ${current.margin_pct !== null ? current.margin_pct + '%' : 'n/a'}, jobs: ${current.job_count}`,
      revChg !== null ? `Revenue trend: ${revChg >= 0 ? '+' : ''}${revChg}% vs prior quarter` : '',
      `(NOTE: Include a brief quarter-over-quarter insight in your message — 1 sentence only)`,
    );
  }

  const userMsg = [
    `Week: ${data.week_from} to ${data.week_to}`,
    `Revenue: $${(data.revenue_cents / 100).toFixed(2)}`,
    `Materials/expenses: $${(data.material_expense_cents / 100).toFixed(2)}`,
    labourLine,
    `Total cost: $${(data.total_expense_cents / 100).toFixed(2)}`,
    `Profit: $${(data.profit_cents / 100).toFixed(2)} (${data.margin_pct !== null ? data.margin_pct + '% margin' : 'margin n/a'})`,
    `Top expense categories: ${topExpenses || 'none'}`,
    `Crew: ${data.crew_count} people, ${data.total_hours}h total`,
    `Active job activity: ${jobLines || 'no job-linked transactions this week'}`,
    ...(qcLines.length ? ['', ...qcLines] : []),
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
  const now     = new Date();
  const nowDay  = now.getUTCDay();   // 0=Sun, 1=Mon, … 6=Sat
  const nowHour = now.getUTCHours(); // 0–23
  const week    = isoWeek(now);
  const year    = now.getUTCFullYear();
  const range   = isoWeekRange(now);
  const qStart  = detectQuarterStart(now);

  // Post-rebuild canonical owner registry: public.users + chiefos_tenants
  // (chiefos_tenant_actor_profiles DISCARDed per Decision 12). user_id is the
  // digits PK = phone_digits; tz lives on chiefos_tenants.
  const ownersResult = await pool.query(`
    SELECT u.owner_id, u.user_id AS phone_digits, t.tz
      FROM public.users u
      JOIN public.chiefos_tenants t ON t.id = u.tenant_id
     WHERE u.role = 'owner'
  `).catch(() => null);

  const owners = ownersResult?.rows || [];
  let processed = 0, sent = 0, skipped = 0, errors = 0;

  for (const owner of owners) {
    const signalKey = `weekly_digest_${year}_${week}`;

    try {
      // ── Per-owner schedule gate ──────────────────────────────────────────
      const cfg = await getDigestConfig(String(owner.owner_id)).catch(() => null);
      if (cfg) {
        if (!cfg.enabled) { skipped++; continue; }
        if (cfg.sendDay  !== nowDay)  { skipped++; continue; }
        if (cfg.sendHour !== nowHour) { skipped++; continue; }
      }

      const existing = await pool.query(
        `SELECT id FROM public.insight_log WHERE owner_id = $1 AND signal_key = $2 LIMIT 1`,
        [String(owner.owner_id), signalKey]
      ).catch(() => null);

      if (existing?.rows?.length) continue;

      processed++;
      const data = await fetchWeeklyData(owner.owner_id, range);

      if (data.revenue_cents === 0 && data.total_expense_cents === 0 && data.total_hours === 0) continue;

      // Quarter-over-quarter comparison when entering a new quarter
      let quarterComparison = null;
      if (qStart) {
        try {
          const { prevQuarter, prevYear } = qStart;
          const curQ    = currentQuarter(now);
          const curRange = quarterRange(year, curQ);
          const priRange = quarterRange(prevYear, prevQuarter);
          const [currentQData, priorQData] = await Promise.all([
            fetchQuarterData(owner.owner_id, curRange),
            fetchQuarterData(owner.owner_id, priRange),
          ]);
          if (priorQData.revenue_cents > 0) {
            quarterComparison = { prevQuarter, prevYear, current: currentQData, prior: priorQData };
          }
        } catch {}
      }

      const message = await generateDigestMessage(data, quarterComparison);
      if (!message) continue;

      const fullMessage = `📊 *Weekly Chief Digest — Week ${week}*\n\n${message}`;
      await sendWhatsApp(`+${owner.phone_digits}`, fullMessage);
      sent++;

      const tenantResult = await pool.query(
        `SELECT id AS tenant_id FROM public.chiefos_tenants WHERE owner_id = $1 LIMIT 1`,
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

  return { processed, sent, skipped, errors };
}

module.exports = { runWeeklyDigest };
