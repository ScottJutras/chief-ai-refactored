// services/kpis.js
// Company-level KPI engine built on:
// - transactions table (period-based revenue/costs)
// - company_balance_kpis view (current balances)
// - kpi_definitions-style metadata
//
// Schema assumptions (based on your DB):
// - transactions:
//     owner_id (text)
//     kind ∈ ('revenue','expense')
//     category (text) e.g. 'ar','cash','cogs','overhead','current_asset','current_liability','ap','inventory'
//     amount_cents (bigint)
//     date (date)
// - company_balance_kpis view:
//     owner_id
//     cash_in_bank_cents
//     ar_cents
//     ap_cents
//     current_assets_cents
//     current_liabilities_cents
//     inventory_cents

const { query } = require('./postgres');
const { getPeriodBounds } = require('./sql/periods');

// Canonical KPI definitions (aligned with kpi_definitions table)
const KPI_DEFINITIONS = {
  // Income & Cashflow
  invoiced_amount_period: {
    label: 'Invoiced amount in period',
    category: 'Income & Cashflow',
    level: 'company',
    unit: 'currency',
  },
  cash_receipts_period: {
    label: 'Cash receipts in period',
    category: 'Income & Cashflow',
    level: 'company',
    unit: 'currency',
  },
  avg_days_to_issue_invoice: {
    label: 'Average days to issue invoice',
    category: 'Income & Cashflow',
    level: 'company',
    unit: 'days',
  },

  // Costs & Profitability
  total_costs: {
    label: 'Total costs',
    category: 'Costs & Profitability',
    level: 'company',
    unit: 'currency',
  },
  total_cogs: {
    label: 'Total cost of goods sold',
    category: 'Costs & Profitability',
    level: 'company',
    unit: 'currency',
  },
  total_controllable_costs: {
    label: 'Total controllable costs',
    category: 'Costs & Profitability',
    level: 'company',
    unit: 'currency',
  },
  total_noncontrollable_costs: {
    label: 'Total non-controllable costs',
    category: 'Costs & Profitability',
    level: 'company',
    unit: 'currency',
  },
  gross_profit: {
    label: 'Gross profit',
    category: 'Costs & Profitability',
    level: 'company',
    unit: 'currency',
  },
  gross_margin_pct: {
    label: 'Gross margin %',
    category: 'Costs & Profitability',
    level: 'company',
    unit: 'percent',
  },
  gross_profit_per_job: {
    label: 'Gross profit per job',
    category: 'Costs & Profitability',
    level: 'company',
    unit: 'currency',
  },
  net_profit: {
    label: 'Net profit',
    category: 'Costs & Profitability',
    level: 'company',
    unit: 'currency',
  },

  // Cash & Assets
  cash_forecast_30d: {
    label: 'Cash forecast (30 days)',
    category: 'Cash & Assets',
    level: 'company',
    unit: 'currency',
  },
  cash_in_bank: {
    label: 'Cash in bank',
    category: 'Cash & Assets',
    level: 'company',
    unit: 'currency',
  },
  total_assets: {
    label: 'Total assets',
    category: 'Cash & Assets',
    level: 'company',
    unit: 'currency',
  },

  // Working Capital & Inventory
  working_capital_ratio: {
    label: 'Working capital ratio',
    category: 'Working Capital',
    level: 'company',
    unit: 'ratio',
  },
  working_capital: {
    label: 'Working capital',
    category: 'Working Capital',
    level: 'company',
    unit: 'currency',
  },
  cost_of_inventory: {
    label: 'Cost of inventory',
    category: 'Working Capital',
    level: 'company',
    unit: 'currency',
  },
  inventory_turnover_ratio: {
    label: 'Inventory turnover ratio',
    category: 'Working Capital',
    level: 'company',
    unit: 'ratio',
  },

  // Debtors & Creditors
  total_accounts_receivable: {
    label: 'Total accounts receivable',
    category: 'Debtors & Creditors',
    level: 'company',
    unit: 'currency',
  },
  average_debtor_days: {
    label: 'Average debtor days',
    category: 'Debtors & Creditors',
    level: 'company',
    unit: 'days',
  },
  total_liabilities: {
    label: 'Total liabilities',
    category: 'Debtors & Creditors',
    level: 'company',
    unit: 'currency',
  },
  total_accounts_payable: {
    label: 'Total accounts payable',
    category: 'Debtors & Creditors',
    level: 'company',
    unit: 'currency',
  },
  tax_owed: {
    label: 'Tax owed',
    category: 'Debtors & Creditors',
    level: 'company',
    unit: 'currency',
  },
};

function normaliseOwnerId(ownerId) {
  if (!ownerId) return null;
  // Your owner ids are numeric strings (phone-like), so stripping non-digits is safe.
  return String(ownerId).replace(/\D/g, '');
}

/**
 * Get company-level KPIs for an owner and period.
 * period: 'today' | 'this_week' | 'this_month' | 'last_month' | 'ytd'
 */
async function getCompanyKpis({ ownerId, period }) {
  const owner = normaliseOwnerId(ownerId);
  if (!owner) {
    throw new Error('getCompanyKpis: ownerId is required');
  }

  const { start, end } = getPeriodBounds(period);

  // 1) Period-based revenue / costs from transactions
  const { rows: periodRows } = await query(
    `
    WITH base AS (
      SELECT owner_id, kind, category, amount_cents, date
      FROM transactions
      WHERE owner_id = $1
        AND date >= $2::date
        AND date <  $3::date
    ),
    revenue AS (
      SELECT SUM(amount_cents) AS revenue_cents
      FROM base
      WHERE kind = 'revenue' AND category = 'ar'
    ),
    cash_receipts AS (
      SELECT SUM(amount_cents) AS cash_cents
      FROM base
      WHERE kind = 'revenue' AND category = 'cash'
    ),
    cogs AS (
      SELECT SUM(amount_cents) AS cogs_cents
      FROM base
      WHERE kind = 'expense' AND category = 'cogs'
    ),
    overheads AS (
      SELECT SUM(amount_cents) AS overhead_cents
      FROM base
      WHERE kind = 'expense' AND category = 'overhead'
    ),
    daily_sales AS (
      SELECT date, SUM(amount_cents) AS daily_total_cents
      FROM base
      WHERE kind = 'revenue' AND category = 'ar'
      GROUP BY date
    )
    SELECT
      COALESCE((SELECT revenue_cents FROM revenue), 0)        AS revenue_cents,
      COALESCE((SELECT cash_cents FROM cash_receipts), 0)     AS cash_receipts_cents,
      COALESCE((SELECT cogs_cents FROM cogs), 0)              AS cogs_cents,
      COALESCE((SELECT overhead_cents FROM overheads), 0)     AS overhead_cents,
      COALESCE((SELECT AVG(daily_total_cents) FROM daily_sales), 0) AS avg_daily_invoice_cents
    `,
    [owner, start, end]
  );

  const periodRow = periodRows[0] || {};

  // 2) Balance-style metrics (current position) from company_balance_kpis
  const { rows: balanceRows } = await query(
    `SELECT *
       FROM company_balance_kpis
      WHERE owner_id = $1
      LIMIT 1`,
    [owner]
  );
  const balanceRow = balanceRows[0] || {};

  const metrics = {};

  // ---------- Income & Cashflow (period) ----------
  const revenue = Number(periodRow.revenue_cents || 0);
  const cashReceipts = Number(periodRow.cash_receipts_cents || 0);
  const cogs = Number(periodRow.cogs_cents || 0);
  const overhead = Number(periodRow.overhead_cents || 0);

  const grossProfit = revenue - cogs;
  const netProfit = revenue - cogs - overhead;

  metrics.invoiced_amount_period = revenue;
  metrics.cash_receipts_period = cashReceipts;
  metrics.total_cogs = cogs;
  metrics.gross_profit = grossProfit;
  metrics.net_profit = netProfit;
  metrics.gross_margin_pct =
    revenue > 0 ? (grossProfit * 100.0) / revenue : null;

  metrics.total_costs = cogs + overhead;

  // ---------- Balances / working capital (current) ----------
  const cashInBank = Number(balanceRow.cash_in_bank_cents || 0);
  const arCents = Number(balanceRow.ar_cents || 0);
  const apCents = Number(balanceRow.ap_cents || 0);
  const currentAssets = Number(balanceRow.current_assets_cents || 0);
  const currentLiabilities = Number(balanceRow.current_liabilities_cents || 0);
  const inventoryCents = Number(balanceRow.inventory_cents || 0);

  metrics.cash_in_bank = cashInBank;
  metrics.total_accounts_receivable = arCents;
  metrics.total_accounts_payable = apCents;
  metrics.cost_of_inventory = inventoryCents;

  metrics.working_capital = currentAssets - currentLiabilities;
  metrics.working_capital_ratio =
    currentLiabilities > 0 ? currentAssets / currentLiabilities : null;

  metrics.total_assets = currentAssets + inventoryCents;
  metrics.total_liabilities = currentLiabilities + apCents;

  // ---------- Debtor days ----------
  const avgDailySales = Number(periodRow.avg_daily_invoice_cents || 0);
  if (arCents > 0 && avgDailySales > 0) {
    metrics.average_debtor_days = Math.round(arCents / avgDailySales);
  } else {
    metrics.average_debtor_days = null;
  }

  // Not yet computed (future enhancement):
  // - total_controllable_costs
  // - total_noncontrollable_costs
  // - gross_profit_per_job
  // - cash_forecast_30d
  // - inventory_turnover_ratio
  // - tax_owed
  // - avg_days_to_issue_invoice

  return {
    definitions: KPI_DEFINITIONS,
    metrics,
    ownerId: owner,
    period: period || 'this_month',
  };
}

module.exports = {
  KPI_DEFINITIONS,
  getCompanyKpis,
};
