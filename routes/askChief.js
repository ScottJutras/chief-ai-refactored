const express = require('express');
const brainV0 = require('../services/brain_v0');
const brainBeta = require('../services/brain_beta');
const router = express.Router();
const { PRO_CREW_UPGRADE_LINE, UPGRADE_FOLLOWUP_ASK } = require('../src/config/upgradeCopy');

// Replace this with your real auth/session mapping.
function getOwnerIdFromRequest(req) {
  // e.g. req.user.owner_id, or JWT claims, etc.
  return req.user?.owner_id || null;
}

function getActorKeyFromRequest(req) {
  // optional for portal; can be owner phone digits if you have it
  return req.user?.actor_key || req.user?.owner_id || null;
}

router.post('/api/ask-chief', express.json(), async (req, res) => {
  const ownerId = getOwnerIdFromRequest(req);
  const actorKey = getActorKeyFromRequest(req);
  const text = String(req.body?.text || '').trim();

  if (!ownerId) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!text) return res.status(400).json({ ok: false, error: 'missing text' });

  // 1) Brain v0 fast path
  const v0 = await brainV0.answer({ ownerId, actorKey, text, tz: 'America/Toronto' });
  if (v0?.ok) return res.json(v0);

  // 2) Beta Brain (if enabled / agent available)
  // Wire your agent wrapper if desired; otherwise omit.
  const agent = req.app?.locals?.agent || null;

  const beta = await brainBeta.answerBeta({ ownerId, actorKey, text, tz: 'America/Toronto', agent });
  if (beta?.ok) return res.json(beta);

  // 3) Fallback (existing agent/help)
  return res.json({
    ok: true,
    answer: `I can’t answer that from facts yet. Try: “cashflow last 7 days”, “profit on job 1556”, or “what happened today”.`,
    evidence: { sql: [], facts_used: 0 }
  });
});

module.exports = router;
