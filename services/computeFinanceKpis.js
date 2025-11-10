// services/computeFinanceKpis.js
// ------------------------------------------------------------
// Defensive KPI calculator — tries multiple candidate tables/views.
// All amounts are in cents (bigint). Missing sources => nulls (UI shows "—").
// ------------------------------------------------------------
function toInt(x){ const n = Number(x); return Number.isFinite(n) ? Math.trunc(n) : null; }

async function safeOne(queryFn, sql, params){
  try { const r = await queryFn(sql, params); return r?.rows?.[0] ?? null; }
  catch { return null; }
}
async function safeSum(queryFn, sql, params){
  const row = await safeOne(queryFn, sql, params);
  const v = row ? (row.sum ?? row.total ?? row.cents ?? row.amount_cents ?? row.remaining_cents) : null;
  return toInt(v);
}

// Tries a list of relations until one works (no errors) and returns SUM(...) from it.
async function trySumFromAny(queryFn, relNames, sumCol, whereSql, params){
  for (const rel of relNames){
    const row = await safeOne(queryFn, `SELECT SUM(${sumCol}) AS sum FROM ${rel} ${whereSql}`, params);
    if (row !== null) return toInt(row.sum);
  }
  return null;
}

async function computeFinanceKpis(ownerId, jobNo, isoDay, { query }){
  const owner = String(ownerId).replace(/\D/g,'');
  const day   = String(isoDay).slice(0,10); // YYYY-MM-DD

  // Candidate sources your stack may have (tables or views)
  const REVENUE  = ['public.revenues', 'public.cash_in', 'public.receipts', 'public.revenue_entries'];
  const EXPENSES = ['public.expenses', 'public.cash_out', 'public.expense_entries'];
  const INVOICES = ['public.invoices', 'public.invoice_entries'];
  const BILLS    = ['public.bills', 'public.bill_entries', 'public.payables'];
  const CHGORD   = ['public.change_orders', 'public.change_order_entries'];
  const ESTIMATES= ['public.estimates', 'public.quote_entries'];

  // Revenue (occurred_on day)
  const revenue = await trySumFromAny(
    query, REVENUE, 'amount_cents', `WHERE owner_id=$1 AND job_no=$2 AND occurred_at::date=$3`,
    [owner, jobNo, day]
  );

  // COGS (occurred_on day; use "kind" if present)
  const cogsWhere =
    `WHERE owner_id=$1 AND job_no=$2 AND occurred_at::date=$3
       AND (kind IS NULL OR kind IN ('materials','cogs','subcontract','labour'))`;
  const cogs = await trySumFromAny(query, EXPENSES, 'amount_cents', cogsWhere, [owner, jobNo, day]);

  // Approved change orders (use approved_at else created_at)
  const changeOrders = await trySumFromAny(
    query, CHGORD, 'delta_cents',
    `WHERE owner_id=$1 AND job_no=$2 AND status='approved'
       AND COALESCE(approved_at, created_at)::date=$3`,
    [owner, jobNo, day]
  );

  // Unreleased holdbacks (retainage still held as of "day")
  // Prefer invoices with retainage columns; fallback to retainage_ledger if you add it later.
  const holdbacks = await (async () => {
    const v1 = await safeSum(query,
      `SELECT SUM(retainage_amount_cents) AS sum
         FROM ${INVOICES[0]}
        WHERE owner_id=$1 AND job_no=$2
          AND COALESCE(issue_date, created_at)::date <= $3
          AND (released_at IS NULL OR released_at::date > $3)`,
      [owner, jobNo, day]
    ).catch(()=>null);
    if (v1 != null) return v1;
    return null; // optional: add retainage_ledger candidate later
  })();

  // Open A/R and A/P (status-based)
  const ar = await trySumFromAny(
    query, INVOICES, 'remaining_cents',
    `WHERE owner_id=$1 AND job_no=$2 AND status IN ('sent','partial','overdue')`,
    [owner, jobNo]
  );
  const ap = await trySumFromAny(
    query, BILLS, 'remaining_cents',
    `WHERE owner_id=$1 AND job_no=$2 AND status IN ('entered','partial','overdue')`,
    [owner, jobNo]
  );

  // Estimates (valid on day)
  const estRev = await trySumFromAny(
    query, ESTIMATES, 'amount_cents',
    `WHERE owner_id=$1 AND job_no=$2 AND (valid_until IS NULL OR valid_until::date >= $3)`,
    [owner, jobNo, day]
  );
  const estCogs = await trySumFromAny(
    query, ESTIMATES, 'cost_cents',
    `WHERE owner_id=$1 AND job_no=$2 AND (valid_until IS NULL OR valid_until::date >= $3)`,
    [owner, jobNo, day]
  );

  // Derived
  const gp    = (revenue != null && cogs != null) ? (revenue - cogs) : null;
  const gmPct = (revenue && revenue !== 0 && gp != null)
    ? Math.round((gp / revenue) * 10000) / 100
    : null;
  const slippage = (estRev != null && estCogs != null && gp != null)
    ? ((estRev - estCogs) - gp)
    : null;

  return {
    revenue_cents: revenue ?? null,
    cogs_cents: cogs ?? null,
    gross_profit_cents: gp,
    gross_margin_pct: gmPct,
    change_order_cents: changeOrders ?? null,
    holdback_cents: holdbacks ?? null,
    ar_total_cents: ar ?? null,
    ap_total_cents: ap ?? null,
    estimate_revenue_cents: estRev ?? null,
    estimate_cogs_cents: estCogs ?? null,
    slippage_cents: slippage ?? null,
  };
}

module.exports = { computeFinanceKpis };
