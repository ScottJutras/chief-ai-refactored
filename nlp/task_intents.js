// nlp/task_intents.js
// PURE NLP helpers. No DB imports here to avoid circular dependency.

const TASK_HINTS = [
  /\btask\b/i,
  /\btodo\b/i,
  /\bto-do\b/i,
  /\bremind me\b/i,
  /\bassign\b/i,
  /\bfollow ?up\b/i,
];

function looksLikeTask(s = '') {
  const t = String(s).toLowerCase().trim();
  return (
    TASK_HINTS.some((re) => re.test(t)) ||
    /^\s*remind me(\s+to)?\b/.test(t) ||
    /^task\b/.test(t)
  );
}

function parseDueAt(text, { tz = 'America/Toronto', now = new Date() } = {}) {
  // Note: tz not applied here (JS Date is local/UTC), but we keep signature stable.
  const base = new Date(now);
  const lower = String(text || '').toLowerCase();

  if (/\btonight\b/.test(lower)) {
    const d = new Date(base);
    d.setHours(21, 0, 0, 0);
    return d.toISOString();
  }

  if (/\btomorrow\b/.test(lower)) {
    const d = new Date(base);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  }

  const nextDow = lower.match(/\bnext\s+(mon|tue|wed|thu|fri|sat|sun)\b/);
  if (nextDow) {
    const map = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 };
    const want = map[nextDow[1]];
    const d = new Date(base);
    const cur = d.getDay();
    let delta = (want - cur + 7) % 7;
    if (delta === 0) delta = 7;
    d.setDate(d.getDate() + delta);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  }

  const byTime = lower.match(/\bby\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (byTime) {
    const [, hh, mm, ap] = byTime;
    let hour = parseInt(hh, 10);
    const minutes = mm ? parseInt(mm, 10) : 0;
    if (ap === 'pm' && hour < 12) hour += 12;
    if (ap === 'am' && hour === 12) hour = 0;

    const d = new Date(base);
    d.setHours(hour, minutes, 0, 0);
    if (d < base) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }

  // fallback: today 6pm
  const d = new Date(base);
  d.setHours(18, 0, 0, 0);
  return d.toISOString();
}

function extractAssignee(text = '') {
  const m = String(text || '').match(/\b(?:to|for|@)\s+([A-Za-z][\w' -]{1,40})\b/);
  return m ? m[1].trim() : null;
}

function buildTitle(text = '') {
  let t = String(text || '')
    .replace(/^\s*(task|todo|to-do)[:\s-]*/i, '')
    .replace(/^\s*remind me (to|that)\s*/i, '');

  t = t.replace(
    /\b(tonight|tomorrow|today|next\s+(mon|tue|wed|thu|fri|sat|sun)|by\s+\d{1,2}(:\d{2})?\s*(am|pm)?)\b/gi,
    ''
  );

  t = t.replace(/\b(?:to|for|@)\s+[A-Za-z][\w' -]{1,40}\b/gi, '');

  t = t.replace(/\s{2,}/g, ' ').trim();
  if (!t) return 'Task';

  return t.charAt(0).toUpperCase() + t.slice(1);
}

function parseTaskUtterance(text, { tz, now } = {}) {
  return {
    title: buildTitle(text),
    dueAt: parseDueAt(text, { tz, now }),
    assignee: extractAssignee(text),
  };
}

module.exports = { looksLikeTask, parseTaskUtterance };
