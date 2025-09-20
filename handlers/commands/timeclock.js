// handlers/commands/timeclock.js
const {
  logTimeEntry,
  generateTimesheet,
  getActiveJob,
} = require('../../services/postgres');

const { zonedTimeToUtc, utcToZonedTime, formatInTimeZone } = require('date-fns-tz');

// ✨ uses shared timezone helpers
const { getUserTzFromProfile, suggestTimezone } = require('../../utils/timezones');

// ----- helpers --------------------------------------------------------------

function titleCase(s = '') {
  return String(s)
    .trim()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Normalize weird whitespace & Unicode quirks. */
function norm(msg = '') {
  return String(msg)
    .normalize('NFKC')                           // Unicode normalize
    .replace(/[\u00A0\u2007\u202F]/g, ' ')       // NBSPs → normal spaces
    .replace(/\s{2,}/g, ' ')                     // collapse runs
    .trim();
}

/** Prefer explicit @ Job or "on Job" at tail of message. */
function extractJobHint(text = '') {
  let m = text.match(/@\s*([^\n\r]+)$/i);
  if (m) return m[1].trim();
  m = text.match(/\bon\s+([A-Za-z0-9].+)$/i);
  if (m) return m[1].trim();
  return null;
}

/** Legacy lowercasing + a couple of autocorrections (kept for safety). */
function normalizeInput(raw) {
  let lc = String(raw || '').trim().toLowerCase();
  lc = lc.replace(/\bclock(?:ed)?\s+(our|or)\b/g, 'clocked out'); // “clocked our/or”
  lc = lc.replace(/\s{2,}/g, ' ').trim();
  return lc;
}

/** Build a UTC Date for "today(+offset) at HH:MM in tz". */
function zonedDayTimeToUtc(tz, hours, minutes, dayOffset = 0) {
  const now = new Date();
  const zNow = utcToZonedTime(now, tz);
  zNow.setDate(zNow.getDate() + (dayOffset || 0));
  const y = zNow.getFullYear();
  const m = String(zNow.getMonth() + 1).padStart(2, '0');
  const d = String(zNow.getDate()).padStart(2, '0');
  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const localStr = `${y}-${m}-${d} ${hh}:${mm}:00`;
  return zonedTimeToUtc(localStr, tz);
}

/** Parse a time from text in the user's timezone; return a UTC Date or null. */
function parseTimeFromText(lc, tz) {
  const dayOffset = /\byesterday\b/.test(lc) ? -1 : 0;

  // 8am / 8:15 pm / at 7 pm
  let m = lc.match(/\b(?:at|@)?\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|am|pm)\b/i);
  if (m) {
    let hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    const ampm = m[3].toLowerCase();
    if (ampm.includes('p') && hour !== 12) hour += 12;
    if (ampm.includes('a') && hour === 12) hour = 0;
    return zonedDayTimeToUtc(tz, hour, minute, dayOffset);
  }

  // 730pm (no colon)
  m = lc.match(/\b(?:at|@)?\s*(\d{1,2})(\d{2})\s*(a\.?m\.?|p\.?m\.?|am|pm)\b/i);
  if (m) {
    let hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    const ampm = m[3].toLowerCase();
    if (ampm.includes('p') && hour !== 12) hour += 12;
    if (ampm.includes('a') && hour === 12) hour = 0;
    return zonedDayTimeToUtc(tz, hour, minute, dayOffset);
  }

  // 24h: 19:30
  m = lc.match(/\b(?:at|@)?\s*(\d{1,2}):(\d{2})\b/);
  if (m) {
    const hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return zonedDayTimeToUtc(tz, hour, minute, dayOffset);
    }
  }

  // 'now'
  if (/\bnow\b/.test(lc)) return new Date();
  return null;
}

/** Format a Date for the user’s timezone (deterministic). */
function fmtInTz(date, tz) {
  return formatInTimeZone(date, tz, 'h:mm a');
}

/** Hours query like "Scott hours week", "hours week", "Alex hours day" */
function parseHoursQuery(lcInput, fallbackName) {
  if (!/\bhours?\b/i.test(lcInput)) return null;
  if (!/\b(day|week|month)\b/i.test(lcInput)) return null;

  const parts = lcInput.trim().split(/\s+/);
  let period = parts.find(p => /^(day|week|month)$/i.test(p));
  period = period ? period.toLowerCase() : 'week';

  // If begins with "hours", use fallbackName; else treat first token as name
  let employeeName = fallbackName || '';
  if (!/^hours?\b/i.test(lcInput)) {
    employeeName = titleCase(parts[0]); // e.g. "scott" → "Scott"
  }

  return { employeeName: employeeName || fallbackName || '', period };
}

// ----- TZ resolver ----------------------------------------------------------

function getUserTz(userProfile) {
  if (typeof getUserTzFromProfile === 'function') {
    const tz = getUserTzFromProfile(userProfile);
    if (tz) return tz;
  }
  if (userProfile?.timezone) return userProfile.timezone;
  const country = userProfile?.business_country || userProfile?.country || '';
  const region = userProfile?.business_province || userProfile?.province || '';
  return suggestTimezone(country, region) || 'UTC';
}

// ----- tolerant command patterns -------------------------------------------
// Name-first variants, e.g. "Scott punched in at 8am"
const RE_NAME_FIRST = [
  { type: 'punch_in',  re: /^(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)\s+(?:punch(?:ed)?|clock(?:ed)?)\s*in(?:\s*(?:at|@))?\s*(?<time>.+)?$/iu },
  { type: 'punch_out', re: /^(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)\s+(?:punch(?:ed)?|clock(?:ed)?)\s*out(?:\s*(?:at|@))?\s*(?<time>.+)?$/iu },

  { type: 'break_start', re: /^(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)\s+(?:break|lunch)\s*(?:start|in|begin)?(?:\s*(?:at|@))?\s*(?<time>.+)?$/iu },
  { type: 'break_end',   re: /^(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)\s+(?:break|lunch)\s*(?:end|out|finish)?(?:\s*(?:at|@))?\s*(?<time>.+)?$/iu },

  { type: 'drive_start', re: /^(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)\s+drive\s*(?:start|begin)?(?:\s*(?:at|@))?\s*(?<time>.+)?$/iu },
  { type: 'drive_end',   re: /^(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)\s+drive\s*(?:end|stop|finish)?(?:\s*(?:at|@))?\s*(?<time>.+)?$/iu },
];

// Action-first variants, e.g. "punched in at 8am", optional "for Scott"
const RE_ACTION_FIRST = [
  { type: 'punch_in',  re: /^(?:punch(?:ed)?|clock(?:ed)?)\s*in(?:\s*(?:at|@))?\s*(?<time>.+)?(?:\s+for\s+(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*))?$/iu },
  { type: 'punch_out', re: /^(?:punch(?:ed)?|clock(?:ed)?)\s*out(?:\s*(?:at|@))?\s*(?<time>.+)?(?:\s+for\s+(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*))?$/iu },

  { type: 'break_start', re: /^(?:break|lunch)\s*(?:start|in|begin)?(?:\s*(?:at|@))?\s*(?<time>.+)?(?:\s+for\s+(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*))?$/iu },
  { type: 'break_end',   re: /^(?:break|lunch)\s*(?:end|out|finish)?(?:\s*(?:at|@))?\s*(?<time>.+)?(?:\s+for\s+(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*))?$/iu },

  { type: 'drive_start', re: /^drive\s*(?:start|begin)?(?:\s*(?:at|@))?\s*(?<time>.+)?(?:\s+for\s+(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*))?$/iu },
  { type: 'drive_end',   re: /^drive\s*(?:end|stop|finish)?(?:\s*(?:at|@))?\s*(?<time>.+)?(?:\s+for\s+(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*))?$/iu },
];

function dbgMatch(label, m) {
  if (m) console.log(`[timeclock] matched ${label}:`, m.groups || {});
}

// ----- main handler ---------------------------------------------------------

async function handleTimeclock(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  try {
    // Normalize first to handle NBSPs etc.
    const raw = norm(input);
    const lc  = normalizeInput(raw); // keep the legacy lowercasing/cleanup too
    const tz  = getUserTz(userProfile);

    // 1) Hours query
    const hoursQ = parseHoursQuery(lc, (userProfile && userProfile.name) || '');
    if (hoursQ) {
      const employeeName = hoursQ.employeeName || (userProfile && userProfile.name) || '';
      if (!employeeName) {
        const reply = `⚠️ Who for? Try "Scott hours week".`;
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      const period = hoursQ.period || 'week';
      const timesheet = await generateTimesheet(ownerId, employeeName, period, new Date());

      const start = timesheet.startDate
        ? formatInTimeZone(new Date(timesheet.startDate), tz, 'MMM d, yyyy')
        : 'N/A';

      const reply =
        `${titleCase(employeeName)}'s ${period}ly hours (starting ${start}):\n` +
        `Total Hours: ${timesheet.totalHours}\n` +
        `Drive Hours: ${timesheet.driveHours}`;

      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // 2) Action entry (punch/clock/break/lunch/drive) — tolerant patterns
    let match = null;
    let action = null;

    for (const { type, re } of RE_NAME_FIRST) {
      const m = raw.match(re); // use raw to preserve casing for name
      if (m) { match = m; action = type; dbgMatch(type + ':name-first', m); break; }
    }
    if (!match) {
      for (const { type, re } of RE_ACTION_FIRST) {
        const m = raw.match(re);
        if (m) { match = m; action = type; dbgMatch(type + ':action-first', m); break; }
      }
    }

    if (!match || !action) {
      const reply = '⚠ Invalid time entry. Use: "[Name] punched in at 9am" or "[Name] hours week".';
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // Normalize lunch → break for downstream consistency
    if (action === 'lunch_start') action = 'break_start';
    if (action === 'lunch_end')   action = 'break_end';

    // Name: from regex or fallback to profile
    const who = titleCase(match.groups?.name || userProfile?.name || 'Unknown');

    // Job: explicit override at tail > active job > null
    const jobOverride = extractJobHint(raw);
    let jobName = jobOverride && jobOverride.trim() ? jobOverride.trim() : null;
    if (!jobName) {
      const activeJob = await getActiveJob(ownerId);
      jobName = activeJob && activeJob !== 'Uncategorized' ? activeJob : null;
    }

    // When: if a time phrase is present, parse; else parse whole lc (yesterday/now) or fallback to now
    const timePhrase = (match.groups?.time || '').trim();
    let whenUtc = parseTimeFromText(timePhrase ? timePhrase.toLowerCase() : lc, tz);
    if (!whenUtc) whenUtc = new Date(); // current UTC

    await logTimeEntry(
      ownerId,
      who,
      action,                         // punch_in, punch_out, break_start, etc.
      whenUtc.toISOString(),
      jobName || null
    );

    const humanTime = fmtInTz(whenUtc, tz);
    const actionText = action.replace('_', ' ');
    const reply = `✅ ${actionText} logged for ${who} at ${humanTime}${jobName ? ` on ${jobName}` : ''}`;

    return res.send(`<Response><Message>${reply}</Message></Response>`);
  } catch (error) {
    console.error(`[ERROR] handleTimeclock failed for ${from}:`, error?.message);
    const reply = '⚠️ Error logging time entry. Please try again.';
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  }
}

module.exports = { handleTimeclock };
