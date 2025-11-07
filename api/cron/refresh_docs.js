// api/cron/refresh_docs.js
'use strict';

/**
 * Refresh the GLOBAL RAG index from markdown/PDF docs.
 * Auth: require ?token=... or Authorization: Bearer ...
 *
 * Env:
 *  - DATABASE_URL (required)
 *  - OPENAI_API_KEY (required)
 *  - RAG_DOCS_DIR (optional; defaults to 'docs/howto')
 *  - CRON_TOKEN or CRON_SECRET (one required)
 */

const path = require('path');

// Import the loader's exported function
const { runRagRefresh } = require('../../scripts/rag_loader');

function getToken(req) {
  // Prefer query string, then Authorization header
  const q = (req.query && (req.query.token || req.query.t)) || null;
  if (q) return String(q);
  const auth = req.headers?.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'HEAD') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

    const TOKEN = process.env.CRON_TOKEN || process.env.CRON_SECRET;
    if (!TOKEN) {
      return res.status(500).json({ ok: false, error: 'Missing CRON_TOKEN/CRON_SECRET env' });
    }

    const provided = getToken(req);
    if (provided !== TOKEN) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    if (!process.env.DATABASE_URL || !process.env.OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: 'Missing DATABASE_URL or OPENAI_API_KEY' });
    }

    // Base directory to crawl for docs (markdown/pdf)
    const baseDir = process.env.RAG_DOCS_DIR || path.join(process.cwd(), 'docs/howto');

    const summary = await runRagRefresh({
      baseDir,
      ownerId: 'GLOBAL',
      // You can cap chunks per file if desired:
      // maxChunksPerFile: 400
    });

    // Nice short message for “owner” notifications
    const changeNote = summary.indexed
      ? `Indexed ${summary.indexed} files (${summary.newChunks} new chunks).` +
        (summary.message?.includes('New/updated:') ? ` ${summary.message}` : '')
      : `No changes detected. (${summary.skipped} files up-to-date)`;

    return res.status(200).json({ ok: true, ...summary, note: changeNote });
  } catch (e) {
    console.error('[cron/refresh_docs] error:', e?.message);
    return res.status(500).json({ ok: false, error: e?.message || 'Refresh failed' });
  }
};
