// routes/dashboard.js
// ------------------------------------------------------------
// GET /api/dashboard
//
// Returns high-level financial & job KPIs for the dashboard UI.
// - Accepts either ?ownerId=... or ?token=... (users.dashboard_token).
// - Optional ?period= today | this_week | this_month | last_month | ytd
//   (for now this is mostly a label; company_kpis is all-time,
//    but we pass period through so the UI is future-proof).
//
// Uses:
//   - services/kpis.getCompanyKpis        (Oracle-style company KPIs)
//   - services/jobsKpis.getJobKpiSummary  (job-level KPIs)
//
// Shape:
//   {
//     ok: true,
//     ownerId,
//     period,
//     periodLabel,
//     tiles: [...],
//     kpis: [...],
//     jobs: [...],
//     jobAggregates: {...}
//   }
//
// ------------------------------------------------------------

const express = require('express');
const router = express.Router();

const { getCompanyKpis } = require('../services/kpis');
const { getJobKpiSummary } = require('../services/jobsKpis');
const { query } = require('../services/postgres');

/**
 * Resolve ownerId from query:
 * - If ?ownerId=... is provided, use that directly.
 * - Else if ?token=... is provided, look up users.dashboard_token.
 */
async function resolveOwnerId(req) {
  const { ownerId, token } = req.query;

  if (ownerId) {
    return String(ownerId).trim();
  }

  if (token) {
    const { rows } = await query(
      `SELECT owner_id
         FROM users
        WHERE dashboard_token = $1
        LIMIT 1`,
      [String(token).trim()]
    );
    if (!rows.length) {
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

/**
 * Normalise ?period to a key + friendly label for display.
 * (Metrics are still all-time for now; this is UI + future-proofing.)
 */
function normalizePeriod(raw) {
  const key = String(raw || 'this_month').toLowerCase();

  switch (key) {
    case 'today':
      return { key: 'today', label: 'Today' };
    case 'this_week':
      return { key: 'this_week', label: 'This Week' };
    case 'last_month':
      return { key: 'last_month', label: 'Last Month' };
    case 'ytd':
      return { key: 'ytd', label: 'Year-to-Date' };
    case 'this_month':
    default:
      return { key: 'this_month', label: 'This Month' };
  }
}

/**
 * Shape the response for the frontend:
 * - Pass through raw metrics (in cents) so UI can format.
 * - Build tiles array for contractor-friendly at-a-glance view.
 * - Include full KPI list + job metrics.
 */
function buildDashboardPayload(ownerId, periodInfo, companyKpis, jobSummary) {
  const { key: period, label: periodLabel } = periodInfo;
  const { definitions, metrics } = companyKpis || { definitions: {}, metrics: {} };
  const jobs = jobSummary?.jobs || [];
  const jobAgg = jobSummary?.aggregates || {};
  const holdbackBuckets = jobAgg.holdback_buckets_cents || {};

  // ----- Company metrics -----
  const revenue = metrics.invoiced_amount_period ?? null;
  const cashReceipts = metrics.cash_receipts_period ?? null;
  const grossProfit = metrics.gross_profit ?? null;
  const grossMarginPct = metrics.gross_margin_pct ?? null;
  const netProfit = metrics.net_profit ?? null;
  const ar = metrics.total_accounts_receivable ?? null;
  const ap = metrics.total_accounts_payable ?? null;
  const cashInBank = metrics.cash_in_bank ?? null;
  const workingCapital = metrics.working_capital ?? null;
  const workingCapitalRatio = metrics.working_capital_ratio ?? null;
  const debtorDays = metrics.average_debtor_days ?? null;

  // ----- Job-level aggregates for extra tiles -----
  const avgRevPerHourCents = jobAgg.avg_revenue_per_labour_hour_cents ?? null;
  const holdback90PlusCents = holdbackBuckets['90_plus'] ?? 0;

  // Jobs leaking more than $2,000 below estimate
  let jobsLeakingOver2k = 0;
  for (const j of jobs) {
    const leak = j.leak_amount_cents ?? (j.slippage_cents ?? 0);
    if (leak && leak > 200000) {
      jobsLeakingOver2k += 1;
    }
  }

  // Base tiles (company-level)
  const tiles = [
    {
      code: 'revenue',
      label: 'Invoiced (all time)',
      unit: 'currency',
      value_cents: revenue,
    },
    {
      code: 'net_profit',
      label: 'Net profit (all time)',
      unit: 'currency',
      value_cents: netProfit,
    },
    {
      code: 'gross_margin_pct',
      label: 'Gross margin',
      unit: 'percent',
      value: grossMarginPct,
    },
    {
      code: 'cash_in_bank',
      label: 'Cash in bank',
      unit: 'currency',
      value_cents: cashInBank,
    },
    {
      code: 'ar',
      label: 'Accounts receivable',
      unit: 'currency',
      value_cents: ar,
    },
    {
      code: 'ap',
      label: 'Accounts payable',
      unit: 'currency',
      value_cents: ap,
    },
    {
      code: 'working_capital',
      label: 'Working capital',
      unit: 'currency',
      value_cents: workingCapital,
    },
    {
      code: 'working_capital_ratio',
      label: 'Working capital ratio',
      unit: 'ratio',
      value: workingCapitalRatio,
    },
    {
      code: 'average_debtor_days',
      label: 'Debtor days',
      unit: 'days',
      value: debtorDays,
    },
  ];

  // Extra contractor-focused tiles derived from job KPIs

  // 1) Average revenue per crew hour
  if (avgRevPerHourCents != null) {
    tiles.push({
      code: 'avg_revenue_per_hour',
      label: 'Avg revenue per crew hour',
      unit: 'currency',
      value_cents: avgRevPerHourCents,
    });
  }

  // 2) Total holdback stuck over 90 days
  tiles.push({
    code: 'holdback_90_plus',
    label: 'Holdback stuck > 90 days',
    unit: 'currency',
    value_cents: holdback90PlusCents,
  });

  // 3) Count of jobs leaking > $2k
  tiles.push({
    code: 'jobs_leaking_over_2000',
    label: 'Jobs leaking > $2k',
    unit: 'count',
    value: jobsLeakingOver2k,
  });

  // Full Oracle-style KPI list
  const kpis = Object.keys(definitions).map((code) => {
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

// GET /api/dashboard
router.get('/dashboard', async (req, res) => {
  const started = Date.now();
  try {
    const ownerId = await resolveOwnerId(req);
    const periodInfo = normalizePeriod(req.query.period);

    // In future, periodInfo can be passed through to getCompanyKpis
    // to actually slice by date. For now it's just a label.
    const [companyKpis, jobSummary] = await Promise.all([
      getCompanyKpis({ ownerId }),
      getJobKpiSummary(ownerId, { limit: 200 }),
    ]);

    const payload = buildDashboardPayload(ownerId, periodInfo, companyKpis, jobSummary);
    res.json(payload);
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('[DASHBOARD] error:', {
      message: err.message,
      stack: err.stack,
    });
    res.status(status).json({
      ok: false,
      error: err.message || 'Dashboard error',
    });
  } finally {
    const ms = Date.now() - started;
    if (ms > 2000) {
      console.warn('[DASHBOARD] slow response', { ms });
    }
  }
});

module.exports = router;
