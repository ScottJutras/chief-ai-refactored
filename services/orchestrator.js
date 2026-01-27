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
const { ensureAnswerContract } = require('../schemas/answer');

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

/**
 * orchestrate({ from, text, userProfile, ownerId, returnContract=false })
 * - Default returns STRING (WhatsApp safe)
 * - If returnContract=true, returns Answer Contract object
 */
async function orchestrate({ from, text, userProfile, ownerId, returnContract = false } = {}) {
  const tz = userProfile?.tz || 'America/Toronto';
  const lc = String(text || '').trim().toLowerCase();

  async function injectPendingDraftNote(contractObj) {
    try {
      if (!returnContract) return contractObj;
      if (!ownerId) return contractObj;

      const n = await pg.countPendingCilDrafts(ownerId).catch(() => 0);
      if (!n) return contractObj;

      const c = ensureAnswerContract(contractObj);
      const note = `${n} draft${n === 1 ? '' : 's'} pending confirmation (not included in totals until confirmed).`;

      // attach into "missing" because it’s literally missing from truth set
      const missing = Array.isArray(c.missing) ? c.missing.slice() : [];
      if (!missing.includes(note)) missing.push(note);

      return ensureAnswerContract({ ...c, missing });
    } catch {
      return contractObj;
    }
  }

  function asText(out) {
    if (out && typeof out === 'object' && !Array.isArray(out)) {
      if (typeof out.answer === 'string') return out.answer;
      return JSON.stringify(out);
    }
    return String(out || '');
  }

  async function asContractOrText(out) {
    if (!returnContract) return asText(out);
    const base =
      (out && typeof out === 'object' && !Array.isArray(out))
        ? ensureAnswerContract(out)
        : ensureAnswerContract({ answer: String(out || '') });

    return await injectPendingDraftNote(base);
  }

  // 1) Pending yes/no? Resolve first (idempotent)
  const yesMatch = lc.match(/^yes\s+([a-f0-9]{24})$/i);
  const noMatch = lc.match(/^no\s+([a-f0-9]{24})$/i);
  if (yesMatch || noMatch) {
    const id = (yesMatch || noMatch)[1];
    const row = await resolvePendingAction(id, !!yesMatch);
    if (!row) return await asContractOrText('That request expired. Try again.');
    if (noMatch) return await asContractOrText('Okay, cancelled.');

    const cil = AnyCIL.safeParse(row.cil_json);
    if (!cil.success) return await asContractOrText('Invalid action—try again.');

    if (cil.data.type === 'Clock') {
      const cmd = `clock ${cil.data.action.replace('_', ' ')} ${cil.data.name ? cil.data.name : ''} ${cil.data.job ? '@ ' + cil.data.job : ''}`;
      const out = await handleTimeclock(from, cmd, userProfile, ownerId, null, true, null);
      return await asContractOrText(out);
    }

    return await asContractOrText('Action done.');
  }

  // 2) Choose a route
  const { route, followup } = await classifyRoute({ text, profile: userProfile });

  // 3) If missing info, ask a tight clarifier (no dead ends)
  if (followup && !/^\s*$/.test(followup)) return await asContractOrText(followup);

  // 4) Execute per route
  switch (route) {
    case 'action': {
      const cil = AnyCIL.safeParse(parseToCIL(text)); // placeholder parseToCIL
      if (cil.success) {
        const summary = shortConfirmForCIL(cil.data);
        const pendingId = await createPendingAction({ ownerId, from, cil: cil.data, summary });
        return await asContractOrText(`${summary}\nReply: yes ${pendingId} or no ${pendingId}`);
      }
      return await asContractOrText('I think you want to do something—try “clock in” or “task - buy nails”.');
    }

    case 'insight': {
      const out = await answerInsights({ text, ownerId, tz });
      return await asContractOrText(out);
    }

    case 'rag': {
      const ans = await ragAnswer({ text, ownerId });
      if (ans?.ok) return await asContractOrText(ans.text);
      const web = await webAnswer({ text });
      return await asContractOrText(web.text);
    }

    case 'web': {
      const web = await webAnswer({ text });
      return await asContractOrText(web.text);
    }

    default:
      return await asContractOrText('I can help with time, tasks, expenses, quotes, and KPIs. Try “clock in” or “How am I doing this month?”');
  }
}

module.exports = { orchestrate };

// Placeholder NL → CIL parser (expand with OpenAI if needed)
function parseToCIL(text) {
  const lc = text.toLowerCase();
  if (/(clock in|clock out|break|drive)/i.test(lc)) {
    return { type: 'Clock', action: 'in' }; // stub
  }
  return null;
}
