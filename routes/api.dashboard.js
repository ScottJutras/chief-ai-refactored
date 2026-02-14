// routes/api.dashboard.js
// GET /api/dashboard  (if you mount it at app.use('/api/dashboard', require(...)))
//
// Alignments:
// - Defensive query() import
// - Uses effective plan via getEffectivePlanFromOwner(ownerProfile)
// - Keeps plan + featureFlags + tasks + recentReceipts
// - Does NOT assume columns exist; failures return [] (fail-open)

const express = require('express');
const router = express.Router();

const { getCompanyKpis } = require('../services/kpis');
const { getJobKpiSummary } = require('../services/jobsKpis');
const { getEffectivePlanFromOwner } = require('../src/config/effectivePlan');

const pg = require('../services/postgres');
const query = pg.query || pg.pool?.query || pg.db?.query;

async function resolveOwnerId(req) {
  const { ownerId, token } = req.query;

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

    if (!rows.length) {
      const err = new Error('Invalid dashboard token');
      err.statusCode = 404;
      throw err;
    }

    return String(rows[0].owner_id || '').trim();
  }

  const err = new Error('ownerId or token is required');
  err.statusCode = 400;
  throw err;
}

function getPeriodLabel(period) {
  switch (period) {
    case 'today': return 'Today';
    case 'this_week': return 'This Week';
    case 'last_month': return 'Last Month';
    case 'ytd': return 'Year-to-Date';
    case 'this_month':
    default: return 'This Month';
  }
}

async function getDashboardTasks(ownerId) {
  if (!query) return [];
  try {
    const { rows } = await query(
      `SELECT id, title, status, assigned_to, created_at
         FROM tasks
        WHERE owner_id = $1
        ORDER BY created_at DESC
        LIMIT 20`,
      [ownerId]
    );
    return rows || [];
  } catch (err) {
    console.warn('[API.DASHBOARD] tasks query failed:', err.message);
    return [];
  }
}

async function getRecentReceipts(ownerId) {
  if (!query) return [];
  try {
    const { rows } = await query(
      `SELECT id, date, description, amount_cents, category, job_name, job_id, media_url
         FROM transactions
        WHERE owner_id = $1
          AND media_url IS NOT NULL
        ORDER BY date DESC
        LIMIT 20`,
      [ownerId]
    );
    return rows || [];
  } catch (err) {
    console.warn('[API.DASHBOARD] receipts query failed:', err.message);
    return [];
  }
}

function buildDashboardPayload(ownerId, period, plan, { definitions, metrics }, jobs) {
  const periodLabel = getPeriodLabel(period);

  const revenue = metrics.invoiced_amount_period ?? null;
  const grossMarginPct = metrics.gross_margin_pct ?? null;
  const netProfit = metrics.net_profit ?? null;
  const cashInBank = metrics.cash_in_bank ?? null;
  const ar = metrics.total_accounts_receivable ?? null;
  const ap = metrics.total_accounts_payable ?? null;
  const workingCapital = metrics.working_capital ?? null;
  const workingCapitalRatio = metrics.working_capital_ratio ?? null;
  const debtorDays = metrics.average_debtor_days ?? null;

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
    plan,
    featureFlags,
    tiles: [
      { code: 'revenue', label: 'Invoiced', unit: 'currency', value_cents: revenue },
      { code: 'net_profit', label: 'Net profit', unit: 'currency', value_cents: netProfit },
      { code: 'gross_margin_pct', label: 'Gross margin', unit: 'percent', value: grossMarginPct },
      { code: 'cash_in_bank', label: 'Cash in bank', unit: 'currency', value_cents: cashInBank },
      { code: 'ar', label: 'Accounts receivable (AR)', unit: 'currency', value_cents: ar },
      { code: 'ap', label: 'Accounts payable (AP)', unit: 'currency', value_cents: ap },
      { code: 'working_capital', label: 'Working capital', unit: 'currency', value_cents: workingCapital },
      { code: 'working_capital_ratio', label: 'Working capital ratio', unit: 'ratio', value: workingCapitalRatio },
      { code: 'average_debtor_days', label: 'Debtor days', unit: 'days', value: debtorDays },
    ],
    kpis: Object.keys(definitions || {}).map((code) => {
      const def = definitions[code];
      return {
        code,
        label: def.label,
        category: def.category,
        unit: def.unit,
        value: metrics[code] ?? null,
      };
    }),
    jobs: jobs || [],
  };
}

// GET /api/dashboard  (if mounted at '/api/dashboard', this should be '/')
router.get('/', async (req, res) => {
  const started = Date.now();
  try {
    const ownerId = await resolveOwnerId(req);
    const period = (req.query.period || 'this_month').toString().toLowerCase();

    // ✅ Effective plan
    let ownerProfile = null;
    try {
      if (typeof pg.getOwnerProfile === 'function') {
        ownerProfile = await pg.getOwnerProfile(String(ownerId).trim());
      }
    } catch (e) {
      console.warn('[API.DASHBOARD] getOwnerProfile failed (fail-open):', e?.message);
    }

    const tier = String(getEffectivePlanFromOwner(ownerProfile) || 'free').toLowerCase().trim() || 'free';
    const plan = { tier, isPro: tier === 'pro' };

    const [kpis, jobs, tasks, recentReceipts] = await Promise.all([
      getCompanyKpis({ ownerId }),
      getJobKpiSummary(ownerId),
      getDashboardTasks(ownerId),
      getRecentReceipts(ownerId),
    ]);

    const payload = buildDashboardPayload(ownerId, period, plan, kpis, jobs);
    payload.tasks = tasks;
    payload.recentReceipts = recentReceipts;
    payload.leads = payload.leads || [];

    res.json(payload);
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('[API.DASHBOARD] error:', { message: err.message, stack: err.stack });
    res.status(status).json({ ok: false, error: err.message || 'Dashboard error' });
  } finally {
    const ms = Date.now() - started;
    if (ms > 2000) console.warn('[API.DASHBOARD] slow response', { ms });
  }
});

module.exports = router;
