// api/cron/refresh_docs.js
'use strict';

/**
 * RAG docs refresher
 * - Weekly cron: allowed via Vercel's X-Vercel-Cron header
 * - On-demand:   GET /api/cron/refresh_docs?token=YOUR_CRON_SECRET
 * - Uses scripts/rag_loader.js: runRagRefresh({ baseDir: process.env.RAG_DOCS_DIR || 'docs/howto' })
 */

const path = require('path');

let runner = null;
function getRunner() {
  if (runner) return runner;
  // from /api/cron/* to /scripts/rag_loader.js
  runner = require('../../scripts/rag_loader.js');
  if (!runner || typeof runner.runRagRefresh !== 'function') {
    throw new Error('rag_loader.runRagRefresh not found');
  }
  return runner;
}

function ok(res, body)    { res.status(200).json(body); }
function bad(res, body)   { res.status(400).json(body); }
function denied(res, msg) { res.status(403).json({ ok: false, error: msg || 'Forbidden' }); }
function oops(res, e)     { res.status(500).json({ ok: false, error: e?.message || String(e) }); }

module.exports = async (req, res) => {
  try {
    // Allow only GET/HEAD
    if (req.method === 'HEAD') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

    // Auth:
    // 1) Vercel Cron calls include this header
    const isCron = !!req.headers['x-vercel-cron'];
    // 2) Manual trigger requires ?token=CRON_SECRET
    const token = (req.query?.token || req.headers['x-cron-token'] || '').toString();
    const secret = process.env.CRON_SECRET || '';

    if (!isCron) {
      if (!secret) return denied(res, 'CRON_SECRET not set');
      if (!token || token !== secret) return denied(res, 'Invalid token');
    }

    const { runRagRefresh } = getRunner();
    const baseDir = process.env.RAG_DOCS_DIR || 'docs/howto'; // mounted into the lambda bundle
    const started = Date.now();

    const summary = await runRagRefresh({ baseDir, ownerId: 'GLOBAL' });
    const ms = Date.now() - started;

    return ok(res, {
      ok: true,
      took_ms: ms,
      dir: baseDir,
      ...summary // { indexed, skipped, newChunks, message }
    });
  } catch (e) {
    return oops(res, e);
  }
};
