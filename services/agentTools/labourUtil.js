'use strict';

/**
 * Agent Tool: get_labour_utilisation
 * Phase 2.2 — Labour Utilisation Analysis
 *
 * Returns hours by employee, estimated labour cost (hours × crew rate),
 * billable allocation, and unallocated time.
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function toInt(x) { const n = Number(x); return Number.isFinite(n) ? Math.trunc(n) : 0; }
function toFloat(x) { const n = Number(x); return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0; }

async function computeLabourUtilisation({ ownerId, dateFrom, dateTo, employeeName }) {
  if (!ownerId) return { error: 'owner_id is required' };

  const params = [String(ownerId)];
  let p = 2;
  const filters = [];

  if (dateFrom) { filters.push(`te_in.clock_in >= $${p++}::timestamptz`); params.push(`${dateFrom}T00:00:00Z`); }
  if (dateTo)   { filters.push(`te_in.clock_in <= $${p++}::timestamptz`); params.push(`${dateTo}T23:59:59Z`); }
  if (employeeName) { filters.push(`LOWER(te_in.employee_name) = LOWER($${p++})`); params.push(employeeName); }

  const filterSql = filters.length ? 'AND ' + filters.join(' AND ') : '';

  const rows = await pool.query(`
    SELECT
      te_in.employee_name,
      te_in.job_id,
      j.name          AS job_name,
      j.job_no,
      COALESCE(cr.hourly_rate_cents, 0) AS rate_cents,
      SUM(
        EXTRACT(EPOCH FROM (COALESCE(te_in.clock_out, NOW()) - te_in.clock_in)) / 3600.0
      ) AS hours
    FROM public.time_entries_v2 te_in
    LEFT JOIN public.jobs j ON j.id = te_in.job_id
    LEFT JOIN public.chiefos_crew_rates cr
      ON cr.owner_id = te_in.owner_id::text
      AND LOWER(cr.employee_name) = LOWER(te_in.employee_name)
    WHERE te_in.owner_id::text = $1
      ${filterSql}
    GROUP BY te_in.employee_name, te_in.job_id, j.name, j.job_no, cr.hourly_rate_cents
    ORDER BY te_in.employee_name, hours DESC
  `, params).catch(() => null);

  const byEmployee = {};

  for (const row of (rows?.rows || [])) {
    const name  = row.employee_name || 'Unknown';
    const hours = toFloat(row.hours);
    const rate  = toInt(row.rate_cents);

    if (!byEmployee[name]) {
      byEmployee[name] = {
        name,
        rate_cents:       rate,
        total_hours:      0,
        allocated_hours:  0,
        unallocated_hours:0,
        cost_cents:       0,
        jobs: [],
      };
    }

    const emp = byEmployee[name];
    emp.total_hours  += hours;
    emp.cost_cents   += Math.round(hours * rate);

    if (row.job_id) {
      emp.allocated_hours += hours;
      emp.jobs.push({
        job_id:   String(row.job_id),
        job_no:   row.job_no,
        job_name: row.job_name || `Job ${row.job_no}`,
        hours,
        cost_cents: Math.round(hours * rate),
      });
    } else {
      emp.unallocated_hours += hours;
    }
  }

  for (const emp of Object.values(byEmployee)) {
    emp.total_hours       = Math.round(emp.total_hours * 10) / 10;
    emp.allocated_hours   = Math.round(emp.allocated_hours * 10) / 10;
    emp.unallocated_hours = Math.round(emp.unallocated_hours * 10) / 10;
    emp.utilisation_pct   = emp.total_hours > 0
      ? Math.round((emp.allocated_hours / emp.total_hours) * 100)
      : null;
  }

  const employees = Object.values(byEmployee).sort((a, b) => b.total_hours - a.total_hours);

  const totalHours     = employees.reduce((s, e) => s + e.total_hours, 0);
  const totalCostCents = employees.reduce((s, e) => s + e.cost_cents, 0);
  const allocatedHours = employees.reduce((s, e) => s + e.allocated_hours, 0);
  const overallUtil    = totalHours > 0 ? Math.round((allocatedHours / totalHours) * 100) : null;

  const underutilised = employees.filter(e => e.utilisation_pct !== null && e.utilisation_pct < 80);

  return {
    date_from:           dateFrom || null,
    date_to:             dateTo   || null,
    employee_filter:     employeeName || null,
    total_hours:         Math.round(totalHours * 10) / 10,
    total_cost_cents:    totalCostCents,
    allocated_hours:     Math.round(allocatedHours * 10) / 10,
    overall_utilisation: overallUtil,
    employees,
    underutilised_employees: underutilised.map(e => ({
      name:              e.name,
      unallocated_hours: e.unallocated_hours,
      utilisation_pct:   e.utilisation_pct,
    })),
  };
}

const labourUtilTool = {
  type: 'function',
  function: {
    name: 'get_labour_utilisation',
    description: [
      'Get labour utilisation analysis: hours by employee, billable allocation %, labour cost, and unallocated time.',
      'Use for questions like "how efficient is my crew?", "how many hours did Mike log?",',
      '"which employees have unallocated time?", "what is my total labour cost this week?"',
    ].join(' '),
    parameters: {
      type: 'object',
      required: ['owner_id'],
      properties: {
        owner_id:      { type: 'string' },
        date_from:     { type: 'string', description: 'ISO date YYYY-MM-DD' },
        date_to:       { type: 'string', description: 'ISO date YYYY-MM-DD' },
        employee_name: { type: 'string', description: 'Filter to a single crew member (optional)' },
      },
    },
  },
  __handler: async (args) => {
    try {
      return await computeLabourUtilisation({
        ownerId:      String(args.owner_id || '').trim(),
        dateFrom:     args.date_from     ? String(args.date_from).trim()     : null,
        dateTo:       args.date_to       ? String(args.date_to).trim()       : null,
        employeeName: args.employee_name ? String(args.employee_name).trim() : null,
      });
    } catch (err) {
      return { error: `get_labour_utilisation failed: ${err?.message}` };
    }
  },
};

module.exports = { labourUtilTool, computeLabourUtilisation };
