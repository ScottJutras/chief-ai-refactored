// services/agent/index.js
// Thin shim that routes Q&A to your RAG tool if present, with topic-aware fallback.

let rag = null;
try {
  rag = require('../tools/rag');
  console.log('[AGENT] RAG loaded successfully');
} catch (err) {
  console.error('[AGENT] Failed to load RAG:', err.message);
  rag = null;
}

// --- Topic detector ---------------------------------------------------------
function pickTopic(text = '', hints = []) {
  const t = String(text || '').toLowerCase();

  // Normalize hints and prefer explicit ones
  const hintSet = new Set((hints || []).map(h => String(h).toLowerCase()));
  if (hintSet.has('jobs')) return 'jobs';
  if (hintSet.has('tasks')) return 'tasks';
  if (hintSet.has('timeclock')) return 'timeclock';

  // Direct keyword checks
  if (/\b(job|jobs|active job|set active|close job|list jobs|move last log)\b/.test(t)) return 'jobs';
  if (/\b(task|tasks|due date|assign|my tasks|done #?\d+|mark done)\b/.test(t)) return 'tasks';
  if (/\b(clock in|punch in|clock out|punch out|break|drive|timesheet|hours)\b/.test(t)) return 'timeclock';

  // “How do I use X?” forms
  if (/\bhow (do|to)\b.*\bjob(s)?\b/.test(t)) return 'jobs';
  if (/\bhow (do|to)\b.*\btask(s)?\b/.test(t)) return 'tasks';
  if (/\bhow (do|to)\b.*\b(clock|time|break|drive|timesheet|hours)\b/.test(t)) return 'timeclock';

  return null; // generic / menu
}

/**
 * Ask the agent (RAG) for an answer.
 * @param {{from:string, text:string, topicHints?:string[]}} args
 * @returns {Promise<string>}
 */
async function ask({ from, text, topicHints = [] }) {
  const topic = pickTopic(text, topicHints);
  console.log('[AGENT] topic:', topic || 'generic', 'text:', text);

  // If nothing in text or hints screams a topic, show a concise menu
  const isGeneric =
  !topic &&
  /\b(what can i do|what can i do here|help|how to|how do i|what now)\b/i.test(String(text || '').toLowerCase());

if (isGeneric) {
  return [
    'PocketCFO — What I can do:',
    '• **Jobs**: create job, set active job, list jobs, close job',
    '• **Tasks**: task – buy nails, my tasks, done #4, due #3 Friday',
    '• **Timeclock**: clock in, clock out, start break, timesheet',
    '• **Money**: expense $50, revenue $500, bill $200',
    '• **Reports**: metrics, tax, quotes',
    '• Ask me anything — I’ll search your SOPs!'
  ].join('\n');
}

    // Prefer RAG if present
  if (rag) {
    const fn = rag.answer || rag.ask || rag.query;
    if (typeof fn === 'function') {
      console.log('[AGENT] RAG available:', !!rag);
      console.log('[AGENT] Calling RAG with query:', text);
      // Pass topic in hints so your RAG can bias retrieval
      const hints = topic ? Array.from(new Set([topic, ...topicHints])) : topicHints;
      const out = await fn({ from, query: text, hints });
      if (out && typeof out === 'string' && out.trim()) {
        console.log('[AGENT] RAG returned:', out.slice(0, 200) + '...');
        return out;
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
