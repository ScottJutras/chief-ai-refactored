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
  if (!ownerProfile) return false;
  // Check explicit plan key first
  const k = getEffectivePlanKey(ownerProfile);
  if (k === "starter" || k === "pro") return true;
  // Also allow active trial or active subscription period (mirrors routes/askChief.js looksPaid)
  const now = Date.now();
  const trialEnd = ownerProfile.trial_end ? new Date(ownerProfile.trial_end).getTime() : 0;
  if (trialEnd > now) return true;
  const periodEnd = ownerProfile.current_period_end ? new Date(ownerProfile.current_period_end).getTime() : 0;
  if (periodEnd > now) return true;
  const subId = String(ownerProfile.stripe_subscription_id || "").trim();
  const status = String(ownerProfile.sub_status || "").toLowerCase().trim();
  if (subId && status !== "canceled" && status !== "cancelled") return true;
  return false;
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

  // BI Agent Tools (Phase 1–3) + Catalog + Phase 2 additions
  const biTools = [
    'jobPnl', 'labourUtil', 'comparePeriods', 'getTopN', 'budgetVsActual', 'cashFlowForecast',
    'catalogLookup',
    // Phase 2 tools
    'customerHistory', 'photoQuery', 'overtimeReport', 'payrollSummary', 'supplierSpend',
    // Phase 3 tools
    'compareQuoteVsActual',
    // Phase 3.2 — pattern & benchmark tools
    'jobPatternTrends', 'ownerBenchmarks',
  ];
  for (const toolFile of biTools) {
    try {
      const mod = require(`../agentTools/${toolFile}`);
      // Each module exports a single tool spec with __handler
      const tool = Object.values(mod).find(v => v?.type === 'function' && v?.function?.name);
      if (tool) {
        reg[tool.function.name] = tool.__handler;
        toolsSpec.push(tool);
      }
    } catch (e) {
      console.warn(`[AGENT] BI tool ${toolFile} not available:`, e?.message);
    }
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
function genericMenu(channel = 'whatsapp') {
  if (channel === 'portal') {
    return [
      "I don't have a specific answer for that yet — it may be that your ledger doesn't have enough data, or I need a more specific question to pull the right numbers.",
      "",
      "Here's what I can answer right now:",
      "",
      "Spending & revenue",
      "  • What did we spend this month?",
      "  • What's our revenue vs. expenses MTD?",
      "  • Which vendor are we spending the most with?",
      "",
      "Jobs & profitability",
      "  • Is [job name] making money?",
      "  • Which jobs are losing money this week?",
      "  • What expenses are unassigned to a job?",
      "",
      "Crew & time",
      "  • How many hours did the crew log this week?",
      "  • What did we spend on labour MTD?",
      "",
      "Try one of these and I'll give you the real numbers."
    ].join("\n");
  }

  return [
    "Here's what I can do right now:",
    "",
    "If you want to **log something**, send one of these:",
    "• task - buy nails",
    "• expense $52 Home Depot",
    "• revenue $500 deposit",
    "• clock in / clock out",
    "",
    "If you want an **answer**, ask:",
    "• what's my cashflow this month?",
    "• profit on job 1556",
    "• what did I log today?",
    "",
    "Tell me: **log** or **question** — and I'll drive."
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

// ----- WhatsApp conversation history settings ----------------------
const MAX_WA_HISTORY_PAIRS = 3;          // keep last 3 Q&A pairs in memory
const MAX_WA_HISTORY_MSG_CHARS = 400;    // per-message truncation before storage

function trimMsg(s = '') {
  const str = String(s || '').trim();
  return str.length > MAX_WA_HISTORY_MSG_CHARS ? str.slice(0, MAX_WA_HISTORY_MSG_CHARS) + '…' : str;
}

// Extract the rolling history slice from actorMemory (last N pairs = N*2 messages)
function buildHistorySlice(memory = {}) {
  const hist = Array.isArray(memory.conversation_history) ? memory.conversation_history : [];
  return hist.slice(-(MAX_WA_HISTORY_PAIRS * 2));
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
    "• what's my cashflow this month?",
    "• profit on job 1556",
    "• what did I log today?"
  ].join("\n");
}

// ----- LLM failure sentinel --------------------------------
const LLM_OFFLINE_SENTINEL = '(llm offline)';
const LLM_OFFLINE_MESSAGE  =
  "I'm not able to reach my reasoning engine right now. Your data is safe — please try again in a moment.";

// ----- Tool-calling loop -----------------------------------
const MAX_TOOL_ITERATIONS = 5;

async function runToolsLoop({ llm, seedMessages, ownerId, from, max_tokens }) {
  const { toolsSpec, reg } = getTools();
  const messages = [...seedMessages];
  const chatOpts = max_tokens ? { max_tokens } : {};

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const msg = await llm.chat({ messages, tools: toolsSpec, ...chatOpts });

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const content = String(msg.content || '').trim();

      // Hard sentinel: LLM provider soft-failed (both providers down or key missing).
      if (content === LLM_OFFLINE_SENTINEL || content.includes(LLM_OFFLINE_SENTINEL)) {
        console.warn('[AGENT] LLM offline sentinel received — returning user-facing fallback');
        return LLM_OFFLINE_MESSAGE;
      }

      if (content) return content;
      // LLM returned no content and no tool calls — give a useful fallback
      return "I don't have enough data logged yet to answer that. Once you start logging expenses, revenue, and time through WhatsApp, I can give you real insights on this.";
    }

    messages.push(msg);

    // Track whether every tool call in this round returned an error
    let roundErrorCount = 0;

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
      if (result?.error) roundErrorCount++;
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }

    // If every tool in the first round errored, the LLM has nothing real to work with.
    // Synthesize a specific "nothing logged" message rather than letting the LLM hallucinate.
    if (i === 0 && roundErrorCount === msg.tool_calls.length && msg.tool_calls.length > 0) {
      const toolNames = msg.tool_calls.map(tc => tc.function?.name).filter(Boolean).join(', ');
      console.warn('[AGENT] All tools errored on first round:', toolNames);
      // Let the LLM see the errors and synthesize — it might still produce a helpful "what's missing" message.
      // But cap iterations to 1 more round so we don't spin.
    }
  }

  // Exceeded max iterations without a final text reply — do one final pass without tools to synthesize what we have
  try {
    const summaryMsg = await llm.chat({
      messages: [
        ...messages,
        { role: 'user', content: 'Based on everything you found so far, give your best answer. Be honest about any gaps.' }
      ],
      max_tokens: chatOpts.max_tokens || 800
    });
    const summaryContent = String(summaryMsg?.content || '').trim();
    if (summaryContent === LLM_OFFLINE_SENTINEL || summaryContent.includes(LLM_OFFLINE_SENTINEL)) {
      return LLM_OFFLINE_MESSAGE;
    }
    if (summaryContent) return summaryContent;
  } catch {}
  return "I gathered some data but ran out of steps to complete a full analysis. Try asking with a specific date range (MTD, WTD, today) or a specific job name — that helps me answer in fewer steps.";
}

// ----- Date range parsing (for WhatsApp temporal expressions) ------
// Returns { date_from, date_to } strings (YYYY-MM-DD) or null.
function parseDateRange(text, tz = 'America/Toronto') {
  const t = String(text || '').toLowerCase().trim();
  const today = getTodayIso(tz);

  // Helper: offset date
  function shift(date, days) {
    const d = new Date(date);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  // Start of week (Monday)
  function weekStart(date) {
    const d = new Date(`${date}T12:00:00Z`);
    const dow = d.getUTCDay(); // 0=Sun
    const diff = dow === 0 ? -6 : 1 - dow;
    d.setUTCDate(d.getUTCDate() + diff);
    return d.toISOString().slice(0, 10);
  }

  // Start of month
  function monthStart(date) { return date.slice(0, 7) + '-01'; }

  // End of month
  function monthEnd(date) {
    const [y, m] = date.split('-').map(Number);
    const d = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day of this
    return d.toISOString().slice(0, 10);
  }

  // Start of quarter
  function quarterStart(date) {
    const [y, m] = date.split('-').map(Number);
    const q = Math.ceil(m / 3);
    return `${y}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`;
  }

  function quarterEnd(date) {
    const [y, m] = date.split('-').map(Number);
    const q = Math.ceil(m / 3);
    const endMonth = q * 3;
    const d = new Date(Date.UTC(y, endMonth, 0));
    return d.toISOString().slice(0, 10);
  }

  // "this week" / "wtd"
  if (/\b(this week|week to date|wtd)\b/.test(t)) {
    return { date_from: weekStart(today), date_to: today };
  }
  // "last week"
  if (/\blast week\b/.test(t)) {
    const lastMon = shift(weekStart(today), -7);
    const lastSun = shift(lastMon, 6);
    return { date_from: lastMon, date_to: lastSun };
  }
  // "this month" / "mtd"
  if (/\b(this month|month to date|mtd)\b/.test(t)) {
    return { date_from: monthStart(today), date_to: today };
  }
  // "last month"
  if (/\blast month\b/.test(t)) {
    const lastMonthEnd = shift(monthStart(today), -1);
    const lastMonthStart = monthStart(lastMonthEnd);
    return { date_from: lastMonthStart, date_to: lastMonthEnd };
  }
  // "year to date" / "ytd" / "this year"
  if (/\b(year to date|ytd|this year)\b/.test(t)) {
    return { date_from: `${today.slice(0, 4)}-01-01`, date_to: today };
  }
  // "last year"
  if (/\blast year\b/.test(t)) {
    const y = Number(today.slice(0, 4)) - 1;
    return { date_from: `${y}-01-01`, date_to: `${y}-12-31` };
  }
  // "Q1" / "Q2" / "Q3" / "Q4" (current year implied)
  const qMatch = t.match(/\bq([1-4])\b/);
  if (qMatch) {
    const q = Number(qMatch[1]);
    const y = today.slice(0, 4);
    const startMonth = String((q - 1) * 3 + 1).padStart(2, '0');
    const endMonth = q * 3;
    const d = new Date(Date.UTC(Number(y), endMonth, 0));
    return { date_from: `${y}-${startMonth}-01`, date_to: d.toISOString().slice(0, 10) };
  }
  // "this quarter"
  if (/\b(this quarter|quarter to date|qtd)\b/.test(t)) {
    return { date_from: quarterStart(today), date_to: today };
  }
  // "last quarter"
  if (/\blast quarter\b/.test(t)) {
    const qStartOfCurrent = new Date(`${quarterStart(today)}T12:00:00Z`);
    const prevQEnd = shift(quarterStart(today), -1);
    const prevQStart = quarterStart(prevQEnd);
    return { date_from: prevQStart, date_to: prevQEnd };
  }
  // "today"
  if (/\btoday\b/.test(t)) {
    return { date_from: today, date_to: today };
  }
  // "yesterday"
  if (/\byesterday\b/.test(t)) {
    const yd = shift(today, -1);
    return { date_from: yd, date_to: yd };
  }

  return null;
}

// ----- Entity reference detectors (WhatsApp multi-turn) ------------
// True if the message references a job implicitly (no job# stated).
function hasEntityRef(text = '') {
  return /\b(that job|same job|this job|the job|last job|the last one|that one|it|the same one|the project)\b/i.test(text);
}

// True if the message references a prior date range implicitly.
function hasPeriodRef(text = '') {
  return /\b(same period|same range|same time|that month|that week|that quarter|that range|same month|same week|same quarter|that date|same dates?|same timeframe)\b/i.test(text);
}

// Extract job number from user text (if any).
function extractJobNo(text = '') {
  const m = String(text).match(/\bjob\s*#?\s*(\d+)\b/i);
  return m ? Number(m[1]) : null;
}

// Build a context line for WhatsApp system prompt based on actorMemory.
function buildWhatsappContextBlock(memory = {}, tz = 'America/Toronto') {
  const lines = [];

  // Today's date (always inject)
  const today = getTodayIso(tz);
  lines.push(`Today is ${today} (timezone: ${tz}).`);

  // Last discussed job
  if (memory.last_job_no || memory.last_job_name) {
    const jobRef = [
      memory.last_job_no ? `Job #${memory.last_job_no}` : null,
      memory.last_job_name ? `"${memory.last_job_name}"` : null,
    ].filter(Boolean).join(' — ');
    lines.push(`Last job discussed in this session: ${jobRef}.`);
    lines.push(`When the user says "that job", "same job", "the last one", or similar — they mean ${jobRef}.`);
  }

  // Date range context
  if (memory.last_date_from || memory.last_date_to) {
    const dr = [memory.last_date_from, memory.last_date_to].filter(Boolean).join(' to ');
    lines.push(`Last date range queried: ${dr}.`);
  }

  return lines.join('\n');
}

// ----- Public ask API --------------------------------------
async function ask({ from, ownerId, text, topicHints = [], ownerProfile, pageContext, history, tz = 'America/Toronto' } = {}) {
  const raw = String(text || '').trim();
  const lc = normBare(raw);

  const ownerDigits = DIGITS_ONLY(ownerId);
  const actorKey = DIGITS_ONLY(from) || ownerDigits; // WhatsApp "from" is your actor identity

  // Detect channel from hints
  const hintSet = new Set((topicHints || []).map(h => String(h).toLowerCase()));
  const channel = hintSet.has('portal') || hintSet.has('askchief') ? 'portal' : 'whatsapp';

  // Load memory (best-effort)
  const memory = await loadActorMemorySafe(ownerDigits, actorKey);
  const pending_choice = String(memory?.pending_choice || '').toLowerCase().trim(); // 'log' | 'question'
  const pending_intent = String(memory?.pending_intent || '').toLowerCase().trim(); // 'expense'|'revenue'|'task'|'time'|'job'

  // If Agent not available for this plan, still give a non-dead-end reply
  if (!canUseAgent(ownerProfile)) {
    // If they're mid-flow, still help
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
    return genericMenu(channel);
  }

  // 0) Help / intro intent — always answer deterministically, never hit the LLM
  const isHelpIntent =
    /\b(what can (you|i) do|how can you help|what do you do|who are you|what are you|how does this work|how do i use|what can i ask|tell me what you can do|help me understand)\b/i.test(lc) ||
    /\b(what can i do here|how to|how do i|what now)\b/i.test(lc) ||
    lc === 'help' || lc === '?' || lc === 'menu';

  if (isHelpIntent) {
    await patchActorMemorySafe(ownerDigits, actorKey, { pending_choice: null, pending_intent: null });
    if (channel === 'portal') {
      return [
        "I'm Chief — think of me as your on-call CFO. I read your transaction ledger in real time and give you straight answers about where the money is going, which jobs are profitable, and what needs your attention.",
        "",
        "Here's what you can ask me:",
        "",
        "Financial position",
        "  \"What did we spend this month?\"",
        "  \"How much revenue came in this week (WTD)?\"",
        "  \"Are we up or down vs. last month?\"",
        "",
        "Job profitability",
        "  \"Is [job name] making money?\"",
        "  \"Which jobs are losing money right now?\"",
        "  \"What expenses aren't assigned to a job yet?\"",
        "",
        "Crew & operations",
        "  \"How many hours did the team log this week?\"",
        "  \"What's still in Pending Review?\"",
        "  \"Which tasks are overdue?\"",
        "",
        "The more you log through WhatsApp — expenses, revenue, time — the more precise my answers get. What would you like to know first?"
      ].join("\n");
    }
    return genericMenu(channel);
  }

  // ---- PORTAL FAST PATH ----------------------------------------
  // For portal users, skip ALL WhatsApp-specific deterministic flows.
  // Go straight to the LLM with tools — answer anything, never hallucinate data.
  if (channel === 'portal') {
    const llmPortal = new LLMProvider({
      provider: process.env.LLM_PROVIDER || process.env.AI_PROVIDER || 'openai',
      model: process.env.LLM_MODEL_PORTAL || process.env.LLM_MODEL || 'gpt-4o',
    });

    // Build rich context block so Chief knows what the user is looking at
    const userTz = tz || 'America/Toronto';
    let dateStr;
    try {
      dateStr = new Date().toLocaleDateString('en-CA', {
        timeZone: userTz,
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      });
    } catch {
      dateStr = new Date().toISOString().split('T')[0];
    }

    const PAGE_LABELS = {
      '/app/jobs': 'the Jobs list (all jobs overview)',
      '/app/dashboard': 'the Dashboard (business-wide metrics)',
      '/app/pending-review': 'the Pending Review page',
      '/app/uploads': 'the Capture / Uploads page',
      '/app/activity/expenses': 'the Activity — Expenses page',
      '/app/activity': 'the Activity page',
      '/app/chief': 'the Ask Chief page',
      '/app/settings': 'the Settings page',
    };

    let contextLines = [`Today is ${dateStr}.`];

    if (pageContext?.job_name || pageContext?.job_no || pageContext?.job_id) {
      const jobLabel = [
        pageContext.job_name,
        pageContext.job_no ? `job #${pageContext.job_no}` : null,
      ].filter(Boolean).join(' — ');
      contextLines.push(
        `\nThe user is currently viewing: ${jobLabel}.`,
        `When they say "this job", "the current job", or ask without specifying a job, they mean this one.`,
        `Always look up this job's data first before asking which job they mean.`,
      );
    } else if (pageContext?.page) {
      const pagePath = String(pageContext.page).split('?')[0];
      // Check for job detail pages like /app/jobs/123
      const jobDetailMatch = pagePath.match(/^\/app\/jobs\/([^/]+)$/);
      if (jobDetailMatch) {
        contextLines.push(`\nThe user is currently on a job detail page (job ID: ${jobDetailMatch[1]}).`);
      } else {
        const label = PAGE_LABELS[pagePath] || `the ${pagePath} page`;
        contextLines.push(`\nThe user is currently on ${label}.`);
      }
    }

    const contextBlock = contextLines.join('\n');

    const portalSystemPrompt = `${CHIEF_SYSTEM_PROMPT}

CHANNEL: Web portal dashboard (not WhatsApp).

${contextBlock}

Portal response rules:
- For questions about the user's OWN data (expenses, revenue, jobs, time, tasks): ALWAYS call tools first. Never invent numbers.
- For general questions, greetings, or "how does X work" → answer naturally from your knowledge. No tools needed — just talk.
- If tools return empty results: say so honestly, explain what data would need to be logged, and offer a concrete next step.
- Respond in clear, conversational prose. No bullet-point menus. No command prompts.
- Be direct. If you have real numbers from tools, lead with them and interpret them — don't just recite.
- Never return a dead-end. Always close with something actionable or a follow-up question.
- If the user refers to "this job" or "the current job", use the context above — do not ask which job unless the context is genuinely ambiguous.
- Conversation is multi-turn: refer back to what was discussed earlier in this session if relevant.`;

    // Build seed: system + up to last 10 history messages + current user message
    const portalSeed = [{ role: 'system', content: portalSystemPrompt }];

    if (Array.isArray(history) && history.length > 0) {
      for (const h of history.slice(-10)) {
        const role = h.role === 'user' ? 'user' : 'assistant';
        const content = String(h.content || '').trim();
        if (content) portalSeed.push({ role, content });
      }
    }

    portalSeed.push({ role: 'user', content: raw });

    try {
      return await runToolsLoop({ llm: llmPortal, seedMessages: portalSeed, ownerId: ownerDigits, from, max_tokens: 1500 });
    } catch (e) {
      console.warn('[AGENT] portal tools loop failed:', e?.message);
      return "I ran into a problem pulling that answer. Your data is safe — please try again in a moment.";
    }
  }
  // ---- END PORTAL FAST PATH ------------------------------------

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

  // 2) If we already know they're logging, treat bare intents as a continuation (NOT a new convo)
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
    return `What's the task?`;
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
  // tz is already a parameter of ask() — use it directly
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
      // Clear flow state so they don't get stuck
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

    // 2) Optional description — if they type anything non-empty, we'll capture and finalize.
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
      return `What's the task?`;
    }

    if (!intake.taskText) {
      const taskText = cleanVendorOrDesc(raw);
      if (!taskText) return `What's the task?`;

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
  if (isBareTask(raw)) return `Got it — what's the task?`;
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

  // ── WhatsApp: inject date + session context ──────────────────────────
  // Resolve the effective query text (substitute entity references if we
  // have a last_job in memory, so the LLM doesn't need to ask again).
  let effectiveText = raw;

  if (channel !== 'portal') {
    // If the user said "that job" / "same job" / etc. and we have context, enrich the query
    if (hasEntityRef(raw) && (memory.last_job_no || memory.last_job_name)) {
      const jobRef = [
        memory.last_job_no ? `job #${memory.last_job_no}` : null,
        memory.last_job_name ? `"${memory.last_job_name}"` : null,
      ].filter(Boolean).join(' ');
      effectiveText = `${effectiveText} [referring to ${jobRef} from earlier in this conversation]`;
      console.log('[AGENT] entity-ref substitution applied:', jobRef);
    }

    // If the user referenced "same period" / "that month" etc., inject the last date range
    if (hasPeriodRef(raw) && (memory.last_date_from || memory.last_date_to)) {
      const dr = [memory.last_date_from, memory.last_date_to].filter(Boolean).join(' to ');
      effectiveText = `${effectiveText} [date range from earlier: ${dr}]`;
      console.log('[AGENT] period-ref substitution applied:', dr);
    }

    // If the user mentioned a new job number, store it for future turns
    const mentionedJobNo = extractJobNo(raw);
    if (mentionedJobNo && mentionedJobNo !== memory.last_job_no) {
      // Store optimistically; also attempt to resolve the job name from DB
      patchActorMemorySafe(ownerDigits, actorKey, { last_job_no: mentionedJobNo, last_job_name: null })
        .catch(() => {});
      pg.query(
        `SELECT name FROM public.jobs WHERE job_int_id = $1 AND owner_id::text = $2 LIMIT 1`,
        [String(mentionedJobNo), ownerDigits]
      ).then(r => {
        if (r?.rows?.[0]?.name) {
          patchActorMemorySafe(ownerDigits, actorKey, { last_job_name: r.rows[0].name }).catch(() => {});
        }
      }).catch(() => {});
    }

    // Store date range if detected
    const dr = parseDateRange(raw, tz);
    if (dr) {
      patchActorMemorySafe(ownerDigits, actorKey, {
        last_date_from: dr.date_from,
        last_date_to: dr.date_to,
      }).catch(() => {});
    }
  }

  const channelContext = channel === 'portal'
    ? `

CHANNEL: Web portal dashboard. Rules for this context:
- Respond in clear prose paragraphs. Do NOT suggest WhatsApp commands.
- The user is asking a business intelligence question from their browser.
- If tool results are empty (no transactions, no jobs, no tasks): respond with something like "You don't have any [expenses/revenue/activity] logged yet. Once you start logging through WhatsApp, I can answer questions like this with real numbers." Be specific about what's missing.
- Never return an error or dead-end. Always end with a concrete next step or example question the user can ask once they have data.
- If you cannot answer due to missing data, still be helpful: explain what data would unlock the answer.`
    : `

CHANNEL: WhatsApp. Keep answers concise — 3-5 sentences max unless the user asks for more detail.

${buildWhatsappContextBlock(memory, tz)}`;

  // For WhatsApp: include rolling conversation history (last N Q&A pairs)
  const waHistory = channel !== 'portal' ? buildHistorySlice(memory) : [];

  const seed = [
    {
      role: 'system',
      content: `${CHIEF_SYSTEM_PROMPT}${channelContext}

Execution rules:
- If details are sufficient: use tools, then reply with a clear prose answer (+ numbers/dates from the data).
- If tool results come back empty, explain what's missing and what the user should do next.
- If details are missing: ask exactly ONE clarifying question (do not execute yet).
- Never dead-end; always offer the next best action.
- After answering a job-specific question, always call get_owner_benchmarks to compare the result to the owner's own historical average. This makes every job answer feel like a CFO insight, not just a data lookup.`
    },
    ...waHistory,                               // prior WhatsApp turns (WhatsApp only)
    { role: 'user', content: effectiveText }
  ];

  try {
    let answer = await runToolsLoop({ llm, seedMessages: seed, ownerId: ownerDigits, from });

    // Catch sentinel that escaped runToolsLoop (belt-and-suspenders)
    if (typeof answer === 'string' && answer.includes(LLM_OFFLINE_SENTINEL)) {
      answer = LLM_OFFLINE_MESSAGE;
    }

    if (channel !== 'portal') {
      // Guard: persist last_job_no if it appeared only via entity-ref substitution
      const jobNoInQuery = extractJobNo(effectiveText);
      if (jobNoInQuery && jobNoInQuery !== memory.last_job_no) {
        patchActorMemorySafe(ownerDigits, actorKey, { last_job_no: jobNoInQuery }).catch(() => {});
        // Also look up job name if not yet stored
        if (!memory.last_job_name) {
          pg.query(
            `SELECT name FROM public.jobs WHERE job_int_id = $1 AND owner_id::text = $2 LIMIT 1`,
            [String(jobNoInQuery), ownerDigits]
          ).then(r => {
            if (r?.rows?.[0]?.name) {
              patchActorMemorySafe(ownerDigits, actorKey, { last_job_name: r.rows[0].name }).catch(() => {});
            }
          }).catch(() => {});
        }
      }

      // Save this Q&A pair to rolling conversation history (fire-and-forget)
      const newHistory = [
        ...waHistory,
        { role: 'user',      content: trimMsg(effectiveText) },
        { role: 'assistant', content: trimMsg(typeof answer === 'string' ? answer : '') },
      ].slice(-(MAX_WA_HISTORY_PAIRS * 2));
      patchActorMemorySafe(ownerDigits, actorKey, { conversation_history: newHistory }).catch(() => {});
    }

    return answer;
  } catch (e) {
    console.warn('[AGENT] tools loop failed:', e?.message);
    return genericMenu(channel);
  }
}

// ----- Tool phase for streaming (used by askChiefStream route) -----
// Runs tool-calling rounds synchronously using chat() (same logic as runToolsLoop)
// but instead of returning a string, returns the accumulated messages so the
// caller can do a final streaming synthesis pass with chatStream().
//
// onRound({ tools, iteration }) is called after each tool round completes.
// Returns { messages, earlyAnswer } where earlyAnswer is set if the LLM returned
// text without any tool calls (i.e., no tools were needed).
const MAX_TOOL_PHASE_ITERATIONS = 4;

async function runToolPhaseSync({ llm, seedMessages, ownerId, onRound }) {
  const { toolsSpec, reg } = getTools();
  const messages = [...seedMessages];

  for (let i = 0; i < MAX_TOOL_PHASE_ITERATIONS; i++) {
    let msg;
    try {
      msg = await llm.chat({ messages, tools: toolsSpec });
    } catch (e) {
      console.warn('[AGENT/stream] chat() failed in tool phase:', e?.message);
      return { messages, earlyAnswer: LLM_OFFLINE_MESSAGE };
    }

    const content = String(msg.content || '').trim();

    // LLM returned text — no more tool calls needed
    if (!msg.tool_calls || !msg.tool_calls.length) {
      if (content === LLM_OFFLINE_SENTINEL || content.includes(LLM_OFFLINE_SENTINEL)) {
        return { messages, earlyAnswer: LLM_OFFLINE_MESSAGE };
      }
      return { messages, earlyAnswer: content || null };
    }

    messages.push(msg);
    const toolNames = msg.tool_calls.map(tc => tc.function?.name).filter(Boolean);

    for (const tc of msg.tool_calls) {
      const name = tc.function?.name;
      const handler = reg[name];
      let result;
      try {
        const args = JSON.parse(tc.function?.arguments || '{}');
        args.owner_id = args.owner_id || ownerId;
        result = handler ? await handler(args) : { error: `Unknown tool: ${name}` };
      } catch (e) {
        result = { error: e?.message };
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }

    onRound?.({ tools: toolNames, iteration: i });
  }

  // Max iterations reached — caller should synthesize from accumulated messages
  return { messages, earlyAnswer: null };
}

// ----- Reasoning query detector (used by webhook for fast-ack) ----
// Returns true if the message is almost certainly a question/analysis query
// that will hit the LLM (vs a deterministic log/action command).
// Conservative: false positives (calling it a question when it's a command)
// are harmless — they just skip the ack. False negatives send an unnecessary ack.
function looksLikeReasoningQuery(text = '') {
  const t = String(text).toLowerCase().trim();
  if (!t) return false;

  // Known log/action prefixes — these route deterministically, skip ack
  if (/^(expense|revenue|task\s*[-–]|clock\s*(in|out)|break|lunch|drive|batch|payroll|set\s+rate|mileage|recurring|job\s+(create|list|close|set)|photo|receipt)\b/.test(t)) return false;
  if (/^\$\d/.test(t)) return false; // bare dollar amount = expense

  // Question/analysis signals
  return (
    /\b(how|what|which|when|why|show me|tell me|give me|is |did |do i|am i|are we|were we|have i|has)\b/.test(t) ||
    /\b(profit|margin|revenue|expense|cashflow|cash flow|labour|labor|overtime|payroll|quote|budget|forecast|kpi|benchmark|average|pattern|trend|report|summary|breakdown)\b/.test(t) ||
    /\b(job\s*#?\d+|last\s+\d+|this week|last week|this month|last month|ytd|mtd|wtd|q[1-4])\b/.test(t)
  );
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

module.exports = { ask, runAgent, canUseAgent, looksLikeReasoningQuery, runToolPhaseSync };
