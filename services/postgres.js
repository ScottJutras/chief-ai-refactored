// services/postgres.js
// ------------------------------------------------------------
// Central Postgres service – pool, retry, helpers, lazy heavy deps
// ------------------------------------------------------------

const { Pool } = require('pg');
const crypto = require('crypto');
const { formatInTimeZone } = require('date-fns-tz');

// ---------- Lazy heavy dependencies ----------
let ExcelJS = null;      // required only in exportTimesheetXlsx
let PDFDocument = null;  // required only in exportTimesheetPdf

// ---------- Pool ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  connectionTimeoutMillis: 20000,
  idleTimeoutMillis: 60000,
  keepAlive: true,
});
pool.on('error', err => console.error('[PG] idle client error:', err?.message));

// ---------- Core query helpers ----------
async function query(text, params) { return queryWithRetry(text, params); }

async function queryWithRetry(text, params, attempt = 1) {
  try {
    return await pool.query(text, params);
  } catch (e) {
    const transient = /terminated|ECONNRESET|EPIPE|read ECONNRESET|Connection terminated/i.test(e.message || '');
    if (transient && attempt < 3) {
      console.warn(`[PG] retry ${attempt + 1}: ${e.message}`);
      await new Promise(r => setTimeout(r, attempt * 200));
      return queryWithRetry(text, params, attempt + 1);
    }
    throw e;
  }
}

async function queryWithTimeout(sql, params, ms = 9000) {
  return withClient(async client => {
    // NOTE: SET LOCAL cannot be parameterized
    const timeoutMs = Math.max(0, Number(ms) | 0);
    await client.query(`SET LOCAL statement_timeout = '${timeoutMs}ms'`);
    return client.query(sql, params);
  }, { useTransaction: true });
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

// ---------- Time Limits & Audit (schema-aware, tolerant) ----------

// Cache detected columns on public.time_entries
let SUPPORTS_CREATED_BY = null; // null=unknown, then true/false
let SUPPORTS_USER_ID    = null;

async function detectTimeEntriesCapabilities() {
  if (SUPPORTS_CREATED_BY !== null && SUPPORTS_USER_ID !== null) {
    return { SUPPORTS_CREATED_BY, SUPPORTS_USER_ID };
  }
  try {
    const { rows } = await query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'time_entries'`
    );
    const names = new Set(rows.map(r => String(r.column_name).toLowerCase()));
    SUPPORTS_CREATED_BY = names.has('created_by');
    SUPPORTS_USER_ID    = names.has('user_id');
  } catch {
    // Conservative defaults if detection fails
    SUPPORTS_CREATED_BY = false;
    SUPPORTS_USER_ID    = false;
  }
  return { SUPPORTS_CREATED_BY, SUPPORTS_USER_ID };
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
      // If it's some other DB error, fail-open
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
  // Resolve job context (prefer explicit name; otherwise active job)
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

  // Delegate to resilient writer
  return await logTimeEntry(ownerId, employeeName, type, ts, jobNo, tz, extras);
}

// ---------- Time (resilient INSERT: user_id ALWAYS bound if exists) ----------
async function logTimeEntry(ownerId, employeeName, type, ts, jobNo, tz, extras = {}) {
  const tsIso = new Date(ts).toISOString();
  const zone  = tz || 'America/Toronto';

  const ownerDigits = DIGITS(ownerId);
  const actorDigits = DIGITS(extras?.requester_id || ownerId);

  const ownerSafe = ownerDigits || actorDigits || '0';
  const actorSafe = actorDigits || ownerDigits || '0'; // NEVER NULL

  const local = formatInTimeZone(tsIso, zone, 'yyyy-MM-dd HH:mm:ss');

  // Ensure detection (retry on null)
  if (SUPPORTS_USER_ID === null || SUPPORTS_CREATED_BY === null) {
    await detectTimeEntriesCapabilities().catch(e => console.error('[PG/logTimeEntry] detection failed:', e?.message));
  }

  const cols = ['owner_id', 'employee_name', 'type', 'timestamp', 'job_no', 'tz', 'local_time'];
  const vals = [ownerSafe, employeeName, type, tsIso, jobNo, zone, local];

  // FORCE user_id if column exists
  if (SUPPORTS_USER_ID) {
    cols.push('user_id');
    vals.push(actorSafe);
  }

  // Optional: created_by
  if (SUPPORTS_CREATED_BY) {
    cols.push('created_by');
    vals.push(actorSafe);
  }

  cols.push('created_at');
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ') + ', NOW()';

  const sql = `
    INSERT INTO public.time_entries (${cols.join(', ')})
    VALUES (${placeholders})
    RETURNING id`;

  console.info('[PG/logTimeEntry] EXECUTING', {
    cols,
    params_preview: [...vals.slice(0, 5), '…', zone, local],
    actorSafe,
    sql: sql.replace(/\s+/g, ' ').slice(0, 300)
  });

  try {
    const { rows } = await query(sql, vals);
    return rows[0].id;
  } catch (e) {
    console.error('[PG/logTimeEntry] FAILED:', e?.message);
    throw e;
  }
}

// ---------- Simple utilities ----------
const DIGITS = x => String(x || '').replace(/\D/g, '');
const toAmount = x => parseFloat(String(x ?? '0').replace(/[$,]/g, '')) || 0;
const isValidIso = ts => !!ts && !Number.isNaN(new Date(ts).getTime());

// ---------- Job helpers ----------
async function ensureJobByName(ownerId, name) {
  const owner = DIGITS(ownerId);
  const jobName = String(name || '').trim();
  if (!jobName) return null;

  let r = await query(
    `SELECT job_no, name, active AS is_active
       FROM public.jobs
      WHERE owner_id=$1 AND lower(name)=lower($2)
      LIMIT 1`,
    [owner, jobName]
  );
  if (r.rowCount) return r.rows[0];

  r = await query(
    `SELECT job_no, job_name AS name, active AS is_active
       FROM public.jobs
      WHERE owner_id=$1 AND lower(job_name)=lower($2)
      LIMIT 1`,
    [owner, jobName]
  );
  if (r.rowCount) return r.rows[0];

  const ins = await query(
    `INSERT INTO public.jobs (owner_id, job_name, name, active, start_date, created_at, updated_at)
     VALUES ($1,$2,$2,true,NOW(),NOW(),NOW())
     RETURNING job_no, name, active AS is_active`,
    [owner, jobName]
  );
  return ins.rows[0];
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

async function createTaskWithJob(opts) {
  const job = await resolveJobContext(opts.ownerId, { explicitJobName: opts.jobName });
  opts.jobNo = job?.job_no || null;
  return await createTask(opts);
}

// ---------- OTP ----------
async function generateOTP(userId) {
  const uid = DIGITS(userId);
  const otp = crypto.randomInt(100000, 1000000).toString();
  const expiry = new Date(Date.now() + 10 * 60 * 1000);
  await query(
    `UPDATE public.users SET otp=$1, otp_expiry=$2 WHERE user_id=$3`,
    [otp, expiry, uid]
  );
  return otp;
}

async function verifyOTP(userId, otp) {
  const uid = DIGITS(userId);
  const { rows } = await query(
    `SELECT otp, otp_expiry FROM public.users WHERE user_id=$1`,
    [uid]
  );
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
  const uid = DIGITS(p.user_id);
  const keys = Object.keys(p);
  const vals = Object.values(p);
  const insCols = keys.join(', ');
  const insVals = keys.map((_, i) => `$${i + 1}`).join(', ');
  const upd = keys.filter(k => k !== 'user_id').map(k => `${k}=EXCLUDED.${k}`).join(', ');
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
  const { rows } = await query(
    `SELECT * FROM public.tasks WHERE owner_id=$1 AND task_no=$2 LIMIT 1`,
    [DIGITS(ownerId), taskNo]
  );
  return rows[0] || null;
}

// ---------- EXCEL EXPORT (lazy load) ----------
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
    { header: 'Employee',  key: 'employee_name' },
    { header: 'Type',      key: 'type' },
    { header: 'Timestamp', key: 'timestamp' },
    { header: 'Job',       key: 'job_name' },
  ];
  rows.forEach(r => ws.addRow(r));

  const buf = await wb.xlsx.writeBuffer();
  const id = crypto.randomBytes(12).toString('hex');
  const filename = `timesheet_${startIso.slice(0,10)}_${endIso.slice(0,10)}${employeeName ? '_' + employeeName.replace(/\s+/g, '_') : ''}.xlsx`;

  await query(
    `INSERT INTO public.file_exports (id, owner_id, filename, content_type, bytes, created_at)
     VALUES ($1,$2,$3,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',$4,NOW())`,
    [id, owner, filename, Buffer.from(buf)]
  );
  const base = process.env.PUBLIC_BASE_URL || '';
  return { url: `${base}/exports/${id}`, id, filename };
}

// ---------- PDF EXPORT (lazy load) ----------
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
  doc.on('data', d => chunks.push(d));
  const done = new Promise(r => doc.on('end', r));

  doc.fontSize(16).text(`Timesheet ${startIso.slice(0,10)} – ${endIso.slice(0,10)}`, { align: 'center' }).moveDown();
  rows.forEach(r => {
    const ts = new Date(r.timestamp);
    doc.fontSize(10).text(
      `${r.employee_name} | ${r.type} | ${formatInTimeZone(ts, r.tz, 'yyyy-MM-dd HH:mm')} | ${r.job_name || ''}`
    );
  });

  doc.end();
  await done;
  const buf = Buffer.concat(chunks);

  const id = crypto.randomBytes(12).toString('hex');
  const filename = `timesheet_${startIso.slice(0,10)}_${endIso.slice(0,10)}${employeeName ? '_' + employeeName.replace(/\s+/g, '_') : ''}.pdf`;

  await query(
    `INSERT INTO public.file_exports (id, owner_id, filename, content_type, bytes, created_at)
     VALUES ($1,$2,$3,'application/pdf',$4,NOW())`,
    [id, owner, filename, buf]
  );
  const base = process.env.PUBLIC_BASE_URL || '';
  return { url: `${base}/exports/${id}`, id, filename };
}

// ---------- Pending actions (confirmations, serverless-safe, TTL) ----------
const PENDING_TTL_MIN = 10;

async function savePendingAction({ ownerId, userId, kind, payload }) {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO public.pending_actions (id, owner_id, user_id, kind, payload, expires_at, created_at)
     VALUES ($1,$2,$3,$4,$5, NOW() + ($6 || ' minutes')::interval, NOW())
     ON CONFLICT (id) DO NOTHING`,
    [id, String(ownerId), String(userId), String(kind), payload, String(PENDING_TTL_MIN)]
  );
  return id;
}

async function getPendingAction({ ownerId, userId }) {
  const { rows } = await query(
    `SELECT id, kind, payload
       FROM public.pending_actions
      WHERE owner_id=$1 AND user_id=$2 AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1`,
    [String(ownerId), String(userId)]
  );
  return rows[0] || null;
}

async function deletePendingAction(id) {
  await query(`DELETE FROM public.pending_actions WHERE id=$1`, [String(id)]);
}

// ---- Safe limiter exports (avoid undefined symbol at module.exports time)
const __checkLimit =
  (typeof checkTimeEntryLimit === 'function' && checkTimeEntryLimit) ||
  (async () => ({ ok: true, n: 0, limit: Infinity, windowSec: 0 })); // fail-open

module.exports = {
  // Core
  pool, query, queryWithTimeout, withClient,
  normalizePhoneNumber: x => DIGITS(x),
  toAmount, isValidIso,

  // Jobs / context
  ensureJobByName, resolveJobContext,
  createTaskWithJob, logTimeEntryWithJob,

  // Users
  generateOTP, verifyOTP,
  createUserProfile, saveUserProfile, getUserProfile, getOwnerProfile,

  // Tasks
  createTask, getTaskByNo,

  // Time
  logTimeEntry,
  checkTimeEntryLimit: __checkLimit, // <= safe export
  checkActorLimit: __checkLimit,     // <= compat alias

  // Exports
  exportTimesheetXlsx,
  exportTimesheetPdf,
  getFileExport,

  // Pending actions
  savePendingAction,
  getPendingAction,
  deletePendingAction,
};
