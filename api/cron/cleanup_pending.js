// api/cron/cleanup_pending.js
// Purges expired pending_actions rows (TTL cleanup).
// Protects with CRON_SECRET; safe to run repeatedly.
// Returns JSON: { ok, deleted, now }

'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 8_000,
});

async function deleteExpired() {
  // Use a CTE so we can return the deleted count in one roundtrip
  const sql = `
    WITH gone AS (
      DELETE FROM public.pending_actions
      WHERE expires_at IS NOT NULL AND expires_at < NOW()
      RETURNING 1
    )
    SELECT COUNT(*)::int AS deleted FROM gone;
  `;
  const { rows } = await pool.query(sql);
  return rows?.[0]?.deleted ?? 0;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    }

    // Simple auth: accept either header or query param
    const headerSecret = req.headers['x-cron-secret'] || req.headers['x-cronkey'];
    const querySecret = (req.query && (req.query.secret || req.query.key)) || null;
    const provided = headerSecret || querySecret || '';
    const expected = process.env.CRON_SECRET || '';

    if (!expected || provided !== expected) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const start = Date.now();
    const deleted = await deleteExpired();
    const ms = Date.now() - start;

    return res.status(200).json({
      ok: true,
      deleted,
      ms,
      now: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[cleanup_pending] error:', err?.message);
    return res.status(500).json({ ok: false, error: err?.message || 'Unknown error' });
  }
};
