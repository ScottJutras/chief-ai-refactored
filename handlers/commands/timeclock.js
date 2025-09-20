// handlers/commands/timeclock.js
const {
  logTimeEntry,
  generateTimesheet,
  getActiveJob,
} = require('../../services/postgres');

const { zonedTimeToUtc, utcToZonedTime, format } = require('date-fns-tz');

// ✨ NEW: use shared timezone helpers
const { getUserTzFromProfile, suggestTimezone } = require('../../utils/timezones');

// ----- helpers --------------------------------------------------------------

function titleCase(s = '') {
  return String(s)
    .trim()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Prefer explicit @ Job or "on Job" at tail of message. */
function extractJobHint(text = '') {
  let m = text.match(/@\s*([^\n\r]+)$/i);
  if (m) return m[1].trim();
  m = text.match(/\bon\s+([A-Za-z0-9].+)$/i);
  if (m) return m[1].trim();
  return null;
}

/** Normalize frequent typos / variants before parsing. */
function normalizeInput(raw) {
  let lc = String(raw || '').trim().toLowerCase();
  // Fix “clocked our/or” → “clocked out”
  lc = lc.replace(/\bclock(?:ed)?\s+(our|or)\b/g, 'clocked out');
  // Compact spaces
  lc = lc.replace(/\s{2,}/g, ' ').trim();
  return lc;
}

/** Extract a name if it appears before the verb; else fallback to profile name. */
function extractName(lc, userProfile) {
  const verbIdx = lc.search(/\b(clock|clocked|punch|break|lunch|drive|hours)\b/);
  if (verbIdx > 0) {
    const head = lc.slice(0, verbIdx).trim();
    const m = head.match(/^[a-z][a-z.'\- ]{0,40}/i);
    if (m) return titleCase(m[0].trim());
  }
  const m2 = lc.match(/^([a-z][a-z.'\- ]{0,40})\s+(clock|clocked|punch|break|lunch|drive|hours)\b/i);
  if (m2) return titleCase(m2[1].trim());
  return titleCase((userProfile && userProfile.name) || 'Unknown');
}

/** Detect action type. */
function detectAction(lc) {
  const rules = [
    { re: /\b(punch|clock(?:ed)?)\s*in\b/, type: 'punch_in' },
    { re: /\b(punch|clock(?:ed)?)\s*out\b/, type: 'punch_out' },
    { re: /\bbreak\s+start\b/, type: 'break_start' },
    { re: /\bbreak\s+end\b/, type: 'break_end' },
    { re: /\blunch\s+start\b/, type: 'lunch_start' },
    { re: /\blunch\s+end\b/, type: 'lunch_end' },
    { re: /\bdrive\s+start\b/, type: 'drive_start' },
    { re: /\bdrive\s+end\b/, type: 'drive_end' },
  ];
  for (const r of rules) {
    if (r.re.test(lc)) return r.type;
  }
  return null;
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

/** Parse a time from text in the user's timezone; return a UTC Date or null if not present. */
function parseTimeFromText(lc, tz) {
  // Optional day words
  const dayOffset = /\byesterday\b/.test(lc) ? -1 : 0;

  // 1) 8am / 8:15 pm / at 7 pm
  let m = lc.match(/\b(?:at|@)?\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|am|pm)\b/i);
  if (m) {
    let hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    const ampm = m[3].toLowerCase();
    if (ampm.includes('p') && hour !== 12) hour += 12;
    if (ampm.includes('a') && hour === 12) hour = 0;
    return zonedDayTimeToUtc(tz, hour, minute, dayOffset);
  }

  // 2) 730pm (no colon)
  m = lc.match(/\b(?:at|@)?\s*(\d{1,2})(\d{2})\s*(a\.?m\.?|p\.?m\.?|am|pm)\b/i);
  if (m) {
    let hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    const ampm = m[3].toLowerCase();
    if (ampm.includes('p') && hour !== 12) hour += 12;
    if (ampm.includes('a') && hour === 12) hour = 0;
    return zonedDayTimeToUtc(tz, hour, minute, dayOffset);
  }

  // 3) 24h: 19:30
  m = lc.match(/\b(?:at|@)?\s*(\d{1,2}):(\d{2})\b/);
  if (m) {
    const hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return zonedDayTimeToUtc(tz, hour, minute, dayOffset);
    }
  }

  // 4) 'now'
  if (/\bnow\b/.test(lc)) return new Date(); // current UTC
  return null;
}

/** Format a Date for the user’s timezone. */
function fmtInTz(date, tz) {
  try {
    return format(date, 'h:mm a', { timeZone: tz });
  } catch (_) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
  }
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

// ----- TZ resolver (tiny patch) --------------------------------------------

function getUserTz(userProfile) {
  // Prefer util if available
  if (typeof getUserTzFromProfile === 'function') {
    const tz = getUserTzFromProfile(userProfile);
    if (tz) return tz;
  }
  // Fallbacks
  if (userProfile?.timezone) return userProfile.timezone;
  const country = userProfile?.business_country || userProfile?.country || '';
  const region = userProfile?.business_province || userProfile?.province || '';
  return suggestTimezone(country, region) || 'UTC';
}

// ----- main handler ---------------------------------------------------------

async function handleTimeclock(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  try {
    const tz = getUserTz(userProfile);
    const lc = normalizeInput(input);

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
        ? format(new Date(timesheet.startDate), 'MMM d, yyyy', { timeZone: tz })
        : 'N/A';

      const reply =
        `${titleCase(employeeName)}'s ${period}ly hours (starting ${start}):\n` +
        `Total Hours: ${timesheet.totalHours}\n` +
        `Drive Hours: ${timesheet.driveHours}`;

      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // 2) Action entry (punch/clock/break/lunch/drive)
    const action = detectAction(lc);
    if (!action) {
      const reply = '⚠ Invalid time entry. Use: "[Name] punched in at 9am" or "[Name] hours week".';
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    const who = extractName(lc, userProfile);

    // Job: explicit override at tail > active job > null
    const jobOverride = extractJobHint(lc);
    let jobName = jobOverride && jobOverride.trim() ? jobOverride.trim() : null;
    if (!jobName) {
      const activeJob = await getActiveJob(ownerId);
      jobName = activeJob && activeJob !== 'Uncategorized' ? activeJob : null;
    }

    // When: parsed specific time in user's tz → UTC; else now (UTC)
    let whenUtc = parseTimeFromText(lc, tz);
    if (!whenUtc) whenUtc = new Date();

    await logTimeEntry(
      ownerId,
      titleCase(who),
      action,                         // punch_in, punch_out, break_start, etc.
      whenUtc.toISOString(),
      jobName || null
    );

    const humanTime = fmtInTz(whenUtc, tz);
    const actionText = action.replace('_', ' ');
    const reply = `✅ ${actionText} logged for ${titleCase(who)} at ${humanTime}${jobName ? ` on ${jobName}` : ''}`;

    return res.send(`<Response><Message>${reply}</Message></Response>`);
  } catch (error) {
    console.error(`[ERROR] handleTimeclock failed for ${from}:`, error?.message);
    const reply = '⚠️ Error logging time entry. Please try again.';
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  }
}

module.exports = { handleTimeclock };
