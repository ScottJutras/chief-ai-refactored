// services/agent/index.js
// ------------------------------------------------------------
// Chief Agent: topic-aware RAG + LLM + tool-calls (confirm → execute)
// NORTHSTAR: no dead ends, fast paths, provider-agnostic, audit-friendly
// ------------------------------------------------------------

const { LLMProvider } = require('../llm');
const { CHIEF_SYSTEM_PROMPT } = require('../../prompts/chief.system');
const txTools = require('../agentTools/transactions');

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

  // -------------------------------------------------------
  // ✅ Transactions (read-only): Tool A/B/C
  // These are "truth tools" for the brain. No writes.
  // -------------------------------------------------------
  const txToolSpecs = [
    {
      type: 'function',
      function: {
        name: 'search_transactions',
        description: 'Search confirmed transactions for this owner with filters. Read-only.',
        parameters: {
          type: 'object',
          required: ['owner_id'],
          properties: {
            owner_id: { type: 'string' },
            kind: { type: 'string', enum: ['expense', 'revenue', 'bill', 'quote', 'invoice', 'receipt'] },
            date_from: { type: 'string', description: 'YYYY-MM-DD' },
            date_to: { type: 'string', description: 'YYYY-MM-DD' },
            source_contains: { type: 'string' },
            description_contains: { type: 'string' },
            category: { type: 'string' },
            job_id: { type: 'string', description: 'UUID' },
            job_name_contains: { type: 'string' },
            min_amount_cents: { type: 'integer' },
            max_amount_cents: { type: 'integer' },
            limit: { type: 'integer', default: 25, maximum: 100 },
            offset: { type: 'integer', default: 0, maximum: 10000 }
          }
        }
      },
      __handler: async (args) => txTools.search_transactions(args)
    },
    {
      type: 'function',
      function: {
        name: 'get_transaction',
        description: 'Fetch a single confirmed transaction by id for this owner. Read-only.',
        parameters: {
          type: 'object',
          required: ['owner_id', 'id'],
          properties: {
            owner_id: { type: 'string' },
            id: { type: 'integer' }
          }
        }
      },
      __handler: async (args) => txTools.get_transaction(args)
    },
    {
      type: 'function',
      function: {
        name: 'get_spend_summary',
        description: 'Summarize confirmed expenses for a date range, optionally scoped to a job. Read-only.',
        parameters: {
          type: 'object',
          required: ['owner_id', 'date_from', 'date_to'],
          properties: {
            owner_id: { type: 'string' },
            date_from: { type: 'string', description: 'YYYY-MM-DD' },
            date_to: { type: 'string', description: 'YYYY-MM-DD' },
            job_id: { type: 'string', description: 'UUID' },
            job_name_contains: { type: 'string' }
          }
        }
      },
      __handler: async (args) => txTools.get_spend_summary(args)
    }
  ];

  for (const t of txToolSpecs) {
    reg[t.function.name] = t.__handler;
    toolsSpec.push(t);
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

      // Standardize ownerId vs owner_id expectations:
      // Our tx tools use owner_id; your other tools use ownerId.
      if (ownerId && args.owner_id == null) args.owner_id = String(ownerId);
      if (ownerId && args.ownerId == null) args.ownerId = String(ownerId);

      if (from && args.fromPhone == null) args.fromPhone = String(from);

      if (args.text == null && messages) {
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
    messages = [
      { role: 'system', content: 'You are Chief. If all required details were present, confirm success with a concise checkmark line and any IDs. If details were missing, ask exactly one clarifying question.' },
      ...messages
    ];
  }

  return genericMenu();
}

// ----- Public ask API --------------------------------------
async function ask({ from, ownerId, text, topicHints = [], userProfile } = {}) {
  if (!canUseAgent(userProfile)) {
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

  if (/\b(what can i do|what can i do here|help|how to|how do i|what now)\b/i.test(lc)) {
    return genericMenu();
  }

  const topic = pickTopic(text, topicHints);
  console.log('[AGENT] topic:', topic || 'generic', 'text:', text);

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

  const llm = new LLMProvider({
    provider: process.env.LLM_PROVIDER || 'openai',
    model: process.env.LLM_MODEL || 'gpt-4o-mini'
  });

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
