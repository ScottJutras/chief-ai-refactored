// routes/askChief.js
const express = require('express');
const router = express.Router();

const { requireDashboardOwner } = require('../middleware/requireDashboardOwner');
const { answerChief } = require('../services/answerChief');

router.post('/api/ask-chief', requireDashboardOwner, express.json(), async (req, res) => {
  const ownerId = String(req.ownerId || '').trim();
  const actorKey = ownerId; // portal actor == owner for MVP
  const text = String(req.body?.text || '').trim();
  const tz = 'America/Toronto';

  if (!ownerId) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!text) return res.status(400).json({ ok: false, error: 'missing text' });

  try {
    const out = await answerChief({
      ownerId,
      actorKey,
      text,
      tz,
      channel: 'portal',
      req,
      agent: req.app?.locals?.agent || null,
      context: {}
    });

    if (out?.route === 'action' && typeof out.run === 'function') {
      const ran = await out.run();
      return res.json(ran?.ok ? ran : { ok: true, answer: ran?.answer || 'Done.', evidence: { sql: [], facts_used: 0 } });
    }

    return res.json(out?.ok ? out : { ok: true, answer: out?.answer || 'Done.', evidence: { sql: [], facts_used: 0 } });
  } catch (e) {
    console.error('[ASK_CHIEF] failed:', e?.message);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
