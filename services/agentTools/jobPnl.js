'use strict';

/**
 * Agent Tool: get_job_pnl
 * Returns a full profit & loss breakdown for a specific job:
 *   revenue, expenses by category, labour cost (hours × crew rate), and margin %.
 *
 * This is the highest-leverage Phase 1 tool — makes "is Job X profitable?" answerable.
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function toInt(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function fmtDollars(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Core P&L query for a single job.
 * Returns structured data; the agent synthesises the narrative.
 */
async function computeJobPnl({ ownerId, jobId, jobNo, dateFrom, dateTo }) {
  const params = [];
  let p = 1;

  // ── 1. Resolve job_id if caller passed job_no ──────────────────────────
  let resolvedJobId = jobId || null;
  let jobName = null;
  let jobNumber = null;
  let jobStatus = null;

  if (!resolvedJobId && jobNo) {
    const jobRow = await pool.query(
      `SELECT id, name, job_no, status FROM public.jobs
       WHERE owner_id::text = $1 AND job_no = $2
       LIMIT 1`,
      [String(ownerId), Number(jobNo)]
    ).catch(() => null);
    if (jobRow?.rows?.[0]) {
      resolvedJobId = String(jobRow.rows[0].id);
      jobName = jobRow.rows[0].name;
      jobNumber = jobRow.rows[0].job_no;
      jobStatus = jobRow.rows[0].status;
    }
  } else if (resolvedJobId) {
    const jobRow = await pool.query(
      `SELECT name, job_no, status FROM public.jobs
       WHERE owner_id::text = $1 AND id = $2
       LIMIT 1`,
      [String(ownerId), resolvedJobId]
    ).catch(() => null);
    if (jobRow?.rows?.[0]) {
      jobName = jobRow.rows[0].name;
      jobNumber = jobRow.rows[0].job_no;
      jobStatus = jobRow.rows[0].status;
    }
  }

  if (!resolvedJobId) {
    return { error: 'Job not found. Provide job_id (UUID) or job_no (integer).' };
  }

  // ── 2. Revenue & expenses from transactions ────────────────────────────
  const txWhere = [`t.owner_id::text = $${p++}`, `t.job_id::text = $${p++}`];
  params.push(String(ownerId), String(resolvedJobId));

  if (dateFrom) { txWhere.push(`t.date >= $${p++}::date`); params.push(dateFrom); }
  if (dateTo)   { txWhere.push(`t.date <= $${p++}::date`); params.push(dateTo); }

  const txResult = await pool.query(`
    SELECT
      t.kind,
      t.category,
      SUM(t.amount_cents) AS total_cents,
      COUNT(*)            AS tx_count
    FROM public.transactions t
    WHERE ${txWhere.join(' AND ')}
    GROUP BY t.kind, t.category
    ORDER BY t.kind, total_cents DESC
  `, params).catch(() => null);

  let revenueCents = 0;
  let expensesByCategory = {};
  let totalExpenseCents = 0;

  for (const row of (txResult?.rows || [])) {
    const cents = toInt(row.total_cents);
    if (row.kind === 'revenue') {
      revenueCents += cents;
    } else if (row.kind === 'expense') {
      const cat = row.category || 'Uncategorised';
      expensesByCategory[cat] = (expensesByCategory[cat] || 0) + cents;
      totalExpenseCents += cents;
    }
  }

  // ── 3. Labour cost from time_entries_v2 × crew_rates ──────────────────
  const labourParams = [String(ownerId), String(resolvedJobId)];
  let labourP = 3;
  const labourDateFilters = [];
  if (dateFrom) { labourDateFilters.push(`te.clock_in >= $${labourP++}::timestamptz`); labourParams.push(`${dateFrom}T00:00:00Z`); }
  if (dateTo)   { labourDateFilters.push(`te.clock_in <= $${labourP++}::timestamptz`); labourParams.push(`${dateTo}T23:59:59Z`); }

  const labourResult = await pool.query(`
    SELECT
      te.employee_name,
      SUM(
        EXTRACT(EPOCH FROM (COALESCE(te.clock_out, NOW()) - te.clock_in)) / 3600.0
      ) AS total_hours,
      COALESCE(cr.hourly_rate_cents, 0) AS rate_cents
    FROM public.time_entries_v2 te
    LEFT JOIN public.chiefos_crew_rates cr
      ON cr.owner_id = te.owner_id::text
      AND LOWER(cr.employee_name) = LOWER(te.employee_name)
    WHERE te.owner_id::text = $1
      AND te.job_id::text = $2
      ${labourDateFilters.length ? 'AND ' + labourDateFilters.join(' AND ') : ''}
    GROUP BY te.employee_name, cr.hourly_rate_cents
  `, labourParams).catch(() => null);

  let labourCents = 0;
  let labourByEmployee = [];

  for (const row of (labourResult?.rows || [])) {
    const hours = Number(row.total_hours) || 0;
    const rate  = toInt(row.rate_cents);
    const cost  = Math.round(hours * rate);
    labourCents += cost;
    labourByEmployee.push({
      name:       row.employee_name || 'Unknown',
      hours:      Math.round(hours * 10) / 10,
      rate_cents: rate,
      cost_cents: cost,
    });
  }

  // If labour transactions also exist (subcontractors logged as expenses),
  // don't double-count — only add time-entry labour if there's no 'Labour' expense category.
  const hasLabourExpense = !!expensesByCategory['Labour'] || !!expensesByCategory['labor'];
  if (labourCents > 0 && !hasLabourExpense) {
    expensesByCategory['Labour (time entries)'] = labourCents;
    totalExpenseCents += labourCents;
  }

  // ── 4. Phase breakdown if job_phases exist ────────────────────────────
  const phaseResult = await pool.query(`
    SELECT jp.id, jp.name, jp.status,
           COUNT(t.id) AS tx_count,
           SUM(CASE WHEN t.kind='revenue' THEN t.amount_cents ELSE 0 END) AS phase_rev,
           SUM(CASE WHEN t.kind='expense' THEN t.amount_cents ELSE 0 END) AS phase_exp
    FROM public.job_phases jp
    LEFT JOIN public.transactions t ON t.phase_id = jp.id
    WHERE jp.job_id = $1
    GROUP BY jp.id, jp.name, jp.status
    ORDER BY jp.id
  `, [resolvedJobId]).catch(() => null);

  const phaseBreakdown = (phaseResult?.rows || []).map(r => ({
    phase:    r.name,
    status:   r.status,
    revenue:  toInt(r.phase_rev),
    expenses: toInt(r.phase_exp),
    margin:   toInt(r.phase_rev) > 0
      ? Math.round(((toInt(r.phase_rev) - toInt(r.phase_exp)) / toInt(r.phase_rev)) * 100)
      : null,
  }));

  // ── 5. Derived metrics ─────────────────────────────────────────────────
  const profitCents  = revenueCents - totalExpenseCents;
  const marginPct    = revenueCents > 0
    ? Math.round((profitCents / revenueCents) * 100)
    : null;

  return {
    job_id:     resolvedJobId,
    job_no:     jobNumber,
    job_name:   jobName,
    job_status: jobStatus,
    date_from:  dateFrom || null,
    date_to:    dateTo   || null,

    revenue_cents:  revenueCents,
    expense_cents:  totalExpenseCents,
    labour_cents:   labourCents,
    profit_cents:   profitCents,
    margin_pct:     marginPct,

    revenue_fmt:  fmtDollars(revenueCents),
    profit_fmt:   fmtDollars(Math.abs(profitCents)),
    profit_sign:  profitCents >= 0 ? '+' : '-',

    expenses_by_category: expensesByCategory,
    labour_by_employee:   labourByEmployee,
    phase_breakdown:      phaseBreakdown,
  };
}

// ── Tool spec for the agent ──────────────────────────────────────────────
const jobPnlTool = {
  type: 'function',
  function: {
    name: 'get_job_pnl',
    description: [
      'Get profit and loss for a specific job.',
      'Returns revenue, expenses by category, labour cost from time entries, margin %, and phase breakdown.',
      'Use when the user asks "is Job X profitable?", "how is job X doing?", "what is my margin on Job X?", etc.',
    ].join(' '),
    parameters: {
      type: 'object',
      required: ['owner_id'],
      properties: {
        owner_id: { type: 'string', description: 'Owner ID (digits string)' },
        job_id:   { type: 'string', description: 'Job UUID — use if you have it' },
        job_no:   { type: 'integer', description: 'Job number (e.g. 7) — use if no UUID' },
        date_from: { type: 'string', description: 'ISO date YYYY-MM-DD, optional — filter transactions to a range' },
        date_to:   { type: 'string', description: 'ISO date YYYY-MM-DD, optional' },
      },
    },
  },
  __handler: async (args) => {
    try {
      const result = await computeJobPnl({
        ownerId:  String(args.owner_id || '').trim(),
        jobId:    args.job_id    ? String(args.job_id).trim()    : null,
        jobNo:    args.job_no    ? Number(args.job_no)           : null,
        dateFrom: args.date_from ? String(args.date_from).trim() : null,
        dateTo:   args.date_to   ? String(args.date_to).trim()   : null,
      });
      return result;
    } catch (err) {
      return { error: `get_job_pnl failed: ${err?.message}` };
    }
  },
};

module.exports = { jobPnlTool, computeJobPnl };
