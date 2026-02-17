// services/chiefOrchestrator.js
const { ragAnswer } = require('./rag_search'); // your existing RAG search wrapper (safe)
const pg = require('./postgres');
// Feature flags (default OFF unless explicitly enabled)
const FEATURE_QUOTES = (process.env.FEATURE_QUOTES || '0') === '1';
const FEATURE_KPIS = (process.env.FEATURE_FINANCE_KPIS || '0') === '1';

// Existing handlers (writes go through these only)
const { handleExpense } = require('../handlers/commands/expense');
const { handleRevenue } = require('../handlers/commands/revenue');
const { handleTasks } = require('../handlers/commands/tasks');
const { handleJob } = require('../handlers/commands/job'); // if you have a single entry; else adapt
const { handleQuoteCommand } = require('../handlers/commands/quote');
const { handleClock } = require('../handlers/commands/timeclock'); // your newer v2 clock handler
const { answerInsightV0 } = require('./insights_v0');


function lc(s) { return String(s || '').toLowerCase(); }
function DIGITS(x) { return String(x ?? '').replace(/\D/g, ''); }

function looksLikeHowToOrDefinition(text) {
  const s = lc(text);
  return (
    /\bhow do i\b|\bhow to\b|\bwhat is\b|\bdefine\b|\bmeaning\b|\bhelp\b|\bguide\b|\bhow can i\b/.test(s) ||
    /\bretainage\b|\bholdback\b|\bprogress billing\b|\bchange order\b/.test(s)
  );
}

function looksLikeTimeclock(text) {
  const s = lc(text);
  return /\bclock\s+(in|out)\b|\bbreak\b|\bdrive\b|\btimesheet\b|\bhours\b/.test(s);
}

function looksLikeExpense(text) {
  const s = lc(text);
  return /^\s*(expense|spent|paid)\b/.test(s) || /\b(expense|receipt)\b/.test(s);
}

function looksLikeRevenue(text) {
  const s = lc(text);
  return /^\s*(revenue|earned|deposit|invoice|paid by customer)\b/.test(s);
}

function looksLikeTask(text) {
  const s = lc(text);
  return /^\s*(task|todo)\b/.test(s) || /\bmy tasks\b|\binbox\b|\bdone\s*#?\d+/.test(s);
}

function looksLikeJob(text) {
  const s = lc(text);
  return /\b(create|new|start|activate|pause|resume|finish|close)\s+job\b/.test(s) ||
         /\b(active job|change job|list jobs)\b/.test(s);
}

function looksLikeQuote(text) {
  const s = lc(text);
  return /^\s*(quote)\b/.test(s) || /\bcreate quote\b/.test(s);
}

function looksLikeInsightQuestion(text) {
  const s = lc(text);
  return (
    /\bprofit\b|\bmargin\b|\bcash ?flow\b|\bspend\b|\brevenue\b|\bnet\b|\bhow much\b|\bwhat did i\b|\blast (7|14|30) days\b/.test(s) ||
    /^kpis?\b/.test(s)
  );
}

async function answerInsight({ ownerId, actorKey, text, tz }) {
  return await answerInsightV0({ ownerId, actorKey, text, tz });
}

function normalizeHandlerOutput(out, fallbackText) {
  if (typeof out === 'string' && out.trim()) return out.trim();
  if (out?.text && String(out.text).trim()) return String(out.text).trim();
  if (out?.twiml && String(out.twiml).trim()) return String(out.twiml).trim(); // if you ever bubble it
  return fallbackText;
}


async function orchestrateChief({ ownerId, actorKey, text, tz, channel, req, agent, context }) {
  const rawText = String(text || '').trim();
  const s = lc(rawText);

  // 0) Deterministic “how-to/definition” → RAG
  if (looksLikeHowToOrDefinition(rawText)) {
    const ans = await ragAnswer({ text: rawText, ownerId });
    return { ok: true, route: 'rag', answer: ans || `I don’t have that in docs yet.`, evidence: { sql: [], facts_used: 0 } };
  }

  // 1) Deterministic writes (action)
  if (looksLikeTimeclock(rawText)) {
    return {
      ok: true,
      route: 'action',
      action: 'timeclock',
      run: async () => {
        // Use your v2 handleClock signature via ctx+cil if you already have it,
        // or call your existing handleTimeclock wrapper. This is the safe “call the handler” point.
        const nowIso = new Date().toISOString();
        const messageSid = context?.messageSid || null;
        const actorId = DIGITS(actorKey);

        // Minimal ctx; adapt to your timeclock v2 CIL contract
        const ctx = {
          owner_id: DIGITS(ownerId),
          user_id: actorId,
          created_by: actorId,
          source_msg_id: messageSid,
          tz: tz || 'America/Toronto',
          job_id: context?.userProfile?.active_job_id || null,
          meta: { job_name: context?.userProfile?.active_job_name || null }
        };

        const cil = { action: 'timeclock', text: rawText, at: nowIso }; // adapt to your expected CIL
        const out = await handleClock(ctx, cil);

        const answer = normalizeHandlerOutput(out, 'Time logged.');
return { ok: true, route: 'action', answer, evidence: { sql: [], facts_used: 0 } };
      }
    };
  }

  if (FEATURE_QUOTES && looksLikeQuote(rawText)) {
  return {
    ok: true,
    route: 'action',
    action: 'quote',
    run: async () => {
      const msg = await handleQuoteCommand({
        ownerId,
        from: context?.from || null,
        text: rawText,
        userProfile: context?.userProfile || null
      });

      const answer = normalizeHandlerOutput(msg, 'Quote updated.');
      return { ok: true, route: 'action', answer, evidence: { sql: [], facts_used: 0 } };
    }
  };
}

  if (looksLikeExpense(rawText)) {
    return {
      ok: true,
      route: 'action',
      action: 'expense',
      run: async () => {
        const from = context?.from || null;           // WhatsApp reply identity (+E164)
        const messageSid = context?.messageSid || null;
        const reqBody = context?.reqBody || null;
        const out = await handleExpense(
          from,
          rawText,
          context?.userProfile || null,
          ownerId,
          context?.ownerProfile || null,
          !!context?.isOwner,
          messageSid,
          reqBody
        );
        const answer = normalizeHandlerOutput(out, 'Expense logged.');
return { ok: true, route: 'action', answer, evidence: { sql: [], facts_used: 0 } };

      }
    };
  }

  if (looksLikeRevenue(rawText)) {
    return {
      ok: true,
      route: 'action',
      action: 'revenue',
      run: async () => {
        const from = context?.from || null;
        const messageSid = context?.messageSid || null;
        const reqBody = context?.reqBody || null;
        const out = await handleRevenue(
          from,
          rawText,
          context?.userProfile || null,
          ownerId,
          context?.ownerProfile || null,
          !!context?.isOwner,
          messageSid,
          reqBody
        );
        const answer = normalizeHandlerOutput(out, 'Revenue logged.'); // or Task updated / Job updated
return { ok: true, route: 'action', answer, evidence: { sql: [], facts_used: 0 } };

      }
    };
  }

  if (looksLikeTask(rawText)) {
    return {
      ok: true,
      route: 'action',
      action: 'tasks',
      run: async () => {
        const from = context?.from || null;
        const messageSid = context?.messageSid || null;
        const reqBody = context?.reqBody || null;
        const out = await handleTasks(
          from,
          rawText,
          context?.userProfile || null,
          ownerId,
          context?.ownerProfile || null,
          !!context?.isOwner,
          messageSid,
          reqBody
        );
        const answer = normalizeHandlerOutput(out, 'Task Updated.'); 
return { ok: true, route: 'action', answer, evidence: { sql: [], facts_used: 0 } };

      }
    };
  }

  if (looksLikeJob(rawText)) {
    return {
      ok: true,
      route: 'action',
      action: 'jobs',
      run: async () => {
        // If you have a single job handler entry point; otherwise adapt to your command module
        const from = context?.from || null;
        const messageSid = context?.messageSid || null;
        const reqBody = context?.reqBody || null;
        const out = await handleJob(
          from,
          rawText,
          context?.userProfile || null,
          ownerId,
          context?.ownerProfile || null,
          !!context?.isOwner,
          messageSid,
          reqBody
        );
        const answer = normalizeHandlerOutput(out, 'Job Updated.'); // or Task updated / Job updated
return { ok: true, route: 'action', answer, evidence: { sql: [], facts_used: 0 } };

      }
    };
  }

  // 2) Deterministic insight questions
  if (looksLikeInsightQuestion(rawText)) {
    return await answerInsight({ ownerId, actorKey, text: rawText, tz });
  }

  // 3) Final fallback: RAG first, then (later) narrated LLM if you want
  const rag = await ragAnswer({ text: rawText, ownerId });
  if (rag) return { ok: true, route: 'rag', answer: rag, evidence: { sql: [], facts_used: 0 } };

  return {
    ok: true,
    route: 'clarify',
    answer: `Do you want me to (1) log something (expense/revenue/time/task), or (2) answer a question (profit/cashflow/KPIs)?\n\nReply “log” or “question”.`,
    evidence: { sql: [], facts_used: 0 }
  };
}

module.exports = { orchestrateChief };
