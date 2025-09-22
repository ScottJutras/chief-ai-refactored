// handlers/commands/timeclock.js
const {
  logTimeEntry,
  generateTimesheet,
  getActiveJob,
  // new helpers:
  createTimePrompt,
  getPendingPrompt,
  clearPrompt,
  getOpenShift,
  getOpenBreakSince,
  closeOpenBreakIfAny,
} = require('../../services/postgres');

const { zonedTimeToUtc, utcToZonedTime, format } = require('date-fns-tz');
// shared tz helpers
const { getUserTzFromProfile, suggestTimezone } = require('../../utils/timezones');

// ---------- small utils ----------
const titleCase = (s='') => String(s).trim().split(/\s+/).map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' ');
const norm = (msg='') => String(msg)
  .normalize('NFKC')
  .replace(/[\u00A0\u2007\u202F]/g, ' ')
  .replace(/\s{2,}/g, ' ')
  .trim();

function normalizeInput(raw) {
  let lc = String(raw || '').trim().toLowerCase();
  lc = lc.replace(/\bclock(?:ed)?\s+(our|or)\b/g, 'clocked out'); // common autocorrect
  return lc.replace(/\s{2,}/g, ' ').trim();
}

function extractJobHint(text = '') {
  let m = text.match(/@\s*([^\n\r]+)$/i);
  if (m) return m[1].trim();
  m = text.match(/\bon\s+([A-Za-z0-9].+)$/i);
  if (m) return m[1].trim();
  return null;
}

// ---------- time parsing ----------
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
    if (hour>=0 && hour<=23 && minute>=0 && minute<=59) {
      return zonedDayTimeToUtc(tz, hour, minute, dayOffset);
    }
  }

  // 'now'
  if (/\bnow\b/.test(lc)) return new Date();
  return null;
}

function fmtInTz(date, tz) {
  try {
    return format(date, 'h:mm a', { timeZone: tz });
  } catch (_) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
  }
}

// ---------- period query ----------
function parseHoursQuery(lcInput, fallbackName) {
  if (!/\bhours?\b/i.test(lcInput)) return null;
  if (!/\b(day|week|month)\b/i.test(lcInput)) return null;
  const parts = lcInput.trim().split(/\s+/);
  let period = parts.find(p => /^(day|week|month)$/i.test(p));
  period = period ? period.toLowerCase() : 'week';
  let employeeName = fallbackName || '';
  if (!/^hours?\b/i.test(lcInput)) {
    employeeName = titleCase(parts[0]); // e.g. "scott" → "Scott"
  }
  return { employeeName: employeeName || fallbackName || '', period };
}

// ---------- tz resolver ----------
function getUserTz(userProfile) {
  if (typeof getUserTzFromProfile === 'function') {
    const tz = getUserTzFromProfile(userProfile);
    if (tz) return tz;
  }
  if (userProfile?.timezone) return userProfile.timezone;
  const country = userProfile?.business_country || userProfile?.country || '';
  const region  = userProfile?.business_province || userProfile?.province || '';
  return suggestTimezone(country, region) || 'America/Toronto';
}

// ---------- tolerant command patterns ----------
// Name-first, strict verbs (prevents “Scott Took A” being swallowed into the name)
const RE_NAME_FIRST = [
  { type: 'punch_in',  re: /^(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)\s+(?:punch(?:ed)?|clock(?:ed)?)\s*in(?:\s*(?:at|@))?\s*(?<time>.+)?$/iu },
  { type: 'punch_out', re: /^(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)\s+(?:punch(?:ed)?|clock(?:ed)?)\s*out(?:\s*(?:at|@))?\s*(?<time>.+)?$/iu },

  // “Scott break start at … / lunch start …”
  { type: 'break_start', re: /^(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)\s+(?:break|lunch)\s*(?:start|in|begin)?(?:\s*(?:at|@))?\s*(?<time>.+)?$/iu },
  { type: 'break_end',   re: /^(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)\s+(?:break|lunch)\s*(?:end|out|finish)?(?:\s*(?:at|@))?\s*(?<time>.+)?$/iu },

  // Natural: “Scott took a 15 minute break/lunch at 4:30pm”
  { type: 'break_start', re: /^(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)\s+took\s+(?:a|an)?\s*(?<dur>\d+\s*(?:min(?:ute)?s?)?)?\s*(?:break|lunch)(?:\s*(?:at|@)\s*(?<time>.+))?$/iu },

  // drive
  { type: 'drive_start', re: /^(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)\s+drive\s*(?:start|begin)?(?:\s*(?:at|@))?\s*(?<time>.+)?$/iu },
  { type: 'drive_end',   re: /^(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)\s+drive\s*(?:end|stop|finish)?(?:\s*(?:at|@))?\s*(?<time>.+)?$/iu },
];

// Action-first, optional “for Name”
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

// ---------- batch parsers ----------
// Utilities
function extractDayOffset(text) {
  return /\byesterday\b/i.test(text) ? -1 : 0; // default today
}
function stripDayWords(text) {
  return text.replace(/\b(today|yesterday)\b/gi, ' ').replace(/\s{2,}/g, ' ').trim();
}
function splitNames(namesStr) {
  const s = namesStr.replace(/\s+and\s+/gi, ',');
  return s.split(',').map(x => titleCase(x.trim())).filter(Boolean);
}

const BATCH_LIMIT = 10;
const MAX_MINUTES = 240;
const GAP_MINUTES = 5;
function safeMinutes(n) {
  const v = Math.max(1, Math.min(MAX_MINUTES, parseInt(n, 10) || 0));
  return v;
}

async function computeAnchorEnd(ownerId, name, tz, dayOffset) {
  // Prefer the person's punch_out that day; else now (today) or 5:00 PM (yesterday)
  const anchorDate = new Date();
  if (dayOffset !== 0) {
    anchorDate.setDate(anchorDate.getDate() + dayOffset);
  }
  try {
    const rows = await getTimeEntries(ownerId, name, 'day', anchorDate);
    const lastOut = [...rows].reverse().find(r => r.type === 'punch_out');
    if (lastOut) return new Date(lastOut.timestamp);
  } catch (_) {}
  return dayOffset === 0 ? new Date() : zonedDayTimeToUtc(tz, 17, 0, dayOffset);
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
      const openShift = await getOpenShift(ownerId, name);
      if (!openShift) return { handled: false, error: `${name} isn’t clocked in. Punch in first.` };

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
      const openShift = await getOpenShift(ownerId, name);
      if (!openShift) return { handled: false, error: `${name} isn’t clocked in. Punch in first.` };

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

// ---------- summary (for punch_out confirmation) ----------
function summarizeShiftFromEntries(entries, punchInUtcIso, punchOutUtcIso) {
  // filter within [punchIn, punchOut]
  const startMs = new Date(punchInUtcIso).getTime();
  const endMs   = new Date(punchOutUtcIso).getTime();
  const inRange = entries.filter(e => {
    const t = new Date(e.timestamp).getTime();
    return t >= startMs && t <= endMs;
  });

  let breakMinutes = 0;
  let lastBreakStart = null;

  // order by time just in case
  inRange.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  for (const e of inRange) {
    if (e.type === 'break_start' && !lastBreakStart) {
      lastBreakStart = new Date(e.timestamp);
    } else if (e.type === 'break_end' && lastBreakStart) {
      breakMinutes += Math.max(0, (new Date(e.timestamp) - lastBreakStart) / 60000);
      lastBreakStart = null;
    }
  }
  // if a break is still open at punch-out, count it up to punch-out
  if (lastBreakStart) {
    breakMinutes += Math.max(0, (endMs - lastBreakStart.getTime()) / 60000);
  }

  const shiftHours = Math.max(0, (endMs - startMs) / 3600000);
  return { shiftHours, breakMinutes: Math.round(breakMinutes) };
}

// ---------- handler ----------
async function handleTimeclock(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  try {
    // Normalize early
    const raw = norm(input);
    const lc  = normalizeInput(raw);
    const tz  = getUserTz(userProfile);

    // Job context: explicit tail > active job > null
    const jobOverride = extractJobHint(raw);
    let jobName = jobOverride && jobOverride.trim() ? jobOverride.trim() : null;
    if (!jobName) {
      const activeJob = await getActiveJob(ownerId);
      jobName = activeJob && activeJob !== 'Uncategorized' ? activeJob : null;
    }

    // 0) Pending prompt flow: if we previously asked for a missing clock-out time
    const pending = await getPendingPrompt(ownerId);
    if (pending && pending.kind === 'need_clock_out_time') {
      const t = parseTimeFromText(lc, tz);
      if (!t) {
        const who = titleCase(pending.employee_name || 'the employee');
        const askedAt = pending.context?.shiftStartUtc
          ? fmtInTz(new Date(pending.context.shiftStartUtc), tz)
          : 'earlier';
        const msg = `I still need ${who}’s clock-out time for the last open shift (started ${askedAt}). Reply with a time like "5:45pm yesterday" or "4:30".`;
        return res.send(`<Response><Message>${msg}</Message></Response>`);
      }

      const employeeName = pending.employee_name;
      const shiftStartUtcIso = pending.context?.shiftStartUtc;
      const punchOutUtcIso   = t.toISOString();

      // Close any open break up to the provided punch-out time
      if (shiftStartUtcIso) {
        await closeOpenBreakIfAny(ownerId, employeeName, shiftStartUtcIso, punchOutUtcIso);
      }

      await logTimeEntry(ownerId, titleCase(employeeName), 'punch_out', punchOutUtcIso, jobName || null);
      await clearPrompt(pending.id);

      const timesheet = await generateTimesheet(ownerId, employeeName, 'day', t);
      const dayKey = t.toISOString().split('T')[0];
      const entriesForDay = timesheet.entriesByDay?.[dayKey] || [];
      const { shiftHours, breakMinutes } = summarizeShiftFromEntries(
        entriesForDay,
        shiftStartUtcIso || punchOutUtcIso,
        punchOutUtcIso
      );

      const msg = `✅ Clocked out ${titleCase(employeeName)} at ${fmtInTz(t, tz)}.\nWorked ${shiftHours.toFixed(2)}h including ${breakMinutes}m paid breaks/lunch.`;
      return res.send(`<Response><Message>${msg}</Message></Response>`);
    }

    // 1) Hours query
    const hoursQ = parseHoursQuery(lc, userProfile?.name || '');
    if (hoursQ) {
      const employeeName = hoursQ.employeeName || userProfile?.name || '';
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
        `Total Hours: ${timesheet.totalHours.toFixed(2)}\n` +
        `Drive Hours: ${timesheet.driveHours.toFixed(2)}`;

      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // 2) Batch summaries (supports: “… break then lunch” and single “… break|lunch”)
    const batch = await handleBatchBreaksOrLunch(raw, tz, ownerId, jobName);
    if (batch?.handled) {
      const who = batch.names.join(', ');
      const dayStr = format(new Date(batch.when), 'MMM d', { timeZone: tz });
      if ('bMin' in batch && 'lMin' in batch) {
        const reply = `✅ Logged ${batch.bMin} min break and ${batch.lMin} min lunch for ${who}${jobName ? ` on ${jobName}` : ''} (${dayStr}).`;
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else {
        const reply = `✅ Logged ${batch.mins} min ${batch.kind} for ${who}${jobName ? ` on ${jobName}` : ''} (${dayStr}).`;
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
    } else if (batch?.error) {
      return res.send(`<Response><Message>⚠️ ${batch.error}</Message></Response>`);
    }

    // 3) Single action entry — tolerant patterns (incl. "took a ... break/lunch")
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
      const reply = '⚠️ Invalid time entry. Try e.g. "Scott punched in at 9am", "hours week", or "Scott took a 15 minute break at 4:30pm".';
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    const who = titleCase(match.groups?.name || userProfile?.name || 'Unknown');

    // When: prefer captured time fragment if present; else full lc (handles 'yesterday'/'now'); else now
    const timePhrase = (match.groups?.time || '').trim();
    let whenUtc = parseTimeFromText(timePhrase ? timePhrase.toLowerCase() : lc, tz);
    if (!whenUtc) whenUtc = new Date(); // current UTC
    const whenIso = whenUtc.toISOString();

    // --- state rules ---
    if (action === 'punch_in') {
      const open = await getOpenShift(ownerId, who);
      if (open) {
        const openLocal = fmtInTz(new Date(open.timestamp), tz);
        await createTimePrompt(ownerId, who, 'need_clock_out_time', {
          shiftStartUtc: open.timestamp,
          tz,
        });
        const msg =
          `I see you’re trying to clock-in ${who}, but they weren’t clocked out from the last shift (started ${openLocal}). ` +
          `Reply with their clock-out time (e.g., "5:45pm yesterday").`;
        return res.send(`<Response><Message>${msg}</Message></Response>`);
      }
      await logTimeEntry(ownerId, who, 'punch_in', whenIso, jobName || null);
      const reply = `✅ Punch in logged for ${who} at ${fmtInTz(whenUtc, tz)}${jobName ? ` on ${jobName}` : ''}`;
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    if (action === 'punch_out') {
      const open = await getOpenShift(ownerId, who);
      if (!open) {
        const msg = `${who} isn’t clocked in. Reply "clock in at 8am" to start a shift, or "hours week" to review.`;
        return res.send(`<Response><Message>${msg}</Message></Response>`);
      }

      // close any open break up to this punch-out
      await closeOpenBreakIfAny(ownerId, who, open.timestamp, whenIso);
      await logTimeEntry(ownerId, who, 'punch_out', whenIso, jobName || null);

      // same-day summary
      const timesheet = await generateTimesheet(ownerId, who, 'day', whenUtc);
      const entriesForDay = timesheet.entriesByDay?.[whenIso.split('T')[0]] || [];
      const { shiftHours, breakMinutes } = summarizeShiftFromEntries(entriesForDay, open.timestamp, whenIso);

      const reply =
        `✅ Clocked out ${who} at ${fmtInTz(whenUtc, tz)}.\n` +
        `Worked ${shiftHours.toFixed(2)}h, including ${breakMinutes}m paid breaks/lunch.`;
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // Breaks must happen inside an open shift
    const openShift = await getOpenShift(ownerId, who);
    if (!openShift) {
      const msg = `${who} isn’t clocked in. Punch in first (e.g., "${who} punched in at 8am").`;
      return res.send(`<Response><Message>${msg}</Message></Response>`);
    }

    if (action === 'break_start') {
      const existingBreak = await getOpenBreakSince(ownerId, who, openShift.timestamp);
      if (existingBreak) {
        const msg = `${who} already has an open break started at ${fmtInTz(new Date(existingBreak.timestamp), tz)}. End it first (e.g., "${who} break end").`;
        return res.send(`<Response><Message>${msg}</Message></Response>`);
      }
      await logTimeEntry(ownerId, who, 'break_start', whenIso, jobName || null);
      const reply = `✅ Break start logged for ${who} at ${fmtInTz(whenUtc, tz)}${jobName ? ` on ${jobName}` : ''}`;
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    if (action === 'break_end') {
      const openBreak = await getOpenBreakSince(ownerId, who, openShift.timestamp);
      if (!openBreak) {
        const msg = `I don’t see an open break for ${who}. Start one first (e.g., "${who} break start at 10:15").`;
        return res.send(`<Response><Message>${msg}</Message></Response>`);
      }
      await logTimeEntry(ownerId, who, 'break_end', whenIso, jobName || null);
      const reply = `✅ Break end logged for ${who} at ${fmtInTz(whenUtc, tz)}${jobName ? ` on ${jobName}` : ''}`;
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // (drive_* just pass through)
    await logTimeEntry(ownerId, who, action, whenIso, jobName || null);
    const reply = `✅ ${action.replace('_',' ')} logged for ${who} at ${fmtInTz(whenUtc, tz)}${jobName ? ` on ${jobName}` : ''}`;
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  } catch (error) {
    console.error(`[ERROR] handleTimeclock failed for ${from}:`, error?.message);
    const reply = '⚠️ Error logging time entry. Please try again.';
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  }
}

module.exports = { handleTimeclock };
