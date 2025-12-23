// services/mediaParser.js

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

function todayIso() {
  return new Date().toISOString().split('T')[0];
}

function parseNaturalDateLoose(text) {
  const s = String(text || '').toLowerCase();
  if (/\btoday\b/.test(s)) return todayIso();
  if (/\byesterday\b/.test(s)) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  }
  if (/\btomorrow\b/.test(s)) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
  }
  const m = s.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (m) return m[1];
  return null;
}

function looksLikeAddress(s) {
  const t = String(s || '').trim();
  if (!/\d/.test(t)) return false;
  return /\b(st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|ln|lane|ct|court|cir|circle|way|trl|trail|pkwy|park)\b/i.test(t);
}

function normalizeJobToken(s) {
  let t = String(s || '').trim();
  t = t.replace(/^(?:job\s*[:\-]?\s*)/i, '');   // "job 123", "job: 123"
  t = t.replace(/[.?!]+$/g, '').trim();
  return t;
}

function moneyToFixed(amountStr) {
  const n = Number(String(amountStr || '').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return `$${n.toFixed(2)}`;
}

function extractTimePhrase(text) {
  const s = String(text || '').toLowerCase();
  let m = s.match(/\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
  if (m) return m[1];
  m = s.match(/\bnow\b/i);
  if (m) return 'now';
  return null;
}

function buildTimestampFromText(clockText) {
  if (!clockText) return new Date().toISOString();
  const t = String(clockText).toLowerCase().trim();
  if (t === 'now' || t === 'right now') return new Date().toISOString();
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return new Date().toISOString();
  let hour = parseInt(m[1], 10);
  let min = m[2] ? parseInt(m[2], 10) : 0;
  const mer = m[3] ? m[3].toLowerCase() : null;
  if (mer === 'am' && hour === 12) hour = 0;
  if (mer === 'pm' && hour !== 12) hour += 12;
  const now = new Date();
  const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
    Math.min(Math.max(hour, 0), 23), Math.min(Math.max(min, 0), 59), 0, 0);
  return dt.toISOString();
}

/* ---------------- TIME ---------------- */

function tryParseTimeEntry(rawText) {
  let original = clean(rawText);
  const timeWord = extractTimePhrase(original);
  let working = original;
  if (timeWord) {
    const esc = escapeRegExp(timeWord);
    const atRe = new RegExp(`\\bat\\s+${esc}\\b`, 'i');
    const bareRe = new RegExp(`\\b${esc}\\b`, 'i');
    working = working.replace(atRe, ' ').replace(bareRe, ' ').replace(/\s+/g, ' ').trim();
  }
  const s = working.replace(/[.,!?]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

  const actionMap = {
    'punch in': 'punch_in', 'clock in': 'punch_in', 'punched in': 'punch_in', 'clocked in': 'punch_in',
    'punch out': 'punch_out', 'clock out': 'punch_out', 'punched out': 'punch_out', 'clocked out': 'punch_out',
    'break start': 'break_start', 'break begin': 'break_start', 'break in': 'break_start',
    'break end': 'break_end', 'break out': 'break_end', 'break finish': 'break_end',
    'lunch start': 'break_start', 'lunch begin': 'break_start', 'lunch in': 'break_start',
    'lunch end': 'break_end', 'lunch out': 'break_end', 'lunch finish': 'break_end',
    'drive start': 'drive_start', 'drive begin': 'drive_start', 'drive in': 'drive_start',
    'drive end': 'drive_end', 'drive stop': 'drive_end', 'drive finish': 'drive_end', 'drive out': 'drive_end',
  };

  function make(name, verbKey) {
    if (!verbKey) return null;
    const type = actionMap[verbKey];
    if (!type) return null;
    const ts = buildTimestampFromText(timeWord);
    return { type: 'time_entry', data: { employeeName: name ? titleCase(sanitizeName(name)) : null, type, timestamp: ts } };
  }

  // Nameless
  let m = s.match(/\b(?:punch(?:ed)?|clock(?:ed)?)\s+(in|out)\b/iu);
  if (m) return make(null, `punch ${m[1].toLowerCase()}`);

  // Action-first with name
  m = s.match(/\b(?:punch(?:ed)?|clock(?:ed)?)\s+(in|out)\b(?:\s*for\b)?\s+([a-z][\w\s.'-]{1,50})\b/iu);
  if (m) return make(m[2], `punch ${m[1].toLowerCase()}`);

  // Name-first
  m = s.match(/^([a-z][\w\s.'-]{1,50})\s+(?:punched|clocked|punch|clock)\s+(in|out)\b/iu);
  if (m) return make(m[1], `punch ${m[2].toLowerCase()}`);

  // Break/Lunch/Drive
  m = s.match(/\b(break|lunch|drive)\s+(start|begin|in|end|out|finish)\b(?:\s*for\b)?\s+([a-z][\w\s.'-]{1,50})\b/iu);
  if (m) return make(m[3], `${m[1].toLowerCase()} ${m[2].toLowerCase()}`);

  m = s.match(/\b(start|begin|end|finish|stop|in|out)\s+(break|lunch|drive)\b(?:\s*for\b)?\s+([a-z][\w\s.'-]{1,50})\b/iu);
  if (m) {
    const dir = m[1].toLowerCase();
    const obj = m[2].toLowerCase();
    const dirKey = dir === 'in' ? 'start' : (dir === 'out' ? 'end' : dir);
    return make(m[3], `${obj} ${dirKey}`);
  }

  return null;
}

function tryParseHoursInquiry(text) {
  const s = String(text || '').trim().toLowerCase();
  if (!/\bhours?\b/.test(s)) return null;
  const name = s.match(/\bfor\s+([a-z][\w\s.'-]{1,50})\b/i)?.[1] ||
               s.match(/\b(?:did|does)\s+([a-z][\w\s.'-]{1,50})\s+(?:work|do)\b/i)?.[1] ||
               s.match(/^([a-z][\w\s.'-]{1,50})\s+hours?\b/i)?.[1] ||
               s.match(/\b([a-z][\w\s.'-]{1,50})\s+(?:worked?|work)\b/i)?.[1] ||
               null;
  const periodMatch = s.match(/\b(today|day|this\s+week|week|this\s+month|month)\b/i);
  let period = null;
  if (periodMatch) {
    const raw = periodMatch[1].toLowerCase();
    period = raw === 'today' || raw === 'day' ? 'day' :
             raw.includes('week') ? 'week' : 'month';
  }
  if (name || period) {
    return { type: 'hours_inquiry', data: { employeeName: name ? titleCase(sanitizeName(name)) : null, period } };
  }
  return null;
}

/* ---------------- EXPENSE ---------------- */

function tryParseExpense(text) {
  const s = clean(text).replace(/\s+/g, ' ');
  const lc = s.toLowerCase();

  // Voice-style patterns
  const verb = /\b(spent|paid|bought|purchased|purchase)\b/.test(lc);
  if (!verb && !/\bexpense\b/.test(lc) && !/\breceipt\b/.test(lc)) return null;

  const amtMatch = s.match(/\$?\b(\d+(?:\.\d{1,2})?)\b/);
  if (!amtMatch) return null;

  const amount = moneyToFixed(amtMatch[1]);
  if (!amount) return null;

  const date = parseNaturalDateLoose(s) || todayIso();

  // Store heuristics: "at Home Depot" / "from Home Depot"
  let store =
    s.match(/\b(?:at|from)\s+([a-z0-9][a-z0-9&.' -]{1,60})\b/i)?.[1] ||
    null;

  store = store ? titleCase(sanitizeName(store)) : 'Unknown Store';

  // Item heuristic: if they said "on lumber/materials/tools" we can pick it up
  let item =
    s.match(/\bon\s+([a-z][a-z0-9&.' -]{1,60})\b/i)?.[1] ||
    s.match(/\bfor\s+([a-z][a-z0-9&.' -]{1,60})\b/i)?.[1] ||
    null;

  item = item ? titleCase(sanitizeName(item)) : 'Materials';

  return {
    type: 'expense',
    data: {
      date,
      item,
      amount,
      store,
      category: null,
      jobName: null
    }
  };
}

/* ---------------- REVENUE ---------------- */

function tryParseRevenue(text) {
  const s = clean(text).replace(/\s+/g, ' ');
  const lc = s.toLowerCase();

  // Match revenue-ish intent
  const verb = /\b(received|got paid|got payed|paid|deposit|deposited|payment|revenue|invoice paid)\b/.test(lc);
  if (!verb && !/\brevenue\b/.test(lc)) return null;

  const amtMatch = s.match(/\$?\b(\d+(?:\.\d{1,2})?)\b/);
  if (!amtMatch) return null;

  const amount = moneyToFixed(amtMatch[1]);
  if (!amount) return null;

  const date = parseNaturalDateLoose(s) || todayIso();

  // Job candidates:
  // - "for <job>"
  // - "on <job>"
  // - "from job <job>"
  // - "from <address-like>"  (treat as job)
  let jobName = null;

  const forMatch = s.match(/\bfor\s+(.+?)(?:\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|$)/i);
  if (forMatch?.[1]) jobName = normalizeJobToken(forMatch[1]);

  if (!jobName) {
    const onMatch = s.match(/\bon\s+(.+?)(?:\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|$)/i);
    if (onMatch?.[1]) jobName = normalizeJobToken(onMatch[1]);
  }

  // "from X" might be payer OR job/address
  let source = 'Unknown';
  const fromMatch = s.match(/\bfrom\s+(.+?)(?:\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|$)/i);
  if (fromMatch?.[1]) {
    const raw = String(fromMatch[1]).trim();
    const cleaned = normalizeJobToken(raw);

    const isExplicitJob = /^\s*job\b/i.test(raw);
    const isAddr = looksLikeAddress(cleaned) || looksLikeAddress(raw);

    if (!jobName && (isExplicitJob || isAddr)) {
      jobName = cleaned;
      source = 'Unknown';
    } else if (!isExplicitJob && !isAddr) {
      source = titleCase(sanitizeName(cleaned));
    }
  }

  // If jobName looks like overhead, normalize it
  if (jobName) {
    const t = String(jobName).trim().toLowerCase();
    if (t === 'overhead' || t === 'oh') jobName = 'Overhead';
  }

  return {
    type: 'revenue',
    data: {
      date,
      description: 'Payment received',
      amount,
      source,
      category: null,
      jobName: jobName || null
    }
  };
}

/* ---------------- MAIN ---------------- */

async function parseMediaText(text) {
  const t = clean(text);
  console.log('[mediaParser] input:', t);

  const time = tryParseTimeEntry(t);
  if (time) return time;

  const hours = tryParseHoursInquiry(t);
  if (hours) return hours;

  const exp = tryParseExpense(t);
  if (exp) return exp;

  const rev = tryParseRevenue(t);
  if (rev) return rev;

  // ✅ Do not throw — let media handler fall back cleanly
  return { type: 'unknown', data: {} };
}

module.exports = { parseMediaText };
