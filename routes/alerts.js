// routes/alerts.js
// POST /api/alerts/dismiss  — mark an insight_log entry as acknowledged
//
// Uses portal auth — tenant boundary enforced via tenantId check.

'use strict';

const express = require('express');
const router = express.Router();

const pg = require('../services/postgres');
const { requirePortalUser } = require('../middleware/requirePortalUser');

router.use(express.json({ limit: '32kb' }));

// POST /api/alerts/dismiss
// Body: { id: number, signal_key: string }
router.post('/dismiss', requirePortalUser(), async (req, res) => {
  try {
    const tenantId = req.tenantId;
    if (!tenantId) return res.status(401).json({ ok: false, error: 'Missing tenant context' });

    const { id, signal_key } = req.body || {};
    if (!id || !Number.isInteger(Number(id))) {
      return res.status(400).json({ ok: false, error: 'Missing or invalid id' });
    }

    // Enforce tenant boundary — only allow acknowledging rows that belong to this tenant
    const result = await pg.query(
      `UPDATE public.insight_log
       SET acknowledged_at = NOW()
       WHERE id = $1
         AND tenant_id = $2
         AND acknowledged_at IS NULL
       RETURNING id`,
      [Number(id), tenantId]
    );

    if (!result?.rows?.length) {
      // Either already acknowledged or doesn't belong to this tenant — both are fine silently
      return res.json({ ok: true, already_done: true });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('[ALERTS_DISMISS]', e?.message);
    return res.status(500).json({ ok: false, error: 'dismiss_failed' });
  }
});

module.exports = router;
