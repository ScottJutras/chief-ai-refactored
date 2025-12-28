// routes/dashboard.js
// ------------------------------------------------------------
// Mounted at: app.use('/dashboard', require('../routes/dashboard'))
// So this file should use router.get('/') (NOT '/dashboard').
// ------------------------------------------------------------
//
// Alignments:
// - Fix path mounting (GET /dashboard)
// - Defensive query() import
// - Keep your existing payload shape (ok/tiles/kpis/jobs/jobAggregates)

const express = require('express');
const router = express.Router();

const { getCompanyKpis } = require('../services/kpis');
const { getJobKpiSummary } = require('../services/jobsKpis');

const pg = require('../services/postgres');
const query = pg.query || pg.pool?.query || pg.db?.query;

async function resolveOwnerId(req) {
  const { ownerId, token } = req.query || {};

  if (ownerId) return String(ownerId).trim();

  if (token) {
    if (!query) {
      const err = new Error('DB not available');
      err.statusCode = 500;
      throw err;
    }
    const { rows } = await query(
      `SELECT owner_id FROM users WHERE dashboard_token = $1 LIMIT 1`,
      [String(token).trim()]
    );
    if (!rows?.length) {
      const err = new Error('Invalid dashboard token');
      err.statusCode = 404;
      throw err;
    }
    return rows[0].owner_id;
  }

  const err = new Error('ownerId or token is required');
  err.statusCode = 400;
  throw err;
}

function normalizePeriod(raw) {
  const key = String(raw || 'this_month').toLowerCase();
  switch (key) {
    case 'today': return { key: 'today', label: 'Today' };
    case 'this_week': return { key: 'this_week', label: 'This Week' };
    case 'last_month': return { key: 'last_month', label: 'Last Month' };
    case 'ytd': return { key: 'ytd', label: 'Year-to-Date' };
    case 'this_month':
    default: return { key: 'this_month', label: 'This Month' };
  }
}

function buildDashboardPayload(ownerId, periodInfo, companyKpis, jobSummary) {
  const { key: period, label: periodLabel } = periodInfo;
  const { definitions, metrics } = companyKpis || { definitions: {}, metrics: {} };
  const jobs = jobSummary?.jobs || jobSummary || [];
  const jobAgg = jobSummary?.aggregates || {};

  const revenue = metrics.invoiced_amount_period ?? null;
  const grossMarginPct = metrics.gross_margin_pct ?? null;
  const netProfit = metrics.net_profit ?? null;
  const cashInBank = metrics.cash_in_bank ?? null;
  const ar = metrics.total_accounts_receivable ?? null;
  const ap = metrics.total_accounts_payable ?? null;
  const workingCapital = metrics.working_capital ?? null;
  const workingCapitalRatio = metrics.working_capital_ratio ?? null;
  const debtorDays = metrics.average_debtor_days ?? null;

  const tiles = [
    { code: 'revenue', label: 'Invoiced (all time)', unit: 'currency', value_cents: revenue },
    { code: 'net_profit', label: 'Net profit (all time)', unit: 'currency', value_cents: netProfit },
    { code: 'gross_margin_pct', label: 'Gross margin', unit: 'percent', value: grossMarginPct },
    { code: 'cash_in_bank', label: 'Cash in bank', unit: 'currency', value_cents: cashInBank },
    { code: 'ar', label: 'Accounts receivable', unit: 'currency', value_cents: ar },
    { code: 'ap', label: 'Accounts payable', unit: 'currency', value_cents: ap },
    { code: 'working_capital', label: 'Working capital', unit: 'currency', value_cents: workingCapital },
    { code: 'working_capital_ratio', label: 'Working capital ratio', unit: 'ratio', value: workingCapitalRatio },
    { code: 'average_debtor_days', label: 'Debtor days', unit: 'days', value: debtorDays },
  ];

  const kpis = Object.keys(definitions || {}).map((code) => {
    const def = definitions[code];
    return {
      code,
      label: def.label,
      category: def.category,
      unit: def.unit,
      value: metrics[code] ?? null,
    };
  });

  return {
    ok: true,
    ownerId,
    period,
    periodLabel,
    tiles,
    kpis,
    jobs,
    jobAggregates: jobAgg,
  };
}

// GET /dashboard
router.get('/', async (req, res) => {
  const started = Date.now();
  try {
    const ownerId = await resolveOwnerId(req);
    const periodInfo = normalizePeriod(req.query.period);

    const [companyKpis, jobSummary] = await Promise.all([
      getCompanyKpis({ ownerId }),
      getJobKpiSummary(ownerId, { limit: 200 }),
    ]);

    const payload = buildDashboardPayload(ownerId, periodInfo, companyKpis, jobSummary);
    res.json(payload);
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('[DASHBOARD] error:', { message: err.message, stack: err.stack });
    res.status(status).json({ ok: false, error: err.message || 'Dashboard error' });
  } finally {
    const ms = Date.now() - started;
    if (ms > 2000) console.warn('[DASHBOARD] slow response', { ms });
  }
});

module.exports = router;
