'use strict';

/**
 * Agent Tools: Transactions (read-only)
 * Tool A: search_transactions
 * Tool B: get_transaction
 * Tool C: get_spend_summary
 */

const pg = require('../postgres');

function isoDateOrNull(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  // lightweight YYYY-MM-DD check; DB will enforce date coercion
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  return t;
}

function toIntOrNull(n) {
  if (n == null || n === '') return null;
  const x = Number(n);
  return Number.isFinite(x) ? Math.trunc(x) : null;
}

async function search_transactions(args = {}, ctx = {}) {
  const owner_id = String(args.owner_id || ctx.owner_id || '').trim();
  if (!owner_id) throw new Error('search_transactions missing owner_id');

  const kind = args.kind ? String(args.kind).trim() : null;
  const date_from = isoDateOrNull(args.date_from);
  const date_to = isoDateOrNull(args.date_to);
  const source_contains = args.source_contains ? String(args.source_contains).trim() : null;
  const description_contains = args.description_contains ? String(args.description_contains).trim() : null;
  const category = args.category ? String(args.category).trim() : null;

  const job_id = args.job_id ? String(args.job_id).trim() : null;
  const job_name_contains = args.job_name_contains ? String(args.job_name_contains).trim() : null;

  const min_amount_cents = toIntOrNull(args.min_amount_cents);
  const max_amount_cents = toIntOrNull(args.max_amount_cents);

  const limit = Math.min(Math.max(toIntOrNull(args.limit) ?? 25, 1), 100);
  const offset = Math.min(Math.max(toIntOrNull(args.offset) ?? 0, 0), 10000);

  const caps = await pg.detectTransactionsCapabilities().catch(() => ({}));

  const where = [];
  const params = [];
  let p = 1;

  where.push(`owner_id::text = $${p++}`);
  params.push(owner_id);

  if (kind) {
    where.push(`kind = $${p++}`);
    params.push(kind);
  }
  if (date_from) {
    where.push(`date >= $${p++}::date`);
    params.push(date_from);
  }
  if (date_to) {
    where.push(`date <= $${p++}::date`);
    params.push(date_to);
  }
  if (min_amount_cents != null) {
    where.push(`amount_cents >= $${p++}`);
    params.push(min_amount_cents);
  }
  if (max_amount_cents != null) {
    where.push(`amount_cents <= $${p++}`);
    params.push(max_amount_cents);
  }
  if (category) {
    where.push(`category = $${p++}`);
    params.push(category);
  }

  if (source_contains) {
    where.push(`source ILIKE $${p++}`);
    params.push(`%${source_contains}%`);
  }
  if (description_contains) {
    where.push(`description ILIKE $${p++}`);
    params.push(`%${description_contains}%`);
  }

  // Job filters: prefer job_id if present; fall back to job_name/job if needed
  if (job_id && caps.TX_HAS_JOB_ID) {
    where.push(`job_id::text = $${p++}`);
    params.push(job_id);
  } else if (job_id && caps.TX_HAS_JOB) {
    where.push(`job::text = $${p++}`);
    params.push(job_id);
  }

  if (job_name_contains && caps.TX_HAS_JOB_NAME) {
    where.push(`job_name ILIKE $${p++}`);
    params.push(`%${job_name_contains}%`);
  } else if (job_name_contains && caps.TX_HAS_JOB) {
    where.push(`job ILIKE $${p++}`);
    params.push(`%${job_name_contains}%`);
  }

  const sql = `
    select
      id,
      date::text as date,
      kind,
      amount_cents,
      source,
      description,
      ${caps.TX_HAS_JOB_ID ? 'job_id::text as job_id,' : 'null::text as job_id,'}
      ${caps.TX_HAS_JOB_NAME ? 'job_name,' : 'null::text as job_name,'}
      ${caps.TX_HAS_CATEGORY ? 'category,' : 'null::text as category,'}
      ${caps.TX_HAS_MEDIA_ASSET_ID ? 'media_asset_id::text as media_asset_id,' : 'null::text as media_asset_id,'}
      ${caps.TX_HAS_SOURCE_MSG_ID ? 'source_msg_id' : 'null::text as source_msg_id'}
    from public.transactions
    where ${where.join('\n      and ')}
    order by date desc, id desc
    limit $${p++} offset $${p++}
  `;

  params.push(limit, offset);

  const r = await pg.queryWithTimeout(sql, params, 4000);
  return { rows: r?.rows || [] };
}

async function get_transaction(args = {}, ctx = {}) {
  const owner_id = String(args.owner_id || ctx.owner_id || '').trim();
  const id = Number(args.id);
  if (!owner_id) throw new Error('get_transaction missing owner_id');
  if (!Number.isFinite(id)) throw new Error('get_transaction missing/invalid id');

  const sql = `
    select
      id,
      owner_id,
      kind,
      date::text as date,
      description,
      amount,
      amount_cents,
      source,
      job,
      job_name,
      job_id::text as job_id,
      category,
      user_name,
      source_msg_id,
      dedupe_hash,
      media_url,
      media_type,
      media_transcript,
      media_confidence,
      media_asset_id::text as media_asset_id,
      created_at::text as created_at
    from public.transactions
    where owner_id::text = $1
      and id = $2
    limit 1
  `;

  const r = await pg.queryWithTimeout(sql, [owner_id, id], 4000);
  const row = r?.rows?.[0] || null;
  return { row };
}

async function get_spend_summary(args = {}, ctx = {}) {
  const owner_id = String(args.owner_id || ctx.owner_id || '').trim();
  const date_from = isoDateOrNull(args.date_from);
  const date_to = isoDateOrNull(args.date_to);
  const job_id = args.job_id ? String(args.job_id).trim() : null;
  const job_name_contains = args.job_name_contains ? String(args.job_name_contains).trim() : null;

  if (!owner_id) throw new Error('get_spend_summary missing owner_id');
  if (!date_from || !date_to) throw new Error('get_spend_summary missing date_from/date_to');

  const caps = await pg.detectTransactionsCapabilities().catch(() => ({}));

  // Total spend (expenses only)
  const where = [`owner_id::text = $1`, `kind = 'expense'`, `date >= $2::date`, `date <= $3::date`];
  const params = [owner_id, date_from, date_to];
  let p = 4;

  if (job_id && caps.TX_HAS_JOB_ID) {
    where.push(`job_id::text = $${p++}`);
    params.push(job_id);
  } else if (job_id && caps.TX_HAS_JOB) {
    where.push(`job::text = $${p++}`);
    params.push(job_id);
  }

  if (job_name_contains && caps.TX_HAS_JOB_NAME) {
    where.push(`job_name ILIKE $${p++}`);
    params.push(`%${job_name_contains}%`);
  } else if (job_name_contains && caps.TX_HAS_JOB) {
    where.push(`job ILIKE $${p++}`);
    params.push(`%${job_name_contains}%`);
  }

  const totalSql = `
    select
      coalesce(sum(amount_cents), 0)::bigint as total_amount_cents,
      count(*)::int as count
    from public.transactions
    where ${where.join('\n      and ')}
  `;

  const totalRes = await pg.queryWithTimeout(totalSql, params, 4000);
  const total_amount_cents = Number(totalRes?.rows?.[0]?.total_amount_cents) || 0;
  const count = Number(totalRes?.rows?.[0]?.count) || 0;

  // Top vendors: reuse your existing breakdown helper (already does canonical vendor keying)
  // NOTE: your helper uses a half-open range (date < toDate). We'll pass (date_to + 1 day)
  // to approximate inclusive end. If you prefer exact behavior, swap to a local vendor query.
  let top_vendors = [];
  try {
    const toPlusOne = new Date(date_to + 'T00:00:00Z');
    toPlusOne.setUTCDate(toPlusOne.getUTCDate() + 1);
    const toPlusOneIso = toPlusOne.toISOString().slice(0, 10);

    const vb = await pg.getOwnerVendorBreakdown(owner_id, date_from, toPlusOneIso, 'expense');
    top_vendors = (vb || [])
      .slice(0, 10)
      .map((r) => ({ source: r.vendor_key, amount_cents: Number(r.amount_cents) || 0 }));
  } catch {
    // ignore vendor breakdown if it fails; total is still correct
  }

  return { total_amount_cents, count, top_vendors };
}

module.exports = {
  search_transactions,
  get_transaction,
  get_spend_summary
};
