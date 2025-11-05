// services/postgres.js
// ------------------------------------------------------------
// Central Postgres service – pool, retry, helpers, lazy heavy deps
// ------------------------------------------------------------
const { Pool } = require('pg');
const crypto = require('crypto');
const { zonedTimeToUtc, utcToZonedTime, formatInTimeZone } = require('date-fns-tz');

// ---------- Lazy heavy dependencies ----------
let ExcelJS = null;      // will be required only in exportTimesheetXlsx
let PDFDocument = null;  // will be required only in exportTimesheetPdf

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
  try { return await pool.query(text, params); }
  catch (e) {
    const transient = /terminated|ECONNRESET|EPIPE|read ECONNRESET/i.test(e.message || '');
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
    await client.query('SET LOCAL statement_timeout = $1', [ms]);
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
  } finally { client.release(); }
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
  const owner = String(ownerId || '').replace(/\D/g, '');
  const actor = String(createdBy || owner).replace(/\D/g, '');

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

  // Always delegate to the resilient writer so user_id/created_by are included
  try {
    const id = await logTimeEntry(ownerId, employeeName, type, ts, jobNo, tz, extras);
    return id;
  } catch (e) {
    console.error('[PG/logTimeEntryWithJob] insert failed:', e?.message);
    throw e;
  }
}

// ---------- Time (resilient INSERT: user_id REQUIRED if column exists) ----------
async function logTimeEntry(ownerId, employeeName, type, ts, jobNo, tz, extras = {}) {
  const tsIso = new Date(ts).toISOString();
  const zone  = tz || 'America/Toronto';

  // Normalize identifiers
  const ownerDigits = String(ownerId ?? '').replace(/\D/g, '');
  const actorDigits = String(extras?.requester_id ?? ownerId ?? '').replace(/\D/g, '');

  // Never pass NULLs to NOT NULL columns
  const ownerSafe = ownerDigits || actorDigits || '0';
  const actorSafe = actorDigits || ownerDigits || '0';

  const local = formatInTimeZone(tsIso, zone, 'yyyy-MM-dd HH:mm:ss');

  // Ensure capability flags are known
  if (SUPPORTS_USER_ID === null || SUPPORTS_CREATED_BY === null) {
    try { await detectTimeEntriesCapabilities(); } catch {}
  }

  // Helper to build and run INSERT. IMPORTANT: created_at uses NOW() (not a param).
  async function runInsert({ includeUserId, includeCreatedBy }) {
    const cols = ['owner_id', 'employee_name', 'type', 'timestamp', 'job_no', 'tz', 'local_time', 'created_at'];
    const vals = [ownerSafe,       employeeName,     type,   tsIso,      jobNo,   zone,  local                 ];
    const ph   = ['$1',            '$2',             '$3',   '$4',       '$5',    '$6',  '$7',                 'NOW()'];

    if (includeUserId) {
      cols.splice(7, 0, 'user_id'); // insert before created_at
      vals.push(actorSafe);
      ph.splice(7, 0, `$${vals.length}`); // next param index
    }
    if (includeCreatedBy) {
      cols.splice(7 + (includeUserId ? 1 : 0), 0, 'created_by');
      vals.push(actorSafe);
      ph.splice(7 + (includeUserId ? 1 : 0), 0, `$${vals.length}`);
    }

    const sql = `
      INSERT INTO public.time_entries (${cols.join(', ')})
      VALUES (${ph.join(', ')})
      RETURNING id`;

    console.info('[PG/logTimeEntry] INSERT', {
      includeUserId, includeCreatedBy,
      user_id: includeUserId ? actorSafe : 'SKIP',
      created_by: includeCreatedBy ? actorSafe : 'SKIP'
    });

    const { rows } = await query(sql, vals);
    return rows[0].id;
  }

  try {
    // Primary path: include user_id if present (your schema has NOT NULL)
    if (SUPPORTS_USER_ID && SUPPORTS_CREATED_BY) {
      return await runInsert({ includeUserId: true, includeCreatedBy: true });
    }
    if (SUPPORTS_USER_ID) {
      return await runInsert({ includeUserId: true, includeCreatedBy: false });
    }
    if (SUPPORTS_CREATED_BY) {
      return await runInsert({ includeUserId: false, includeCreatedBy: true });
    }
    // Legacy fallback: neither column exists
    return await runInsert({ includeUserId: false, includeCreatedBy: false });

  } catch (e) {
    const msg = String(e?.message || '').toLowerCase();
    console.error('[PG/logTimeEntry] insert failed:', msg);

    // Update capability flags if we learned something
    if (msg.includes('column "user_id" does not exist'))    SUPPORTS_USER_ID = false;
    if (msg.includes('column "created_by" does not exist')) SUPPORTS_CREATED_BY = false;

    // If DB complains about NULL user_id we must surface it (requester_id missing)
    if (msg.includes('null value in column "user_id"')) {
      throw new Error(`[PG] user_id is NOT NULL but missing. actorSafe='${actorSafe}' SUPPORTS_USER_ID=${SUPPORTS_USER_ID}`);
    }

    // If our flags were wrong (e.g., we tried with user_id but column missing), retry once without it.
    if (msg.includes('column "user_id" does not exist')) {
      try {
        return await runInsert({ includeUserId: false, includeCreatedBy: SUPPORTS_CREATED_BY === true });
      } catch (e2) {
        throw e2;
      }
    }

    throw e;
  }
}


// ---------- Simple utilities ----------
const DIGITS = x => String(x || '').replace(/\D/g, '');
const toAmount = x => parseFloat(String(x ?? '0').replace(/[$,]/g, '')) || 0;
const isValidIso = ts => !!ts && !Number.isNaN(new Date(ts).getTime());

// ---------- Job helpers (unchanged) ----------
async function ensureJobByName(ownerId, name) {
  const owner = DIGITS(ownerId);
  const jobName = String(name || '').trim();
  if (!jobName) return null;
  let r = await query(
    `SELECT job_no, name, active AS is_active
       FROM public.jobs
      WHERE owner_id=$1 AND lower(name)=lower($2) LIMIT 1`,
    [owner, jobName]
  );
  if (r.rowCount) return r.rows[0];
  r = await query(
    `SELECT job_no, job_name AS name, active AS is_active
       FROM public.jobs
      WHERE owner_id=$1 AND lower(job_name)=lower($2) LIMIT 1`,
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
async function logTimeEntryWithJob(ownerId, employeeName, type, ts, jobName, tz, extras) {
  const job = await resolveJobContext(ownerId, { explicitJobName: jobName });
  return await logTimeEntry(ownerId, employeeName, type, ts, job?.job_no || null, tz, extras);
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

// ---------- Time (schema-aware INSERT for created_by) ----------

// Reuse the capability probe if you already added it above.
// If not present yet, include the detectTimeEntriesCapabilities() function
// from the limiter section. We assume SUPPORTS_CREATED_BY is shared.

/**
 * Insert a time entry, tolerating schemas without created_by.
 * Never throws because of a missing created_by column.
 */
async function logTimeEntry(ownerId, employeeName, type, ts, jobNo, tz, extras = {}) {
  const tsIso = new Date(ts).toISOString();

  // Ensure the capability flag is populated (cached)
  if (typeof SUPPORTS_CREATED_BY === 'undefined' || SUPPORTS_CREATED_BY === null) {
    await detectTimeEntriesCapabilities().catch(() => { SUPPORTS_CREATED_BY = false; });
  }

  const owner = String(ownerId || '').replace(/\D/g, '');
  const local = formatInTimeZone(tsIso, tz || 'America/Toronto', 'yyyy-MM-dd HH:mm:ss');

  if (SUPPORTS_CREATED_BY) {
    // Schema WITH created_by
    const { rows } = await query(
      `INSERT INTO public.time_entries
         (owner_id, employee_name, type, timestamp, job_no, tz, local_time, created_by, created_at)
       VALUES ($1,$2,$3,$4::timestamptz,$5,$6,$7::timestamp,$8,NOW())
       RETURNING id`,
      [owner, employeeName, type, tsIso, jobNo, tz, local, extras.requester_id || null]
    );
    return rows[0].id;
  } else {
    // Schema WITHOUT created_by
    const { rows } = await query(
      `INSERT INTO public.time_entries
         (owner_id, employee_name, type, timestamp, job_no, tz, local_time, created_at)
       VALUES ($1,$2,$3,$4::timestamptz,$5,$6,$7::timestamp,NOW())
       RETURNING id`,
      [owner, employeeName, type, tsIso, jobNo, tz, local]
    );
    return rows[0].id;
  }
}


// ---------- EXCEL EXPORT (lazy load) ----------
async function exportTimesheetXlsx(opts) {
  // ----- lazy require -----
  if (!ExcelJS) ExcelJS = require('exceljs');

  const { ownerId, startIso, endIso, employeeName, tz = 'America/Toronto' } = opts;
  const params = employeeName ? [ownerId, startIso, endIso, tz, employeeName] : [ownerId, startIso, endIso, tz];
  const { rows } = await queryWithTimeout(
    `SELECT employee_name, type, timestamp, COALESCE(job_name,'') AS job_name, COALESCE(tz,$4) AS tz
       FROM public.time_entries
      WHERE owner_id=$1 AND timestamp>=$2::timestamptz AND timestamp<=$3::timestamptz
      ${employeeName ? 'AND employee_name=$5' : ''}
      ORDER BY employee_name, timestamp`,
    params, 15000
  );

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Timesheet');
  ws.columns = [
    { header: 'Employee', key: 'employee_name' },
    { header: 'Type', key: 'type' },
    { header: 'Timestamp', key: 'timestamp' },
    { header: 'Job', key: 'job_name' },
  ];
  rows.forEach(r => ws.addRow(r));

  const buf = await wb.xlsx.writeBuffer();
  const id = crypto.randomBytes(12).toString('hex');
  const filename = `timesheet_${startIso.slice(0,10)}_${endIso.slice(0,10)}${employeeName ? '_' + employeeName.replace(/\s+/g, '_') : ''}.xlsx`;

  await query(
    `INSERT INTO public.file_exports (id, owner_id, filename, content_type, bytes, created_at)
     VALUES ($1,$2,$3,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',$4,NOW())`,
    [id, ownerId, filename, Buffer.from(buf)]
  );
  const base = process.env.PUBLIC_BASE_URL || '';
  return { url: `${base}/exports/${id}`, id, filename };
}

// ---------- PDF EXPORT (lazy load) ----------
async function exportTimesheetPdf(opts) {
  // ----- lazy require -----
  if (!PDFDocument) PDFDocument = require('pdfkit');

  const { ownerId, startIso, endIso, employeeName, tz = 'America/Toronto' } = opts;
  const params = employeeName ? [ownerId, startIso, endIso, tz, employeeName] : [ownerId, startIso, endIso, tz];
  const { rows } = await queryWithTimeout(
    `SELECT employee_name, type, timestamp, COALESCE(job_name,'') AS job_name, COALESCE(tz,$4) AS tz
       FROM public.time_entries
      WHERE owner_id=$1 AND timestamp>=$2::timestamptz AND timestamp<=$3::timestamptz
      ${employeeName ? 'AND employee_name=$5' : ''}
      ORDER BY employee_name, timestamp`,
    params, 15000
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
    [id, ownerId, filename, buf]
  );
  const base = process.env.PUBLIC_BASE_URL || '';
  return { url: `${base}/exports/${id}`, id, filename };
}


// ---- Safe limiter exports (avoid undefined symbol at module.exports time)
const __checkLimit =
  (typeof checkTimeEntryLimit === 'function' && checkTimeEntryLimit) ||
  (async () => ({ ok: true, n: 0, limit: Infinity, windowSec: 0 })); // fail-open

  // Detect time_entries capabilities once at startup (cache flags)
(async () => {
  try {
    const caps = await detectTimeEntriesCapabilities();
    console.info('[PG] time_entries schema detected:', caps);
  } catch (e) {
    console.warn('[PG] schema detect failed, safe defaults', e?.message);
    SUPPORTS_USER_ID = true;      // your schema has NOT NULL user_id
    SUPPORTS_CREATED_BY = false;
  }
})();


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

  // …add any other helpers you already export (listMyTasks, etc.)
};