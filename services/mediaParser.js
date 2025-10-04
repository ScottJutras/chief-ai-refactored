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

// Strip trailing time tokens accidentally captured as part of the name
function stripTrailingTimeTokens(name) {
  return String(name || '')
    .replace(/\bnow\b/gi, '')
    .replace(/\s+at\s+.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Build a timestamp from an extracted clock string, else now (UTC ISO).
function buildTimestampFromText(clockText) {
  if (!clockText) return new Date().toISOString();

  const t = clockText.toLowerCase().trim();
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
  let m = s.match(/\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
  if (m) return m[1];
  m = s.match(/\bnow\b/i);
  if (m) return 'now';
  return null;
}

// ---------------- Time-entry parsing ----------------
function tryParseTimeEntry(rawText) {
  const original = clean(rawText);
  if (!original) return null;

  const s = original
    .replace(/[.,!?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const timeWord = extractTimePhrase(s);
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
    'drive end': 'drive_end',
    'drive stop': 'drive_end',
    'drive finish': 'drive_end',
  };

  function makeResult(name, verbKey) {
    if (!verbKey) return null;
    const type = actionMap[verbKey];
    if (!type) return null;
    const ts = buildTimestampFromText(timeWord);
    return {
      type: 'time_entry',
      data: {
        employeeName: titleCase(sanitizeName(name)),
        type,
        timestamp: ts,
        implicitNow: !timeWord || timeWord === 'now'
      }
    };
  }

  // (1) Action-first "punch/clock in/out [for] NAME"
  let m = s.match(/\b(?:punch(?:ed)?|clock(?:ed)?)\s+(in|out)\b(?:\s*for\b)?\s+([a-z][\w\s.'-]{1,50})\b/iu);
  if (m) {
    const dir = m[1].toLowerCase();
    const name = stripTrailingTimeTokens(m[2]);
    return makeResult(name, `punch ${dir}`);
  }

  // (1a) Sandwich "punch/clock NAME in/out"
  m = s.match(/\b(?:punch|clock)\s+([a-z][\w\s.'-]{1,50})\s+(in|out)\b/iu);
  if (m) {
    const name = stripTrailingTimeTokens(m[1]);
    const dir = m[2].toLowerCase();
    return makeResult(name, `punch ${dir}`);
  }

  // (2) Name-first "NAME punched/clocked in/out"
  m = s.match(/^([a-z][\w\s.'-]{1,50})\s+(?:punched|clocked|punch|clock)\s+(in|out)\b/iu);
  if (m) {
    const name = stripTrailingTimeTokens(m[1]);
    const dir = m[2].toLowerCase();
    return makeResult(name, `punch ${dir}`);
  }

  // (3) Break/Lunch/Drive action-first "(break|lunch|drive) (start|...)[for] NAME"
  m = s.match(/\b(break|lunch|drive)\s+(start|begin|in|end|out|finish)\b(?:\s*for\b)?\s+([a-z][\w\s.'-]{1,50})\b/iu);
  if (m) {
    const name = stripTrailingTimeTokens(m[3]);
    return makeResult(name, `${m[1].toLowerCase()} ${m[2].toLowerCase()}`);
  }

  // (3b) NEW: action-first reversed "start/begin... (break|lunch|drive) [for] NAME"
  m = s.match(/\b(start|begin|in|end|out|finish)\s+(break|lunch|drive)\b(?:\s*for\b)?\s+([a-z][\w\s.'-]{1,50})\b/iu);
  if (m) {
    const name = stripTrailingTimeTokens(m[3]);
    return makeResult(name, `${m[2].toLowerCase()} ${m[1].toLowerCase()}`);
  }

  // (4) Break/Lunch/Drive name-first "NAME break/lunch/drive start/end"
  m = s.match(/^([a-z][\w\s.'-]{1,50})\s+(break|lunch|drive)\s+(start|begin|in|end|out|finish)\b/iu);
  if (m) {
    const name = stripTrailingTimeTokens(m[1]);
    return makeResult(name, `${m[2].toLowerCase()} ${m[3].toLowerCase()}`);
  }

  // (4b) NEW: name-first reversed "NAME start/begin... break/lunch/drive"
  m = s.match(/^([a-z][\w\s.'-]{1,50})\s+(start|begin|in|end|out|finish)\s+(break|lunch|drive)\b/iu);
  if (m) {
    const name = stripTrailingTimeTokens(m[1]);
    return makeResult(name, `${m[3].toLowerCase()} ${m[2].toLowerCase()}`);
  }

  // (5) Imperative with commas "clock in, justin"
  m = s.match(/\b(?:punch|clock)\s+in\b[^a-z0-9]+([a-z][\w\s.'-]{1,50})\b/iu);
  if (m) {
    const name = stripTrailingTimeTokens(m[1]);
    return makeResult(name, 'punch in');
  }
  m = s.match(/\b(?:punch|clock)\s+out\b[^a-z0-9]+([a-z][\w\s.'-]{1,50})\b/iu);
  if (m) {
    const name = stripTrailingTimeTokens(m[1]);
    return makeResult(name, 'punch out');
  }

  // (6) “NAME just punched/clocked in/out”
  m = s.match(/^([a-z][\w\s.'-]{1,50})\s+just\s+(?:punched|clocked)\s+(in|out)\b/iu);
  if (m) {
    const name = stripTrailingTimeTokens(m[1]);
    const dir = m[2].toLowerCase();
    return makeResult(name, `punch ${dir}`);
  }

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

  // 2) Hours inquiry (period optional)
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
