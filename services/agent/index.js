// services/agent/index.js
// Thin shim that routes Q&A to your RAG tool if present, with a safe fallback.

let rag = null;
try {
  // Prefer your existing RAG tool if available
  rag = require('../tools/rag'); // adapt if your path differs
} catch (_) {
  rag = null;
}

/**
 * Ask the agent (RAG) for an answer.
 * @param {{from:string, text:string, topicHints?:string[]}} args
 * @returns {Promise<string>}
 */
async function ask({ from, text, topicHints = [] }) {
  // Try common exported shapes from a RAG module
  if (rag) {
    if (typeof rag.answer === 'function') {
      return rag.answer({ from, query: text, hints: topicHints });
    }
    if (typeof rag.ask === 'function') {
      return rag.ask({ from, query: text, hints: topicHints });
    }
    if (typeof rag.query === 'function') {
      return rag.query({ from, query: text, topics: topicHints });
    }
  }

  // Safe fallback so UX doesn’t crash if RAG is not wired yet
  const hint = (topicHints && topicHints.length) ? topicHints.join(', ') : 'docs';
  return [
    `Here’s what to know (${hint}):`,
    '',
    '• **Clock in** – “clock in” uses your active job, or say “clock in @ Roof Repair 7am”.',
    '• **Clock out** – “clock out” ends the open shift. If I need the time, I’ll ask.',
    '• **Break/Drive** – “start break”, “end break”, “start drive”, “end drive”.',
    '• For another user – “clock in Justin @ Roof Repair 5pm” (Owner/Board only).',
  ].join('\n');
}

module.exports = { ask };
