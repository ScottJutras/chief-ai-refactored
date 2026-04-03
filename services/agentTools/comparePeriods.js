'use strict';

/**
 * Agent Tool: compare_periods
 * Phase 2.3 — Compare two date ranges for a given metric.
 *
 * Q: "How does this month compare to last month?"
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function toInt(x) { const n = Number(x); return Number.isFinite(n) ? Math.trunc(n) : 0; }

async function fetchPeriodMetrics(ownerId, dateFrom, dateTo) {
  const owner = String(ownerId);

  const revResult = await pool.query(`
    SELECT SUM(amount_cents) AS total
    FROM public.transactions
    WHERE owner_id::text = $1
      AND kind = 'revenue'
      AND date >= $2::date
      AND date <= $3::date
  `, [owner, dateFrom, dateTo]).catch(() => null);

  const expResult = await pool.query(`
    SELECT SUM(amount_cents) AS total
    FROM public.transactions
    WHERE owner_id::text = $1
      AND kind = 'expense'
      AND date >= $2::date
      AND date <= $3::date
  `, [owner, dateFrom, dateTo]).catch(() => null);

  const hoursResult = await pool.query(`
    SELECT SUM(
      EXTRACT(EPOCH FROM (COALESCE(clock_out, NOW()) - clock_in)) / 3600.0
    ) AS total
    FROM public.time_entries_v2
    WHERE owner_id::text = $1
      AND clock_in >= $2::timestamptz
      AND clock_in <= ($3::date + interval '1 day')::timestamptz
  `, [owner, `${dateFrom}T00:00:00Z`, dateTo]).catch(() => null);

  const revenue  = toInt(revResult?.rows?.[0]?.total);
  const expenses = toInt(expResult?.rows?.[0]?.total);
  const profit   = revenue - expenses;
  const margin   = revenue > 0 ? Math.round((profit / revenue) * 100) : null;
  const hours    = Math.round((Number(hoursResult?.rows?.[0]?.total) || 0) * 10) / 10;

  return { revenue, expenses, profit, margin, hours };
}

async function comparePeriods({ ownerId, period1From, period1To, period2From, period2To }) {
  if (!ownerId || !period1From || !period1To || !period2From || !period2To) {
    return { error: 'Required: owner_id, period1_from, period1_to, period2_from, period2_to' };
  }

  const [p1, p2] = await Promise.all([
    fetchPeriodMetrics(ownerId, period1From, period1To),
    fetchPeriodMetrics(ownerId, period2From, period2To),
  ]);

  function pctChange(a, b) {
    if (!b || b === 0) return null;
    return Math.round(((a - b) / Math.abs(b)) * 100);
  }

  return {
    period1: { from: period1From, to: period1To, ...p1 },
    period2: { from: period2From, to: period2To, ...p2 },
    changes: {
      revenue_change_pct:  pctChange(p1.revenue, p2.revenue),
      expenses_change_pct: pctChange(p1.expenses, p2.expenses),
      profit_change_pct:   pctChange(p1.profit, p2.profit),
      margin_change_pts:   p1.margin !== null && p2.margin !== null ? p1.margin - p2.margin : null,
      hours_change_pct:    pctChange(p1.hours, p2.hours),
    },
  };
}

const comparePeriodsTool = {
  type: 'function',
  function: {
    name: 'compare_periods',
    description: [
      'Compare two date ranges on key financial metrics: revenue, expenses, profit, margin, hours.',
      'Use for questions like "how does this month compare to last month?",',
      '"is Q2 better than Q1?", "did revenue improve vs last week?"',
    ].join(' '),
    parameters: {
      type: 'object',
      required: ['owner_id', 'period1_from', 'period1_to', 'period2_from', 'period2_to'],
      properties: {
        owner_id:     { type: 'string' },
        period1_from: { type: 'string', description: 'ISO date — the "current" or primary period start' },
        period1_to:   { type: 'string', description: 'ISO date — primary period end' },
        period2_from: { type: 'string', description: 'ISO date — the comparison (prior) period start' },
        period2_to:   { type: 'string', description: 'ISO date — comparison period end' },
        metric:       { type: 'string', description: 'Optional focus metric (revenue|expenses|margin|hours)' },
      },
    },
  },
  __handler: async (args) => {
    try {
      return await comparePeriods({
        ownerId:      String(args.owner_id || '').trim(),
        period1From:  String(args.period1_from || '').trim(),
        period1To:    String(args.period1_to   || '').trim(),
        period2From:  String(args.period2_from || '').trim(),
        period2To:    String(args.period2_to   || '').trim(),
      });
    } catch (err) {
      return { error: `compare_periods failed: ${err?.message}` };
    }
  },
};

module.exports = { comparePeriodsTool, comparePeriods };
