// nlp/conversation.js
// 1) Fuzzy match (fast) against commandCatalog.json
// 2) If confidence is low, fall back to nlp/intentRouter.js tool-calls
// 3) Output TwiML (clarify) OR a normalized command your handlers accept

const fs = require('fs');
const path = require('path');
const { routeWithAI } = require('./intentRouter');
const { looksLikeTask, parseTaskUtterance } = require('./task_intents');
const { getMemory, upsertMemory, forget } = require('../services/memory');
const { getPendingPrompt } = require('../services/postgres');

const CONVERSATION_FALLBACK_ENABLED = /^true$/i.test(process.env.CONVERSATION_FALLBACK_ENABLED || 'true');

const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, 'commandCatalog.json'), 'utf8'));

const HIGH = 0.85;
const MID = 0.6;

const CFO = {
  confirm: (s) => `✅ ${s}`,
  ask: (s) => `Quick one — ${s}`,
  nudge: (s) => `${s} (one more detail?)`,
  follow: (s) => s
};

function normalize(s = '') {
  return String(s).toLowerCase().replace(/[^\w\s\.\-:$@]/g, ' ').replace(/\s+/g, ' ').trim();
}

function levenshtein(a, b) {
  a = a || ''; b = b || '';
  const m = Array.from({ length: a.length + 1 }, (_, i) => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) m[i][0] = i;
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + cost);
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

function matchIntent(userText) {
  const input = normalize(userText);
  let best = { key: null, score: 0, via: '' };

  for (const [key, def] of Object.entries(CATALOG)) {
    for (const syn of def.synonyms || []) {
      const score = charSim(input, syn);
      const tieBreaker = syn.length / 1000;
      const total = score + tieBreaker;
      if (total > best.score) best = { key, score: total, via: syn };

      const words = normalize(syn).split(' ').filter(Boolean);
      if (words.length && words.every(w => input.includes(w))) {
        const boosted = Math.min(1, score + 0.1) + tieBreaker;
        if (boosted > best.score) best = { key, score: boosted, via: syn };
      }
    }
  }

  return best;
}

function extractSlots(key, userText, convoState, memory) {
  const text = userText || '';
  const lc = normalize(userText);
  let slots = {};

  if (key === 'tasks.create') {
    let m = text.match(/^\s*(?:task[s]?|todo|remind me to|note to|please remember)\s*[:\-]?\s*(.+)$/i);
    if (m?.[1]) slots.title = m[1].trim().slice(0, 140);
    if (!slots.title) {
      m = text.match(/task(?:s)?\b.*?(?:-|\:)\s*(.+)$/i);
      if (m?.[1]) slots.title = m[1].trim().slice(0, 140);
    }
  }

  if (key === 'tasks.assign_all') {
    const m =
      text.match(/^\s*task\s*@everyone\s*[-:]\s*(.+)$/i) ||
      text.match(/^\s*task\s*everyone\s*[-:]\s*(.+)$/i) ||
      text.match(/^\s*broadcast\s*task\s*[-:]\s*(.+)$/i) ||
      text.match(/^\s*send\s*task\s*to\s*everyone\s*[-:]\s*(.+)$/i) ||
      text.match(/^\s*assign\s*everyone\s*[-:]\s*(.+)$/i) ||
      text.match(/^\s*all\s*hands\s*task\s*[-:]\s*(.+)$/i);
    if (m?.[1]) slots.title = m[1].trim().slice(0, 200);
  }

  if (key === 'expense.add') {
    const mAmt = lc.match(/(\$|usd\s*)?(\d{1,5}([.,]\d{2})?)/i);
    if (mAmt) slots.amount = parseFloat(mAmt[2].replace(',', '.'));
    const jobMention = lc.match(/\bfor\s+([a-z][\w\s.'-]{1,50})$/i);
    if (jobMention) slots.job = jobMention[1].trim();
    if (!slots.job && convoState?.aliases?.[lc]) slots.job = convoState.aliases[lc];
    if (!slots.job && memory?.['default.expense.bucket']) slots.job = memory['default.expense.bucket'].bucket;
  }

  if (key === 'job.create') {
    const m = text.match(/^\s*(?:new job|create job|add job|start job|set up job)\s*[:\-]?\s*(.+)$/i);
    if (m?.[1]) slots.name = m[1].trim();
  }

  if (key === 'quote.send') {
    let m = lc.match(/\b(?:to|for)\s+([a-z][\w\s'-]{1,50})$/i);
    if (m) slots.client = m[1].trim();
    m = lc.match(/\b(?:quote|for)\s+([a-z][\w\s'-]{1,50})$/i);
    if (m) slots.quote_id = m[1].trim();
  }

  if (key === 'budget.set') {
    let m = lc.match(/\b(?:for)\s+([a-z][\w\s'-]{1,50})$/i);
    if (m) slots.job = m[1].trim();
    m = lc.match(/(\$|usd\s*)?(\d{1,5}([.,]\d{2})?)/i);
    if (m) slots.amount = parseFloat(m[2].replace(',', '.'));
  }

  if (key === 'memory.forget') {
    const m = lc.match(/\b(?:forget|remove)\s+([a-z][\w\s.-]{1,50})$/i);
    if (m) slots.key = m[1].trim();
  }

  const def = CATALOG[key] || {};
  if (def.contextual_defaults?.job && !slots.job) {
    if (def.contextual_defaults.job === 'active_job_or_ask' && convoState?.active_job) {
      slots.job = convoState.active_job;
    } else if (def.contextual_defaults.job === 'last_job_or_overhead') {
      slots.job = convoState?.last_args?.job || memory?.['default.expense.bucket']?.bucket || 'Overhead';
    }
  }

  return slots;
}

function normalizeForHandlers(key, slots) {
  if (key === 'tasks.create') {
    const title = (slots.title || '').trim().slice(0, 140);
    if (!title) return null;
    return { route: 'tasks', normalized: `task - ${title}` };
  }
  if (key === 'tasks.list') return { route: 'tasks', normalized: 'tasks' };
  if (key === 'tasks.assign_all') {
    const title = (slots.title || '').trim().slice(0, 200);
    if (!title) return null;
    return { route: 'tasks', normalized: `task @everyone - ${title}` };
  }
  if (key === 'expense.add') {
    const amt = slots.amount;
    const item = (slots.item || slots.merchant || 'misc');
    if (!amt) return null;
    const vendor = slots.merchant ? ` from ${slots.merchant}` : '';
    const jobHint = slots.job ? ` ${slots.job}` : '';
    return { route: 'expense', normalized: `expense $${amt} ${item}${vendor}${jobHint}` };
  }
  if (key === 'timeclock.punch_in') return { route: 'timeclock', normalized: 'punched in' };
  if (key === 'timeclock.punch_out') return { route: 'timeclock', normalized: 'punched out' };
  if (key === 'job.create') {
    const name = (slots.name || '').trim();
    if (!name) return null;
    return { route: 'job', normalized: `create job ${name}` };
  }
  if (key === 'quote.send') {
    const client = (slots.client || '').trim();
    const quoteId = (slots.quote_id || '').trim();
    if (!client || !quoteId) return null;
    return { route: 'quote', normalized: `quote send ${client} ${quoteId}` };
  }
  if (key === 'budget.set') {
    const job = (slots.job || '').trim();
    const amount = slots.amount;
    if (!job || !amount) return null;
    return { route: 'budget', normalized: `budget set ${job} $${amount}` };
  }
  return null;
}

function fillTemplate(str, slots) {
  return String(str || '').replace(/\{([^}]+)\}/g, (_, key) => {
    const v = slots?.[key];
    return v == null ? '' : String(v);
  });
}

async function converseAndRoute(userText, { userProfile, ownerId, convoState, memory } = {}) {
  // FAST-PATH FOR TIME PROMPTS
  try {
    const pending = await getPendingPrompt(ownerId);
    if (pending) {
      return {
        handled: false,
        route: 'timeclock',
        normalized: userText,
        intent: 'timeclock.pending_prompt'
      };
    }
  } catch (e) {
    console.warn('[conversation] pending prompt check failed:', e?.message);
  }

  // FAST-PATH FOR TASKY UTTERANCES
  if (looksLikeTask(userText)) {
    try {
      const parsed = parseTaskUtterance(userText, { tz: userProfile?.tz || 'America/Toronto' });
      return {
        handled: false,
        route: 'tasks',
        normalized: `task - ${parsed.title}`,
        intent: 'tasks.create',
        args: {
          title: parsed.title,
          dueAt: parsed.dueAt,
          assigneeName: parsed.assignee || null,
        }
      };
    } catch (e) {
      console.warn('[conversation] task fast-path error:', e?.message);
    }
  }

  const input = normalize(userText);
  let { key, score } = matchIntent(userText);

  if (CONVERSATION_FALLBACK_ENABLED && (!key || score < MID)) {
    try {
      const ai = await routeWithAI(userText, { userProfile, convoState, memory });
      if (ai?.intent === 'timeclock.clock_in') key = 'timeclock.punch_in', score = HIGH;
      else if (ai?.intent === 'timeclock.clock_out') key = 'timeclock.punch_out', score = HIGH;
      else if (ai?.intent === 'job.create') key = 'job.create', score = HIGH;
      else if (ai?.intent === 'expense.add') key = 'expense.add', score = HIGH;
      else if (ai?.intent === 'tasks.list') key = 'tasks.list', score = HIGH;
      else if (ai?.intent === 'tasks.assign_all') key = 'tasks.assign_all', score = HIGH;
      else if (ai?.intent === 'quote.send') key = 'quote.send', score = HIGH;
      else if (ai?.intent === 'budget.set') key = 'budget.set', score = HIGH;
      else if (ai?.intent === 'memory.forget') key = 'memory.forget', score = HIGH;
      else if (ai?.intent === 'memory.show') key = 'memory.show', score = HIGH;
    } catch (_) {}
  }

  if (!key || score < MID) {
    return {
      handled: true,
      twiml:
        `<Response><Message>` +
        CFO.ask('I can help with tasks, time, expenses.') + `\n` +
        `• “task - buy tape”\n` +
        `• “tasks”\n` +
        `• “task @everyone - team standup at 8”\n` +
        CFO.follow('What do you want to do?') +
        `</Message></Response>`
    };
  }

  const def = CATALOG[key] || {};
  const slots = extractSlots(key, userText, convoState, memory);

  // Pending alias flow (optional)
  if (convoState?.pendingAlias && input === 'yes') {
    const { key: aliasKey, value } = convoState.pendingAlias;
    await upsertMemory(ownerId, userProfile.user_id, `alias.vendor.${aliasKey}`, { name: value });
    convoState.aliases = convoState.aliases || {};
    convoState.aliases[aliasKey] = value;
    convoState.pendingAlias = null;
    const response = CFO.confirm(`Saved “${aliasKey}” as ${value}. Now, what’s the expense details?`);
    return { handled: true, twiml: `<Response><Message>${response}</Message></Response>` };
  }

  // Missing required slots
  const missing = (def.required || []).filter(r => !slots[r]);
  if (missing.length) {
    const first = missing[0];
    const ask = def.asks?.[first] || `I need ${first}.`;
    const hint = def.personality_hints?.[0] ? def.personality_hints[0] + ' ' : '';
    const response = CFO.ask(`${hint}${ask}`);
    return { handled: true, twiml: `<Response><Message>${response}</Message></Response>`, intent: key };
  }

  // Inline memory intents
  if (key === 'memory.show') {
    const mem = await getMemory(ownerId, userProfile.user_id, []);
    const summary = Object.entries(mem || {}).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n') || 'Nothing yet!';
    const response = CFO.confirm(`Here’s what I know:\n${summary}`);
    return { handled: true, twiml: `<Response><Message>${response}</Message></Response>` };
  }
  if (key === 'memory.forget') {
    await forget(ownerId, userProfile.user_id, slots.key);
    const response = CFO.confirm(`Forgot ${slots.key}. Anything else?`);
    return { handled: true, twiml: `<Response><Message>${response}</Message></Response>` };
  }

  // Normalize for handlers
  const norm = normalizeForHandlers(key, slots);
  if (norm) {
    const confirmLine = fillTemplate(def.confirm || 'Okay.', slots);
    const follow = def.follow_up_prompts?.[0] || 'What’s next?';
    const response = CFO.confirm(`${confirmLine} ${follow}`);
    return { handled: false, ...norm, twiml: `<Response><Message>${response}</Message></Response>`, intent: key, args: slots };
  }

  return {
    handled: true,
    twiml: `<Response><Message>${CFO.ask('Got it. Want to create a task, list your tasks, or send one to everyone?')}</Message></Response>`
  };
}

module.exports = { converseAndRoute };
