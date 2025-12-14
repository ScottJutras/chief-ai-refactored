// scripts/demoKpi.js
require('dotenv').config({ path: './config/.env' });
const { query } = require('../services/postgres');
const { processBatch } = require('../services/kpiWorker');

(async () => {
  await query(`INSERT INTO public.cash_in(owner_id, job_no, occurred_at, amount_cents)
               VALUES ('19053279955', 8, NOW(), 9900)
               ON CONFLICT DO NOTHING;`);
  await query(`INSERT INTO public.kpi_touches(owner_id, job_no, day)
               VALUES ('19053279955', 8, CURRENT_DATE);`);
  await processBatch();
  const { rows } = await query(`
    SELECT day, job_no, revenue_cents, cogs_cents, gross_profit_cents, gross_margin_pct,
           paid_minutes, drive_minutes, labour_cost_cents
    FROM public.job_kpis_daily
    WHERE owner_id='19053279955'
    ORDER BY day DESC, job_no NULLS FIRST
    LIMIT 5
  `);
  console.log(rows);
  process.exit(0);
})();
