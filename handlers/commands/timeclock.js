const {
  logTimeEntry,
  generateTimesheet,
  getActiveJob,
  createTimePrompt,
  getPendingPrompt,
  clearPrompt,
  getOpenShift,
  getOpenBreakSince,
  closeOpenBreakIfAny,
  getTimeEntries,
  exportTimesheetXlsx,
  exportTimesheetPdf,
  createTimeEditRequestTask,
  checkTimeEntryLimit,
  checkActorLimit,
  hasCreatedByColumn,
  getEntriesBetween,
  getCurrentStatus,
  getUserByName,
} = require('../../services/postgres');
const { zonedTimeToUtc, utcToZonedTime, formatInTimeZone } = require('date-fns-tz');
const { getUserTzFromProfile, suggestTimezone } = require('../../utils/timezones');
const { inferIntentFromText } = require('../../utils/intent');

// ---------- Subscription tier limits ----------
const TIME_ENTRY_LIMITS = {
  starter: { maxEntriesPerDay: 50 },
  pro: { maxEntriesPerDay: 200 },
  enterprise: { maxEntriesPerDay: 1000 },
};

// ---------- Small utils ----------
const titleCase = (s = '') =>
  String(s)
    .trim()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

const norm = (msg = '') =>
  String(msg).normalize('NFKC').replace(/[\u00A0\u2007\u202F]/g, ' ').replace(/\s{2,}/g, ' ').trim();

function sanitizeInput(text) {
  return String(text || '').replace(/[<>"'&]/g, '').trim().slice(0, 100);
}

function normalizeInput(raw) {
  let lc = String(raw || '').trim().toLowerCase();
  lc = lc.replace(/\bclock(?:ed)?\s+(our|or)\b/g, 'clocked out');
  return lc.replace(/\s{2,}/g, ' ').trim();
}

// Remove trailing punctuation and filler tokens that accidentally end up in a name capture
function cleanPersonName(input = '') {
  let s = String(input || '').trim();
  // strip trailing punctuation
  s = s.replace(/[.,!?;:]+$/u, '').trim();
  // if someone said "Justin now" or "Justin today please"
  s = s
    .replace(/\b(now|right now|today|pls|please)\b$/iu, '')
    .replace(/\b(now|right now|today|pls|please)\b/giu, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // super defensive: if the *only* second token is "now" after punctuation removal
  s = s.replace(/\s+\bnow\b$/iu, '').trim();
  // final cleanup + TitleCase
  return titleCase(sanitizeInput(s));
}

// --- Future-entry policy (grace window) ---
const MAX_FUTURE_MINUTES = Number(process.env.MAX_FUTURE_MINUTES || 10);
function isTooFarInFuture(ts) {
  const now = Date.now();
  return new Date(ts).getTime() - now > MAX_FUTURE_MINUTES * 60 * 1000;
}
function guardFutureOrExplain(whenUtc, tz, res, subject = 'That time') {
  if (!whenUtc) return false;
  if (isTooFarInFuture(whenUtc)) {
    const msg = `⛔ ${subject} (${fmtInTz(whenUtc, tz)}) is more than ${MAX_FUTURE_MINUTES} minutes in the future. Please send a current or past time (e.g., "10:00am yesterday" or "now").`;
    res.send(twiml(msg));
    return true;
  }
  return false;
}

// ---------- Access control ----------
function normalizeName(s = '') {
  return String(s).trim().toLowerCase();
}

function canActOn(userProfile, isOwner, targetName, ownerProfile) {
  const actorRole = String(userProfile?.role || 'team').toLowerCase();
  const actorName = String(userProfile?.name || '').trim();
  const ownerName = String(ownerProfile?.name || '').trim();
  const targetIsOwner = targetName && normalizeName(targetName) === normalizeName(ownerName);

  if (isOwner) return true;
  if (actorRole === 'board') return !targetIsOwner;
  if (actorRole === 'team') return !targetName || normalizeName(targetName) === normalizeName(actorName);
  if (actorRole === 'accountant') return false;
  return !targetName || normalizeName(targetName) === normalizeName(actorName);
}

function denyActMsg(actorProfile, targetName) {
  const role = String(actorProfile?.role || 'team').toLowerCase();
  const who = titleCase(targetName || '');
  if (role === 'accountant') return `⛔ Accountants can’t log time. Ask the Owner/Board.`;
  if (role === 'team' && who) return `⛔ You can only log your own time (not ${who}).`;
  if (role === 'board' && who) return `⛔ Board members can’t log time for the Owner.`;
  return `⛔ You don’t have permission to log this entry.`;
}

// ---------- Approval gate ----------
function isApproved(userProfile, isOwner) {
  if (isOwner) return true;
  const role = String(userProfile?.role || '').toLowerCase();
  return ['owner', 'board', 'team', 'accountant', 'approved'].includes(role);
}

function approvalBlockMsg(userProfile, ownerProfile) {
  const ownerName = ownerProfile?.name ? titleCase(ownerProfile.name) : 'the Owner';
  return `⛔ You’re not approved yet. I’ve notified ${ownerName} to assign your role. Try again after approval.`;
}

function extractJobHint(text = '') {
  let m = text.match(/@\s*([^\n\r]+)$/i);
  if (m) return sanitizeInput(m[1].trim());
  m = text.match(/\bon\s+([A-Za-z0-9].+)$/i);
  if (m) return sanitizeInput(m[1].trim());
  return null;
}

function parseEmployeeFor(text) {
  const m = text.match(/\bfor\s+([A-Za-z][A-Za-z.'\- ]{0,60})\b/i);
  return m ? titleCase(sanitizeInput(m[1].trim())) : null;
}

// ---------- Time parsing ----------
function zonedDayTimeToUtc(tz, hours, minutes, dayOffset = 0) {
  const now = new Date();
  const zNow = utcToZonedTime(now, tz);
  zNow.setDate(zNow.getDate() + (dayOffset || 0));
  const y = zNow.getFullYear();
  const mo = String(zNow.getMonth() + 1).padStart(2, '0');
  const d = String(zNow.getDate()).padStart(2, '0');
  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  return zonedTimeToUtc(`${y}-${mo}-${d} ${hh}:${mm}:00`, tz);
}

function parseTimeFromText(lc, tz) {
  const dayOffset = /\byesterday\b/.test(lc) ? -1 : 0;

  let m = lc.match(/\b(?:at|@)?\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|am|pm)\b/i);
  if (m) {
    let hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    const ampm = m[3].toLowerCase();
    if (ampm.includes('p') && hour !== 12) hour += 12;
    if (ampm.includes('a') && hour === 12) hour = 0;
    return zonedDayTimeToUtc(tz, hour, minute, dayOffset);
  }

  m = lc.match(/\b(?:at|@)?\s*(\d{1,2})(\d{2})\s*(a\.?m\.?|p\.?m\.?|am|pm)\b/i);
  if (m) {
    let hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    const ampm = m[3].toLowerCase();
    if (ampm.includes('p') && hour !== 12) hour += 12;
    if (ampm.includes('a') && hour === 12) hour = 0;
    return zonedDayTimeToUtc(tz, hour, minute, dayOffset);
  }

  m = lc.match(/\b(?:at|@)?\s*(\d{1,2}):(\d{2})\b/);
  if (m) {
    const hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return zonedDayTimeToUtc(tz, hour, minute, dayOffset);
    }
  }

  if (/\bnow\b/.test(lc)) return new Date();
  return null;
}

function fmtInTz(date, tz) {
  try {
    return formatInTimeZone(date, tz, 'h:mm a');
  } catch {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
  }
}

// ---------- Period query ----------
function parseHoursQuery(lcInput, fallbackName) {
  const s = String(lcInput || '').trim();
  const periodMatch = s.match(/\b(day|week|month)\b/i);
  if (!/\bhours?\b/i.test(s) || !periodMatch) return null;
  const period = periodMatch[1].toLowerCase();

  const nameFromFor = s.match(/\bfor\s+([a-z][a-z.'\-]*(?:\s+[a-z][a-z.'\-]*){0,3})\b/i);
  const nameFromHowMany = s.match(/\bhow\s+many\s+hours\b.*?\b(?:did\s+)?([a-z][a-z.'\-]*(?:\s+[a-z][a-z.'\-]*){0,3})\s+(?:work|do)\b/i);
  const nameBeforeHours = s.match(/^([a-z][a-z.'\-]*(?:\s+[a-z][a-z.'\-]*){0,3})\s+hours?\b/i);
  const nameNearWork = s.match(/\b([a-z][a-z.'\-]*(?:\s+[a-z][a-z.'\-]*){0,3})\s+(?:worked?|work)\b/i);

  let name =
    (nameFromFor && nameFromFor[1]) ||
    (nameFromHowMany && nameFromHowMany[1]) ||
    (nameBeforeHours && nameBeforeHours[1]) ||
    (nameNearWork && nameNearWork[1]) ||
    '';

  const stop = new Set([
    'how', 'what', 'who', 'when', 'where', 'why', 'which',
    'many', 'much', 'did', 'does', 'do', 'the', 'a', 'an',
    'this', 'that', 'my', 'his', 'her', 'their',
  ]);
  name = name.split(/\s+/).filter(w => !stop.has(w)).join(' ').trim();
  if (!name) name = fallbackName || '';
  return { employeeName: titleCase(sanitizeInput(name)), period };
}

// ---------- TZ resolver ----------
function getUserTz(userProfile) {
  if (typeof getUserTzFromProfile === 'function') {
    const tz = getUserTzFromProfile(userProfile);
    if (tz) return tz;
  }
  if (userProfile?.timezone) return userProfile.timezone;
  const country = userProfile?.business_country || userProfile?.country || '';
  const region = userProfile?.business_province || userProfile?.province || '';
  return suggestTimezone(country, region) || 'America/Toronto';
}

// ---------- tolerant command patterns ----------
const RE_ACTION_FIRST = [
  {
    type: 'punch_in',
    re: /^(?:punch(?:ed)?|clock(?:ed)?)\s*in\s*[,:-]?\s*(?<name>(?:(?!\bnow\b)[\p{L}.'-]+)(?:\s+(?:(?!\bnow\b)[\p{L}.'-]+))*)(?:\s*,?\s*(?:now|right\s+now)\b|\s*(?:at|@)\s*(?<time>.+))?$/iu,
  },
  {
    type: 'punch_out',
    re: /^(?:punch(?:ed)?|clock(?:ed)?)\s*out\s*[,:-]?\s*(?<name>(?:(?!\bnow\b)[\p{L}.'-]+)(?:\s+(?:(?!\bnow\b)[\p{L}.'-]+))*)(?:\s*,?\s*(?:now|right\s+now)\b|\s*(?:at|@)\s*(?<time>.+))?$/iu,
  },
  {
    type: 'punch_in',
    re: /^(?:punch(?:ed)?|clock(?:ed)?)\s*in\s+(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)(?:\s*(?:at|@)\s*(?<time>.+))?$/iu,
  },
  {
    type: 'punch_out',
    re: /^(?:punch(?:ed)?|clock(?:ed)?)\s*out\s+(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)(?:\s*(?:at|@)\s*(?<time>.+))?$/iu,
  },
  {
    type: 'punch_in',
    re: /^(?:punch(?:ed)?|clock(?:ed)?)\s*in(?:\s*(?:at|@))?\s*(?<time>.+)?(?:\s+for\s+(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*))?$/iu,
  },
  {
    type: 'punch_out',
    re: /^(?:punch(?:ed)?|clock(?:ed)?)\s*out(?:\s*(?:at|@))?\s*(?<time>.+)?(?:\s+for\s+(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*))?$/iu,
  },
  {
    type: 'punch_out',
    re: /^(?:end|finish|stop)\s+(?:work|shift)(?:\s*(?:at|@))?\s*(?<time>.+)?(?:\s+for\s+(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*))?$/iu,
  },
  {
    type: 'punch_in',
    re: /^(?:start|begin)\s+(?:work|shift)(?:\s*(?:at|@))?\s*(?<time>.+)?(?:\s+for\s+(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*))?$/iu,
  },
  {
    type: 'break_end',
    re: /^(?:break|lunch)\s*(?:end|out|finish)(?:\s*(?:at|@))?\s*(?<time>.+)?(?:\s+for\s+(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*))?$/iu,
  },
  {
    type: 'break_start',
    re: /^(?:break|lunch)(?!\s*(?:end|out|finish)\b)\s*(?:start|in|begin)?(?:\s*(?:at|@))?\s*(?<time>.+)?(?:\s+for\s+(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*))?$/iu,
  },
  {
    type: 'break_start',
    re: /^(?:just\s+)?(?:went\s+on\s+|on\s+|is\s+on\s+)(?:break)(?!\s*(?:end|out|finish)\b)(?:\s*(?:at|@))?\s*(?<time>.+)?(?:\s+for\s+(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*))?$/iu,
  },
  {
    type: 'drive_end',
    re: /^drive\s*(?:end|stop|finish)(?:\s*(?:at|@))?\s*(?<time>.+)?(?:\s+for\s+(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*))?$/iu,
  },
  {
    type: 'drive_start',
    re: /^drive\s*(?:start|begin)?(?:\s*(?:at|@))?\s*(?<time>.+)?(?:\s+for\s+(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*))?$/iu,
  },
];

const RE_NAME_FIRST = [
  {
    type: 'punch_in',
    re: /^(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)\s+(?:punch(?:ed)?|clock(?:ed)?)\s*in(?:\s*(?:at|@))?\s*(?<time>.+)?$/iu,
  },
  {
    type: 'punch_out',
    re: /^(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)\s+(?:punch(?:ed)?|clock(?:ed)?)\s*out(?:\s*(?:at|@))?\s*(?<time>.+)?$/iu,
  },
  {
    type: 'punch_out',
    re: /^(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)\s+(?:work|shift)\s*(?:end|out|finish|stop)(?:\s*(?:at|@))?\s*(?<time>.+)?$/iu,
  },
  {
    type: 'punch_in',
    re: /^(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)\s+(?:work|shift)\s*(?:start|in|begin)(?:\s*(?:at|@))?\s*(?<time>.+)?$/iu,
  },
  {
    type: 'break_end',
    re: /^(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)\s+(?:break|lunch)\s*(?:end|out|finish)(?:\s*(?:at|@))?\s*(?<time>.+)?$/iu,
  },
  {
    type: 'break_start',
    re: /^(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)\s+(?:break|lunch)(?!\s*(?:end|out|finish)\b)\s*(?:start|in|begin)?(?:\s*(?:at|@))?\s*(?<time>.+)?$/iu,
  },
  {
    type: 'break_start',
    re: /^(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)\s+(?:just\s+)?(?:went\s+on\s+|is\s+on\s+|on\s+)break(?!\s*(?:end|out|finish)\b)(?:\s*(?:at|@))?\s*(?<time>.+)?$/iu,
  },
  {
    type: 'drive_end',
    re: /^(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)\s+drive\s*(?:end|stop|finish)(?:\s*(?:at|@))?\s*(?<time>.+)?$/iu,
  },
  {
    type: 'drive_start',
    re: /^(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)\s+drive\s*(?:start|begin)?(?:\s*(?:at|@))?\s*(?<time>.+)?$/iu,
  },
];

const RE_TIME_EDIT =
  /^(?:adjust|fix|edit)\s+(?:last)?\s*(?:punch|clock|break|lunch|drive)\s*(?:in|out|start|end)?\s*(?:by)?\s*([+-]?\d{1,3})\s*(?:min|minutes)\b/i;

function dbgMatch(label, m) {
  if (m) console.log(`[timeclock] matched ${label}:`, m?.groups || {});
}

// ---------- batch helpers ----------
function extractDayOffset(text) {
  return /\byesterday\b/i.test(text) ? -1 : 0;
}
function stripDayWords(text) {
  return text.replace(/\b(today|yesterday)\b/gi, ' ').replace(/\s{2,}/g, ' ').trim();
}
function splitNames(namesStr) {
  const s = namesStr.replace(/\s+and\s+/gi, ',');
  return s.split(',').map(x => titleCase(sanitizeInput(x.trim()))).filter(Boolean);
}

const BATCH_LIMIT = 10,
  MAX_MINUTES = 240,
  GAP_MINUTES = 5;
function safeMinutes(n) {
  return Math.max(1, Math.min(MAX_MINUTES, parseInt(n, 10) || 0));
}

async function computeAnchorEnd(ownerId, name, tz, dayOffset) {
  const anchorDate = new Date();
  if (dayOffset !== 0) anchorDate.setDate(anchorDate.getDate() + dayOffset);
  try {
    const rows = await getTimeEntries(ownerId, name, 'day', anchorDate, tz);
    const lastOut = [...rows].reverse().find(r => r.type === 'punch_out');
    if (lastOut) return new Date(lastOut.timestamp);
  } catch {}
  return dayOffset === 0 ? new Date() : zonedDayTimeToUtc(tz, 17, 0, dayOffset);
}

async function handleBatchBreaksOrLunch(raw, tz, ownerId, jobName, extras, userProfile, isOwner, ownerProfile) {
  const dayOffset = extractDayOffset(raw);
  const stripped = stripDayWords(raw);

  let m = stripped.match(
    /^(?<names>[\p{L}.'\- ]+(?:\s*,\s*[\p{L}.'\- ]+)*(?:\s*,?\s*and\s+[\p{L}.'\- ]+)?)\s+(?:took|had|did)\s+(?:a\s+)? (?<bmin>\d{1,3})\s*(?:min|mins|minute|minutes)\s+break\s+(?:then\s+(?:a\s+)?)?(?<lmin>\d{1,3})\s*(?:min|mins|minute|minutes)\s+lunch\s*$/iu
  );
  if (m) {
    const names = splitNames(m.groups.names || '').slice(0, BATCH_LIMIT);
    if (!names.length) return { handled: false };
    const bMin = safeMinutes(m.groups.bmin);
    const lMin = safeMinutes(m.groups.lmin);
    let whenAny = null;

    for (const name of names) {
      if (!canActOn(userProfile, isOwner, name, ownerProfile)) {
        return { handled: false, error: denyActMsg(userProfile, name) };
      }
      const openShift = await getOpenShift(ownerId, name);
      if (!openShift) return { handled: false, error: `${name} isn’t clocked in. Punch in first.` };

      const endAnchor = await computeAnchorEnd(ownerId, name, tz, dayOffset);
      const gapMs = GAP_MINUTES * 60 * 1000,
        lMs = lMin * 60 * 1000,
        bMs = bMin * 60 * 1000;

      const lunchEnd = new Date(endAnchor.getTime());
      const lunchStart = new Date(lunchEnd.getTime() - lMs);
      const breakEnd = new Date(lunchStart.getTime() - gapMs);
      const breakStart = new Date(breakEnd.getTime() - bMs);

      if (guardFutureOrExplain(lunchEnd, tz, { send: () => {} })) {
        /* no-op in batch pre-check */
      }

      await logTimeEntry(ownerId, name, 'break_start', breakStart.toISOString(), jobName || null, tz, extras);
      await logTimeEntry(ownerId, name, 'break_end', breakEnd.toISOString(), jobName || null, tz, extras);
      await logTimeEntry(ownerId, name, 'break_start', lunchStart.toISOString(), jobName || null, tz, extras);
      await logTimeEntry(ownerId, name, 'break_end', lunchEnd.toISOString(), jobName || null, tz, extras);

      whenAny ||= lunchEnd;
    }
    return { handled: true, names, bMin, lMin, when: whenAny };
  }

  m = stripped.match(
    /^(?<names>[\p{L}.'\- ]+(?:\s*,\s*[\p{L}.'\- ]+)*(?:\s*,?\s*and\s+[\p{L}.'\- ]+)?)\s+(?:took|had|did)\s+(?:a\s+)?(?<min>\d{1,3})\s*(?:min|mins|minute|minutes)\s+(?<kind>break|lunch)\s*$/iu
  );
  if (m) {
    const names = splitNames(m.groups.names || '').slice(0, BATCH_LIMIT);
    if (!names.length) return { handled: false };
    const mins = safeMinutes(m.groups.min);
    let whenAny = null;

    for (const name of names) {
      if (!canActOn(userProfile, isOwner, name, ownerProfile)) {
        return { handled: false, error: denyActMsg(userProfile, name) };
      }
      const openShift = await getOpenShift(ownerId, name);
      if (!openShift) return { handled: false, error: `${name} isn’t clocked in. Punch in first.` };

      const endAnchor = await computeAnchorEnd(ownerId, name, tz, dayOffset);
      const durMs = mins * 60 * 1000;
      const end = new Date(endAnchor.getTime());
      const start = new Date(end.getTime() - durMs);

      if (guardFutureOrExplain(end, tz, { send: () => {} })) {
        /* no-op batch pre-check */
      }

      await logTimeEntry(ownerId, name, 'break_start', start.toISOString(), jobName || null, tz, extras);
      await logTimeEntry(ownerId, name, 'break_end', end.toISOString(), jobName || null, tz, extras);

      whenAny ||= end;
    }
    return { handled: true, names, mins, kind: m.groups.kind, when: whenAny };
  }

  return { handled: false };
}

// ---------- date ranges for exports ----------
const WEEK_STARTS_ON = 1;
function localMidnight(date, tz) {
  const y = date.getFullYear(),
    m = String(date.getMonth() + 1).padStart(2, '0'),
    d = String(date.getDate()).padStart(2, '0');
  return zonedTimeToUtc(`${y}-${m}-${d} 00:00:00`, tz);
}
function localEndOfDay(date, tz) {
  const y = date.getFullYear(),
    m = String(date.getMonth() + 1).padStart(2, '0'),
    d = String(date.getDate()).padStart(2, '0');
  return zonedTimeToUtc(`${y}-${m}-${d} 23:59:59`, tz);
}
function getLocalWeekRange(tz, which = 'current') {
  const nowUtc = new Date();
  const localNow = utcToZonedTime(nowUtc, tz);
  const local = new Date(localNow.getTime());
  local.setHours(0, 0, 0, 0);
  const day = local.getDay();
  const diffToStart = (day - WEEK_STARTS_ON + 7) % 7;
  const startLocal = new Date(local);
  startLocal.setDate(local.getDate() - diffToStart - (which === 'last' ? 7 : 0));
  const endLocal = new Date(startLocal);
  endLocal.setDate(startLocal.getDate() + 6);
  endLocal.setHours(23, 59, 59, 999);
  return { start: localMidnight(startLocal, tz), end: localEndOfDay(endLocal, tz) };
}

const MONTHS = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  sept: 8,
  october: 9,
  november: 10,
  december: 11,
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may2: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

function parseDateRangeFromText(text, tz) {
  const s = String(text || '').toLowerCase();

  if (/\b(last|previous)\s+week\b/.test(s)) return getLocalWeekRange(tz, 'last');
  if (/\bthis\s+week\b/.test(s)) return getLocalWeekRange(tz, 'current');

  let m = s.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})\s*[-–to]+\s*(\d{1,2}),?\s*(\d{4})\b/i
  );
  if (m) {
    const month = MONTHS[m[1].toLowerCase()],
      d1 = +m[2],
      d2 = +m[3],
      y = +m[4];
    const startLocal = new Date(y, month, d1, 0, 0, 0, 0);
    const endLocal = new Date(y, month, d2, 23, 59, 59, 999);
    return { start: localMidnight(startLocal, tz), end: localEndOfDay(endLocal, tz) };
  }
  m = s.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2}),?\s*(\d{4})\s*(?:to|-\s*)\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2}),?\s*(\d{4})\b/i
  );
  if (m) {
    const m1 = MONTHS[m[1].toLowerCase()],
      d1 = +m[2],
      y1 = +m[3];
    const m2 = MONTHS[m[4].toLowerCase()],
      d2 = +m[5],
      y2 = +m[6];
    const startLocal = new Date(y1, m1, d1, 0, 0, 0, 0);
    const endLocal = new Date(y2, m2, d2, 23, 59, 59, 999);
    return { start: localMidnight(startLocal, tz), end: localEndOfDay(endLocal, tz) };
  }
  m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\s*(?:to|-\s*)\s*(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) {
    const startLocal = new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0);
    const endLocal = new Date(+m[4], +m[5] - 1, +m[6], 23, 59, 59, 999);
    return { start: localMidnight(startLocal, tz), end: localEndOfDay(endLocal, tz) };
  }
  return null;
}

// ---------- summary ----------
function summarizeShiftFromEntries(entries, punchInUtcIso, punchOutUtcIso) {
  const startMs = new Date(punchInUtcIso).getTime();
  const endMs = new Date(punchOutUtcIso).getTime();
  const inRange = entries.filter(e => {
    const t = new Date(e.timestamp).getTime();
    return t >= startMs && t <= endMs;
  });
  let breakMinutes = 0;
  let lastBreakStart = null;
  inRange.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  for (const e of inRange) {
    if (e.type === 'break_start' && !lastBreakStart) {
      lastBreakStart = new Date(e.timestamp);
    } else if (e.type === 'break_end' && lastBreakStart) {
      breakMinutes += Math.max(0, (new Date(e.timestamp) - lastBreakStart) / 60000);
      lastBreakStart = null;
    }
  }
  if (lastBreakStart) breakMinutes += Math.max(0, (endMs - lastBreakStart.getTime()) / 60000);
  const shiftHours = Math.max(0, (endMs - startMs) / 3600000);
  return { shiftHours, breakMinutes: Math.round(breakMinutes) };
}

function twiml(text) {
  return `<Response><Message>${text}</Message></Response>`;
}

// ---------- handler ----------
async function handleTimeclock(from, input, userProfile, ownerId, ownerProfile, isOwner, res, extras = {}) {
  try {
    let raw = norm(input);
    raw = raw
      .replace(/\b(clock|punch)\s*(in|out)\s*,\s*/gi, '$1 $2 ')
      .replace(/,\s*(now|today)\b/gi, ' $1');
    let lc = normalizeInput(raw);
    const tz = getUserTz(userProfile);
    const xtras = { ...extras, created_by: from };

    console.log(`[timeclock] input:`, { raw, lc, from });

    // 1) Approval gate
    if (!isApproved(userProfile, isOwner)) {
      try {
        await createTimeEditRequestTask({
          ownerId,
          employeeId: userProfile?.name || from,
          requesterId: from,
          title: `Role approval needed for ${userProfile?.name || from}`,
          body: `Please approve and assign a role for this user before they can log time.`,
          relatedEntryId: null,
        });
      } catch (e) {
        console.warn(`[timeclock] failed to enqueue approval task: ${e?.message}`);
      }
      return res.send(twiml(approvalBlockMsg(userProfile, ownerProfile)));
    }

    // 2) Subscription & actor limits
    const { ok: ownerLimitOk, tierKey, tierLimit } = await checkTimeEntryLimit(
      ownerId,
      userProfile?.subscription_tier || 'starter'
    );
    if (!ownerLimitOk) {
      return res.send(twiml(`⚠️ Time entry limit reached for ${tierKey} tier (${tierLimit}/day). Upgrade or try tomorrow.`));
    }
    const actorOk = await checkActorLimit(ownerId, from);
    if (!actorOk) {
      return res.send(twiml(`⚠️ Daily action limit reached for your account. Try again tomorrow.`));
    }

    // 3) Job context
    const jobOverride = extractJobHint(raw);
    let jobName = jobOverride && jobOverride.trim() ? jobOverride.trim() : null;
    if (!jobName) {
      const activeJob = await getActiveJob(ownerId);
      jobName = activeJob && activeJob !== 'Uncategorized' ? activeJob : null;
    }

    // 4) Interpret “clock out ... for break/lunch” as break start
    if (/\bfor\s+(break|lunch)\b/i.test(raw) && /\b(?:clock(?:ed)?\s*out|punch(?:ed)?\s*out)\b/i.test(raw)) {
      const mNameFirst = raw.match(
        /^(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)\s+.*?\b(?:clock(?:ed)?\s*out|punch(?:ed)?\s*out)\b.*?\bfor\s+(?<kind>break|lunch)\b(?:\s*(?:at|@)\s*(?<time>.+))?$/iu
      );
      const mActionFirst = raw.match(
        /^(?:clock(?:ed)?\s*out|punch(?:ed)?\s*out)\s+(?<name>[\p{L}.'-]+(?:\s+[\p{L}.'-]+)*)\s+.*?\bfor\s+(?<kind>break|lunch)\b(?:\s*(?:at|@)\s*(?<time>.+))?$/iu
      );
      const mFallback = raw.match(/\bfor\s+(?<kind>break|lunch)\b(?:\s*(?:at|@)\s*(?<time>.+))?$/iu);

      const nameHintPresent = /\bfor\s+(break|lunch)\b/i.test(raw);
      const who = cleanPersonName(mNameFirst?.groups?.name || mActionFirst?.groups?.name || (!nameHintPresent ? userProfile?.name : '') || 'Unknown');
      if (who === 'Unknown') {
        return res.send(twiml(`⚠️ Who’s the break for? Try "Justin break start" or "Clock out Justin for lunch".`));
      }

      let whenUtc = parseTimeFromText(
        (mNameFirst?.groups?.time || mActionFirst?.groups?.time || mFallback?.groups?.time || '').toLowerCase(),
        tz
      );
      if (!whenUtc) whenUtc = new Date();

      if (!canActOn(userProfile, isOwner, who, ownerProfile)) {
        return res.send(twiml(denyActMsg(userProfile, who)));
      }
      if (guardFutureOrExplain(whenUtc, tz, res, 'That time')) return;

      const openShift = await getOpenShift(ownerId, who);
      if (!openShift) {
        const msg = `${who} isn’t clocked in. Punch in first (e.g., "${who} punched in at 8am").`;
        return res.send(twiml(msg));
      }
      const existingBreak = await getOpenBreakSince(ownerId, who, openShift.timestamp);
      if (existingBreak) {
        const msg = `${who} already has an open break started at ${fmtInTz(new Date(existingBreak.timestamp), tz)}. End it first (e.g., "${who} break end").`;
        return res.send(twiml(msg));
      }
      await logTimeEntry(ownerId, who, 'break_start', whenUtc.toISOString(), jobName || null, tz, xtras);
      const reply = `✅ Break start logged for ${who} at ${fmtInTz(whenUtc, tz)}${jobName ? ` on ${jobName}` : ''}`;
      return res.send(twiml(reply));
    }

    // 5) Timesheet export
    if (/\btimes?\s*sheet\b/i.test(lc)) {
      const range = parseDateRangeFromText(raw, tz);
      if (!range) {
        const help =
          'Tell me a date range, e.g. "timesheet for September 15-19, 2025", "timesheet 2025-09-15 to 2025-09-19", or "timesheet for last week". Optionally: "for Scott" or "pdf".';
        return res.send(twiml(help));
      }
      const wantsPdf = /\bpdf\b/i.test(lc);
      const employeeOne = parseEmployeeFor(raw);
      const startIso = range.start.toISOString();
      const endIso = range.end.toISOString();
      const exportFn = wantsPdf ? exportTimesheetPdf : exportTimesheetXlsx;
      const { url, filename } = await exportFn({ ownerId, startIso, endIso, employeeName: employeeOne, tz });
      const body = `📄 Timesheet ready (${startIso.slice(0, 10)} → ${endIso.slice(0, 10)}${employeeOne ? ` • ${employeeOne}` : ''}).\n${filename}`;
      return res.send(`<Response><Message><Body>${body}</Body><Media>${url}</Media></Message></Response>`);
    }

    // 6) Pending prompt: need clock-out time
    const pending = await getPendingPrompt(ownerId);
    if (pending && pending.kind === 'need_clock_out_time') {
      const t = parseTimeFromText(lc, tz);
      if (!t) {
        const who = titleCase(pending.employee_name || 'the employee');
        const askedAt = pending.context?.shiftStartUtc ? fmtInTz(new Date(pending.context.shiftStartUtc), tz) : 'earlier';
        const msg = `I still need ${who}’s clock-out time for the last open shift (started ${askedAt}). Reply "5:45pm yesterday" or "4:30".`;
        return res.send(twiml(msg));
      }
      if (guardFutureOrExplain(t, tz, res, 'That time')) return;

      const employeeName = pending.employee_name;
      const shiftStartIso = pending.context?.shiftStartUtc;
      const punchOutUtcIso = t.toISOString();

      if (shiftStartIso) await closeOpenBreakIfAny(ownerId, employeeName, shiftStartIso, punchOutUtcIso, tz);
      await logTimeEntry(ownerId, titleCase(employeeName), 'punch_out', punchOutUtcIso, jobName || null, tz, xtras);
      await clearPrompt(pending.id);

      const windowEntries = await getEntriesBetween(ownerId, employeeName, shiftStartIso || punchOutUtcIso, punchOutUtcIso);
      const { shiftHours, breakMinutes } = summarizeShiftFromEntries(windowEntries, shiftStartIso || punchOutUtcIso, punchOutUtcIso);

      const msg = `✅ Clocked out ${titleCase(employeeName)} at ${fmtInTz(t, tz)}.\nWorked ${shiftHours.toFixed(2)}h including ${breakMinutes}m paid breaks/lunch.`;
      return res.send(twiml(msg));
    }

    // 7) Time edit request
    const editMatch = lc.match(RE_TIME_EDIT);
    if (editMatch) {
      const minutes = parseInt(editMatch[1], 10);
      if (Math.abs(minutes) > 240) {
        return res.send(twiml(`⚠️ Adjustment must be between -240 and +240 minutes.`));
      }
      const employeeName = parseEmployeeFor(raw) || userProfile?.name || 'Unknown';
      if (!canActOn(userProfile, isOwner, employeeName, ownerProfile)) {
        return res.send(twiml(denyActMsg(userProfile, employeeName)));
      }
      const openShift = await getOpenShift(ownerId, employeeName);
      const lastEntry = (await getTimeEntries(ownerId, employeeName, 'day', new Date(), tz)).slice(-1)[0];
      if (!lastEntry && !openShift) {
        return res.send(twiml(`⚠️ No recent time entries found for ${employeeName}. Punch in first.`));
      }
      const task = await createTimeEditRequestTask({
        ownerId,
        employeeId: employeeName,
        requesterId: from,
        title: `Adjust last time entry by ${minutes} minutes for ${employeeName}`,
        body: `Requested adjustment: ${minutes} minutes for ${employeeName}'s last time entry${lastEntry ? ` (${lastEntry.type} at ${fmtInTz(new Date(lastEntry.timestamp), tz)})` : ''}.`,
        relatedEntryId: lastEntry?.id || null,
      });
      return res.send(twiml(`✅ Time edit request created (#${task.id}): Adjust last entry by ${minutes} minutes for ${employeeName}. Owner/Board will review.`));
    }

    // 8) Hours query (fast path)
    const hoursQ = parseHoursQuery(lc, userProfile?.name || '');
    if (hoursQ) {
      const employeeName = hoursQ.employeeName || userProfile?.name || '';
      if (!employeeName) {
        return res.send(twiml(`⚠️ Who for? Try "Scott hours week".`));
      }
      const period = hoursQ.period || 'week';
      const { message } = await generateTimesheet({
        ownerId,
        person: titleCase(employeeName),
        period,
        tz,
        now: new Date(),
      });
      return res.send(twiml(message));
    }

    // 9) Batch summaries
    const batch = await handleBatchBreaksOrLunch(raw, tz, ownerId, jobName, xtras, userProfile, isOwner, ownerProfile);
    if (batch?.handled) {
      const who = batch.names.join(', ');
      const dayStr = formatInTimeZone(new Date(batch.when), tz, 'MMM d');
      const reply =
        'bMin' in batch && 'lMin' in batch
          ? `✅ Logged ${batch.bMin} min break and ${batch.lMin} min lunch for ${who}${jobName ? ` on ${jobName}` : ''} (${dayStr}).`
          : `✅ Logged ${batch.mins} min ${batch.kind} for ${who}${jobName ? ` on ${jobName}` : ''} (${dayStr}).`;
      return res.send(twiml(reply));
    } else if (batch?.error) {
      return res.send(twiml(`⚠️ ${batch.error}`));
    }

    // 10) Single action entry
    let match = null,
      action = null;
    for (const { type, re } of RE_NAME_FIRST) {
      const m = raw.match(re);
      if (m) {
        match = m;
        action = type;
        dbgMatch(`${type}:name-first`, m);
        break;
      }
    }
    if (!match) {
      for (const { type, re } of RE_ACTION_FIRST) {
        const m = raw.match(re);
        if (m) {
          match = m;
          action = type;
          dbgMatch(`${type}:action-first`, m);
          break;
        }
      }
    }

    if (!match || !action) {
      console.log(`[timeclock] no match for input:`, { raw, lc });
      return res.send(twiml('⚠️ Invalid time entry. Try "Scott punched in at 9am", "hours week", or "Scott took a 15 minute break at 4:30pm".'));
    }

    // Safer intent override: only allow related action swaps
    const rawIntent = inferIntentFromText(raw);
    const relatedActions = {
      punch_in: ['punch_out'],
      punch_out: ['punch_in'],
      break_start: ['break_end'],
      break_end: ['break_start'],
      drive_start: ['drive_end'],
      drive_end: ['drive_start'],
    };
    if (rawIntent && rawIntent !== action && relatedActions[action]?.includes(rawIntent)) {
      console.log(`[timeclock] intent override allowed`, { matched: action, override: rawIntent, input: raw });
      action = rawIntent;
    } else if (rawIntent && rawIntent !== action) {
      console.log(`[timeclock] intent override blocked`, { matched: action, proposed: rawIntent, input: raw });
    }

    // Avoid sender fallback if another person is mentioned
    const tokensContainOtherPerson =
      /\bfor\s+[a-z]/i.test(raw) ||
      /\b(?:clock|punch)\s+(?:in|out)\s+[a-z]/i.test(raw) ||
      /^[a-z].*\b(?:clock|punch|work|shift|break|drive)\b/i.test(raw);
    const whoRaw = match.groups?.name || (!tokensContainOtherPerson ? userProfile?.name : '') || 'Unknown';
    const who = cleanPersonName(whoRaw);
    if (who === 'Unknown') {
      return res.send(twiml(`⚠️ Who should I log this for? Try "Clock in Justin" or "Scott break start".`));
    }

    // Disambiguate name with getUserByName
    const resolved = await getUserByName(ownerId, who);
    console.log(`[timeclock] getUserByName result:`, { who, resolved });
    if (!resolved) {
      return res.send(twiml(`⚠️ I couldn’t find "${who}". Try the full name or check if the user is registered.`));
    }

    console.log(`[timeclock] processing for:`, { who, action, time: match.groups?.time });

    if (!canActOn(userProfile, isOwner, who, ownerProfile)) {
      return res.send(twiml(denyActMsg(userProfile, who)));
    }

    const timePhrase = (match.groups?.time || '').trim();
    let whenUtc = parseTimeFromText(timePhrase ? timePhrase.toLowerCase() : lc, tz);
    if (!whenUtc) whenUtc = new Date();
    if (guardFutureOrExplain(whenUtc, tz, res, 'That time')) return;
    const whenIso = whenUtc.toISOString();

    // 11) Guardrails via current status (optional function)
    let status = null;
    try {
      if (typeof getCurrentStatus === 'function') {
        status = await getCurrentStatus(ownerId, who);
      }
    } catch {
      status = null;
    }

    async function ensureOnShift() {
      if (status?.onShift === false) return false;
      const open = await getOpenShift(ownerId, who);
      return !!open;
    }
    async function ensureNoOpenShift() {
      if (status?.onShift === true) return false;
      const open = await getOpenShift(ownerId, who);
      return !open;
    }
    async function getOpenBreak() {
      if (status?.onBreak && status.lastBreakStart) {
        return { timestamp: status.lastBreakStart };
      }
      const open = await getOpenShift(ownerId, who);
      if (!open) return null;
      return getOpenBreakSince(ownerId, who, open.timestamp);
    }

    // 12) Apply action-specific logic
    if (action === 'punch_in') {
      if (!(await ensureNoOpenShift())) {
        const open = await getOpenShift(ownerId, who);
        const openLocal = fmtInTz(new Date(open.timestamp), tz);
        await createTimePrompt(ownerId, who, 'need_clock_out_time', { shiftStartUtc: open.timestamp, tz });
        const msg = `I see you’re trying to clock-in ${who}, but they weren’t clocked out from the last shift (started ${openLocal}). Reply with their clock-out time (e.g., "5:45pm yesterday").`;
        return res.send(twiml(msg));
      }
      await logTimeEntry(ownerId, who, 'punch_in', whenIso, jobName || null, tz, xtras);
      const reply = `✅ Punch in logged for ${who} at ${fmtInTz(whenUtc, tz)}${jobName ? ` on ${jobName}` : ''}`;
      return res.send(twiml(reply));
    }

    if (action === 'punch_out') {
      if (!(await ensureOnShift())) {
        const msg = `${who} isn’t clocked in. Reply "clock in at 8am" to start a shift, or "hours week" to review.`;
        return res.send(twiml(msg));
      }
      const open = await getOpenShift(ownerId, who);
      await closeOpenBreakIfAny(ownerId, who, open.timestamp, whenIso, tz);
      await logTimeEntry(ownerId, who, 'punch_out', whenIso, jobName || null, tz, xtras);

      const windowEntries = await getEntriesBetween(ownerId, who, open.timestamp, whenIso);
      const { shiftHours, breakMinutes } = summarizeShiftFromEntries(windowEntries, open.timestamp, whenIso);

      const reply = `✅ Clocked out ${who} at ${fmtInTz(whenUtc, tz)}.\nWorked ${shiftHours.toFixed(2)}h, including ${breakMinutes}m paid breaks/lunch.`;
      return res.send(twiml(reply));
    }

    const openShift = await getOpenShift(ownerId, who);
    if (!openShift) {
      const msg = `${who} isn’t clocked in. Punch in first (e.g., "${who} punched in at 8am").`;
      return res.send(twiml(msg));
    }

    if (action === 'break_start') {
      const existingBreak = await getOpenBreakSince(ownerId, who, openShift.timestamp);
      if (existingBreak) {
        const msg = `${who} already has an open break started at ${fmtInTz(new Date(existingBreak.timestamp), tz)}. End it first (e.g., "${who} break end").`;
        return res.send(twiml(msg));
      }
      await logTimeEntry(ownerId, who, 'break_start', whenIso, jobName || null, tz, xtras);
      const reply = `✅ Break start logged for ${who} at ${fmtInTz(whenUtc, tz)}${jobName ? ` on ${jobName}` : ''}`;
      return res.send(twiml(reply));
    }

    if (action === 'break_end') {
      const openBreak = await getOpenBreakSince(ownerId, who, openShift.timestamp);
      if (!openBreak) {
        const msg = `I don’t see an open break for ${who}. Start one first (e.g., "${who} break start at 10:15").`;
        return res.send(twiml(msg));
      }
      await logTimeEntry(ownerId, who, 'break_end', whenIso, jobName || null, tz, xtras);
      const reply = `✅ Break end logged for ${who} at ${fmtInTz(whenUtc, tz)}${jobName ? ` on ${jobName}` : ''}`;
      return res.send(twiml(reply));
    }

    await logTimeEntry(ownerId, who, action, whenIso, jobName || null, tz, xtras);
    const reply = `✅ ${action.replace('_', ' ')} logged for ${who} at ${fmtInTz(whenUtc, tz)}${jobName ? ` on ${jobName}` : ''}`;
    return res.send(twiml(reply));
  } catch (error) {
    console.error(`[ERROR] handleTimeclock failed for ${from}: ${error?.message}`);
    const reply = `⚠️ Error logging time entry. Please try again.`;
    return res.send(twiml(reply));
  }
}

module.exports = { handleTimeclock };