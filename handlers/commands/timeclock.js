// handlers/commands/timeclock.js
const {
  logTimeEntry,
  generateTimesheet,
  getActiveJob,
} = require('../../services/postgres');

// --- helpers ---------------------------------------------------------------

function titleCase(s = '') {
  return s
    .trim()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function extractJobHint(text = '') {
  // Look for "@ Job Name" OR "on Job Name" near the end
  let m = text.match(/@\s*([^\n\r]+)$/i);
  if (m) return m[1].trim();

  m = text.match(/\bon\s+([A-Za-z0-9].+)$/i);
  if (m) return m[1].trim();

  return null;
}

/**
 * Extract a time from free text.
 * Supports: "8am", "8 am", "8:30am", "830am", "5 pm", "5:05 pm"
 * Returns { date: Date|null, consumed: string, dayOffset: -1|0 }
 */
function extractTime(text = '') {
  let s = text;
  let dayOffset = 0;

  // Normalize "yesterday" / "today"
  if (/\byesterday\b/i.test(s)) {
    dayOffset = -1;
    s = s.replace(/\byesterday\b/ig, '').trim();
  } else if (/\btoday\b/i.test(s)) {
    s = s.replace(/\btoday\b/ig, '').trim();
  }

  // 1) h:mm am/pm (8:30am / 8:30 am)
  let m = s.match(/\b(\d{1,2}):(\d{2})\s*([ap])\.?m\.?\b/i);
  if (m) {
    const hours = parseInt(m[1], 10);
    const minutes = parseInt(m[2], 10);
    const ap = m[3].toLowerCase();
    return { match: m[0], hours, minutes, ap, dayOffset };
  }

  // 2) hhmm am/pm (830am / 0830am)
  m = s.match(/\b(\d{1,2})(\d{2})\s*([ap])\.?m\.?\b/i);
  if (m) {
    const hours = parseInt(m[1], 10);
    const minutes = parseInt(m[2], 10);
    const ap = m[3].toLowerCase();
    return { match: m[0], hours, minutes, ap, dayOffset };
  }

  // 3) h am/pm (8am / 8 am)
  m = s.match(/\b(\d{1,2})\s*([ap])\.?m\.?\b/i);
  if (m) {
    const hours = parseInt(m[1], 10);
    const minutes = 0;
    const ap = m[2].toLowerCase();
    return { match: m[0], hours, minutes, ap, dayOffset };
  }

  return { match: null, hours: null, minutes: null, ap: null, dayOffset };
}

function buildTimestampFromParts(parts) {
  const now = new Date();
  if (parts.dayOffset) {
    now.setDate(now.getDate() + parts.dayOffset);
  }
  if (parts.hours != null && parts.ap) {
    let h = parts.hours % 12;
    if (parts.ap === 'p') h += 12;
    now.setHours(h, parts.minutes || 0, 0, 0);
  }
  return now;
}

function formatTimeForReply(d) {
  try {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  } catch {
    return d.toISOString();
  }
}

/** Parse a timeclock action from text.
 * Returns { name, type, when, jobOverride } or null.
 * type in: punch_in|punch_out|break_start|break_end|lunch_start|lunch_end|drive_start|drive_end
 */
function parseAction(text, fallbackName) {
  const original = String(text || '');
  let s = original.trim();

  // Extract time if present
  const t = extractTime(s);
  if (t.match) {
    s = s.replace(t.match, '').replace(/\bat\b/ig, ' ').trim();
  }
  const when = buildTimestampFromParts(t);

  // Extract job override if present
  const jobOverride = extractJobHint(s);
  if (jobOverride) {
    s = s.replace(/@\s*[^\n\r]+$/i, '').replace(/\bon\s+[A-Za-z0-9].+$/i, '').trim();
  }

  // Normalize verbs & patterns
  // Name-first: "Scott punched in", "Scott punch in", "Scott clocked in/out"
  let m =
    s.match(/^\s*([a-z][\w\s.'-]{1,50}?)\s+(punched|punch|clock(?:ed)?)\s+(in|out)\b/i) ||
    s.match(/^\s*([a-z][\w\s.'-]{1,50}?)\s+(break|lunch|drive)\s+(start|end)\b/i);

  if (m) {
    const candidate = m[1].trim();
    const token2 = m[2].toLowerCase();
    const token3 = m[3].toLowerCase();

    const name = candidate || fallbackName || '';
    let type = null;

    if (/(punched|punch|clock)/i.test(token2)) {
      type = token3 === 'in' ? 'punch_in' : 'punch_out';
    } else {
      const kind = token2; // break|lunch|drive
      const phase = token3; // start|end
      type = `${kind}_${phase}`; // break_start, etc.
    }

    return { name: name || fallbackName || '', type, when, jobOverride };
  }

  // Verb-first: "punched in Scott", "break start Alex"
  m =
    s.match(/\b(punched|punch|clock(?:ed)?)\s+(in|out)\s+([a-z][\w\s.'-]{1,50}?)\b/i) ||
    s.match(/\b(break|lunch|drive)\s+(start|end)\s+([a-z][\w\s.'-]{1,50}?)\b/i);

  if (m) {
    const token1 = m[1].toLowerCase(); // verb or kind
    const token2 = m[2].toLowerCase(); // in/out or start/end
    const candidate = m[3].trim();

    const name = candidate || fallbackName || '';
    let type = null;

    if (/(punched|punch|clock)/i.test(token1)) {
      type = token2 === 'in' ? 'punch_in' : 'punch_out';
    } else {
      const kind = token1; // break|lunch|drive
      const phase = token2; // start|end
      type = `${kind}_${phase}`;
    }

    return { name: name || fallbackName || '', type, when, jobOverride };
  }

  // If we at least find "punched/punch/clock in|out" without a name, use fallbackName.
  m = s.match(/\b(punched|punch|clock(?:ed)?)\s+(in|out)\b/i);
  if (m && fallbackName) {
    const type = m[2].toLowerCase() === 'in' ? 'punch_in' : 'punch_out';
    return { name: fallbackName, type, when, jobOverride };
  }

  return null;
}

// Parse hours query like "Scott hours week", "hours week", "Alex hours day"
function parseHoursQuery(lcInput, fallbackName) {
  if (!/\bhours?\b/i.test(lcInput)) return null;
  if (!/\b(day|week|month)\b/i.test(lcInput)) return null;

  const parts = lcInput.trim().split(/\s+/);
  let period = parts.find(p => /^(day|week|month)$/i.test(p));
  period = period ? period.toLowerCase() : 'week';

  // If the string begins with "hours", use fallbackName; otherwise treat first token as name
  let employeeName = fallbackName || '';
  if (!/^hours?\b/i.test(lcInput)) {
    employeeName = parts[0]; // e.g. "scott"
  }

  return { employeeName: employeeName || fallbackName || '', period };
}

// --- handler ---------------------------------------------------------------

async function handleTimeclock(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  try {
    const lcInput = String(input || '').toLowerCase().trim();

    // 1) Hours query
    const hoursQ = parseHoursQuery(lcInput, (userProfile && userProfile.name) || '');
    if (hoursQ) {
      const employeeName = hoursQ.employeeName || (userProfile && userProfile.name) || '';
      if (!employeeName) {
        const reply = `⚠️ Who for? Try "Scott hours week".`;
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      const period = hoursQ.period || 'week';
      const timesheet = await generateTimesheet(ownerId, employeeName, period, new Date());

      const reply =
        `${titleCase(employeeName)}'s ${period}ly hours (starting ${timesheet.startDate}):\n` +
        `Total Hours: ${timesheet.totalHours}\n` +
        `Drive Hours: ${timesheet.driveHours}`;

      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // 2) Action entry (punch/clock/break/lunch/drive)
    const fallbackName = (userProfile && userProfile.name) || '';
    const parsed = parseAction(input, fallbackName);

    if (!parsed || !parsed.name || !parsed.type) {
      const reply = '⚠️ Invalid time entry. Use: "[Name] punched in at 9am" or "[Name] hours week".';
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    const person = titleCase(parsed.name);
    const when = parsed.when || new Date();

    // Figure out job: explicit override > active job > null
    let jobName = parsed.jobOverride;
    if (!jobName || !jobName.trim()) {
      const activeJob = await getActiveJob(ownerId);
      jobName = activeJob && activeJob !== 'Uncategorized' ? activeJob : null;
    }

    await logTimeEntry(
      ownerId,
      person,
      parsed.type,                  // punch_in, punch_out, break_start, etc.
      when.toISOString(),
      jobName || null
    );

    const verbPretty = parsed.type.replace('_', ' ');
    const whenPretty = formatTimeForReply(when);
    const wherePretty = jobName ? ` on ${jobName}` : '';

    const reply = `✅ ${verbPretty} logged for ${person} at ${whenPretty}${wherePretty}`;
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  } catch (error) {
    console.error(`[ERROR] handleTimeclock failed for ${from}:`, error?.message);
    const reply = '⚠️ Error logging time entry. Please try again.';
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  }
}

module.exports = { handleTimeclock };
