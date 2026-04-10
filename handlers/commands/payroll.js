'use strict';

/**
 * handlers/commands/payroll.js
 * WhatsApp payroll summary command — owner-only, Starter+.
 *
 * Supported:
 *   payroll this week
 *   payroll summary
 *   payroll [YYYY-MM-DD] to [YYYY-MM-DD]   (custom range)
 *   overtime this week
 *   overtime report
 *
 * Replies with per-employee hours + labour cost for the current pay period.
 * Positioned clearly as a calculation tool — not a payroll processor.
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function RESP(t) {
  const s = String(t ?? '').trim();
  if (!s) return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  const e = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${e}</Message></Response>`;
}

function isPayrollCommand(text) {
  const s = String(text || '').trim().toLowerCase();
  return (
    /^payroll\b/.test(s) ||
    /^overtime\s+(this\s+week|report|summary)\b/.test(s)
  );
}

// Get Monday and Sunday of the current ISO week (UTC)
function currentWeekRange() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon … 6=Sat
  const diffToMon = (day === 0 ? -6 : 1 - day);
  const mon = new Date(now);
  mon.setUTCDate(now.getUTCDate() + diffToMon);
  mon.setUTCHours(0, 0, 0, 0);
  const sun = new Date(mon);
  sun.setUTCDate(mon.getUTCDate() + 6);
  sun.setUTCHours(23, 59, 59, 999);
  return {
    dateFrom: mon.toISOString().slice(0, 10),
    dateTo:   sun.toISOString().slice(0, 10),
  };
}

function parseCustomRange(text) {
  const m = text.match(/(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/i);
  return m ? { dateFrom: m[1], dateTo: m[2] } : null;
}

function fmtMoney(cents) {
  return `$${(cents / 100).toFixed(0)}`;
}

function fmtHours(h) {
  const r = Math.round(h * 10) / 10;
  return `${r}h`;
}

async function handlePayroll(from, text, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId) {
  if (!isPayrollCommand(text)) return false;

  if (!isOwner) {
    res.send(RESP('Only the Owner can view payroll summaries.'));
    return true;
  }

  const owner = String(ownerId || from || '').replace(/\D/g, '');
  if (!owner) { res.send(RESP('Unable to identify your account.')); return true; }

  // Parse date range
  const customRange = parseCustomRange(text);
  const { dateFrom, dateTo } = customRange || currentWeekRange();

  const OT_THRESHOLD = 40;

  try {
    // Get time entries for the period, joined with crew rates
    const result = await pool.query(`
      SELECT
        te.employee_name,
        ROUND(SUM(
          EXTRACT(EPOCH FROM (COALESCE(te.clock_out, NOW()) - te.clock_in)) / 3600.0
        )::numeric, 2)::float AS total_hours,
        cr.hourly_rate_cents
      FROM public.time_entries_v2 te
      LEFT JOIN LATERAL (
        SELECT hourly_rate_cents
        FROM public.chiefos_crew_rates
        WHERE owner_id::text = $1
          AND LOWER(employee_name) = LOWER(te.employee_name)
          AND effective_from <= $2::date
        ORDER BY effective_from DESC
        LIMIT 1
      ) cr ON true
      WHERE te.owner_id::text = $1
        AND te.clock_in >= $2::timestamptz
        AND te.clock_in <= ($3::date + interval '1 day')::timestamptz
        AND te.deleted_at IS NULL
        AND te.kind = 'shift'
        AND te.clock_out IS NOT NULL
      GROUP BY te.employee_name, cr.hourly_rate_cents
      ORDER BY te.employee_name
    `, [owner, dateFrom, dateTo]);

    if (!result.rows.length) {
      res.send(RESP(
        `No time entries found for ${dateFrom} to ${dateTo}.\n\n` +
        `Make sure employees are clocked in and out.`
      ));
      return true;
    }

    const lines = [];
    let totalGross = 0;
    let missingRates = [];
    let hasOT = false;

    for (const row of result.rows) {
      const hrs   = Number(row.total_hours) || 0;
      const rate  = Number(row.hourly_rate_cents) || 0;
      const name  = String(row.employee_name || 'Unknown');

      if (!rate) {
        missingRates.push(name);
        lines.push(`${name}: ${fmtHours(hrs)} (no rate set)`);
        continue;
      }

      const regHrs = Math.min(hrs, OT_THRESHOLD);
      const otHrs  = Math.max(0, hrs - OT_THRESHOLD);
      const regPay = Math.round(regHrs * rate);
      const otPay  = Math.round(otHrs * rate * 1.5);
      const gross  = regPay + otPay;
      totalGross  += gross;

      if (otHrs > 0) {
        hasOT = true;
        lines.push(`${name}: ${fmtHours(hrs)} → ${fmtMoney(gross)} (${fmtHours(otHrs)} OT)`);
      } else {
        lines.push(`${name}: ${fmtHours(hrs)} → ${fmtMoney(gross)}`);
      }
    }

    const rangeLabel = customRange
      ? `${dateFrom} to ${dateTo}`
      : `this week (${dateFrom})`;

    let reply = `📊 Payroll — ${rangeLabel}\n\n${lines.join('\n')}`;

    if (totalGross > 0) {
      reply += `\n\n💰 Total labour: ${fmtMoney(totalGross)}`;
    }
    if (missingRates.length) {
      reply += `\n\n⚠️ No rates set for: ${missingRates.join(', ')}. Use "set rate [name] $X/hour" to add them.`;
    }
    if (hasOT) {
      reply += `\n\n⚠️ OT calculated at 1.5×.`;
    }

    reply += `\n\n📋 Labour costs only. Your payroll provider handles deductions + deposits.`;

    res.send(RESP(reply));
  } catch (e) {
    console.error('[payroll] error:', e?.message);
    res.send(RESP('Could not load payroll data. Try again.'));
  }

  return true;
}

module.exports = { handlePayroll, isPayrollCommand };
