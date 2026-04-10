'use strict';

/**
 * Agent Tool: get_customer_history
 * Returns all jobs linked to a customer, with P&L summary per job.
 * Also detects repeat customers and computes aggregate metrics.
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function toInt(x) { const n = Number(x); return Number.isFinite(n) ? Math.trunc(n) : 0; }
function fmt(cents) { return `$${(Math.abs(cents) / 100).toFixed(0)}`; }

async function getCustomerHistory({ ownerId, customerName, customerId }) {
  if (!ownerId) return { error: 'owner_id is required' };
  if (!customerName && !customerId) return { error: 'customer_name or customer_id required' };

  // Resolve tenant_id from owner_id
  const tenantRow = await pool.query(
    `SELECT id FROM public.chiefos_tenants
     WHERE regexp_replace(coalesce(owner_id,''), '\\D', '', 'g') = regexp_replace($1, '\\D', '', 'g')
     LIMIT 1`,
    [String(ownerId)]
  ).catch(() => null);
  const tenantId = tenantRow?.rows?.[0]?.id;
  if (!tenantId) return { error: 'tenant not found' };

  // Find the customer
  let customerRow = null;
  if (customerId) {
    const r = await pool.query(
      `SELECT id, name, phone, email FROM public.customers WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [customerId, tenantId]
    ).catch(() => null);
    customerRow = r?.rows?.[0] || null;
  } else {
    const r = await pool.query(
      `SELECT id, name, phone, email FROM public.customers
       WHERE tenant_id = $1 AND LOWER(name) LIKE LOWER($2)
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, `%${customerName}%`]
    ).catch(() => null);
    customerRow = r?.rows?.[0] || null;
  }

  if (!customerRow) {
    return {
      found: false,
      message: `No customer found matching "${customerName}". Check the name or create a customer record from the portal.`,
    };
  }

  // All jobs linked to this customer
  const jobsResult = await pool.query(
    `SELECT j.id, j.job_no, j.name, j.status, j.created_at
     FROM public.jobs j
     JOIN public.job_documents jd ON jd.job_id = j.id
     WHERE jd.customer_id = $1 AND j.owner_id::text = $2
     ORDER BY j.created_at DESC`,
    [customerRow.id, String(ownerId)]
  ).catch(() => null);

  const jobs = jobsResult?.rows || [];

  // P&L per job
  const jobSummaries = await Promise.all(jobs.map(async (job) => {
    const txResult = await pool.query(
      `SELECT kind, SUM(amount_cents) AS total
       FROM public.transactions
       WHERE owner_id::text = $1 AND job_id::text = $2
       GROUP BY kind`,
      [String(ownerId), String(job.id)]
    ).catch(() => null);

    let rev = 0, exp = 0;
    for (const row of (txResult?.rows || [])) {
      if (row.kind === 'revenue') rev += toInt(row.total);
      else if (row.kind === 'expense') exp += toInt(row.total);
    }

    // Labor cost
    const labourResult = await pool.query(
      `SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(te.clock_out, NOW()) - te.clock_in)) / 3600.0) AS hours,
              COALESCE(cr.hourly_rate_cents, 0) AS rate
       FROM public.time_entries_v2 te
       LEFT JOIN public.chiefos_crew_rates cr
         ON cr.owner_id = te.owner_id::text AND LOWER(cr.employee_name) = LOWER(te.employee_name)
       WHERE te.owner_id::text = $1 AND te.job_id::text = $2
       GROUP BY cr.hourly_rate_cents`,
      [String(ownerId), String(job.id)]
    ).catch(() => null);

    let labourCents = 0;
    for (const row of (labourResult?.rows || [])) {
      labourCents += Math.round((Number(row.hours) || 0) * toInt(row.rate));
    }

    const totalCost = exp + labourCents;
    const profit = rev - totalCost;
    const margin = rev > 0 ? Math.round((profit / rev) * 100) : null;

    return {
      job_id: String(job.id),
      job_no: job.job_no,
      job_name: job.name,
      status: job.status,
      created_at: job.created_at,
      revenue_cents: rev,
      expense_cents: exp,
      labour_cents: labourCents,
      profit_cents: profit,
      margin_pct: margin,
      revenue_fmt: fmt(rev),
      profit_fmt: (profit >= 0 ? '+' : '-') + fmt(profit),
    };
  }));

  const totalRevenue = jobSummaries.reduce((s, j) => s + j.revenue_cents, 0);
  const totalProfit = jobSummaries.reduce((s, j) => s + j.profit_cents, 0);
  const marginsWithRevenue = jobSummaries.filter(j => j.revenue_cents > 0 && j.margin_pct !== null);
  const avgMargin = marginsWithRevenue.length
    ? Math.round(marginsWithRevenue.reduce((s, j) => s + j.margin_pct, 0) / marginsWithRevenue.length)
    : null;

  return {
    found: true,
    customer: {
      id: customerRow.id,
      name: customerRow.name,
      phone: customerRow.phone || null,
      email: customerRow.email || null,
    },
    job_count: jobs.length,
    total_revenue_cents: totalRevenue,
    total_profit_cents: totalProfit,
    avg_margin_pct: avgMargin,
    total_revenue_fmt: fmt(totalRevenue),
    total_profit_fmt: (totalProfit >= 0 ? '+' : '-') + fmt(totalProfit),
    is_repeat_customer: jobs.length > 1,
    jobs: jobSummaries,
  };
}

const customerHistoryTool = {
  type: 'function',
  function: {
    name: 'get_customer_history',
    description: [
      'Look up a customer by name and return all their jobs with P&L per job.',
      'Use for questions like "show me all jobs for John Smith", "how much has ABC Corp paid us?",',
      '"is Jane a repeat customer?", "what\'s my history with [customer]?"',
    ].join(' '),
    parameters: {
      type: 'object',
      required: ['owner_id'],
      properties: {
        owner_id:      { type: 'string' },
        customer_name: { type: 'string', description: 'Customer name or partial name to search' },
        customer_id:   { type: 'string', description: 'Customer UUID if known' },
      },
    },
  },
  __handler: async (args) => {
    try {
      return await getCustomerHistory({
        ownerId:      String(args.owner_id || '').trim(),
        customerName: args.customer_name ? String(args.customer_name).trim() : null,
        customerId:   args.customer_id   ? String(args.customer_id).trim()   : null,
      });
    } catch (err) {
      return { error: `get_customer_history failed: ${err?.message}` };
    }
  },
};

module.exports = { customerHistoryTool, getCustomerHistory };
