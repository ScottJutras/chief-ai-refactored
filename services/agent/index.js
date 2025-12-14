// services/agent/index.js
// ------------------------------------------------------------
// Chief Agent: topic-aware RAG + LLM + tool-calls (confirm → execute)
// NORTHSTAR: no dead ends, fast paths, provider-agnostic, audit-friendly
// ------------------------------------------------------------

const { LLMProvider } = require('../llm');
const { CHIEF_SYSTEM_PROMPT } = require('../../prompts/chief.system');

// ----- Subscription gate (free/basic can't use Agent) -----
function canUseAgent(userProfile) {
  const tier = (userProfile?.subscription_tier || 'basic').toLowerCase();
  return tier !== 'basic';
}

// ----- Lazy RAG loader (prevents cold-start stalls) -----
let rag = null, ragTried = false;
function getRag() {
  if (ragTried) return rag;
  ragTried = true;
  try {
    rag = require('../tools/rag'); // { answer, ragTool }
    console.log('[AGENT] RAG loaded successfully');
  } catch (err) {
    console.warn('[AGENT] No RAG available:', err?.message);
    rag = null;
  }
  return rag;
}

// ----- Lazy tools (wrappers around existing handlers) -----
let TOOL_REGISTRY = null;
function getTools() {
  if (TOOL_REGISTRY) return TOOL_REGISTRY;

  const reg = {};
  const toolsSpec = [];

  // RAG
  const ragMod = getRag();
  if (ragMod?.ragTool) {
    reg[ragMod.ragTool.function.name] = ragMod.ragTool.__handler;
    toolsSpec.push(ragMod.ragTool);
  }

  // Tasks
  try {
    const { tasksTool } = require('../tools/tasks'); // __handler({text,ownerId,fromPhone})
    reg[tasksTool.function.name] = tasksTool.__handler;
    toolsSpec.push(tasksTool);
  } catch (e) {
    console.warn('[AGENT] tasks tool not available:', e?.message);
  }

  // Jobs
  try {
    const { jobTool } = require('../tools/job'); // __handler({text,ownerId,fromPhone})
    reg[jobTool.function.name] = jobTool.__handler;
    toolsSpec.push(jobTool);
  } catch (e) {
    console.warn('[AGENT] jobs tool not available:', e?.message);
  }

  TOOL_REGISTRY = { reg, toolsSpec };
  return TOOL_REGISTRY;
}

// ----- Topic detector (cheap + deterministic) --------------
function pickTopic(text = '', hints = []) {
  const t = String(text || '').toLowerCase();

  // Hints override everything
  const hintSet = new Set((hints || []).map(h => String(h).toLowerCase()));
  if (hintSet.has('jobs')) return 'jobs';
  if (hintSet.has('tasks')) return 'tasks';
  if (hintSet.has('timeclock')) return 'timeclock';

  // Generic help — earliest
  if (/\b(what can i do|what can i do here|help|how to|how do i|what now)\b/i.test(t)) {
    return null;
  }

  // Direct keyword checks
  if (/\b(job|jobs|active job|set active|close job|list jobs|move last log)\b/.test(t)) return 'jobs';
  if (/\b(task|tasks|due date|assign|my tasks|done #?\d+|mark done)\b/.test(t)) return 'tasks';
  if (/\b(clock in|punch in|clock out|punch out|break|drive|timesheet|hours)\b/.test(t)) return 'timeclock';

  // “How do I use X?”
  if (/\bhow (do|to)\b.*\b(job|jobs)\b/.test(t)) return 'jobs';
  if (/\bhow (do|to)\b.*\b(task|tasks)\b/.test(t)) return 'tasks';
  if (/\bhow (do|to)\b.*\b(clock|time|break|drive|timesheet|hours)\b/.test(t)) return 'timeclock';

  return null; // generic/menu
}

// ----- Generic menu (never dead-ends) ----------------------
function genericMenu() {
  return [
    'PocketCFO — What I can do:',
    '• **Jobs**: create job, set active job, list jobs, close job',
    '• **Tasks**: task – buy nails, my tasks, done #4, due #3 Friday',
    '• **Timeclock**: clock in/out, start break, timesheet',
    '• **Money**: expense $50, revenue $500, bill $200',
    '• **Reports**: metrics, quotes, tax',
    '• Ask me anything — I’ll search your SOPs!',
  ].join('\n');
}

// ----- Tool runner (exec OpenAI tool_calls using our handlers) -----
async function runToolsLoop({ llm, seedMessages, ownerId, from }) {
  const { reg, toolsSpec } = getTools();

  // First call with tools
  let messages = seedMessages.slice();
  let step = 0;
  const MAX_STEPS = 2; // keep latency bounded

  while (step < MAX_STEPS) {
    step += 1;
    const m = await llm.chat({ messages, tools: toolsSpec, temperature: 0.2 });

    // If no tool calls → return assistant text
    const toolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : m?.tool_calls;
    const content = (m.content || '').trim();
    if (!toolCalls || toolCalls.length === 0) {
      if (content) return content;
      // If no content and no tool calls, bail to menu
      return genericMenu();
    }

    // Execute each tool in order
    for (const call of toolCalls) {
      const name = call.function?.name;
      const rawArgs = call.function?.arguments || '{}';

      if (!name || !reg[name]) {
        console.warn('[AGENT] unknown tool:', name);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: 'unknown_tool' }) });
        continue;
      }

      // Parse args, inject context
      let args;
      try { args = JSON.parse(rawArgs || '{}'); } catch { args = {}; }
      // Ensure context fields are present for our wrappers
      if (ownerId && args.ownerId == null) args.ownerId = String(ownerId);
      if (from && args.fromPhone == null) args.fromPhone = String(from);
      if (args.text == null && messages) {
        // Fallback: last user message text
        const lastUser = [...messages].reverse().find(x => x.role === 'user');
        if (lastUser?.content) args.text = String(lastUser.content);
      }

      let result;
      try {
        result = await reg[name](args);
      } catch (e) {
        console.error('[AGENT] tool error:', name, e?.message);
        result = { error: e?.message || 'tool_error' };
      }

      // Push tool result back to LLM
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result ?? {}),
      });
    }

    // After executing tools, ask LLM to produce final user-facing message
    // Add a short system nudge to confirm/execute pattern & clarity.
    messages = [
      { role: 'system', content: 'You are Chief. If all required details were present, confirm success with a concise checkmark line and any IDs. If details were missing, ask exactly one clarifying question.' },
      ...messages
    ];
  }

  // Safety fallback
  return genericMenu();
}

// ----- Public ask API --------------------------------------
/**
 * ask({ from, ownerId, text, topicHints, userProfile })
 * - RAG first (cheap + fast)
 * - If not sufficient → LLM + tools (confirm → execute)
 * - Always returns a helpful string
 */
async function ask({ from, ownerId, text, topicHints = [], userProfile } = {}) {
  // Gate by plan
  if (!canUseAgent(userProfile)) {
    // Light nudge for upgrade but still be helpful:
    const ragMod = getRag();
    if (ragMod?.answer) {
      try {
        const out = await ragMod.answer({ from, query: text, hints: topicHints, ownerId });
        if (out && out.trim()) return out;
      } catch {}
    }
    return genericMenu();
  }

  const lc = String(text || '').toLowerCase();

  // Immediate generic menu
  if (/\b(what can i do|what can i do here|help|how to|how do i|what now)\b/i.test(lc)) {
    return genericMenu();
  }

  const topic = pickTopic(text, topicHints);
  console.log('[AGENT] topic:', topic || 'generic', 'text:', text);

  // 1) Try RAG answer fast (no model call if your rag.answer composes locally)
  const ragMod = getRag();
  if (ragMod?.answer) {
    try {
      const hints = topic ? Array.from(new Set([topic, ...topicHints])) : topicHints;
      const out = await ragMod.answer({ from, query: text, hints, ownerId });
      if (out && out.trim()) return out;
    } catch (e) {
      console.warn('[AGENT] RAG call failed:', e?.message);
    }
  }

  // 2) LLM with tool-calls: confirm → execute (bounded loop)
  const llm = new LLMProvider({
    provider: process.env.LLM_PROVIDER || 'openai',
    model: process.env.LLM_MODEL || 'gpt-4o-mini'
  });

  const topicPrompt = topic ? `Focus on ${topic}.` : '';
  const seed = [
  {
    role: 'system',
    content: `${CHIEF_SYSTEM_PROMPT}

Execution rules:
- If details are sufficient: use tools, then reply with "✅ <short confirmation>" (+ IDs if relevant).
- If details are missing: ask exactly ONE clarifying question (do not execute yet).
- Never dead-end; always offer the next best action.`
  },
  { role: 'user', content: text }
];

  try {
    return await runToolsLoop({ llm, seedMessages: seed, ownerId, from });
  } catch (e) {
    console.warn('[AGENT] tools loop failed:', e?.message);
    // 3) Last resort: generic help
    return genericMenu();
  }
}

// ----- Back-compat shim ------------------------------------
async function runAgent(opts = {}) {
  const from = opts.fromPhone || opts.from || '';
  const text = opts.text || opts.query || '';
  const topicHints = opts.topicHints || opts.hints || [];
  const ownerId = opts.ownerId;
  const userProfile = opts.userProfile;
  return ask({ from, ownerId, text, topicHints, userProfile });
}

module.exports = { ask, runAgent, canUseAgent };
