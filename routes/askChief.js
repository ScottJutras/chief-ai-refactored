const express = require('express');
const brainV0 = require('../services/brain_v0');
const brainBeta = require('../services/brain_beta');
const router = express.Router();
const pg = require('../services/postgres');
const { getEffectivePlanFromOwner } = require('../src/config/effectivePlan');

// Replace this with your real auth/session mapping.
function getOwnerIdFromRequest(req) {
  return req.user?.owner_id || null;
}

function getActorKeyFromRequest(req) {
  return req.user?.actor_key || req.user?.owner_id || null;
}

async function resolveCapsForOwnerProfile(ownerProfile) {
  const plan = String(getEffectivePlanFromOwner(ownerProfile) || 'free').toLowerCase().trim() || 'free';

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

router.post('/api/ask-chief', express.json(), async (req, res) => {
  const ownerId = getOwnerIdFromRequest(req);
  const actorKey = getActorKeyFromRequest(req);
  const text = String(req.body?.text || '').trim();
  const tz = 'America/Toronto';

  if (!ownerId) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!text) return res.status(400).json({ ok: false, error: 'missing text' });

  let ownerProfile = null;
  try {
    ownerProfile = await pg.getOwnerProfile(String(ownerId));
  } catch (e) {
    console.warn('[ASK_CHIEF] getOwnerProfile failed (fail-open):', e?.message);
  }

  const caps = await resolveCapsForOwnerProfile(ownerProfile);
  const enabled = !!caps?.reasoning?.ask_chief?.enabled;
  const monthlyQuestions = caps?.reasoning?.ask_chief?.monthly_questions ?? 0;

  if (!enabled) {
    return res.json({
      ok: true,
      answer: `Ask Chief is not enabled on your plan.\n\nUpgrade to Starter or Pro to unlock it.`,
      evidence: { sql: [], facts_used: 0 }
    });
  }

  // Quota gate (fail-open if usage table missing)
  try {
    const ym = pg.ymInTZ(tz);
    const usage = await pg.getUsageMonthly(String(ownerId), ym);
    const used = Number(usage?.ask_chief_questions || 0);

    const q = pg.checkMonthlyQuota(monthlyQuestions, used);
    if (!q.allowed) {
      return res.json({
        ok: true,
        answer: `You’ve hit your monthly Ask Chief limit (${used}/${monthlyQuestions}).\n\nUpgrade to Pro for more capacity.`,
        evidence: { sql: [], facts_used: 0 }
      });
    }

    await pg.incrementUsageMonthly(String(ownerId), ym, 'ask_chief_questions', 1);
  } catch (e) {
    console.warn('[ASK_CHIEF] quota check failed (fail-open):', e?.message);
  }

  const v0 = await brainV0.answer({ ownerId, actorKey, text, tz });
  if (v0?.ok) return res.json(v0);

  const agent = req.app?.locals?.agent || null;
  const beta = await brainBeta.answerBeta({ ownerId, actorKey, text, tz, agent });
  if (beta?.ok) return res.json(beta);

  return res.json({
    ok: true,
    answer: `I can’t answer that from facts yet. Try: “cashflow last 7 days”, “profit on job 1556”, or “what happened today”.`,
    evidence: { sql: [], facts_used: 0 }
  });
});

module.exports = router;
