// services/mediaParser.js
// (Your file is already solid. Keeping as-is with only tiny safety guards.)

function clean(s) { return String(s || '').trim(); }

function titleCase(s) {
  return String(s || '')
    .split(/\s+/)
    .map(w => (w ? w[0].toUpperCase() + w.slice(1) : ''))
    .join(' ')
    .trim();
}

function sanitizeName(s) {
  return String(s || '')
    .replace(/[^\p{L}\p{N}\s.'-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function todayIso() {
  return new Date().toISOString().split('T')[0];
}

function parseNaturalDateLoose(text) {
  const raw = String(text || '').trim();
  const s = raw.toLowerCase();

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

  const mIso = s.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (mIso) return mIso[1];

  const mNat = raw.match(/\b(?:on\s+)?([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})\b/);
  if (mNat?.[1]) {
    const parsed = Date.parse(mNat[1]);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().split('T')[0];
  }

  return null;
}

function looksLikeAddress(s) {
  const t = String(s || '').trim();
  if (!/\d/.test(t)) return false;
  return /\b(st|street|ave|avenue|rd|road|dr|drive|blvd|boulevard|ln|lane|ct|court|cir|circle|way|trl|trail|pkwy|park)\b/i.test(t);
}

function normalizeJobToken(s) {
  let t = String(s || '').trim();
  t = t.replace(/^(?:job\s*[:\-]?\s*)/i, '');
  t = t.replace(/[.?!]+$/g, '').trim();
  return t;
}

function formatMoneyDisplay(n) {
  try {
    const fmt = new Intl.NumberFormat('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `$${fmt.format(n)}`;
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

function moneyToFixed(amountStr) {
  const raw = String(amountStr || '').trim();
  if (!raw) return null;

  const cleaned = raw.replace(/[^0-9.,]/g, '');
  if (!cleaned) return null;

  const normalized = cleaned.replace(/,/g, '');
  const n = Number(normalized);
  if (!Number.isFinite(n) || n <= 0) return null;

  return formatMoneyDisplay(n);
}

function extractMoneyToken(text) {
  const s = String(text || '');

  let m = s.match(/\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)/);
  if (m?.[1]) return m[1];

  m = s.match(/\b([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?)\b/);
  if (m?.[1]) return m[1];

  m = s.match(/\b([0-9]{4,}(?:\.[0-9]{1,2})?)\b/);
  if (m?.[1]) return m[1];

  m = s.match(/\b([0-9]{1,3}\.[0-9]{1,2})\b/);
  if (m?.[1]) return m[1];

  return null;
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
    Math.min(Math.max(hour, 0), 23),
    Math.min(Math.max(min, 0), 59),
    0, 0
  );
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
    const type = actionMap[verbKey];
    if (!type) return null;
    const ts = buildTimestampFromText(timeWord);
    return { type: 'time_entry', data: { employeeName: name ? titleCase(sanitizeName(name)) : null, type, timestamp: ts } };
  }

  let m = s.match(/\b(?:punch(?:ed)?|clock(?:ed)?)\s+(in|out)\b/iu);
  if (m) return make(null, `punch ${m[1].toLowerCase()}`);

  m = s.match(/\b(?:punch(?:ed)?|clock(?:ed)?)\s+(in|out)\b(?:\s*for\b)?\s+([a-z][\w\s.'-]{1,50})\b/iu);
  if (m) return make(m[2], `punch ${m[1].toLowerCase()}`);

  m = s.match(/^([a-z][\w\s.'-]{1,50})\s+(?:punched|clocked|punch|clock)\s+(in|out)\b/iu);
  if (m) return make(m[1], `punch ${m[2].toLowerCase()}`);

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

  const name =
    s.match(/\bfor\s+([a-z][\w\s.'-]{1,50})\b/i)?.[1] ||
    s.match(/\b(?:did|does)\s+([a-z][\w\s.'-]{1,50})\s+(?:work|do)\b/i)?.[1] ||
    s.match(/^([a-z][\w\s.'-]{1,50})\s+hours?\b/i)?.[1] ||
    s.match(/\b([a-z][\w\s.'-]{1,50})\s+(?:worked?|work)\b/i)?.[1] ||
    null;

  const periodMatch = s.match(/\b(today|day|this\s+week|week|this\s+month|month)\b/i);
  let period = null;
  if (periodMatch) {
    const raw = periodMatch[1].toLowerCase();
    period = raw === 'today' || raw === 'day' ? 'day' : raw.includes('week') ? 'week' : 'month';
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

  const verb = /\b(spent|paid|bought|purchased|purchase|ordered|charge|charged|picked\s*up)\b/.test(lc);
  if (!verb && !/\bexpense\b/.test(lc) && !/\breceipt\b/.test(lc)) return null;

  const token = extractMoneyToken(s);
  if (!token) return null;

  const amount = moneyToFixed(token);
  if (!amount) return null;

  const date = parseNaturalDateLoose(s) || todayIso();

  let store = s.match(/\b(?:at|from)\s+(.+?)(?:\s+\bon\b|\s+\bfor\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|[.?!]|$)/i)?.[1] || null;
  store = store ? titleCase(sanitizeName(store)) : 'Unknown Store';

  let jobName = s.match(/\bfor\s+(?:job\s+)?(.+?)(?:\s+\bon\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|[.?!]|$)/i)?.[1] || null;
  jobName = jobName ? normalizeJobToken(jobName) : null;

  if (jobName) {
    const t = String(jobName).trim().toLowerCase();
    if (t === 'overhead' || t === 'oh') jobName = 'Overhead';
  }

  let item =
    s.match(/\bworth\s+of\s+(.+?)(?:\s+\b(?:at|from)\b|\s+\bon\b|\s+\bfor\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|[.?!]|$)/i)?.[1] ||
    s.match(/\bon\s+(.+?)(?:\s+\b(?:at|from)\b|\s+\bon\b|\s+\bfor\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|[.?!]|$)/i)?.[1] ||
    null;

  if (item && jobName && clean(item).toLowerCase() === clean(jobName).toLowerCase()) item = null;
  item = item ? titleCase(sanitizeName(item)) : 'Materials';

  return {
    type: 'expense',
    data: { date, item, amount, store, category: null, jobName: jobName || null }
  };
}

/* ---------------- REVENUE ---------------- */

function tryParseRevenue(text) {
  const s = clean(text).replace(/\s+/g, ' ');
  const lc = s.toLowerCase();

  const verb = /\b(received|got paid|got payed|deposit|deposited|payment|revenue|invoice paid)\b/.test(lc);
  if (!verb && !/\brevenue\b/.test(lc)) return null;

  const token = extractMoneyToken(s);
  if (!token) return null;

  const amount = moneyToFixed(token);
  if (!amount) return null;

  const date = parseNaturalDateLoose(s) || todayIso();

  let jobName = null;
  const forMatch = s.match(/\bfor\s+(.+?)(?:\s+\bon\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|[.?!]|$)/i);
  if (forMatch?.[1]) jobName = normalizeJobToken(forMatch[1]);

  if (!jobName) {
    const onMatch = s.match(/\bon\s+(.+?)(?:\s+\bon\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|[.?!]|$)/i);
    if (onMatch?.[1]) jobName = normalizeJobToken(onMatch[1]);
  }

  let source = 'Unknown';
  const fromMatch = s.match(/\bfrom\s+(.+?)(?:\s+\bon\b|\s+\b(today|yesterday|tomorrow)\b|\s+\d{4}-\d{2}-\d{2}\b|[.?!]|$)/i);
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

  if (jobName) {
    const t = String(jobName).trim().toLowerCase();
    if (t === 'overhead' || t === 'oh') jobName = 'Overhead';
  }

  return {
    type: 'revenue',
    data: { date, description: 'Payment received', amount, source, category: null, jobName: jobName || null }
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

  return { type: 'unknown', data: {} };
}

module.exports = { parseMediaText };
