// services/mediaParser.js
// Robust media text parser for time entries, expenses, and revenue.
// - Handles action-first ("punch in Justin", "clock in, Justin. now", "clock Justin in now")
// - Handles name-first ("Justin punched in", "Justin break end at 12:05")
// - Supports break/lunch/drive start/end
// - Lightweight time extraction: "now", "at 8", "at 8am", "at 8:15 pm"

function clean(s) {
  return String(s || '').trim();
}
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

// Build a timestamp from an extracted clock string, else now.
function buildTimestampFromText(clockText) {
  if (!clockText) return new Date().toISOString();

  const t = clockText.toLowerCase().trim();
  if (t === 'now' || t === 'right now') return new Date().toISOString();

  // Accept "8", "8am", "8 pm", "8:15", "8:15am"
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

// Try to extract a time following "at ..." or trailing "now"
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
  const original = clean(rawText);
  if (!original) return null;

  // Normalize punctuation spacing for easier matching
  const s = original
    .replace(/[.,!?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  // Supported verbs/objects
  // punch/clock in/out
  // break/lunch/drive start/end
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

  // Helper to build the return object
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
      }
    };
  }

  // 1) Action-first: "(punched|clocked|punch|clock) (in|out) [for] NAME ..."
  // e.g., "punch in justin", "clock in, justin now"
  let m = s.match(/\b(?:punch(?:ed)?|clock(?:ed)?)\s+(in|out)\b(?:\s*(?:for)\b)?\s+([a-z][\w\s.'-]{1,50})\b/iu);
  if (m) {
    const dir = m[1].toLowerCase();
    const name = m[2];
    return makeResult(name, `punch ${dir}`);
  }

  // 1a) Sandwich order: "(punch|clock) NAME (in|out)"  ← fixes "Clock Justin in now"
  m = s.match(/\b(?:punch|clock)\s+([a-z][\w\s.'-]{1,50})\s+(in|out)\b/iu);
  if (m) {
    const name = m[1];
    const dir = m[2].toLowerCase();
    return makeResult(name, `punch ${dir}`);
  }

  // 2) Name-first: "NAME (punched|clocked|punch|clock) (in|out) ..."
  // e.g., "justin punched in", "justin clocked out at 5 pm"
  m = s.match(/^([a-z][\w\s.'-]{1,50})\s+(?:punched|clocked|punch|clock)\s+(in|out)\b/iu);
  if (m) {
    const name = m[1];
    const dir = m[2].toLowerCase();
    return makeResult(name, `punch ${dir}`);
  }

  // 3) Break/Lunch/Drive - action-first: "(break|lunch|drive) (start|begin|in|end|out|finish) [for] NAME"
  m = s.match(/\b(break|lunch|drive)\s+(start|begin|in|end|out|finish)\b(?:\s*(?:for)\b)?\s+([a-z][\w\s.'-]{1,50})\b/iu);
  if (m) {
    const obj = m[1].toLowerCase();
    const dir = m[2].toLowerCase();
    const name = m[3];
    return makeResult(name, `${obj} ${dir}`);
  }

  // 4) Break/Lunch/Drive - name-first: "NAME (break|lunch|drive) (start|begin|in|end|out|finish)"
  m = s.match(/^([a-z][\w\s.'-]{1,50})\s+(break|lunch|drive)\s+(start|begin|in|end|out|finish)\b/iu);
  if (m) {
    const name = m[1];
    const obj = m[2].toLowerCase();
    const dir = m[3].toLowerCase();
    return makeResult(name, `${obj} ${dir}`);
  }

  // 5) Imperative with comma: "clock in, justin", "punch in, scott, now"
  m = s.match(/\b(?:punch|clock)\s+in\b[^a-z0-9]+([a-z][\w\s.'-]{1,50})\b/iu);
  if (m) {
    const name = m[1];
    return makeResult(name, 'punch in');
  }
  m = s.match(/\b(?:punch|clock)\s+out\b[^a-z0-9]+([a-z][\w\s.'-]{1,50})\b/iu);
  if (m) {
    const name = m[1];
    return makeResult(name, 'punch out');
  }

  // 6) “NAME just punched/clocked in/out”
  m = s.match(/^([a-z][\w\s.'-]{1,50})\s+just\s+(?:punched|clocked)\s+(in|out)\b/iu);
  if (m) {
    const name = m[1];
    const dir = m[2].toLowerCase();
    return makeResult(name, `punch ${dir}`);
  }

  return null;
}

// ---------------- Expense / Revenue parsing (simple heuristics) ----------------
function tryParseExpense(text) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const joined = lines.join(' ');
  const amtMatch = joined.match(/\$?\b(\d+(?:\.\d{2})?)\b/);
  if (!amtMatch) return null;

  // crude heuristic: treat as expense if we see a money amount and common purchase words
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

  // "1234 from Acme", "paid 500 from John"
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

  // 1) Time-entry first (so “clock Justin in now” doesn’t fall through)
  const timeEntry = tryParseTimeEntry(t);
  if (timeEntry) return timeEntry;

  // 2) Expense
  const exp = tryParseExpense(t);
  if (exp) return exp;

  // 3) Revenue
  const rev = tryParseRevenue(t);
  if (rev) return rev;

  // If nothing matched, keep previous behavior (throw)
  throw new Error('Invalid media format');
}

module.exports = { parseMediaText };
