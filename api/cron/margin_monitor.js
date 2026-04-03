'use strict';
// api/cron/margin_monitor.js
// Vercel Cron: every 6 hours (see vercel.json)

const { runMarginMonitor } = require('../../workers/marginMonitor');

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

    const result = await runMarginMonitor();
    console.log('[margin_monitor cron]', result);
    return res.status(200).json({ ok: true, ...result, ts: new Date().toISOString() });

  } catch (err) {
    console.error('[margin_monitor cron] fatal:', err?.message);
    return res.status(500).json({ ok: false, error: err?.message });
  }
};
