// services/postgres.js (DROP-IN) — Beta-ready, schema-aware, safe fallbacks
// ------------------------------------------------------------
const { Pool } = require('pg');
const crypto = require('crypto');
const integrity = require('./integrity');
const { formatInTimeZone } = require('date-fns-tz');
const { getEffectivePlanKey } = require('../src/config/getEffectivePlanKey');
/* ---------- Environment (robust) ---------- */
const env = process.env;

const DB_URL =
  (env.DATABASE_URL && String(env.DATABASE_URL).trim()) ||
  (env.POSTGRES_URL && String(env.POSTGRES_URL).trim()) ||
  (env.SUPABASE_DB_URL && String(env.SUPABASE_DB_URL).trim()) ||
  '';

const NODE_ENV = env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

// Hosted DBs usually need SSL. Local 127.0.0.1 usually does not.
const PGSSLMODE = (env.PGSSLMODE || '').toLowerCase();
const shouldSSL =
  PGSSLMODE === 'require' || /supabase\.co|render\.com|herokuapp\.com|aws|gcp|azure/i.test(DB_URL);

const ssl = shouldSSL ? { rejectUnauthorized: false } : false;

// Build pool config
let poolConfig;
if (DB_URL) {
  poolConfig = { connectionString: DB_URL, ssl };
} else {
  const host = env.PGHOST || '127.0.0.1';
  const port = Number(env.PGPORT || 5432);
  const database = env.PGDATABASE || 'postgres';
  const user = env.PGUSER || 'postgres';
  const password = env.PGPASSWORD || '';
  poolConfig = { host, port, database, user, password, ssl };
}

if (!DB_URL && (!poolConfig.host || !poolConfig.database)) {
  throw new Error("Postgres not configured. Set DATABASE_URL in config/.env or PGHOST/PGDATABASE/etc.");
}

/* ---------- Pool (sane limits + timeouts) ---------- */
const pool = new Pool({
  ...poolConfig,
  max: parseInt(process.env.PG_POOL_MAX || '5', 10),
  min: 0,
  idleTimeoutMillis: 60_000,
  connectionTimeoutMillis: parseInt(process.env.PG_CONN_TIMEOUT_MS || '5000', 10),
  query_timeout: parseInt(process.env.PG_QUERY_TIMEOUT_MS || '9000', 10),
  keepAlive: true,
  application_name: 'chief-ai'
});

pool.on("connect", async (client) => {
  try {
    // ✅ Single round-trip session prep (much safer on serverless/poolers)
    const timeoutMs = parseInt(process.env.PG_STATEMENT_TIMEOUT_MS || "8000", 10);

    await client.query(
      `
      SET TIME ZONE 'UTC';
      SET intervalstyle = 'iso_8601';
      SET statement_timeout = '${timeoutMs}ms';
      `
    );
  } catch (e) {
    // ✅ Never let connect-prep failures break requests
    console.warn("[PG] connect session prep failed:", String(e?.message || e));
  }
});



pool.on('error', (err) => {
  console.error('[PG] idle client error:', err?.message);
});

// Active job resolution join mode
// - "legacy": old behavior
// - "rls": new behavior if you introduced a new join path
const userActiveJobJoinMode = String(env.USER_ACTIVE_JOB_JOIN_MODE || 'legacy').toLowerCase();

/* ---------- Core query helpers ---------- */
async function query(text, params) {
  return queryWithRetry(text, params);
}

async function queryWithRetry(text, params, attempt = 1) {
  try {
    return await pool.query(text, params);
  } catch (e) {
    const msg = String(e?.message || '');
    const transient = /terminated|ECONNRESET|EPIPE|read ECONNRESET|connection terminated|TimeoutError/i.test(msg);
    if (transient && attempt < 3) {
      console.warn(`[PG] retry ${attempt + 1}: ${msg}`);
      await new Promise((r) => setTimeout(r, attempt * 200));
      return queryWithRetry(text, params, attempt + 1);
    }
    throw e;
  }
}
function getDbQueryFn() {
  // Prefer local helper if it exists
  if (typeof query === 'function') return query;

  // Common patterns
  if (typeof module.exports?.query === 'function') return module.exports.query;
  if (typeof exports?.query === 'function') return exports.query;

  // Pool fallbacks
  if (module.exports?.pool?.query) return module.exports.pool.query.bind(module.exports.pool);
  if (typeof pool?.query === 'function') return pool.query.bind(pool);

  throw new Error('DB query function not available (query/pool missing)');
}
async function withClient(fn, { useTransaction = true } = {}) {
  const client = await pool.connect();
  try {
    if (useTransaction) await client.query('BEGIN');
    const res = await fn(client);
    if (useTransaction) await client.query('COMMIT');
    return res;
  } catch (err) {
    if (useTransaction) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function queryWithTimeout(sql, params, ms = 9000) {
  return withClient(
    async (client) => {
      const timeoutMs = Math.max(0, Number(ms) | 0);
      await client.query(`SET LOCAL statement_timeout = '${timeoutMs}ms'`);
      return client.query(sql, params);
    },
    { useTransaction: true }
  );
}

/* ---------- Utilities (single source of truth) ---------- */
const DIGITS = (x) => String(x ?? '').replace(/\D/g, '');

function toCents(v) {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}
const toAmount = toCents;

const isValidIso = (ts) => !!ts && !Number.isNaN(new Date(ts).getTime());

function todayInTZ(tz = 'America/Toronto') {
  return formatInTimeZone(new Date(), tz, 'yyyy-MM-dd');
}

const normalizePhoneNumber = (x) => DIGITS(x);

function looksLikeUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(str || '')
  );
}

function ownerKey(ownerId) {
  return String(ownerId || "").trim();
}

function ownerDigitsOrNull(ownerId) {
  const d = String(ownerId || "").replace(/\D/g, "");
  return d || null;
}

// ---------------- Tenant mapping helpers ----------------

/**
 * Map owner digits (e.g. "19053279955") -> tenant UUID (e.g. "5c7c3a45-...").
 * Rebuild schema: chiefos_tenants.owner_id is UNIQUE, so a single lookup suffices.
 *
 * Returns: tenant_id UUID string OR null
 */
async function getTenantIdForOwnerDigits(ownerDigits) {
  const owner = DIGITS(ownerDigits);
  if (!owner) return null;

  try {
    const r = await query(
      `
      select id as tenant_id
      from public.chiefos_tenants
      where owner_id = $1
      limit 1
      `,
      [owner]
    );
    const tid = r?.rows?.[0]?.tenant_id || null;
    if (tid) return String(tid);
  } catch (e) {
    const msg = String(e?.message || '');
    if (!/does not exist|permission denied/i.test(msg)) {
      console.warn('[PG] getTenantIdForOwnerDigits(chiefos_tenants) failed:', msg);
    }
  }

  return null;
}

async function topExpenseCategoriesByRange({ ownerId, fromIso, toIso, limit = 5 }) {
  const owner = DIGITS(ownerId);
  if (!owner) return { rows: [] };

  const lim = Math.max(1, Math.min(25, Number(limit || 5)));

  const r = await query(
    `
    select
      coalesce(nullif(trim(category), ''), 'Uncategorized') as category,
      coalesce(sum(coalesce(amount_cents, (round(amount * 100))::bigint)), 0)::bigint as cents
    from public.transactions
    where owner_id::text = $1
      and lower(kind) = 'expense'
      and date >= $2::date
      and date <= $3::date
    group by 1
    order by cents desc
    limit ${lim}
    `,
    [owner, fromIso, toIso]
  );

  return r;
}

async function resolveTenantIdForOwner(ownerId) {
  const owner = String(ownerId || '').trim();
  if (!owner) return null;

  // Most ChiefOS installs: 1 tenant per owner phone
  const r = await queryWithTimeout(
    `select id
       from public.chiefos_tenants
      where regexp_replace(coalesce(owner_id,''), '\\D', '', 'g') = regexp_replace($1, '\\D', '', 'g')
      order by created_at asc
      limit 1`,
    [owner],
    2500
  );

  return r?.rows?.[0]?.id ?? null;
}

async function topExpenseVendorsByRange({ ownerId, fromIso, toIso, limit = 5 }) {
  const owner = DIGITS(ownerId);
  if (!owner) return { rows: [] };

  const lim = Math.max(1, Math.min(25, Number(limit || 5)));

  // vendor does not exist in transactions, so we use:
  // - description (best effort)
  // - fallback to category if description empty
const r = await query(
  `
  with v as (
    select
      -- raw vendor guess (best effort)
      coalesce(
        nullif(trim(split_part(description, ' - ', 1)), ''),
        nullif(trim(split_part(description, '@', 1)), ''),
        nullif(trim(description), ''),
        'Unknown'
      ) as vendor_raw,
      coalesce(amount_cents, (round(amount * 100))::bigint) as cents
    from public.transactions
    where owner_id::text = $1
      and lower(kind) = 'expense'
      and date >= $2::date
      and date <= $3::date
  )
  select
    -- normalized key for grouping (fixes Lumber vs lumber)
    initcap(lower(trim(vendor_raw))) as vendor,
    coalesce(sum(cents), 0)::bigint as cents
  from v
  group by lower(trim(vendor_raw))
  order by cents desc
  limit ${lim}
  `,
  [owner, fromIso, toIso]
);

  return r;
}

// -------------------- Job profit by range (transactions-first) --------------------

/**
 * Compute job profit by range from public.transactions.
 *
 * Requirements:
 * - transactions.kind in ('revenue','expense')
 * - date column exists (you already use `date`)
 * - job link exists in one of:
 *   - transactions.job_id (preferred)
 *   - transactions.job_no
 *
 * Returns:
 * { ok:true, row:{ revenue_cents, expense_cents, profit_cents, mode } }
 * or { ok:false, error, reason }
 */
async function getJobProfitByRange({ ownerId, jobId = null, jobNo = null, fromIso, toIso }) {
  const owner = DIGITS(ownerId);
  if (!owner) return { ok: false, reason: "missing_owner" };

  const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "").trim());
  const from = String(fromIso || "").trim();
  const to = String(toIso || "").trim();
  if (!isIso(from) || !isIso(to)) return { ok: false, reason: "invalid_range" };

  const a = from <= to ? from : to;
  const b = from <= to ? to : from;

  // Decide which job-link column is available
  const hasJobId = await hasColumn("transactions", "job_id");
  const hasJobNo = await hasColumn("transactions", "job_no");

  // Fail-closed: if we have neither, we cannot do ranged job profit safely
  if (!hasJobId && !hasJobNo) {
    return { ok: false, reason: "no_job_link_columns" };
  }

  // Prefer job_id if available and provided
  if (hasJobId && jobId != null && Number.isFinite(Number(jobId))) {
    const jid = Number(jobId);

    const r = await query(
      `
      with sums as (
        select
          coalesce(sum(case when kind='revenue' then coalesce(amount_cents, (round(coalesce(amount,0)::numeric*100))::bigint) else 0 end),0)::bigint as revenue_cents,
          coalesce(sum(case when kind='expense' then coalesce(amount_cents, (round(coalesce(amount,0)::numeric*100))::bigint) else 0 end),0)::bigint as expense_cents
        from public.transactions
        where owner_id::text = $1
          and kind in ('revenue','expense')
          and date >= $2::date
          and date <= $3::date
          and job_id = $4
      )
      select
        revenue_cents,
        expense_cents,
        (revenue_cents - expense_cents)::bigint as profit_cents
      from sums
      `,
      [owner, a, b, jid]
    );

    const row = r?.rows?.[0] || null;
    if (!row) return { ok: false, reason: "no_rows" };

    return { ok: true, row: { ...row, mode: "job_id" } };
  }

  // Fallback: job_no if available and provided
  if (hasJobNo && jobNo != null && Number.isFinite(Number(jobNo))) {
    const jn = Number(jobNo);

    const r = await query(
      `
      with sums as (
        select
          coalesce(sum(case when kind='revenue' then coalesce(amount_cents, (round(coalesce(amount,0)::numeric*100))::bigint) else 0 end),0)::bigint as revenue_cents,
          coalesce(sum(case when kind='expense' then coalesce(amount_cents, (round(coalesce(amount,0)::numeric*100))::bigint) else 0 end),0)::bigint as expense_cents
        from public.transactions
        where owner_id::text = $1
          and kind in ('revenue','expense')
          and date >= $2::date
          and date <= $3::date
          and job_no = $4
      )
      select
        revenue_cents,
        expense_cents,
        (revenue_cents - expense_cents)::bigint as profit_cents
      from sums
      `,
      [owner, a, b, jn]
    );

    const row = r?.rows?.[0] || null;
    if (!row) return { ok: false, reason: "no_rows" };

    return { ok: true, row: { ...row, mode: "job_no" } };
  }

  // If we couldn't use any mode because required input missing:
  return { ok: false, reason: "missing_job_key_for_available_mode", hasJobId, hasJobNo };
}


/**
 * Sum expenses (in cents) for a date range.
 * Post-rebuild canonical: public.transactions WHERE kind='expense' (chiefos_expenses
 * was DISCARDed). amount_cents is bigint cents, no conversion needed.
 */
async function sumExpensesCentsByRange({ tenantId, ownerId, fromIso, toIso }) {
  let tid = tenantId ? String(tenantId).trim() : null;

  if (!tid && ownerId) {
    tid = await getTenantIdForOwnerDigits(ownerId);
  }

  if (!tid) {
    console.warn("[INSIGHTS] tenantId not resolved for owner:", ownerId || null);
    return 0;
  }

  const from = String(fromIso || "").trim();
  const to = String(toIso || "").trim();

  const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isIso(from) || !isIso(to)) {
    console.warn("[INSIGHTS] invalid date range (expenses)", { fromIso, toIso, tid });
    return 0;
  }

  const a = from <= to ? from : to;
  const b = from <= to ? to : from;

  const r = await query(
    `
    select coalesce(sum(amount_cents), 0)::bigint as total_cents
      from public.transactions
     where tenant_id = $1
       and kind = 'expense'
       and deleted_at is null
       and submission_status = 'confirmed'
       and date >= $2::date
       and date <= $3::date
    `,
    [tid, a, b]
  );

  return Number(r?.rows?.[0]?.total_cents || 0);
}

/**
 * Sum revenues (in cents) for a date range.
 * transactions.amount_cents preferred; fallback to amount (numeric dollars).
 */
async function sumRevenueCentsByRange({ ownerId, fromIso, toIso }) {
  const owner = DIGITS(ownerId);
  if (!owner) return 0;

  const from = String(fromIso || "").trim();
  const to = String(toIso || "").trim();

  const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isIso(from) || !isIso(to)) {
    console.warn("[INSIGHTS] invalid date range (revenue)", { fromIso, toIso, owner });
    return 0;
  }

  const a = from <= to ? from : to;
  const b = from <= to ? to : from;

  const r = await query(
    `
    select coalesce(sum(
      coalesce(
        amount_cents,
        (round(coalesce(amount, 0)::numeric * 100))::bigint
      )
    ), 0)::bigint as total_cents
    from public.transactions
    where owner_id::text = $1
      and kind = 'revenue'
      and date >= $2::date
      and date <= $3::date
    `,
    [owner, a, b]
  );

  return Number(r?.rows?.[0]?.total_cents || 0);
}

/* -------------------- Usage / Quotas (monthly) -------------------- */

function ymInTZ(tz = 'America/Toronto', d = new Date()) {
  // returns "YYYY-MM"
  const day = formatInTimeZone(d, tz, 'yyyy-MM-dd'); // you already import formatInTimeZone
  return String(day).slice(0, 7);
}

async function getUsageMonthly(ownerId, ym, { createIfMissing = true } = {}) {
  const owner = String(ownerId || '').trim();
  const keyYm = String(ym || '').trim();
  if (!owner || !keyYm) return null;

  const { rows } = await query(
    `
    select owner_id, ym, ocr_receipts_count, voice_minutes, ask_chief_questions
      from public.usage_monthly
     where owner_id = $1 and ym = $2
     limit 1
    `,
    [owner, keyYm]
  );

  if (rows?.[0]) return rows[0];

  if (!createIfMissing) return {
    owner_id: owner,
    ym: keyYm,
    ocr_receipts_count: 0,
    voice_minutes: 0,
    ask_chief_questions: 0
  };

  const ins = await query(
    `
    insert into public.usage_monthly (owner_id, ym, ocr_receipts_count, voice_minutes, ask_chief_questions)
    values ($1, $2, 0, 0, 0)
    on conflict (owner_id, ym) do nothing
    returning owner_id, ym, ocr_receipts_count, voice_minutes, ask_chief_questions
    `,
    [owner, keyYm]
  );

  if (ins?.rows?.[0]) return ins.rows[0];

  // If conflict happened, re-read
  const reread = await query(
    `
    select owner_id, ym, ocr_receipts_count, voice_minutes, ask_chief_questions
      from public.usage_monthly
     where owner_id = $1 and ym = $2
     limit 1
    `,
    [owner, keyYm]
  );
  return reread?.rows?.[0] || null;
}

async function incrementUsageMonthly(ownerId, ym, field, delta = 1) {
  const owner = String(ownerId || '').trim();
  const keyYm = String(ym || '').trim();
  const f = String(field || '').trim();

  const allowed = new Set(['ocr_receipts_count', 'voice_minutes', 'ask_chief_questions']);
  if (!owner || !keyYm || !allowed.has(f)) {
    return { ok: false, reason: 'invalid_args' };
  }

  const d = Number(delta);
  const inc = Number.isFinite(d) ? d : 1;

  const sqlByField = {
    ocr_receipts_count: `
      insert into public.usage_monthly (owner_id, ym, ocr_receipts_count)
      values ($1, $2, $3)
      on conflict (owner_id, ym)
      do update set ocr_receipts_count = public.usage_monthly.ocr_receipts_count + excluded.ocr_receipts_count
      returning owner_id, ym, ocr_receipts_count, voice_minutes, ask_chief_questions
    `,
    voice_minutes: `
      insert into public.usage_monthly (owner_id, ym, voice_minutes)
      values ($1, $2, $3)
      on conflict (owner_id, ym)
      do update set voice_minutes = public.usage_monthly.voice_minutes + excluded.voice_minutes
      returning owner_id, ym, ocr_receipts_count, voice_minutes, ask_chief_questions
    `,
    ask_chief_questions: `
      insert into public.usage_monthly (owner_id, ym, ask_chief_questions)
      values ($1, $2, $3)
      on conflict (owner_id, ym)
      do update set ask_chief_questions = public.usage_monthly.ask_chief_questions + excluded.ask_chief_questions
      returning owner_id, ym, ocr_receipts_count, voice_minutes, ask_chief_questions
    `,
  };

  const { rows } = await query(sqlByField[f], [owner, keyYm, inc]);
  return { ok: true, row: rows?.[0] || null };
}

/**
 * Convenience checker:
 * - capMonthly: number | null
 * - used: number
 * returns { allowed: boolean, remaining: number|null }
 */
function checkMonthlyQuota(capMonthly, used) {
  if (capMonthly == null) return { allowed: true, remaining: null }; // unbounded
  const cap = Number(capMonthly);
  const u = Number(used || 0);
  if (!Number.isFinite(cap) || cap <= 0) return { allowed: false, remaining: 0 };
  const remaining = Math.max(0, cap - u);
  return { allowed: remaining > 0, remaining };
}

/* ---------- schema helpers (cached) ---------- */
const _TABLE_CACHE = new Map();
const _COL_CACHE = new Map();
const _COL_TYPE_CACHE = new Map();

async function hasColumn(table, col) {
  const key = `${String(table)}.${String(col)}`;
  if (_COL_CACHE.has(key)) return _COL_CACHE.get(key);

  const r = await query(
    `select 1
       from information_schema.columns
      where table_schema='public'
        and table_name=$1
        and column_name=$2
      limit 1`,
    [table, col]
  );
  const ok = (r?.rows?.length || 0) > 0;
  _COL_CACHE.set(key, ok);
  return ok;
}

async function hasTable(table) {
  const t = String(table);
  if (_TABLE_CACHE.has(t)) return _TABLE_CACHE.get(t);

  const r = await query(
    `select 1
       from information_schema.tables
      where table_schema='public'
        and table_name=$1
      limit 1`,
    [t]
  );
  const ok = (r?.rows?.length || 0) > 0;
  _TABLE_CACHE.set(t, ok);
  return ok;
}

async function getColumnDataType(table, col) {
  const key = `${String(table)}.${String(col)}.type`;
  if (_COL_TYPE_CACHE.has(key)) return _COL_TYPE_CACHE.get(key);

  try {
    const r = await query(
      `select data_type
         from information_schema.columns
        where table_schema='public'
          and table_name=$1
          and column_name=$2
        limit 1`,
      [String(table), String(col)]
    );
    const t = String(r?.rows?.[0]?.data_type || '').toLowerCase() || null;
    _COL_TYPE_CACHE.set(key, t);
    return t;
  } catch {
    _COL_TYPE_CACHE.set(key, null);
    return null;
  }
}

// memberships self-disabling cache
let _MEMBERSHIPS_OK = null;

// detectUserActiveJobJobIdType — DELETED post-rebuild.
// user_active_job table is DROPPED; canonical replacement is
// users.auto_assign_active_job_id (integer FK to jobs.id). Type
// detection is no longer needed. Active-job get/set are stubbed
// pending rewrite per P1 punchlist.

/* ------------------------------------------------------------------ */
/* ✅ Media transcript truncation + transactions schema capabilities    */
/* ------------------------------------------------------------------ */
const MEDIA_TRANSCRIPT_MAX_CHARS = 8000;

function truncateText(s, maxChars = MEDIA_TRANSCRIPT_MAX_CHARS) {
  const str = String(s ?? '');
  if (!str) return null;
  if (!Number.isFinite(maxChars) || maxChars <= 0) return null;
  return str.length > maxChars ? str.slice(0, maxChars) : str;
}

// add this near your other TX_HAS_* globals
let TX_HAS_DEDUPE_HASH = null;
let TX_HAS_SOURCE_MSG_ID = null;
let TX_HAS_AMOUNT = null;
let TX_HAS_MEDIA_URL = null;
let TX_HAS_MEDIA_TYPE = null;
let TX_HAS_MEDIA_TXT = null;
let TX_HAS_MEDIA_CONF = null;
let TX_HAS_JOB_ID = null; // uuid/text depending schema
let TX_HAS_JOB_NO = null;
let TX_HAS_JOB = null;
let TX_HAS_JOB_NAME = null;
let TX_HAS_CATEGORY = null;
let TX_HAS_USER_NAME = null;
let TX_HAS_MEDIA_META = null; // jsonb single-field meta (if you have it)
let TX_HAS_CREATED_AT = null;
let TX_HAS_UPDATED_AT = null;
let TX_HAS_SUBTOTAL_AMOUNT = null;
let TX_HAS_TAX_AMOUNT = null;
let TX_HAS_TAX_LABEL = null;
let TX_HAS_RECORD_HASH = null;

let TX_HAS_OWNER_SOURCEMSG_UNIQUE = null;

async function detectTransactionsCapabilities() {
  // cached
  if (
    TX_HAS_SOURCE_MSG_ID !== null &&
    TX_HAS_AMOUNT !== null &&
    TX_HAS_MEDIA_URL !== null &&
    TX_HAS_MEDIA_TYPE !== null &&
    TX_HAS_MEDIA_TXT !== null &&
    TX_HAS_MEDIA_CONF !== null &&
    TX_HAS_JOB_ID !== null &&
    TX_HAS_JOB_NO !== null &&
    TX_HAS_DEDUPE_HASH !== null &&
    TX_HAS_JOB !== null &&
    TX_HAS_JOB_NAME !== null &&
    TX_HAS_CATEGORY !== null &&
    TX_HAS_USER_NAME !== null &&
    TX_HAS_MEDIA_META !== null &&
    TX_HAS_CREATED_AT !== null &&
    TX_HAS_UPDATED_AT !== null &&
    TX_HAS_MEDIA_ASSET_ID !== null &&
    TX_HAS_TENANT_ID !== null &&
    TX_HAS_SUBTOTAL_AMOUNT !== null &&
    TX_HAS_TAX_AMOUNT !== null &&
    TX_HAS_TAX_LABEL !== null &&
    TX_HAS_RECORD_HASH !== null
  ) {
    return {
      TX_HAS_SOURCE_MSG_ID,
      TX_HAS_AMOUNT,
      TX_HAS_MEDIA_URL,
      TX_HAS_MEDIA_TYPE,
      TX_HAS_MEDIA_TXT,
      TX_HAS_MEDIA_CONF,
      TX_HAS_JOB_ID,
      TX_HAS_JOB_NO,
      TX_HAS_DEDUPE_HASH,
      TX_HAS_JOB,
      TX_HAS_JOB_NAME,
      TX_HAS_CATEGORY,
      TX_HAS_USER_NAME,
      TX_HAS_MEDIA_META,
      TX_HAS_CREATED_AT,
      TX_HAS_UPDATED_AT,
      TX_HAS_MEDIA_ASSET_ID,
      TX_HAS_TENANT_ID,
      TX_HAS_SUBTOTAL_AMOUNT,
      TX_HAS_TAX_AMOUNT,
      TX_HAS_TAX_LABEL,
      TX_HAS_RECORD_HASH
    };
  }

  try {
    const { rows } = await query(
      `select column_name
         from information_schema.columns
        where table_schema='public'
          and table_name='transactions'`
    );

    const names = new Set((rows || []).map((r) => String(r.column_name).toLowerCase()));

    TX_HAS_TENANT_ID = names.has('tenant_id');

    TX_HAS_SOURCE_MSG_ID = names.has('source_msg_id');
    TX_HAS_AMOUNT = names.has('amount');
    TX_HAS_MEDIA_URL = names.has('media_url');
    TX_HAS_MEDIA_TYPE = names.has('media_type');
    TX_HAS_MEDIA_TXT = names.has('media_transcript');
    TX_HAS_MEDIA_CONF = names.has('media_confidence');
    TX_HAS_JOB_ID = names.has('job_id');
    TX_HAS_JOB_NO = names.has('job_no');
    TX_HAS_DEDUPE_HASH = names.has('dedupe_hash');
    TX_HAS_MEDIA_ASSET_ID = names.has('media_asset_id');

    // additional back-compat / optional columns
    TX_HAS_JOB = names.has('job');
    TX_HAS_JOB_NAME = names.has('job_name');
    TX_HAS_CATEGORY = names.has('category');
    TX_HAS_USER_NAME = names.has('user_name');
    TX_HAS_MEDIA_META = names.has('media_meta');
    TX_HAS_CREATED_AT = names.has('created_at');
    TX_HAS_UPDATED_AT = names.has('updated_at');
    TX_HAS_SUBTOTAL_AMOUNT = names.has('subtotal_amount');
    TX_HAS_TAX_AMOUNT = names.has('tax_amount');
    TX_HAS_TAX_LABEL = names.has('tax_label');
    TX_HAS_RECORD_HASH = names.has('record_hash');
  } catch (e) {
    console.warn('[PG/transactions] detect capabilities failed (fail-open):', e?.message);
    // Don't cache transient errors — allow retry on next call
    return {
      TX_HAS_SOURCE_MSG_ID: false,
      TX_HAS_AMOUNT: false,
      TX_HAS_MEDIA_URL: false,
      TX_HAS_MEDIA_TYPE: false,
      TX_HAS_MEDIA_TXT: false,
      TX_HAS_MEDIA_CONF: false,
      TX_HAS_JOB_ID: false,
      TX_HAS_JOB_NO: false,
      TX_HAS_DEDUPE_HASH: false,
      TX_HAS_JOB: false,
      TX_HAS_JOB_NAME: false,
      TX_HAS_CATEGORY: false,
      TX_HAS_USER_NAME: false,
      TX_HAS_MEDIA_META: false,
      TX_HAS_CREATED_AT: false,
      TX_HAS_UPDATED_AT: false,
      TX_HAS_MEDIA_ASSET_ID: false,
      TX_HAS_TENANT_ID: false,
      TX_HAS_SUBTOTAL_AMOUNT: false,
      TX_HAS_TAX_AMOUNT: false,
      TX_HAS_TAX_LABEL: false,
      TX_HAS_RECORD_HASH: false
    };
  }

  return {
    TX_HAS_SOURCE_MSG_ID,
    TX_HAS_AMOUNT,
    TX_HAS_MEDIA_URL,
    TX_HAS_MEDIA_TYPE,
    TX_HAS_MEDIA_TXT,
    TX_HAS_MEDIA_CONF,
    TX_HAS_JOB_ID,
    TX_HAS_JOB_NO,
    TX_HAS_DEDUPE_HASH,
    TX_HAS_JOB,
    TX_HAS_JOB_NAME,
    TX_HAS_CATEGORY,
    TX_HAS_USER_NAME,
    TX_HAS_MEDIA_META,
    TX_HAS_CREATED_AT,
    TX_HAS_UPDATED_AT,
    TX_HAS_MEDIA_ASSET_ID,
    TX_HAS_TENANT_ID,
    TX_HAS_SUBTOTAL_AMOUNT,
    TX_HAS_TAX_AMOUNT,
    TX_HAS_TAX_LABEL,
    TX_HAS_RECORD_HASH
  };
}

// -------------------- Column type introspection (cached) --------------------

const __colTypeCache = new Map(); // key: "schema.table.column" => { data_type, udt_name }

async function getColumnTypeCached(schema, table, column) {
  const key = `${schema}.${table}.${column}`.toLowerCase();
  if (__colTypeCache.has(key)) return __colTypeCache.get(key);

  const r = await query(
    `
    select data_type, udt_name
    from information_schema.columns
    where table_schema = $1 and table_name = $2 and column_name = $3
    limit 1
    `,
    [schema, table, column]
  );

  const row = r?.rows?.[0] || null;
  const out = row
    ? { data_type: String(row.data_type || '').toLowerCase(), udt_name: String(row.udt_name || '').toLowerCase() }
    : null;

  __colTypeCache.set(key, out);
  return out;
}

function isIntLike(x) {
  const s = String(x ?? '').trim();
  return /^\d+$/.test(s);
}

// ============================================================================
// ✅ DROP-IN: safeQueryUndefinedColumnRetry
// ----------------------------------------------------------------------------
// If a query fails due to undefined column (42703) we retry with a caller-provided
// fallback SQL (typically the same query but without the missing column).
// This prevents crashes from schema drift like: column "source" does not exist.
// ============================================================================
async function safeQueryUndefinedColumnRetry(pgClient, primarySql, params, fallbackSql, tag = 'SAFE_SQL') {
  try {
    return await pgClient.query(primarySql, params);
  } catch (e) {
    const code = e?.code || null; // Postgres error code
    const msg = String(e?.message || '');

    const isUndefinedColumn = code === '42703' || /column .* does not exist/i.test(msg);
    if (!isUndefinedColumn) throw e;

    console.warn(`[${tag}] undefined column -> retrying without optional column`, {
      code,
      msg: msg.slice(0, 180)
    });

    return await pgClient.query(fallbackSql, params);
  }
}




async function detectTransactionsUniqueOwnerSourceMsg() {
  if (TX_HAS_OWNER_SOURCEMSG_UNIQUE !== null) return TX_HAS_OWNER_SOURCEMSG_UNIQUE;

  try {
    const { rows } = await query(
      `
      select pg_get_indexdef(ix.indexrelid) as def
        from pg_class t
        join pg_namespace n on n.oid=t.relnamespace
        join pg_index ix on ix.indrelid=t.oid
       where n.nspname='public'
         and t.relname='transactions'
         and ix.indisunique=true
      `
    );

    const defs = (rows || []).map((r) => String(r.def || '').toLowerCase());

    TX_HAS_OWNER_SOURCEMSG_UNIQUE = defs.some((d) => {
      // Must have key list (owner_id, source_msg_id)
      const keyMatch = d.match(/on\s+public\.transactions\s+using\s+\w+\s*\(([^)]+)\)/);
      const keys = String(keyMatch?.[1] || '');
      if (!(keys.includes('owner_id') && keys.includes('source_msg_id'))) return false;

      // Accept: no predicate OR predicate includes "source_msg_id is not null"
      const hasWhere = d.includes(' where ');
      if (!hasWhere) return true;

      return d.includes('source_msg_id is not null');
    });
  } catch (e) {
    console.warn('[PG/transactions] detect unique(owner_id,source_msg_id) failed:', e?.message);
    TX_HAS_OWNER_SOURCEMSG_UNIQUE = false;
  }

  return TX_HAS_OWNER_SOURCEMSG_UNIQUE;
}



function normalizeMediaMeta(mediaMeta) {
  if (!mediaMeta || typeof mediaMeta !== 'object') return null;

  const url = String(mediaMeta.url || mediaMeta.media_url || '').trim() || null;
  const type = String(mediaMeta.type || mediaMeta.media_type || '').trim() || null;

  const transcriptRaw = mediaMeta.transcript || mediaMeta.media_transcript || null;
  const transcript = transcriptRaw ? truncateText(transcriptRaw, MEDIA_TRANSCRIPT_MAX_CHARS) : null;

  const conf = mediaMeta.confidence ?? mediaMeta.media_confidence ?? null;
  const confidence = Number.isFinite(Number(conf)) ? Number(conf) : null;

  if (!url && !type && !transcript && confidence == null) return null;

  return {
    media_url: url,
    media_type: type,
    media_transcript: transcript,
    media_confidence: confidence
  };
}

/* ------------------------------------------------------------------ */
/* ✅ Job resolution helpers used by insertTransaction                  */
/* ------------------------------------------------------------------ */
async function resolveJobRow(ownerId, jobRefOrName) {
  const owner = String(ownerId || '').trim();
  const ref = jobRefOrName == null ? '' : String(jobRefOrName).trim();
  if (!owner || !ref) return null;

  // If caller passed uuid job_id
  if (looksLikeUuid(ref)) {
    try {
      const r = await query(
        `select id, job_no, coalesce(name, job_name) as job_name
           from public.jobs
          where owner_id=$1 and id=$2::uuid
          limit 1`,
        [owner, ref]
      );
      return r?.rows?.[0] || null;
    } catch {
      return null;
    }
  }

  // If caller passed numeric job_no
  if (/^\d+$/.test(ref)) {
    try {
      const r = await query(
        `select id, job_no, coalesce(name, job_name) as job_name
           from public.jobs
          where owner_id=$1 and job_no=$2
          limit 1`,
        [owner, Number(ref)]
      );
      return r?.rows?.[0] || null;
    } catch {
      return null;
    }
  }

  // Else treat as name
  try {
    const r = await query(
      `select id, job_no, coalesce(name, job_name) as job_name
         from public.jobs
        where owner_id=$1 and lower(coalesce(name, job_name)) = lower($2)
        order by updated_at desc nulls last, created_at desc
        limit 1`,
      [owner, ref]
    );
    return r?.rows?.[0] || null;
  } catch {
    return null;
  }
}

function normDedupeStr(v) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    // keep: a-z 0-9 space . - &
    .replace(/[^a-z0-9 .\-&]/g, '');
}

function buildTxnDedupeHash({ owner, kind, date, amountCents, source, description, jobNo, jobName }) {
  // Keep it stable + cheap. Prefer jobNo when available.
  const payload = [
    String(owner || ''),
    normDedupeStr(kind),
    String(date || ''),
    String(Number(amountCents || 0) || 0),
    normDedupeStr(source),
    normDedupeStr(description),
    jobNo != null && Number.isFinite(Number(jobNo)) ? `jobno:${Number(jobNo)}` : `job:${normDedupeStr(jobName)}`
  ].join('|');

  return crypto.createHash('sha256').update(payload).digest('hex');
}

// Cache whether the unique index exists (so we can safely use ON CONFLICT)
let TX_HAS_OWNER_DEDUPE_UNIQUE = null;

async function detectTransactionsUniqueOwnerDedupeHash() {
  if (TX_HAS_OWNER_DEDUPE_UNIQUE != null) return TX_HAS_OWNER_DEDUPE_UNIQUE;

  try {
    const r = await query(`
      select 1
      from pg_indexes
      where schemaname='public'
        and tablename='transactions'
        and indexname='transactions_owner_dedupe_hash_uq'
      limit 1
    `);
    TX_HAS_OWNER_DEDUPE_UNIQUE = !!r?.rows?.length;
  } catch {
    TX_HAS_OWNER_DEDUPE_UNIQUE = false;
  }
  return TX_HAS_OWNER_DEDUPE_UNIQUE;
}

// R4c-migrate (2026-04-24): getActorMemory + patchActorMemory removed.
// Replacement: services/conversationState.js (getSessionStateSafe,
// patchSessionStateSafe, appendMessageSafe, getRecentMessagesSafe) writing to
// the rebuild's conversation_sessions + conversation_messages per §3.10.
// Pre-rebuild table public.chief_actor_memory is DISCARDed at cutover.

// --- Job Picker Pending State (owner-scoped, pickUserId-scoped) ---
//
// STUBBED — confirm_flow_pending + confirm_flows are DROPPED post-rebuild.
// Replacement model is pending_actions (jsonb payload, no soft-mark) +
// cil_drafts (replaces confirm_flows for staged-payload mutation). Full
// rewrite is filed as P1 in POST_CUTOVER_PUNCHLIST.md.
//
// These 3 functions are reachable only from handlers/system/jobPickRouter.js
// via the legacy `jobpick::` text token path. Nothing in the active codebase
// sends that token (the live job picker uses HMAC-signed `jp:` row IDs in
// handlers/commands/expense.js with inline state, NOT these functions).
// So these stubs are dead-path under normal traffic; they exist purely for
// safety if a stale Twilio template ever delivers a `jobpick::` reply.
//
// Audit: 2026-04-27 cutover-integration-parity. Rewrite: P1 punchlist
// "Job-picker pending-state rewrite".

async function getPendingJobPick({ ownerId, pickUserId }) {
  console.warn(
    '[STUB] getPendingJobPick: confirm_flow_pending DROPPED post-rebuild. ' +
    'Job-picker pending state needs rewrite per P1 punchlist. Returning null.',
    { ownerId, pickUserId }
  );
  return null;
}

async function applyJobToPendingDraft({ ownerId, confirmFlowId, jobId }) {
  console.warn(
    '[STUB] applyJobToPendingDraft: confirm_flows DROPPED post-rebuild. ' +
    'Job-picker pending state needs rewrite per P1 punchlist. No-op.',
    { ownerId, confirmFlowId, jobId }
  );
}

async function clearPendingJobPick({ ownerId, confirmFlowId }) {
  console.warn(
    '[STUB] clearPendingJobPick: confirm_flow_pending DROPPED post-rebuild. ' +
    'Job-picker pending state needs rewrite per P1 punchlist. No-op.',
    { ownerId, confirmFlowId }
  );
}


// ------------------------------------------------------------------
// ✅ CIL Drafts (v1): store drafts before confirm; link to transactions
// ------------------------------------------------------------------

async function createCilDraft({
  owner_id,
  kind,
  payload,
  actor_user_id = null,
  actor_phone = null,
  occurred_on = null,
  amount_cents = null,
  source = null,
  description = null,
  job_id = null,
  job_name = null,
  category = null,
  source_msg_id = null,
  dedupe_hash = null,
  media_asset_id = null
} = {}, { timeoutMs = 4000 } = {}) {
  if (!owner_id) throw new Error('createCilDraft missing owner_id');
  if (!kind) throw new Error('createCilDraft missing kind');
  if (!payload) throw new Error('createCilDraft missing payload');

  const sql = `
    insert into public.cil_drafts (
      owner_id, kind, status, payload,
      actor_user_id, actor_phone,
      occurred_on, amount_cents, source, description,
      job_id, job_name, category,
      source_msg_id, dedupe_hash,
      media_asset_id,
      created_at, updated_at
    )
    values (
      $1, $2, 'draft', $3::jsonb,
      $4, $5,
      $6::date, $7::bigint, $8, $9,
      $10::uuid, $11, $12,
      $13, $14,
      $15::uuid,
      now(), now()
    )
    on conflict (owner_id, source_msg_id)
    where source_msg_id is not null
    do update set
      payload = excluded.payload,
      updated_at = now()
    returning id
  `;

  const params = [
    String(owner_id),
    String(kind),
    JSON.stringify(payload),
    actor_user_id ? String(actor_user_id) : null,
    actor_phone ? String(actor_phone) : null,
    occurred_on ? String(occurred_on) : null,
    amount_cents != null ? Number(amount_cents) : null,
    source != null ? String(source) : null,
    description != null ? String(description) : null,
    job_id ? String(job_id) : null,
    job_name != null ? String(job_name) : null,
    category != null ? String(category) : null,
    source_msg_id ? String(source_msg_id) : null,
    dedupe_hash ? String(dedupe_hash) : null,
    media_asset_id ? String(media_asset_id) : null
  ];

  const r = await queryWithTimeout(sql, params, timeoutMs);
  return { id: r?.rows?.[0]?.id ?? null };
}

async function confirmCilDraftBySourceMsg({
  owner_id,
  source_msg_id,
  confirmed_transaction_id
} = {}, { timeoutMs = 4000 } = {}) {
  if (!owner_id) throw new Error('confirmCilDraftBySourceMsg missing owner_id');
  if (!source_msg_id) throw new Error('confirmCilDraftBySourceMsg missing source_msg_id');
  if (!confirmed_transaction_id) throw new Error('confirmCilDraftBySourceMsg missing confirmed_transaction_id');

  const sql = `
    update public.cil_drafts
    set
      status = 'confirmed',
      confirmed_transaction_id = $3,
      updated_at = now()
    where owner_id::text = $1
      and source_msg_id = $2
    returning id
  `;

  const r = await queryWithTimeout(
    sql,
    [String(owner_id), String(source_msg_id), Number(confirmed_transaction_id)],
    timeoutMs
  );

  return { updated: (r?.rows?.length || 0) > 0, id: r?.rows?.[0]?.id ?? null };
}

// ✅ Cancel a draft by source message id (best-effort)
async function cancelCilDraftBySourceMsg(
  { owner_id, source_msg_id, status = 'cancelled' } = {},
  { timeoutMs = 4000 } = {}
) {
  const ownerKey = String(owner_id || '').trim();
  const src = String(source_msg_id || '').trim();
  if (!ownerKey || !src) return { ok: false, reason: 'missing_owner_or_source' };

  const sql = `
    update public.cil_drafts
       set status = $3,
           updated_at = now()
     where owner_id::text = $1
       and source_msg_id = $2
       and status = 'draft'
     returning id, status, source_msg_id
  `;

  const r = await queryWithTimeout(sql, [ownerKey, src, String(status || 'cancelled')], timeoutMs);

  return { ok: true, cancelled: r?.rows?.length || 0, row: r?.rows?.[0] || null };
}

// ✅ Expire old drafts (so PA TTL expiration doesn't leave zombies)
async function expireOldCilDrafts(
  owner_id,
  { maxAgeMinutes = 360 } = {},
  { timeoutMs = 4000 } = {}
) {
  const ownerKey = String(owner_id || '').trim();
  if (!ownerKey) return { ok: false, reason: 'missing_owner' };

  const mins = Number(maxAgeMinutes);
  const maxMins = Number.isFinite(mins) && mins > 0 ? Math.floor(mins) : 360;

  const sql = `
    update public.cil_drafts
       set status = 'expired',
           updated_at = now()
     where owner_id::text = $1
       and status = 'draft'
       and created_at < (now() - (($2::text || ' minutes')::interval))
     returning id
  `;

  const r = await queryWithTimeout(sql, [ownerKey, String(maxMins)], timeoutMs);
  return { ok: true, expired: r?.rows?.length || 0 };
}

async function countPendingCilDrafts(ownerId) {
  const ownerKey = String(ownerId || '').trim();
  if (!ownerKey) return 0;

  // ✅ best-effort cleanup (prevents PA TTL from leaving “draft” zombies)
  try {
    const ttlMins = Number(process.env.CIL_DRAFT_TTL_MINUTES) || 360;
    await expireOldCilDrafts(ownerKey, { maxAgeMinutes: ttlMins });
  } catch {}

  const sql = `
    select count(*)::int as n
    from public.cil_drafts
    where owner_id::text = $1
      and status = 'draft'
  `;

  const r = await queryWithTimeout(sql, [ownerKey], 2500);
  return Number(r?.rows?.[0]?.n) || 0;
}

// ✅ Cancel most-recent draft for this actor/owner (fallback when source_msg_id missing/mismatch)
async function cancelLatestCilDraftForActor({
  owner_id,
  actor_phone,
  kind = null,
  status = 'cancelled'
} = {}) {
  const ownerKey = String(owner_id || '').trim();
  const actorRaw = String(actor_phone || '').trim();
  const actorDigits = actorRaw.replace(/\D/g, '');
  if (!ownerKey || !actorDigits) return { ok: false, reason: 'missing_owner_or_actor' };

  const q = getDbQueryFn();

  const params = [ownerKey, actorDigits, String(status || 'cancelled')];
  let kindSql = '';
  if (kind) {
    kindSql = ' and kind = $4 ';
    params.push(String(kind));
  }

  const { rows } = await q(
    `
    update public.cil_drafts d
       set status = $3,
           updated_at = now()
     where d.id = (
       select id
         from public.cil_drafts
        where owner_id::text = $1
          and regexp_replace(coalesce(actor_phone,''), '\\D', '', 'g') = $2
          and status = 'draft'
          ${kindSql}
        order by created_at desc
        limit 1
     )
     returning id, status, source_msg_id, actor_phone, kind, created_at
    `,
    params
  );

  return { ok: true, cancelled: rows?.length || 0, row: rows?.[0] || null };
}

async function cancelAllCilDraftsForActor({ owner_id, actor_phone, kind = null, status = 'cancelled' } = {}) {
  const ownerId = String(owner_id || '').trim();
  const actorPhone = String(actor_phone || '').trim();
  const st = String(status || 'cancelled').trim();
  const k = kind ? String(kind).trim() : null;

  if (!ownerId) throw new Error('cancelAllCilDraftsForActor: owner_id is required');
  if (!actorPhone) throw new Error('cancelAllCilDraftsForActor: actor_phone is required');

  const q = module.exports.query || module.exports.pool?.query;
  if (!q) throw new Error('DB query not available');

  const { rows } = await q(
    `
    update public.cil_drafts
      set status = $3,
          updated_at = now()
    where owner_id::text = $1
      and actor_phone = $2
      and status = 'draft'
      and ($4::text is null or kind = $4)
    returning id, source_msg_id, kind, status, created_at, updated_at
    `,
    [ownerId, actorPhone, st, k]
  );

  return { ok: true, cancelled: rows.length, rows };
}



/**
 * ✅ insertTransaction()
 * Schema-aware insert into public.transactions with optional fields.
 *
 * HARD GUARANTEES:
 * - transactions.job_id is written ONLY when it matches the column type:
 *   - UUID string if job_id column is uuid
 *   - integer if job_id column is int/bigint
 *   - otherwise null
 * - media_asset_id is UUID or null only.
 */
async function insertTransaction(opts = {}, { timeoutMs = 4000 } = {}) {
  const owner = String(opts.ownerId ?? opts.owner_id ?? '').trim();
  const kind = String(opts.kind || '').trim();
  const date = String(opts.date || '').trim();
  const description = String(opts.description || '').trim() || 'Unknown';

  const amountCents = Number(opts.amount_cents ?? opts.amountCents ?? 0) || 0;
  const amountMaybe = opts.amount;

  let source = String(opts.source || '').trim() || 'Unknown';
  const sourceMsgId = String(opts.source_msg_id ?? opts.sourceMsgId ?? '').trim() || null;

  // ✅ Normalize + diagnose bad sources in ONE place (before dedupe + insert)
  const sourceRaw = source;
  source = normalizeVendorSource(source);

  const lcRaw = String(sourceRaw || '').trim().toLowerCase();
  if (lcRaw.startsWith('job ') || lcRaw === 'on' || lcRaw === 'off') {
    console.warn('[TXN_SOURCE_GARBAGE]', {
      kind,
      owner_id: owner,
      source_raw: sourceRaw,
      source_norm: source,
      description: String(description || '').slice(0, 80),
      source_msg_id: sourceMsgId
    });
  }

  const jobRef = opts.job == null ? null : String(opts.job).trim() || null;

  const jobNameInput =
    (opts.job_name ?? opts.jobName ?? opts.job_title ?? null) != null
      ? String(opts.job_name ?? opts.jobName ?? opts.job_title).trim()
      : null;

  const explicitJobId = opts.job_id ?? opts.jobId ?? null; // uuid OR int (schema-dependent)
  const explicitJobNo = opts.job_no ?? opts.jobNo ?? null; // number-like

  const category = opts.category == null ? null : String(opts.category).trim() || null;
  const userName = opts.user_name ?? opts.userName ?? null;

  // ✅ media asset id: UUID or null only
  const mediaAssetIdRaw = opts.media_asset_id ?? opts.mediaAssetId ?? opts.mediaAssetID ?? null;
  const mediaAssetId =
    mediaAssetIdRaw != null && looksLikeUuid(String(mediaAssetIdRaw).trim())
      ? String(mediaAssetIdRaw).trim()
      : null;

  if (mediaAssetIdRaw != null && !mediaAssetId) {
    console.warn('[PG/transactions] refusing non-uuid media_asset_id; ignoring', { mediaAssetIdRaw });
  }

  if (!owner) throw new Error('insertTransaction missing ownerId');
  if (!kind) throw new Error('insertTransaction missing kind');
  if (!date) throw new Error('insertTransaction missing date');
  if (!amountCents || amountCents <= 0) throw new Error('insertTransaction invalid amount_cents');

  // 🔐 Resolve capabilities
  const caps = await detectTransactionsCapabilities();

  // Determine transactions.job_id type (uuid vs int) once
  let jobIdType = null; // 'uuid' | 'int' | null
  if (caps.TX_HAS_JOB_ID) {
    try {
      const t = await getColumnTypeCached('public', 'transactions', 'job_id');
      const dt = String(t?.data_type || '').toLowerCase();
      const udt = String(t?.udt_name || '').toLowerCase();

      if (dt === 'uuid' || udt === 'uuid') jobIdType = 'uuid';
      else if (dt === 'integer' || dt === 'bigint' || udt === 'int4' || udt === 'int8') jobIdType = 'int';
      else jobIdType = null;
    } catch (e) {
      console.warn('[PG/transactions] job_id type detect failed:', e?.message);
      jobIdType = null;
    }
  }

  // helper: enforce job_id column type
  function coerceJobIdForColumn(idValue) {
    if (idValue == null) return null;

    if (jobIdType === 'uuid') {
      const s = String(idValue).trim();
      return looksLikeUuid(s) ? s : null;
    }

    if (jobIdType === 'int') {
      const n = Number(idValue);
      return Number.isFinite(n) ? Math.trunc(n) : null;
    }

    return null;
  }

  const media = normalizeMediaMeta(opts.mediaMeta || opts.media_meta || null);

  // 🔐 tenant_id (required by portal RLS insert policy when column exists)
  const tenantIdRaw = opts.tenant_id ?? opts.tenantId ?? null;
  let tenantId =
    tenantIdRaw != null && looksLikeUuid(String(tenantIdRaw).trim())
      ? String(tenantIdRaw).trim()
      : null;

  if (!tenantId && caps.TX_HAS_TENANT_ID) {
    try {
      tenantId = await resolveTenantIdForOwner(owner);
    } catch (e) {
      console.warn('[PG/transactions] resolveTenantIdForOwner failed:', e?.message);
    }
    if (!tenantId) throw new Error('insertTransaction missing tenant_id (required)');
  }

  // job resolution outputs
  let resolvedJobId = null; // uuid string OR int depending on schema
  let resolvedJobNo = null;
  let resolvedJobName =
    jobNameInput || (jobRef && !looksLikeUuid(jobRef) && !/^\d+$/.test(jobRef) ? jobRef : null);

  function isPoisonJobName(name) {
    const s = String(name || '').trim();
    if (!s) return false;
    const lc = s.toLowerCase();

    const tokenOrCommand =
      /^jobix_\d+$/i.test(lc) ||
      /^jobno_\d+$/i.test(lc) ||
      /^job_\d+_[0-9a-z]+$/i.test(lc) ||
      /^#\s*\d+\b/.test(lc) ||
      lc === 'cancel' ||
      lc === 'show active jobs' ||
      lc === 'active jobs' ||
      lc === 'change job' ||
      lc === 'switch job' ||
      lc === 'pick job' ||
      lc === 'more' ||
      lc === 'overhead';

    const errorish =
      lc.includes('should succeed') ||
      lc.includes('owner_id') ||
      lc.includes('missing owner') ||
      lc.includes('missing ownerid') ||
      lc.includes('assert') ||
      lc.includes('operator does not exist') ||
      lc.includes('require stack') ||
      lc.includes('stack') ||
      lc.includes('exception') ||
      lc.includes('error') ||
      lc.includes('failed') ||
      lc.includes('counter should stamp');

    const sentenceLike =
      lc.includes('$') ||
      /\b\d{4}-\d{2}-\d{2}\b/.test(lc) ||
      /\b(expense|revenue|paid|spent|bought|purchased|received|worth|from|at|today|yesterday|tomorrow)\b/.test(lc);

    return tokenOrCommand || errorish || sentenceLike;
  }

  if (resolvedJobName && isPoisonJobName(resolvedJobName)) {
    console.warn('[PG/transactions] dropping poison resolvedJobName', { resolvedJobName });
    resolvedJobName = null;
  }

  try {
    // 1) explicit job_id (schema-dependent)
    if (explicitJobId != null && String(explicitJobId).trim() !== '') {
      const coerced = coerceJobIdForColumn(explicitJobId);
      if (coerced != null) {
        resolvedJobId = coerced;

        // best-effort enrich
        const row = await resolveJobRow(owner, String(explicitJobId)).catch(() => null);
        if (row) {
          // if the row.id is better than what we coerced (rare), accept it
          const rowCoerced = coerceJobIdForColumn(row?.id);
          if (rowCoerced != null) resolvedJobId = rowCoerced;

          resolvedJobNo = row.job_no ?? resolvedJobNo ?? null;
          const nm = row.job_name ? String(row.job_name).trim() : null;
          if (nm && !isPoisonJobName(nm)) resolvedJobName = nm;
        }
      } else {
        console.warn('[PG/transactions] explicit job_id does not match column type; ignoring', {
          explicitJobId,
          jobIdType
        });
      }
    }

    // 2) explicit job_no
    if (resolvedJobId == null && explicitJobNo != null && String(explicitJobNo).trim() !== '') {
      const n = Number(explicitJobNo);
      if (Number.isFinite(n)) {
        resolvedJobNo = n;

        const row = await resolveJobRow(owner, String(n)).catch(() => null);
        if (row) {
          const rowCoerced = coerceJobIdForColumn(row?.id);
          if (rowCoerced != null) resolvedJobId = rowCoerced;

          resolvedJobNo = row.job_no ?? resolvedJobNo ?? null;
          const nm = row.job_name ? String(row.job_name).trim() : null;
          if (nm && !isPoisonJobName(nm)) resolvedJobName = nm;
        }
      }
    }

    // 3) jobRef (uuid/job_no/name)
    if (resolvedJobId == null && jobRef) {
      const row = await resolveJobRow(owner, jobRef).catch(() => null);
      if (row) {
        const rowCoerced = coerceJobIdForColumn(row?.id);
        if (rowCoerced != null) resolvedJobId = rowCoerced;

        resolvedJobNo = row.job_no ?? resolvedJobNo ?? null;
        const nm = row.job_name ? String(row.job_name).trim() : null;
        if (nm && !isPoisonJobName(nm)) resolvedJobName = nm;
      } else {
        // fallback: numeric ref -> treat as job_no
        if (/^\d+$/.test(String(jobRef).trim())) {
          const nn = Number(jobRef);
          if (Number.isFinite(nn)) resolvedJobNo = resolvedJobNo ?? nn;
        } else if (!resolvedJobName) {
          const nm = String(jobRef).trim();
          if (nm && !isPoisonJobName(nm)) resolvedJobName = nm;
        }
      }
    }

    // 4) resolve name-only
    if (resolvedJobId == null && resolvedJobName) {
      const row = await resolveJobRow(owner, resolvedJobName).catch(() => null);
      if (row) {
        const rowCoerced = coerceJobIdForColumn(row?.id);
        if (rowCoerced != null) resolvedJobId = rowCoerced;

        resolvedJobNo = row.job_no ?? resolvedJobNo ?? null;
        const nm = row.job_name ? String(row.job_name).trim() : null;
        if (nm && !isPoisonJobName(nm)) resolvedJobName = nm;
      }
    }
  } catch (e) {
    console.warn('[PG/transactions] job resolution failed (ignored):', e?.message);
  }

  // ✅ final hard-guard: enforce schema type (uuid vs int). Unknown => null.
  resolvedJobId = coerceJobIdForColumn(resolvedJobId);

  if (resolvedJobName && isPoisonJobName(resolvedJobName)) {
    console.warn('[PG/transactions] dropping poison resolvedJobName (post-resolve)', { resolvedJobName });
    resolvedJobName = null;
  }

  const jobNo = resolvedJobNo != null && Number.isFinite(Number(resolvedJobNo)) ? Number(resolvedJobNo) : null;
  const jobName = resolvedJobName ? String(resolvedJobName).trim() : null;

  const job =
    jobRef != null
      ? jobRef
      : jobName
        ? jobName
        : jobNo != null
          ? String(jobNo)
          : resolvedJobId != null
            ? String(resolvedJobId)
            : null;

  const shouldDedupeByContent = kind === 'expense' || kind === 'revenue';
  // Per-item inserts (source_msg_id ends with :i<N>) use source_msg_id for idempotency;
  // skip content-based dedupe_hash so soft-deleted rows don't block genuine re-submissions.
  const isPerItemInsert = typeof sourceMsgId === 'string' && /:i\d+$/.test(sourceMsgId);
  const dedupeHash =
    shouldDedupeByContent && !isPerItemInsert && typeof buildTxnDedupeHash === 'function'
      ? buildTxnDedupeHash({ owner, kind, date, amountCents, source, description, jobNo, jobName })
      : null;

  // idempotency pre-check (source_msg_id)
  if (caps.TX_HAS_SOURCE_MSG_ID && sourceMsgId) {
    try {
      const exists = await queryWithTimeout(
        `select id from public.transactions where owner_id=$1 and source_msg_id=$2 limit 1`,
        [owner, sourceMsgId],
        Math.min(2500, timeoutMs)
      );
      if (exists?.rows?.length) return { inserted: false, id: exists.rows[0].id };
    } catch (e) {
      console.warn('[PG/transactions] idempotency pre-check failed (ignored):', e?.message);
    }
  }

  const hasOwnerDedupeUnique = await detectTransactionsUniqueOwnerDedupeHash().catch(() => false);

  // Build insert cols/vals based on caps
  const cols = ['owner_id', 'kind', 'date', 'description', 'amount_cents', 'source'];
  const vals = [owner, kind, date, description, amountCents, source];

  if (caps.TX_HAS_TENANT_ID) {
    if (!tenantId) throw new Error('insertTransaction missing tenant_id (required)');
    cols.unshift('tenant_id');
    vals.unshift(tenantId);
  }

  if (caps.TX_HAS_AMOUNT && amountMaybe != null) {
    cols.push('amount');
    vals.push(amountMaybe);
  }

  if (caps.TX_HAS_JOB) {
    cols.push('job');
    vals.push(job);
  }
  if (caps.TX_HAS_JOB_NAME) {
    cols.push('job_name');
    vals.push(jobName);
  }
  if (caps.TX_HAS_JOB_NO) {
    cols.push('job_no');
    vals.push(jobNo);
  }
  if (caps.TX_HAS_JOB_ID) {
    cols.push('job_id');
    vals.push(resolvedJobId);
  }

  if (caps.TX_HAS_CATEGORY) {
    cols.push('category');
    vals.push(category);
  }

  if (caps.TX_HAS_USER_NAME) {
    cols.push('user_name');
    vals.push(userName);
  }

  if (caps.TX_HAS_SOURCE_MSG_ID) {
    cols.push('source_msg_id');
    vals.push(sourceMsgId);
  }

  if (caps.TX_HAS_DEDUPE_HASH && dedupeHash) {
    cols.push('dedupe_hash');
    vals.push(dedupeHash);
  }

  if (caps.TX_HAS_MEDIA_META && media) {
    cols.push('media_meta');
    vals.push(JSON.stringify(media));
  }

  if (caps.TX_HAS_MEDIA_ASSET_ID) {
    cols.push('media_asset_id');
    vals.push(mediaAssetId); // UUID or null only
  }

  // legacy discrete media cols if present (optional, safe)
  if (media) {
    if (caps.TX_HAS_MEDIA_URL) {
      cols.push('media_url');
      vals.push(media.media_url);
    }
    if (caps.TX_HAS_MEDIA_TYPE) {
      cols.push('media_type');
      vals.push(media.media_type);
    }
    if (caps.TX_HAS_MEDIA_TXT) {
      cols.push('media_transcript');
      vals.push(media.media_transcript);
    }
    if (caps.TX_HAS_MEDIA_CONF) {
      cols.push('media_confidence');
      vals.push(media.media_confidence);
    }
  }

  if (caps.TX_HAS_CREATED_AT) {
    cols.push('created_at');
    vals.push(new Date());
  }
  if (caps.TX_HAS_UPDATED_AT) {
    cols.push('updated_at');
    vals.push(new Date());
  }

  if (caps.TX_HAS_SUBTOTAL_AMOUNT && opts.subtotal_amount != null) {
    const v = Number(opts.subtotal_amount);
    if (Number.isFinite(v)) { cols.push('subtotal_amount'); vals.push(v); }
  }
  if (caps.TX_HAS_TAX_AMOUNT && opts.tax_amount != null) {
    const v = Number(opts.tax_amount);
    if (Number.isFinite(v)) { cols.push('tax_amount'); vals.push(v); }
  }
  if (caps.TX_HAS_TAX_LABEL && opts.tax_label != null) {
    const v = String(opts.tax_label).trim();
    if (v) { cols.push('tax_label'); vals.push(v); }
  }

  let conflictSql = '';

  if (caps.TX_HAS_DEDUPE_HASH && dedupeHash && hasOwnerDedupeUnique) {
    conflictSql = ' on conflict (owner_id, dedupe_hash) where dedupe_hash is not null do nothing ';
  }

  if (!conflictSql && caps.TX_HAS_SOURCE_MSG_ID && sourceMsgId) {
    const hasUq = await detectTransactionsUniqueOwnerSourceMsg().catch(() => false);
    if (hasUq) {
      conflictSql = ' on conflict (owner_id, source_msg_id) where source_msg_id is not null do nothing ';
    }
  }

  // Snapshot the pre-hash record state for hash input computation (tenant_id required)
  const hashableRecord = {
    owner_id: owner,
    tenant_id: tenantId,
    kind,
    amount_cents: amountCents,
    description,
    source,
    source_msg_id: sourceMsgId,
    job_id: resolvedJobId,
    created_at: new Date().toISOString(),
  };

  try {
    // ─── Execute INSERT inside an explicit DB transaction ──────────────────────
    // This ensures the hash chain previous_hash lookup and the INSERT are atomic,
    // preventing concurrent writes from corrupting the chain (FOR UPDATE SKIP LOCKED).
    const r = await withClient(async (client) => {
      await client.query(`SET LOCAL statement_timeout = '${timeoutMs}ms'`);

      // Append hash columns when schema supports them
      const insertCols = [...cols];
      const insertVals = [...vals];

      if (caps.TX_HAS_RECORD_HASH && tenantId) {
        try {
          const hashData = await integrity.generateHashData(hashableRecord, 'transactions', client);
          insertCols.push('record_hash', 'previous_hash', 'hash_version', 'hash_input_snapshot');
          insertVals.push(
            hashData.record_hash,
            hashData.previous_hash,
            hashData.hash_version,
            JSON.stringify(hashData.hash_input_snapshot)
          );
        } catch (hashErr) {
          // Hash generation failure is non-fatal — write the record without hash
          // (backfill script can recover it later)
          console.warn('[integrity] hash generation failed (record written without hash):', hashErr.message);
        }
      }

      const placeholders = insertCols.map((_, i) => `$${i + 1}`).join(', ');
      const sql = `
        insert into public.transactions (${insertCols.join(', ')})
        values (${placeholders})
        ${conflictSql}
        returning id
      `;

      return client.query(sql, insertVals);
    }, { useTransaction: true });

    const id = r?.rows?.[0]?.id ?? null;

    console.info('[TX_WRITE_JOB]', {
      owner_id: owner,
      kind,
      job_id: resolvedJobId ?? null,
      job_no: jobNo ?? null
    });

    if (id) return { inserted: true, id };

    // conflictSql DO NOTHING can yield no RETURNING row; try to recover id
    if (caps.TX_HAS_SOURCE_MSG_ID && sourceMsgId) {
      try {
        const ex = await queryWithTimeout(
          `select id from public.transactions where owner_id=$1 and source_msg_id=$2 limit 1`,
          [owner, sourceMsgId],
          Math.min(2500, timeoutMs)
        );
        if (ex?.rows?.length) return { inserted: false, id: ex.rows[0].id };
      } catch {}
    }

    if (caps.TX_HAS_DEDUPE_HASH && dedupeHash) {
      try {
        const ex2 = await queryWithTimeout(
          `select id from public.transactions where owner_id=$1 and dedupe_hash=$2 limit 1`,
          [owner, dedupeHash],
          Math.min(2500, timeoutMs)
        );
        if (ex2?.rows?.length) return { inserted: false, id: ex2.rows[0].id };
      } catch {}
    }

    return { inserted: false, id: null };
  } catch (e) {
    const code = String(e?.code || '');
    if (code === '23505') {
      console.warn('[PG/transactions] insert conflict treated as duplicate:', e?.message);

      // best-effort recover id
      if (caps.TX_HAS_SOURCE_MSG_ID && sourceMsgId) {
        try {
          const ex = await queryWithTimeout(
            `select id from public.transactions where owner_id=$1 and source_msg_id=$2 limit 1`,
            [owner, sourceMsgId],
            Math.min(2500, timeoutMs)
          );
          if (ex?.rows?.length) return { inserted: false, id: ex.rows[0].id };
        } catch {}
      }
      if (caps.TX_HAS_DEDUPE_HASH && dedupeHash) {
        try {
          const ex2 = await queryWithTimeout(
            `select id from public.transactions where owner_id=$1 and dedupe_hash=$2 limit 1`,
            [owner, dedupeHash],
            Math.min(2500, timeoutMs)
          );
          if (ex2?.rows?.length) return { inserted: false, id: ex2.rows[0].id };
        } catch {}
      }

      return { inserted: false, id: null };
    }
    throw e;
  }
}

/* -------------------- Time helpers -------------------- */
// Post-rebuild: legacy public.time_entries table is DROPPED. Canonical is
// public.time_entries_v2. The functions below are stubbed pending rewrite —
// they were the WhatsApp-side legacy dual-write path that owner views used
// to read from. Owner-side reads now query time_entries_v2 directly; the
// dual-write was already a silent no-op in production (table didn't exist).
// Filed as P1: legacy-time_entries dual-write removal + caller migration.

async function getLatestTimeEvent(ownerId, employeeName) {
  console.warn(
    '[STUB] getLatestTimeEvent: public.time_entries DROPPED post-rebuild. ' +
    'Caller should read from public.time_entries_v2 directly. Returning null.',
    { ownerId, employeeName }
  );
  return null;
}

/* -------------------- JOB HELPERS -------------------- */
// ---------- Per-owner safe job_no allocator ----------
async function withOwnerAllocLock(owner, client) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [String(owner)]);
}

async function allocateNextJobNo(owner, client) {
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(job_no), 0) + 1 AS next_no
       FROM public.jobs
      WHERE owner_id = $1`,
    [String(owner)]
  );
  return Number(rows?.[0]?.next_no || 1);
}
// ---------- Per-tenant safe activity log_no allocator ----------
async function withTenantAllocLock(tenantId, client) {
  // tenantId is uuid; use advisory lock scoped to this tenant
  // hashtext(text) gives stable int32; advisory lock expects bigint but PG coerces fine.
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [String(tenantId)]);
}

/**
 * Allocate the next integer for (tenantId, counterKind). Atomic UPSERT.
 * Returns the allocated integer (1-based; first call for a pair returns 1).
 *
 * Used by new-idiom CIL handlers for per-tenant per-kind sequence numbers
 * (quote human_ids, invoice numbers, etc.). See docs/QUOTES_SPINE_DECISIONS.md
 * §17.13 (strategy) and §18 (Migration 5).
 *
 * counterKind must be a member of COUNTER_KINDS (src/cil/counterKinds.js).
 * The DB-side format CHECK accepts any lowercase-snake_case string; the
 * product-concept set is policed app-side.
 */
async function allocateNextDocCounter(tenantId, counterKind, client) {
  const tid = String(tenantId || "").trim();
  const kind = String(counterKind || "").trim();
  if (!tid) throw new Error("Missing tenantId for allocateNextDocCounter");
  if (!kind) throw new Error("Missing counterKind for allocateNextDocCounter");

  // Atomic upsert: allocate current value, then advance counter.
  // If row doesn't exist, start at 1 and advance to 2.
  const r = await client.query(
    `
    insert into public.chiefos_tenant_counters (tenant_id, counter_kind, next_no, updated_at)
    values ($1, $2, 2, now())
    on conflict (tenant_id, counter_kind)
    do update
      set next_no = public.chiefos_tenant_counters.next_no + 1,
          updated_at = now()
    returning
      case
        when xmax = 0 then 1                         -- inserted path allocates 1
        else (public.chiefos_tenant_counters.next_no - 1) -- update path allocates previous
      end as allocated_no
    `,
    [tid, kind]
  );

  const n = r?.rows?.[0]?.allocated_no;
  if (!Number.isFinite(Number(n))) throw new Error("Failed to allocate doc counter");
  return Number(n);
}

// Find or create a job by name (case-insensitive on name or job_name).
async function ensureJobByName(ownerId, name) {
  // ✅ Jobs table appears legacy-keyed by digits (varchar(20) + FK to users.user_id)
  const owner = ownerDigitsOrNull(ownerId);
  const jobNameRaw = String(name || "").trim();

  // Fail closed if we can't produce the legacy owner key
  if (!owner || !jobNameRaw) return null;

  const jobName = jobNameRaw.replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
  const lc = jobName.toLowerCase();

  // ✅ HARD GUARDRAIL: refuse poison names (tokens / commands / error/debug strings)
  const looksLikeTokenGarbage =
    /^jobix_\d+$/i.test(lc) ||
    /^jobno_\d+$/i.test(lc) ||
    /^job_\d+_[0-9a-z]+$/i.test(lc) ||
    /^#\s*\d+\b/.test(lc) ||
    lc === "cancel" ||
    lc === "show active jobs" ||
    lc === "active jobs" ||
    lc === "change job" ||
    lc === "switch job" ||
    lc === "pick job" ||
    lc === "more" ||
    lc === "overhead";

  const looksLikeErrorText =
    lc.includes("should succeed") ||
    lc.includes("owner_id") ||
    lc.includes("missing owner") ||
    lc.includes("missing ownerid") ||
    lc.includes("assert") ||
    lc.includes("operator does not exist") ||
    lc.includes("require stack") ||
    lc.includes("stack") ||
    lc.includes("exception") ||
    lc.includes("error") ||
    lc.includes("failed") ||
    lc.includes("counter should stamp");

  // Extra: looks like an expense sentence, not a job name
  const looksLikeSentence =
    lc.includes("$") ||
    /\b\d{4}-\d{2}-\d{2}\b/.test(lc) ||
    /\b(expense|revenue|paid|spent|bought|purchased|received|worth|from|at|today|yesterday|tomorrow)\b/.test(lc);

  if (looksLikeTokenGarbage || looksLikeErrorText || looksLikeSentence) {
    console.warn("[PG/ensureJobByName] refusing poison job name", { jobName });
    return null;
  }

  // Existing: find first
  let r = await query(
    `SELECT id, job_no, COALESCE(name, job_name) AS name, active AS is_active
       FROM public.jobs
      WHERE owner_id = $1
        AND (lower(name) = lower($2) OR lower(job_name) = lower($2))
      LIMIT 1`,
    [owner, jobName]
  );
  if (r.rowCount) return r.rows[0];

  // Existing: create under allocation lock
  return await withClient(async (client) => {
    await withOwnerAllocLock(owner, client);

    const again = await client.query(
      `SELECT id, job_no, COALESCE(name, job_name) AS name, active AS is_active
         FROM public.jobs
        WHERE owner_id = $1
          AND (lower(name) = lower($2) OR lower(job_name) = lower($2))
        LIMIT 1`,
      [owner, jobName]
    );
    if (again.rowCount) return again.rows[0];

    const nextNo = await allocateNextJobNo(owner, client);

    try {
      const ins = await client.query(
        `INSERT INTO public.jobs (owner_id, job_no, job_name, name, active, start_date, created_at, updated_at)
         VALUES ($1, $2, $3, $4, true, NOW(), NOW(), NOW())
         RETURNING id, job_no, COALESCE(name, job_name) AS name, active AS is_active`,
        [owner, nextNo, jobName, jobName]
      );
      return ins.rows[0];
    } catch (e) {
      if (e && e.code === "23505") {
        const final = await client.query(
          `SELECT id, job_no, COALESCE(name, job_name) AS name, active AS is_active
             FROM public.jobs
            WHERE owner_id = $1
              AND (lower(name) = lower($2) OR lower(job_name) = lower($2))
            LIMIT 1`,
          [owner, jobName]
        );
        if (final.rowCount) return final.rows[0];
      }
      throw e;
    }
  });
}

async function resolveJobContext(ownerId, { explicitJobName, require = false, fallbackName } = {}) {
  const owner = DIGITS(ownerId);
  if (explicitJobName) {
    const j = await ensureJobByName(owner, explicitJobName);
    if (j) return j;
  }
  const act = await query(
    `SELECT id, job_no, COALESCE(name, job_name) AS name
       FROM public.jobs
      WHERE owner_id=$1 AND active=true
      ORDER BY updated_at DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [owner]
  );
  if (act.rowCount) return act.rows[0];
  if (fallbackName) {
    const j = await ensureJobByName(owner, fallbackName);
    if (j) return j;
  }
  if (require) throw new Error('No active job');
  return null;
}

async function insertFactEvent(e) {
  const owner_id = String(e?.owner_id || '').trim();
  const actor_key = String(e?.actor_key || '').trim();
  const event_type = String(e?.event_type || '').trim();
  const entity_type = String(e?.entity_type || '').trim();
  const dedupe_key = String(e?.dedupe_key || '').trim();

  if (!owner_id || !actor_key || !event_type || !entity_type || !dedupe_key) {
    return { ok: false, error: 'missing required fields' };
  }

  // ✅ occurred_at hardening: never null, never Invalid Date
  const occurredAt =
    e?.occurred_at && !Number.isNaN(Date.parse(String(e.occurred_at)))
      ? new Date(e.occurred_at)
      : new Date();

  const row = {
    owner_id,
    actor_key,
    event_type,
    entity_type,
    entity_id: e?.entity_id != null ? String(e.entity_id) : null,
    entity_no: e?.entity_no != null ? Number(e.entity_no) : null,

    job_id: e?.job_id != null ? String(e.job_id) : null,
    job_no: e?.job_no != null ? Number(e.job_no) : null,
    job_name: e?.job_name != null ? String(e.job_name) : null,
    job_source: e?.job_source != null ? String(e.job_source) : null,

    amount_cents: e?.amount_cents != null ? Number(e.amount_cents) : null,
    currency: e?.currency != null ? String(e.currency) : null,

    occurred_at: occurredAt,

    source_msg_id: e?.source_msg_id != null ? String(e.source_msg_id) : null,
    source_kind: e?.source_kind != null ? String(e.source_kind) : null,
    source_payload: e?.source_payload || null,
    event_payload: e?.event_payload || null,

    dedupe_key
  };

  const q = `
    insert into public.fact_events (
      owner_id, actor_key, event_type, entity_type,
      entity_id, entity_no,
      job_id, job_no, job_name, job_source,
      amount_cents, currency,
      occurred_at,
      source_msg_id, source_kind,
      source_payload, event_payload,
      dedupe_key
    ) values (
      $1,$2,$3,$4,
      $5,$6,
      $7,$8,$9,$10,
      $11,$12,
      $13,
      $14,$15,
      $16::jsonb,$17::jsonb,
      $18
    )
    on conflict (owner_id, dedupe_key) do nothing
    returning id
  `;

  try {
    const r = await query(q, [
      row.owner_id, row.actor_key, row.event_type, row.entity_type,
      row.entity_id, row.entity_no,
      row.job_id, row.job_no, row.job_name, row.job_source,
      row.amount_cents, row.currency,
      row.occurred_at,
      row.source_msg_id, row.source_kind,
      row.source_payload ? JSON.stringify(row.source_payload) : null,
      row.event_payload ? JSON.stringify(row.event_payload) : null,
      row.dedupe_key
    ]);

    const inserted = !!(r?.rows?.[0]?.id);
    return { ok: true, inserted, id: inserted ? r.rows[0].id : null };
  } catch (e2) {
    return { ok: false, error: e2?.message || 'db error' };
  }
}

async function getCashflowDaily({ ownerId, days = 30 }) {
  const owner_id = String(ownerId || '').trim();
  const limDays = Math.max(1, Math.min(365, Number(days) || 30));

  if (!owner_id) return { ok: false, error: 'missing ownerId' };

  const q = `
    select day, revenue_cents, expense_cents, net_cents
    from public.v_cashflow_daily
    where owner_id = $1
      and day >= (now() - ($2::text || ' days')::interval)
    order by day asc
  `;

  try {
    const r = await query(q, [owner_id, String(limDays)]);
    return { ok: true, rows: r.rows || [] };
  } catch (e) {
    return { ok: false, error: e?.message || 'db error' };
  }
}

async function getJobProfitSimple({ ownerId, jobNo = null, limit = 20 }) {
  const owner_id = String(ownerId || '').trim();
  const lim = Math.max(1, Math.min(200, Number(limit) || 20));

  if (!owner_id) return { ok: false, error: 'missing ownerId' };

  const q = jobNo != null
    ? `
      select
        job_no,
        job_name,
        revenue_cents,
        expense_cents,
        profit_cents
      from public.v_job_profit_simple_fixed
      where owner_id::text = $1
        and job_no = $2
      limit 1
    `
    : `
      select
        job_no,
        job_name,
        revenue_cents,
        expense_cents,
        profit_cents
      from public.v_job_profit_simple_fixed
      where owner_id::text = $1
      order by profit_cents desc nulls last
      limit $2
    `;

  try {
    const args = jobNo != null ? [owner_id, Number(jobNo)] : [owner_id, lim];
    const r = await query(q, args);
    return { ok: true, rows: r.rows || [] };
  } catch (e) {
    return { ok: false, error: e?.message || 'db error' };
  }
}




async function getLatestFacts({ ownerId, limit = 20, types = [] }) {
  const owner_id = String(ownerId || '').trim();
  const lim = Math.max(1, Math.min(200, Number(limit) || 20));
  if (!owner_id) return { ok: false, error: 'missing ownerId' };

  const typeList = Array.isArray(types) ? types.filter(Boolean).map(String) : [];
  const hasTypes = typeList.length > 0;

  const q = hasTypes
    ? `
      select recorded_at, occurred_at, event_type, entity_type, entity_id, entity_no,
             job_no, job_name, amount_cents, currency, event_payload
      from public.fact_events
      where owner_id = $1
        and event_type = any($2::text[])
      order by recorded_at desc
      limit $3
    `
    : `
      select recorded_at, occurred_at, event_type, entity_type, entity_id, entity_no,
             job_no, job_name, amount_cents, currency, event_payload
      from public.fact_events
      where owner_id = $1
      order by recorded_at desc
      limit $2
    `;

  try {
    const args = hasTypes ? [owner_id, typeList, lim] : [owner_id, lim];
    const r = await query(q, args);
    return { ok: true, rows: r.rows || [] };
  } catch (e) {
    return { ok: false, error: e?.message || 'db error' };
  }
}




/**
 * ✅ createJobIdempotent (CANONICAL)
 * - Owner IDs may be numeric OR UUID/text — do NOT DIGITS() here.
 * - Idempotency checks happen BEFORE cap (duplicates never blocked).
 * - Plan-based job cap enforced inside owner allocation lock (serial).
 * - Membership gating removed (recommended) — keep your codebase single-source for plan truth.
 */
async function createJobIdempotent({
  ownerId,
  jobName,
  name,
  sourceMsgId,
  status = 'open',
  active = true
} = {}) {
  const owner = String(ownerId || '').trim();
  const cleanName = String(jobName || name || '').trim() || 'Untitled Job';
  const msgId = String(sourceMsgId || '').trim() || null;

  if (!owner) throw new Error('Missing ownerId');

  return await withClient(async (client) => {
    await withOwnerAllocLock(owner, client);

    // ---------------------------------------------------------
    // 1) Idempotency by sourceMsgId (if present) — FIRST
    // ---------------------------------------------------------
    if (msgId) {
      const existing = await client.query(
        `SELECT id, owner_id, job_no,
                COALESCE(job_name, name) AS job_name,
                name, active, status, source_msg_id
           FROM public.jobs
          WHERE owner_id = $1 AND source_msg_id = $2
          LIMIT 1`,
        [owner, msgId]
      );
      if (existing.rowCount) return { inserted: false, job: existing.rows[0], reason: 'duplicate_message' };
    }

    // ---------------------------------------------------------
    // 2) Idempotency by name — SECOND
    // ---------------------------------------------------------
    const existingByName = await client.query(
      `SELECT id, owner_id, job_no,
              COALESCE(job_name, name) AS job_name,
              name, active, status, source_msg_id
         FROM public.jobs
        WHERE owner_id = $1 AND lower(COALESCE(job_name, name)) = lower($2)
        LIMIT 1`,
      [owner, cleanName]
    );
    if (existingByName.rowCount) return { inserted: false, job: existingByName.rows[0], reason: 'already_exists' };

// ---------------------------------------------------------
// 3) DB-level job cap (planCapabilities source of truth) — THIRD
// Fail-open on unexpected DB issues.
// ---------------------------------------------------------
try {
  const { plan_capabilities } = require('../src/config/planCapabilities'); // ✅ correct relative path

  const planRow = await client.query(
    `select plan_key, sub_status
       from public.users
      where user_id = $1
      limit 1`,
    [owner]
  );

  const effective = getEffectivePlanKey(planRow?.rows?.[0] || null);

  const caps = plan_capabilities?.[effective] || plan_capabilities?.free || null;
  const maxJobs = caps?.jobs?.max_jobs_total ?? null; // null => unlimited

  if (maxJobs != null && Number.isFinite(Number(maxJobs))) {
    const c = await client.query(
      `select count(*)::int as n
         from public.jobs
        where owner_id=$1
          and (status is null or status in ('open','active','draft'))`,
      [owner]
    );

    const n = c.rows?.[0]?.n ?? 0;

    if (Number.isFinite(n) && n >= Number(maxJobs)) {
      return {
        inserted: false,
        job: null,
        reason: 'job_limit_reached',
        error: `Job limit reached for your plan (${maxJobs}).`
      };
    }
  }
} catch (e) {
  // ✅ fail-open
  // console.warn('[DB_JOB_CAP] fail-open:', e?.message);
}

    // ---------------------------------------------------------
    // 4) Create
    // ---------------------------------------------------------
    const nextNo = await allocateNextJobNo(owner, client);

    try {
      const ins = await client.query(
        `INSERT INTO public.jobs
           (owner_id, job_no, job_name, name, status, active, start_date, created_at, updated_at, source_msg_id)
         VALUES
           ($1, $2, $3, $4, $5, $6, NOW(), NOW(), NOW(), $7)
         RETURNING id, owner_id, job_no,
                   COALESCE(job_name, name) AS job_name,
                   name, active, status, source_msg_id`,
        [
          owner,
          nextNo,
          cleanName, // $3 -> job_name
          cleanName, // $4 -> name (separate param fixes type inference)
          String(status || 'open'),
          !!active,
          msgId
        ]
      );
      return { inserted: true, job: ins.rows[0], reason: 'created' };
    } catch (e) {
      // handle unique collisions gracefully
      if (e && e.code === '23505' && msgId) {
        const existing = await client.query(
          `SELECT id, owner_id, job_no,
                  COALESCE(job_name, name) AS job_name,
                  name, active, status, source_msg_id
             FROM public.jobs
            WHERE owner_id = $1 AND source_msg_id = $2
            LIMIT 1`,
          [owner, msgId]
        );
        if (existing.rowCount) return { inserted: false, job: existing.rows[0], reason: 'duplicate_message' };
      }

      if (e && e.code === '23505') {
        const byName = await client.query(
          `SELECT id, owner_id, job_no,
                  COALESCE(job_name, name) AS job_name,
                  name, active, status, source_msg_id
             FROM public.jobs
            WHERE owner_id = $1 AND lower(COALESCE(job_name, name)) = lower($2)
            LIMIT 1`,
          [owner, cleanName]
        );
        if (byName.rowCount) return { inserted: false, job: byName.rows[0], reason: 'already_exists' };
      }

      throw e;
    }
  });
}


// Upsert a job by name, deactivate others, and activate this one
async function activateJobByName(ownerId, rawName) {
  const owner = ownerDigitsOrNull(ownerId);
if (!owner) throw new Error("Missing ownerId (digits) for jobs subsystem");
  const name = String(rawName || "").trim();
  if (!name) throw new Error("Missing job name");

  const j = await ensureJobByName(owner, name); // ensureJobByName must also accept owner as text
  const jobNo = j?.job_no;
  if (!jobNo) throw new Error("Failed to create/resolve job");

  await withClient(async (client) => {
    await client.query(
      `UPDATE public.jobs
         SET active=false, updated_at=NOW()
       WHERE owner_id=$1 AND active=true AND job_no<>$2`,
      [owner, jobNo]
    );
    await client.query(
      `UPDATE public.jobs
         SET active=true, updated_at=NOW(),
             name=COALESCE(name, $3), job_name=COALESCE(job_name, $3)
       WHERE owner_id=$1 AND job_no=$2`,
      [owner, jobNo, name]
    );
  });

  const { rows } = await query(
    `SELECT id, job_no, COALESCE(name, job_name) AS name, active, updated_at
       FROM public.jobs
      WHERE owner_id=$1 AND job_no=$2
      LIMIT 1`,
    [owner, jobNo]
  );

  return rows[0] || { id: j?.id || null, job_no: jobNo, name, active: true };
}

// ─────────────────────────────────────────────────────────────────────────
// getActiveJob / setActiveJob — STUBBED (compat shape preserved)
// Both functions read/wrote a mix of DROPPED schema:
//   - user_active_job table (DROPPED post-rebuild)
//   - jobs.active boolean column (DROPPED; rebuild uses jobs.status enum)
// Canonical replacement is users.auto_assign_active_job_id (integer FK to
// jobs.id) — but the rewrite needs caller audit + job_no→jobs.id resolution.
// Filed as P1 in POST_CUTOVER_PUNCHLIST.md ("Active-job-memory rewrite").
// Audit: 2026-04-27 cutover-integration-parity.
// ─────────────────────────────────────────────────────────────────────────

async function getActiveJob(ownerId, userId = null) {
  console.warn(
    '[STUB] getActiveJob: user_active_job table DROPPED post-rebuild + ' +
    'jobs.active column DROPPED. Active-job memory needs rewrite to use ' +
    'users.auto_assign_active_job_id per P1 punchlist. Returning null.',
    { ownerId, userId }
  );
  return null;
}

async function setActiveJob(ownerId, userId, jobRef) {
  console.warn(
    '[STUB] setActiveJob: user_active_job table DROPPED post-rebuild + ' +
    'jobs.active column DROPPED. Active-job memory needs rewrite to use ' +
    'users.auto_assign_active_job_id per P1 punchlist. Returning false.',
    { ownerId, userId, jobRef }
  );
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// Active-job detection helpers DELETED post-rebuild.
//
// detectActiveJobCaps / detectActiveJobIdColumnTypes / coerceActiveJobIdValue
// were built for the multi-schema-detection era (users.active_job_id /
// memberships.active_job_id / user_profiles.active_job_id /
// user_active_job.job_id with uuid-vs-int-vs-text type variations). The
// rebuild collapsed all of these onto a single canonical column:
//   public.users.auto_assign_active_job_id (integer NULL FK to jobs.id)
//
// Active-job get/set is stubbed pending rewrite to use that column directly.
// See P1 punchlist "Active-job-memory rewrite". No callers remain.
// ─────────────────────────────────────────────────────────────────────────

async function resolveJobIdAndName(ownerId, jobId, jobName) {
  const owner = DIGITS(ownerId);
  let id = jobId ? String(jobId).trim() : null;
  let name = jobName ? String(jobName).trim() : null;
  let jobNo = null;

  // if jobName provided, resolve id from jobs (best-effort)
  if (!id && name) {
    try {
      const r = await query(
        `select id, job_no, coalesce(name, job_name) as job_name
           from public.jobs
          where owner_id=$1
            and lower(coalesce(name, job_name)) = lower($2)
          order by updated_at desc nulls last, created_at desc
          limit 1`,
        [owner, name]
      );
      if (r?.rows?.[0]) {
        id = r.rows[0].id ? String(r.rows[0].id) : null;
        jobNo = r.rows[0].job_no ?? null;
        name = r.rows[0].job_name ? String(r.rows[0].job_name).trim() : name;
      }
    } catch {}
  }

  // if id provided but no name, resolve name:
  // - if uuid: lookup by id::uuid (future schema)
  // - else if numeric: treat as job_no (today’s schema)
  if (id && !name) {
    const s = String(id).trim();
    try {
      if (looksLikeUuid(s)) {
        const r = await query(
          `select job_no, coalesce(name, job_name) as job_name
             from public.jobs
            where owner_id=$1 and id=$2::uuid
            limit 1`,
          [owner, s]
        );
        if (r?.rows?.[0]) {
          jobNo = r.rows[0].job_no ?? jobNo;
          if (r.rows[0].job_name) name = String(r.rows[0].job_name).trim();
        }
      } else if (/^\d+$/.test(s)) {
        const r = await query(
          `select job_no, coalesce(name, job_name) as job_name
             from public.jobs
            where owner_id=$1 and job_no=$2::int
            limit 1`,
          [owner, Number(s)]
        );
        if (r?.rows?.[0]) {
          jobNo = r.rows[0].job_no ?? jobNo;
          if (r.rows[0].job_name) name = String(r.rows[0].job_name).trim();
        }
      }
    } catch {}
  }

  // if neither id nor jobNo, but name exists, ensure a job row exists (optional, but helps)
  if (!id && jobNo == null && name) {
    // ✅ Guardrail: never create a job from error text / tokens / weird debug strings
    const nm = String(name || '').trim();
    const lc = nm.toLowerCase();

    const looksLikeErrorText =
      lc.includes('should succeed') ||
      lc.includes('owner_id') ||
      lc.includes('assert') ||
      lc.includes('missing owner') ||
      lc.includes('missing ownerid') ||
      lc.includes('error') ||
      lc.includes('failed') ||
      lc.includes('exception') ||
      lc.includes('stack') ||
      lc.includes('require stack') ||
      lc.includes('operator does not exist') ||
      lc.includes('counter should stamp now');

    const looksLikeTokenGarbage =
      /^jobix_\d+$/i.test(lc) ||
      /^jobno_\d+$/i.test(lc) ||
      /^job_\d+_[0-9a-z]+$/i.test(lc) ||
      /^#\s*\d+\b/.test(lc) ||
      lc === 'cancel' ||
      lc === 'show active jobs' ||
      lc === 'active jobs' ||
      lc === 'change job' ||
      lc === 'switch job' ||
      lc === 'pick job';

    if (!looksLikeErrorText && !looksLikeTokenGarbage) {
      try {
        const j = await ensureJobByName(owner, nm);
        if (j) {
          id = j.id ? String(j.id) : id;
          jobNo = j.job_no ?? jobNo;
          name = j.name ? String(j.name).trim() : nm;
        }
      } catch {}
    }
  }

  return { id, name, jobNo };
}

async function setActiveJobForIdentity(ownerId, userIdOrPhone, jobId, jobName) {
  console.warn(
    '[STUB] setActiveJobForIdentity: user_active_job + memberships + ' +
    'user_profiles + users.active_job_id all DROPPED post-rebuild. ' +
    'Active-job memory needs rewrite to use users.auto_assign_active_job_id ' +
    'per P1 punchlist. Returning unknown-source no-op shape.',
    { ownerId, userIdOrPhone, jobId, jobName }
  );
  return { active_job_id: null, active_job_name: null, source: 'unknown' };
}

async function getActiveJobForIdentity(ownerId, userIdOrPhone) {
  console.warn(
    '[STUB] getActiveJobForIdentity: user_active_job + memberships + ' +
    'user_profiles + users.active_job_id all DROPPED post-rebuild. ' +
    'Active-job memory needs rewrite to use users.auto_assign_active_job_id ' +
    'per P1 punchlist. Returning null.',
    { ownerId, userIdOrPhone }
  );
  return null;
}

/* -------------------- OTP / Users / Tasks / Exports / Pending Actions -------------------- */
// ---------- OTP ----------
async function generateOTP(userId) {
  const uid = DIGITS(userId);
  const otp = crypto.randomInt(100000, 1000000).toString();
  const expiry = new Date(Date.now() + 10 * 60 * 1000);
  await query(`UPDATE public.users SET otp=$1, otp_expiry=$2 WHERE user_id=$3`, [otp, expiry, uid]);
  return otp;
}

async function verifyOTP(userId, otp) {
  const uid = DIGITS(userId);
  const { rows } = await query(`SELECT otp, otp_expiry FROM public.users WHERE user_id=$1`, [uid]);
  const user = rows[0];
  const ok = !!user && user.otp === otp && new Date() <= new Date(user.otp_expiry);
  if (ok) await query(`UPDATE public.users SET otp=NULL, otp_expiry=NULL WHERE user_id=$1`, [uid]);
  return ok;
}

// ---------- Users ----------
async function createUserProfile({ user_id, ownerId, onboarding_in_progress = false }) {
  const uid = DIGITS(user_id);
  const oid = DIGITS(ownerId || uid);
  const token = crypto.randomBytes(16).toString('hex');

  const { rows } = await query(
    `INSERT INTO public.users (user_id, owner_id, onboarding_in_progress, dashboard_token, created_at)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (user_id) DO UPDATE SET onboarding_in_progress=EXCLUDED.onboarding_in_progress
     RETURNING *`,
    [uid, oid, onboarding_in_progress, token]
  );
  return rows[0];
}


const _SAVE_USER_PROFILE_ALLOWED_COLS = new Set([
  'user_id', 'owner_id', 'name', 'email', 'phone', 'phone_e164',
  'wa_id', 'timezone', 'tz', 'plan_key', 'subscription_tier', 'paid_tier',
  'sub_status', 'stripe_customer_id', 'stripe_subscription_id', 'stripe_price_id',
  'current_period_start', 'current_period_end', 'cancel_at_period_end',
  'onboarding_in_progress', 'dashboard_token', 'active_job_id', 'active_job_name',
  'otp', 'otp_expiry', 'created_at', 'updated_at'
]);

async function saveUserProfile(p) {
  const keys = Object.keys(p).filter((k) => _SAVE_USER_PROFILE_ALLOWED_COLS.has(k));
  if (!keys.length) throw new Error('saveUserProfile: no valid columns to save');

  const vals = keys.map((k) => p[k]);
  const insCols = keys.join(', ');
  const insVals = keys.map((_, i) => `$${i + 1}`).join(', ');
  const upd = keys
    .filter((k) => k !== 'user_id')
    .map((k) => `${k}=EXCLUDED.${k}`)
    .join(', ');
  const { rows } = await query(
    `INSERT INTO public.users (${insCols}) VALUES (${insVals})
     ON CONFLICT (user_id) DO UPDATE SET ${upd}
     RETURNING *`,
    vals
  );
  return rows[0];
}

async function getUserProfile(userId) {
  const { rows } = await query(`SELECT * FROM public.users WHERE user_id=$1`, [DIGITS(userId)]);
  return rows[0] || null;
}

async function getOwnerProfile(ownerId) {
  const { rows } = await query(`SELECT * FROM public.users WHERE user_id=$1`, [DIGITS(ownerId)]);
  return rows[0] || null;
}

// ---------- Tasks ----------
async function createTask({ ownerId, createdBy, assignedTo, title, body, type = 'general', dueAt, jobNo }) {
  const { rows } = await query(
    `INSERT INTO public.tasks
       (owner_id, created_by, assigned_to, title, body, type, due_at, job_no, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
     RETURNING *`,
    [
      DIGITS(ownerId),
      DIGITS(createdBy),
      assignedTo ? DIGITS(assignedTo) : null,
      title,
      body,
      type,
      dueAt,
      jobNo
    ]
  );
  return rows[0];
}

async function getTaskByNo(ownerId, taskNo) {
  const { rows } = await query(`SELECT * FROM public.tasks WHERE owner_id=$1 AND task_no=$2 LIMIT 1`, [
    DIGITS(ownerId),
    taskNo
  ]);
  return rows[0] || null;
}

async function createTaskWithJob(opts) {
  const job = await resolveJobContext(opts.ownerId, { explicitJobName: opts.jobName });
  opts.jobNo = job?.job_no || null;
  return await createTask(opts);
}

// ---------- V2 EXCEL EXPORT (lazy load) ----------
let ExcelJS_V2 = null;
async function exportTimesheetXlsxV2(opts) {
  if (!ExcelJS_V2) ExcelJS_V2 = require('exceljs');

  const { ownerId, startIso, endIso, tz = 'America/Toronto', filterUserIds = null } = opts;
  const owner = DIGITS(ownerId);

  const params = [owner, startIso, endIso];
  let whereUser = '';
  if (Array.isArray(filterUserIds) && filterUserIds.length) {
    params.push(filterUserIds);
    whereUser = ` AND te.user_id = ANY($4::text[]) `;
  }

  const { rows } = await queryWithTimeout(
    `
    SELECT te.user_id,
           te.start_at_utc,
           te.end_at_utc,
           COALESCE((te.meta->'calc'->>'paidMinutes')::int, 0) AS paid_minutes,
           COALESCE((te.meta->'calc'->>'driveTotal')::int, 0) AS drive_minutes,
           COALESCE(j.name, j.job_name, '') AS job_name
      FROM public.time_entries_v2 te
      LEFT JOIN public.jobs j
        ON j.owner_id = te.owner_id
       AND te.job_id IS NOT NULL
       AND j.id = te.job_id
     WHERE te.owner_id = $1
       AND te.kind = 'shift'
       AND te.deleted_at IS NULL
       AND te.end_at_utc IS NOT NULL
       AND te.start_at_utc >= $2::timestamptz
       AND te.start_at_utc <  $3::timestamptz
       ${whereUser}
     ORDER BY te.user_id, te.start_at_utc ASC
    `,
    params,
    15000
  );

  const wb = new ExcelJS_V2.Workbook();
  const ws = wb.addWorksheet('Timesheet');

  ws.columns = [
    { header: 'UserId', key: 'user_id' },
    { header: 'Start (UTC)', key: 'start_at_utc' },
    { header: 'End (UTC)', key: 'end_at_utc' },
    { header: 'Paid Minutes', key: 'paid_minutes' },
    { header: 'Drive Minutes', key: 'drive_minutes' },
    { header: 'Job', key: 'job_name' }
  ];

  (rows || []).forEach((r) => ws.addRow(r));

  const buf = await wb.xlsx.writeBuffer();
  const id = crypto.randomBytes(12).toString('hex');

  const suffix =
    Array.isArray(filterUserIds) && filterUserIds.length === 1 ? `_user_${String(filterUserIds[0])}` : '';
  const filename = `timesheet_v2_${startIso.slice(0, 10)}_${endIso.slice(0, 10)}${suffix}.xlsx`;

  await query(
    `INSERT INTO public.file_exports (id, owner_id, filename, content_type, bytes, created_at)
     VALUES ($1,$2,$3,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',$4,NOW())`,
    [id, owner, filename, Buffer.from(buf)]
  );

  const base = process.env.PUBLIC_BASE_URL || '';
  return { url: `${base}/exports/${id}`, id, filename };
}

// ---------- V2 PDF EXPORT (lazy load) ----------
let PDFDocument_V2 = null;
async function exportTimesheetPdfV2(opts) {
  if (!PDFDocument_V2) PDFDocument_V2 = require('pdfkit');

  const { ownerId, startIso, endIso, tz = 'America/Toronto', filterUserIds = null } = opts;
  const owner = DIGITS(ownerId);

  const params = [owner, startIso, endIso];
  let whereUser = '';
  if (Array.isArray(filterUserIds) && filterUserIds.length) {
    params.push(filterUserIds);
    whereUser = ` AND te.user_id = ANY($4::text[]) `;
  }

  const { rows } = await queryWithTimeout(
    `
    SELECT te.user_id,
           te.start_at_utc,
           te.end_at_utc,
           COALESCE((te.meta->'calc'->>'paidMinutes')::int, 0) AS paid_minutes,
           COALESCE((te.meta->'calc'->>'driveTotal')::int, 0) AS drive_minutes,
           COALESCE(j.name, j.job_name, '') AS job_name
      FROM public.time_entries_v2 te
      LEFT JOIN public.jobs j
        ON j.owner_id = te.owner_id
       AND te.job_id IS NOT NULL
       AND j.id = te.job_id
     WHERE te.owner_id = $1
       AND te.kind = 'shift'
       AND te.deleted_at IS NULL
       AND te.end_at_utc IS NOT NULL
       AND te.start_at_utc >= $2::timestamptz
       AND te.start_at_utc <  $3::timestamptz
       ${whereUser}
     ORDER BY te.user_id, te.start_at_utc ASC
    `,
    params,
    15000
  );

  const doc = new PDFDocument_V2({ margin: 40 });
  const chunks = [];
  doc.on('data', (d) => chunks.push(d));
  const done = new Promise((r) => doc.on('end', r));

  doc
    .fontSize(16)
    .text(`Timesheet (v2) ${startIso.slice(0, 10)} – ${endIso.slice(0, 10)}`, { align: 'center' })
    .moveDown();

  (rows || []).forEach((r) => {
    doc
      .fontSize(10)
      .text(
        `User ${r.user_id} | paid ${r.paid_minutes}m | drive ${r.drive_minutes}m | ${r.job_name || ''} | ${r.start_at_utc} → ${r.end_at_utc}`
      );
  });

  doc.end();
  await done;

  const buf = Buffer.concat(chunks);
  const id = crypto.randomBytes(12).toString('hex');

  const suffix =
    Array.isArray(filterUserIds) && filterUserIds.length === 1 ? `_user_${String(filterUserIds[0])}` : '';
  const filename = `timesheet_v2_${startIso.slice(0, 10)}_${endIso.slice(0, 10)}${suffix}.pdf`;

  await query(
    `INSERT INTO public.file_exports (id, owner_id, filename, content_type, bytes, created_at)
     VALUES ($1,$2,$3,'application/pdf',$4,NOW())`,
    [id, owner, filename, buf]
  );

  const base = process.env.PUBLIC_BASE_URL || '';
  return { url: `${base}/exports/${id}`, id, filename };
}


async function getFileExport(id) {
  const { rows } = await query(
    `SELECT filename, content_type, bytes
       FROM public.file_exports
      WHERE id = $1
      LIMIT 1`,
    [String(id)]
  );
  return rows[0] || null;
}

/* ---------- Pending actions ---------- */
const PENDING_TTL_MIN = 10;

async function savePendingAction({ ownerId, userId, kind, payload }) {
  const { rows } = await query(
    `insert into public.pending_actions (owner_id, user_id, kind, payload, created_at)
     values ($1,$2,$3,$4::jsonb, now())
     on conflict (owner_id, user_id, kind)
     do update set
       payload    = EXCLUDED.payload,
       created_at = now()
     returning id`,
    [DIGITS(ownerId), String(userId), String(kind), payload]
  );
  return rows[0]?.id;
}

async function getPendingAction({ ownerId, userId }) {
  const { rows } = await query(
    `select id, kind, payload, created_at
       from public.pending_actions
      where owner_id=$1 and user_id=$2
        and created_at > now() - (($3::text || ' minutes')::interval)
      order by created_at desc
      limit 1`,
    [String(ownerId).replace(/\D/g, ''), String(userId), String(PENDING_TTL_MIN)]
  );
  return rows[0] || null;
}

async function getPendingActionByKind({ ownerId, userId, kind }) {
  const owner = DIGITS(ownerId);
  const user = String(userId);
  const k = String(kind || '').trim();
  if (!owner || !user || !k) return null;

  const { rows } = await query(
    `
    SELECT id, kind, payload, created_at
      FROM public.pending_actions
     WHERE owner_id = $1
       AND user_id = $2
       AND kind = $3
       AND created_at > now() - (($4::text || ' minutes')::interval)
     ORDER BY created_at DESC
     LIMIT 1
    `,
    [owner, user, k, String(PENDING_TTL_MIN)]
  );

  return rows[0] || null;
}

async function deletePendingActionByKind({ ownerId, userId, kind }) {
  const owner = DIGITS(ownerId);
  const user = String(userId);
  const k = String(kind || '').trim();
  if (!owner || !user || !k) return;

  await query(
    `
    DELETE FROM public.pending_actions
     WHERE owner_id = $1
       AND user_id = $2
       AND kind = $3
    `,
    [owner, user, k]
  );
}

// ✅ SMART delete:
// - deletePendingAction(uuid) works
// - deletePendingAction({ ownerId, userId, kind }) also works (routes to deletePendingActionByKind)
// - deletePendingAction(pendingRow) also works (uses .id or .owner_id + .user_id + .kind)
async function deletePendingAction(arg) {
  const looksUuid = (s) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s || '').trim());

  // 1) If passed an id string, delete by id
  if (typeof arg === 'string' || typeof arg === 'number') {
    const id = String(arg).trim();
    if (looksUuid(id)) {
      await query(`delete from public.pending_actions where id=$1`, [id]);
      return;
    }
    console.warn('[pending_actions] deletePendingAction received non-uuid id (ignored):', id);
    return;
  }

  // 2) If passed an object: try delete by kind OR by embedded id
  if (arg && typeof arg === 'object') {
    const id = arg.id || arg.pending_id || null;
    if (id && looksUuid(id)) {
      await query(`delete from public.pending_actions where id=$1`, [String(id)]);
      return;
    }

    const ownerId = arg.ownerId ?? arg.owner_id ?? null;
    const userId = arg.userId ?? arg.user_id ?? null;
    const kind = arg.kind ?? null;

    if (ownerId && userId && kind) {
      await deletePendingActionByKind({ ownerId, userId, kind });
      return;
    }

    console.warn('[pending_actions] deletePendingAction received object but insufficient keys (ignored):', {
      hasOwnerId: !!ownerId,
      hasUserId: !!userId,
      hasKind: !!kind,
      hasId: !!id
    });
    return;
  }

  // 3) null/undefined etc
  return;
}

// ✅ Compatibility aliases
async function upsertPendingAction({ ownerId, userId, kind, payload, ttlSeconds } = {}) {
  // schema uses created_at TTL; ignore ttlSeconds safely.
  return savePendingAction({ ownerId, userId, kind, payload });
}

async function clearPendingAction({ ownerId, userId, kind } = {}) {
  return deletePendingActionByKind({ ownerId, userId, kind });
}

async function getMostRecentPendingActionForUser({ ownerId, userId }) {
  const owner = String(ownerId || '').replace(/\D/g, '');
  const user = String(userId || '').trim();
  if (!owner || !user) return null;

  const ttlMin = Number(process.env.PENDING_TTL_MIN || 10);

  const r = await query(
    `
    SELECT kind, payload, created_at
      FROM public.pending_actions
     WHERE owner_id = $1
       AND user_id = $2
       AND created_at > now() - (($3::text || ' minutes')::interval)
     ORDER BY created_at DESC
     LIMIT 1
    `,
    [owner, user, String(ttlMin)]
  );

  return r?.rows?.[0] || null;
}

/* -------------------- Finance helpers -------------------- */
async function getOwnerPricingItems(ownerId) {
  const ownerKey = String(ownerId);
  const { rows } = await query(
    `
      select id, item_name, unit, unit_cost_cents, kind, created_at
      from pricing_items
      where owner_id::text = $1
      order by lower(item_name)
    `,
    [ownerKey]
  );
  return rows;
}

async function getJobFinanceSnapshot(ownerId, jobId = null) {
  const ownerKey = String(ownerId);
  const params = [ownerKey];
  let where = 'owner_id::text = $1';

  if (jobId) {
    params.push(String(jobId));
    const caps = await detectTransactionsCapabilities().catch(() => ({ TX_HAS_JOB_ID: false, TX_HAS_JOB: false }));
    if (caps?.TX_HAS_JOB_ID) where += ' AND job_id::text = $2';
    else if (caps?.TX_HAS_JOB) where += ' AND job::text = $2';
    else where += ' AND 1=0';
  }

  const { rows } = await query(
    `
      select kind, coalesce(sum(amount_cents), 0) as amount_cents
      from transactions
      where ${where}
      group by kind
    `,
    params
  );

  let totalExpense = 0;
  let totalRevenue = 0;

  for (const r of rows) {
    const kind = (r.kind || '').toLowerCase();
    const cents = Number(r.amount_cents) || 0;
    if (kind === 'expense') totalExpense += cents;
    if (kind === 'revenue') totalRevenue += cents;
  }

  const profit = totalRevenue - totalExpense;
  const marginPct = totalRevenue > 0 ? Math.round((profit / totalRevenue) * 1000) / 10 : null;

  return {
    total_expense_cents: totalExpense,
    total_revenue_cents: totalRevenue,
    profit_cents: profit,
    margin_pct: marginPct
  };
}

async function getOwnerMonthlyFinance(ownerId, monthStart) {
  const ownerKey = String(ownerId);
  const start = monthStart;

  const { rows } = await query(
    `
      select
        kind,
        coalesce(sum(amount_cents), 0) as amount_cents
      from transactions
      where owner_id::text = $1
        and date >= $2::date
        and date <  ($2::date + interval '1 month')
      group by kind
    `,
    [ownerKey, start]
  );

  let revenue = 0;
  let expense = 0;
  for (const r of rows) {
    const k = (r.kind || '').toLowerCase();
    const cents = Number(r.amount_cents) || 0;
    if (k === 'revenue') revenue += cents;
    if (k === 'expense') expense += cents;
  }

  const profit = revenue - expense;
  const margin_pct = revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : null;

  return {
    month_start: start,
    revenue_cents: revenue,
    expense_cents: expense,
    profit_cents: profit,
    margin_pct
  };
}
// -----------------------------------------------------------------------------
// ✅ MVP Insight Helper: totals for a date range (business-wide)
// Returns DOLLARS (not cents) to match insights_v0 expectations.
// -----------------------------------------------------------------------------
function isoToDateOnly(isoLike) {
  if (!isoLike) return null;
  const d = new Date(isoLike);
  if (Number.isNaN(d.getTime())) return null;

  // Use local date; good enough for MVP given insights_v0 creates day windows.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

async function getTotalsForRange(ownerId, fromIso, toIso, _jobId = null) {
  const ownerKey = String(ownerId || '').trim();
  if (!ownerKey) throw new Error('getTotalsForRange: missing ownerId');

  const fromDate = isoToDateOnly(fromIso);
  const toDate = isoToDateOnly(toIso);

  if (!fromDate || !toDate) {
    return {
      spend: 0,
      revenue: 0,
      profit: 0,
      spend_cents: 0,
      revenue_cents: 0,
      profit_cents: 0,
      from: fromDate || null,
      to: toDate || null
    };
  }

  // We use inclusive end date because transactions.date is stored as DATE.
  const { rows } = await query(
    `
    select
      coalesce(sum(case when kind = 'expense' then amount_cents end), 0) as expense_cents,
      coalesce(sum(case when kind = 'revenue' then amount_cents end), 0) as revenue_cents
    from public.transactions
    where owner_id::text = $1
      and date >= $2::date
      and date <= $3::date
    `,
    [ownerKey, fromDate, toDate]
  );

  const expenseCents = Number(rows?.[0]?.expense_cents) || 0;
  const revenueCents = Number(rows?.[0]?.revenue_cents) || 0;
  const profitCents = revenueCents - expenseCents;

  // ✅ insights_v0 expects dollars (it prints with toFixed(2))
  const spend = expenseCents / 100;
  const revenue = revenueCents / 100;
  const profit = profitCents / 100;

  return {
    spend,
    revenue,
    profit,
    spend_cents: expenseCents,
    revenue_cents: revenueCents,
    profit_cents: profitCents,
    from: fromDate,
    to: toDate
  };
}

async function getOwnerCategoryBreakdown(ownerId, fromDate, toDate, kindFilter = null) {
  const ownerKey = String(ownerId);

  const params = [ownerKey, fromDate, toDate];
  let where = `
    owner_id::text = $1
    and date >= $2::date
    and date <  $3::date
  `;

  if (kindFilter) {
    params.push(kindFilter);
    where += ` and kind = $4`;
  }

  const { rows } = await query(
    `
      select
        coalesce(nullif(category, ''), 'Uncategorized') as category,
        coalesce(sum(amount_cents), 0) as amount_cents
      from transactions
      where ${where}
      group by coalesce(nullif(category, ''), 'Uncategorized')
      order by amount_cents desc
    `,
    params
  );

  return rows.map((r) => ({
    category: r.category,
    amount_cents: Number(r.amount_cents) || 0
  }));
}

async function getOwnerVendorBreakdown(ownerId, fromDate, toDate, kindFilter = 'expense') {
  const ownerKey = String(ownerId);
  const params = [ownerKey, fromDate, toDate];
  let where = `
    owner_id::text = $1
    and date >= $2::date
    and date <  $3::date
  `;

  if (kindFilter) {
    params.push(kindFilter);
    where += ` and kind = $4`;
  }

  const { rows } = await query(
    `
      select
        coalesce(nullif(regexp_replace(lower(trim(source)), '\\s+', ' ', 'g'), ''), 'Unknown') as vendor_key,
        coalesce(sum(amount_cents), 0) as amount_cents,
        count(*)::int as txn_count
      from transactions
      where ${where}
      group by coalesce(nullif(regexp_replace(lower(trim(source)), '\\s+', ' ', 'g'), ''), 'Unknown')
      order by amount_cents desc
    `,
    params
  );

  return rows.map((r) => ({
    vendor_key: r.vendor_key,
    amount_cents: Number(r.amount_cents) || 0,
    txn_count: Number(r.txn_count) || 0
  }));
}

/* ------------------------------------------------------------------ */
/* ✅ Category Rules                                                    */
/* ------------------------------------------------------------------ */
let _HAS_CATEGORY_RULES = null;

async function detectCategoryRulesTable() {
  if (_HAS_CATEGORY_RULES !== null) return _HAS_CATEGORY_RULES;
  try {
    _HAS_CATEGORY_RULES = await hasTable('category_rules');
  } catch {
    _HAS_CATEGORY_RULES = false;
  }
  return _HAS_CATEGORY_RULES;
}

function normalizeCategoryString(category) {
  const s = String(category || '').trim();
  if (!s) return null;

  const t = s.toLowerCase();
  if (t === 'material' || t === 'materials' || t === 'mat') return 'Materials';
  if (t === 'fuel' || t === 'gas') return 'Fuel';
  if (t === 'tool' || t === 'tools' || t === 'equipment') return 'Tools';
  if (t === 'sub' || t === 'subs' || t === 'subcontractor' || t === 'subcontractors') return 'Subcontractors';
  if (t === 'office' || t === 'office supplies') return 'Office Supplies';

  return s.replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeVendorSource(source) {
  let s = String(source || '').trim().replace(/\s+/g, ' ');
  const lc = s.toLowerCase();
  if (!s) return 'Unknown';
  if (lc === 'on' || lc === 'off') return 'Unknown';
  if (lc.startsWith('job ')) return 'Unknown';

  // optional alias map
  const ALIASES = {
    'rona': 'RONA',
    'the home depot': 'Home Depot',
    'home depot': 'Home Depot',
  };
  s = ALIASES[lc] || s;

  if (s.length > 80) return s.slice(0, 80);
  return s;
}


async function normalizeVendorName(_ownerId, vendor) {
  return normalizeVendorSource(vendor);
}


async function upsertCategoryRule({ ownerId, kind = 'expense', vendor, keyword = null, category, weight = 10 } = {}) {
  const owner = String(ownerId || '').replace(/\D/g, '');
  const k = String(kind || 'expense').trim() || 'expense';

  const vendorNorm = vendor ? normalizeVendorSource(vendor) : null;
  const kw = keyword ? String(keyword).trim().toLowerCase() : null;

  const cat = normalizeCategoryString(category);
  const w = Number.isFinite(Number(weight)) ? Number(weight) : 10;

  if (!owner) throw new Error('upsertCategoryRule missing ownerId');
  if (!cat) throw new Error('upsertCategoryRule missing category');

  if (!(await detectCategoryRulesTable())) return { ok: false, skipped: true };

  const { rows } = await query(
    `
    with existing as (
      select id
        from public.category_rules
       where owner_id = $1
         and kind = $2
         and (
           (vendor_norm is null and $3 is null) or vendor_norm = $3
         )
         and (
           (keyword is null and $4 is null) or keyword = $4
         )
       order by weight desc, created_at desc
       limit 1
    )
    update public.category_rules r
       set category = $5,
           weight = $6
      from existing e
     where r.id = e.id
    returning r.id
    `,
    [owner, k, vendorNorm, kw, cat, w]
  );

  if (rows?.[0]?.id) return { ok: true, id: rows[0].id, updated: true };

  const ins = await query(
    `
    insert into public.category_rules (owner_id, kind, vendor_norm, keyword, category, weight, created_at)
    values ($1,$2,$3,$4,$5,$6,now())
    returning id
    `,
    [owner, k, vendorNorm, kw, cat, w]
  );

  return { ok: true, id: ins?.rows?.[0]?.id || null, inserted: true };
}

async function getCategorySuggestion(ownerId, kind = 'expense', vendor, itemText) {
  const owner = String(ownerId || '').replace(/\D/g, '');
  if (!owner) return null;
  if (!(await detectCategoryRulesTable())) return null;

  const k = String(kind || 'expense').trim() || 'expense';
  const vendorNorm = vendor ? normalizeVendorSource(vendor) : null;
  const text = String(itemText || '').toLowerCase();

  try {
    if (vendorNorm && text) {
      const r1 = await query(
        `
        select id, category, weight, vendor_norm, keyword
          from public.category_rules
         where owner_id=$1
           and kind=$2
           and vendor_norm=$3
           and keyword is not null
         order by weight desc, created_at desc
        `,
        [owner, k, vendorNorm]
      );

      for (const row of r1.rows || []) {
        const kw = String(row.keyword || '').trim().toLowerCase();
        if (kw && text.includes(kw)) {
          return normalizeCategoryString(row.category);
        }
      }
    }

    if (vendorNorm) {
      const r2 = await query(
        `
        select id, category
          from public.category_rules
         where owner_id=$1
           and kind=$2
           and vendor_norm=$3
           and keyword is null
         order by weight desc, created_at desc
         limit 1
        `,
        [owner, k, vendorNorm]
      );
      if (r2.rows?.[0]) return normalizeCategoryString(r2.rows[0].category);
    }

    if (text) {
      const r3 = await query(
        `
        select id, category, keyword
          from public.category_rules
         where owner_id=$1
           and kind=$2
           and vendor_norm is null
           and keyword is not null
         order by weight desc, created_at desc
        `,
        [owner, k]
      );

      for (const row of r3.rows || []) {
        const kw = String(row.keyword || '').trim().toLowerCase();
        if (kw && text.includes(kw)) {
          return normalizeCategoryString(row.category);
        }
      }
    }

    return null;
  } catch (e) {
    console.warn('[PG/getCategorySuggestion] failed (fail-open):', e?.message);
    return null;
  }
}

/**
 * ✅ listOpenJobs(ownerId, { limit })
 */
async function listOpenJobs(ownerId, { limit = 8 } = {}) {
  const owner = String(ownerId || '').trim();
  const lim = Math.max(1, Math.min(Number(limit) || 8, 50));

  try {
    const { rows } = await query(
      `
      select coalesce(name, job_name) as job_name
      from public.jobs
      where owner_id::text = $1
        and coalesce(nullif(status,''), 'open') not in ('closed','done','completed','archived','canceled','cancelled')
      order by active desc nulls last, updated_at desc nulls last, created_at desc
      limit $2
      `,
      [owner, lim]
    );
    return (rows || []).map((r) => r.job_name).filter(Boolean);
  } catch (e) {
    console.warn('[PG/listOpenJobs] status query failed; falling back:', e?.message);
  }

  try {
    const { rows } = await query(
      `
      select coalesce(name, job_name) as job_name
      from public.jobs
      where owner_id::text = $1
        and completed_at is null
      order by active desc nulls last, updated_at desc nulls last, created_at desc
      limit $2
      `,
      [owner, lim]
    );
    return (rows || []).map((r) => r.job_name).filter(Boolean);
  } catch (e) {
    console.warn('[PG/listOpenJobs] fallback query failed:', e?.message);
    return [];
  }
}

/* -------------------- Time Limits & Audit -------------------- */
// Post-rebuild: public.time_entries DROPPED — these capability detectors
// are dead. Canonical is public.time_entries_v2.

async function detectTimeEntriesCapabilities() {
  return { SUPPORTS_CREATED_BY: false, SUPPORTS_USER_ID: false, SUPPORTS_SOURCE_MSG_ID: false };
}

async function detectTimeEntriesUniqueOwnerUserSourceMsg() {
  return false;
}

// All 4 functions below are STUBBED — public.time_entries DROPPED post-rebuild.
// Canonical surface is public.time_entries_v2 (different shape: `kind`,
// `start_at_utc`, `end_at_utc`, `meta jsonb`, no `type`/`employee_name`/
// `local_time`/`timestamp` columns). The owner-side dual-write that these
// functions performed is gone — owner views read time_entries_v2 directly.
// Filed as P1: legacy-time_entries removal + caller migration to v2.

async function checkTimeEntryLimit(ownerId, createdBy, opts = {}) {
  // Returning "no rate-limit hit" preserves caller behavior under the legacy
  // dual-write path. Real rate-limiting on time_entries_v2 belongs in the P1
  // rewrite — this stub disables the legacy check rather than blocking writes.
  console.warn(
    '[STUB] checkTimeEntryLimit: public.time_entries DROPPED post-rebuild. ' +
    'Returning ok:true (rate-limit disabled). Rewrite via time_entries_v2 in P1.',
    { ownerId, createdBy, opts }
  );
  return { ok: true, n: 0, limit: Infinity, windowSec: 0 };
}

async function logTimeEntryWithJob(ownerId, employeeName, type, ts, jobName, tz, extras = {}) {
  return await logTimeEntry(ownerId, employeeName, type, ts, null, tz, extras);
}

async function logTimeEntry(ownerId, employeeName, type, ts, jobNo, tz, extras = {}) {
  console.warn(
    '[STUB] logTimeEntry: public.time_entries DROPPED post-rebuild. ' +
    'Authoritative writes go to time_entries_v2 directly from caller (e.g., ' +
    'routes/timeclock.js, routes/employee.js). Legacy dual-write was already ' +
    'a silent no-op in production. Returning null.',
    { ownerId, employeeName, type, ts, jobNo, tz }
  );
  return null;
}

async function moveLastLogToJob(ownerId, userName, jobRef) {
  console.warn(
    '[STUB] moveLastLogToJob: public.time_entries DROPPED post-rebuild. ' +
    'Caller should UPDATE public.time_entries_v2 directly. Returning null.',
    { ownerId, userName, jobRef }
  );
  return null;
}

async function enqueueKpiTouch(ownerId, jobId, isoDate) {
  const owner = String(ownerId).replace(/\D/g, '');
  const day = isoDate ? isoDate.slice(0, 10) : new Date().toISOString().slice(0, 10);
  await query(`insert into public.kpi_touches (owner_id, job_id, day) values ($1,$2,$3)`, [owner, jobId || null, day]);
}

// ---- JOB BY NAME/SOURCE HELPERS (kept) ----
async function getJobByName(ownerId, name) {
  const owner = DIGITS(ownerId);
  const jobName = String(name || '').trim();
  if (!owner || !jobName) return null;

  const { rows } = await query(
    `
    select
      id,
      job_no,
      coalesce(name, job_name) as job_name,
      source_msg_id
    from public.jobs
    where owner_id = $1
      and (
        lower(name) = lower($2)
        or lower(job_name) = lower($2)
      )
    order by created_at desc
    limit 1
    `,
    [owner, jobName]
  );

  return rows[0] || null;
}

async function getJobBySourceMsg(ownerId, sourceMsgId) {
  const owner = DIGITS(ownerId);
  const sm = String(sourceMsgId || '').trim();
  if (!owner || !sm) return null;

  const { rows } = await query(
    `select id, job_no, coalesce(name, job_name) as job_name, source_msg_id
       from public.jobs
      where owner_id = $1 and source_msg_id = $2
      limit 1`,
    [owner, sm]
  );
  return rows[0] || null;
}

// ---- Safe limiter exports
const __checkLimit =
  (typeof checkTimeEntryLimit === 'function' && checkTimeEntryLimit) ||
  (async () => ({ ok: true, n: 0, limit: Infinity, windowSec: 0 }));

/* ------------------------------------------------------------------ */
/* ✅ Aliases expected by handlers                                     */
/* ------------------------------------------------------------------ */
async function setActiveJobForUser(ownerId, userId, jobId, jobName) {
  return setActiveJobForIdentity(ownerId, userId, jobId, jobName);
}
async function setUserActiveJob(ownerId, userId, jobId, jobName) {
  return setActiveJobForIdentity(ownerId, userId, jobId, jobName);
}
async function updateUserActiveJob(ownerId, userId, jobId, jobName) {
  return setActiveJobForIdentity(ownerId, userId, jobId, jobName);
}
async function saveActiveJob(ownerId, userId, jobId, jobName) {
  return setActiveJobForIdentity(ownerId, userId, jobId, jobName);
}
async function setActiveJobForPhone(ownerId, fromPhone, jobId, jobName) {
  return setActiveJobForIdentity(ownerId, fromPhone, jobId, jobName);
}
// ---------------- Stripe / Billing helpers ----------------

// Stripe webhook idempotency (schema: stripe_events(event_id text, received_at timestamptz))
async function hasStripeEvent(eventId) {
  const id = String(eventId || "").trim();
  if (!id) return false;

  const { rows } = await pool.query(
    `select 1
     from public.stripe_events
     where event_id = $1
     limit 1`,
    [id]
  );

  return rows.length > 0;
}

async function insertStripeEvent(eventId, eventType = null) {
  const { rows } = await pool.query(
    `insert into public.stripe_events (event_id, received_at, event_type)
     values ($1, now(), $2)
     on conflict (event_id) do nothing
     returning event_id`,
    [String(eventId), eventType ? String(eventType) : null]
  );
  return !!rows?.[0]?.event_id; // true = inserted, false = deduped
}



async function getOwnerByDashboardToken(dashboardToken) {
  const t = String(dashboardToken || "").trim();
  if (!t) return null;

  const { rows } = await pool.query(
    `
    select user_id
    from public.users
    where dashboard_token = $1
      and user_id = owner_id
    limit 1
    `,
    [t]
  );

  return rows[0]?.user_id ? String(rows[0].user_id) : null;
}


async function getOwner(ownerId) {
  const owner = String(ownerId || '').trim();
  if (!owner) return null;

  const r = await query(
    `select user_id, name, email,
            plan_key, subscription_tier, paid_tier, sub_status,
            stripe_customer_id, stripe_subscription_id, stripe_price_id,
            current_period_start, current_period_end, cancel_at_period_end
       from public.users
      where user_id = $1
      limit 1`,
    [owner]
  );

  return r?.rows?.[0] || null;
}

async function findOwnerIdByStripeCustomer(customerId) {
  const cid = String(customerId || '').trim();
  if (!cid) return null;

  const r = await query(
    `select user_id
       from public.users
      where stripe_customer_id = $1
      limit 1`,
    [cid]
  );

  return r?.rows?.[0]?.user_id || null;
}

async function findOwnerIdByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;

  const r = await query(
    `select user_id
       from public.users
      where lower(email) = $1
      limit 1`,
    [e]
  );

  return r?.rows?.[0]?.user_id || null;
}

async function updateOwnerBilling(ownerId, patch = {}) {
  const id = String(ownerId || "").trim();
  if (!id) throw new Error("updateOwnerBilling: missing ownerId");

  const p = patch || {};

  // ✅ Whitelist of columns we allow billing to mutate
  const allowed = new Set([
    "plan_key",
    "subscription_tier",
    "paid_tier",

    "stripe_customer_id",
    "stripe_subscription_id",
    "stripe_price_id",

    "sub_status",
    "cancel_at_period_end",
    "current_period_start",
    "current_period_end",
  ]);

  // ✅ IMPORTANT: drop undefined values entirely (do NOT convert to null)
  const entries = Object.entries(p)
    .filter(([k]) => allowed.has(k))
    .filter(([, v]) => v !== undefined);

  if (entries.length === 0) return null;

  // ✅ Plan truth alignment: whenever plan_key is set, mirror it
  let finalEntries = entries;
  const hasPlanKey = entries.some(([k]) => k === "plan_key");
  if (hasPlanKey) {
    const planKey = entries.find(([k]) => k === "plan_key")[1];
    finalEntries = finalEntries
      .filter(([k]) => k !== "subscription_tier" && k !== "paid_tier")
      .concat([
        ["subscription_tier", planKey],
        ["paid_tier", planKey],
      ]);
  }

  const sets = [];
  const values = [];
  let i = 1;

  for (const [k, v] of finalEntries) {
    sets.push(`${k} = $${i++}`);
    // ✅ allow explicit null if caller really wants to clear it
    values.push(v);
  }

  values.push(id);

  const sql = `
    update public.users
    set ${sets.join(", ")},
        updated_at = now()
    where user_id = $${i}
    returning user_id, plan_key, subscription_tier, paid_tier,
              stripe_customer_id, stripe_subscription_id, stripe_price_id,
              sub_status, cancel_at_period_end,
              current_period_start, current_period_end,
              updated_at
  `;

  const { rows } = await pool.query(sql, values);
  return rows[0] || null;
}

// ---- Usage / Quota (MVP) ---------------------------------------------

function monthKeyFromDate(d = new Date()) {
  const dt = (d instanceof Date) ? d : new Date(d);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`; // e.g. "2026-02"
}

async function getMonthlyUsage({ ownerId, kind, monthKey }) {
  if (!ownerId) throw new Error('getMonthlyUsage: missing ownerId');
  if (!kind) throw new Error('getMonthlyUsage: missing kind');
  const mk = monthKey || monthKeyFromDate();

  const sql = `
    select units
    from public.usage_monthly_v2
    where owner_id = $1 and month_key = $2 and kind = $3
    limit 1
  `;
  const { rows } = await pool.query(sql, [ownerId, mk, kind]);
  return rows[0]?.units ? Number(rows[0].units) : 0;
}

// amount is the number of units to add (1 receipt, N seconds, 1 export)
async function incrementMonthlyUsage({ ownerId, kind, monthKey, amount = 1 }) {
  if (!ownerId) throw new Error('incrementMonthlyUsage: missing ownerId');
  if (!kind) throw new Error('incrementMonthlyUsage: missing kind');
  const mk = monthKey || monthKeyFromDate();
  const add = Number(amount || 0);
  if (!Number.isFinite(add) || add <= 0) return 0;

  const sql = `
    insert into public.usage_monthly_v2 (owner_id, month_key, kind, units)
    values ($1, $2, $3, $4)
    on conflict (owner_id, month_key, kind)
do update set
  units = public.usage_monthly_v2.units + excluded.units,
      updated_at = now()
    returning units
  `;
  const { rows } = await pool.query(sql, [ownerId, mk, kind, add]);
  return rows[0]?.units ? Number(rows[0].units) : 0;
}

// -----------------------------------------------------------------------------
// ✅ Export safety bridge (prevents boot-time ReferenceError on Vercel)
// If legacy names were removed/renamed during v2 migration, Node will crash
// when module.exports references undefined identifiers.
// This ensures the identifiers always exist, and points legacy names to v2.
// -----------------------------------------------------------------------------

// Prefer v2 exports if present
const exportTimesheetXlsx =
  (typeof exportTimesheetXlsxV2 === 'function' && exportTimesheetXlsxV2) ||
  (typeof exportTimesheetXlsxLegacy === 'function' && exportTimesheetXlsxLegacy) ||
  null;

const exportTimesheetPdf =
  (typeof exportTimesheetPdfV2 === 'function' && exportTimesheetPdfV2) ||
  (typeof exportTimesheetPdfLegacy === 'function' && exportTimesheetPdfLegacy) ||
  null;


/* ─────────────────────────────────────────────────────────────────────────────
   SUPPLIER CATALOG QUERIES
   Catalog tables are shared reference data — no tenant_id, no RLS.
   Contractors read from the global catalog; writes are ingestion-pipeline only.
   ───────────────────────────────────────────────────────────────────────────── */

// Freshness cadence in days
const CADENCE_DAYS = { monthly: 30, quarterly: 90, annual: 365 };

function getSupplierFreshnessState(lastUpdatedDate, cadence) {
  if (!lastUpdatedDate) return 'UNKNOWN';
  const cadenceDays = CADENCE_DAYS[cadence] || 90;
  const daysSince = Math.floor((Date.now() - new Date(lastUpdatedDate).getTime()) / (1000 * 60 * 60 * 24));
  if (daysSince > cadenceDays * 2) return 'EXPIRED';
  if (daysSince > cadenceDays) return 'STALE';
  if (daysSince > cadenceDays - 30) return 'AGING';
  return 'FRESH';
}

async function listSuppliers() {
  const { rows } = await query(
    `SELECT id, slug, name, description, website_url, logo_storage_key,
            catalog_update_cadence, is_active, updated_at,
            (SELECT COUNT(*) FROM public.catalog_products cp WHERE cp.supplier_id = s.id AND cp.is_active = true) AS product_count,
            (SELECT MAX(price_effective_date) FROM public.catalog_products cp WHERE cp.supplier_id = s.id) AS last_price_date
     FROM public.suppliers s
     WHERE is_active = true
     ORDER BY name`
  );
  return rows.map((r) => ({
    ...r,
    freshness: getSupplierFreshnessState(r.last_price_date, r.catalog_update_cadence),
  }));
}

async function getSupplierBySlug(slug) {
  const { rows } = await query(
    `SELECT id, slug, name, description, website_url, logo_storage_key,
            contact_email, catalog_update_cadence, is_active, created_at, updated_at
     FROM public.suppliers
     WHERE slug = $1 AND is_active = true
     LIMIT 1`,
    [slug]
  );
  return rows[0] ?? null;
}

async function listSupplierCategories(supplierId) {
  const { rows } = await query(
    `SELECT id, name, slug, parent_category_id, sort_order
     FROM public.supplier_categories
     WHERE supplier_id = $1 AND is_active = true
     ORDER BY sort_order, name`,
    [supplierId]
  );
  return rows;
}

async function listCatalogProducts(supplierId, { categoryId = null, search = null, limit = 50, offset = 0 } = {}) {
  const conditions = [`cp.supplier_id = $1`, `cp.is_active = true`];
  const params = [supplierId];

  if (categoryId) {
    params.push(categoryId);
    conditions.push(`cp.category_id = $${params.length}`);
  }

  let orderBy = 'cp.name';

  if (search && search.trim()) {
    params.push(search.trim());
    const idx = params.length;
    conditions.push(`to_tsvector('english', cp.name || ' ' || COALESCE(cp.description, '')) @@ plainto_tsquery('english', $${idx})`);
    orderBy = `ts_rank(to_tsvector('english', cp.name || ' ' || COALESCE(cp.description, '')), plainto_tsquery('english', $${idx})) DESC`;
  }

  const whereClause = conditions.join(' AND ');

  // Total count (same filters, no limit/offset)
  const { rows: countRows } = await query(
    `SELECT COUNT(*) AS total
     FROM public.catalog_products cp
     WHERE ${whereClause}`,
    params
  );
  const total = parseInt(countRows[0]?.total ?? '0', 10);

  params.push(limit);
  params.push(offset);

  const { rows } = await query(
    `SELECT cp.id, cp.sku, cp.name, cp.description, cp.unit_of_measure,
            cp.unit_price_cents, cp.price_type, cp.price_effective_date,
            cp.price_expires_date, cp.min_order_quantity, cp.metadata, cp.updated_at,
            sc.name AS category_name
     FROM public.catalog_products cp
     LEFT JOIN public.supplier_categories sc ON sc.id = cp.category_id
     WHERE ${whereClause}
     ORDER BY ${orderBy}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows, total };
}

async function searchAllCatalog(searchQuery, { limit = 20 } = {}) {
  if (!searchQuery || !searchQuery.trim()) return [];
  const { rows } = await query(
    `SELECT cp.id, cp.sku, cp.name, cp.description, cp.unit_of_measure,
            cp.unit_price_cents, cp.price_effective_date, cp.metadata,
            s.name AS supplier_name, s.slug AS supplier_slug,
            s.catalog_update_cadence
     FROM public.catalog_products cp
     JOIN public.suppliers s ON s.id = cp.supplier_id
     WHERE cp.is_active = true
       AND s.is_active = true
       AND to_tsvector('english', cp.name || ' ' || COALESCE(cp.description, ''))
           @@ plainto_tsquery('english', $1)
     ORDER BY ts_rank(
       to_tsvector('english', cp.name || ' ' || COALESCE(cp.description, '')),
       plainto_tsquery('english', $1)
     ) DESC
     LIMIT $2`,
    [searchQuery.trim(), limit]
  );
  return rows.map((r) => ({
    ...r,
    freshness: getSupplierFreshnessState(r.price_effective_date, r.catalog_update_cadence),
  }));
}

async function getCatalogProduct(productId) {
  const { rows } = await query(
    `SELECT cp.id, cp.sku, cp.name, cp.description, cp.unit_of_measure,
            cp.unit_price_cents, cp.price_type, cp.price_effective_date,
            cp.price_expires_date, cp.min_order_quantity, cp.metadata,
            cp.is_active, cp.discontinued_at, cp.updated_at,
            s.name AS supplier_name, s.slug AS supplier_slug,
            s.catalog_update_cadence,
            sc.name AS category_name
     FROM public.catalog_products cp
     JOIN public.suppliers s ON s.id = cp.supplier_id
     LEFT JOIN public.supplier_categories sc ON sc.id = cp.category_id
     WHERE cp.id = $1
     LIMIT 1`,
    [productId]
  );
  if (!rows[0]) return null;
  return {
    ...rows[0],
    freshness: getSupplierFreshnessState(rows[0].price_effective_date, rows[0].catalog_update_cadence),
  };
}

async function getProductPriceHistory(productId, limit = 20) {
  const { rows } = await query(
    `SELECT old_price_cents, new_price_cents, price_type, effective_date, change_source, created_at
     FROM public.catalog_price_history
     WHERE product_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [productId, limit]
  );
  return rows;
}

async function getTenantSupplierPreferences(tenantId) {
  const { rows } = await query(
    `SELECT tsp.id, tsp.supplier_id, tsp.is_preferred, tsp.contractor_account_number,
            tsp.discount_percentage, tsp.notes, tsp.updated_at,
            s.slug, s.name AS supplier_name, s.website_url
     FROM public.tenant_supplier_preferences tsp
     JOIN public.suppliers s ON s.id = tsp.supplier_id
     WHERE tsp.tenant_id = $1
     ORDER BY tsp.is_preferred DESC, s.name`,
    [tenantId]
  );
  return rows;
}

async function upsertTenantSupplierPreference(tenantId, supplierId, prefs) {
  const { is_preferred, contractor_account_number, discount_percentage, notes } = prefs;
  const { rows } = await query(
    `INSERT INTO public.tenant_supplier_preferences
       (tenant_id, supplier_id, is_preferred, contractor_account_number, discount_percentage, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, supplier_id)
     DO UPDATE SET
       is_preferred = EXCLUDED.is_preferred,
       contractor_account_number = EXCLUDED.contractor_account_number,
       discount_percentage = EXCLUDED.discount_percentage,
       notes = EXCLUDED.notes,
       updated_at = now()
     RETURNING *`,
    [tenantId, supplierId, is_preferred ?? false,
     contractor_account_number ?? null, discount_percentage ?? 0, notes ?? null]
  );
  return rows[0];
}

/**
 * saveQuoteLineItemsWithSnapshots
 * Persists catalog-sourced WhatsApp quote line items to quote_line_items
 * so they appear in the portal with frozen catalog snapshots.
 * Requires job to exist — resolves by job_name under ownerId.
 * Fail-open: if job or tenant not found, skips silently.
 */
async function saveQuoteLineItemsWithSnapshots({ ownerId, jobName, items }) {
  if (!ownerId || !jobName || !items?.length) return;

  // Resolve tenant_id from owner_id
  const tenantRes = await query(
    `SELECT id FROM public.chiefos_tenants WHERE owner_id = $1 LIMIT 1`,
    [String(ownerId)]
  );
  const tenantId = tenantRes.rows?.[0]?.id;
  if (!tenantId) return;

  // Resolve job_id from job_name under owner
  const jobRes = await query(
    `SELECT id FROM public.jobs WHERE owner_id = $1 AND LOWER(job_name) = LOWER($2) ORDER BY id DESC LIMIT 1`,
    [String(ownerId), jobName.trim()]
  );
  const jobId = jobRes.rows?.[0]?.id;
  if (!jobId) return;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    await query(
      `INSERT INTO public.quote_line_items
         (job_id, tenant_id, description, qty, unit_price_cents, category, sort_order, catalog_product_id, catalog_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        jobId,
        tenantId,
        item.item || item.catalog_snapshot?.name || 'Material',
        item.quantity || 1,
        Math.round((item.price || 0) * 100),
        'materials',
        i,
        item.catalog_product_id || null,
        item.catalog_snapshot ? JSON.stringify(item.catalog_snapshot) : null,
      ]
    );
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   INTEGRITY VERIFICATION QUERIES
   ───────────────────────────────────────────────────────────────────────────── */

async function getIntegrityVerificationHistory(tenantId, limit = 20) {
  const { rows } = await query(
    `SELECT id, table_name, verification_type, total_records_checked,
            records_valid, records_invalid, records_unhashed,
            first_invalid_record_id, invalid_details, chain_intact,
            started_at, completed_at, created_at,
            (records_invalid = 0) AS chain_intact
     FROM public.integrity_verification_log
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [tenantId, limit]
  );
  return rows;
}

async function getLatestIntegrityStatus(tenantId) {
  const { rows } = await query(
    `SELECT records_invalid = 0 AS chain_intact, total_records_checked,
            records_valid, records_invalid, completed_at
     FROM public.integrity_verification_log
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId]
  );
  return rows[0] ?? null;
}

/* -------------------- module exports -------------------- */
module.exports = {
  pool,
  query,
  queryWithRetry,
  queryWithTimeout,
  withClient,

  DIGITS,
  todayInTZ,
  normalizePhoneNumber,
  toCents,
  toAmount,
  isValidIso,

  MEDIA_TRANSCRIPT_MAX_CHARS,
  truncateText,
  detectTransactionsCapabilities,
  insertTransaction,
  normalizeMediaMeta,

  savePendingAction,
  getPendingAction,
  deletePendingAction,
  clearPendingAction,

  generateOTP,
  verifyOTP,
  createUserProfile,
  saveUserProfile,
  getUserProfile,
  getOwnerProfile,

  createTask,
  getTaskByNo,
  createTaskWithJob,

  ensureJobByName,
  createJobIdempotent,
  activateJobByName,
  resolveJobContext,
  listOpenJobs,
  normalizeVendorName,

  normalizeCategoryString,
  upsertCategoryRule,
  getCategorySuggestion,

  setActiveJob,
  getActiveJob,
  moveLastLogToJob,
  enqueueKpiTouch,

  setActiveJobForIdentity,
  getActiveJobForIdentity,

  setActiveJobForUser,
  setUserActiveJob,
  updateUserActiveJob,
  saveActiveJob,
  setActiveJobForPhone,

  logTimeEntry,
  logTimeEntryWithJob,
  getLatestTimeEvent,
  checkTimeEntryLimit: __checkLimit,
  checkActorLimit: __checkLimit,

  getJobFinanceSnapshot,
  getOwnerPricingItems,
  getOwnerMonthlyFinance,
  getOwnerCategoryBreakdown,
  getOwnerVendorBreakdown,

  exportTimesheetXlsx,
  exportTimesheetPdf,
  getFileExport,

  upsertPendingAction,
  getPendingActionByKind,
  deletePendingActionByKind,
  getMostRecentPendingActionForUser,
  createCilDraft,
  confirmCilDraftBySourceMsg,
  cancelCilDraftBySourceMsg,
  expireOldCilDrafts,
  countPendingCilDrafts,
  cancelLatestCilDraftForActor,
  cancelAllCilDraftsForActor,

  // Brain Exports
  insertFactEvent,
  getCashflowDaily,
  getJobProfitSimple,
  getLatestFacts,

  // kept helpers (if other files import them)
  getJobByName,
  getJobBySourceMsg,

  // optional: debugging / inspection
  // detectUserActiveJobJobIdType — REMOVED post-rebuild (user_active_job DROPPED)
  userActiveJobJoinMode,
  ymInTZ,
  getUsageMonthly,
  incrementUsageMonthly,
  checkMonthlyQuota,
  hasStripeEvent,
  insertStripeEvent,
  getOwner,
  findOwnerIdByStripeCustomer,
  findOwnerIdByEmail,
  updateOwnerBilling,
  getOwnerByDashboardToken,
  getMonthlyUsage,
  incrementMonthlyUsage,
  exportTimesheetXlsxV2,
  exportTimesheetPdfV2,
  resolveJobRow,
  getColumnDataType,
  getPendingJobPick,
  applyJobToPendingDraft,
  clearPendingJobPick,
  getTotalsForRange,
  getTenantIdForOwnerDigits,
  sumExpensesCentsByRange,
  sumRevenueCentsByRange,
  safeQueryUndefinedColumnRetry,
  topExpenseVendorsByRange,
  topExpenseCategoriesByRange,
  withTenantAllocLock,
  allocateNextDocCounter,
  allocateNextJobNo,
  getJobProfitByRange,

  // Supplier catalog
  listSuppliers,
  getSupplierBySlug,
  listSupplierCategories,
  listCatalogProducts,
  searchAllCatalog,
  getCatalogProduct,
  getProductPriceHistory,
  getTenantSupplierPreferences,
  upsertTenantSupplierPreference,
  getSupplierFreshnessState,
  saveQuoteLineItemsWithSnapshots,

  // Integrity verification
  getIntegrityVerificationHistory,
  getLatestIntegrityStatus,
};
