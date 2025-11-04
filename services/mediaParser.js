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
function tryParseExpense(text) {
  const joined = String(text || '').split('\n').map(l => l.trim()).filter(Boolean).join(' ');
  const amtMatch = joined.match(/\$?\b(\d+(?:\.\d{2})?)\b/);
  if (!amtMatch) return null;
  const likely = /\b(receipt|bought|purchase|total|tax|visa|mastercard|debit|store|coffee|fuel|gas|hardware|tools?)\b/i.test(joined);
  if (!likely) return null;
  const amount = `$${amtMatch[1]}`;
  const store = (joined.split(/\s+/).find(w => !/\$?\d+(\.\d{2})?/.test(w)) || 'Unknown').trim();
  return {
    type: 'expense',
    data: { date: new Date().toISOString().split('T')[0], item: store, amount, store, category: 'Miscellaneous' }
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
    data: { date: new Date().toISOString().split('T')[0], description: source, amount, source, category: 'Service' }
  };
}
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
  throw new Error('Invalid media format');
}
module.exports = { parseMediaText };