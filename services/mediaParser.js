// services/mediaParser.js
// Robust media text parser for time entries, expenses, revenue, and hours inquiries.

function clean(s) { return String(s || '').trim(); }
function titleCase(s) {
  return String(s || '')
    .split(/\s+/)
    .map(w => (w ? w[0].toUpperCase() + w.slice(1) : ''))
    .join(' ')
    .trim();
}
function sanitizeName(s) {
  return String(s || '').replace(/[^\p{L}\p{N}\s.'-]/gu, '').replace(/\s+/g, ' ').trim();
}
function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build a timestamp from an extracted clock string, else now (UTC ISO).
function buildTimestampFromText(clockText) {
  if (!clockText) return new Date().toISOString();

  const t = String(clockText).toLowerCase().trim();
  if (t === 'now' || t === 'right now') return new Date().toISOString();

  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return new Date().toISOString();

  let hour = parseInt(m[1], 10);
  let min = m[2] ? parseInt(m[2], 10) : 0;
  const mer = m[3] ? m[3].toLowerCase() : null;

  if (mer === 'am') {
    if (hour === 12) hour = 0;
  } else if (mer === 'pm') {
    if (hour !== 12) hour += 12;
  }
  const now = new Date();
  const dt = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    Math.min(Math.max(hour, 0), 23),
    Math.min(Math.max(min, 0), 59),
    0,
    0
  );
  return dt.toISOString();
}

function extractTimePhrase(text) {
  const s = String(text || '').toLowerCase();

  // explicit "at TIME"
  let m = s.match(/\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
  if (m) return m[1];

  // bare "now" anywhere
  m = s.match(/\bnow\b/i);
  if (m) return 'now';

  return null;
}

// ---------------- Time-entry parsing ----------------
function tryParseTimeEntry(rawText) {
  let originalStr = clean(rawText);
  if (!originalStr) return null;

  // Pull a time phrase out of the *original* first, then strip it from a working copy
  const timeWordRaw = extractTimePhrase(originalStr); // e.g., "now", "8", "8am", "8:15 pm"
  let working = originalStr;

  if (timeWordRaw) {
    // remove "now" or "at HH(:MM) am/pm" once, case-insensitive
    const timeEsc = escapeRegExp(timeWordRaw);
    // Try "at TIME" first, then bare TIME, to avoid deleting a name chunk accidentally
    const atRe = new RegExp(`\\bat\\s+${timeEsc}\\b`, 'i');
    const bareRe = new RegExp(`\\b${timeEsc}\\b`, 'i');
    if (atRe.test(working)) {
      working = working.replace(atRe, ' ');
    } else if (bareRe.test(working)) {
      working = working.replace(bareRe, ' ');
    }
    working = working.replace(/\s+/g, ' ').trim();
  }

  // Normalize punctuation & whitespace for matching
  const s = working
    .replace(/[.,!?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const actionMap = {
    'punch in': 'punch_in',
    'clock in': 'punch_in',
    'punched in': 'punch_in',
    'clocked in': 'punch_in',

    'punch out': 'punch_out',
    'clock out': 'punch_out',
    'punched out': 'punch_out',
    'clocked out': 'punch_out',

    'break start': 'break_start',
    'break begin': 'break_start',
    'break in': 'break_start',

    'break end': 'break_end',
    'break out': 'break_end',
    'break finish': 'break_end',

    'lunch start': 'break_start',
    'lunch begin': 'break_start',
    'lunch in': 'break_start',

    'lunch end': 'break_end',
    'lunch out': 'break_end',
    'lunch finish': 'break_end',

    'drive start': 'drive_start',
    'drive begin': 'drive_start',
    'drive in': 'drive_start',

    'drive end': 'drive_end',
    'drive stop': 'drive_end',
    'drive finish': 'drive_end',
    'drive out': 'drive_end',
  };

  function makeResult(name, verbKey) {
    if (!verbKey) return null;
    const type = actionMap[verbKey];
    if (!type) return null;
    const ts = buildTimestampFromText(timeWordRaw);
    return {
      type: 'time_entry',
      data: {
        employeeName: name ? titleCase(sanitizeName(name)) : null,
        type,
        timestamp: ts,
        implicitNow: !timeWordRaw || String(timeWordRaw).toLowerCase() === 'now'
      }
    };
  }

  // (0) Nameless action "punch/clock in/out"
  let m = s.match(/\b(?:punch(?:ed)?|clock(?:ed)?)\s+(in|out)\b/iu);
  if (m) return makeResult(null, `punch ${m[1].toLowerCase()}`);

  // (1) Action-first "punch/clock in/out [for] NAME"
  m = s.match(/\b(?:punch(?:ed)?|clock(?:ed)?)\s+(in|out)\b(?:\s*for\b)?\s+([a-z][\w\s.'-]{1,50})\b/iu);
  if (m) return makeResult(m[2], `punch ${m[1].toLowerCase()}`);

  // (1a) Sandwich "punch/clock NAME in/out"  ← handles “Clock Justin in (now)”
  m = s.match(/\b(?:punch|clock)\s+([a-z][\w\s.'-]{1,50})\s+(in|out)\b/iu);
  if (m) return makeResult(m[1], `punch ${m[2].toLowerCase()}`);

  // (2) Name-first "NAME punched/clocked in/out"
  m = s.match(/^([a-z][\w\s.'-]{1,50})\s+(?:punched|clocked|punch|clock)\s+(in|out)\b/iu);
  if (m) return makeResult(m[1], `punch ${m[2].toLowerCase()}`);

  // (3) Break/Lunch/Drive action-first "(break|lunch|drive) (start|…|end) [for] NAME"
  m = s.match(/\b(break|lunch|drive)\s+(start|begin|in|end|out|finish)\b(?:\s*for\b)?\s+([a-z][\w\s.'-]{1,50})\b/iu);
  if (m) return makeResult(m[3], `${m[1].toLowerCase()} ${m[2].toLowerCase()}`);

  // (3-nameless) Break/Lunch/Drive action-first without name
  m = s.match(/\b(break|lunch|drive)\s+(start|begin|in|end|out|finish)\b/iu);
  if (m) return makeResult(null, `${m[1].toLowerCase()} ${m[2].toLowerCase()}`);

  // (3a) Verb-first "(start|begin|end|finish|stop|in|out) (break|lunch|drive) [for] NAME"
  m = s.match(/\b(start|begin|end|finish|stop|in|out)\s+(break|lunch|drive)\b(?:\s*for\b)?\s+([a-z][\w\s.'-]{1,50})\b/iu);
  if (m) {
    const dir = m[1].toLowerCase();
    const obj = m[2].toLowerCase();
    const dirKey = (dir === 'in' ? 'start' : (dir === 'out' ? 'end' : dir));
    return makeResult(m[3], `${obj} ${dirKey}`);
  }

  // (3a-nameless) Verb-first without name
  m = s.match(/\b(start|begin|end|finish|stop|in|out)\s+(break|lunch|drive)\b/iu);
  if (m) {
    const dir = m[1].toLowerCase();
    const obj = m[2].toLowerCase();
    const dirKey = (dir === 'in' ? 'start' : (dir === 'out' ? 'end' : dir));
    return makeResult(null, `${obj} ${dirKey}`);
  }

  // (4) Name-first "NAME break/lunch/drive start/end"
  m = s.match(/^([a-z][\w\s.'-]{1,50})\s+(break|lunch|drive)\s+(start|begin|in|end|out|finish)\b/iu);
  if (m) return makeResult(m[1], `${m[2].toLowerCase()} ${m[3].toLowerCase()}`);

  // (5) Imperative with commas "clock in, justin"
  m = s.match(/\b(?:punch|clock)\s+in\b[^a-z0-9]+([a-z][\w\s.'-]{1,50})\b/iu);
  if (m) return makeResult(m[1], 'punch in');
  m = s.match(/\b(?:punch|clock)\s+out\b[^a-z0-9]+([a-z][\w\s.'-]{1,50})\b/iu);
  if (m) return makeResult(m[1], 'punch out');

  // (6) “NAME just punched/clocked in/out”
  m = s.match(/^([a-z][\w\s.'-]{1,50})\s+just\s+(?:punched|clocked)\s+(in|out)\b/iu);
  if (m) return makeResult(m[1], `punch ${m[2].toLowerCase()}`);

  return null;
}

// ---------------- Hours inquiry (with or without period) ----------------
function tryParseHoursInquiry(text) {
  const s = String(text || '').trim().toLowerCase();
  if (!/\bhours?\b/.test(s)) return null;

  const forName =
    s.match(/\bfor\s+([a-z][\w\s.'-]{1,50})\b/i)?.[1] ||
    s.match(/\b(?:did|does)\s+([a-z][\w\s.'-]{1,50})\s+(?:work|do)\b/i)?.[1] ||
    s.match(/^([a-z][\w\s.'-]{1,50})\s+hours?\b/i)?.[1] ||
    s.match(/\b([a-z][\w\s.'-]{1,50})\s+(?:worked?|work)\b/i)?.[1] ||
    null;

  const periodMatch = s.match(/\b(today|day|this\s+week|week|this\s+month|month)\b/i);
  let period = null;
  if (periodMatch) {
    const raw = periodMatch[1].toLowerCase();
    if (raw === 'today' || raw === 'day') period = 'day';
    else if (raw.includes('week')) period = 'week';
    else if (raw.includes('month')) period = 'month';
  }

  if (forName || period) {
    return {
      type: 'hours_inquiry',
      data: {
        employeeName: forName ? titleCase(sanitizeName(forName)) : null,
        period
      }
    };
  }
  return null;
}

// ---------------- Expense / Revenue (simple) ----------------
function tryParseExpense(text) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const joined = lines.join(' ');
  const amtMatch = joined.match(/\$?\b(\d+(?:\.\d{2})?)\b/);
  if (!amtMatch) return null;

  const likelyExpense = /\b(receipt|bought|purchase|total|tax|visa|mastercard|debit|store|coffee|fuel|gas|hardware|tools?)\b/i.test(joined);
  if (!likelyExpense) return null;

  const amount = `$${amtMatch[1]}`;
  const store = (lines.find(l => !l.match(/\$?\d+(\.\d{2})?/)) || 'Unknown').trim();
  return {
    type: 'expense',
    data: {
      date: new Date().toISOString().split('T')[0],
      item: store || 'Item',
      amount,
      store,
      category: 'Miscellaneous',
    }
  };
}

function tryParseRevenue(text) {
  const s = String(text || '');
  const amtMatch = s.match(/\$?\b(\d+(?:\.\d{2})?)\b/);
  if (!amtMatch) return null;

  const m = s.match(/\bfrom\s+([^\n]+)$/i);
  if (!m) return null;

  const amount = `$${amtMatch[1]}`;
  const source = m[1].trim();
  return {
    type: 'revenue',
    data: {
      date: new Date().toISOString().split('T')[0],
      description: source,
      amount,
      source,
      category: 'Service',
    }
  };
}

// ---------------- Public API ----------------
async function parseMediaText(text) {
  const t = clean(text);
  console.log('[DEBUG] parseMediaText called:', { text: t });

  // 1) Time entry first
  const timeEntry = tryParseTimeEntry(t);
  if (timeEntry) return timeEntry;

  // 2) Hours inquiry
  const h = tryParseHoursInquiry(t);
  if (h) return h;

  // 3) Expense
  const exp = tryParseExpense(t);
  if (exp) return exp;

  // 4) Revenue
  const rev = tryParseRevenue(t);
  if (rev) return rev;

  throw new Error('Invalid media format');
}

module.exports = { parseMediaText };
