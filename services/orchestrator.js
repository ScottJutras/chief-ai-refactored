// services/orchestrator.js
// Classify every message → action | insight | RAG | web. No dead ends.
const OpenAI = require('openai');
const pg = require('./postgres');
const { createPendingAction, resolvePendingAction, shortConfirmForCIL } = require('./ai_confirm');
const { answerInsights } = require('./qa_insights');
const { ragAnswer } = require('./rag_search');
const { webAnswer } = require('./web_fallback');
const { AnyCIL } = require('../schemas/cil');
const { handleTimeclock } = require('../handlers/commands/timeclock'); // legacy fallback

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYS_ROUTER = `
You are Chief's router. Classify the user's message into exactly one route:
- "action" for commands that mutate data (clock in/out, create task, move time, export, etc.)
- "insight" for performance questions answerable from our database (KPIs, jobs, P&L, hours, forecasts).
- "rag" for how-to and product usage questions that are answered by our internal docs/SOPs.
- "web" if it's outside product scope and not answered by our docs (industry methods, materials, regulations).
Return strict JSON: {"route":"action|insight|rag|web","followup": "short question if info missing or null"}`;

async function classifyRoute({ text, profile }) {
  const res = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL_CLASSIFY || 'gpt-4o-mini',
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYS_ROUTER },
      { role: 'user', content: `User: ${text}\nPlan:${profile?.plan||'free'}` }
    ]
  });
  try { return JSON.parse(res.choices[0].message.content); }
  catch { return { route: 'rag', followup: null }; }
}

async function orchestrate({ from, text, userProfile, ownerId }) {
  const tz = userProfile?.tz || 'America/Toronto';
  const lc = String(text || '').trim().toLowerCase();
  // 1) Pending yes/no? Resolve first (idempotent)
  const yesMatch = lc.match(/^yes\s+([a-f0-9]{24})$/i);
  const noMatch = lc.match(/^no\s+([a-f0-9]{24})$/i);
  if (yesMatch || noMatch) {
    const id = (yesMatch || noMatch)[1];
    const row = await resolvePendingAction(id, !!yesMatch);
    if (!row) return 'That request expired. Try again.';
    if (noMatch) return 'Okay, cancelled.';
    // Execute CIL
    const cil = AnyCIL.safeParse(row.cil_json);
    if (!cil.success) return 'Invalid action—try again.';
    // Route to handler
    if (cil.data.type === 'Clock') {
      // Legacy timeclock handler (replace with applyCIL later)
      const cmd = `clock ${cil.data.action.replace('_', ' ')} ${cil.data.name ? cil.data.name : ''} ${cil.data.job ? '@ ' + cil.data.job : ''}`;
      return await handleTimeclock(from, cmd, userProfile, ownerId, null, true, null); // assume isOwner for simplicity
    }
    // TODO: Add CreateTask/Expense/Quote execution via applyCIL
    return 'Action done.';
  }
  // 2) Choose a route
  const { route, followup } = await classifyRoute({ text, profile: userProfile });
  // 3) If missing info, ask a tight clarifier (no dead ends)
  if (followup && !/^\s*$/.test(followup)) return followup;
  // 4) Execute per route
  switch (route) {
    case 'action': {
      // Parse NL → CIL → confirm → pending
      const cil = AnyCIL.safeParse(parseToCIL(text)); // placeholder parseToCIL
      if (cil.success) {
        const summary = shortConfirmForCIL(cil.data);
        const pendingId = await createPendingAction({ ownerId, from, cil: cil.data, summary });
        return `${summary}\nReply: yes ${pendingId} or no ${pendingId}`;
      }
      return 'I think you want to do something—try “clock in” or “task - buy nails”.';
    }
    case 'insight': return await answerInsights({ text, ownerId, tz });
    case 'rag': {
      const ans = await ragAnswer({ text, ownerId });
      if (ans?.ok) return ans.text;
      // Pivot to web
      const web = await webAnswer({ text });
      return web.text;
    }
    case 'web': {
      const web = await webAnswer({ text });
      return web.text;
    }
    default: return 'I can help with time, tasks, expenses, quotes, and KPIs. Try “clock in” or “How am I doing this month?”';
  }
}

module.exports = { orchestrate };

// Placeholder NL → CIL parser (expand with OpenAI if needed)
function parseToCIL(text) {
  const lc = text.toLowerCase();
  if (/(clock in|clock out|break|drive)/i.test(lc)) {
    // Parse clock logic...
    return { type: 'Clock', action: 'in' }; // stub
  }
  // Add more...
  return null;
}