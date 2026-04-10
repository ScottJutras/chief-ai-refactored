'use strict';

/**
 * Agent Tool: get_owner_benchmarks
 *
 * Computes the owner's own historical averages across all jobs (or keyword-filtered jobs):
 *   - Average margin %
 *   - Average labor as % of revenue
 *   - Average job size (revenue)
 *   - Total jobs and total revenue analyzed
 *
 * Powers answers like:
 *   "That's below your average of 34% across similar jobs"
 *   "Your typical bathroom reno comes in at 28% margin — this one is above average"
 *   "Your labor usually runs about 40% of revenue; this job is at 55%"
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
  return `$${(Math.abs(cents) / 100).toFixed(2)}`;
}

async function getOwnerBenchmarks({ ownerId, keyword, status, dateFrom, dateTo }) {
  if (!ownerId) return { error: 'owner_id is required' };

  // ── 1. Get matching jobs ───────────────────────────────────────────────
  const jobParams = [String(ownerId)];
  let jobWhereExtra = '';

  if (keyword && String(keyword).trim()) {
    jobParams.push(`%${String(keyword).trim()}%`);
    jobWhereExtra += ` AND j.name ILIKE $${jobParams.length}`;
  }
  if (status && String(status).trim()) {
    jobParams.push(String(status).trim());
    jobWhereExtra += ` AND j.status = $${jobParams.length}`;
  }
  if (dateFrom) {
    jobParams.push(String(dateFrom));
    jobWhereExtra += ` AND j.created_at >= $${jobParams.length}::date`;
  }
  if (dateTo) {
    jobParams.push(String(dateTo));
    jobWhereExtra += ` AND j.created_at <= $${jobParams.length}::date`;
  }

  const jobResult = await pool.query(`
    SELECT j.id, j.name, j.job_no, j.status
    FROM public.jobs j
    WHERE j.owner_id::text = $1
    ${jobWhereExtra}
    ORDER BY j.created_at DESC
  `, jobParams).catch(() => null);

  const jobs = jobResult?.rows || [];
  if (!jobs.length) {
    return {
      job_count: 0,
      keyword: keyword || null,
      message: keyword
        ? `No jobs found matching "${keyword}".`
        : 'No jobs found for this owner.',
    };
  }

  const jobIds = jobs.map(j => String(j.id));

  // ── 2. Batch: transactions for all jobs ───────────────────────────────
  const txResult = await pool.query(`
    SELECT
      t.job_id::text AS job_id,
      SUM(CASE WHEN t.kind = 'revenue' THEN t.amount_cents ELSE 0 END) AS revenue_cents,
      SUM(CASE WHEN t.kind = 'expense' THEN t.amount_cents ELSE 0 END) AS expense_cents
    FROM public.transactions t
    WHERE t.owner_id::text = $1
      AND t.job_id::text = ANY($2::text[])
    GROUP BY t.job_id
  `, [String(ownerId), jobIds]).catch(() => null);

  const txByJob = {};
  for (const row of (txResult?.rows || [])) {
    txByJob[row.job_id] = {
      revenue_cents: toInt(row.revenue_cents),
      expense_cents: toInt(row.expense_cents),
    };
  }

  // ── 3. Batch: actual labour ────────────────────────────────────────────
  const labourResult = await pool.query(`
    SELECT
      te.job_id::text AS job_id,
      SUM(
        EXTRACT(EPOCH FROM (COALESCE(te.clock_out, NOW()) - te.clock_in)) / 3600.0
        * COALESCE(cr.hourly_rate_cents, 0)
      ) AS labour_cost_cents
    FROM public.time_entries_v2 te
    LEFT JOIN public.chiefos_crew_rates cr
      ON cr.owner_id = te.owner_id::text
      AND LOWER(cr.employee_name) = LOWER(te.employee_name)
    WHERE te.owner_id::text = $1
      AND te.job_id::text = ANY($2::text[])
    GROUP BY te.job_id
  `, [String(ownerId), jobIds]).catch(() => null);

  const labourByJob = {};
  for (const row of (labourResult?.rows || [])) {
    labourByJob[row.job_id] = toInt(row.labour_cost_cents);
  }

  // ── 4. Compute per-job metrics ─────────────────────────────────────────
  const margins = [];
  const labourPcts = [];
  const revenues = [];
  const jobsWithRevenue = [];

  for (const j of jobs) {
    const jid = String(j.id);
    const tx = txByJob[jid] || { revenue_cents: 0, expense_cents: 0 };
    const actualLabour = labourByJob[jid] || 0;
    const totalCosts = tx.expense_cents + actualLabour;
    const revenue = tx.revenue_cents;

    if (revenue > 0) {
      const profit = revenue - totalCosts;
      const marginPct = Math.round((profit / revenue) * 100);
      const labourPct = Math.round((actualLabour / revenue) * 100);

      margins.push(marginPct);
      labourPcts.push(labourPct);
      revenues.push(revenue);
      jobsWithRevenue.push({
        job_id:       jid,
        job_no:       j.job_no,
        job_name:     j.name,
        revenue_cents: revenue,
        total_costs_cents: totalCosts,
        margin_pct:   marginPct,
        labour_pct_of_revenue: labourPct,
      });
    }
  }

  const jobCount = jobs.length;
  const jobsWithData = jobsWithRevenue.length;

  const avgMarginPct = margins.length
    ? Math.round(margins.reduce((a, b) => a + b, 0) / margins.length)
    : null;

  const avgLabourPct = labourPcts.length
    ? Math.round(labourPcts.reduce((a, b) => a + b, 0) / labourPcts.length)
    : null;

  const avgRevenueCents = revenues.length
    ? Math.round(revenues.reduce((a, b) => a + b, 0) / revenues.length)
    : null;

  const totalRevenueCents = revenues.reduce((a, b) => a + b, 0);

  // Margin distribution for richer context
  const p25 = margins.length >= 4
    ? margins.sort((a, b) => a - b)[Math.floor(margins.length * 0.25)]
    : null;
  const p75 = margins.length >= 4
    ? margins.sort((a, b) => a - b)[Math.floor(margins.length * 0.75)]
    : null;

  return {
    job_count:               jobCount,
    jobs_with_revenue_data:  jobsWithData,
    keyword:                 keyword || null,
    status_filter:           status || null,
    date_from:               dateFrom || null,
    date_to:                 dateTo   || null,

    avg_margin_pct:          avgMarginPct,
    avg_labour_pct_of_revenue: avgLabourPct,
    avg_revenue_cents:       avgRevenueCents,
    avg_revenue_fmt:         avgRevenueCents !== null ? fmtDollars(avgRevenueCents) : null,
    total_revenue_cents:     totalRevenueCents,
    total_revenue_fmt:       fmtDollars(totalRevenueCents),

    margin_p25_pct:          p25,
    margin_p75_pct:          p75,

    // Top-level jobs list (sorted best margin first)
    jobs: jobsWithRevenue.sort((a, b) => b.margin_pct - a.margin_pct),
  };
}

// ── Tool spec ─────────────────────────────────────────────────────────────────
const ownerBenchmarksTool = {
  type: 'function',
  function: {
    name: 'get_owner_benchmarks',
    description: [
      'Compute the owner\'s own historical averages across all (or keyword-filtered) jobs.',
      'Returns average margin %, average labor as % of revenue, average job size.',
      'Use to add comparative context after answering a specific job question:',
      '"That\'s below your average of 34%",',
      '"Your typical deck job runs 28% margin — this one is above that",',
      '"Your labor usually runs 40% of revenue; this job is at 55%".',
      'Also use when asked: "What\'s my average margin?", "How do I usually do?", "What\'s typical for me?"',
    ].join(' '),
    parameters: {
      type: 'object',
      required: ['owner_id'],
      properties: {
        owner_id:  { type: 'string', description: 'Owner ID (digits string)' },
        keyword:   { type: 'string', description: 'Filter jobs by name keyword (e.g. "bathroom", "deck"). Omit for all jobs.' },
        status:    { type: 'string', description: 'Filter by job status. Use "completed" for closed-job benchmarks.' },
        date_from: { type: 'string', description: 'YYYY-MM-DD — only include jobs created on or after this date' },
        date_to:   { type: 'string', description: 'YYYY-MM-DD — only include jobs created on or before this date' },
      },
    },
  },
  __handler: async (args) => {
    try {
      return await getOwnerBenchmarks({
        ownerId:  String(args.owner_id || '').trim(),
        keyword:  args.keyword   ? String(args.keyword).trim()   : null,
        status:   args.status    ? String(args.status).trim()    : null,
        dateFrom: args.date_from ? String(args.date_from).trim() : null,
        dateTo:   args.date_to   ? String(args.date_to).trim()   : null,
      });
    } catch (err) {
      return { error: `get_owner_benchmarks failed: ${err?.message}` };
    }
  },
};

module.exports = { ownerBenchmarksTool, getOwnerBenchmarks };
