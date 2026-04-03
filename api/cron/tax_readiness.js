'use strict';
// api/cron/tax_readiness.js
// Vercel Cron: quarterly — 9 AM UTC on Jan 1, Apr 1, Jul 1, Oct 1 (see vercel.json)

const { runTaxReadiness } = require('../../workers/taxReadiness');

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

    const result = await runTaxReadiness();
    console.log('[tax_readiness cron]', result);
    return res.status(200).json({ ok: true, ...result, ts: new Date().toISOString() });

  } catch (err) {
    console.error('[tax_readiness cron] fatal:', err?.message);
    return res.status(500).json({ ok: false, error: err?.message });
  }
};
