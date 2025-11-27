// routes/api.dashboard.js
// GET /api/dashboard
//
// Returns high-level financial + job KPIs for the dashboard UI.
// - Accepts either ?ownerId=... or ?token=... (dashboard_token from users).
// - Uses services/kpis.getCompanyKpis (Oracle-style KPI engine).
// - Uses services/jobsKpis.getJobKpiSummary for job-level KPIs.
// - Adds plan + featureFlags for free vs Pro gating.

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
 * Figure out the owner's plan based on users table.
 * We treat trial/pro/paid as "Pro" for feature gating.
 */
async function getOwnerPlan(ownerId) {
  const { rows } = await query(
    `SELECT subscription_tier, paid_tier
       FROM users
      WHERE owner_id = $1
      ORDER BY created_at ASC
      LIMIT 1`,
    [ownerId]
  );

  const row = rows[0] || {};
  const rawTier = (row.paid_tier || row.subscription_tier || 'free').toString();
  const tier = rawTier.toLowerCase();

  const isPro =
    tier === 'pro' ||
    tier === 'trial' ||
    tier === 'paid' ||
    tier === 'plus';

  return {
    tier,
    isPro,
  };
}

/**
 * Map a period key to a human-friendly label.
 * (For now this is UI-only; we’re not slicing data by date yet.)
 */
function getPeriodLabel(period) {
  switch (period) {
    case 'today':
      return 'Today';
    case 'this_week':
      return 'This Week';
    case 'last_month':
      return 'Last Month';
    case 'ytd':
      return 'Year-to-Date';
    case 'this_month':
    default:
      return 'This Month';
  }
}

async function getDashboardTasks(ownerId) {
  try {
    const { rows } = await query(
      `SELECT
         id,
         title,
         status,
         assigned_to,
         created_at
       FROM tasks
       WHERE owner_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [ownerId]
    );
    return rows;
  } catch (err) {
    console.warn('[DASHBOARD] tasks query failed:', err.message);
    // If schema doesn’t match yet, just return empty so dashboard still works
    return [];
  }
}

async function getRecentReceipts(ownerId) {
  try {
    const { rows } = await query(
      `SELECT
         id,
         date,
         description,
         amount_cents,
         category,
         job_name,
         job_id,
         media_url
       FROM transactions
       WHERE owner_id = $1
         AND media_url IS NOT NULL
       ORDER BY date DESC
       LIMIT 20`,
      [ownerId]
    );
    return rows;
  } catch (err) {
    console.warn('[DASHBOARD] receipts query failed:', err.message);
    return [];
  }
}


/**
 * Shape the response for the frontend:
 * - Pass through raw metrics (in cents) so UI can format.
 * - Include tiles ordered for contractors.
 * - Include full KPI set.
 * - Include job summary from job_kpis_summary.
 * - Include plan + featureFlags for free vs Pro gating.
 */
function buildDashboardPayload(ownerId, period, plan, { definitions, metrics }, jobs) {
  const periodLabel = getPeriodLabel(period);

  // Safely read common metrics (default to null if missing)
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

  // Feature flags for gating in the UI
  const featureFlags = {
    periodFilter: !!plan.isPro,
    advancedKpis: !!plan.isPro,
    forecast: !!plan.isPro,
    jobLeakSection: !!plan.isPro,
  };

  return {
    ok: true,
    ownerId,
    period,
    periodLabel,
    plan,          // { tier, isPro }
    featureFlags,  // free vs Pro switches the UI can read
    tiles: [
      {
        code: 'revenue',
        label: 'Invoiced',
        unit: 'currency',
        value_cents: revenue,
      },
      {
        code: 'net_profit',
        label: 'Net profit',
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
        label: 'Accounts receivable (AR)',
        unit: 'currency',
        value_cents: ar,
      },
      {
        code: 'ap',
        label: 'Accounts payable (AP)',
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
    ],
    // Full Oracle-style KPI set (for charts / extended UI)
    kpis: Object.keys(definitions).map((code) => {
      const def = definitions[code];
      return {
        code,
        label: def.label,
        category: def.category,
        unit: def.unit,
        value: metrics[code] ?? null,
      };
    }),
    // Job-level KPIs from job_kpis_summary
    jobs: jobs || [],
  };
}

// GET /api/dashboard
router.get('/', async (req, res) => {
  const started = Date.now();
  try {
    const ownerId = await resolveOwnerId(req);
    const period = (req.query.period || 'this_month').toString();

    const plan = await getOwnerPlan(ownerId);

        const [kpis, jobs, tasks, recentReceipts] = await Promise.all([
      getCompanyKpis({ ownerId }),
      getJobKpiSummary(ownerId),
      getDashboardTasks(ownerId),
      getRecentReceipts(ownerId),
    ]);

    const payload = buildDashboardPayload(ownerId, period, plan, kpis, jobs);

    // Attach extra collections for the UI
    payload.tasks = tasks;
    payload.recentReceipts = recentReceipts;
    // leads can be added later once you have a leads table
    payload.leads = payload.leads || [];

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
