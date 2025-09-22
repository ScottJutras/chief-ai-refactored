// handlers/commands/timeclock.js
const {
  logTimeEntry,
  generateTimesheet,
  getActiveJob,
  getTimeEntries, // used to anchor end-of-day summaries
} = require('../../services/postgres');

const { zonedTimeToUtc, utcToZonedTime, formatInTimeZone } = require('date-fns-tz');

// uses shared timezone helpers
const { getUserTzFromProfile, suggestTimezone } = require('../../utils/timezones');

// --------------------------------- helpers ----------------------------------

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

// ----------------------------- TZ resolver ---------------------------------

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

// ------------------- tolerant command patterns (single) ---------------------
const NAME = String.raw`(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)`;
const T = String.raw`(?<time>.+)?`;
const AT = String.raw`(?:\s*(?:at|@))?\s*`;

const RE_NAME_FIRST = [
  // punch / clock
  { type: 'punch_in',  re: new RegExp(`^${NAME}\\s+(?:punch(?:ed)?|clock(?:ed)?)\\s*in${AT}${T}$`, 'iu') },
  { type: 'punch_out', re: new RegExp(`^${NAME}\\s+(?:punch(?:ed)?|clock(?:ed)?)\\s*out${AT}${T}$`, 'iu') },

  // break/lunch: traditional + natural
  { type: 'break_start', re: new RegExp(`^${NAME}\\s+(?:break|lunch)\\s*(?:start|in|begin)?${AT}${T}$`, 'iu') },
  { type: 'break_end',   re: new RegExp(`^${NAME}\\s+(?:break|lunch)\\s*(?:end|out|finish)?${AT}${T}$`, 'iu') },
  { type: 'break_start', re: new RegExp(`^${NAME}\\s+(?:took|taking|went|going)\\s+(?:on\\s+)?(?:a\\s+)?(?:break|lunch)${AT}${T}$`, 'iu') },
  { type: 'break_end',   re: new RegExp(`^${NAME}\\s+(?:back\\s+from|finished|ended|done\\s+with)\\s+(?:a\\s+)?(?:break|lunch)${AT}${T}$`, 'iu') },

  // drive
  { type: 'drive_start', re: new RegExp(`^${NAME}\\s+drive\\s*(?:start|begin)?${AT}${T}$`, 'iu') },
  { type: 'drive_end',   re: new RegExp(`^${NAME}\\s+drive\\s*(?:end|stop|finish)?${AT}${T}$`, 'iu') },
];

// Action-first variants, e.g. "punched in at 8am", optional "for Scott"
const FOR_NAME = String.raw`(?:\s+for\s+${NAME})?`;

const RE_ACTION_FIRST = [
  // punch / clock
  { type: 'punch_in',  re: new RegExp(`^(?:punch(?:ed)?|clock(?:ed)?)\\s*in${AT}${T}${FOR_NAME}$`, 'iu') },
  { type: 'punch_out', re: new RegExp(`^(?:punch(?:ed)?|clock(?:ed)?)\\s*out${AT}${T}${FOR_NAME}$`, 'iu') },

  // break/lunch: traditional + natural
  { type: 'break_start', re: new RegExp(`^(?:break|lunch)\\s*(?:start|in|begin)?${AT}${T}${FOR_NAME}$`, 'iu') },
  { type: 'break_end',   re: new RegExp(`^(?:break|lunch)\\s*(?:end|out|finish)?${AT}${T}${FOR_NAME}$`, 'iu') },
  { type: 'break_start', re: new RegExp(`^(?:took|taking|went|going)\\s+(?:on\\s+)?(?:a\\s+)?(?:break|lunch)${AT}${T}${FOR_NAME}$`, 'iu') },
  { type: 'break_end',   re: new RegExp(`^(?:back\\s+from|finished|ended|done\\s+with)\\s+(?:a\\s+)?(?:break|lunch)${AT}${T}${FOR_NAME}$`, 'iu') },

  // drive
  { type: 'drive_start', re: new RegExp(`^drive\\s*(?:start|begin)?${AT}${T}${FOR_NAME}$`, 'iu') },
  { type: 'drive_end',   re: new RegExp(`^drive\\s*(?:end|stop|finish)?${AT}${T}${FOR_NAME}$`, 'iu') },
];

function dbgMatch(label, m) {
  if (m) console.log(`[timeclock] matched ${label}:`, m.groups || {});
}

// ------------------------- batch parsers ------------------------------------

// Utilities
function extractDayOffset(text) {
  return /\byesterday\b/i.test(text) ? -1 : 0; // default today
}

function stripDayWords(text) {
  return text.replace(/\b(today|yesterday)\b/gi, ' ').replace(/\s{2,}/g, ' ').trim();
}

function splitNames(namesStr) {
  // turn "Scott, Joe, Justin" or "Scott, Joe and Justin" into ["Scott","Joe","Justin"]
  const s = namesStr.replace(/\s+and\s+/gi, ',');
  return s.split(',').map(x => titleCase(x.trim())).filter(Boolean);
}

const BATCH_LIMIT = 10;          // safety cap on number of people
const MAX_MINUTES = 240;         // safety cap on duration minutes
const GAP_MINUTES = 5;

function safeMinutes(n) {
  const v = Math.max(1, Math.min(MAX_MINUTES, parseInt(n, 10) || 0));
  return v;
}

async function computeAnchorEnd(ownerId, name, tz, dayOffset) {
  // Prefer the person's punch_out that day; else now (today) or 5:00 PM (yesterday)
  const anchorDate = new Date(); // used only as "day" token in getTimeEntries
  if (dayOffset !== 0) {
    anchorDate.setDate(anchorDate.getDate() + dayOffset);
  }
  try {
    const rows = await getTimeEntries(ownerId, name, 'day', anchorDate);
    const lastOut = [...rows].reverse().find(r => r.type === 'punch_out');
    if (lastOut) return new Date(lastOut.timestamp);
  } catch (_) { /* ignore */ }

  if (dayOffset === 0) {
    return new Date(); // now
  } else {
    // Yesterday 5:00 PM local → UTC
    return zonedDayTimeToUtc(tz, 17, 0, dayOffset);
  }
}

// A) break THEN lunch summary (two durations)
const RE_BATCH_BREAK_THEN_LUNCH = new RegExp(
  String.raw`^(?<names>[\p{L}.'\- ]+(?:\s*,\s*[\p{L}.'\- ]+)*(?:\s*,?\s*and\s+[\p{L}.'\- ]+)?)\s+` +
  String.raw`(?:took|had|did)\s+(?:a\s+)?(?<bmin>\d{1,3})\s*(?:min|mins|minute|minutes)\s+break\s+` +
  String.raw`(?:then\s+(?:a\s+)?)?(?<lmin>\d{1,3})\s*(?:min|mins|minute|minutes)\s+lunch\s*$`,
  'iu'
);

// B) single summary (ONE duration): “… took a 15 minute break|lunch”
const RE_BATCH_SINGLE = new RegExp(
  String.raw`^(?<names>[\p{L}.'\- ]+(?:\s*,\s*[\p{L}.'\- ]+)*(?:\s*,?\s*and\s+[\p{L}.'\- ]+)?)\s+` +
  String.raw`(?:took|had|did)\s+(?:a\s+)?(?<min>\d{1,3})\s*(?:min|mins|minute|minutes)\s+` +
  String.raw`(?<kind>break|lunch)\s*$`,
  'iu'
);

async function handleBatchBreaksOrLunch(raw, tz, ownerId, jobName) {
  // allow "today|yesterday" anywhere
  const dayOffset = extractDayOffset(raw);
  const stripped = stripDayWords(raw);

  // Try “break then lunch”
  let m = stripped.match(RE_BATCH_BREAK_THEN_LUNCH);
  if (m) {
    const names = splitNames(m.groups.names || '').slice(0, BATCH_LIMIT);
    if (!names.length) return { handled: false };

    const bMin = safeMinutes(m.groups.bmin);
    const lMin = safeMinutes(m.groups.lmin);
    let whenAny = null;

    for (const name of names) {
      const endAnchor = await computeAnchorEnd(ownerId, name, tz, dayOffset);

      const gapMs   = GAP_MINUTES * 60 * 1000;
      const lMs     = lMin * 60 * 1000;
      const bMs     = bMin * 60 * 1000;

      const lunchEnd   = new Date(endAnchor.getTime());
      const lunchStart = new Date(lunchEnd.getTime() - lMs);
      const breakEnd   = new Date(lunchStart.getTime() - gapMs);
      const breakStart = new Date(breakEnd.getTime() - bMs);

      await logTimeEntry(ownerId, name, 'break_start', breakStart.toISOString(), jobName || null);
      await logTimeEntry(ownerId, name, 'break_end',   breakEnd.toISOString(),   jobName || null);
      await logTimeEntry(ownerId, name, 'break_start', lunchStart.toISOString(), jobName || null); // lunch
      await logTimeEntry(ownerId, name, 'break_end',   lunchEnd.toISOString(),   jobName || null);

      whenAny ||= lunchEnd;
    }

    return { handled: true, names, bMin, lMin, when: whenAny };
  }

  // Try single: “… took a 15 minute break|lunch”
  m = stripped.match(RE_BATCH_SINGLE);
  if (m) {
    const names = splitNames(m.groups.names || '').slice(0, BATCH_LIMIT);
    if (!names.length) return { handled: false };

    const mins = safeMinutes(m.groups.min);
    const isLunch = (m.groups.kind || '').toLowerCase() === 'lunch';
    let whenAny = null;

    for (const name of names) {
      const endAnchor = await computeAnchorEnd(ownerId, name, tz, dayOffset);
      const durMs = mins * 60 * 1000;

      const end   = new Date(endAnchor.getTime());
      const start = new Date(end.getTime() - durMs);

      await logTimeEntry(ownerId, name, 'break_start', start.toISOString(), jobName || null);
      await logTimeEntry(ownerId, name, 'break_end',   end.toISOString(),   jobName || null);

      whenAny ||= end;
    }

    return { handled: true, names, mins, kind: (isLunch ? 'lunch' : 'break'), when: whenAny };
  }

  return { handled: false };
}

// ------------------------------- main handler -------------------------------

async function handleTimeclock(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  try {
    // Normalize first to handle NBSPs etc.
    const raw = norm(input);
    const lc  = normalizeInput(raw); // keep the legacy lowercasing/cleanup too
    const tz  = getUserTz(userProfile);

    // Job context: explicit tail > active job > null
    const jobOverride = extractJobHint(raw);
    let jobName = jobOverride && jobOverride.trim() ? jobOverride.trim() : null;
    if (!jobName) {
      const activeJob = await getActiveJob(ownerId);
      jobName = activeJob && activeJob !== 'Uncategorized' ? activeJob : null;
    }

    // 0) Batch summaries (supports: “… break then lunch” and single “… break|lunch”)
    const batch = await handleBatchBreaksOrLunch(raw, tz, ownerId, jobName);
    if (batch?.handled) {
      const who = batch.names.join(', ');
      const dayStr = formatInTimeZone(batch.when, tz, 'MMM d');
      if ('bMin' in batch && 'lMin' in batch) {
        const reply = `✅ Logged ${batch.bMin} min break and ${batch.lMin} min lunch for ${who}${jobName ? ` on ${jobName}` : ''} (${dayStr}).`;
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else {
        const reply = `✅ Logged ${batch.mins} min ${batch.kind} for ${who}${jobName ? ` on ${jobName}` : ''} (${dayStr}).`;
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
    }

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

    // 2) Single action entry (punch/clock/break/lunch/drive) — tolerant patterns
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
      const reply = '⚠️ Invalid time entry. Try e.g. "Scott punched in at 9am", "hours week", or "Scott, Joe took a 15 minute break then a 30 minute lunch".';
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // Normalize lunch → break for downstream consistency
    if (action === 'lunch_start') action = 'break_start';
    if (action === 'lunch_end')   action = 'break_end';

    // Name: from regex or fallback to profile
    const who = titleCase(match.groups?.name || userProfile?.name || 'Unknown');

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
