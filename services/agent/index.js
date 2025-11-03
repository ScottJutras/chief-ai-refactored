// services/agent/index.js
// Thin shim that routes Q&A to your RAG tool if present, with topic-aware fallback.

// ----- Lazy RAG loader (prevents cold-start hangs at module load) -----
let rag = null, ragTried = false;
function getRag() {
  if (ragTried) return rag;
  ragTried = true;
  try {
    rag = require('../tools/rag');
    console.log('[AGENT] RAG loaded successfully');
  } catch (err) {
    console.warn('[AGENT] No RAG available:', err?.message);
    rag = null;
  }
  return rag;
}

// --- Topic detector ---------------------------------------------------------
function pickTopic(text = '', hints = []) {
  const t = String(text || '').toLowerCase();

  // 1. Hints override everything
  const hintSet = new Set((hints || []).map(h => String(h).toLowerCase()));
  if (hintSet.has('jobs')) return 'jobs';
  if (hintSet.has('tasks')) return 'tasks';
  if (hintSet.has('timeclock')) return 'timeclock';

  // 2. Generic help — EARLIEST to block all other matches
  if (/\b(what can i do|what can i do here|help|how to|how do i|what now)\b/i.test(t)) {
    return null;
  }

  // 3. Direct keyword checks
  if (/\b(job|jobs|active job|set active|close job|list jobs|move last log)\b/.test(t)) return 'jobs';
  if (/\b(task|tasks|due date|assign|my tasks|done #?\d+|mark done)\b/.test(t)) return 'tasks';
  if (/\b(clock in|punch in|clock out|punch out|break|drive|timesheet|hours)\b/.test(t)) return 'timeclock';

  // 4. “How do I use X?” — only if not generic
  if (/\bhow (do|to)\b.*\b(job|jobs)\b/.test(t)) return 'jobs';
  if (/\bhow (do|to)\b.*\b(task|tasks)\b/.test(t)) return 'tasks';
  if (/\bhow (do|to)\b.*\b(clock|time|break|drive|timesheet|hours)\b/.test(t)) return 'timeclock';

  return null; // generic / menu
}

/**
 * Ask the agent (RAG) for an answer.
 * @param {{from:string, text:string, topicHints?:string[]}} args
 * @returns {Promise<string>}
 */
async function ask({ from, text, topicHints = [] }) {
  const lc = String(text || '').toLowerCase();

  // 1) Generic help phrases -> show menu EARLY (ignore hints)
  const isGeneric = /\b(what can i do|what can i do here|help|how to|how do i|what now)\b/i.test(lc);
  if (isGeneric) {
    console.log('[AGENT] generic menu path hit');
    return [
      'PocketCFO — What I can do:',
      '• **Jobs**: create job, set active job, list jobs, close job',
      '• **Tasks**: task – buy nails, my tasks, done #4, due #3 Friday',
      '• **Timeclock**: clock in, clock out, start break, timesheet',
      '• **Money**: expense $50, revenue $500, bill $200',
      '• **Reports**: metrics, tax, quotes',
      '• Ask me anything — I’ll search your SOPs!',
    ].join('\n');
  }

  // 2) Otherwise, detect topic (may use hints)
  const topic = pickTopic(text, topicHints);
  console.log('[AGENT] topic:', topic || 'generic', 'text:', text);

  // Prefer RAG if present
  const ragMod = getRag();
  if (ragMod) {
    const fn = ragMod.answer || ragMod.ask || ragMod.query;
    if (typeof fn === 'function') {
      try {
        console.log('[AGENT] Calling RAG with query:', text);
        const hints = topic ? Array.from(new Set([topic, ...topicHints])) : topicHints;
        const out = await fn({ from, query: text, hints });
        if (out && typeof out === 'string' && out.trim()) {
          console.log('[AGENT] RAG returned:', out.slice(0, 200) + '...');
          return out;
        }
      } catch (e) {
        console.warn('[AGENT] RAG call failed:', e?.message);
      }
    }
  }

  // Topic-aware fallback (if RAG missing or returned nothing)
  if (topic === 'jobs') {
    return [
      'Jobs — quick guide:',
      '• create job <name>',
      '• list jobs',
      '• set active job <name>',
      '• active job?',
      '• close job <name>',
      '• move last log to <name>',
    ].join('\n');
  }

  if (topic === 'tasks') {
    return [
      'Tasks — quick guide:',
      '• task – buy nails  (adds to active job)',
      '• task Roof Repair – order shingles  (explicit job)',
      '• task @Justin – pick up materials  (assign)',
      '• tasks  /  my tasks  (list)',
      '• done #4  (mark done)',
      '• add due date Friday to task 3',
    ].join('\n');
  }

  // Default to timeclock help
  return [
    'Here’s what to know (timeclock):',
    '• **Clock in** – “clock in” uses your active job, or “clock in @ Roof Repair 7am”.',
    '• **Clock out** – “clock out” ends the open shift. If a time is missing, I’ll ask.',
    '• **Break/Drive** – “start break”, “end break”, “start drive”, “end drive”.',
    '• **Another user** – “clock in Justin @ Roof Repair 5pm” (Owner/Board only).',
  ].join('\n');
}

/**
 * Back-compat shim for older call sites that used runAgent({...}).
 * Accepts shapes like: { ownerId, fromPhone, text, topicHints }
 */
async function runAgent(opts = {}) {
  const from = opts.fromPhone || opts.from || '';
  const text = opts.text || opts.query || '';
  const topicHints = opts.topicHints || opts.hints || [];
  return ask({ from, text, topicHints });
}

module.exports = { ask, runAgent };
