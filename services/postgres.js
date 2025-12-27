// services/postgres.js (ENV + Pool drop-in)
// ------------------------------------------------------------
const { Pool } = require('pg');
const crypto = require('crypto');

// Load date-fns-tz ONCE here; other places should reuse helpers below.
const { formatInTimeZone } = require('date-fns-tz');

/* ---------- Environment (robust) ---------- */
const env = process.env;

// Prefer DATABASE_URL; allow common alternates for hosts that rename it
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
  PGSSLMODE === 'require' ||
  /supabase\.co|render\.com|herokuapp\.com|aws|gcp|azure/i.test(DB_URL);

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
  throw new Error(
    "Postgres not configured. Set DATABASE_URL in config/.env or PGHOST/PGDATABASE/etc."
  );
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
      await new Promise(r => setTimeout(r, attempt * 200));
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
  return withClient(async client => {
    const timeoutMs = Math.max(0, Number(ms) | 0);
    await client.query(`SET LOCAL statement_timeout = '${timeoutMs}ms'`);
    return client.query(sql, params);
  }, { useTransaction: true });
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

async function hasColumn(table, col) {
  const r = await query(
    `select 1
       from information_schema.columns
      where table_schema='public'
        and table_name=$1
        and column_name=$2
      limit 1`,
    [table, col]
  );
  return (r?.rows?.length || 0) > 0;
}

let TX_HAS_SOURCE_MSG_ID = null;
let TX_HAS_AMOUNT        = null;
let TX_HAS_MEDIA_URL     = null;
let TX_HAS_MEDIA_TYPE    = null;
let TX_HAS_MEDIA_TXT     = null;
let TX_HAS_MEDIA_CONF    = null;

let TX_HAS_OWNER_SOURCEMSG_UNIQUE = null;

async function detectTransactionsCapabilities() {
  if (
    TX_HAS_SOURCE_MSG_ID !== null &&
    TX_HAS_AMOUNT !== null &&
    TX_HAS_MEDIA_URL !== null &&
    TX_HAS_MEDIA_TYPE !== null &&
    TX_HAS_MEDIA_TXT !== null &&
    TX_HAS_MEDIA_CONF !== null
  ) {
    return {
      TX_HAS_SOURCE_MSG_ID,
      TX_HAS_AMOUNT,
      TX_HAS_MEDIA_URL,
      TX_HAS_MEDIA_TYPE,
      TX_HAS_MEDIA_TXT,
      TX_HAS_MEDIA_CONF
    };
  }

  try {
    const { rows } = await query(
      `select column_name
         from information_schema.columns
        where table_schema='public'
          and table_name='transactions'`
    );
    const names = new Set(rows.map(r => String(r.column_name).toLowerCase()));

    TX_HAS_SOURCE_MSG_ID = names.has('source_msg_id');
    TX_HAS_AMOUNT        = names.has('amount');
    TX_HAS_MEDIA_URL     = names.has('media_url');
    TX_HAS_MEDIA_TYPE    = names.has('media_type');
    TX_HAS_MEDIA_TXT     = names.has('media_transcript');
    TX_HAS_MEDIA_CONF    = names.has('media_confidence');
  } catch (e) {
    console.warn('[PG/transactions] detect capabilities failed (fail-open):', e?.message);
    TX_HAS_SOURCE_MSG_ID = false;
    TX_HAS_AMOUNT        = false;
    TX_HAS_MEDIA_URL     = false;
    TX_HAS_MEDIA_TYPE    = false;
    TX_HAS_MEDIA_TXT     = false;
    TX_HAS_MEDIA_CONF    = false;
  }

  return {
    TX_HAS_SOURCE_MSG_ID,
    TX_HAS_AMOUNT,
    TX_HAS_MEDIA_URL,
    TX_HAS_MEDIA_TYPE,
    TX_HAS_MEDIA_TXT,
    TX_HAS_MEDIA_CONF
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

    const defs = rows.map(r => String(r.def || '').toLowerCase());
    TX_HAS_OWNER_SOURCEMSG_UNIQUE = defs.some(d => d.includes('(owner_id') && d.includes('source_msg_id'));
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

/**
 * ✅ insertTransaction()
 * Schema-aware insert into public.transactions with optional media fields.
 */
async function insertTransaction(opts = {}, { timeoutMs = 4000 } = {}) {
  const owner = DIGITS(opts.ownerId || opts.owner_id);
  const kind = String(opts.kind || '').trim();
  const date = String(opts.date || '').trim();
  const description = String(opts.description || '').trim() || 'Unknown';

  const amountCents = Number(opts.amount_cents ?? opts.amountCents ?? 0) || 0;
  const amountMaybe = opts.amount;

  const source = String(opts.source || '').trim() || 'Unknown';
  const job = (opts.job == null ? null : String(opts.job).trim() || null);
  const jobName = (opts.job_name ?? opts.jobName ?? job);
  const category = (opts.category == null ? null : String(opts.category).trim() || null);
  const userName = (opts.user_name ?? opts.userName ?? null);
  const sourceMsgId = String(opts.source_msg_id ?? opts.sourceMsgId ?? '').trim() || null;

  if (!owner) throw new Error('insertTransaction missing ownerId');
  if (!kind) throw new Error('insertTransaction missing kind');
  if (!date) throw new Error('insertTransaction missing date');
  if (!amountCents || amountCents <= 0) throw new Error('insertTransaction invalid amount_cents');

  const caps = await detectTransactionsCapabilities();
  const media = normalizeMediaMeta(opts.mediaMeta || opts.media_meta || null);

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

  const cols = [
    'owner_id',
    'kind',
    'date',
    'description',
    ...(caps.TX_HAS_AMOUNT ? ['amount'] : []),
    'amount_cents',
    'source',
    'job',
    'job_name',
    'category',
    'user_name',
    ...(caps.TX_HAS_SOURCE_MSG_ID ? ['source_msg_id'] : []),
    ...(caps.TX_HAS_MEDIA_URL ? ['media_url'] : []),
    ...(caps.TX_HAS_MEDIA_TYPE ? ['media_type'] : []),
    ...(caps.TX_HAS_MEDIA_TXT ? ['media_transcript'] : []),
    ...(caps.TX_HAS_MEDIA_CONF ? ['media_confidence'] : []),
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
    job,
    jobName ? String(jobName).trim() : null,
    category,
    userName ? String(userName).trim() : null,
    ...(caps.TX_HAS_SOURCE_MSG_ID ? [sourceMsgId] : []),
    ...(caps.TX_HAS_MEDIA_URL ? [media?.media_url || null] : []),
    ...(caps.TX_HAS_MEDIA_TYPE ? [media?.media_type || null] : []),
    ...(caps.TX_HAS_MEDIA_TXT ? [media?.media_transcript || null] : []),
    ...(caps.TX_HAS_MEDIA_CONF ? [media?.media_confidence ?? null] : [])
  ];

  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');

  const canIdempotent =
    caps.TX_HAS_SOURCE_MSG_ID &&
    !!sourceMsgId &&
    (await detectTransactionsUniqueOwnerSourceMsg());

  const sql = canIdempotent
    ? `
      insert into public.transactions (${cols.join(', ')})
      values (${placeholders}, now())
      on conflict (owner_id, source_msg_id)
      do nothing
      returning id
    `
    : `
      insert into public.transactions (${cols.join(', ')})
      values (${placeholders}, now())
      returning id
    `;

  try {
    const res = await queryWithTimeout(sql, vals, timeoutMs);
    if (!res?.rows?.length) return { inserted: false, id: null };
    return { inserted: true, id: res.rows[0].id };
  } catch (e) {
    const msg = String(e?.message || '').toLowerCase();
    const code = String(e?.code || '');
    const looksConflictUnsupported =
      canIdempotent &&
      (code === '42P10' || msg.includes('there is no unique or exclusion constraint') || msg.includes('on conflict'));

    if (looksConflictUnsupported) {
      console.warn('[PG/transactions] ON CONFLICT unsupported; retrying without conflict clause');
      TX_HAS_OWNER_SOURCEMSG_UNIQUE = false;
      const sql2 = `
        insert into public.transactions (${cols.join(', ')})
        values (${placeholders}, now())
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
// Robust against races and job_no duplicates: allocate job_no under advisory lock.
async function ensureJobByName(ownerId, name) {
  const owner   = DIGITS(ownerId);
  const jobName = String(name || '').trim();
  if (!jobName) return null;

  // 1) Try to find existing by either column
  let r = await query(
    `SELECT job_no, COALESCE(name, job_name) AS name, active AS is_active
       FROM public.jobs
      WHERE owner_id = $1
        AND (lower(name) = lower($2) OR lower(job_name) = lower($2))
      LIMIT 1`,
    [owner, jobName]
  );
  if (r.rowCount) return r.rows[0];

  // 2) Create safely with explicit job_no in a serialized transaction
  return await withClient(async (client) => {
    await withOwnerAllocLock(owner, client);

    const again = await client.query(
      `SELECT job_no, COALESCE(name, job_name) AS name, active AS is_active
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
         RETURNING job_no, COALESCE(name, job_name) AS name, active AS is_active`,
        [owner, nextNo, jobName, jobName]
      );
      return ins.rows[0];
    } catch (e) {
      if (e && e.code === '23505') {
        const final = await client.query(
          `SELECT job_no, COALESCE(name, job_name) AS name, active AS is_active
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
    `SELECT job_no, COALESCE(name, job_name) AS name
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
 * - supports { jobName } or { name }
 * - idempotent by sourceMsgId if unique constraint exists (best effort)
 * - also avoids duplicates by (owner_id, job_name case-insensitive) if already exists
 * - allocates job_no under per-owner advisory lock
 */
async function createJobIdempotent({ ownerId, jobName, name, sourceMsgId, status = 'open', active = true } = {}) {
  const owner = DIGITS(ownerId);
  const cleanName = String(jobName || name || '').trim() || 'Untitled Job';
  const msgId = String(sourceMsgId || '').trim() || null;

  if (!owner) throw new Error('Missing ownerId');

  return await withClient(async (client) => {
    await withOwnerAllocLock(owner, client);

    // 1) If msgId, check if job already created for that msg
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

    // 2) If same name exists, return it
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

    // 3) allocate next job_no
    const nextNo = await allocateNextJobNo(owner, client);

    // 4) insert
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
      // If msg id raced, fetch it
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
      // If name raced, fetch by name
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
  const name  = String(rawName || '').trim();
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
    `SELECT job_no, COALESCE(name, job_name) AS name, active, updated_at
       FROM public.jobs
      WHERE owner_id=$1 AND job_no=$2
      LIMIT 1`,
    [owner, jobNo]
  );
  const final = rows[0] || { job_no: jobNo, name, active: true };
  console.info('[PG] activated job', { owner, job_no: final.job_no, name: final.name });
  return final;
}

/**
 * ✅ getActiveJob (compat)
 * - If user_active_job exists and userId provided -> use it
 * - Else -> fallback to jobs.active=true (latest)
 * Returns:
 *  - if userId provided: { job_no, name } or null
 *  - if userId omitted: string job name or null (back-compat with handlers/media.js)
 */
let _HAS_USER_ACTIVE_JOB_TABLE = null;

async function detectUserActiveJobTable() {
  if (_HAS_USER_ACTIVE_JOB_TABLE !== null) return _HAS_USER_ACTIVE_JOB_TABLE;
  try {
    const r = await query(
      `select 1
         from information_schema.tables
        where table_schema='public'
          and table_name='user_active_job'
        limit 1`
    );
    _HAS_USER_ACTIVE_JOB_TABLE = (r?.rows?.length || 0) > 0;
  } catch {
    _HAS_USER_ACTIVE_JOB_TABLE = false;
  }
  return _HAS_USER_ACTIVE_JOB_TABLE;
}

async function getActiveJob(ownerId, userId = null) {
  const owner = DIGITS(ownerId);
  if (!owner) return null;

  // Prefer per-user active job if available
  if (userId && (await detectUserActiveJobTable())) {
    try {
      const { rows } = await query(
        `select j.job_no, coalesce(j.name, j.job_name) as name
           from public.user_active_job u
           join public.jobs j
             on j.owner_id=u.owner_id and j.id=u.job_id
          where u.owner_id=$1 and u.user_id=$2
          limit 1`,
        [owner, String(userId)]
      );
      if (rows[0]) return rows[0];
    } catch (e) {
      console.warn('[PG/getActiveJob] user_active_job lookup failed (ignored):', e?.message);
    }
  }

  // Owner-wide active job (job_no schema)
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

  // Back-compat: media.js expects a string job name when calling getActiveJob(ownerId)
  if (!userId) return row.name || null;

  return { job_no: row.job_no, name: row.name };
}

/**
 * ✅ setActiveJob (compat)
 * If your system is using owner-wide "jobs.active", we activate by job_no/name.
 * If your system is using user_active_job, it will still work when table exists.
 *
 * Accepts:
 *  - jobId (uuid) if user_active_job uses jobs.id
 *  - OR jobNo (int)
 *  - OR jobName (string)
 */
async function setActiveJob(ownerId, userId, jobRef) {
  const owner = DIGITS(ownerId);
  if (!owner) throw new Error('Missing ownerId');

  // If user_active_job exists and caller gave a uuid id, try to use it
  if (userId && (await detectUserActiveJobTable())) {
    const ref = String(jobRef || '').trim();
    const looksUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ref);
    if (looksUuid) {
      await query(
        `insert into public.user_active_job (owner_id,user_id,job_id,updated_at)
         values ($1,$2,$3,now())
         on conflict (owner_id,user_id) do update
           set job_id=excluded.job_id, updated_at=now()`,
        [owner, String(userId), ref]
      );
      return true;
    }
  }

  // Otherwise: owner-wide active job activation by name/job_no
  let jobNo = null;
  const s = String(jobRef || '').trim();
  if (/^\d+$/.test(s)) {
    jobNo = Number(s);
  } else if (s) {
    const j = await ensureJobByName(owner, s);
    jobNo = j?.job_no || null;
  }

  if (!jobNo) throw new Error('Could not resolve job');

  await withClient(async (client) => {
    await client.query(
      `update public.jobs set active=false, updated_at=now()
        where owner_id=$1 and active=true and job_no<>$2`,
      [owner, jobNo]
    );
    await client.query(
      `update public.jobs set active=true, updated_at=now()
        where owner_id=$1 and job_no=$2`,
      [owner, jobNo]
    );
  });

  return true;
}

/**
 * ✅ moveLastLogToJob (job_no schema)
 * Updates most recent time_entries row for employee to new job_no.
 * Accepts jobRef as name or job_no.
 */
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
  await query(`insert into public.kpi_touches (owner_id, job_id, day) values ($1,$2,$3)`, [
    owner,
    jobId || null,
    day
  ]);
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

/* -------------------- Time Limits & Audit (schema-aware, tolerant) -------------------- */

// Cache detected columns on public.time_entries
let SUPPORTS_CREATED_BY = null;
let SUPPORTS_USER_ID = null;
let SUPPORTS_SOURCE_MSG_ID = null;

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
    const names = new Set(rows.map((r) => String(r.column_name).toLowerCase()));
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

async function checkTimeEntryLimit(ownerId, createdBy, { windowSec = 30, maxInWindow = 8 } = {}) {
  const owner = DIGITS(ownerId);
  const actor = DIGITS(createdBy || owner);

  // Prefer per-actor (user_id) if available
  try {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n
         FROM public.time_entries
        WHERE owner_id=$1
          AND user_id=$2
          AND created_at >= NOW() - ($3 || ' seconds')::interval`,
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

  // Fallback to created_by if user_id missing
  try {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n
         FROM public.time_entries
        WHERE owner_id=$1
          AND COALESCE(created_by,$2::text) = $2::text
          AND created_at >= NOW() - ($3 || ' seconds')::interval`,
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

  // Last resort: per-owner window
  try {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n
         FROM public.time_entries
        WHERE owner_id=$1
          AND created_at >= NOW() - ($2 || ' seconds')::interval`,
      [owner, windowSec]
    );
    const n = rows?.[0]?.n ?? 0;
    return { ok: n < maxInWindow, n, limit: maxInWindow, windowSec };
  } catch {
    return { ok: true, n: 0, limit: Infinity, windowSec: 0 };
  }
}

// ---------- Job-aware time entry (delegates to resilient logTimeEntry) ----------
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
  const actorSafe = actorDigits || ownerDigits || '0'; // NEVER NULL

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

  const canIdempotent = SUPPORTS_SOURCE_MSG_ID && SUPPORTS_USER_ID && sourceMsgId;

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

  console.info('[PG/logTimeEntry] EXECUTING', {
    cols,
    actorSafe,
    ownerSafe,
    sourceMsgId: sourceMsgId || undefined,
    idempotent: !!canIdempotent
  });

  const { rows } = await query(sql, vals);
  return rows?.[0]?.id || null;
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
  const upd = keys.filter((k) => k !== 'user_id').map((k) => `${k}=EXCLUDED.${k}`).join(', ');
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
    [DIGITS(ownerId), DIGITS(createdBy), assignedTo ? DIGITS(assignedTo) : null, title, body, type, dueAt, jobNo]
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
  rows.forEach((r) => ws.addRow(r));

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

  doc
    .fontSize(16)
    .text(`Timesheet ${startIso.slice(0, 10)} – ${endIso.slice(0, 10)}`, { align: 'center' })
    .moveDown();
  rows.forEach((r) => {
    const ts = new Date(r.timestamp);
    doc
      .fontSize(10)
      .text(`${r.employee_name} | ${r.type} | ${formatInTimeZone(ts, r.tz, 'yyyy-MM-dd HH:mm')} | ${r.job_name || ''}`);
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

// ---------- File Exports (fetch) ----------
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

// ---------- Pending actions (confirmations, serverless-safe, TTL via created_at) ----------
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
  const id = rows[0].id;
  console.info('[pending] saved', { id, ownerId: DIGITS(ownerId), userId, kind });
  return id;
}

async function getPendingAction({ ownerId, userId }) {
  const { rows } = await query(
    `select id, kind, payload, created_at
       from public.pending_actions
      where owner_id=$1 and user_id=$2
        and created_at > now() - ($3 || ' minutes')::interval
      order by created_at desc
      limit 1`,
    [String(ownerId).replace(/\D/g, ''), String(userId), String(PENDING_TTL_MIN)]
  );
  return rows[0] || null;
}

async function deletePendingAction(id) {
  await query(`delete from public.pending_actions where id=$1`, [id]);
}

// -------------------- Finance helpers (transactions + pricing_items) --------------------

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
    where += ' AND job_id::text = $2';
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

/**
 * ✅ Vendor breakdown (NO schema change required)
 * Uses transactions.source as vendor label but normalizes for grouping.
 * Your dashboard can call this today.
 */
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

  // Normalize vendor for grouping: trim, collapse whitespace, lower
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
/**
 * Vendor normalization (fail-open).
 * - Trims, collapses whitespace
 * - Strips common suffix noise
 * - Optional: maps known aliases to a canonical name
 */
function normalizeVendorString(v) {
  let s = String(v || '').trim();
  s = s.replace(/\s+/g, ' ');
  if (!s) return 'Unknown Store';

  // remove some common trailing junk (optional / conservative)
  s = s.replace(/\s+#\d+$/i, '');                 // "Home Depot #123"
  s = s.replace(/\s+(inc|ltd|limited)\.?$/i, ''); // "Convoy Supply Ltd"
  s = s.trim();

  // Simple alias map (add your common vendors here)
  const key = s.toLowerCase();
  const ALIASES = {
    'home depot': 'Home Depot',
    'the home depot': 'Home Depot',
    'homedepot': 'Home Depot',
    'convoy supply': 'Convoy Supply',
    'convoy': 'Convoy Supply',
    'rona': 'RONA',
    'lowes': "Lowe's",
    'lowe’s': "Lowe's"
    'gentek': 'Gentek',
    'gentech': 'Gentek',
  };

  return ALIASES[key] || s;
}

/**
 * ✅ normalizeVendorName(ownerId, vendor)
 * Signature matches what expense.js expects today.
 * You can later upgrade this to query a vendor table per owner.
 */
async function normalizeVendorName(_ownerId, vendor) {
  return normalizeVendorString(vendor);
}

/**
 * ✅ listOpenJobs(ownerId, { limit })
 * Returns an array of job display names.
 * Uses jobs.status if present, otherwise falls back to "completed_at is null"
 * and excludes closed/archived-ish statuses.
 */
async function listOpenJobs(ownerId, { limit = 8 } = {}) {
  const owner = String(ownerId || '').trim();
  const lim = Math.max(1, Math.min(Number(limit) || 8, 25));

  // Try status-based first (many schemas have status)
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
    return (rows || []).map(r => r.job_name).filter(Boolean);
  } catch (e) {
    console.warn('[PG/listOpenJobs] status query failed; falling back:', e?.message);
  }

  // Fallback: completed_at null or missing status concept
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
    return (rows || []).map(r => r.job_name).filter(Boolean);
  } catch (e) {
    console.warn('[PG/listOpenJobs] fallback query failed:', e?.message);
    return [];
  }
}

// ---- Safe limiter exports (avoid undefined symbol at module.exports time)
const __checkLimit =
  (typeof checkTimeEntryLimit === 'function' && checkTimeEntryLimit) ||
  (async () => ({ ok: true, n: 0, limit: Infinity, windowSec: 0 })); // fail-open

module.exports = {
  // ---------- Core ----------
  pool,
  query,
  queryWithRetry,
  queryWithTimeout,
  withClient,

  // ---------- Utils ----------
  DIGITS,
  todayInTZ,
  normalizePhoneNumber: (x) => DIGITS(x),
  toCents,
  toAmount,
  isValidIso,

  // ✅ Media/Transactions helpers
  MEDIA_TRANSCRIPT_MAX_CHARS,
  truncateText,
  detectTransactionsCapabilities,
  insertTransaction,
  normalizeMediaMeta,

  // ---------- Pending actions ----------
  savePendingAction,
  getPendingAction,
  deletePendingAction,

  // ---------- Users ----------
  generateOTP,
  verifyOTP,
  createUserProfile,
  saveUserProfile,
  getUserProfile,
  getOwnerProfile,

  // ---------- Tasks ----------
  createTask,
  getTaskByNo,
  createTaskWithJob,

  // ---------- Jobs / context ----------
  ensureJobByName,
  createJobIdempotent,
  activateJobByName,
  resolveJobContext,
  listOpenJobs,
  normalizeVendorName,


  // ✅ restored compat exports
  setActiveJob,
  getActiveJob,
  moveLastLogToJob,
  enqueueKpiTouch,

  // ---------- Time ----------
  logTimeEntry,
  logTimeEntryWithJob,
  getLatestTimeEvent,
  checkTimeEntryLimit: __checkLimit,
  checkActorLimit: __checkLimit,

  // ---------- Finance ----------
  getJobFinanceSnapshot,
  getOwnerPricingItems,
  getOwnerJobsFinance,
  getOwnerMonthlyFinance,
  getOwnerCategoryBreakdown,
  getOwnerVendorBreakdown,

  // ---------- Exports ----------
  exportTimesheetXlsx,
  exportTimesheetPdf,
  getFileExport
};
