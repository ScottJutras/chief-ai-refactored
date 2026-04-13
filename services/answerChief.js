// services/answerChief.js
// One orchestrator path for ALL inputs.
// IMPORTANT: Ask-Chief gating applies ONLY to reasoning routes (insight/rag/clarify), never to action/capture.

const pg = require('./postgres');
const { getEffectivePlanFromOwner } = require('../src/config/effectivePlan');
const { orchestrateChief } = require('./orchestrator');


function DIGITS(x) { return String(x ?? '').replace(/\D/g, ''); }

function ymInTZ(tz = 'America/Toronto') {
  if (typeof pg.ymInTZ === 'function') return pg.ymInTZ(tz);
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function resolveCapsForOwnerProfile(ownerProfile) {
  const plan = String(getEffectivePlanFromOwner(ownerProfile) || 'free').toLowerCase().trim() || 'free';

  // Prefer your canonical plan caps module(s)
  try {
    const capMod = require('../src/config/capabilities');
    const fn =
      capMod?.getCapabilitiesForPlan ||
      capMod?.resolveCapabilities ||
      capMod?.getPlanCapabilities ||
      null;
    if (typeof fn === 'function') return fn(plan);
  } catch {}

  try {
    const { plan_capabilities } = require('../src/config/planCapabilities');
    return plan_capabilities?.[plan] || plan_capabilities?.free || null;
  } catch {}

  return null;
}

async function enforceAskChiefGates_AND_Consume({ ownerId, ownerProfile, tz }) {
  // Fail-closed on plan lookup: treat as free
  const caps = await resolveCapsForOwnerProfile(ownerProfile);
  const enabled = !!caps?.reasoning?.ask_chief?.enabled;
  const monthlyLimit = Number(caps?.reasoning?.ask_chief?.monthly_questions ?? 0) || 0;

  if (!enabled) {
    // Fallback for plans where ask_chief.enabled is false (should not happen for free/starter/pro).
    // Uses a conservative limit so unexpected plan states don't grant unlimited access.
    try {
      const ym = ymInTZ(tz);
      const usage = await pg.getUsageMonthly(String(ownerId), ym);
      const trialUsed = Number(usage?.ask_chief_questions || 0);
      const TRIAL_LIMIT = 10;

      if (trialUsed >= TRIAL_LIMIT) {
        return {
          ok: true,
          gated: true,
          answer:
            `You've used your ${TRIAL_LIMIT} free Ask Chief queries this month.\n\n` +
            `Upgrade to Starter ($59/month) to unlock 250 questions/month, plus financial insights, job profitability, and more.\n\n` +
            `👉 usechiefos.com/pricing`,
          evidence: { sql: [], facts_used: 0, warnings: ['TRIAL_EXHAUSTED'] }
        };
      }

      // Consume BEFORE execution (fail-closed rule)
      await pg.incrementUsageMonthly(String(ownerId), ym, 'ask_chief_questions', 1);
      return { ok: true, gated: false, trial: true, trialUsed: trialUsed + 1, trialLimit: TRIAL_LIMIT };
    } catch {
      // Fail-closed: if trial check fails, block access
      return {
        ok: true,
        gated: true,
        answer: `Ask Chief is available on Starter and above.\n\nUpgrade at usechiefos.com/pricing`,
        evidence: { sql: [], facts_used: 0, warnings: ['NOT_INCLUDED'] }
      };
    }
  }

  // Quota must be fail-closed per Monetization Enforcement Constitution
  try {
    const ym = ymInTZ(tz);
    const usage = await pg.getUsageMonthly(String(ownerId), ym);
    const used = Number(usage?.ask_chief_questions || 0);

    const q = pg.checkMonthlyQuota(monthlyLimit, used);
    if (!q.allowed) {
      return {
        ok: true,
        gated: true,
        answer: `You’ve hit your monthly Ask Chief limit (${used}/${monthlyLimit}).\n\nUpgrade to Pro for more capacity.`,
        evidence: { sql: [], facts_used: 0, warnings: ['OVER_QUOTA'] }
      };
    }

    // Consume BEFORE execution (rule)
    await pg.incrementUsageMonthly(String(ownerId), ym, 'ask_chief_questions', 1);
    return { ok: true, gated: false };
  } catch (e) {
    console.warn('[ASK_CHIEF] quota check failed (FAIL-CLOSED):', e?.message);
    return {
      ok: true,
      gated: true,
      answer: `Ask Chief is temporarily unavailable (quota system). Please try again.`,
      evidence: { sql: [], facts_used: 0, warnings: ['QUOTA_UNAVAILABLE'] }
    };
  }
}

async function answerChief({
  ownerId,
  actorKey,
  text,
  tz = 'America/Toronto',
  channel = 'whatsapp',
  req = null,
  agent = null,
  context = {}
}) {
  const ownerIdNorm = DIGITS(ownerId);
  const actorKeyNorm = DIGITS(actorKey || ownerIdNorm);
  const cleanedText = String(text || '').trim();

  if (!ownerIdNorm) return { ok: false, error: 'missing ownerId' };
  if (!cleanedText) return { ok: true, answer: '', evidence: { sql: [], facts_used: 0 } };

  // Load ownerProfile (best effort). If missing, gates treat as free (fail-closed).
  let ownerProfile = context.ownerProfile || null;
  try {
    if (!ownerProfile) ownerProfile = await pg.getOwnerProfile(String(ownerIdNorm));
  } catch (e) {
    console.warn('[CHIEF] getOwnerProfile failed:', e?.message);
  }

  let actorMemory = {};
try {
  if (typeof pg.getActorMemory === 'function') {
    actorMemory = await pg.getActorMemory(ownerIdNorm, actorKeyNorm);
  }
} catch (e) {
  console.warn('[CHIEF] getActorMemory failed:', e?.message);
}

  // 1) Route FIRST (deterministic-first). Orchestrator must not write directly.
  const decision = await orchestrateChief({
  ownerId: ownerIdNorm,
  actorKey: actorKeyNorm,
  text: cleanedText,
  tz,
  channel,
  req,
  agent,
  context: { ...context, ownerProfile, actorMemory }
});

    // 2) If action route: DO NOT Ask-Chief gate. This preserves Free-tier capture.
  if (decision?.route === "action") return decision;

  // 3) If reasoning route: enforce plan + quota (fail-closed) + consume quota before answering.
  const gate = await enforceAskChiefGates_AND_Consume({ ownerId: ownerIdNorm, ownerProfile, tz });
  if (gate?.gated) return gate;

  // 4) Execute reasoning AFTER gates
  let result;
  if (typeof decision?.run === "function") {
    try {
      result = await decision.run();
    } catch (e) {
      console.warn("[CHIEF] reasoning run failed:", e?.message);
      return { ok: true, answer: "Something went wrong. Try again.", evidence: { sql: [], facts_used: 0 } };
    }
  } else {
    result = decision;
  }

  // 5) Append free trial footer
  if (gate?.trial && result?.answer) {
    const remaining = gate.trialLimit - gate.trialUsed;
    const footer = remaining > 0
      ? `\n\n─\n🆓 Free query ${gate.trialUsed}/${gate.trialLimit} — ${remaining} left this month.\nUpgrade to Starter ($59/mo) for unlimited: usechiefos.com/pricing`
      : `\n\n─\n🆓 That was your last free query this month.\nUpgrade to Starter ($59/mo) for unlimited: usechiefos.com/pricing`;
    result = { ...result, answer: result.answer + footer };
  }

  return result;
}

module.exports = { answerChief, enforceAskChiefGates_AND_Consume };
