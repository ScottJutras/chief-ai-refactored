'use strict';

/**
 * Agent Tool: get_job_pattern_trends
 *
 * Analyzes the last N jobs (optionally filtered by a keyword in the job name)
 * and returns aggregate pattern data:
 *   - Average margin %
 *   - Average labor cost vs quoted labor (variance %)
 *   - Average job revenue / expense
 *
 * Powers answers like:
 *   "Your last 5 bathroom renos averaged 15% over quoted labor"
 *   "Across 8 deck jobs this year, your average margin is 22%"
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

function avg(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

async function getJobPatternTrends({ ownerId, keyword, limit = 5, status }) {
  if (!ownerId) return { error: 'owner_id is required' };

  const limitN = Math.min(Math.max(Number(limit) || 5, 1), 25);

  // ── 1. Fetch recent jobs (optionally filtered by keyword) ──────────────
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
  jobParams.push(limitN);

  const jobResult = await pool.query(`
    SELECT j.id, j.name, j.job_no, j.status, j.created_at
    FROM public.jobs j
    WHERE j.owner_id::text = $1
    ${jobWhereExtra}
    ORDER BY j.created_at DESC
    LIMIT $${jobParams.length}
  `, jobParams).catch(() => null);

  const jobs = jobResult?.rows || [];
  if (!jobs.length) {
    return {
      jobs_analyzed: 0,
      keyword: keyword || null,
      message: keyword
        ? `No jobs found matching "${keyword}".`
        : 'No jobs found for this owner.',
      jobs: [],
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

  // ── 3. Batch: actual labour from time_entries × crew_rates ────────────
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

  // ── 4. Batch: quoted labour from quote_line_items (needs tenant_id) ───
  const tenantRow = await pool.query(
    `SELECT tenant_id FROM public.chiefos_tenant_actor_profiles WHERE owner_id = $1 LIMIT 1`,
    [String(ownerId)]
  ).catch(() => null);
  const tenantId = tenantRow?.rows?.[0]?.tenant_id || null;

  const quotedByJob = {}; // job_id -> {labour, materials, total}
  if (tenantId) {
    // quote_line_items uses integer job_id (maps to jobs.job_no or job_int_id)
    // We need to join via job_no for each job
    const jobNos = jobs.map(j => j.job_no).filter(n => n != null);
    if (jobNos.length) {
      // Build a map from job_no → job_id
      const jobNoToId = {};
      for (const j of jobs) {
        if (j.job_no != null) jobNoToId[String(j.job_no)] = String(j.id);
      }

      const quoteResult = await pool.query(`
        SELECT
          qli.job_id AS job_no,
          SUM(CASE WHEN LOWER(qli.category) IN ('labour','labor') THEN qli.qty * qli.unit_price_cents ELSE 0 END) AS quoted_labour_cents,
          SUM(CASE WHEN LOWER(qli.category) = 'materials' THEN qli.qty * qli.unit_price_cents ELSE 0 END) AS quoted_materials_cents,
          SUM(qli.qty * qli.unit_price_cents) AS quoted_total_cents
        FROM public.quote_line_items qli
        WHERE qli.tenant_id = $1
          AND qli.job_id = ANY($2::integer[])
        GROUP BY qli.job_id
      `, [tenantId, jobNos]).catch(() => null);

      for (const row of (quoteResult?.rows || [])) {
        const jobId = jobNoToId[String(row.job_no)];
        if (jobId) {
          quotedByJob[jobId] = {
            labour_cents:    toInt(row.quoted_labour_cents),
            materials_cents: toInt(row.quoted_materials_cents),
            total_cents:     toInt(row.quoted_total_cents),
          };
        }
      }
    }
  }

  // ── 5. Per-job metrics ────────────────────────────────────────────────
  const jobMetrics = [];
  for (const j of jobs) {
    const jid = String(j.id);
    const tx = txByJob[jid] || { revenue_cents: 0, expense_cents: 0 };
    const actualLabour = labourByJob[jid] || 0;
    const totalCosts = tx.expense_cents + actualLabour;
    const revenue = tx.revenue_cents;
    const profit = revenue - totalCosts;
    const marginPct = revenue > 0 ? Math.round((profit / revenue) * 100) : null;

    const quoted = quotedByJob[jid] || null;
    let labourVariancePct = null;
    if (quoted && quoted.labour_cents > 0 && actualLabour > 0) {
      labourVariancePct = Math.round(((actualLabour - quoted.labour_cents) / quoted.labour_cents) * 100);
    }

    jobMetrics.push({
      job_id:             jid,
      job_no:             j.job_no,
      job_name:           j.name,
      job_status:         j.status,
      revenue_cents:      revenue,
      expense_cents:      tx.expense_cents,
      actual_labour_cents: actualLabour,
      total_cost_cents:   totalCosts,
      profit_cents:       profit,
      margin_pct:         marginPct,
      quoted_labour_cents: quoted?.labour_cents ?? null,
      labour_variance_pct: labourVariancePct,
      has_quote:          !!quoted,
    });
  }

  // ── 6. Aggregate stats ────────────────────────────────────────────────
  const margins = jobMetrics.map(m => m.margin_pct).filter(v => v !== null);
  const labourVariances = jobMetrics.map(m => m.labour_variance_pct).filter(v => v !== null);
  const revenues = jobMetrics.map(m => m.revenue_cents);
  const jobsWithQuote = jobMetrics.filter(m => m.has_quote).length;

  const avgMarginPct         = margins.length ? Math.round(avg(margins)) : null;
  const avgLabourVariancePct = labourVariances.length ? Math.round(avg(labourVariances)) : null;
  const avgRevenueCents      = revenues.length ? Math.round(avg(revenues)) : null;
  const totalRevenueCents    = revenues.reduce((a, b) => a + b, 0);

  // ── 7. Narrative hint ─────────────────────────────────────────────────
  let labourPattern = null;
  if (avgLabourVariancePct !== null) {
    const direction = avgLabourVariancePct > 0 ? 'over' : 'under';
    const absPct = Math.abs(avgLabourVariancePct);
    labourPattern = `${absPct}% ${direction} quoted labor on average`;
  }

  let marginPattern = null;
  if (avgMarginPct !== null) {
    marginPattern = `average margin of ${avgMarginPct}%`;
  }

  return {
    jobs_analyzed:           jobMetrics.length,
    jobs_with_quote_data:    jobsWithQuote,
    keyword:                 keyword || null,
    status_filter:           status || null,
    avg_margin_pct:          avgMarginPct,
    avg_labour_variance_pct: avgLabourVariancePct,
    avg_revenue_cents:       avgRevenueCents,
    avg_revenue_fmt:         avgRevenueCents !== null ? fmtDollars(avgRevenueCents) : null,
    total_revenue_cents:     totalRevenueCents,
    total_revenue_fmt:       fmtDollars(totalRevenueCents),
    labour_pattern_summary:  labourPattern,
    margin_pattern_summary:  marginPattern,
    jobs:                    jobMetrics,
  };
}

// ── Tool spec ─────────────────────────────────────────────────────────────────
const jobPatternTrendsTool = {
  type: 'function',
  function: {
    name: 'get_job_pattern_trends',
    description: [
      'Analyze a batch of recent jobs (optionally filtered by job name keyword) and return aggregate pattern data:',
      'average margin %, average labor variance vs quote, average job size.',
      'Use when the user asks questions like:',
      '"How do my bathroom reno jobs typically do?",',
      '"What\'s my average margin on deck builds?",',
      '"Am I usually over budget on labour for kitchens?",',
      '"How have my last 5 jobs performed?",',
      '"Do I tend to go over on quoted labor?"',
    ].join(' '),
    parameters: {
      type: 'object',
      required: ['owner_id'],
      properties: {
        owner_id: { type: 'string', description: 'Owner ID (digits string)' },
        keyword:  { type: 'string', description: 'Filter jobs by name keyword (e.g. "bathroom", "deck", "kitchen"). Omit for all jobs.' },
        limit:    { type: 'integer', description: 'How many recent jobs to analyze (default 5, max 25)', default: 5 },
        status:   { type: 'string', description: 'Filter by job status: "completed", "active", etc. Omit for all statuses.' },
      },
    },
  },
  __handler: async (args) => {
    try {
      return await getJobPatternTrends({
        ownerId: String(args.owner_id || '').trim(),
        keyword: args.keyword ? String(args.keyword).trim() : null,
        limit:   args.limit   ? Number(args.limit)          : 5,
        status:  args.status  ? String(args.status).trim()  : null,
      });
    } catch (err) {
      return { error: `get_job_pattern_trends failed: ${err?.message}` };
    }
  },
};

module.exports = { jobPatternTrendsTool, getJobPatternTrends };
