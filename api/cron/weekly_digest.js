'use strict';
// api/cron/weekly_digest.js
// Vercel Cron: every Friday at 16:00 UTC (see vercel.json)

const { runWeeklyDigest } = require('../../workers/weeklyDigest');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    }

    const isVercelCron = req.headers['x-vercel-cron'] === '1';
    const provided = req.headers['x-cron-secret'] || req.query?.secret || '';
    const expected  = process.env.CRON_SECRET || '';
    if (!isVercelCron && (!expected || provided !== expected)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const result = await runWeeklyDigest();
    console.log('[weekly_digest cron]', result);
    return res.status(200).json({ ok: true, ...result, ts: new Date().toISOString() });

  } catch (err) {
    console.error('[weekly_digest cron] fatal:', err?.message);
    return res.status(500).json({ ok: false, error: err?.message });
  }
};
