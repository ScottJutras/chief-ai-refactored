'use strict';

/**
 * Agent Tool: get_payroll_summary
 * Returns payroll period summary: hours, gross pay, and OT breakdown per employee.
 * This is visibility only — not payroll processing.
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function toFloat(x) { const n = Number(x); return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0; }
function toInt(x)   { const n = Number(x); return Number.isFinite(n) ? Math.trunc(n) : 0; }
function fmt(cents) { return `$${(cents / 100).toFixed(2)}`; }

// Default pay period: current Monday–Sunday
function currentPayPeriod() {
  const d = new Date();
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

async function getPayrollSummary({ ownerId, dateFrom, dateTo, overtimeThreshold }) {
  if (!ownerId) return { error: 'owner_id is required' };

  const threshold = typeof overtimeThreshold === 'number' ? overtimeThreshold : 40;
  const { from: defaultFrom, to: defaultTo } = currentPayPeriod();
  const from = dateFrom || defaultFrom;
  const to   = dateTo   || defaultTo;

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
     ORDER BY te.employee_name`,
    [String(ownerId), `${from}T00:00:00Z`, `${to}T23:59:59Z`]
  ).catch(() => null);

  const employees = [];
  let missingRates = false;

  for (const row of (result?.rows || [])) {
    const totalHours    = toFloat(row.total_hours);
    const rate          = toInt(row.rate_cents);
    const regularHours  = Math.min(totalHours, threshold);
    const otHours       = Math.max(0, totalHours - threshold);

    if (rate === 0) missingRates = true;

    const regularPay = Math.round(regularHours * rate);
    const otPay      = Math.round(otHours * rate * 1.5);
    const grossPay   = regularPay + otPay;

    employees.push({
      name:              row.employee_name || 'Unknown',
      total_hours:       totalHours,
      regular_hours:     Math.round(regularHours * 10) / 10,
      ot_hours:          Math.round(otHours * 10) / 10,
      rate_cents:        rate,
      rate_fmt:          rate > 0 ? `$${(rate / 100).toFixed(2)}/hr` : 'rate not set',
      regular_pay_cents: regularPay,
      ot_pay_cents:      otPay,
      gross_pay_cents:   grossPay,
      gross_pay_fmt:     rate > 0 ? fmt(grossPay) : 'rate not set',
      has_overtime:      otHours > 0,
    });
  }

  const totalHours    = employees.reduce((s, e) => s + e.total_hours, 0);
  const totalGrossPay = employees.reduce((s, e) => s + e.gross_pay_cents, 0);
  const totalOtPay    = employees.reduce((s, e) => s + e.ot_pay_cents, 0);

  return {
    period_from:         from,
    period_to:           to,
    overtime_threshold:  threshold,
    employee_count:      employees.length,
    total_hours:         Math.round(totalHours * 10) / 10,
    total_gross_pay_cents: totalGrossPay,
    total_gross_pay_fmt: fmt(totalGrossPay),
    total_ot_pay_cents:  totalOtPay,
    total_ot_pay_fmt:    fmt(totalOtPay),
    missing_rates:       missingRates,
    missing_rates_note:  missingRates
      ? 'Some employees have no rate set. Use `set rate [name] $X/hour` to include them in pay calculations.'
      : null,
    disclaimer:          'ChiefOS calculates labour numbers only. Your payroll provider handles deductions, taxes, and direct deposits.',
    employees,
  };
}

const payrollSummaryTool = {
  type: 'function',
  function: {
    name: 'get_payroll_summary',
    description: [
      'Get payroll summary for a pay period: hours, regular pay, overtime pay, and gross pay per employee.',
      'Visibility only — not payroll processing.',
      'Use for questions like "what\'s my payroll this week?", "how much do I owe in wages?",',
      '"payroll summary", "what are my labour costs this pay period?"',
    ].join(' '),
    parameters: {
      type: 'object',
      required: ['owner_id'],
      properties: {
        owner_id:           { type: 'string' },
        date_from:          { type: 'string', description: 'Pay period start YYYY-MM-DD (defaults to Monday of current week)' },
        date_to:            { type: 'string', description: 'Pay period end YYYY-MM-DD (defaults to Sunday of current week)' },
        overtime_threshold: { type: 'number', description: 'Hours per week before OT at 1.5x (default: 40)' },
      },
    },
  },
  __handler: async (args) => {
    try {
      return await getPayrollSummary({
        ownerId:           String(args.owner_id || '').trim(),
        dateFrom:          args.date_from ? String(args.date_from).trim() : null,
        dateTo:            args.date_to   ? String(args.date_to).trim()   : null,
        overtimeThreshold: args.overtime_threshold ? Number(args.overtime_threshold) : 40,
      });
    } catch (err) {
      return { error: `get_payroll_summary failed: ${err?.message}` };
    }
  },
};

module.exports = { payrollSummaryTool, getPayrollSummary };
