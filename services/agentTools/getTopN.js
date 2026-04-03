'use strict';

/**
 * Agent Tool: get_top_n
 * Phase 2.3 — Ranked queries: top jobs by profit, top vendors by spend, etc.
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function toInt(x) { const n = Number(x); return Number.isFinite(n) ? Math.trunc(n) : 0; }

const VALID_ENTITIES = ['jobs', 'vendors', 'categories', 'employees'];

async function getTopN({ ownerId, entity, metric, n, dateFrom, dateTo, sortDir }) {
  if (!ownerId) return { error: 'owner_id is required' };

  const owner  = String(ownerId);
  const limit  = Math.min(Math.max(Number(n) || 5, 1), 20);
  const dir    = sortDir === 'asc' ? 'ASC' : 'DESC';

  const params = [owner];
  let p = 2;
  const dateFilters = [];
  if (dateFrom) { dateFilters.push(`t.date >= $${p++}::date`); params.push(dateFrom); }
  if (dateTo)   { dateFilters.push(`t.date <= $${p++}::date`); params.push(dateTo); }
  const dateWhere = dateFilters.length ? ' AND ' + dateFilters.join(' AND ') : '';

  // ── Top jobs ──────────────────────────────────────────────────────────────
  if (entity === 'jobs') {
    const rows = await pool.query(`
      SELECT
        j.id,
        j.job_no,
        j.name,
        j.status,
        SUM(CASE WHEN t.kind = 'revenue' THEN t.amount_cents ELSE 0 END) AS revenue,
        SUM(CASE WHEN t.kind = 'expense' THEN t.amount_cents ELSE 0 END) AS expenses
      FROM public.jobs j
      LEFT JOIN public.transactions t
        ON t.job_id = j.id
        AND t.owner_id::text = $1
        ${dateWhere}
      WHERE j.owner_id::text = $1
      GROUP BY j.id, j.job_no, j.name, j.status
      HAVING SUM(t.amount_cents) > 0
      ORDER BY
        CASE WHEN '${metric}' = 'profit'   THEN SUM(CASE WHEN t.kind = 'revenue' THEN t.amount_cents ELSE 0 END) - SUM(CASE WHEN t.kind = 'expense' THEN t.amount_cents ELSE 0 END)
             WHEN '${metric}' = 'revenue'  THEN SUM(CASE WHEN t.kind = 'revenue' THEN t.amount_cents ELSE 0 END)
             WHEN '${metric}' = 'expenses' THEN SUM(CASE WHEN t.kind = 'expense' THEN t.amount_cents ELSE 0 END)
             ELSE SUM(CASE WHEN t.kind = 'revenue' THEN t.amount_cents ELSE 0 END) - SUM(CASE WHEN t.kind = 'expense' THEN t.amount_cents ELSE 0 END)
        END ${dir}
      LIMIT ${limit}
    `, params).catch(() => null);

    return {
      entity, metric, n: limit, date_from: dateFrom, date_to: dateTo,
      results: (rows?.rows || []).map((r, i) => {
        const rev = toInt(r.revenue);
        const exp = toInt(r.expenses);
        const prf = rev - exp;
        return {
          rank:       i + 1,
          job_no:     r.job_no,
          name:       r.name,
          status:     r.status,
          revenue:    rev,
          expenses:   exp,
          profit:     prf,
          margin_pct: rev > 0 ? Math.round((prf / rev) * 100) : null,
        };
      }),
    };
  }

  // ── Top vendors ───────────────────────────────────────────────────────────
  if (entity === 'vendors') {
    const rows = await pool.query(`
      SELECT
        source          AS vendor,
        COUNT(*)        AS tx_count,
        SUM(amount_cents) AS total_cents
      FROM public.transactions t
      WHERE t.owner_id::text = $1
        AND t.kind = 'expense'
        AND t.source IS NOT NULL
        ${dateWhere}
      GROUP BY source
      ORDER BY total_cents ${dir}
      LIMIT ${limit}
    `, params).catch(() => null);

    return {
      entity, metric: 'expenses', n: limit, date_from: dateFrom, date_to: dateTo,
      results: (rows?.rows || []).map((r, i) => ({
        rank:       i + 1,
        vendor:     r.vendor,
        tx_count:   toInt(r.tx_count),
        total_cents: toInt(r.total_cents),
      })),
    };
  }

  // ── Top expense categories ────────────────────────────────────────────────
  if (entity === 'categories') {
    const rows = await pool.query(`
      SELECT
        COALESCE(category, 'Uncategorised') AS category,
        COUNT(*)                            AS tx_count,
        SUM(amount_cents)                   AS total_cents
      FROM public.transactions t
      WHERE t.owner_id::text = $1
        AND t.kind = 'expense'
        ${dateWhere}
      GROUP BY category
      ORDER BY total_cents ${dir}
      LIMIT ${limit}
    `, params).catch(() => null);

    return {
      entity, metric: 'expenses', n: limit, date_from: dateFrom, date_to: dateTo,
      results: (rows?.rows || []).map((r, i) => ({
        rank:       i + 1,
        category:   r.category,
        tx_count:   toInt(r.tx_count),
        total_cents: toInt(r.total_cents),
      })),
    };
  }

  // ── Top employees by hours ────────────────────────────────────────────────
  if (entity === 'employees') {
    const empParams = [owner];
    let ep = 2;
    const empFilters = [];
    if (dateFrom) { empFilters.push(`clock_in >= $${ep++}::timestamptz`); empParams.push(`${dateFrom}T00:00:00Z`); }
    if (dateTo)   { empFilters.push(`clock_in <= $${ep++}::timestamptz`); empParams.push(`${dateTo}T23:59:59Z`); }

    const rows = await pool.query(`
      SELECT
        employee_name,
        COUNT(*) AS sessions,
        SUM(EXTRACT(EPOCH FROM (COALESCE(clock_out, NOW()) - clock_in)) / 3600.0) AS total_hours
      FROM public.time_entries_v2
      WHERE owner_id::text = $1
        ${empFilters.length ? 'AND ' + empFilters.join(' AND ') : ''}
      GROUP BY employee_name
      ORDER BY total_hours ${dir}
      LIMIT ${limit}
    `, empParams).catch(() => null);

    return {
      entity, metric: 'hours', n: limit, date_from: dateFrom, date_to: dateTo,
      results: (rows?.rows || []).map((r, i) => ({
        rank:        i + 1,
        name:        r.employee_name,
        sessions:    toInt(r.sessions),
        total_hours: Math.round(Number(r.total_hours) * 10) / 10,
      })),
    };
  }

  return { error: `Unknown entity "${entity}". Valid: ${VALID_ENTITIES.join(', ')}` };
}

const getTopNTool = {
  type: 'function',
  function: {
    name: 'get_top_n',
    description: [
      'Get ranked top-N results for jobs (by profit/revenue/margin), vendors (by spend),',
      'expense categories (by spend), or employees (by hours).',
      'Use for questions like "top 5 jobs by profit", "which vendor do I spend the most with?",',
      '"biggest expense categories this month", "who logged the most hours?"',
    ].join(' '),
    parameters: {
      type: 'object',
      required: ['owner_id', 'entity'],
      properties: {
        owner_id:  { type: 'string' },
        entity:    { type: 'string', enum: ['jobs', 'vendors', 'categories', 'employees'] },
        metric:    { type: 'string', enum: ['profit', 'revenue', 'expenses', 'hours', 'margin'], description: 'Sort metric' },
        n:         { type: 'integer', description: 'Number of results (default 5, max 20)' },
        date_from: { type: 'string', description: 'ISO date filter start' },
        date_to:   { type: 'string', description: 'ISO date filter end' },
        sort_dir:  { type: 'string', enum: ['desc', 'asc'], description: 'desc = highest first (default)' },
      },
    },
  },
  __handler: async (args) => {
    try {
      const defaultMetrics = { jobs: 'profit', vendors: 'expenses', categories: 'expenses', employees: 'hours' };
      const ent = String(args.entity || 'jobs').toLowerCase();
      const met = args.metric ? String(args.metric).toLowerCase() : (defaultMetrics[ent] || 'profit');

      return await getTopN({
        ownerId:  String(args.owner_id || '').trim(),
        entity:   ent,
        metric:   met,
        n:        args.n,
        dateFrom: args.date_from  ? String(args.date_from).trim()  : null,
        dateTo:   args.date_to    ? String(args.date_to).trim()    : null,
        sortDir:  args.sort_dir   ? String(args.sort_dir).trim()   : 'desc',
      });
    } catch (err) {
      return { error: `get_top_n failed: ${err?.message}` };
    }
  },
};

module.exports = { getTopNTool, getTopN };
