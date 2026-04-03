'use strict';
// api/cron/daily_job_summary.js
// Vercel Cron: 22:00 UTC daily (6pm ET / 3pm PT)

const { runDailyJobSummary } = require('../../workers/dailyJobSummary');

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

    const result = await runDailyJobSummary();
    console.log('[daily_job_summary cron]', result);
    return res.status(200).json({ ok: true, ...result, ts: new Date().toISOString() });

  } catch (err) {
    console.error('[daily_job_summary cron] fatal:', err?.message);
    return res.status(500).json({ ok: false, error: err?.message });
  }
};
