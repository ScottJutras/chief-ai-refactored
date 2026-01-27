// routes/debug.js
// Dev-only debug endpoints.
// GET  /api/debug/ping
// GET  /api/debug/pending-drafts?ownerId=...
// GET  /api/debug/cil-drafts?ownerId=...&limit=20
// POST /api/debug/contract  -> Answer Contract JSON (Brain v0)

const express = require('express');
const router = express.Router();

const { orchestrate } = require('../services/orchestrator');
const pg = require('../services/postgres');

// Parse JSON ONLY for this router (keeps your global “no parsers” rule)
router.use(express.json({ limit: '256kb' }));

function maskDbUrl(u) {
  const s = String(u || '');
  if (!s) return null;
  return s.replace(/\/\/([^@]+)@/g, '//***:***@');
}

function errToObj(e) {
  if (!e) return null;
  return {
    message: e.message || String(e),
    code: e.code || null,
    detail: e.detail || null,
    hint: e.hint || null,
    where: e.where || null,
    schema: e.schema || null,
    table: e.table || null,
    column: e.column || null,
    constraint: e.constraint || null,
    stack: e.stack ? String(e.stack).split('\n').slice(0, 6).join('\n') : null
  };
}

router.get('/debug/ping', (req, res) => {
  return res.json({
    ok: true,
    ts: Date.now(),
    database_url: process.env.DATABASE_URL ? 'set' : 'missing',
    db_url_masked: maskDbUrl(process.env.DATABASE_URL),
    has_countPendingCilDrafts: typeof pg.countPendingCilDrafts === 'function'
  });
});

// ✅ Direct unit test endpoint for the DB function
router.get('/debug/pending-drafts', async (req, res) => {
  try {
    const ownerId = String(req.query.ownerId || '').trim();
    if (!ownerId) return res.status(400).json({ ok: false, error: 'ownerId is required' });

    const n = await pg.countPendingCilDrafts(ownerId);
    return res.json({
      ok: true,
      ownerId,
      pendingDrafts: n,
      db_url_masked: maskDbUrl(process.env.DATABASE_URL)
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: 'countPendingCilDrafts failed',
      err: errToObj(e),
      db_url_masked: maskDbUrl(process.env.DATABASE_URL)
    });
  }
});

// ✅ Inspect the actual draft rows (definitive)
router.get('/debug/cil-drafts', async (req, res) => {
  try {
    const ownerId = String(req.query.ownerId || '').trim();
    const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20) || 20));
    if (!ownerId) return res.status(400).json({ ok: false, error: 'ownerId is required' });

    const q = pg.query || pg.pool?.query;
    if (!q) return res.status(500).json({ ok: false, error: 'DB query not available' });

    const { rows } = await q(
      `
      select
        id,
        owner_id::text as owner_id,
        kind,
        status,
        source_msg_id,
        actor_phone,
        actor_user_id,
        confirmed_transaction_id,
        created_at,
        updated_at
      from public.cil_drafts
      where owner_id::text = $1
      order by created_at desc
      limit $2
      `,
      [ownerId, limit]
    );

    return res.json({ ok: true, ownerId, rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'list drafts failed', err: errToObj(e) });
  }
});

router.post('/debug/contract', async (req, res) => {
  try {
    const body = req.body || {};

    const text = String(body.text || '').trim();
    const ownerId = String(body.ownerId || '').trim();
    const from = String(body.from || '').trim() || '+19055551234';
    const wantDebug = !!body.debug;

    if (!text) return res.status(400).json({ ok: false, error: 'text is required' });
    if (!ownerId) return res.status(400).json({ ok: false, error: 'ownerId is required' });

    const userProfile = {
      tz: body.tz || 'America/Toronto',
      plan: body.plan || 'pro',
      subscription_tier: body.subscription_tier || 'pro'
    };

    let pendingDrafts = null;
    let pendingDraftsErr = null;
    try {
      pendingDrafts = await pg.countPendingCilDrafts(ownerId);
      if (typeof pendingDrafts === 'string') pendingDrafts = Number(pendingDrafts);
      if (!Number.isFinite(pendingDrafts)) pendingDrafts = null;
    } catch (e) {
      pendingDrafts = null;
      pendingDraftsErr = errToObj(e);
    }

    const out = await orchestrate({
      from,
      text,
      userProfile,
      ownerId,
      returnContract: true
    });

    if (wantDebug && out && typeof out === 'object') {
      out._debug = {
        ownerId,
        pendingDrafts,
        pendingDraftsErr,
        database_url: maskDbUrl(process.env.DATABASE_URL),
        node_env: process.env.NODE_ENV || null
      };
    }

    return res.json(out);
  } catch (e) {
    console.error('[DEBUG/contract] failed:', e?.message, e?.stack);
    return res.status(500).json({ ok: false, error: e?.message || 'debug error', err: errToObj(e) });
  }
});

module.exports = router;
