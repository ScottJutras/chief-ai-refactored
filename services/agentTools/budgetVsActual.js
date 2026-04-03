'use strict';

/**
 * Agent Tool: get_budget_vs_actual
 * Phase 2.5 — Budget vs. Actual tracking
 *
 * Compares quote_line_items (budgeted) against transactions (actuals) per job.
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function toInt(x) { const n = Number(x); return Number.isFinite(n) ? Math.trunc(n) : 0; }

async function getBudgetVsActual({ ownerId, jobId, jobNo }) {
  if (!ownerId) return { error: 'owner_id is required' };

  let resolvedJobId = jobId || null;
  let jobName       = null;
  let jobNumber     = null;

  if (!resolvedJobId && jobNo) {
    const r = await pool.query(
      `SELECT id, name, job_no FROM public.jobs WHERE owner_id::text = $1 AND job_no = $2 LIMIT 1`,
      [String(ownerId), Number(jobNo)]
    ).catch(() => null);
    if (r?.rows?.[0]) {
      resolvedJobId = String(r.rows[0].id);
      jobName       = r.rows[0].name;
      jobNumber     = r.rows[0].job_no;
    }
  } else if (resolvedJobId) {
    const r = await pool.query(
      `SELECT name, job_no FROM public.jobs WHERE owner_id::text = $1 AND id = $2 LIMIT 1`,
      [String(ownerId), resolvedJobId]
    ).catch(() => null);
    if (r?.rows?.[0]) {
      jobName   = r.rows[0].name;
      jobNumber = r.rows[0].job_no;
    }
  }

  if (!resolvedJobId) return { error: 'Job not found. Provide job_id or job_no.' };

  const budgetResult = await pool.query(`
    SELECT
      category,
      SUM(COALESCE(qty, 1) * COALESCE(unit_price_cents, 0)) AS budgeted_cents
    FROM public.quote_line_items
    WHERE job_id = $1
    GROUP BY category
  `, [resolvedJobId]).catch(() => null);

  const budgetByCategory = {};
  for (const r of (budgetResult?.rows || [])) {
    budgetByCategory[r.category || 'Uncategorised'] = toInt(r.budgeted_cents);
  }

  const actualResult = await pool.query(`
    SELECT
      COALESCE(category, 'Uncategorised') AS category,
      SUM(amount_cents) AS actual_cents
    FROM public.transactions
    WHERE job_id = $1
      AND kind = 'expense'
    GROUP BY category
  `, [resolvedJobId]).catch(() => null);

  const actualByCategory = {};
  for (const r of (actualResult?.rows || [])) {
    actualByCategory[r.category] = toInt(r.actual_cents);
  }

  const allCategories = new Set([
    ...Object.keys(budgetByCategory),
    ...Object.keys(actualByCategory),
  ]);

  const lines = [];
  let totalBudget = 0;
  let totalActual = 0;

  for (const cat of allCategories) {
    const budgeted = budgetByCategory[cat] || 0;
    const actual   = actualByCategory[cat] || 0;
    const variance = actual - budgeted;
    totalBudget   += budgeted;
    totalActual   += actual;

    lines.push({
      category:       cat,
      budgeted_cents: budgeted,
      actual_cents:   actual,
      variance_cents: variance,
      pct_used:       budgeted > 0 ? Math.round((actual / budgeted) * 100) : null,
      status:         budgeted === 0 ? 'unbudgeted'
                    : variance > 0   ? 'over'
                    : variance < 0   ? 'under'
                    : 'on_budget',
    });
  }

  lines.sort((a, b) => b.variance_cents - a.variance_cents);

  const totalVariance = totalActual - totalBudget;

  return {
    job_id:   resolvedJobId,
    job_no:   jobNumber,
    job_name: jobName,
    total_budgeted_cents: totalBudget,
    total_actual_cents:   totalActual,
    total_variance_cents: totalVariance,
    overall_status:       totalBudget === 0 ? 'no_budget' : totalVariance > 0 ? 'over' : 'under',
    categories: lines,
    has_quote_data: totalBudget > 0,
  };
}

const budgetVsActualTool = {
  type: 'function',
  function: {
    name: 'get_budget_vs_actual',
    description: [
      'Compare a job\'s quoted budget (from quote line items) against actual expenses from transactions.',
      'Returns variance by category. Use for "am I over budget?", "how does spend compare to quote?",',
      '"what categories are over budget on Job X?"',
    ].join(' '),
    parameters: {
      type: 'object',
      required: ['owner_id'],
      properties: {
        owner_id: { type: 'string' },
        job_id:   { type: 'string', description: 'Job UUID' },
        job_no:   { type: 'integer', description: 'Job number' },
      },
    },
  },
  __handler: async (args) => {
    try {
      return await getBudgetVsActual({
        ownerId: String(args.owner_id || '').trim(),
        jobId:   args.job_id ? String(args.job_id).trim() : null,
        jobNo:   args.job_no ? Number(args.job_no)        : null,
      });
    } catch (err) {
      return { error: `get_budget_vs_actual failed: ${err?.message}` };
    }
  },
};

module.exports = { budgetVsActualTool, getBudgetVsActual };
