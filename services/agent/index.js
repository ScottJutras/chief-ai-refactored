// services/agent/index.js
// ------------------------------------------------------------
// Chief Agent: topic-aware RAG + LLM + tool-calls (confirm → execute)
// NORTHSTAR: no dead ends, fast paths, provider-agnostic, audit-friendly
// ------------------------------------------------------------
const pg = require('../postgres');
const { LLMProvider } = require('../llm');
const { CHIEF_SYSTEM_PROMPT } = require('../../prompts/chief.system');
const txTools = require('../agentTools/transaction');

// ✅ correct path from /services/agent → /src/config
const { getEffectivePlanKey } = require('../../src/config/getEffectivePlanKey');

// ----- Subscription gate (free/starter can't use Agent) -----
function canUseAgent(ownerProfile) {
  // Ask Chief unlocks on Starter, so Agent should too.
  const k = getEffectivePlanKey(ownerProfile);
  return k === "starter" || k === "pro";
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
    "Here’s what I can do right now:",
    "",
    "If you want to **log something**, send one of these:",
    "• task - buy nails",
    "• expense $52 Home Depot",
    "• revenue $500 deposit",
    "• clock in / clock out",
    "",
    "If you want an **answer**, ask:",
    "• what’s my cashflow this month?",
    "• profit on job 1556",
    "• what did I log today?",
    "",
    "Tell me: **log** or **question** — and I’ll drive."
  ].join("\n");
}

// ----- Canonical conversational helpers --------------------
function DIGITS_ONLY(x) {
  return String(x ?? "").replace(/\D/g, "");
}

function normBare(s = "") {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "");
}

function safeJson(obj) {
  return obj && typeof obj === "object" ? obj : {};
}

async function loadActorMemorySafe(ownerId, actorKey) {
  try {
    if (!pg?.getActorMemory) return {};
    return safeJson(await pg.getActorMemory(ownerId, actorKey));
  } catch {
    return {};
  }
}

async function patchActorMemorySafe(ownerId, actorKey, patch) {
  try {
    if (!pg?.patchActorMemory) return;
    await pg.patchActorMemory(ownerId, actorKey, safeJson(patch));
  } catch {
    // never block user reply
  }
}

// Choice detectors
function isLogChoice(text = "") {
  const s = normBare(text);
  return s === "log" || s === "logging" || s === "log something";
}

function isQuestionChoice(text = "") {
  const s = normBare(text);
  return s === "question" || s === "questions" || s === "ask" || s === "answer" || s === "answers" || s === "insight";
}

// Bare intent detectors
function isBareExpense(text = "") {
  const s = normBare(text);
  return s === "expense" || s === "an expense" || s === "a expense";
}

function isBareRevenue(text = "") {
  const s = normBare(text);
  return s === "revenue" || s === "a revenue" || s === "an revenue";
}

function isBareTask(text = "") {
  const s = normBare(text);
  return s === "task" || s === "a task" || s === "an task" || s === "todo" || s === "a todo" || s === "to-do";
}

function isBareTime(text = "") {
  const s = normBare(text);
  return (
    s === "time" ||
    s === "clock" ||
    s === "clock in" ||
    s === "clock out" ||
    s === "timesheet" ||
    s === "hours"
  );
}

function isBareJob(text = "") {
  const s = normBare(text);
  return s === "job" || s === "jobs" || s === "a job" || s === "an job";
}

// Lightweight “did they provide the missing core?” detectors
function hasMoney(text = "") {
  return /\$?\s*\d+(\.\d{1,2})?\b/.test(String(text || ""));
}

function looksLikeClockCmd(text = "") {
  const s = normBare(text);
  return s === "clock in" || s === "clock out" || s === "start break" || s === "end break";
}

function looksLikeJustANumber(text = "") {
  const s = normBare(text);
  return /^\d+(\.\d{1,2})?$/.test(s) || /^\$\d+(\.\d{1,2})?$/.test(s);
}

function getTodayIso(tz = "America/Toronto") {
  try {
    if (pg?.todayInTZ) return pg.todayInTZ(tz);
  } catch {}
  return new Date().toISOString().slice(0, 10);
}

function extractMoneyText(text = "") {
  const s = String(text || "").trim();
  const m = s.match(/(\$?\s*\d+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const raw = m[1].replace(/\s+/g, "");
  return raw.startsWith("$") ? raw : `$${raw}`;
}

function extractIsoDate(text = "", tz = "America/Toronto") {
  const s = normBare(text);

  const m = s.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (m) return m[1];

  if (s === "today") return getTodayIso(tz);

  if (s === "yesterday") {
    const t = getTodayIso(tz);
    const d = new Date(`${t}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  return null;
}

function cleanVendorOrDesc(text = "") {
  return String(text || "").trim().replace(/[.!?]+$/g, "").trim();
}

function buildExpenseCommand({ amountText, vendor, dateIso } = {}) {
  const parts = ["expense"];
  if (amountText) parts.push(amountText);
  if (vendor) parts.push(vendor);
  if (dateIso) parts.push(dateIso);
  return parts.join(" ");
}

function buildRevenueCommand({ amountText, desc, dateIso } = {}) {
  const parts = ["revenue"];
  if (amountText) parts.push(amountText);
  if (desc) parts.push(desc);
  if (dateIso) parts.push(dateIso);
  return parts.join(" ");
}

function buildTaskCommand({ taskText } = {}) {
  return `task - ${String(taskText || "").trim()}`;
}

function logMenu() {
  return [
    "Cool — what are we logging?",
    "",
    "Reply with one: **expense**, **revenue**, **time**, or **task**.",
    "",
    "Examples:",
    "• expense $52 Home Depot",
    "• revenue $500 deposit",
    "• clock in",
    "• task - buy nails"
  ].join("\n");
}

function questionMenu() {
  return [
    "Alright — ask it straight.",
    "",
    "Examples:",
    "• what’s my cashflow this month?",
    "• profit on job 1556",
    "• what did I log today?"
  ].join("\n");
}

// ----- Tool-calling loop -----------------------------------
const MAX_TOOL_ITERATIONS = 6;

async function runToolsLoop({ llm, seedMessages, ownerId, from }) {
  const { toolsSpec, reg } = getTools();
  const messages = [...seedMessages];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const msg = await llm.chat({ messages, tools: toolsSpec });

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return String(msg.content || '').trim() || genericMenu();
    }

    messages.push(msg);

    for (const tc of msg.tool_calls) {
      const name = tc.function?.name;
      const handler = reg[name];
      let result;
      try {
        const args = JSON.parse(tc.function?.arguments || '{}');
        // Ensure owner_id is always scoped correctly
        args.owner_id = args.owner_id || ownerId;
        result = handler ? await handler(args) : { error: `Unknown tool: ${name}` };
      } catch (e) {
        result = { error: e?.message };
      }
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }

  // Exceeded max iterations without a final text reply
  return genericMenu();
}

// ----- Public ask API --------------------------------------
async function ask({ from, ownerId, text, topicHints = [], ownerProfile } = {}) {
  const raw = String(text || '').trim();
  const lc = normBare(raw);

  const ownerDigits = DIGITS_ONLY(ownerId);
  const actorKey = DIGITS_ONLY(from) || ownerDigits; // WhatsApp "from" is your actor identity

  // Load memory (best-effort)
  const memory = await loadActorMemorySafe(ownerDigits, actorKey);
  const pending_choice = String(memory?.pending_choice || '').toLowerCase().trim(); // 'log' | 'question'
  const pending_intent = String(memory?.pending_intent || '').toLowerCase().trim(); // 'expense'|'revenue'|'task'|'time'|'job'

  // If Agent not available for this plan, still give a non-dead-end reply
  if (!canUseAgent(ownerProfile)) {
    // If they’re mid-flow, still help
    if (pending_choice === 'log') {
      return `Got it. What are you logging — expense, revenue, task, or time?`;
    }
    if (pending_choice === 'question') {
      return `Ask away — what do you want to know? (cashflow, profit on a job, what you logged today, etc.)`;
    }

    const ragMod = getRag();
    if (ragMod?.answer) {
      try {
        const out = await ragMod.answer({ from, query: raw, hints: topicHints, ownerId: ownerDigits });
        if (out && out.trim()) return out;
      } catch {}
    }
    return genericMenu();
  }

  // 0) Help/menu
  if (/\b(what can i do|what can i do here|help|how to|how do i|what now)\b/i.test(lc)) {
    // reset stale flow state to avoid weird followups
    await patchActorMemorySafe(ownerDigits, actorKey, { pending_choice: null, pending_intent: null });
    return genericMenu();
  }

  // 1) Deterministic choice handling + memory
  if (isLogChoice(raw)) {
    await patchActorMemorySafe(ownerDigits, actorKey, { pending_choice: 'log', pending_intent: null });
    // One best next question (ChatGPT-like)
    return `Got it. What are you logging — **expense**, **revenue**, **task**, **time**, or **job**?`;
  }

  if (isQuestionChoice(raw)) {
    await patchActorMemorySafe(ownerDigits, actorKey, { pending_choice: 'question', pending_intent: null });
    // One best next question (ChatGPT-like)
    return `Okay — what do you want to know?`;
  }

  // 2) If we already know they’re logging, treat bare intents as a continuation (NOT a new convo)
  if (pending_choice === 'log') {
  if (isBareExpense(raw)) {
    await patchActorMemorySafe(ownerDigits, actorKey, {
      pending_intent: 'expense',
      intake_draft: { kind: 'expense', amountText: null, vendor: null, dateIso: null }
    });
    return `How much was it?`;
  }

  if (isBareRevenue(raw)) {
    await patchActorMemorySafe(ownerDigits, actorKey, {
      pending_intent: 'revenue',
      intake_draft: { kind: 'revenue', amountText: null, desc: null, dateIso: null }
    });
    return `How much came in?`;
  }

  if (isBareTask(raw)) {
    await patchActorMemorySafe(ownerDigits, actorKey, {
      pending_intent: 'task',
      intake_draft: { kind: 'task', taskText: null }
    });
    return `What’s the task?`;
  }

  if (isBareTime(raw)) {
    await patchActorMemorySafe(ownerDigits, actorKey, {
      pending_intent: 'time',
      intake_draft: { kind: 'time' }
    });
    return `Clock **in** or **out**?`;
  }

  if (isBareJob(raw)) {
    await patchActorMemorySafe(ownerDigits, actorKey, {
      pending_intent: 'job',
      intake_draft: { kind: 'job' }
    });
    return `Create a job, list jobs, or set active?`;
  }
}

   // 3) Draft-driven log flows (ChatGPT-like: one question at a time)
  const tz = ownerProfile?.tz || 'America/Toronto';
  const intake = safeJson(memory?.intake_draft || {});
  const intakeKind = String(intake?.kind || '').toLowerCase().trim();

  // ---------------- EXPENSE ----------------
  if (pending_choice === 'log' && pending_intent === 'expense') {
    // Ensure draft exists
    if (intakeKind !== 'expense') {
      await patchActorMemorySafe(ownerDigits, actorKey, {
        intake_draft: { kind: 'expense', amountText: null, vendor: null, dateIso: null }
      });
      return `How much was it?`;
    }

    // If they provided a date at any time, capture it
    const maybeDate = extractIsoDate(raw, tz);
    if (maybeDate && !intake.dateIso) {
      await patchActorMemorySafe(ownerDigits, actorKey, {
        intake_draft: { dateIso: maybeDate }
      });
    }

    // 1) Need amount
    if (!intake.amountText) {
      const amt = extractMoneyText(raw);
      if (!amt) return `How much was it?`;

      await patchActorMemorySafe(ownerDigits, actorKey, {
        intake_draft: { amountText: amt }
      });

      return `✅ Got it — expense ${amt}. Where was it from?`;
    }

    // 2) Need vendor
    if (!intake.vendor) {
      // If user just repeats amount again, re-ask vendor
      if (looksLikeJustANumber(raw)) {
        return `Where was it from?`;
      }

      const vendor = cleanVendorOrDesc(raw);
      if (!vendor) return `Where was it from?`;

      // If the vendor text *also* contains a date, extract it
      const dateIso = extractIsoDate(vendor, tz) || intake.dateIso || null;

      await patchActorMemorySafe(ownerDigits, actorKey, {
        intake_draft: { vendor, dateIso }
      });

      const cmd = buildExpenseCommand({ amountText: intake.amountText, vendor, dateIso });
      // Clear flow state so they don’t get stuck
      await patchActorMemorySafe(ownerDigits, actorKey, {
        pending_choice: null,
        pending_intent: null,
        intake_draft: null
      });

      return `✅ Logged: ${cmd}`;
    }

    // If somehow complete already, finalize
    const cmd = buildExpenseCommand({
      amountText: intake.amountText,
      vendor: intake.vendor,
      dateIso: intake.dateIso || null
    });
    await patchActorMemorySafe(ownerDigits, actorKey, {
      pending_choice: null,
      pending_intent: null,
      intake_draft: null
    });
    return `✅ Logged: ${cmd}`;
  }

  // ---------------- REVENUE ----------------
  if (pending_choice === 'log' && pending_intent === 'revenue') {
    if (intakeKind !== 'revenue') {
      await patchActorMemorySafe(ownerDigits, actorKey, {
        intake_draft: { kind: 'revenue', amountText: null, desc: null, dateIso: null }
      });
      return `How much came in?`;
    }

    const maybeDate = extractIsoDate(raw, tz);
    if (maybeDate && !intake.dateIso) {
      await patchActorMemorySafe(ownerDigits, actorKey, {
        intake_draft: { dateIso: maybeDate }
      });
    }

    // 1) Need amount
    if (!intake.amountText) {
      const amt = extractMoneyText(raw);
      if (!amt) return `How much came in?`;

      await patchActorMemorySafe(ownerDigits, actorKey, {
        intake_draft: { amountText: amt }
      });

      return `✅ Got it — revenue ${amt}. What was it for? (optional)`;
    }

    // 2) Optional description — if they type anything non-empty, we’ll capture and finalize.
    const desc = cleanVendorOrDesc(raw);
    const dateIso = extractIsoDate(desc, tz) || intake.dateIso || null;

    // If they reply “skip”, finalize with no desc
    const skip = normBare(desc) === 'skip' || normBare(desc) === 'no' || normBare(desc) === 'none';
    const finalDesc = skip ? null : (desc || null);

    const cmd = buildRevenueCommand({ amountText: intake.amountText, desc: finalDesc, dateIso });

    await patchActorMemorySafe(ownerDigits, actorKey, {
      pending_choice: null,
      pending_intent: null,
      intake_draft: null
    });

    return `✅ Logged: ${cmd}`;
  }

  // ---------------- TASK ----------------
  if (pending_choice === 'log' && pending_intent === 'task') {
    if (intakeKind !== 'task') {
      await patchActorMemorySafe(ownerDigits, actorKey, {
        intake_draft: { kind: 'task', taskText: null }
      });
      return `What’s the task?`;
    }

    if (!intake.taskText) {
      const taskText = cleanVendorOrDesc(raw);
      if (!taskText) return `What’s the task?`;

      const cmd = buildTaskCommand({ taskText });

      await patchActorMemorySafe(ownerDigits, actorKey, {
        pending_choice: null,
        pending_intent: null,
        intake_draft: null
      });

      return `✅ Logged: ${cmd}`;
    }

    // finalize if already present
    const cmd = buildTaskCommand({ taskText: intake.taskText });
    await patchActorMemorySafe(ownerDigits, actorKey, {
      pending_choice: null,
      pending_intent: null,
      intake_draft: null
    });
    return `✅ Logged: ${cmd}`;
  }

  // ---------------- TIME ----------------
  if (pending_choice === 'log' && pending_intent === 'time') {
    // Keep time ultra-deterministic: push them to the exact phrases your router already knows.
    if (looksLikeClockCmd(raw)) {
      await patchActorMemorySafe(ownerDigits, actorKey, {
        pending_choice: null,
        pending_intent: null,
        intake_draft: null
      });
      // Let orchestrator/router consume "clock in/out" normally
    } else {
      return `Say **clock in** or **clock out**.`;
    }
  }

  // ---------------- JOB ----------------
  if (pending_choice === 'log' && pending_intent === 'job') {
    // No draft needed for now; just route them into deterministic phrases you already support.
    return `Say one of these: **create job <name>**, **list jobs**, or **set active job <name>**.`;
  }
  // 4) If user types bare intent without saying “log” first, still be helpful (ChatGPT-like)
  if (isBareExpense(raw)) return `Got it — how much was it?`;
  if (isBareRevenue(raw)) return `Got it — how much came in?`;
  if (isBareTask(raw)) return `Got it — what’s the task?`;
  if (isBareTime(raw)) return `Got it — clock **in** or **out**?`;
  if (isBareJob(raw)) return `Got it — create, list, or set active?`;

  // 5) Normal Agent flow (RAG → tools → LLM)
  const topic = pickTopic(raw, topicHints);
  console.log('[AGENT] topic:', topic || 'generic', 'text:', raw);

  const ragMod = getRag();
  if (ragMod?.answer) {
    try {
      const hints = topic ? Array.from(new Set([topic, ...topicHints])) : topicHints;
      const out = await ragMod.answer({ from, query: raw, hints, ownerId: ownerDigits });
      if (out && out.trim()) return out;
    } catch (e) {
      console.warn('[AGENT] RAG call failed:', e?.message);
    }
  }

  const llm = new LLMProvider({
    provider: process.env.LLM_PROVIDER || process.env.AI_PROVIDER || 'openai',
    model: process.env.LLM_MODEL || 'gpt-4o-mini',
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
    { role: 'user', content: raw }
  ];

  try {
    return await runToolsLoop({ llm, seedMessages: seed, ownerId: ownerDigits, from });
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
    const ownerProfile = opts.ownerProfile || opts.userProfile || null;
  return ask({ from, ownerId, text, topicHints, ownerProfile });
}

module.exports = { ask, runAgent, canUseAgent };
