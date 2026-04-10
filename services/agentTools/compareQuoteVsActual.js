'use strict';

/**
 * Agent Tool: compare_quote_vs_actual
 * Compares quoted (estimate) cost vs actual (recorded) cost for a specific job.
 * Returns variance by category: labour, materials, other, plus total quoted vs actual.
 *
 * Quote source: quote_line_items (qty × unit_price_cents, grouped by category)
 * Actual source: transactions (expenses by category) + time_entries_v2 × crew_rates
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

function varianceLine(quoted, actual) {
  const diff = actual - quoted;
  const pct  = quoted > 0 ? Math.round((diff / quoted) * 100) : null;
  return {
    quoted_cents:   quoted,
    actual_cents:   actual,
    variance_cents: diff,
    variance_pct:   pct,
    status: diff > 0 ? 'over' : diff < 0 ? 'under' : 'on_budget',
  };
}

async function compareQuoteVsActual({ ownerId, jobId, jobNo }) {
  // ── 1. Resolve job ──────────────────────────────────────────────────────
  let resolvedJobId = jobId || null;
  let resolvedTenantId = null;
  let jobName = null;
  let jobNumber = null;
  let jobStatus = null;

  if (!resolvedJobId && jobNo) {
    const row = await pool.query(
      `SELECT id, name, job_no, status FROM public.jobs WHERE owner_id::text = $1 AND job_no = $2 LIMIT 1`,
      [String(ownerId), Number(jobNo)]
    ).catch(() => null);
    if (row?.rows?.[0]) {
      resolvedJobId = String(row.rows[0].id);
      jobName       = row.rows[0].name;
      jobNumber     = row.rows[0].job_no;
      jobStatus     = row.rows[0].status;
    }
  } else if (resolvedJobId) {
    const row = await pool.query(
      `SELECT j.name, j.job_no, j.status, p.tenant_id
       FROM public.jobs j
       LEFT JOIN public.chiefos_tenant_actor_profiles p ON p.owner_id = j.owner_id::text
       WHERE j.owner_id::text = $1 AND j.id = $2 LIMIT 1`,
      [String(ownerId), resolvedJobId]
    ).catch(() => null);
    if (row?.rows?.[0]) {
      jobName         = row.rows[0].name;
      jobNumber       = row.rows[0].job_no;
      jobStatus       = row.rows[0].status;
      resolvedTenantId = row.rows[0].tenant_id;
    }
  }

  if (!resolvedJobId) {
    return { error: 'Job not found. Provide job_id (UUID) or job_no (integer).' };
  }

  // Need tenant_id for quote_line_items (which is tenant-scoped)
  if (!resolvedTenantId) {
    const tRow = await pool.query(
      `SELECT tenant_id FROM public.chiefos_tenant_actor_profiles WHERE owner_id = $1 LIMIT 1`,
      [String(ownerId)]
    ).catch(() => null);
    resolvedTenantId = tRow?.rows?.[0]?.tenant_id || null;
  }

  // ── 2. Quoted costs (quote_line_items) ──────────────────────────────────
  let quotedLabour    = 0;
  let quotedMaterials = 0;
  let quotedOther     = 0;
  let hasQuote        = false;

  if (resolvedTenantId) {
    const qResult = await pool.query(`
      SELECT category, SUM(qty * unit_price_cents) AS total_cents
      FROM public.quote_line_items
      WHERE job_id = $1 AND tenant_id = $2
      GROUP BY category
    `, [Number(resolvedJobId), resolvedTenantId]).catch(() => null);

    for (const row of (qResult?.rows || [])) {
      hasQuote = true;
      const cents = toInt(row.total_cents);
      const cat   = String(row.category || 'other').toLowerCase();
      if (cat === 'labour' || cat === 'labor') quotedLabour    += cents;
      else if (cat === 'materials')             quotedMaterials += cents;
      else                                      quotedOther     += cents;
    }
  }

  // ── 3. Actual expenses (transactions) ───────────────────────────────────
  const txResult = await pool.query(`
    SELECT category, kind, SUM(amount_cents) AS total_cents
    FROM public.transactions
    WHERE owner_id::text = $1 AND job_id::text = $2
    GROUP BY category, kind
  `, [String(ownerId), String(resolvedJobId)]).catch(() => null);

  let actualRevenue   = 0;
  let actualMaterials = 0;
  let actualOther     = 0;
  let expensesByCategory = {};

  for (const row of (txResult?.rows || [])) {
    const cents = toInt(row.total_cents);
    if (row.kind === 'revenue') {
      actualRevenue += cents;
      continue;
    }
    if (row.kind !== 'expense') continue;
    const cat = String(row.category || 'other').toLowerCase();
    expensesByCategory[row.category || 'Other'] = (expensesByCategory[row.category || 'Other'] || 0) + cents;
    // Map to quote categories
    if (['labour', 'labor'].includes(cat)) {
      // skip — covered by time entries below
    } else if (['materials', 'material', 'supplies'].includes(cat)) {
      actualMaterials += cents;
    } else {
      actualOther += cents;
    }
  }

  // ── 4. Actual labour (time_entries_v2 × crew_rates) ─────────────────────
  const labourResult = await pool.query(`
    SELECT
      te.employee_name,
      SUM(EXTRACT(EPOCH FROM (COALESCE(te.clock_out, NOW()) - te.clock_in)) / 3600.0) AS total_hours,
      COALESCE(cr.hourly_rate_cents, 0) AS rate_cents
    FROM public.time_entries_v2 te
    LEFT JOIN public.chiefos_crew_rates cr
      ON cr.owner_id = te.owner_id::text
      AND LOWER(cr.employee_name) = LOWER(te.employee_name)
    WHERE te.owner_id::text = $1 AND te.job_id::text = $2
    GROUP BY te.employee_name, cr.hourly_rate_cents
  `, [String(ownerId), String(resolvedJobId)]).catch(() => null);

  let actualLabour      = 0;
  let totalHours        = 0;
  let missingRates      = false;
  const labourByEmployee = [];

  for (const row of (labourResult?.rows || [])) {
    const hrs  = Number(row.total_hours) || 0;
    const rate = toInt(row.rate_cents);
    totalHours += hrs;
    if (rate === 0 && hrs > 0) missingRates = true;
    const cost = Math.round(hrs * rate);
    actualLabour += cost;
    labourByEmployee.push({
      name:       row.employee_name || 'Unknown',
      hours:      Math.round(hrs * 10) / 10,
      rate_cents: rate,
      cost_cents: cost,
    });
  }

  // ── 5. Build comparison ──────────────────────────────────────────────────
  const quotedTotal = quotedLabour + quotedMaterials + quotedOther;
  const actualTotal = actualLabour + actualMaterials + actualOther;
  const totalVar    = varianceLine(quotedTotal, actualTotal);

  const result = {
    job_id:     resolvedJobId,
    job_no:     jobNumber,
    job_name:   jobName,
    job_status: jobStatus,
    has_quote:  hasQuote,

    revenue_cents: actualRevenue,
    revenue_fmt:   fmtDollars(actualRevenue),

    // Quoted breakdown
    quoted: {
      labour_cents:    quotedLabour,
      materials_cents: quotedMaterials,
      other_cents:     quotedOther,
      total_cents:     quotedTotal,
      labour_fmt:      fmtDollars(quotedLabour),
      materials_fmt:   fmtDollars(quotedMaterials),
      other_fmt:       fmtDollars(quotedOther),
      total_fmt:       fmtDollars(quotedTotal),
    },

    // Actual breakdown
    actual: {
      labour_cents:    actualLabour,
      materials_cents: actualMaterials,
      other_cents:     actualOther,
      total_cents:     actualTotal,
      labour_fmt:      fmtDollars(actualLabour),
      materials_fmt:   fmtDollars(actualMaterials),
      other_fmt:       fmtDollars(actualOther),
      total_fmt:       fmtDollars(actualTotal),
    },

    // Variance by category
    variance: {
      labour:    varianceLine(quotedLabour,    actualLabour),
      materials: varianceLine(quotedMaterials, actualMaterials),
      other:     varianceLine(quotedOther,     actualOther),
      total:     totalVar,
    },

    // Labour detail
    total_hours:        Math.round(totalHours * 10) / 10,
    labour_by_employee: labourByEmployee,
    missing_rates:      missingRates,

    // Profit summary
    profit_cents: actualRevenue - actualTotal,
    margin_pct:   actualRevenue > 0 ? Math.round(((actualRevenue - actualTotal) / actualRevenue) * 100) : null,
    profit_fmt:   fmtDollars(Math.abs(actualRevenue - actualTotal)),
    profit_sign:  (actualRevenue - actualTotal) >= 0 ? '+' : '-',

    expenses_by_category: expensesByCategory,
  };

  return result;
}

// ── Tool spec ─────────────────────────────────────────────────────────────────
const compareQuoteVsActualTool = {
  type: 'function',
  function: {
    name: 'compare_quote_vs_actual',
    description: [
      'Compare quoted (estimated) costs vs actual costs for a specific job.',
      'Returns variance by category (labour, materials, other) and total over/under budget.',
      'Use when the user asks "did this job come in on budget?", "how did [job] compare to the quote?",',
      '"were we over budget on [job]?", "quote vs actual on job X", etc.',
    ].join(' '),
    parameters: {
      type: 'object',
      required: ['owner_id'],
      properties: {
        owner_id: { type: 'string', description: 'Owner ID (digits string)' },
        job_id:   { type: 'string', description: 'Job UUID — use if you have it' },
        job_no:   { type: 'integer', description: 'Job number (e.g. 7) — use if no UUID' },
      },
    },
  },
  __handler: async (args) => {
    try {
      return await compareQuoteVsActual({
        ownerId: String(args.owner_id || '').trim(),
        jobId:   args.job_id ? String(args.job_id).trim() : null,
        jobNo:   args.job_no ? Number(args.job_no)        : null,
      });
    } catch (err) {
      return { error: `compare_quote_vs_actual failed: ${err?.message}` };
    }
  },
};

module.exports = { compareQuoteVsActualTool, compareQuoteVsActual };
