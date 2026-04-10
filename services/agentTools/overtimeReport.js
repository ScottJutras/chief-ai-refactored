'use strict';

/**
 * Agent Tool: get_overtime_report
 * Detects employees whose hours in a given week exceed the threshold (default 40h).
 * Returns per-employee breakdown with regular hours, OT hours, and cost premium.
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function toFloat(x) { const n = Number(x); return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0; }
function toInt(x)   { const n = Number(x); return Number.isFinite(n) ? Math.trunc(n) : 0; }
function fmt(cents) { return `$${(cents / 100).toFixed(0)}`; }

// ISO week bounds (Mon–Sun) for a given date string
function weekBounds(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const day = d.getUTCDay() || 7;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - (day - 1));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return {
    from: monday.toISOString().slice(0, 10),
    to:   sunday.toISOString().slice(0, 10),
  };
}

async function getOvertimeReport({ ownerId, dateFrom, dateTo, overtimeThreshold }) {
  if (!ownerId) return { error: 'owner_id is required' };

  const threshold = typeof overtimeThreshold === 'number' ? overtimeThreshold : 40;

  // Default to current week if no range given
  let from = dateFrom, to = dateTo;
  if (!from) {
    const bounds = weekBounds(null);
    from = bounds.from;
    to   = bounds.to;
  }

  const result = await pool.query(
    `SELECT
       te.employee_name,
       SUM(EXTRACT(EPOCH FROM (COALESCE(te.clock_out, NOW()) - te.clock_in)) / 3600.0) AS total_hours,
       COALESCE(cr.hourly_rate_cents, 0) AS rate_cents
     FROM public.time_entries_v2 te
     LEFT JOIN public.chiefos_crew_rates cr
       ON cr.owner_id = te.owner_id::text
       AND LOWER(cr.employee_name) = LOWER(te.employee_name)
     WHERE te.owner_id::text = $1
       AND te.clock_in >= $2::timestamptz
       AND te.clock_in <= $3::timestamptz
     GROUP BY te.employee_name, cr.hourly_rate_cents
     ORDER BY total_hours DESC`,
    [String(ownerId), `${from}T00:00:00Z`, `${to}T23:59:59Z`]
  ).catch(() => null);

  const employees = [];
  let hasOvertime = false;

  for (const row of (result?.rows || [])) {
    const totalHours   = toFloat(row.total_hours);
    const rate         = toInt(row.rate_cents);
    const regularHours = Math.min(totalHours, threshold);
    const otHours      = Math.max(0, totalHours - threshold);
    const otCents      = rate > 0 ? Math.round(otHours * rate * 0.5) : 0; // 0.5x premium
    const totalCents   = rate > 0 ? Math.round(regularHours * rate + (otHours * rate * 1.5)) : 0;

    if (otHours > 0) hasOvertime = true;

    employees.push({
      name:          row.employee_name || 'Unknown',
      total_hours:   totalHours,
      regular_hours: Math.round(regularHours * 10) / 10,
      ot_hours:      Math.round(otHours * 10) / 10,
      rate_cents:    rate,
      ot_premium_cents: otCents,
      total_cost_cents: totalCents,
      total_cost_fmt: rate > 0 ? fmt(totalCents) : 'rate not set',
      ot_premium_fmt: rate > 0 ? `+${fmt(otCents)}` : 'rate not set',
      has_overtime:  otHours > 0,
    });
  }

  const totalOtHours = employees.reduce((s, e) => s + e.ot_hours, 0);
  const totalOtCents = employees.reduce((s, e) => s + e.ot_premium_cents, 0);

  return {
    date_from:         from,
    date_to:           to,
    overtime_threshold: threshold,
    has_overtime:      hasOvertime,
    total_ot_hours:    Math.round(totalOtHours * 10) / 10,
    total_ot_premium_cents: totalOtCents,
    total_ot_premium_fmt: fmt(totalOtCents),
    employees,
    employees_with_ot: employees.filter(e => e.has_overtime),
  };
}

const overtimeReportTool = {
  type: 'function',
  function: {
    name: 'get_overtime_report',
    description: [
      'Get overtime report: employees with hours over the weekly threshold (default 40h).',
      'Returns regular hours, OT hours, and the cost premium.',
      'Use for questions like "who worked overtime this week?", "how much is overtime costing me?",',
      '"is anyone over 40 hours?", "what\'s my overtime exposure?"',
    ].join(' '),
    parameters: {
      type: 'object',
      required: ['owner_id'],
      properties: {
        owner_id:           { type: 'string' },
        date_from:          { type: 'string', description: 'ISO date YYYY-MM-DD (defaults to start of current week)' },
        date_to:            { type: 'string', description: 'ISO date YYYY-MM-DD (defaults to end of current week)' },
        overtime_threshold: { type: 'number', description: 'Hours per week before OT applies (default: 40)' },
      },
    },
  },
  __handler: async (args) => {
    try {
      return await getOvertimeReport({
        ownerId:           String(args.owner_id || '').trim(),
        dateFrom:          args.date_from ? String(args.date_from).trim() : null,
        dateTo:            args.date_to   ? String(args.date_to).trim()   : null,
        overtimeThreshold: args.overtime_threshold ? Number(args.overtime_threshold) : 40,
      });
    } catch (err) {
      return { error: `get_overtime_report failed: ${err?.message}` };
    }
  },
};

module.exports = { overtimeReportTool, getOvertimeReport };
