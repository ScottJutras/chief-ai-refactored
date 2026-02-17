// services/chiefOrchestrator.js
const { ragAnswer } = require('./rag_search'); // your existing RAG search wrapper (safe)
const pg = require('./postgres');
// Feature flags (default OFF unless explicitly enabled)
const FEATURE_KPIS = (process.env.FEATURE_FINANCE_KPIS || '0') === '1';
// Quotes are MVP-excluded. Default OFF.
const QUOTES_ENABLED = (process.env.FEATURE_QUOTES || '0') === '1';

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

  // If it contains finance metrics, treat as insight (NOT a definition request)
  if (/\b(profit|revenue|spend|spent|expenses?|cash ?flow|margin|kpi|invoice|paid)\b/.test(s)) {
    return false;
  }

  // How-to / help intent
  if (/\bhow do i\b|\bhow to\b|\bdefine\b|\bmeaning\b|\bhelp\b|\bguide\b|\bhow can i\b/.test(s)) {
    return true;
  }

  // Contractor vocabulary terms (OK for RAG)
  if (/\bretainage\b|\bholdback\b|\bprogress billing\b|\bchange order\b/.test(s)) {
    return true;
  }

  // Only allow "what is" if it's a contractor term (prevents “what is my profit”)
  if (/\bwhat is\b/.test(s) && /\b(retainage|holdback|change order|progress billing)\b/.test(s)) {
    return true;
  }

  return false;
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
function normalizeHandlerOutput(out, fallback = 'Done.') {
  if (out == null) return fallback;

  // Common legacy patterns
  if (typeof out === 'string') {
    const s = out.trim();
    return s || fallback;
  }

  // Many handlers return { text }, { message }, { twiml }, { ok, text }, etc.
  const cand =
    (typeof out.text === 'string' && out.text) ||
    (typeof out.message === 'string' && out.message) ||
    (typeof out.twiml === 'string' && out.twiml) ||
    (typeof out.answer === 'string' && out.answer) ||
    null;

  if (cand && String(cand).trim()) return String(cand).trim();
  return fallback;
}

async function answerInsight({ ownerId, actorKey, text, tz }) {
  return await answerInsightV0({ ownerId, actorKey, text, tz });
}


async function orchestrateChief({ ownerId, actorKey, text, tz, channel, req, agent, context }) {
  const rawText = String(text || '').trim();
  const s = lc(rawText);

  // 00) Pending-action / mid-flow resolver (prevents "yes" being misrouted)
  // If we’re mid-confirmation, do NOT let the orchestrator route this message elsewhere.
  if (context?.userProfile?.pending_action) {
    return {
      ok: true,
      route: 'action',
      action: 'pending_action',
      run: async () => {
        let out = null;

        // Best-effort pending action handler (safe if missing)
        try {
          const { handlePendingAction } = require('../handlers/pending_action');
          if (typeof handlePendingAction === 'function') {
            out = await handlePendingAction(context, rawText);
          }
        } catch (e) {
          // swallow; do not guess
        }

        const msg = normalizeHandlerOutput(
          out,
          'Please finish the pending confirmation first (or reply “cancel”).'
        );

        return { ok: true, route: 'action', answer: msg, evidence: { sql: [], facts_used: 0 } };
      }
    };
  }

  // 01) Job picker token safety net (your tokens are jp:...)
  // If this reaches Chief, do NOT treat it as natural language.
  // Webhook SHOULD consume jp: earlier; this is a last-resort loop breaker.
  if (/^jp:/i.test(rawText)) {
    return {
      ok: true,
      route: 'clarify',
      answer: '✅ Job selected. Now tell me what you want to do (expense / revenue / time / task).',
      evidence: { sql: [], facts_used: 0 }
    };
  }

  // 0) Deterministic “how-to/definition” → RAG
  if (looksLikeHowToOrDefinition(rawText)) {
    const ans = await ragAnswer({ text: rawText, ownerId });
    return {
      ok: true,
      route: 'rag',
      answer: ans || `I don’t have that in docs yet.`,
      evidence: { sql: [], facts_used: 0 }
    };
  }

  // 1) Deterministic writes (action)
  if (looksLikeTimeclock(rawText)) {
    return {
      ok: true,
      route: 'action',
      action: 'timeclock',
      run: async () => {
        const nowIso = new Date().toISOString();
        const messageSid = context?.messageSid || null;
        const actorId = DIGITS(actorKey);

        const ctx = {
          owner_id: DIGITS(ownerId),
          user_id: actorId,
          created_by: actorId,
          source_msg_id: messageSid,
          tz: tz || 'America/Toronto',
          job_id: context?.userProfile?.active_job_id || null,
          meta: { job_name: context?.userProfile?.active_job_name || null }
        };

        const cil = { action: 'timeclock', text: rawText, at: nowIso };
        const out = await handleClock(ctx, cil);

        const msg = normalizeHandlerOutput(out, 'Time logged.');
        return { ok: true, route: 'action', answer: msg, evidence: { sql: [], facts_used: 0 } };
      }
    };
  }

  if (QUOTES_ENABLED && looksLikeQuote(rawText)) {
    return {
      ok: true,
      route: 'action',
      action: 'quote',
      run: async () => {
        const out = await handleQuoteCommand({
          ownerId,
          from: context?.from || null,
          text: rawText,
          userProfile: context?.userProfile || null
        });

        const msg = normalizeHandlerOutput(out, 'Quote Updated.');
        return { ok: true, route: 'action', answer: msg, evidence: { sql: [], facts_used: 0 } };
      }
    };
  }

  if (looksLikeExpense(rawText)) {
    return {
      ok: true,
      route: 'action',
      action: 'expense',
      run: async () => {
        const from = context?.from || null;
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

        const msg = normalizeHandlerOutput(out, 'Expense logged.');
        return { ok: true, route: 'action', answer: msg, evidence: { sql: [], facts_used: 0 } };
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

        const msg = normalizeHandlerOutput(out, 'Revenue logged.');
        return { ok: true, route: 'action', answer: msg, evidence: { sql: [], facts_used: 0 } };
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

        const msg = normalizeHandlerOutput(out, 'Task Updated.');
        return { ok: true, route: 'action', answer: msg, evidence: { sql: [], facts_used: 0 } };
      }
    };
  }

  if (looksLikeJob(rawText)) {
    return {
      ok: true,
      route: 'action',
      action: 'jobs',
      run: async () => {
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

        const msg = normalizeHandlerOutput(out, 'Job Updated.');
        return { ok: true, route: 'action', answer: msg, evidence: { sql: [], facts_used: 0 } };
      }
    };
  }

  // 2) Deterministic insight questions
  if (looksLikeInsightQuestion(rawText)) {
    return await answerInsight({ ownerId, actorKey, text: rawText, tz });
  }

  // 3) Final fallback: RAG first
  const rag = await ragAnswer({ text: rawText, ownerId });
  if (rag) return { ok: true, route: 'rag', answer: rag, evidence: { sql: [], facts_used: 0 } };

  return {
    ok: true,
    route: 'clarify',
    answer:
      'Do you want me to (1) log something (expense/revenue/time/task), or (2) answer a question (profit/cashflow/KPIs)?\n\nReply “log” or “question”.',
    evidence: { sql: [], facts_used: 0 }
  };
}


module.exports = { orchestrateChief };
