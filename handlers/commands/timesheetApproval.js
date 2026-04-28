'use strict';

/**
 * handlers/commands/timesheetApproval.js
 * Phase 1.5 — Timesheet Approval Flow
 *
 * Employee commands (non-owner, Pro plan):
 *   submit timesheet              → this week
 *   submit timesheet last week    → last week
 *   submit timesheet [date] to [date]
 *
 * Owner commands:
 *   pending timesheets            → list all pending submissions
 *   timesheets                    → same
 *   approve timesheet [name]      → approve employee's latest pending
 *   reject timesheet [name] [note]
 *
 * Lock utility (exported):
 *   isTimePeriodLocked(ownerId, employeeName, date) → boolean
 *   Used by timeclock.js to block undo/edit on approved periods.
 */

const { Pool } = require('pg');
const { getUserBasic } = require('../../services/users');
const { getEffectivePlanKey } = require('../../src/config/getEffectivePlanKey');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const DIGITS = (x) =>
  String(x ?? '')
    .replace(/^whatsapp:/i, '')
    .replace(/^\+/, '')
    .replace(/\D/g, '');

function twiml(text) {
  const t = String(text ?? '').trim();
  if (!t) return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  const e = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${e}</Message></Response>`;
}

let sendWhatsApp;
try { ({ sendWhatsApp } = require('../../services/twilio')); } catch {}

// ── Date range helpers ────────────────────────────────────────────────────────

function weekRange(offsetWeeks = 0) {
  const now = new Date();
  const day = now.getUTCDay();
  const diffToMon = day === 0 ? -6 : 1 - day;
  const mon = new Date(now);
  mon.setUTCDate(now.getUTCDate() + diffToMon + offsetWeeks * 7);
  mon.setUTCHours(0, 0, 0, 0);
  const sun = new Date(mon);
  sun.setUTCDate(mon.getUTCDate() + 6);
  sun.setUTCHours(23, 59, 59, 999);
  return { from: mon.toISOString().slice(0, 10), to: sun.toISOString().slice(0, 10) };
}

function parseRange(text) {
  const lc = text.toLowerCase();
  if (/last\s+week/.test(lc)) return weekRange(-1);
  const custom = text.match(/(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/i);
  if (custom) return { from: custom[1], to: custom[2] };
  return weekRange(0);
}

function fmtDate(d) { return String(d || '').slice(0, 10); }
function fmtH(h) {
  const r = Math.round(Number(h || 0) * 10) / 10;
  return r === 1 ? '1 hr' : `${r} hrs`;
}
function fmtMoney(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

// ── Lock check (exported for timeclock.js) ────────────────────────────────────

/**
 * Returns true if the given date falls inside an approved timesheet period
 * for the specified owner + employee.
 */
async function isTimePeriodLocked(ownerId, employeeName, date) {
  if (!ownerId || !employeeName || !date) return false;
  try {
    const dateStr = typeof date === 'string' ? date.slice(0, 10) : new Date(date).toISOString().slice(0, 10);
    const { rows } = await pool.query(
      `SELECT id FROM public.timesheet_approvals
       WHERE owner_id = $1
         AND LOWER(employee_name) = LOWER($2)
         AND period_start <= $3::date
         AND period_end   >= $3::date
         AND status = 'approved'
       LIMIT 1`,
      [String(ownerId), String(employeeName), dateStr]
    );
    return rows.length > 0;
  } catch {
    return false; // fail-open on lock check error
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function calcWeeklyTotals(ownerId, employeeName, range) {
  const { rows } = await pool.query(
    `SELECT
       SUM(EXTRACT(EPOCH FROM (COALESCE(clock_out, NOW()) - clock_in)) / 3600.0) AS total_hours,
       COUNT(*) AS shift_count
     FROM public.time_entries_v2
     WHERE owner_id = $1
       AND LOWER(employee_name) = LOWER($2)
       AND clock_in >= $3
       AND clock_in <= $4
       AND (entry_type IS NULL OR entry_type = 'work')`,
    [ownerId, employeeName, range.from + 'T00:00:00Z', range.to + 'T23:59:59Z']
  );
  const totalHours = Number(rows[0]?.total_hours || 0);

  // Try to get hourly rate for cost calc
  const rateRow = await pool.query(
    `SELECT hourly_rate_cents FROM public.chiefos_crew_rates
     WHERE owner_id = $1 AND LOWER(employee_name) = LOWER($2) LIMIT 1`,
    [ownerId, employeeName]
  ).catch(() => ({ rows: [] }));
  const rateCents = Number(rateRow.rows[0]?.hourly_rate_cents || 0);
  const costCents = rateCents > 0 ? Math.round(totalHours * rateCents) : null;

  return { totalHours, costCents, shiftCount: Number(rows[0]?.shift_count || 0) };
}

// Post-rebuild canonical: public.users keyed by (owner_id, role).
// chiefos_tenant_actor_profiles DISCARDed per Decision 12.
// user_id is the digits PK = phone.
async function getOwnerPhone(ownerId) {
  try {
    const { rows } = await pool.query(
      `SELECT user_id AS phone_digits FROM public.users
       WHERE owner_id = $1 AND role = 'owner' LIMIT 1`,
      [String(ownerId)]
    );
    return rows[0]?.phone_digits || null;
  } catch { return null; }
}

async function getEmployeePhone(ownerId, employeeName) {
  try {
    const { rows } = await pool.query(
      `SELECT user_id AS phone_digits FROM public.users
       WHERE owner_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
      [String(ownerId), String(employeeName)]
    );
    return rows[0]?.phone_digits || null;
  } catch { return null; }
}

// ── Command detection ─────────────────────────────────────────────────────────

function isTimesheetApprovalCommand(text) {
  const lc = String(text || '').trim().toLowerCase();
  return (
    /^submit\s+timesheet\b/.test(lc) ||
    /^(pending\s+)?timesheets?\b/.test(lc) ||
    /^(approve|reject)\s+timesheet\b/.test(lc)
  );
}

// ── Main handler ──────────────────────────────────────────────────────────────

async function handleTimesheetApproval(from, text, userProfile, ownerId, ownerProfile, isOwner, res) {
  const raw = String(text || '').trim();
  const lc  = raw.toLowerCase();

  // ── OWNER: pending timesheets / timesheets ────────────────────────────────
  if (isOwner && /^(pending\s+)?timesheets?\b/i.test(lc)) {
    const { rows } = await pool.query(
      `SELECT employee_name, period_start, period_end, total_hours, total_cost_cents, submitted_at
       FROM public.timesheet_approvals
       WHERE owner_id = $1 AND status = 'pending'
       ORDER BY submitted_at ASC
       LIMIT 10`,
      [String(ownerId)]
    ).catch(() => ({ rows: [] }));

    if (!rows.length) {
      res.status(200).type('application/xml; charset=utf-8').send(
        twiml("✅ No pending timesheet submissions.")
      );
      return true;
    }

    const lines = ['📋 *Pending Timesheets*', ''];
    for (const r of rows) {
      const hrs  = fmtH(r.total_hours);
      const cost = r.total_cost_cents ? ` (${fmtMoney(r.total_cost_cents)})` : '';
      lines.push(
        `• ${r.employee_name}: ${fmtDate(r.period_start)} – ${fmtDate(r.period_end)} — ${hrs}${cost}`,
        `  Submitted: ${fmtDate(r.submitted_at)}`
      );
    }
    lines.push('');
    lines.push('Reply: "approve timesheet [name]" or "reject timesheet [name] [note]"');

    res.status(200).type('application/xml; charset=utf-8').send(twiml(lines.join('\n')));
    return true;
  }

  // ── OWNER: approve timesheet [name] ──────────────────────────────────────
  const approveMatch = /^approve\s+timesheet\s+(.+)/i.exec(raw);
  if (isOwner && approveMatch) {
    const empName = approveMatch[1].trim();

    const result = await pool.query(
      `UPDATE public.timesheet_approvals
       SET status = 'approved', reviewed_at = NOW()
       WHERE id = (
         SELECT id FROM public.timesheet_approvals
         WHERE owner_id = $1
           AND LOWER(employee_name) = LOWER($2)
           AND status = 'pending'
         ORDER BY period_end DESC
         LIMIT 1
       )
       RETURNING employee_name, period_start, period_end, total_hours, total_cost_cents`,
      [String(ownerId), empName]
    ).catch(() => ({ rows: [] }));

    if (!result.rows.length) {
      res.status(200).type('application/xml; charset=utf-8').send(
        twiml(`No pending timesheet found for "${empName}". Check "timesheets" to see the list.`)
      );
      return true;
    }

    const row = result.rows[0];
    const hrs  = fmtH(row.total_hours);
    const cost = row.total_cost_cents ? ` (${fmtMoney(row.total_cost_cents)})` : '';

    res.status(200).type('application/xml; charset=utf-8').send(
      twiml(
        `✅ Timesheet approved for *${row.employee_name}*\n` +
        `Period: ${fmtDate(row.period_start)} – ${fmtDate(row.period_end)}\n` +
        `Hours: ${hrs}${cost}\n\n` +
        `This period is now locked — time entries cannot be undone.`
      )
    );

    // Notify employee
    try {
      const empPhone = await getEmployeePhone(ownerId, row.employee_name);
      if (empPhone && sendWhatsApp) {
        await sendWhatsApp(
          `+${empPhone}`,
          `✅ Your timesheet for ${fmtDate(row.period_start)} – ${fmtDate(row.period_end)} has been *approved* (${hrs}${cost}). The period is now locked.`
        );
      }
    } catch {}

    return true;
  }

  // ── OWNER: reject timesheet [name] [note] ─────────────────────────────────
  const rejectMatch = /^reject\s+timesheet\s+(\S+(?:\s+\S+)*?)(?:\s{2,}|\s*[-–]\s*)(.+)?$/i.exec(raw) ||
                      /^reject\s+timesheet\s+(.+)/i.exec(raw);
  if (isOwner && rejectMatch) {
    // Parse: first token(s) = name, rest = note
    // Strategy: try to match against known pending employees; otherwise split on first word
    const afterCmd = raw.replace(/^reject\s+timesheet\s+/i, '').trim();
    const pendingRows = await pool.query(
      `SELECT id, employee_name, period_start, period_end FROM public.timesheet_approvals
       WHERE owner_id = $1 AND status = 'pending'
       ORDER BY period_end DESC`,
      [String(ownerId)]
    ).catch(() => ({ rows: [] }));

    // Find which pending employee name is a prefix of afterCmd
    let matched = null;
    let reviewerNote = '';
    for (const pr of pendingRows.rows) {
      const empLc = pr.employee_name.toLowerCase();
      const afterLc = afterCmd.toLowerCase();
      if (afterLc.startsWith(empLc)) {
        matched = pr;
        reviewerNote = afterCmd.slice(pr.employee_name.length).replace(/^[\s,:-]+/, '').trim();
        break;
      }
    }
    // Fallback: split on first word as name
    if (!matched) {
      const parts = afterCmd.split(/\s+/);
      const nameGuess = parts[0];
      const noteGuess = parts.slice(1).join(' ');
      const found = pendingRows.rows.find(r =>
        r.employee_name.toLowerCase().startsWith(nameGuess.toLowerCase())
      );
      if (found) { matched = found; reviewerNote = noteGuess; }
    }

    if (!matched) {
      res.status(200).type('application/xml; charset=utf-8').send(
        twiml(`No pending timesheet found matching that name. Check "timesheets" to see the list.`)
      );
      return true;
    }

    await pool.query(
      `UPDATE public.timesheet_approvals
       SET status = 'rejected', reviewed_at = NOW(), reviewer_note = $3
       WHERE id = $1 AND owner_id = $2`,
      [matched.id, String(ownerId), reviewerNote || null]
    ).catch(() => {});

    res.status(200).type('application/xml; charset=utf-8').send(
      twiml(
        `❌ Timesheet rejected for *${matched.employee_name}*\n` +
        `Period: ${fmtDate(matched.period_start)} – ${fmtDate(matched.period_end)}\n` +
        (reviewerNote ? `Note: ${reviewerNote}` : '')
      )
    );

    // Notify employee
    try {
      const empPhone = await getEmployeePhone(ownerId, matched.employee_name);
      if (empPhone && sendWhatsApp) {
        const noteStr = reviewerNote ? `\nNote from owner: ${reviewerNote}` : '';
        await sendWhatsApp(
          `+${empPhone}`,
          `❌ Your timesheet for ${fmtDate(matched.period_start)} – ${fmtDate(matched.period_end)} was *rejected*.${noteStr}\n\nPlease contact your employer for details.`
        );
      }
    } catch {}

    return true;
  }

  // ── EMPLOYEE: submit timesheet ────────────────────────────────────────────
  if (/^submit\s+timesheet\b/i.test(lc)) {
    // Plan gate — Pro only
    const plan = getEffectivePlanKey(ownerProfile);
    if (plan !== 'pro') {
      res.status(200).type('application/xml; charset=utf-8').send(
        twiml("Timesheet submission is a Pro feature. Ask the business owner to upgrade.")
      );
      return true;
    }

    // Resolve actor identity
    const actorDigits = DIGITS(from);
    const userRow = await getUserBasic(actorDigits).catch(() => null);
    const employeeName = userRow?.name?.trim() || null;

    if (!employeeName) {
      res.status(200).type('application/xml; charset=utf-8').send(
        twiml("I couldn't find your name in this account. Make sure the owner has added you as a team member.")
      );
      return true;
    }

    const range = parseRange(raw);
    const rangeLabel = /last\s+week/i.test(lc) ? 'last week' : 'this week';

    // Check if already submitted for this period
    const existing = await pool.query(
      `SELECT status FROM public.timesheet_approvals
       WHERE owner_id = $1
         AND LOWER(employee_name) = LOWER($2)
         AND period_start = $3::date
         AND period_end   = $4::date
       LIMIT 1`,
      [String(ownerId), employeeName, range.from, range.to]
    ).catch(() => ({ rows: [] }));

    if (existing.rows.length) {
      const st = existing.rows[0].status;
      const statusLabel = st === 'approved' ? '✅ approved' : st === 'rejected' ? '❌ rejected' : '⏳ pending review';
      res.status(200).type('application/xml; charset=utf-8').send(
        twiml(`You've already submitted a timesheet for ${rangeLabel} (${range.from} – ${range.to}). Status: ${statusLabel}.`)
      );
      return true;
    }

    // Calculate hours for the period
    const { totalHours, costCents, shiftCount } = await calcWeeklyTotals(ownerId, employeeName, range);

    if (totalHours === 0 && shiftCount === 0) {
      res.status(200).type('application/xml; charset=utf-8').send(
        twiml(`No time entries found for ${rangeLabel} (${range.from} – ${range.to}). Nothing to submit.`)
      );
      return true;
    }

    // Post-rebuild: tenant_id by owner_id lives on chiefos_tenants (UNIQUE).
    const tenantResult = await pool.query(
      `SELECT id AS tenant_id FROM public.chiefos_tenants WHERE owner_id = $1 LIMIT 1`,
      [String(ownerId)]
    ).catch(() => ({ rows: [] }));
    const tenantId = tenantResult.rows[0]?.tenant_id || '00000000-0000-0000-0000-000000000000';

    await pool.query(
      `INSERT INTO public.timesheet_approvals
         (tenant_id, owner_id, employee_name, period_start, period_end, total_hours, total_cost_cents, status, submitted_at)
       VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, 'pending', NOW())
       ON CONFLICT (owner_id, employee_name, period_start, period_end)
       DO UPDATE SET total_hours = EXCLUDED.total_hours, total_cost_cents = EXCLUDED.total_cost_cents,
                     status = 'pending', submitted_at = NOW()`,
      [tenantId, String(ownerId), employeeName, range.from, range.to,
       Math.round(totalHours * 100) / 100, costCents]
    );

    const costStr = costCents ? ` (${fmtMoney(costCents)})` : '';
    res.status(200).type('application/xml; charset=utf-8').send(
      twiml(
        `📤 Timesheet submitted for ${rangeLabel}!\n\n` +
        `Period: ${range.from} – ${range.to}\n` +
        `Hours: ${fmtH(totalHours)}${costStr}\n\n` +
        `Your employer has been notified. You'll get a message when it's reviewed.`
      )
    );

    // Notify owner
    try {
      const ownerPhone = ownerProfile?.phone_digits || await getOwnerPhone(ownerId);
      if (ownerPhone && sendWhatsApp) {
        await sendWhatsApp(
          `+${ownerPhone}`,
          `📋 *Timesheet submitted* by ${employeeName}\n` +
          `Period: ${range.from} – ${range.to} — ${fmtH(totalHours)}${costStr}\n\n` +
          `Reply "approve timesheet ${employeeName}" to approve.`
        );
      }
    } catch {}

    return true;
  }

  return false;
}

module.exports = { isTimesheetApprovalCommand, handleTimesheetApproval, isTimePeriodLocked };
