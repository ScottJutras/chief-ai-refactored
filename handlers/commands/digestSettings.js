'use strict';

/**
 * handlers/commands/digestSettings.js
 * Phase 2.6 — Configurable Weekly Digest (Owner-only)
 *
 * Owner commands:
 *   digest settings          → show current day/time config
 *   digest day [day]         → set send day (monday–sunday, default: friday)
 *   digest time [hour]       → set send hour in UTC (e.g. 4pm, 16, 9am)
 *   digest on / digest off   → enable / disable the digest
 *
 * Examples:
 *   "digest day monday"      → sends digest on Mondays
 *   "digest time 9am"        → sends at 09:00 UTC
 *   "digest time 16"         → sends at 16:00 UTC
 *   "digest off"             → pauses digest for this account
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function twiml(text) {
  const t = String(text ?? '').trim();
  if (!t) return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  const e = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${e}</Message></Response>`;
}

// ── Settings keys ─────────────────────────────────────────────────────────────

const KEY_DAY     = 'digest.send_day';   // 0–6 (Sun=0, Mon=1, … Sat=6)
const KEY_HOUR    = 'digest.send_hour';  // 0–23 UTC
const KEY_ENABLED = 'digest.enabled';    // 'true' | 'false'

const DAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const DAY_ABBR  = ['sun','mon','tue','wed','thu','fri','sat'];

// Defaults
const DEFAULT_SEND_DAY  = 5;  // Friday
const DEFAULT_SEND_HOUR = 16; // 4 PM UTC

// ── Parsing helpers ───────────────────────────────────────────────────────────

function parseDay(text) {
  const lc = text.toLowerCase().trim();
  let idx = DAY_NAMES.indexOf(lc);
  if (idx !== -1) return idx;
  idx = DAY_ABBR.indexOf(lc);
  if (idx !== -1) return idx;
  return null;
}

function parseHour(text) {
  const lc = text.toLowerCase().trim();

  // "4pm" / "4 pm"
  const pm = lc.match(/^(\d{1,2})\s*pm$/);
  if (pm) {
    const h = parseInt(pm[1], 10);
    if (h >= 1 && h <= 11) return h + 12;
    if (h === 12) return 12;
  }

  // "4am" / "12am"
  const am = lc.match(/^(\d{1,2})\s*am$/);
  if (am) {
    const h = parseInt(am[1], 10);
    if (h === 12) return 0;
    if (h >= 1 && h <= 11) return h;
  }

  // "16" / "9" / "16:00"
  const plain = lc.match(/^(\d{1,2})(?::00)?$/);
  if (plain) {
    const h = parseInt(plain[1], 10);
    if (h >= 0 && h <= 23) return h;
  }

  return null;
}

function fmtHour(h) {
  if (h === 0)  return '12:00 AM';
  if (h < 12)   return `${h}:00 AM`;
  if (h === 12) return '12:00 PM';
  return `${h - 12}:00 PM`;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function getSetting(ownerId, key) {
  const { rows } = await pool.query(
    `SELECT value FROM public.settings WHERE owner_id = $1 AND key = $2 LIMIT 1`,
    [ownerId, key]
  ).catch(() => ({ rows: [] }));
  return rows[0]?.value ?? null;
}

async function setSetting(ownerId, key, value) {
  await pool.query(
    `INSERT INTO public.settings (owner_id, key, value, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (owner_id, key) DO UPDATE SET value = $3, updated_at = NOW()`,
    [ownerId, key, String(value)]
  );
}

async function getDigestConfig(ownerId) {
  const [dayVal, hourVal, enabledVal] = await Promise.all([
    getSetting(ownerId, KEY_DAY),
    getSetting(ownerId, KEY_HOUR),
    getSetting(ownerId, KEY_ENABLED),
  ]);

  const sendDay    = dayVal  !== null ? parseInt(dayVal,  10) : DEFAULT_SEND_DAY;
  const sendHour   = hourVal !== null ? parseInt(hourVal, 10) : DEFAULT_SEND_HOUR;
  const enabled    = enabledVal !== null ? enabledVal !== 'false' : true;

  return {
    sendDay:  Number.isFinite(sendDay)  ? sendDay  : DEFAULT_SEND_DAY,
    sendHour: Number.isFinite(sendHour) ? sendHour : DEFAULT_SEND_HOUR,
    enabled,
  };
}

// ── Command detection ─────────────────────────────────────────────────────────

function isDigestSettingsCommand(text) {
  const lc = String(text || '').trim().toLowerCase();
  return /^digest\s+(settings?|day|time|on|off|pause|resume)\b/.test(lc);
}

// ── Main handler ──────────────────────────────────────────────────────────────

async function handleDigestSettings(from, text, userProfile, ownerId, ownerProfile, isOwner, res) {
  const lc = String(text || '').trim().toLowerCase();

  if (!isOwner) {
    res.status(200).type('application/xml; charset=utf-8').send(
      twiml("Only the account owner can change digest settings.")
    );
    return true;
  }

  // ── digest off / pause ────────────────────────────────────────────────────
  if (/^digest\s+(off|pause)\b/.test(lc)) {
    await setSetting(ownerId, KEY_ENABLED, 'false');
    res.status(200).type('application/xml; charset=utf-8').send(
      twiml("🔕 Weekly digest paused. Reply \"digest on\" to re-enable.")
    );
    return true;
  }

  // ── digest on / resume ────────────────────────────────────────────────────
  if (/^digest\s+(on|resume)\b/.test(lc)) {
    await setSetting(ownerId, KEY_ENABLED, 'true');
    const cfg = await getDigestConfig(ownerId);
    res.status(200).type('application/xml; charset=utf-8').send(
      twiml(
        `✅ Weekly digest re-enabled.\n` +
        `Sends every ${DAY_NAMES[cfg.sendDay].charAt(0).toUpperCase() + DAY_NAMES[cfg.sendDay].slice(1)} at ${fmtHour(cfg.sendHour)} UTC.`
      )
    );
    return true;
  }

  // ── digest day [day] ──────────────────────────────────────────────────────
  const dayMatch = lc.match(/^digest\s+day\s+(\w+)/);
  if (dayMatch) {
    const dayIdx = parseDay(dayMatch[1]);
    if (dayIdx === null) {
      res.status(200).type('application/xml; charset=utf-8').send(
        twiml(
          `Unrecognised day: "${dayMatch[1]}"\n\n` +
          `Use: monday, tuesday, wednesday, thursday, friday, saturday, sunday`
        )
      );
      return true;
    }
    await setSetting(ownerId, KEY_DAY, String(dayIdx));
    const cfg = await getDigestConfig(ownerId);
    const dayLabel = DAY_NAMES[dayIdx].charAt(0).toUpperCase() + DAY_NAMES[dayIdx].slice(1);
    res.status(200).type('application/xml; charset=utf-8').send(
      twiml(
        `✅ Digest day set to *${dayLabel}*.\n` +
        `Your digest will send every ${dayLabel} at ${fmtHour(cfg.sendHour)} UTC.`
      )
    );
    return true;
  }

  // ── digest time [hour] ────────────────────────────────────────────────────
  const timeMatch = lc.match(/^digest\s+time\s+(.+)/);
  if (timeMatch) {
    const hour = parseHour(timeMatch[1].trim());
    if (hour === null) {
      res.status(200).type('application/xml; charset=utf-8').send(
        twiml(
          `Unrecognised time: "${timeMatch[1].trim()}"\n\n` +
          `Examples: "4pm", "9am", "16", "8"`
        )
      );
      return true;
    }
    await setSetting(ownerId, KEY_HOUR, String(hour));
    const cfg = await getDigestConfig(ownerId);
    const dayLabel = DAY_NAMES[cfg.sendDay].charAt(0).toUpperCase() + DAY_NAMES[cfg.sendDay].slice(1);
    res.status(200).type('application/xml; charset=utf-8').send(
      twiml(
        `✅ Digest time set to *${fmtHour(hour)} UTC*.\n` +
        `Your digest will send every ${dayLabel} at ${fmtHour(hour)} UTC.`
      )
    );
    return true;
  }

  // ── digest settings (show) ────────────────────────────────────────────────
  const cfg = await getDigestConfig(ownerId);
  const dayLabel  = DAY_NAMES[cfg.sendDay].charAt(0).toUpperCase() + DAY_NAMES[cfg.sendDay].slice(1);
  const statusStr = cfg.enabled ? '✅ ON' : '🔕 PAUSED';

  res.status(200).type('application/xml; charset=utf-8').send(
    twiml([
      `📊 *Weekly Digest Settings*`,
      '',
      `Status: ${statusStr}`,
      `Day: ${dayLabel}`,
      `Time: ${fmtHour(cfg.sendHour)} UTC`,
      '',
      'To change:',
      '  "digest day friday"',
      '  "digest time 4pm"',
      '  "digest off" / "digest on"',
    ].join('\n'))
  );
  return true;
}

module.exports = { isDigestSettingsCommand, handleDigestSettings, getDigestConfig };
