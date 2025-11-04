// services/postgres.js
// ---------------------------------------------------------------
// Central Postgres service – pool, retry, timeout, helpers.
// All DB calls are RLS‑guarded in the schema.
// ---------------------------------------------------------------
const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { zonedTimeToUtc, utcToZonedTime, formatInTimeZone } = require('date-fns-tz');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  connectionTimeoutMillis: 20000,
  idleTimeoutMillis: 60000,
  keepAlive: true,
});
pool.on('error', err => console.error('[PG] idle client error:', err?.message));

async function query(text, params) {
  return await queryWithRetry(text, params);
}
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

// ---------- Helpers ----------
const DIGITS = x => String(x || '').replace(/\D/g, '');
const toAmount = x => parseFloat(String(x ?? '0').replace(/[$,]/g, '')) || 0;
const isValidIso = ts => !!ts && !Number.isNaN(new Date(ts).getTime());

// ---------- Job wrappers ----------
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

// ---------- User ----------
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
  const keyshoz = Object.keys(p);
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

// ---------- Time ----------
async function logTimeEntry(ownerId, employeeName, type, ts, jobNo, tz, extras = {}) {
  const tsIso = new Date(ts).toISOString();
  const local = formatInTimeZone(tsIso, tz, 'yyyy-MM-dd HH:mm:ss');
  const { rows } = await query(
    `INSERT INTO public.time_entries
       (owner_id, employee_name, type, timestamp, job_no, tz, local_time, created_by, created_at)
     VALUES ($1,$2,$3,$4::timestamptz,$5,$6,$7::timestamp,$8,NOW())
     RETURNING id`,
    [DIGITS(ownerId), employeeName, type, tsIso, jobNo, tz, local, extras.requester_id || null]
  );
  return rows[0].id;
}

// ---------- Exports ----------
async function exportTimesheetXlsx(opts) {
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
  const filename = `timesheet_${startIso.slice(0,10)}_${endIso.slice(0,10)}.xlsx`;
  await query(
    `INSERT INTO public.file_exports (id, owner_id, filename, content_type, bytes, created_at)
     VALUES ($1,$2,$3,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',$4,NOW())`,
    [id, ownerId, filename, Buffer.from(buf)]
  );
  return { url: `${process.env.PUBLIC_BASE_URL || ''}/exports/${id}`, id, filename };
}
async function exportTimesheetPdf(opts) {
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
  const filename = `timesheet_${startIso.slice(0,10)}_${endIso.slice(0,10)}.pdf`;
  await query(
    `INSERT INTO public.file_exports (id, owner_id, filename, content_type, bytes, created_at)
     VALUES ($1,$2,$3,'application/pdf',$4,NOW())`,
    [id, ownerId, filename, buf]
  );
  return { url: `${process.env.PUBLIC_BASE_URL || ''}/exports/${id}`, id, filename };
}

// ---------- Export all ----------
module.exports = {
  pool, query, queryWithTimeout, withClient,
  normalizePhoneNumber: x => DIGITS(x),
  toAmount, isValidIso,
  ensureJobByName, resolveJobContext,
  createTaskWithJob, logTimeEntryWithJob,
  generateOTP, verifyOTP,
  createUserProfile, saveUserProfile, getUserProfile, getOwnerProfile,
  createTask, getTaskByNo,
  logTimeEntry,
  exportTimesheetXlsx, exportTimesheetPdf,
  // Add any other helpers you already use (listMyTasks, etc.) here
};