'use strict';

/**
 * Agent Tool: get_supplier_spend
 * Returns total spend at a specific supplier/vendor, with monthly trend.
 *
 * Works in two modes:
 *   1. Source-text match (always) — searches transactions.source ILIKE '%name%'
 *      Handles any vendor the owner has ever logged (Home Depot, Rona, etc.)
 *   2. supplier_id FK match (when supplier is registered in ChiefOS supplier catalog)
 *      Adds catalog price history if available.
 *
 * Use when asked: "How much have I spent at Home Depot this year?",
 * "What did we spend at [supplier] last quarter?", "Are our material costs going up?"
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function fmt(cents) {
  return `$${(Math.abs(cents) / 100).toFixed(0)}`;
}

async function getSupplierSpend({ ownerId, supplierName, dateFrom, dateTo }) {
  if (!ownerId) return { error: 'owner_id is required' };
  if (!supplierName) return { error: 'supplier_name is required' };

  const nameParam = String(supplierName).trim();

  // ── 1. Try to find a registered supplier by name ─────────────────────────
  const supplierResult = await pool.query(
    `SELECT id, name, slug
       FROM public.suppliers
      WHERE is_active = true
        AND (
          LOWER(name) ILIKE $1
          OR LOWER(name) ILIKE $2
        )
      ORDER BY LENGTH(name) DESC
      LIMIT 1`,
    [`%${nameParam.toLowerCase()}%`, `${nameParam.toLowerCase()}%`]
  ).catch(() => null);

  const registeredSupplier = supplierResult?.rows?.[0] || null;

  // ── 2. Build date range filter ────────────────────────────────────────────
  const dateFilters = [];
  const params = [String(ownerId)];

  if (dateFrom) {
    params.push(dateFrom);
    dateFilters.push(`AND t.date >= $${params.length}`);
  }
  if (dateTo) {
    params.push(dateTo);
    dateFilters.push(`AND t.date <= $${params.length}`);
  }

  const dateClause = dateFilters.join(' ');

  // ── 3. Source-text match query ────────────────────────────────────────────
  params.push(`%${nameParam.toLowerCase()}%`);
  const likeIdx = params.length;

  // If we have a registered supplier_id, also match on that
  let supplierIdClause = '';
  if (registeredSupplier) {
    params.push(registeredSupplier.id);
    const sidIdx = params.length;
    supplierIdClause = `OR t.supplier_id = $${sidIdx}`;
  }

  const txQuery = `
    SELECT
      t.id,
      t.date,
      t.amount_cents,
      t.source,
      t.description,
      t.category,
      t.job_id,
      t.job_name
    FROM public.transactions t
    WHERE t.owner_id = $1
      AND t.kind = 'expense'
      AND (
        LOWER(COALESCE(t.source, '')) ILIKE $${likeIdx}
        ${supplierIdClause}
      )
      ${dateClause}
    ORDER BY t.date DESC
  `;

  const txResult = await pool.query(txQuery, params).catch(() => null);
  const rows = txResult?.rows || [];

  if (!rows.length) {
    const rangeNote = dateFrom || dateTo
      ? ` between ${dateFrom || 'the beginning'} and ${dateTo || 'today'}`
      : '';
    return {
      found: false,
      supplier_name: nameParam,
      message: `No expenses found at "${nameParam}"${rangeNote}. Make sure expenses are logged with the vendor name in the source field.`,
    };
  }

  // ── 4. Aggregate totals ───────────────────────────────────────────────────
  const totalCents = rows.reduce((s, r) => s + Number(r.amount_cents || 0), 0);
  const avgCents = Math.round(totalCents / rows.length);

  // Largest single expense
  const largest = rows.reduce((best, r) =>
    Number(r.amount_cents) > Number(best.amount_cents) ? r : best, rows[0]);

  // ── 5. Monthly breakdown ──────────────────────────────────────────────────
  const monthMap = {};
  for (const r of rows) {
    const month = String(r.date || '').slice(0, 7); // YYYY-MM
    if (!month) continue;
    if (!monthMap[month]) monthMap[month] = { month, total_cents: 0, count: 0 };
    monthMap[month].total_cents += Number(r.amount_cents || 0);
    monthMap[month].count += 1;
  }
  const byMonth = Object.values(monthMap)
    .sort((a, b) => a.month.localeCompare(b.month))
    .map(m => ({
      month: m.month,
      total: fmt(m.total_cents),
      total_cents: m.total_cents,
      transactions: m.count,
    }));

  // Trend: is spending going up? Compare last 3 months to prior 3 months
  let trendNote = null;
  if (byMonth.length >= 4) {
    const recent = byMonth.slice(-3).reduce((s, m) => s + m.total_cents, 0);
    const prior = byMonth.slice(-6, -3).reduce((s, m) => s + m.total_cents, 0);
    if (prior > 0) {
      const changePct = Math.round(((recent - prior) / prior) * 100);
      if (changePct > 10) {
        trendNote = `Spending at ${nameParam} is up ${changePct}% compared to the prior 3 months.`;
      } else if (changePct < -10) {
        trendNote = `Spending at ${nameParam} is down ${Math.abs(changePct)}% compared to the prior 3 months.`;
      } else {
        trendNote = `Spending at ${nameParam} has been relatively steady over the past 6 months.`;
      }
    }
  }

  // ── 6. Catalog price history (if registered supplier has products) ────────
  let catalogNote = null;
  if (registeredSupplier) {
    const phResult = await pool.query(
      `SELECT ph.effective_date, ph.old_price_cents, ph.new_price_cents,
              cp.name AS product_name, cp.sku
         FROM public.catalog_price_history ph
         JOIN public.catalog_products cp ON cp.id = ph.product_id
        WHERE ph.supplier_id = $1
        ORDER BY ph.effective_date DESC
        LIMIT 5`,
      [registeredSupplier.id]
    ).catch(() => null);

    const priceChanges = phResult?.rows || [];
    if (priceChanges.length) {
      const increases = priceChanges.filter(r =>
        Number(r.new_price_cents) > Number(r.old_price_cents)
      ).length;
      catalogNote = increases > 0
        ? `${increases} price increase(s) detected in ${registeredSupplier.name}'s catalog recently.`
        : `No recent price increases in ${registeredSupplier.name}'s catalog.`;
    }
  }

  return {
    found: true,
    supplier_name: registeredSupplier?.name || nameParam,
    is_registered_supplier: !!registeredSupplier,
    total_cents: totalCents,
    total: fmt(totalCents),
    transaction_count: rows.length,
    avg_transaction: fmt(avgCents),
    largest_transaction: {
      amount: fmt(Number(largest.amount_cents)),
      date: largest.date,
      description: largest.description || largest.source,
    },
    by_month: byMonth,
    trend_note: trendNote,
    catalog_price_note: catalogNote,
    date_range: {
      from: dateFrom || rows[rows.length - 1]?.date || null,
      to: dateTo || rows[0]?.date || null,
    },
  };
}

const supplierSpendTool = {
  type: 'function',
  function: {
    name: 'get_supplier_spend',
    description: [
      'Returns total spend at a specific vendor or supplier, with monthly trend.',
      'Use when asked "How much have I spent at Home Depot this year?",',
      '"What did we spend at [vendor] last quarter?",',
      '"Are our material costs going up?",',
      '"Which supplier are we spending the most with?".',
      'Searches by vendor name in expense source field — works for any vendor,',
      'not just registered suppliers. Includes month-by-month trend and spend direction.',
    ].join(' '),
    parameters: {
      type: 'object',
      required: ['owner_id', 'supplier_name'],
      properties: {
        owner_id:      { type: 'string' },
        supplier_name: { type: 'string', description: 'Vendor or supplier name (e.g. "Home Depot", "Gentek", "Rona")' },
        date_from:     { type: 'string', description: 'YYYY-MM-DD start date (optional)' },
        date_to:       { type: 'string', description: 'YYYY-MM-DD end date (optional)' },
      },
    },
  },
  __handler: async (args) => {
    try {
      return await getSupplierSpend({
        ownerId:      String(args.owner_id || '').trim(),
        supplierName: String(args.supplier_name || '').trim(),
        dateFrom:     args.date_from ? String(args.date_from).trim() : null,
        dateTo:       args.date_to   ? String(args.date_to).trim()   : null,
      });
    } catch (err) {
      return { error: `get_supplier_spend failed: ${err?.message}` };
    }
  },
};

module.exports = { supplierSpendTool, getSupplierSpend };
