// services/postgres.js (DROP-IN) — aligned w/ handlers/commands/timeclock.js
// ------------------------------------------------------------
const { Pool } = require('pg');
const crypto = require('crypto');
const { formatInTimeZone } = require('date-fns-tz');

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
  max: 20,
  min: 0,
  idleTimeoutMillis: 60_000,
  connectionTimeoutMillis: 20_000,
  keepAlive: true,
  application_name: 'chief-ai'
});

pool.on('connect', async (client) => {
  try {
    await client.query(`SET TIME ZONE 'UTC'`);
    await client.query(`SET intervalstyle = 'iso_8601'`);
  } catch (e) {
    console.warn('[PG] connect session prep failed:', e?.message);
  }
});

pool.on('error', (err) => {
  console.error('[PG] idle client error:', err?.message);
});
// Active job resolution join mode
// - "legacy": old behavior
// - "rls": new behavior if you introduced a new join path
const userActiveJobJoinMode = String(env.USER_ACTIVE_JOB_JOIN_MODE || 'legacy').toLowerCase();

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


// ---------- Core query helpers ----------
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
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(str || ''));
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
let _MEMBERSHIPS_OK = null; 

/* ------------------------------------------------------------------ */
/* ✅ user_active_job job_id type detection (FIXES integer = uuid)      */
/* ------------------------------------------------------------------ */
let _USER_ACTIVE_JOB_JOB_ID_TYPE = null;

async function detectUserActiveJobJobIdType() {
  if (_USER_ACTIVE_JOB_JOB_ID_TYPE !== null) return _USER_ACTIVE_JOB_JOB_ID_TYPE;

  try {
    const r = await query(
      `
      select data_type
      from information_schema.columns
      where table_schema='public'
        and table_name='user_active_job'
        and column_name='job_id'
      limit 1
      `
    );
    _USER_ACTIVE_JOB_JOB_ID_TYPE = String(r?.rows?.[0]?.data_type || '').toLowerCase() || 'unknown';
  } catch {
    _USER_ACTIVE_JOB_JOB_ID_TYPE = 'unknown';
  }

  return _USER_ACTIVE_JOB_JOB_ID_TYPE;
}

/* ------------------------------------------------------------------ */
/*  ✅ Media transcript truncation + transactions schema capabilities   */
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
let TX_HAS_JOB_ID = null; // ✅ IMPORTANT: job_id column support
let TX_HAS_JOB_NO = null; // optional
let TX_HAS_OWNER_SOURCEMSG_UNIQUE = null;



async function detectTransactionsCapabilities() {
  if (
    TX_HAS_SOURCE_MSG_ID !== null &&
    TX_HAS_AMOUNT !== null &&
    TX_HAS_MEDIA_URL !== null &&
    TX_HAS_MEDIA_TYPE !== null &&
    TX_HAS_MEDIA_TXT !== null &&
    TX_HAS_MEDIA_CONF !== null &&
    TX_HAS_JOB_ID !== null &&
    TX_HAS_JOB_NO !== null &&
    TX_HAS_DEDUPE_HASH !== null
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
      TX_HAS_DEDUPE_HASH
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

    TX_HAS_SOURCE_MSG_ID = names.has('source_msg_id');
    TX_HAS_AMOUNT = names.has('amount');
    TX_HAS_MEDIA_URL = names.has('media_url');
    TX_HAS_MEDIA_TYPE = names.has('media_type');
    TX_HAS_MEDIA_TXT = names.has('media_transcript');
    TX_HAS_MEDIA_CONF = names.has('media_confidence');
    TX_HAS_JOB_ID = names.has('job_id');
    TX_HAS_JOB_NO = names.has('job_no');
    TX_HAS_DEDUPE_HASH = names.has('dedupe_hash'); // ✅ NEW
  } catch (e) {
    console.warn('[PG/transactions] detect capabilities failed (fail-open):', e?.message);
    TX_HAS_SOURCE_MSG_ID = false;
    TX_HAS_AMOUNT = false;
    TX_HAS_MEDIA_URL = false;
    TX_HAS_MEDIA_TYPE = false;
    TX_HAS_MEDIA_TXT = false;
    TX_HAS_MEDIA_CONF = false;
    TX_HAS_JOB_ID = false;
    TX_HAS_JOB_NO = false;
    TX_HAS_DEDUPE_HASH = false; // ✅ NEW
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
    TX_HAS_DEDUPE_HASH
  };
}


async function detectTransactionsUniqueOwnerSourceMsg() {
  if (TX_HAS_OWNER_SOURCEMSG_UNIQUE !== null) return TX_HAS_OWNER_SOURCEMSG_UNIQUE;

  try {
    const { rows } = await query(
      `
      select i.relname as index_name, pg_get_indexdef(ix.indexrelid) as def
        from pg_class t
        join pg_namespace n on n.oid=t.relnamespace
        join pg_index ix on ix.indrelid=t.oid
        join pg_class i on i.oid=ix.indexrelid
       where n.nspname='public'
         and t.relname='transactions'
         and ix.indisunique=true
      `
    );

    const defs = (rows || []).map((r) => String(r.def || '').toLowerCase());
    TX_HAS_OWNER_SOURCEMSG_UNIQUE = defs.some((d) => d.includes('(owner_id') && d.includes('source_msg_id'));
  } catch (e) {
    console.warn('[PG/transactions] detect unique(owner_id,source_msg_id) failed (fail-open):', e?.message);
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
  const owner = DIGITS(ownerId);
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
    .replace(/[^\p{L}\p{N}\s\.\-\&]/, ''); 
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

/**
 * ✅ insertTransaction()
 * Schema-aware insert into public.transactions with optional media fields.
 *
 * HARD GUARANTEE:
 * - transactions.job_id is UUID in your schema
 * - jobs.id is INTEGER in your schema
 * => NEVER insert jobs.id into transactions.job_id
 * => Only insert job_id when it is a UUID
 */
async function insertTransaction(opts = {}, { timeoutMs = 4000 } = {}) {
  const owner = DIGITS(opts.ownerId || opts.owner_id);
  const kind = String(opts.kind || '').trim();
  const date = String(opts.date || '').trim();
  const description = String(opts.description || '').trim() || 'Unknown';

  const amountCents = Number(opts.amount_cents ?? opts.amountCents ?? 0) || 0;
  const amountMaybe = opts.amount;

  const source = String(opts.source || '').trim() || 'Unknown';

  // job signals from callers
  const jobRef = opts.job == null ? null : String(opts.job).trim() || null;
  const jobNameInput =
    (opts.job_name ?? opts.jobName ?? opts.job_title ?? null) != null
      ? String(opts.job_name ?? opts.jobName ?? opts.job_title).trim()
      : null;

  const explicitJobId = opts.job_id ?? opts.jobId ?? null; // should be UUID if present
  const explicitJobNo = opts.job_no ?? opts.jobNo ?? null; // number-like

  const category = opts.category == null ? null : String(opts.category).trim() || null;
  const userName = opts.user_name ?? opts.userName ?? null;
  const sourceMsgId = String(opts.source_msg_id ?? opts.sourceMsgId ?? '').trim() || null;

  if (!owner) throw new Error('insertTransaction missing ownerId');
  if (!kind) throw new Error('insertTransaction missing kind');
  if (!date) throw new Error('insertTransaction missing date');
  if (!amountCents || amountCents <= 0) throw new Error('insertTransaction invalid amount_cents');

  const caps = await detectTransactionsCapabilities();
  const media = normalizeMediaMeta(opts.mediaMeta || opts.media_meta || null);

  // ✅ Resolve job_id/job_no/job_name best-effort, but never hard fail
  // IMPORTANT: resolvedJobId must ALWAYS be UUID or null
  let resolvedJobId = null;
  let resolvedJobNo = null;
  let resolvedJobName =
    jobNameInput || (jobRef && !looksLikeUuid(jobRef) && !/^\d+$/.test(jobRef) ? jobRef : null);

  try {
    // 1) Prefer explicit job_id if caller gave UUID
    if (explicitJobId != null && looksLikeUuid(String(explicitJobId))) {
      resolvedJobId = String(explicitJobId);

      // resolveJobRow should accept UUID job_id and return job_name/job_no if it can
      const row = await resolveJobRow(owner, resolvedJobId);
      if (row) {
        resolvedJobNo = row.job_no ?? resolvedJobNo ?? null;
        resolvedJobName = row.job_name ? String(row.job_name).trim() : resolvedJobName;
      }
    } else if (explicitJobId != null && /^\d+$/.test(String(explicitJobId).trim())) {
      // 🔒 Explicitly refuse numeric "job_id"
      console.warn('[PG/transactions] refusing numeric explicit job_id; ignoring', { explicitJobId });
    }

    // 2) If job_no passed, resolve name/no, but DO NOT copy jobs.id into transactions.job_id
    if (!resolvedJobId && explicitJobNo != null && String(explicitJobNo).trim() !== '') {
      const n = Number(explicitJobNo);
      if (Number.isFinite(n)) {
        resolvedJobNo = n;
        const row = await resolveJobRow(owner, String(n)); // may return row.id (INTEGER), row.job_name
        if (row) {
          // 🔒 NEVER set resolvedJobId from row.id unless it is UUID
          const candidate = row.id != null ? String(row.id) : null;
          if (candidate && looksLikeUuid(candidate)) resolvedJobId = candidate;
          else if (candidate) resolvedJobId = null;

          resolvedJobNo = row.job_no ?? resolvedJobNo ?? null;
          resolvedJobName = row.job_name ? String(row.job_name).trim() : resolvedJobName;
        }
      }
    }

    // 3) If jobRef passed (could be uuid, job_no, or name)
    if (!resolvedJobId && jobRef) {
      const row = await resolveJobRow(owner, jobRef);
      if (row) {
        const candidate = row.id != null ? String(row.id) : null;
        if (candidate && looksLikeUuid(candidate)) resolvedJobId = candidate;
        else resolvedJobId = null; // 🔒 ignore integer ids

        resolvedJobNo = row.job_no ?? resolvedJobNo ?? null;
        resolvedJobName = row.job_name ? String(row.job_name).trim() : resolvedJobName;
      } else {
        // If jobRef is a number-like string, treat as job_no for job_name resolution only
        if (/^\d+$/.test(String(jobRef).trim())) {
          const n = Number(jobRef);
          if (Number.isFinite(n)) resolvedJobNo = resolvedJobNo ?? n;
        } else if (!resolvedJobName) {
          resolvedJobName = String(jobRef).trim();
        }
      }
    }

    // 4) If only name known, try resolving it
    if (!resolvedJobId && resolvedJobName) {
      const row = await resolveJobRow(owner, resolvedJobName);
      if (row) {
        const candidate = row.id != null ? String(row.id) : null;
        if (candidate && looksLikeUuid(candidate)) resolvedJobId = candidate;
        else resolvedJobId = null; // 🔒 ignore integer ids

        resolvedJobNo = row.job_no ?? resolvedJobNo ?? null;
        resolvedJobName = row.job_name ? String(row.job_name).trim() : resolvedJobName;
      }
    }
  } catch {
    // ignore
  }

  // 🔒 FINAL HARD GUARD: job_id MUST be UUID or null
  if (resolvedJobId && !looksLikeUuid(String(resolvedJobId))) {
    console.warn('[PG/transactions] dropping non-uuid resolvedJobId', { resolvedJobId });
    resolvedJobId = null;
  }

  // Keep job "string" field for back-compat with older schemas/handlers.
  // Prefer: jobRef (caller), else uuid job_id, else job_name, else job_no string.
  const job =
    jobRef != null
      ? jobRef
      : resolvedJobId
        ? String(resolvedJobId)
        : resolvedJobName
          ? String(resolvedJobName)
          : resolvedJobNo != null
            ? String(resolvedJobNo)
            : null;

  const jobName = resolvedJobName ? String(resolvedJobName).trim() : null;

  // ✅ (2.1) Content-based dedupe hash (expense/revenue only)
  const shouldDedupeByContent = kind === 'expense' || kind === 'revenue';
  const dedupeHash =
    shouldDedupeByContent
      ? buildTxnDedupeHash({
          owner,
          kind,
          date,
          amountCents,
          source,
          description,
          jobNo: resolvedJobNo,
          jobName
        })
      : null;

  // best-effort idempotency pre-check
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

  // IMPORTANT: do NOT include created_at in cols if you are injecting now() in SQL
  // (your previous version included created_at but didn't add a value -> misalignment)
  const cols = [
    'owner_id',
    'kind',
    'date',
    'description',
    ...(caps.TX_HAS_AMOUNT ? ['amount'] : []),
    'amount_cents',
    'source',
    ...(caps.TX_HAS_JOB_ID ? ['job_id'] : []), // ✅ UUID only
    ...(caps.TX_HAS_JOB_NO ? ['job_no'] : []),
    'job',
    'job_name',
    'category',
    'user_name',
    ...(caps.TX_HAS_SOURCE_MSG_ID ? ['source_msg_id'] : []),
    ...(caps.TX_HAS_MEDIA_URL ? ['media_url'] : []),
    ...(caps.TX_HAS_MEDIA_TYPE ? ['media_type'] : []),
    ...(caps.TX_HAS_MEDIA_TXT ? ['media_transcript'] : []),
    ...(caps.TX_HAS_MEDIA_CONF ? ['media_confidence'] : []),
    // ✅ (2.2) dedupe_hash column
    ...(caps.TX_HAS_DEDUPE_HASH ? ['dedupe_hash'] : []),
    'created_at'
  ];

  const vals = [
    owner,
    kind,
    date,
    description,
    ...(caps.TX_HAS_AMOUNT ? [Number.isFinite(Number(amountMaybe)) ? Number(amountMaybe) : null] : []),
    amountCents,
    source,
    ...(caps.TX_HAS_JOB_ID ? [resolvedJobId ? String(resolvedJobId) : null] : []),
    ...(caps.TX_HAS_JOB_NO ? [resolvedJobNo != null ? Number(resolvedJobNo) : null] : []),
    job,
    jobName,
    category,
    userName ? String(userName).trim() : null,
    ...(caps.TX_HAS_SOURCE_MSG_ID ? [sourceMsgId] : []),
    ...(caps.TX_HAS_MEDIA_URL ? [media?.media_url || null] : []),
    ...(caps.TX_HAS_MEDIA_TYPE ? [media?.media_type || null] : []),
    ...(caps.TX_HAS_MEDIA_TXT ? [media?.media_transcript || null] : []),
    ...(caps.TX_HAS_MEDIA_CONF ? [media?.media_confidence ?? null] : []),
    // ✅ (2.3) dedupe_hash value
    ...(caps.TX_HAS_DEDUPE_HASH ? [dedupeHash] : []),
    // created_at value
    new Date()
  ];

  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');

  const canIdempotent =
    caps.TX_HAS_SOURCE_MSG_ID && !!sourceMsgId && (await detectTransactionsUniqueOwnerSourceMsg());

  // ✅ (2.4) owner_id + dedupe_hash ON CONFLICT (only if unique partial index exists)
  const canDedupeHash =
    caps.TX_HAS_DEDUPE_HASH && !!dedupeHash && (await detectTransactionsUniqueOwnerDedupeHash());

  const conflictTarget = canIdempotent
    ? `(owner_id, source_msg_id) where source_msg_id is not null`
    : canDedupeHash
      ? `(owner_id, dedupe_hash) where dedupe_hash is not null`
      : null;

  const sql = conflictTarget
    ? `
      insert into public.transactions (${cols.join(', ')})
      values (${placeholders})
      on conflict ${conflictTarget}
      do nothing
      returning id
    `
    : `
      insert into public.transactions (${cols.join(', ')})
      values (${placeholders})
      returning id
    `;

  try {
    const res = await queryWithTimeout(sql, vals, timeoutMs);
    if (!res?.rows?.length) return { inserted: false, id: null };
    return { inserted: true, id: res.rows[0].id };
  } catch (e) {
    const msg = String(e?.message || '').toLowerCase();
    const code = String(e?.code || '');

    // ✅ (2.5) Treat either conflict path as potentially unsupported
    const looksConflictUnsupported =
      (canIdempotent || canDedupeHash) &&
      (code === '42P10' ||
        msg.includes('there is no unique or exclusion constraint') ||
        msg.includes('on conflict'));

    if (looksConflictUnsupported) {
      console.warn('[PG/transactions] ON CONFLICT unsupported; retrying without conflict clause');

      // if either uniqueness probe was wrong, stop using it going forward
      if (canIdempotent) TX_HAS_OWNER_SOURCEMSG_UNIQUE = false;
      if (canDedupeHash) TX_HAS_OWNER_DEDUPE_UNIQUE = false;

      const sql2 = `
        insert into public.transactions (${cols.join(', ')})
        values (${placeholders})
        returning id
      `;
      const res2 = await queryWithTimeout(sql2, vals, timeoutMs);
      if (!res2?.rows?.length) return { inserted: false, id: null };
      return { inserted: true, id: res2.rows[0].id };
    }

    throw e;
  }
}


/* -------------------- Time helpers -------------------- */
async function getLatestTimeEvent(ownerId, employeeName) {
  const { rows } = await query(
    `SELECT type, timestamp
       FROM public.time_entries
      WHERE owner_id=$1 AND lower(employee_name)=lower($2)
      ORDER BY timestamp DESC
      LIMIT 1`,
    [String(DIGITS(ownerId)), String(employeeName || '').trim()]
  );
  return rows[0] || null;
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

// Find or create a job by name (case-insensitive on name or job_name).
async function ensureJobByName(ownerId, name) {
  const owner = DIGITS(ownerId);
  const jobName = String(name || '').trim();
  if (!jobName) return null;

  let r = await query(
    `SELECT id, job_no, COALESCE(name, job_name) AS name, active AS is_active
       FROM public.jobs
      WHERE owner_id = $1
        AND (lower(name) = lower($2) OR lower(job_name) = lower($2))
      LIMIT 1`,
    [owner, jobName]
  );
  if (r.rowCount) return r.rows[0];

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
      if (e && e.code === '23505') {
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

/**
 * ✅ createJobIdempotent (CANONICAL)
 */
async function createJobIdempotent({
  ownerId,
  jobName,
  name,
  sourceMsgId,
  status = 'open',
  active = true
} = {}) {
  const owner = DIGITS(ownerId);
  const cleanName = String(jobName || name || '').trim() || 'Untitled Job';
  const msgId = String(sourceMsgId || '').trim() || null;

  if (!owner) throw new Error('Missing ownerId');

  return await withClient(async (client) => {
    await withOwnerAllocLock(owner, client);

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

    const nextNo = await allocateNextJobNo(owner, client);

    try {
      const ins = await client.query(
        `INSERT INTO public.jobs
           (owner_id, job_no, job_name, name, status, active, start_date, created_at, updated_at, source_msg_id)
         VALUES
           ($1, $2, $3, $3, $4, $5, NOW(), NOW(), NOW(), $6)
         RETURNING id, owner_id, job_no,
                   COALESCE(job_name, name) AS job_name,
                   name, active, status, source_msg_id`,
        [owner, nextNo, cleanName, String(status || 'open'), !!active, msgId]
      );
      return { inserted: true, job: ins.rows[0], reason: 'created' };
    } catch (e) {
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
  const owner = DIGITS(ownerId);
  const name = String(rawName || '').trim();
  if (!name) throw new Error('Missing job name');

  const j = await ensureJobByName(owner, name);
  const jobNo = j?.job_no;
  if (!jobNo) throw new Error('Failed to create/resolve job');

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

/**
 * ✅ getActiveJob (compat)
 */
let _HAS_USER_ACTIVE_JOB_TABLE = null;

async function detectUserActiveJobTable() {
  if (_HAS_USER_ACTIVE_JOB_TABLE !== null) return _HAS_USER_ACTIVE_JOB_TABLE;
  try {
    _HAS_USER_ACTIVE_JOB_TABLE = await hasTable('user_active_job');
  } catch {
    _HAS_USER_ACTIVE_JOB_TABLE = false;
  }
  return _HAS_USER_ACTIVE_JOB_TABLE;
}

async function getActiveJob(ownerId, userId = null) {
  const owner = DIGITS(ownerId);
  if (!owner) return null;

  // per-user active job if available
  if (userId && (await detectUserActiveJobTable())) {
    try {
      const sql = `
        select j.job_no, coalesce(j.name, j.job_name) as name
          from public.user_active_job u
          join public.jobs j
            on j.owner_id = u.owner_id
           and j.job_no  = u.job_id
         where u.owner_id = $1
           and u.user_id  = $2
         limit 1
      `;
      const { rows } = await query(sql, [owner, String(userId)]);
      if (rows?.[0]) return rows[0];
    } catch (e) {
      console.warn('[PG/getActiveJob] user_active_job lookup failed (ignored):', e?.message);
    }
  }

  // owner-wide active job fallback
  const act = await query(
    `select coalesce(name, job_name) as name, job_no
       from public.jobs
      where owner_id=$1 and active=true
      order by updated_at desc nulls last, created_at desc
      limit 1`,
    [owner]
  );

  const row = act.rows?.[0] || null;
  if (!row) return null;

  if (!userId) return row.name || null;
  return { job_no: row.job_no, name: row.name };
}


/**
 * ✅ setActiveJob (compat) — FORCE job_no mode for user_active_job.job_id
 * In today's schema:
 * - jobs.job_no is INT
 * - user_active_job.job_id stores job_no (INT)
 * - jobs.id is NOT compatible with user_active_job.job_id
 */
async function setActiveJob(ownerId, userId, jobRef) {
  const owner = DIGITS(ownerId);
  if (!owner) throw new Error('Missing ownerId');

  const ref = String(jobRef || '').trim();

  // 1) Per-user active job (preferred) if table exists
  if (userId && (await detectUserActiveJobTable())) {
    try {
      let jobNo = null;

      if (/^\d+$/.test(ref)) {
        jobNo = Number(ref);
      } else if (ref) {
        // Resolve by name -> create if needed (your helper)
        jobNo = (await ensureJobByName(owner, ref))?.job_no ?? null;
      }

      if (jobNo != null && Number.isFinite(Number(jobNo))) {
        await query(
          `insert into public.user_active_job (owner_id,user_id,job_id,updated_at)
           values ($1,$2,$3,now())
           on conflict (owner_id,user_id) do update
             set job_id=excluded.job_id, updated_at=now()`,
          [owner, String(userId), Number(jobNo)]
        );
        return true;
      }
    } catch (e) {
      console.warn('[PG/setActiveJob] user_active_job upsert failed (ignored):', e?.message);
      // fall through to owner-wide activation
    }
  }

  // 2) Owner-wide activation fallback (jobs.active=true)
  let jobNo = null;
  if (/^\d+$/.test(ref)) jobNo = Number(ref);
  else if (ref) jobNo = (await ensureJobByName(owner, ref))?.job_no ?? null;

  if (!jobNo) throw new Error('Could not resolve job');

  await withClient(async (client) => {
    await client.query(
      `update public.jobs set active=false, updated_at=now()
        where owner_id=$1 and active=true and job_no<>$2`,
      [owner, Number(jobNo)]
    );
    await client.query(
      `update public.jobs set active=true, updated_at=now()
        where owner_id=$1 and job_no=$2`,
      [owner, Number(jobNo)]
    );
  });

  return true;
}


/* ------------------------------------------------------------------ */
/* ✅ Canonical per-identity Active Job                                */
/* ------------------------------------------------------------------ */
let _ACTIVEJOB_CAPS = null;
let _ACTIVEJOB_ID_TYPES = null; // ✅ cache active_job_id column types

async function detectActiveJobCaps() {
  if (_ACTIVEJOB_CAPS) return _ACTIVEJOB_CAPS;

  const caps = {
    users_has_active_job_id: false,
    users_has_active_job_name: false,
    memberships_has_active_job_id: false,
    memberships_has_active_job_name: false,
    user_profiles_has_active_job_id: false,
    user_profiles_has_active_job_name: false,
    has_memberships: false,
    has_user_profiles: false,
    has_users: false,
    has_user_active_job: false
  };

  try {
    caps.has_users = await hasTable('users');
    if (caps.has_users) {
      caps.users_has_active_job_id = await hasColumn('users', 'active_job_id');
      caps.users_has_active_job_name = await hasColumn('users', 'active_job_name');
    }
  } catch {}

  try {
    caps.has_memberships = await hasTable('memberships');
    if (caps.has_memberships) {
      caps.memberships_has_active_job_id = await hasColumn('memberships', 'active_job_id');
      caps.memberships_has_active_job_name = await hasColumn('memberships', 'active_job_name');
    }
  } catch {}

  try {
    caps.has_user_profiles = await hasTable('user_profiles');
    if (caps.has_user_profiles) {
      caps.user_profiles_has_active_job_id = await hasColumn('user_profiles', 'active_job_id');
      caps.user_profiles_has_active_job_name = await hasColumn('user_profiles', 'active_job_name');
    }
  } catch {}

  try {
    caps.has_user_active_job = await detectUserActiveJobTable();
  } catch {}

  _ACTIVEJOB_CAPS = caps;
  return caps;
}

async function detectActiveJobIdColumnTypes() {
  if (_ACTIVEJOB_ID_TYPES) return _ACTIVEJOB_ID_TYPES;
  const out = {
    users: null,
    memberships: null,
    user_profiles: null
  };
  try {
    if (await hasTable('users')) out.users = await getColumnDataType('users', 'active_job_id');
  } catch {}
  try {
    if (await hasTable('memberships')) out.memberships = await getColumnDataType('memberships', 'active_job_id');
  } catch {}
  try {
    if (await hasTable('user_profiles')) out.user_profiles = await getColumnDataType('user_profiles', 'active_job_id');
  } catch {}
  _ACTIVEJOB_ID_TYPES = out;
  return out;
}

function coerceActiveJobIdValue(colType, { jobUuid, jobNo }) {
  const t = String(colType || '').toLowerCase();
  if (!t) return jobUuid || jobNo || null;

  if (t.includes('uuid')) return jobUuid && looksLikeUuid(jobUuid) ? jobUuid : null;
  if (t.includes('int') || t.includes('bigint') || t.includes('smallint')) {
    if (jobNo == null) return null;
    const n = Number(jobNo);
    return Number.isFinite(n) ? n : null;
  }

  // text/other: store uuid if present, else job_no as string
  if (jobUuid) return String(jobUuid);
  if (jobNo != null) return String(jobNo);
  return null;
}

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
    try {
      const j = await ensureJobByName(owner, name);
      if (j) {
        id = j.id ? String(j.id) : id;
        jobNo = j.job_no ?? jobNo;
        name = j.name ? String(j.name).trim() : name;
      }
    } catch {}
  }

  return { id, name, jobNo };
}


async function setActiveJobForIdentity(ownerId, userIdOrPhone, jobId, jobName) {
  const owner = DIGITS(ownerId);
  const userId = DIGITS(userIdOrPhone);

  if (!owner || !userId) throw new Error('setActiveJobForIdentity missing ownerId/userId');

  const caps = await detectActiveJobCaps();
  const types = await detectActiveJobIdColumnTypes();

  // Resolve to a jobNo + name (jobNo-first)
  const resolved = await resolveJobIdAndName(owner, jobId, jobName);
  const name = resolved.name || (jobName ? String(jobName).trim() : null);

  // Prefer numeric job_no whenever possible
  const jobNo =
    resolved.jobNo != null && Number.isFinite(Number(resolved.jobNo)) ? Number(resolved.jobNo) :
    (jobId != null && /^\d+$/.test(String(jobId).trim())) ? Number(jobId) :
    null;

  // Fallback: if we only have a name, attempt to lookup job_no by name (optional best-effort)
  let finalJobNo = jobNo;
  if (!Number.isFinite(finalJobNo) && name) {
    try {
      const r = await query(
        `
        select job_no
          from public.jobs
         where owner_id = $1
           and lower(coalesce(name, job_name)) = lower($2)
         order by job_no desc
         limit 1
        `,
        [owner, String(name)]
      );
      const n = r?.rows?.[0]?.job_no;
      if (n != null && Number.isFinite(Number(n))) finalJobNo = Number(n);
    } catch {}
  }

  // If we still can't resolve a jobNo, fail soft: clear active job in user_active_job if present
  // (but do not throw, keeps UX resilient)
  const jobNoText = Number.isFinite(finalJobNo) ? String(finalJobNo) : null;

  // 1) users
  if (caps.has_users && (caps.users_has_active_job_id || caps.users_has_active_job_name)) {
    try {
      const sets = [];
      const params = [owner, userId];
      let i = 3;

      if (caps.users_has_active_job_id) {
        // ✅ coerce based on column type; supply jobNo (preferred) and (optional) uuid if needed
        const v = coerceActiveJobIdValue(types.users, { jobUuid: null, jobNo: finalJobNo });
        sets.push(`active_job_id = $${i++}`);
        params.push(v);
      }
      if (caps.users_has_active_job_name) {
        sets.push(`active_job_name = $${i++}`);
        params.push(name);
      }
      if (await hasColumn('users', 'updated_at').catch(() => false)) sets.push(`updated_at = now()`);

      if (sets.length) {
        const r = await query(`update public.users set ${sets.join(', ')} where owner_id=$1 and user_id=$2`, params);
        if (r?.rowCount) {
          // keep going; we still want to update user_active_job
        }
      }
    } catch (e) {
      console.warn('[PG/activeJob] users update failed (ignored):', e?.message);
    }
  }

  // 2) memberships
  if (caps.has_memberships && (caps.memberships_has_active_job_id || caps.memberships_has_active_job_name)) {
    try {
      const sets = [];
      const params = [owner, userId];
      let i = 3;

      if (caps.memberships_has_active_job_id) {
        const v = coerceActiveJobIdValue(types.memberships, { jobUuid: null, jobNo: finalJobNo });
        sets.push(`active_job_id = $${i++}`);
        params.push(v);
      }
      if (caps.memberships_has_active_job_name) {
        sets.push(`active_job_name = $${i++}`);
        params.push(name);
      }
      if (await hasColumn('memberships', 'updated_at').catch(() => false)) sets.push(`updated_at = now()`);

      if (sets.length) {
        await query(`update public.memberships set ${sets.join(', ')} where owner_id=$1 and user_id=$2`, params);
      }
    } catch (e) {
      console.warn('[PG/activeJob] memberships update failed (ignored):', e?.message);
    }
  }

  // 3) user_profiles
  if (caps.has_user_profiles && (caps.user_profiles_has_active_job_id || caps.user_profiles_has_active_job_name)) {
    try {
      const sets = [];
      const params = [owner, userId];
      let i = 3;

      if (caps.user_profiles_has_active_job_id) {
        const v = coerceActiveJobIdValue(types.user_profiles, { jobUuid: null, jobNo: finalJobNo });
        sets.push(`active_job_id = $${i++}`);
        params.push(v);
      }
      if (caps.user_profiles_has_active_job_name) {
        sets.push(`active_job_name = $${i++}`);
        params.push(name);
      }
      if (await hasColumn('user_profiles', 'updated_at').catch(() => false)) sets.push(`updated_at = now()`);

      if (sets.length) {
        await query(`update public.user_profiles set ${sets.join(', ')} where owner_id=$1 and user_id=$2`, params);
      }
    } catch (e) {
      console.warn('[PG/activeJob] user_profiles update failed (ignored):', e?.message);
    }
  }

  // 4) user_active_job (✅ store job_no as text; avoids integer=uuid joins forever)
  if (caps.has_user_active_job) {
    try {
      if (!jobNoText) {
        // clear
        await query(`delete from public.user_active_job where owner_id=$1 and user_id=$2`, [owner, String(userId)]);
        return { active_job_id: null, active_job_name: null, source: 'user_active_job' };
      }

      await query(
        `
        insert into public.user_active_job (owner_id, user_id, job_id, updated_at)
        values ($1, $2, $3::text, now())
        on conflict (owner_id, user_id)
        do update set job_id = excluded.job_id, updated_at = now()
        `,
        [owner, String(userId), jobNoText]
      );

      return { active_job_id: jobNoText, active_job_name: name || null, source: 'user_active_job' };
    } catch (e) {
      console.warn('[PG/activeJob] user_active_job write failed (ignored):', e?.message);
    }
  }

  return { active_job_id: jobNoText, active_job_name: name || null, source: 'unknown' };
}


async function getActiveJobForIdentity(ownerId, userIdOrPhone) {
  const owner = DIGITS(ownerId);
  const userId = DIGITS(userIdOrPhone);
  if (!owner || !userId) return null;

  const caps = await detectActiveJobCaps();

  // helper: if id present but no name, resolve via jobs table (UUID or job_no)
  async function enrichIfNeeded(activeId, activeName, source) {
    const id = activeId != null ? activeId : null;
    let name = activeName != null ? String(activeName).trim() : null;

    if (name) return { active_job_id: id, active_job_name: name, source };
    if (id == null) return { active_job_id: null, active_job_name: null, source };

    const s = String(id).trim();

    try {
      // Future schema: UUID job id
      if (looksLikeUuid(s)) {
        const j = await query(
          `select coalesce(name, job_name) as job_name
             from public.jobs
            where owner_id=$1 and id=$2::uuid
            limit 1`,
          [owner, s]
        );
        name = j?.rows?.[0]?.job_name ? String(j.rows[0].job_name).trim() : null;
        return { active_job_id: id, active_job_name: name, source };
      }

      // Current schema: numeric job_no
      if (/^\d+$/.test(s)) {
        const j = await query(
          `select coalesce(name, job_name) as job_name
             from public.jobs
            where owner_id=$1 and job_no=$2::int
            limit 1`,
          [owner, Number(s)]
        );
        name = j?.rows?.[0]?.job_name ? String(j.rows[0].job_name).trim() : null;
        return { active_job_id: id, active_job_name: name, source };
      }
    } catch {
      // ignore
    }

    return { active_job_id: id, active_job_name: null, source };
  }

  // 1) users
  if (caps.has_users && (caps.users_has_active_job_id || caps.users_has_active_job_name)) {
    try {
      const cols = [];
      if (caps.users_has_active_job_id) cols.push('active_job_id');
      if (caps.users_has_active_job_name) cols.push('active_job_name');

      const r = await query(
        `select ${cols.join(', ')} from public.users where owner_id=$1 and user_id=$2 limit 1`,
        [owner, userId]
      );

      const row = r?.rows?.[0];
      if (row && (row.active_job_id != null || row.active_job_name != null)) {
        const out = await enrichIfNeeded(row.active_job_id ?? null, row.active_job_name ?? null, 'users');
        if (out?.active_job_id != null || out?.active_job_name) return out;
      }
    } catch (e) {
      console.warn('[PG/activeJob] users read failed (ignored):', e?.message);
    }
  }

  // 2) memberships (self-disabling)
  if (
    _MEMBERSHIPS_OK !== false &&
    caps.has_memberships &&
    (caps.memberships_has_active_job_id || caps.memberships_has_active_job_name)
  ) {
    try {
      const membershipsExists = await hasTable('memberships').catch(() => false);
      if (!membershipsExists) {
        _MEMBERSHIPS_OK = false; // permanently stop trying
      } else {
        _MEMBERSHIPS_OK = true;

        const cols = [];
        if (caps.memberships_has_active_job_id) cols.push('active_job_id');
        if (caps.memberships_has_active_job_name) cols.push('active_job_name');

        if (cols.length) {
          const r = await query(
            `select ${cols.join(', ')} from public.memberships where owner_id=$1 and user_id=$2 limit 1`,
            [owner, userId]
          );

          const row = r?.rows?.[0];
          if (row && (row.active_job_id != null || row.active_job_name != null)) {
            const out = await enrichIfNeeded(row.active_job_id ?? null, row.active_job_name ?? null, 'memberships');
            if (out?.active_job_id != null || out?.active_job_name) return out;
          }
        }
      }
    } catch (e) {
      const msg = String(e?.message || '').toLowerCase();
      const code = String(e?.code || '');

      if (code === '42P01' || (msg.includes('memberships') && msg.includes('does not exist'))) {
        _MEMBERSHIPS_OK = false; // permanently stop trying
        // swallow
      } else {
        console.warn('[PG/activeJob] memberships read failed (ignored):', e?.message);
      }
    }
  }

  // 3) user_profiles
  if (caps.has_user_profiles && (caps.user_profiles_has_active_job_id || caps.user_profiles_has_active_job_name)) {
    try {
      const cols = [];
      if (caps.user_profiles_has_active_job_id) cols.push('active_job_id');
      if (caps.user_profiles_has_active_job_name) cols.push('active_job_name');

      const r = await query(
        `select ${cols.join(', ')} from public.user_profiles where owner_id=$1 and user_id=$2 limit 1`,
        [owner, userId]
      );

      const row = r?.rows?.[0];
      if (row && (row.active_job_id != null || row.active_job_name != null)) {
        const out = await enrichIfNeeded(row.active_job_id ?? null, row.active_job_name ?? null, 'user_profiles');
        if (out?.active_job_id != null || out?.active_job_name) return out;
      }
    } catch (e) {
      console.warn('[PG/activeJob] user_profiles read failed (ignored):', e?.message);
    }
  }

    // 4) user_active_job (job_no stored as text)
if (caps.has_user_active_job) {
  try {
    const r = await query(
      `
      select
        u.job_id as active_job_id,
        coalesce(j.name, j.job_name) as active_job_name
      from public.user_active_job u
      join public.jobs j
        on j.owner_id = u.owner_id
       and (u.job_id::text ~ '^\\d+$')
       and j.job_no = (u.job_id::text)::int
      where u.owner_id = $1 and u.user_id = $2
      limit 1
      `,
      [owner, String(userId)]
    );

    const row = r?.rows?.[0];
    if (row && (row.active_job_id != null || row.active_job_name != null)) {
      const out = await enrichIfNeeded(row.active_job_id ?? null, row.active_job_name ?? null, 'user_active_job');
      if (out?.active_job_id != null || out?.active_job_name) return out;
    }
  } catch (e) {
    console.warn('[PG/activeJob] user_active_job read failed (ignored):', e?.message);
  }
}

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
    `INSERT INTO public.users (user_id, owner_id, onboarding_in_progress, subscription_tier, dashboard_token, created_at)
     VALUES ($1,$2,$3,'basic',$4,NOW())
     ON CONFLICT (user_id) DO UPDATE SET onboarding_in_progress=EXCLUDED.onboarding_in_progress
     RETURNING *`,
    [uid, oid, onboarding_in_progress, token]
  );
  return rows[0];
}

async function saveUserProfile(p) {
  const keys = Object.keys(p);
  const vals = Object.values(p);
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

// ---------- EXCEL EXPORT (lazy load) ----------
let ExcelJS = null;
async function exportTimesheetXlsx(opts) {
  if (!ExcelJS) ExcelJS = require('exceljs');

  const { ownerId, startIso, endIso, employeeName, tz = 'America/Toronto' } = opts;
  const owner = DIGITS(ownerId);
  const params = employeeName ? [owner, startIso, endIso, tz, employeeName] : [owner, startIso, endIso, tz];

  const { rows } = await queryWithTimeout(
    `SELECT te.employee_name,
            te.type,
            te.timestamp,
            COALESCE(j.name, j.job_name, '') AS job_name,
            COALESCE(te.tz, $4)              AS tz
       FROM public.time_entries te
       LEFT JOIN public.jobs j
         ON j.owner_id = $1 AND j.job_no = te.job_no
      WHERE te.owner_id = $1
        AND te.timestamp >= $2::timestamptz
        AND te.timestamp <= $3::timestamptz
        ${employeeName ? 'AND te.employee_name = $5' : ''}
      ORDER BY te.employee_name, te.timestamp`,
    params,
    15000
  );

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Timesheet');
  ws.columns = [
    { header: 'Employee', key: 'employee_name' },
    { header: 'Type', key: 'type' },
    { header: 'Timestamp', key: 'timestamp' },
    { header: 'Job', key: 'job_name' }
  ];
  (rows || []).forEach((r) => ws.addRow(r));

  const buf = await wb.xlsx.writeBuffer();
  const id = crypto.randomBytes(12).toString('hex');
  const filename = `timesheet_${startIso.slice(0, 10)}_${endIso.slice(0, 10)}${
    employeeName ? '_' + employeeName.replace(/\s+/g, '_') : ''
  }.xlsx`;

  await query(
    `INSERT INTO public.file_exports (id, owner_id, filename, content_type, bytes, created_at)
     VALUES ($1,$2,$3,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',$4,NOW())`,
    [id, owner, filename, Buffer.from(buf)]
  );
  const base = process.env.PUBLIC_BASE_URL || '';
  return { url: `${base}/exports/${id}`, id, filename };
}

// ---------- PDF EXPORT (lazy load) ----------
let PDFDocument = null;
async function exportTimesheetPdf(opts) {
  if (!PDFDocument) PDFDocument = require('pdfkit');

  const { ownerId, startIso, endIso, employeeName, tz = 'America/Toronto' } = opts;
  const owner = DIGITS(ownerId);
  const params = employeeName ? [owner, startIso, endIso, tz, employeeName] : [owner, startIso, endIso, tz];

  const { rows } = await queryWithTimeout(
    `SELECT te.employee_name,
            te.type,
            te.timestamp,
            COALESCE(j.name, j.job_name, '') AS job_name,
            COALESCE(te.tz, $4)              AS tz
       FROM public.time_entries te
       LEFT JOIN public.jobs j
         ON j.owner_id = $1 AND j.job_no = te.job_no
      WHERE te.owner_id = $1
        AND te.timestamp >= $2::timestamptz
        AND te.timestamp <= $3::timestamptz
        ${employeeName ? 'AND te.employee_name = $5' : ''}
      ORDER BY te.employee_name, te.timestamp`,
    params,
    15000
  );

  const doc = new PDFDocument({ margin: 40 });
  const chunks = [];
  doc.on('data', (d) => chunks.push(d));
  const done = new Promise((r) => doc.on('end', r));

  doc.fontSize(16).text(`Timesheet ${startIso.slice(0, 10)} – ${endIso.slice(0, 10)}`, { align: 'center' }).moveDown();

  (rows || []).forEach((r) => {
    const ts = new Date(r.timestamp);
    doc
      .fontSize(10)
      .text(
        `${r.employee_name} | ${r.type} | ${formatInTimeZone(ts, r.tz, 'yyyy-MM-dd HH:mm')} | ${r.job_name || ''}`
      );
  });

  doc.end();
  await done;
  const buf = Buffer.concat(chunks);

  const id = crypto.randomBytes(12).toString('hex');
  const filename = `timesheet_${startIso.slice(0, 10)}_${endIso.slice(0, 10)}${
    employeeName ? '_' + employeeName.replace(/\s+/g, '_') : ''
  }.pdf`;

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

// ---------- Pending actions ----------
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

// ✅ SMART delete:
// - deletePendingAction(uuid) works
// - deletePendingAction({ ownerId, userId, kind }) also works (routes to deletePendingActionByKind)
// - deletePendingAction(pendingRow) also works (uses .id or .owner_id + .user_id + .kind)
async function deletePendingAction(arg) {
  // simple uuid string
  const looksUuid = (s) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s || '').trim());

  // 1) If passed an id string, delete by id
  if (typeof arg === 'string' || typeof arg === 'number') {
    const id = String(arg).trim();
    if (looksUuid(id)) {
      await query(`delete from public.pending_actions where id=$1`, [id]);
      return;
    }
    // If someone passes "123" or "[object Object]" accidentally, do nothing safely
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

    if (ownerId && userId && kind && typeof deletePendingActionByKind === 'function') {
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

/* ---------- Pending Actions (Kind-aware helpers) ---------- */

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
// ✅ Compatibility aliases (some newer files expect these names)
async function upsertPendingAction({ ownerId, userId, kind, payload, ttlSeconds } = {}) {
  // Your schema uses created_at TTL, not expires_at. We ignore ttlSeconds safely.
  return savePendingAction({ ownerId, userId, kind, payload });
}

async function clearPendingAction({ ownerId, userId, kind } = {}) {
  return deletePendingActionByKind({ ownerId, userId, kind });
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
    // Prefer job_id if present, else fall back to job string field matching
    const caps = await detectTransactionsCapabilities().catch(() => ({ TX_HAS_JOB_ID: false }));
    if (caps?.TX_HAS_JOB_ID) where += ' AND job_id::text = $2';
    else where += ' AND job::text = $2';
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

async function getOwnerJobsFinance(ownerId) {
  const ownerKey = String(ownerId);

  // If transactions.job_id is missing, this join will fail. We fallback gracefully.
  const caps = await detectTransactionsCapabilities().catch(() => ({ TX_HAS_JOB_ID: false }));

  if (!caps?.TX_HAS_JOB_ID) {
    const { rows } = await query(
      `
      select
        j.id,
        j.name,
        j.status,
        j.created_at,
        j.completed_at,
        0::bigint as revenue_cents,
        0::bigint as expense_cents
      from jobs j
      where j.owner_id::text = $1
      order by j.created_at desc
      `,
      [ownerKey]
    );

    return rows.map((r) => ({
      job_id: r.id,
      name: r.name,
      status: r.status,
      created_at: r.created_at,
      completed_at: r.completed_at,
      revenue_cents: 0,
      expense_cents: 0,
      profit_cents: 0,
      margin_pct: null
    }));
  }

  const { rows } = await query(
    `
      select
        j.id,
        j.name,
        j.status,
        j.created_at,
        j.completed_at,
        coalesce(sum(case when t.kind = 'revenue' then t.amount_cents end), 0) as revenue_cents,
        coalesce(sum(case when t.kind = 'expense' then t.amount_cents end), 0) as expense_cents
      from jobs j
      left join transactions t
        on t.owner_id::text = j.owner_id::text
       and t.job_id        = j.id
      where j.owner_id::text = $1
      group by j.id
      order by j.created_at desc
    `,
    [ownerKey]
  );

  return rows.map((r) => {
    const revenue = Number(r.revenue_cents) || 0;
    const expense = Number(r.expense_cents) || 0;
    const profit = revenue - expense;
    const margin_pct = revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : null;

    return {
      job_id: r.id,
      name: r.name,
      status: r.status,
      created_at: r.created_at,
      completed_at: r.completed_at,
      revenue_cents: revenue,
      expense_cents: expense,
      profit_cents: profit,
      margin_pct
    };
  });
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

function normalizeVendorString(v) {
  let s = String(v || '').trim();
  s = s.replace(/\s+/g, ' ');
  if (!s) return 'Unknown Store';

  s = s.replace(/\s+#\d+$/i, '');
  s = s.replace(/\s+(inc|ltd|limited)\.?$/i, '');
  s = s.trim();

  const key = s.toLowerCase();
  const ALIASES = {
    'home depot': 'Home Depot',
    'the home depot': 'Home Depot',
    homedepot: 'Home Depot',
    'convoy supply': 'Convoy Supply',
    convoy: 'Convoy Supply',
    rona: 'RONA',
    lowes: "Lowe's",
    'lowe’s': "Lowe's",
    gentek: 'Gentek',
    gentech: 'Gentek'
  };

  return ALIASES[key] || s;
}

async function normalizeVendorName(_ownerId, vendor) {
  return normalizeVendorString(vendor);
}

async function upsertCategoryRule({ ownerId, kind = 'expense', vendor, keyword = null, category, weight = 10 } = {}) {
  const owner = String(ownerId || '').replace(/\D/g, '');
  const k = String(kind || 'expense').trim() || 'expense';

  const vendorNorm = vendor ? normalizeVendorString(vendor) : null;
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
  const vendorNorm = vendor ? normalizeVendorString(vendor) : null;
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
// Cache detected columns on public.time_entries
let SUPPORTS_CREATED_BY = null;
let SUPPORTS_USER_ID = null;
let SUPPORTS_SOURCE_MSG_ID = null;
let TE_HAS_OWNER_USER_SOURCEMSG_UNIQUE = null;

async function detectTimeEntriesCapabilities() {
  if (SUPPORTS_CREATED_BY !== null && SUPPORTS_USER_ID !== null && SUPPORTS_SOURCE_MSG_ID !== null) {
    return { SUPPORTS_CREATED_BY, SUPPORTS_USER_ID, SUPPORTS_SOURCE_MSG_ID };
  }

  try {
    const { rows } = await query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'time_entries'`
    );
    const names = new Set((rows || []).map((r) => String(r.column_name).toLowerCase()));
    SUPPORTS_CREATED_BY = names.has('created_by');
    SUPPORTS_USER_ID = names.has('user_id');
    SUPPORTS_SOURCE_MSG_ID = names.has('source_msg_id');
  } catch {
    SUPPORTS_CREATED_BY = false;
    SUPPORTS_USER_ID = false;
    SUPPORTS_SOURCE_MSG_ID = false;
  }

  return { SUPPORTS_CREATED_BY, SUPPORTS_USER_ID, SUPPORTS_SOURCE_MSG_ID };
}

async function detectTimeEntriesUniqueOwnerUserSourceMsg() {
  if (TE_HAS_OWNER_USER_SOURCEMSG_UNIQUE !== null) return TE_HAS_OWNER_USER_SOURCEMSG_UNIQUE;
  try {
    const { rows } = await query(
      `
      select pg_get_indexdef(ix.indexrelid) as def
        from pg_class t
        join pg_namespace n on n.oid=t.relnamespace
        join pg_index ix on ix.indrelid=t.oid
       where n.nspname='public'
         and t.relname='time_entries'
         and ix.indisunique=true
      `
    );
    const defs = (rows || []).map((r) => String(r.def || '').toLowerCase());
    TE_HAS_OWNER_USER_SOURCEMSG_UNIQUE = defs.some(
      (d) => d.includes('(owner_id') && d.includes('user_id') && d.includes('source_msg_id')
    );
  } catch {
    TE_HAS_OWNER_USER_SOURCEMSG_UNIQUE = false;
  }
  return TE_HAS_OWNER_USER_SOURCEMSG_UNIQUE;
}

// ✅ aligned with timeclock.js: accepts { max } OR { maxInWindow }
async function checkTimeEntryLimit(ownerId, createdBy, opts = {}) {
  const windowSec = Number(opts.windowSec ?? 30);
  const maxInWindow = Number(opts.maxInWindow ?? opts.max ?? 8);

  const owner = DIGITS(ownerId);
  const actor = DIGITS(createdBy || owner);
  const windowIntervalExpr = `(($3::text || ' seconds')::interval)`;

  try {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n
         FROM public.time_entries
        WHERE owner_id=$1
          AND user_id=$2
          AND created_at >= NOW() - ${windowIntervalExpr}`,
      [owner, actor, windowSec]
    );
    const n = rows?.[0]?.n ?? 0;
    return { ok: n < maxInWindow, n, limit: maxInWindow, windowSec };
  } catch (eUser) {
    const msg = String(eUser?.message || '').toLowerCase();
    if (!msg.includes('column "user_id" does not exist')) {
      return { ok: true, n: 0, limit: Infinity, windowSec: 0 };
    }
  }

  try {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n
         FROM public.time_entries
        WHERE owner_id=$1
          AND COALESCE(created_by,$2::text) = $2::text
          AND created_at >= NOW() - ${windowIntervalExpr}`,
      [owner, actor, windowSec]
    );
    const n = rows?.[0]?.n ?? 0;
    return { ok: n < maxInWindow, n, limit: maxInWindow, windowSec };
  } catch (eCreated) {
    const msg = String(eCreated?.message || '').toLowerCase();
    if (!msg.includes('column "created_by" does not exist')) {
      return { ok: true, n: 0, limit: Infinity, windowSec: 0 };
    }
  }

  try {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n
         FROM public.time_entries
        WHERE owner_id=$1
          AND created_at >= NOW() - ${windowIntervalExpr}`,
      [owner, windowSec]
    );
    const n = rows?.[0]?.n ?? 0;
    return { ok: n < maxInWindow, n, limit: maxInWindow, windowSec };
  } catch {
    return { ok: true, n: 0, limit: Infinity, windowSec: 0 };
  }
}

// ---------- Job-aware time entry ----------
async function logTimeEntryWithJob(ownerId, employeeName, type, ts, jobName, tz, extras = {}) {
  let jobNo = null;

  try {
    if (jobName && String(jobName).trim()) {
      const j = await ensureJobByName(ownerId, jobName);
      jobNo = j?.job_no ?? null;
    } else {
      const j = await resolveJobContext(ownerId, { require: false });
      jobNo = j?.job_no ?? null;
    }
  } catch (e) {
    console.warn('[PG/logTimeEntryWithJob] job resolve failed:', e?.message);
  }

  return await logTimeEntry(ownerId, employeeName, type, ts, jobNo, tz, extras);
}

async function logTimeEntry(ownerId, employeeName, type, ts, jobNo, tz, extras = {}) {
  const tsIso = new Date(ts).toISOString();
  const zone = tz || 'America/Toronto';

  const ownerDigits = DIGITS(ownerId);
  const actorDigits = DIGITS(extras?.requester_id || ownerId);

  const ownerSafe = ownerDigits || actorDigits || '0';
  const actorSafe = actorDigits || ownerDigits || '0';

  const local = formatInTimeZone(tsIso, zone, 'yyyy-MM-dd HH:mm:ss');

  if (SUPPORTS_USER_ID === null || SUPPORTS_CREATED_BY === null || SUPPORTS_SOURCE_MSG_ID === null) {
    await detectTimeEntriesCapabilities().catch((e) =>
      console.error('[PG/logTimeEntry] detection failed:', e?.message)
    );
  }

  const cols = ['owner_id', 'employee_name', 'type', 'timestamp', 'job_no', 'tz', 'local_time'];
  const vals = [ownerSafe, employeeName, type, tsIso, jobNo, zone, local];

  if (SUPPORTS_USER_ID) {
    cols.push('user_id');
    vals.push(actorSafe);
  }

  if (SUPPORTS_CREATED_BY) {
    cols.push('created_by');
    vals.push(actorSafe);
  }

  const sourceMsgId = String(extras?.source_msg_id || '').trim() || null;
  if (SUPPORTS_SOURCE_MSG_ID && sourceMsgId) {
    cols.push('source_msg_id');
    vals.push(sourceMsgId);
  }

  cols.push('created_at');
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ') + ', NOW()';

  const canIdempotent =
    SUPPORTS_SOURCE_MSG_ID &&
    SUPPORTS_USER_ID &&
    !!sourceMsgId &&
    (await detectTimeEntriesUniqueOwnerUserSourceMsg().catch(() => false));

  const sql = canIdempotent
    ? `
      INSERT INTO public.time_entries (${cols.join(', ')})
      VALUES (${placeholders})
      ON CONFLICT (owner_id, user_id, source_msg_id) DO NOTHING
      RETURNING id
    `
    : `
      INSERT INTO public.time_entries (${cols.join(', ')})
      VALUES (${placeholders})
      RETURNING id
    `;

  try {
    const { rows } = await query(sql, vals);
    return rows?.[0]?.id || null;
  } catch (e) {
    const msg = String(e?.message || '').toLowerCase();
    const code = String(e?.code || '');
    if (canIdempotent && (code === '42P10' || msg.includes('there is no unique') || msg.includes('on conflict'))) {
      TE_HAS_OWNER_USER_SOURCEMSG_UNIQUE = false;
      const sql2 = `
        INSERT INTO public.time_entries (${cols.join(', ')})
        VALUES (${placeholders})
        RETURNING id
      `;
      const { rows: rows2 } = await query(sql2, vals);
      return rows2?.[0]?.id || null;
    }
    throw e;
  }
}

async function moveLastLogToJob(ownerId, userName, jobRef) {
  const owner = DIGITS(ownerId);
  if (!owner) throw new Error('Missing ownerId');

  let jobNo = null;
  const s = String(jobRef || '').trim();
  if (/^\d+$/.test(s)) jobNo = Number(s);
  else if (s) jobNo = (await ensureJobByName(owner, s))?.job_no || null;

  if (!jobNo) throw new Error('Could not resolve job');

  const { rows } = await query(
    `update public.time_entries t
        set job_no=$1
      where t.id = (
        select id from public.time_entries
         where owner_id=$2 and lower(employee_name)=lower($3)
         order by timestamp desc limit 1
      )
      returning id, type, timestamp`,
    [jobNo, owner, String(userName)]
  );
  return rows[0] || null;
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
  getOwnerJobsFinance,
  getOwnerMonthlyFinance,
  getOwnerCategoryBreakdown,
  getOwnerVendorBreakdown,

  exportTimesheetXlsx,
  exportTimesheetPdf,
  getFileExport,
  upsertPendingAction,
  deletePendingAction,
  getPendingActionByKind,
  deletePendingActionByKind,
  getMostRecentPendingActionForUser,


  // kept helpers (if other files import them)
  getJobByName,
  getJobBySourceMsg,

  // optional: debugging / inspection
  detectUserActiveJobJobIdType,
  userActiveJobJoinMode,

  // internal helpers occasionally useful
  resolveJobRow,
  getColumnDataType
};
