'use strict';

/**
 * Agent Tool: get_cash_flow_forecast
 * Phase 3.2 — 30/60/90-day cash flow forecast
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function toInt(x) { const n = Number(x); return Number.isFinite(n) ? Math.trunc(n) : 0; }

async function estimateInflows(ownerId, horizonDays) {
  const jobsResult = await pool.query(`
    SELECT
      j.id,
      j.name,
      j.job_no,
      COALESCE(j.quoted_revenue_cents, 0)  AS quoted,
      COALESCE(SUM(CASE WHEN t.kind = 'revenue' THEN t.amount_cents ELSE 0 END), 0) AS logged
    FROM public.jobs j
    LEFT JOIN public.transactions t ON t.job_id = j.id
    WHERE j.owner_id::text = $1
      AND j.status NOT IN ('archived', 'cancelled', 'completed')
    GROUP BY j.id, j.name, j.job_no, j.quoted_revenue_cents
    HAVING COALESCE(j.quoted_revenue_cents, 0) > 0
  `, [String(ownerId)]).catch(() => null);

  const COLLECTION_PROBABILITY = 0.75;

  let projectedInflows = 0;
  const inflowBreakdown = [];

  for (const r of (jobsResult?.rows || [])) {
    const quoted = toInt(r.quoted);
    const logged = toInt(r.logged);
    const remaining = Math.max(0, quoted - logged);
    if (!remaining) continue;

    const expected = Math.round(remaining * COLLECTION_PROBABILITY * (Math.min(horizonDays, 30) / 30));
    projectedInflows += expected;
    inflowBreakdown.push({ job_no: r.job_no, job_name: r.name, remaining, expected });
  }

  const recentRevResult = await pool.query(`
    SELECT
      DATE_TRUNC('month', date) AS mo,
      SUM(amount_cents)         AS monthly_rev
    FROM public.transactions
    WHERE owner_id::text = $1
      AND kind = 'revenue'
      AND date >= NOW() - INTERVAL '3 months'
    GROUP BY mo
    ORDER BY mo DESC
  `, [String(ownerId)]).catch(() => null);

  const recentMonths = recentRevResult?.rows || [];
  const avgMonthlyRev = recentMonths.length
    ? recentMonths.reduce((s, r) => s + toInt(r.monthly_rev), 0) / recentMonths.length
    : 0;

  const nonJobInflow = projectedInflows === 0 && avgMonthlyRev > 0
    ? Math.round(avgMonthlyRev * (horizonDays / 30))
    : 0;

  projectedInflows += nonJobInflow;

  return {
    projected_inflows_cents: projectedInflows,
    inflow_breakdown:        inflowBreakdown,
    collection_probability:  COLLECTION_PROBABILITY,
    avg_monthly_revenue:     Math.round(avgMonthlyRev),
  };
}

async function estimateOutflows(ownerId, horizonDays) {
  let projectedOutflows = 0;
  const outflowBreakdown = [];

  const overheadResult = await pool.query(`
    SELECT name, amount_cents, tax_amount_cents, due_day
    FROM public.overhead_items
    WHERE owner_id::text = $1
      AND active = true
      AND item_type = 'recurring'
  `, [String(ownerId)]).catch(() => null);

  for (const item of (overheadResult?.rows || [])) {
    const total = toInt(item.amount_cents) + toInt(item.tax_amount_cents);
    const occurrences = Math.ceil(horizonDays / 30);
    const expected = total * occurrences;
    projectedOutflows += expected;
    outflowBreakdown.push({ kind: 'overhead', name: item.name, amount: total, occurrences, total: expected });
  }

  const labourResult = await pool.query(`
    SELECT
      SUM(
        EXTRACT(EPOCH FROM (COALESCE(te.clock_out, NOW()) - te.clock_in)) / 3600.0
        * COALESCE(cr.hourly_rate_cents, 0)
      ) AS weekly_labour_cost
    FROM public.time_entries_v2 te
    LEFT JOIN public.chiefos_crew_rates cr
      ON cr.owner_id::text = te.owner_id::text
      AND LOWER(cr.name) = LOWER(te.employee_name)
    WHERE te.owner_id::text = $1
      AND te.clock_in >= NOW() - INTERVAL '4 weeks'
  `, [String(ownerId)]).catch(() => null);

  const weeklyLabourCents = toInt(labourResult?.rows?.[0]?.weekly_labour_cost) / 4;
  const labourEstimate = Math.round(weeklyLabourCents * (horizonDays / 7));
  if (labourEstimate > 0) {
    projectedOutflows += labourEstimate;
    outflowBreakdown.push({ kind: 'labour', name: 'Crew wages (estimated)', amount: weeklyLabourCents, occurrences: Math.ceil(horizonDays / 7), total: labourEstimate });
  }

  const materialsResult = await pool.query(`
    SELECT AVG(monthly_total) AS avg_monthly
    FROM (
      SELECT DATE_TRUNC('month', date) AS mo, SUM(amount_cents) AS monthly_total
      FROM public.transactions
      WHERE owner_id::text = $1
        AND kind = 'expense'
        AND category NOT ILIKE '%labour%'
        AND category NOT ILIKE '%labor%'
        AND date >= NOW() - INTERVAL '3 months'
      GROUP BY mo
    ) sub
  `, [String(ownerId)]).catch(() => null);

  const avgMonthlyMaterials = toInt(materialsResult?.rows?.[0]?.avg_monthly);
  const materialsEstimate = Math.round(avgMonthlyMaterials * (horizonDays / 30));
  if (materialsEstimate > 0) {
    projectedOutflows += materialsEstimate;
    outflowBreakdown.push({ kind: 'materials', name: 'Materials/expenses (estimated)', amount: avgMonthlyMaterials, occurrences: 1, total: materialsEstimate });
  }

  return { projected_outflows_cents: projectedOutflows, outflow_breakdown: outflowBreakdown };
}

async function getCashFlowForecast({ ownerId, horizonDays, currentBalanceCents }) {
  if (!ownerId) return { error: 'owner_id is required' };

  const horizon = Math.min(Math.max(Number(horizonDays) || 30, 7), 90);

  const [inflows, outflows] = await Promise.all([
    estimateInflows(ownerId, horizon),
    estimateOutflows(ownerId, horizon),
  ]);

  const balance    = currentBalanceCents != null ? toInt(currentBalanceCents) : null;
  const netFlow    = inflows.projected_inflows_cents - outflows.projected_outflows_cents;
  const netPosition = balance !== null ? balance + netFlow : null;

  const overdueResult = await pool.query(`
    SELECT COUNT(*) AS cnt, SUM(amount_cents) AS total
    FROM public.transactions
    WHERE owner_id::text = $1
      AND kind = 'revenue'
      AND date <= NOW() - INTERVAL '30 days'
      AND COALESCE(payment_status, 'pending') = 'pending'
  `, [String(ownerId)]).catch(() => null);

  const overdueCount = toInt(overdueResult?.rows?.[0]?.cnt);
  const overdueTotal = toInt(overdueResult?.rows?.[0]?.total);

  return {
    horizon_days:                horizon,
    current_balance_cents:       balance,
    projected_inflows_cents:     inflows.projected_inflows_cents,
    projected_outflows_cents:    outflows.projected_outflows_cents,
    net_flow_cents:              netFlow,
    net_position_cents:          netPosition,
    inflow_details:              inflows,
    outflow_details:             outflows,
    overdue_receivables_count:   overdueCount,
    overdue_receivables_cents:   overdueTotal,
    note: balance === null
      ? 'No current bank balance provided — net position not computed. Ask for current balance to complete forecast.'
      : null,
  };
}

const cashFlowForecastTool = {
  type: 'function',
  function: {
    name: 'get_cash_flow_forecast',
    description: [
      'Forecast cash inflows and outflows for the next 30, 60, or 90 days.',
      'Returns projected inflows from active jobs, outflows from overhead + labour, and net position.',
      'Use for questions like "what is my cash outlook?", "will I run short next month?", "how much cash coming in this quarter?"',
    ].join(' '),
    parameters: {
      type: 'object',
      required: ['owner_id'],
      properties: {
        owner_id:              { type: 'string' },
        horizon_days:          { type: 'integer', description: '30, 60, or 90 (default 30)' },
        current_balance_cents: { type: 'integer', description: 'Current bank balance in cents — user must provide for net position' },
      },
    },
  },
  __handler: async (args) => {
    try {
      return await getCashFlowForecast({
        ownerId:              String(args.owner_id || '').trim(),
        horizonDays:          args.horizon_days,
        currentBalanceCents:  args.current_balance_cents != null ? Number(args.current_balance_cents) : null,
      });
    } catch (err) {
      return { error: `get_cash_flow_forecast failed: ${err?.message}` };
    }
  },
};

module.exports = { cashFlowForecastTool, getCashFlowForecast };
