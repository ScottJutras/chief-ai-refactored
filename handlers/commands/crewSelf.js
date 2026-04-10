'use strict';

/**
 * handlers/commands/crewSelf.js
 * Crew Self-Query — "My Performance" (Pro tier only)
 *
 * Crew members can ask about their own hours, jobs, and tasks via WhatsApp.
 * Hard boundary: every query is scoped to the requesting employee's name only.
 * No employee can see another employee's data.
 *
 * Owner commands (owner-only):
 *   crew self query on   → enable crew self-query for this business (default on Pro)
 *   crew self query off  → disable
 *   crew settings        → show current setting
 *
 * Crew commands (non-owner, Pro plan, feature enabled):
 *   my hours             → my hours this week + benchmark
 *   my hours this week   → same
 *   my hours last week   → last week
 *   my hours [date] to [date]
 *   my jobs              → jobs I've clocked into (this week by default)
 *   my jobs this week
 *   my tasks             → tasks assigned to me
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
  if (/this\s+month/.test(lc)) {
    const now = new Date();
    const y = now.getUTCFullYear(), m = now.getUTCMonth();
    const first = `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const last  = new Date(y, m + 1, 0);
    return { from: first, to: last.toISOString().slice(0, 10) };
  }
  const custom = text.match(/(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/i);
  if (custom) return { from: custom[1], to: custom[2] };
  return weekRange(0); // default: this week
}

function fmtH(h) {
  const rounded = Math.round(h * 10) / 10;
  return rounded === 1 ? '1 hour' : `${rounded} hours`;
}

// ── Settings helpers ──────────────────────────────────────────────────────────

const SETTING_KEY = 'crew.self_query_enabled';

async function getCrewSelfQueryEnabled(ownerId) {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM public.settings WHERE owner_id = $1 AND key = $2 LIMIT 1`,
      [ownerId, SETTING_KEY]
    );
    if (!rows.length) return true; // default: enabled on Pro
    return String(rows[0].value || '').toLowerCase() !== 'false';
  } catch {
    return true; // fail-open
  }
}

async function setCrewSelfQueryEnabled(ownerId, enabled) {
  await pool.query(
    `INSERT INTO public.settings (owner_id, key, value, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (owner_id, key) DO UPDATE SET value = $3, updated_at = NOW()`,
    [ownerId, SETTING_KEY, enabled ? 'true' : 'false']
  );
}

// ── Command detection ─────────────────────────────────────────────────────────

function isCrewSelfCommand(text) {
  const lc = String(text || '').trim().toLowerCase();
  return (
    /^my\s+(hours|time|jobs?|tasks?)\b/.test(lc) ||
    /^crew\s+(self\s+query|settings)\b/.test(lc)
  );
}

// ── Query functions (all scoped to employeeName — HARD BOUNDARY) ──────────────

async function queryMyHours(ownerId, employeeName, range) {
  const { rows } = await pool.query(
    `SELECT
       SUM(EXTRACT(EPOCH FROM (COALESCE(clock_out, NOW()) - clock_in)) / 3600.0) AS total_hours,
       COUNT(*) AS shift_count,
       COUNT(DISTINCT DATE(clock_in)) AS days_worked
     FROM public.time_entries_v2
     WHERE owner_id = $1
       AND LOWER(employee_name) = LOWER($2)
       AND clock_in >= $3
       AND clock_in <= $4
       AND (entry_type IS NULL OR entry_type = 'work')`,
    [ownerId, employeeName, range.from + 'T00:00:00Z', range.to + 'T23:59:59Z']
  );
  return rows[0] || {};
}

async function queryTeamAvgHours(ownerId, range) {
  // Returns aggregate only — NO individual names exposed to crew member
  const { rows } = await pool.query(
    `SELECT
       AVG(emp_hours) AS avg_hours,
       COUNT(*) AS employee_count
     FROM (
       SELECT
         employee_name,
         SUM(EXTRACT(EPOCH FROM (COALESCE(clock_out, NOW()) - clock_in)) / 3600.0) AS emp_hours
       FROM public.time_entries_v2
       WHERE owner_id = $1
         AND clock_in >= $2
         AND clock_in <= $3
         AND (entry_type IS NULL OR entry_type = 'work')
       GROUP BY employee_name
     ) t`,
    [ownerId, range.from + 'T00:00:00Z', range.to + 'T23:59:59Z']
  );
  return rows[0] || {};
}

async function queryMyJobs(ownerId, employeeName, range) {
  const { rows } = await pool.query(
    `SELECT DISTINCT
       COALESCE(te.job_name, j.job_name, j.name, 'Unknown job') AS job_label,
       MIN(te.clock_in) AS first_clock,
       SUM(EXTRACT(EPOCH FROM (COALESCE(te.clock_out, NOW()) - te.clock_in)) / 3600.0) AS hours
     FROM public.time_entries_v2 te
     LEFT JOIN public.jobs j
       ON j.owner_id = te.owner_id
      AND (j.id::text = te.job_id::text OR j.job_int_id::text = te.job_id::text)
     WHERE te.owner_id = $1
       AND LOWER(te.employee_name) = LOWER($2)
       AND te.clock_in >= $3
       AND te.clock_in <= $4
       AND (te.entry_type IS NULL OR te.entry_type = 'work')
     GROUP BY job_label
     ORDER BY first_clock DESC
     LIMIT 10`,
    [ownerId, employeeName, range.from + 'T00:00:00Z', range.to + 'T23:59:59Z']
  );
  return rows;
}

async function queryMyTasks(ownerId, employeeName) {
  const { rows } = await pool.query(
    `SELECT t.title, t.status, t.due_date, j.job_name, j.name AS job_alt_name
     FROM public.tasks t
     LEFT JOIN public.jobs j ON j.id = t.job_id AND j.owner_id = $1
     WHERE t.owner_id = $1
       AND LOWER(t.assigned_to) = LOWER($2)
       AND t.status NOT IN ('done','completed','deleted')
     ORDER BY t.due_date ASC NULLS LAST, t.created_at DESC
     LIMIT 20`,
    [ownerId, employeeName]
  );
  return rows;
}

// ── Main handler ──────────────────────────────────────────────────────────────

async function handleCrewSelf(from, text, userProfile, ownerId, ownerProfile, isOwner, res) {
  const raw = String(text || '').trim();
  const lc  = raw.toLowerCase();

  // ── Owner settings commands ───────────────────────────────────────────────
  if (/^crew\s+(self\s+query|settings)\b/i.test(lc)) {
    if (!isOwner) {
      res.status(200).type('application/xml; charset=utf-8').send(
        twiml("Only the account owner can change crew settings.")
      );
      return true;
    }

    if (/\bon\b/.test(lc)) {
      await setCrewSelfQueryEnabled(ownerId, true);
      res.status(200).type('application/xml; charset=utf-8').send(
        twiml("✅ Crew self-query enabled. Crew members on Pro can now text \"my hours\" or \"my jobs\" to see their own stats.")
      );
      return true;
    }

    if (/\boff\b/.test(lc)) {
      await setCrewSelfQueryEnabled(ownerId, false);
      res.status(200).type('application/xml; charset=utf-8').send(
        twiml("🔒 Crew self-query disabled. Crew members will no longer be able to query their own data.")
      );
      return true;
    }

    // Show current setting
    const enabled = await getCrewSelfQueryEnabled(ownerId);
    res.status(200).type('application/xml; charset=utf-8').send(
      twiml([
        `Crew self-query: ${enabled ? '✅ ON' : '🔒 OFF'}`,
        '',
        'To change: reply "crew self query on" or "crew self query off"',
        '',
        'When on (Pro): crew can text "my hours" or "my jobs" to see their own stats.',
      ].join('\n'))
    );
    return true;
  }

  // ── Crew self-query — plan + feature gate ─────────────────────────────────
  const plan = getEffectivePlanKey(ownerProfile);
  if (plan !== 'pro') {
    res.status(200).type('application/xml; charset=utf-8').send(
      twiml([
        "👋 Crew self-query is a Pro feature.",
        "",
        "Ask the business owner to upgrade to Pro to unlock \"my hours\", \"my jobs\", and \"my tasks\" for the whole team.",
      ].join('\n'))
    );
    return true;
  }

  const enabled = await getCrewSelfQueryEnabled(ownerId);
  if (!enabled) {
    res.status(200).type('application/xml; charset=utf-8').send(
      twiml("Your employer has disabled crew self-query. Ask them to enable it if you need access to your stats.")
    );
    return true;
  }

  // ── Resolve actor identity ────────────────────────────────────────────────
  const actorDigits = DIGITS(from);
  const userRow = await getUserBasic(actorDigits).catch(() => null);
  const employeeName = userRow?.name?.trim() || null;

  if (!employeeName) {
    res.status(200).type('application/xml; charset=utf-8').send(
      twiml("I couldn't find your name in this account. Make sure the owner has added you as a team member in the portal.")
    );
    return true;
  }

  const range = parseRange(raw);
  const rangeLabel = /last\s+week/i.test(lc)
    ? 'last week'
    : /this\s+month/i.test(lc)
    ? 'this month'
    : /(\d{4}-\d{2}-\d{2})/.test(raw)
    ? `${range.from} – ${range.to}`
    : 'this week';

  // ── my tasks ─────────────────────────────────────────────────────────────
  if (/^my\s+tasks?\b/i.test(lc)) {
    const tasks = await queryMyTasks(ownerId, employeeName).catch(() => []);
    if (!tasks.length) {
      res.status(200).type('application/xml; charset=utf-8').send(
        twiml(`✅ ${employeeName}, you have no open tasks right now.`)
      );
      return true;
    }
    const lines = [`📋 Open tasks for ${employeeName}:`];
    for (const t of tasks) {
      const job   = t.job_name || t.job_alt_name || '';
      const due   = t.due_date ? ` (due ${String(t.due_date).slice(0, 10)})` : '';
      const label = job ? `${t.title} [${job}]` : t.title;
      lines.push(`• ${label}${due}`);
    }
    res.status(200).type('application/xml; charset=utf-8').send(twiml(lines.join('\n')));
    return true;
  }

  // ── my jobs ──────────────────────────────────────────────────────────────
  if (/^my\s+jobs?\b/i.test(lc)) {
    const jobs = await queryMyJobs(ownerId, employeeName, range).catch(() => []);
    if (!jobs.length) {
      res.status(200).type('application/xml; charset=utf-8').send(
        twiml(`No jobs found for ${employeeName} ${rangeLabel}.`)
      );
      return true;
    }
    const lines = [`🔨 Jobs for ${employeeName} (${rangeLabel}):`];
    for (const j of jobs) {
      const h = Math.round((Number(j.hours) || 0) * 10) / 10;
      lines.push(`• ${j.job_label} — ${h}h`);
    }
    res.status(200).type('application/xml; charset=utf-8').send(twiml(lines.join('\n')));
    return true;
  }

  // ── my hours ─────────────────────────────────────────────────────────────
  const [myHours, teamAvg] = await Promise.all([
    queryMyHours(ownerId, employeeName, range).catch(() => ({})),
    queryTeamAvgHours(ownerId, range).catch(() => ({})),
  ]);

  const myH    = Number(myHours.total_hours  || 0);
  const shifts = Number(myHours.shift_count  || 0);
  const days   = Number(myHours.days_worked  || 0);
  const teamH  = Number(teamAvg.avg_hours    || 0);
  const teamN  = Number(teamAvg.employee_count || 0);

  const lines = [
    `⏱ ${employeeName} — ${rangeLabel}`,
    '',
    `Hours: ${fmtH(myH)}`,
    shifts ? `Shifts: ${shifts} across ${days} day${days !== 1 ? 's' : ''}` : null,
  ].filter(Boolean);

  // Company benchmark — aggregate only, never individual names
  if (teamH > 0 && teamN > 1) {
    const diff    = myH - teamH;
    const pct     = teamH > 0 ? Math.round(Math.abs(diff / teamH) * 100) : 0;
    const aboveBelow = diff > 0.5 ? `${pct}% above` : diff < -0.5 ? `${pct}% below` : 'in line with';
    lines.push('');
    lines.push(`📊 Company avg: ${fmtH(teamH)} (${teamN} team members)`);
    lines.push(`You're ${aboveBelow} the team average ${rangeLabel}.`);
  }

  res.status(200).type('application/xml; charset=utf-8').send(twiml(lines.join('\n')));
  return true;
}

module.exports = { isCrewSelfCommand, handleCrewSelf };
