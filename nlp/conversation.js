// nlp/conversation.js
// Conversational normalizer:
// 1) Fuzzy match (fast) against commandCatalog.json
// 2) If confidence is low, fall back to your nlp/intentRouter.js tool-calls
// 3) Output either TwiML (clarify) OR a normalized command your handlers accept

const fs = require('fs');
const path = require('path');
const { routeWithAI } = require('./intentRouter'); // <- you already have this

const CATALOG = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'commandCatalog.json'), 'utf8')
);

const HIGH = 0.85;
const MID = 0.6;

// ---------------- utils ----------------
function normalize(s = '') {
  return String(s).toLowerCase().replace(/[^\w\s\.\-:$]/g, ' ').replace(/\s+/g, ' ').trim();
}

function levenshtein(a, b) {
  a = a || ''; b = b || '';
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      m[i][j] = Math.min(
        m[i - 1][j] + 1,
        m[i][j - 1] + 1,
        m[i - 1][j - 1] + cost
      );
    }
  }
  return m[a.length][b.length];
}

function charSim(a, b) {
  const A = normalize(a), B = normalize(b);
  if (!A || !B) return 0;
  if (A.includes(B) || B.includes(A)) return 1;
  const dist = levenshtein(A, B);
  const base = Math.max(3, Math.max(A.length, B.length));
  return 1 - dist / base;
}

// ---------------- intent match ----------------
function matchIntent(userText) {
  const input = normalize(userText);
  let best = { key: null, score: 0, via: '' };

  for (const [key, def] of Object.entries(CATALOG)) {
    for (const syn of def.synonyms || []) {
      const score = charSim(input, syn);
      if (score > best.score) best = { key, score, via: syn };

      // small boost if all words present
      const words = normalize(syn).split(' ').filter(Boolean);
      if (words.length && words.every(w => input.includes(w))) {
        const boosted = Math.min(1, score + 0.1);
        if (boosted > best.score) best = { key, score: boosted, via: syn };
      }
    }
  }
  return best;
}

// ---------------- slot extraction (light) ----------------
function extractSlots(key, userText) {
  const text = userText || '';
  const slots = {};

  if (key === 'tasks.create') {
    // "task - title" | "todo title" | "remind me to <title>"
    let m = text.match(/^\s*(?:task[s]?|todo|remind me to|note to|please remember)\s*[:\-]?\s*(.+)$/i);
    if (m && m[1]) slots.title = m[1].trim();
    if (!slots.title) {
      m = text.match(/task(?:s)?\b.*?(?:-|\:)\s*(.+)$/i);
      if (m && m[1]) slots.title = m[1].trim();
    }
  }

  if (key === 'expense.add') {
    // $12.34 or 12.34
    let m = text.match(/(\$|usd\s*)?(\d{1,5}([.,]\d{2})?)/i);
    if (m) slots.amount = m[2].replace(',', '.');
    const jobMention = text.match(/\bfor\s+([a-z][\w\s.'-]{1,50})$/i);
    if (jobMention) slots.job = jobMention[1].trim();
  }

  return slots;
}

// ---------------- normalize to handlers ----------------
function normalizeForHandlers(key, slots) {
  if (key === 'tasks.create') {
    const title = (slots.title || '').trim().slice(0, 140);
    if (!title) return null;
    return { route: 'tasks', normalized: `task - ${title}` };
  }

  if (key === 'expense.add') {
    const amt = slots.amount;
    if (!amt) return null;
    const jobHint = slots.job ? ` ${slots.job}` : '';
    return { route: 'expense', normalized: `expense $${amt}${jobHint}` };
  }

  if (key === 'timeclock.punch_in') {
    return { route: 'timeclock', normalized: 'punched in' };
  }

  if (key === 'timeclock.punch_out') {
    return { route: 'timeclock', normalized: 'punched out' };
  }

  if (key === 'job.create') {
    const name = (slots.name || '').trim();
    if (!name) return null;
    return { route: 'job', normalized: `create job ${name}` };
  }

  return null;
}

// ---------------- main API ----------------
async function converseAndRoute(userText, { userProfile, ownerId } = {}) {
  // 1) deterministic
  let { key, score } = matchIntent(userText);

  // 2) low confidence? ask your AI router
  if (!key || score < MID) {
    try {
      const ai = await routeWithAI(userText, { userProfile, ownerId });
      if (ai?.intent === 'timeclock.clock_in') key = 'timeclock.punch_in', score = HIGH;
      else if (ai?.intent === 'timeclock.clock_out') key = 'timeclock.punch_out', score = HIGH;
      else if (ai?.intent === 'job.create') key = 'job.create', score = HIGH;
      else if (ai?.intent === 'expense.add') key = 'expense.add', score = HIGH;
      // tasks.create is mostly deterministic with our regexes; leave as-is
    } catch (_) {}
  }

  // 3) still unsure → friendly suggestions (no hard error)
  if (!key || score < MID) {
    return {
      handled: true,
      twiml:
        `<Response><Message>` +
        `I can help with tasks, time, and expenses.\n` +
        `• “task - buy tape”\n` +
        `• “punch in”\n` +
        `• “expense $45 tools”\n` +
        `What would you like to do?` +
        `</Message></Response>`
    };
  }

  const def = CATALOG[key] || {};
  const slots = extractSlots(key, userText);

  // 4) ask for missing required slots conversationally
  const missing = (def.required || []).filter(r => !slots[r]);
  if (missing.length) {
    const first = missing[0];
    const ask = (def.asks && def.asks[first]) || `I need ${first}.`;
    const hint = (def.personality_hints && def.personality_hints[0]) ? def.personality_hints[0] + ' ' : '';
    return { handled: true, twiml: `<Response><Message>${hint}${ask}</Message></Response>` };
  }

  // 5) produce normalized command for your existing handlers
  const norm = normalizeForHandlers(key, slots);
  if (norm) return { handled: false, ...norm };

  // fallback (rare)
  return {
    handled: true,
    twiml: `<Response><Message>Got it. Want to create a task, log time, or add an expense?</Message></Response>`
  };
}

module.exports = { converseAndRoute };
