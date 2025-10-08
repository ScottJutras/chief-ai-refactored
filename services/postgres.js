const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { zonedTimeToUtc, utcToZonedTime, formatInTimeZone } = require('date-fns-tz');
const { reverseGeocode } = require('./geocode');

// Initialize Postgres connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  // you can keep reasonable defaults; tweak if needed
  max: 10,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[PG] idle client error:', err?.message || err);
});

async function query(sql, params) {
  try {
    return await pool.query(sql, params);
  } catch (error) {
    // Avoid logging huge SQL with sensitive data; this is fine for your internal queries
    console.error('[ERROR] Query failed:', error.message);
    throw error;
  }
}

async function withClient(fn, { useTransaction = true } = {}) {
  const client = await getPool().connect();
  try {
    if (useTransaction) await client.query('BEGIN');
    const result = await fn(client);
    if (useTransaction) await client.query('COMMIT');
    return result;
  } catch (err) {
    if (useTransaction) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    throw err;
  } finally {
    client.release();
  }
}

// ---------- Helpers ----------
function normalizePhoneNumber(phone = '') {
  const val = String(phone || '');
  const noWa = val.startsWith('whatsapp:') ? val.slice('whatsapp:'.length) : val;
  return noWa.replace(/^\+/, '').trim();
}

function toAmount(x) {
  return parseFloat(String(x ?? '0').replace(/[$,]/g, '')) || 0;
}

function isValidIsoTimestamp(ts) {
  if (!ts || (typeof ts !== 'string' && !(ts instanceof Date))) return false;
  const d = new Date(ts);
  return !Number.isNaN(d.getTime());
}

function groupBy(arr, key) {
  return arr.reduce((m, x) => ((m[x[key]] ||= []).push(x), m), {});
}

function computeEmployeeSummary(rows) {
  let totalHours = 0, driveHours = 0, breakMinutes = 0;
  let lastIn = null, lastDrive = null, lastBreak = null;
  const sorted = [...rows].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  for (const r of sorted) {
    const t = new Date(r.timestamp);
    if (r.type === 'punch_in') lastIn = t;
    if (r.type === 'punch_out' && lastIn) { totalHours += (t - lastIn) / 3600000; lastIn = null; }
    if (r.type === 'drive_start') lastDrive = t;
    if (r.type === 'drive_end' && lastDrive) { driveHours += (t - lastDrive) / 3600000; lastDrive = null; }
    if (r.type === 'break_start') lastBreak = t;
    if (r.type === 'break_end' && lastBreak) { breakMinutes += (t - lastBreak) / 60000; lastBreak = null; }
  }
  if (lastBreak) {
    const last = sorted.length ? new Date(sorted[sorted.length - 1].timestamp) : new Date();
    breakMinutes += Math.max(0, (last - lastBreak) / 60000);
  }
  return {
    totalHours: +totalHours.toFixed(2),
    driveHours: +driveHours.toFixed(2),
    breakMinutes: Math.round(breakMinutes),
  };
}

// ---------- OTP & verification ----------
async function generateOTP(userId) {
  const normalizedId = normalizePhoneNumber(userId);
  try {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 10 * 60 * 1000);
    await query(
      `UPDATE users SET otp=$1, otp_expiry=$2 WHERE user_id=$3`,
      [otp, expiry, normalizedId]
    );
    return otp;
  } catch (error) {
    console.error('[ERROR] generateOTP failed:', error.message);
    throw error;
  }
}

async function verifyOTP(userId, otp) {
  const normalizedId = normalizePhoneNumber(userId);
  try {
    const res = await query(
      `SELECT otp, otp_expiry FROM users WHERE user_id=$1`,
      [normalizedId]
    );
    const user = res.rows[0];
    const isValid = !!user && user.otp === otp && new Date() <= new Date(user.otp_expiry);
    if (!isValid) return false;
    await query(`UPDATE users SET otp=NULL, otp_expiry=NULL WHERE user_id=$1`, [normalizedId]);
    return true;
  } catch (error) {
    console.error('[ERROR] verifyOTP failed:', error.message);
    throw error;
  }
}

// ---------- Transactions / Expenses / Bills / Revenue / Quotes ----------
async function appendToUserSpreadsheet(ownerId, data) {
  try {
    const [date, item, amount, store, jobName, type, category, mediaUrl, userName] = data;
    const sql = `
      INSERT INTO transactions
        (owner_id, date, item, amount, store, job_name, type, category, media_url, user_name, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
      RETURNING id`;
    const result = await query(sql, [
      ownerId,
      date,
      item,
      toAmount(amount),
      store,
      jobName,
      type,
      category,
      mediaUrl || null,
      userName
    ]);
    return result.rows[0].id;
  } catch (error) {
    console.error('[ERROR] appendToUserSpreadsheet failed:', error.message);
    throw error;
  }
}

async function saveExpense({ ownerId, date, item, amount, store, jobName, category, user, mediaUrl }) {
  try {
    await query(
      `INSERT INTO transactions (owner_id, type, date, item, amount, store, job_name, category, user_name, media_url, created_at)
       VALUES ($1,'expense',$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
      [ownerId, date, item, toAmount(amount), store, jobName, category, user, mediaUrl || null]
    );
  } catch (error) {
    console.error('[ERROR] saveExpense failed:', error.message);
    throw error;
  }
}

async function deleteExpense(ownerId, criteria) {
  try {
    const res = await query(
      `DELETE FROM transactions
       WHERE owner_id = $1 AND type='expense' AND item=$2 AND amount=$3 AND store=$4
       RETURNING *`,
      [ownerId, criteria.item, toAmount(criteria.amount), criteria.store]
    );
    return res.rows.length > 0;
  } catch (error) {
    console.error('[ERROR] deleteExpense failed:', error.message);
    return false;
  }
}

async function saveBill(ownerId, billData) {
  try {
    await query(
      `INSERT INTO transactions (owner_id, type, date, item, amount, recurrence, job_name, category, created_at)
       VALUES ($1,'bill',$2,$3,$4,$5,$6,$7,NOW())`,
      [
        ownerId,
        billData.date,
        billData.billName,
        toAmount(billData.amount),
        billData.recurrence,
        billData.jobName,
        billData.category
      ]
    );
  } catch (error) {
    console.error('[ERROR] saveBill failed:', error.message);
    throw error;
  }
}

async function updateBill(ownerId, billData) {
  try {
    const res = await query(
      `UPDATE transactions
       SET amount = COALESCE($1, amount),
           recurrence = COALESCE($2, recurrence),
           date = COALESCE($3, date),
           updated_at = NOW()
       WHERE owner_id=$4 AND type='bill' AND item=$5
       RETURNING *`,
      [
        billData.amount != null ? toAmount(billData.amount) : null,
        billData.recurrence || null,
        billData.date || null,
        ownerId,
        billData.billName
      ]
    );
    return res.rows.length > 0;
  } catch (error) {
    console.error('[ERROR] updateBill failed:', error.message);
    return false;
  }
}

async function deleteBill(ownerId, billName) {
  try {
    const res = await query(
      `DELETE FROM transactions WHERE owner_id=$1 AND type='bill' AND item=$2 RETURNING *`,
      [ownerId, billName]
    );
    return res.rows.length > 0;
  } catch (error) {
    console.error('[ERROR] deleteBill failed:', error.message);
    return false;
  }
}

async function saveRevenue(ownerId, revenueData) {
  try {
    await query(
      `INSERT INTO transactions (owner_id, type, amount, item, store, category, date, job_name, created_at)
       VALUES ($1,'revenue',$2,$3,$4,$5,$6,$7,NOW())`,
      [
        ownerId,
        toAmount(revenueData.amount),
        revenueData.description,
        revenueData.source,
        revenueData.category,
        revenueData.date,
        revenueData.jobName
      ]
    );
  } catch (error) {
    console.error('[ERROR] saveRevenue failed:', error.message);
    throw error;
  }
}

async function saveQuote(ownerId, quoteData) {
  try {
    await query(
      `INSERT INTO quotes (owner_id, amount, description, client, job_name, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW())`,
      [ownerId, toAmount(quoteData.amount), quoteData.description, quoteData.client, quoteData.jobName]
    );
  } catch (error) {
    console.error('[ERROR] saveQuote failed:', error.message);
    throw error;
  }
}

// --- Pricing Items ---
async function addPricingItem(ownerId, itemName, unitCost, unit = 'each', category = 'material') {
  try {
    const res = await query(
      `INSERT INTO pricing_items
        (owner_id, item_name, unit_cost, unit, category, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       RETURNING item_name, unit_cost, unit, category`,
      [ownerId, itemName, toAmount(unitCost), unit, category]
    );
    return res.rows[0];
  } catch (error) {
    console.error('[ERROR] addPricingItem failed:', error.message);
    throw error;
  }
}

async function getPricingItems(ownerId) {
  try {
    const res = await query(
      `SELECT item_name, unit_cost, unit, category
       FROM pricing_items
       WHERE owner_id=$1
       ORDER BY item_name ASC`,
      [ownerId]
    );
    return res.rows;
  } catch (error) {
    console.error('[ERROR] getPricingItems failed:', error.message);
    throw error;
  }
}

async function updatePricingItem(ownerId, itemName, unitCost) {
  try {
    const res = await query(
      `UPDATE pricing_items
       SET unit_cost=$1, updated_at=NOW()
       WHERE owner_id=$2 AND item_name=$3
       RETURNING item_name, unit_cost, unit, category`,
      [toAmount(unitCost), ownerId, itemName]
    );
    return res.rows[0] || null;
  } catch (error) {
    console.error('[ERROR] updatePricingItem failed:', error.message);
    throw error;
  }
}

async function deletePricingItem(ownerId, itemName) {
  try {
    await query(
      `DELETE FROM pricing_items
       WHERE owner_id=$1 AND item_name=$2`,
      [ownerId, itemName]
    );
    return true;
  } catch (error) {
    console.error('[ERROR] deletePricingItem failed:', error.message);
    throw error;
  }
}

// --- Jobs ---
async function getActiveJob(ownerId) {
  try {
    const res = await query(
      `SELECT job_name FROM jobs WHERE owner_id=$1 AND active=true LIMIT 1`,
      [ownerId]
    );
    return res.rows[0]?.job_name || 'Uncategorized';
  } catch (error) {
    console.error('[ERROR] getActiveJob failed:', error.message);
    return 'Uncategorized';
  }
}

async function createJob(ownerId, jobName) {
  try {
    await query(
      `INSERT INTO jobs (owner_id, job_name, active, created_at)
       VALUES ($1, $2, false, NOW())`,
      [ownerId, jobName]
    );
  } catch (error) {
    console.error('[ERROR] createJob failed:', error.message);
    throw error;
  }
}

async function saveJob(ownerId, jobName, startDate) {
  try {
    await query(
      `INSERT INTO jobs (owner_id, job_name, start_date, active, created_at)
       VALUES ($1, $2, $3, true, NOW())`,
      [ownerId, jobName, startDate || new Date()]
    );
  } catch (error) {
    console.error('[ERROR] saveJob failed:', error.message);
    throw error;
  }
}

async function setActiveJob(ownerId, jobName) {
  try {
    await query(`UPDATE jobs SET active=false WHERE owner_id=$1`, [ownerId]);
    await query(
      `UPDATE jobs SET active=true, start_date=NOW() WHERE owner_id=$1 AND job_name=$2`,
      [ownerId, jobName]
    );
  } catch (error) {
    console.error('[ERROR] setActiveJob failed:', error.message);
    throw error;
  }
}

async function finishJob(ownerId, jobName) {
  try {
    await query(
      `UPDATE jobs
       SET active=false, end_date=NOW()
       WHERE owner_id=$1 AND job_name=$2`,
      [ownerId, jobName]
    );
  } catch (error) {
    console.error('[ERROR] finishJob failed:', error.message);
    throw error;
  }
}

async function finalizeJobCreation(ownerId, jobName, activate) {
  try {
    await createJob(ownerId, jobName);
    if (activate) {
      await setActiveJob(ownerId, jobName);
    }
  } catch (error) {
    console.error('[ERROR] finalizeJobCreation failed:', error.message);
    throw error;
  }
}

async function pauseJob(ownerId, jobName) {
  try {
    await query(
      `UPDATE jobs SET active=false WHERE owner_id=$1 AND job_name=$2`,
      [ownerId, jobName]
    );
  } catch (error) {
    console.error('[ERROR] pauseJob failed:', error.message);
    throw error;
  }
}

async function resumeJob(ownerId, jobName) {
  try {
    await query(
      `UPDATE jobs SET active=true WHERE owner_id=$1 AND job_name=$2`,
      [ownerId, jobName]
    );
  } catch (error) {
    console.error('[ERROR] resumeJob failed:', error.message);
    throw error;
  }
}

async function listOpenJobs(ownerId, limit = 3) {
  try {
    const sql = `
      SELECT job_name
      FROM jobs
      WHERE owner_id = $1 AND (active = true OR end_date IS NULL)
      ORDER BY created_at DESC
      LIMIT $2
    `;
    const res = await query(sql, [ownerId, limit]);
    return res.rows.map(row => ({ name: row.job_name }));
  } catch (error) {
    console.error('[ERROR] listOpenJobs failed:', error.message);
    throw error;
  }
}


async function summarizeJob(ownerId, jobName) {
  try {
    const jobRes = await query(
      `SELECT start_date, end_date FROM jobs
       WHERE owner_id=$1 AND job_name=$2 LIMIT 1`,
      [ownerId, jobName]
    );
    const { start_date, end_date } = jobRes.rows[0] || {};
    const start = start_date ? new Date(start_date) : new Date();
    const end = end_date ? new Date(end_date) : new Date();
    const durationDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24));

    const expRes = await query(
      `SELECT COALESCE(SUM(amount::numeric),0) AS total_expenses
       FROM transactions
       WHERE owner_id=$1 AND job_name=$2 AND (type='expense' OR type='bill')`,
      [ownerId, jobName]
    );
    const revRes = await query(
      `SELECT COALESCE(SUM(amount::numeric),0) AS total_revenue
       FROM transactions
       WHERE owner_id=$1 AND job_name=$2 AND type='revenue'`,
      [ownerId, jobName]
    );

    const materialCost = parseFloat(expRes.rows[0].total_expenses);
    const revenue = parseFloat(revRes.rows[0].total_revenue);
    const profit = revenue - materialCost;
    const profitMargin = revenue > 0 ? profit / revenue : 0;

    const timeRes = await query(
      `SELECT COALESCE(SUM(hours),0) AS hours FROM (
         SELECT
           CASE
             WHEN type = 'punch_in' THEN
               EXTRACT(EPOCH FROM (
                 (LEAD(timestamp) OVER (PARTITION BY owner_id, employee_name, job_name ORDER BY timestamp)) - timestamp
               )) / 3600.0
             ELSE 0
           END AS hours
         FROM time_entries
         WHERE owner_id = $1 AND job_name = $2
       ) x`,
      [ownerId, jobName]
    );
    const labourHours = parseFloat(timeRes.rows[0].hours) || 0;

    const rateRes = await query(
      `SELECT unit_cost FROM pricing_items
       WHERE owner_id=$1 AND category='labour' LIMIT 1`,
      [ownerId]
    );
    const labourRate = parseFloat(rateRes.rows[0]?.unit_cost) || 0;
    const labourCost = labourHours * labourRate;

    return { durationDays, labourHours, labourCost, materialCost, revenue, profit, profitMargin };
  } catch (error) {
    console.error('[ERROR] summarizeJob failed:', error.message);
    throw error;
  }
}

// --- Users ---
async function createUserProfile({ user_id, ownerId, onboarding_in_progress = false }) {
  const normalizedId = normalizePhoneNumber(user_id);
  const normalizedOwnerId = normalizePhoneNumber(ownerId);
  try {
    const dashboard_token = crypto.randomBytes(16).toString('hex');
    const result = await query(
      `INSERT INTO users
         (user_id, owner_id, onboarding_in_progress, onboarding_completed, subscription_tier, dashboard_token, created_at)
       VALUES
         ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET onboarding_in_progress = EXCLUDED.onboarding_in_progress
       RETURNING *`,
      [normalizedId, normalizedOwnerId, onboarding_in_progress, false, 'basic', dashboard_token]
    );
    return result.rows[0];
  } catch (error) {
    console.error('[ERROR] createUserProfile failed:', error.message);
    throw error;
  }
}

async function saveUserProfile(profile) {
  const normalizedId = normalizePhoneNumber(profile.user_id);
  const data = { ...profile, user_id: normalizedId };
  const keys = Object.keys(data);
  const values = Object.values(data);
  const insertCols = keys.join(', ');
  const insertVals = keys.map((_, i) => `$${i + 1}`).join(', ');
  const updateSet = keys
    .filter(k => k !== 'user_id')
    .map(k => `${k}=EXCLUDED.${k}`)
    .join(', ');
  const sql = `
    INSERT INTO users (${insertCols})
    VALUES (${insertVals})
    ON CONFLICT (user_id) DO UPDATE SET ${updateSet}
    RETURNING *`;
  try {
    const result = await query(sql, values);
    return result.rows[0];
  } catch (error) {
    console.error('[ERROR] saveUserProfile failed:', error.message);
    throw error;
  }
}

async function getUserProfile(userId) {
  const normalizedId = normalizePhoneNumber(userId);
  try {
    const res = await query('SELECT * FROM users WHERE user_id=$1', [normalizedId]);
    return res.rows[0] || null;
  } catch (error) {
    console.error('[ERROR] getUserProfile failed:', error.message);
    throw error;
  }
}

async function getOwnerProfile(ownerId) {
  const normalizedId = normalizePhoneNumber(ownerId);
  try {
    const res = await query('SELECT * FROM users WHERE user_id=$1', [normalizedId]);
    return res.rows[0] || null;
  } catch (error) {
    console.error('[ERROR] getOwnerProfile failed:', error.message);
    throw error;
  }
}

// --- File parsing ---
async function parseFinancialFile(fileBuffer, fileType) {
  try {
    let data = [];
    if (fileType === 'text/csv') {
      const csvText = fileBuffer.toString('utf-8');
      data = require('papaparse').parse(csvText, { header: true, skipEmptyLines: true }).data;
    } else {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(fileBuffer);
      const ws = workbook.worksheets[0];
      data = [];
      ws.eachRow({ includeEmpty: false }, (row, idx) => {
        if (idx === 1) return;
        const obj = {};
        row.eachCell((cell, col) => {
          const header = ws.getRow(1).getCell(col).value;
          obj[header] = cell.value;
        });
        data.push(obj);
      });
    }
    const result = data.map(r => ({
      date: r.Date || r.date || new Date().toISOString().split('T')[0],
      amount: parseFloat(r.Amount || r.amount || 0).toFixed(2),
      description: r.Description || r.description || r.Item || 'Unknown',
      source: r.Source || r.source || r.Store || 'Unknown',
      type: toAmount(r.Amount || r.amount) >= 0 ? 'revenue' : 'expense',
    }));
    return result;
  } catch (error) {
    console.error('[ERROR] parseFinancialFile failed:', error.message);
    throw error;
  }
}

async function parseReceiptText(text) {
  try {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const amt = lines.find(l => l.match(/\$?\d+\.\d{2}/));
    const amount = amt ? (amt.match(/\$?(\d+\.\d{2})/)?.[1] || '0.00') : '0.00';
    const store = lines.find(l => !l.match(/\$?\d+\.\d{2}/)) || 'Unknown';
    return {
      date: new Date().toISOString().split('T')[0],
      item: store,
      amount: `$${amount}`,
      store,
    };
  } catch (error) {
    console.error('[ERROR] parseReceiptText failed:', error.message);
    throw error;
  }
}

// --- Time entries / Timesheets (TZ-safe) ---
const VALID_TYPES = new Set([
  'punch_in',
  'punch_out',
  'break_start',
  'break_end',
  'drive_start',
  'drive_end',
]);

const DUPE_WINDOW_SECONDS = Number(process.env.DUPE_WINDOW_SECONDS || 90);
const MAX_FUTURE_MINUTES = Number(process.env.MAX_FUTURE_MINUTES || 10);

function enforceNoFarFuture(timestampIso) {
  const now = Date.now();
  const ts = new Date(timestampIso).getTime();
  if ((ts - now) > MAX_FUTURE_MINUTES * 60 * 1000) {
    const err = new Error(`Timestamp is more than ${MAX_FUTURE_MINUTES} minutes in the future`);
    err.code = 'FUTURE_TS';
    throw err;
  }
}

async function logTimeEntry(ownerId, employeeName, type, timestamp, jobName = null, tz = 'America/Toronto', extras = {}) {
  try {
    if (!ownerId) throw new Error('Missing ownerId');
    if (!VALID_TYPES.has(type)) throw new Error('Invalid time entry type');
    if (!employeeName || typeof employeeName !== 'string' || employeeName.length > 100) {
      throw new Error('Invalid employee name');
    }
    if (!isValidIsoTimestamp(timestamp)) throw new Error('Invalid timestamp');
    enforceNoFarFuture(timestamp);
    if (jobName && jobName.length > 200) throw new Error('Job name too long');

    const ts = new Date(timestamp);
    const tsIso = ts.toISOString();
    const localStr = formatInTimeZone(ts, tz, 'yyyy-MM-dd HH:mm:ss');

    const lat = extras.lat ?? null;
    const lng = extras.lng ?? null;
    let address = extras.address ?? null;
    const createdBy = extras.requester_id || extras.created_by || null;

    const dupeQ = `
      SELECT id
      FROM time_entries
      WHERE owner_id=$1
        AND employee_name=$2
        AND type=$3
        AND timestamp BETWEEN ($4::timestamptz - INTERVAL '${DUPE_WINDOW_SECONDS} seconds')
                           AND ($4::timestamptz + INTERVAL '${DUPE_WINDOW_SECONDS} seconds')
      ORDER BY id DESC
      LIMIT 1`;
    const dupe = await query(dupeQ, [ownerId, employeeName, type, tsIso]);
    if (dupe.rows.length) return dupe.rows[0].id;

    const hasCreatedBy = await hasCreatedByColumn();
    let ins, params;
    if (hasCreatedBy) {
      ins = `
        INSERT INTO time_entries
          (owner_id, employee_name, type, timestamp, job_name, tz, local_time, lat, lng, address, created_by, created_at)
        VALUES ($1,$2,$3,$4::timestamptz,$5,$6,$7::timestamp,$8,$9,$10,$11,NOW())
        RETURNING id`;
      params = [ownerId, employeeName, type, tsIso, jobName || null, tz, localStr, lat, lng, address, createdBy];
    } else {
      ins = `
        INSERT INTO time_entries
          (owner_id, employee_name, type, timestamp, job_name, tz, local_time, lat, lng, address, created_at)
        VALUES ($1,$2,$3,$4::timestamptz,$5,$6,$7::timestamp,$8,$9,$10,NOW())
        RETURNING id`;
      params = [ownerId, employeeName, type, tsIso, jobName || null, tz, localStr, lat, lng, address];
    }

    const { rows } = await query(ins, params);
    const insertedId = rows[0].id;

    if ((lat != null && lng != null) && !address) {
      try {
        address = await reverseGeocode(lat, lng);
        if (address) {
          await query(`UPDATE time_entries SET address=$1 WHERE id=$2`, [address, insertedId]);
        }
      } catch (e) {
        console.warn('[WARN] reverseGeocode failed:', e.message);
      }
    }

    return insertedId;
  } catch (error) {
    console.error('[ERROR] logTimeEntry failed:', error.message);
    throw error;
  }
}

async function moveLastEntryToJob(ownerId, employeeName, jobName) {
  const q = `
    UPDATE time_entries t
    SET job_name = $1
    WHERE t.id = (
      SELECT id FROM time_entries
      WHERE owner_id = $2 AND employee_name = $3
      ORDER BY timestamp DESC
      LIMIT 1
    )
    RETURNING id, type, timestamp, job_name
  `;
  const { rows } = await query(q, [jobName || null, ownerId, employeeName]);
  return rows[0] || null;
}

async function getTimeEntries(ownerId, employeeName, period = 'week', date = new Date(), tz = 'America/Toronto') {
  try {
    const validPeriods = new Set(['day', 'week', 'month']);
    if (!validPeriods.has(period)) throw new Error('Invalid period');

    const dateLocal = formatInTimeZone(new Date(date), tz, 'yyyy-MM-dd');
    let filter;
    if (period === 'day') {
      filter = `DATE(local_time) = $2`;
    } else if (period === 'week') {
      filter = `DATE(local_time) BETWEEN $2 AND $2::date + INTERVAL '6 days'`;
    } else {
      filter = `DATE_TRUNC('month', local_time) = DATE_TRUNC('month', $2::date)`;
    }

    const q = `
      SELECT *, COALESCE(tz, $4) AS tz
      FROM time_entries
      WHERE owner_id = $1
        AND employee_name = $3
        AND ${filter}
      ORDER BY timestamp`;
    const res = await query(q, [ownerId, dateLocal, employeeName, tz]);
    return res.rows;
  } catch (error) {
    console.error('[ERROR] getTimeEntries failed:', error.message);
    throw error;
  }
}

async function getEntriesBetween(ownerId, employeeName, startIso, endIso) {
  try {
    const q = `
      SELECT *
      FROM time_entries
      WHERE owner_id = $1
        AND employee_name = $2
        AND timestamp >= $3::timestamptz
        AND timestamp <= $4::timestamptz
      ORDER BY timestamp`;
    const { rows } = await query(q, [ownerId, employeeName, startIso, endIso]);
    return rows;
  } catch (error) {
    console.error('[ERROR] getEntriesBetween failed:', error.message);
    throw error;
  }
}

async function getWorkAndDriveIntervals({ ownerId, employeeName, startUtc, endUtc }) {
  const q = `
  WITH params AS (
    SELECT $1::text AS owner_id, $2::text AS emp, $3::timestamptz AS s, $4::timestamptz AS e
  ),
  base AS (
    SELECT t.*
    FROM time_entries t, params p
    WHERE t.owner_id=p.owner_id
      AND t.employee_name=p.emp
      AND t.timestamp < p.e
      AND t.timestamp >= (p.s - INTERVAL '35 days')
  ),
  punch_pairs AS (
    SELECT
      i.timestamp AS in_ts,
      (
        SELECT o.timestamp
        FROM time_entries o, params p2
        WHERE o.owner_id = i.owner_id
          AND o.employee_name = i.employee_name
          AND o.type = 'punch_out'
          AND o.timestamp > i.timestamp
        ORDER BY o.timestamp
        LIMIT 1
      ) AS out_ts
    FROM base i
    WHERE i.type = 'punch_in'
  ),
  drive_pairs AS (
    SELECT
      i.timestamp AS start_ts,
      (
        SELECT o.timestamp
        FROM time_entries o
        WHERE o.owner_id = i.owner_id
          AND o.employee_name = i.employee_name
          AND o.type = 'drive_end'
          AND o.timestamp > i.timestamp
        ORDER BY o.timestamp
        LIMIT 1
      ) AS end_ts
    FROM base i
    WHERE i.type = 'drive_start'
  ),
  work_intervals AS (
    SELECT
      GREATEST(in_ts, (SELECT s FROM params)) AS start_utc,
      LEAST(out_ts, (SELECT e FROM params)) AS end_utc
    FROM punch_pairs
    WHERE out_ts IS NOT NULL
      AND GREATEST(in_ts, (SELECT s FROM params)) < LEAST(out_ts, (SELECT e FROM params))
  ),
  drive_intervals AS (
    SELECT
      GREATEST(start_ts, (SELECT s FROM params)) AS start_utc,
      LEAST(end_ts, (SELECT e FROM params)) AS end_utc
    FROM drive_pairs
    WHERE end_ts IS NOT NULL
      AND GREATEST(start_ts, (SELECT s FROM params)) < LEAST(end_ts, (SELECT e FROM params))
  )
  SELECT
    (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (end_utc - start_utc))),0) FROM work_intervals) AS work_seconds,
    (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (end_utc - start_utc))),0) FROM drive_intervals) AS drive_seconds;
  `;
  const { rows: [r] } = await query(q, [ownerId, employeeName, startUtc, endUtc]);
  return {
    workSeconds: Number(r.work_seconds) || 0,
    driveSeconds: Number(r.drive_seconds) || 0,
  };
}

async function getWeekDayBuckets({ ownerId, employeeName, startUtc, endUtc, tz }) {
  const q = `
    WITH params AS (
      SELECT $1::text AS owner_id, $2::text AS emp, $3::timestamptz AS s, $4::timestamptz AS e, $5::text AS tz
    ),
    week_days AS (
      SELECT gs::date AS d
      FROM params,
      LATERAL generate_series(
        date_trunc('week', (s AT TIME ZONE tz))::date,
        (date_trunc('week', (s AT TIME ZONE tz))::date + 6),
        INTERVAL '1 day'
      ) gs
    ),
    punch_pairs AS (
      SELECT
        i.timestamp AS in_ts,
        (
          SELECT o.timestamp
          FROM time_entries o, params p2
          WHERE o.owner_id = i.owner_id
            AND o.employee_name = i.employee_name
            AND o.type = 'punch_out'
            AND o.timestamp > i.timestamp
          ORDER BY o.timestamp
          LIMIT 1
        ) AS out_ts
      FROM time_entries i, params p
      WHERE i.owner_id=p.owner_id
        AND i.employee_name=p.emp
        AND i.type='punch_in'
        AND i.timestamp < p.e
        AND i.timestamp >= (p.s - INTERVAL '35 days')
    ),
    work_intervals AS (
      SELECT
        GREATEST(in_ts, (SELECT s FROM params)) AS start_utc,
        LEAST(out_ts, (SELECT e FROM params)) AS end_utc,
        (SELECT tz FROM params) AS tz
      FROM punch_pairs
      WHERE out_ts IS NOT NULL
        AND GREATEST(in_ts, (SELECT s FROM params)) < LEAST(out_ts, (SELECT e FROM params))
    ),
    day_buckets AS (
      SELECT
        wd.d AS local_day,
        COALESCE(SUM(
          GREATEST(0, EXTRACT(EPOCH FROM (
            LEAST(w.end_utc, (wd.d + INTERVAL '1 day') AT TIME ZONE w.tz) -
            GREATEST(w.start_utc, (wd.d AT TIME ZONE w.tz))
          )))
        ),0) AS seconds
      FROM week_days wd
      LEFT JOIN work_intervals w
        ON w.start_utc < ((wd.d + INTERVAL '1 day') AT TIME ZONE w.tz)
       AND w.end_utc > (wd.d AT TIME ZONE w.tz)
      GROUP BY 1
      ORDER BY 1
    )
    SELECT local_day, seconds FROM day_buckets;
  `;
  const { rows } = await query(q, [ownerId, employeeName, startUtc, endUtc, tz]);
  return rows.map(r => ({ day: String(r.local_day), seconds: Number(r.seconds) || 0 }));
}

async function getMonthWeekBuckets({ ownerId, employeeName, startUtc, endUtc, tz }) {
  const q = `
    WITH params AS (
      SELECT $1::text AS owner_id, $2::text AS emp, $3::timestamptz AS s, $4::timestamptz AS e, $5::text AS tz
    ),
    month_start AS (
      SELECT date_trunc('month', (s AT TIME ZONE tz))::date AS mstart FROM params
    ),
    week_starts AS (
      SELECT gs::date AS ws
      FROM month_start m,
      params p,
      LATERAL generate_series(
        date_trunc('week', m.mstart),
        (p.e AT TIME ZONE p.tz)::date,
        INTERVAL '7 day'
      ) gs
    ),
    week_ranges AS (
      SELECT ws AS week_start, (ws + INTERVAL '7 day') AS week_end
      FROM week_starts
    ),
    punch_pairs AS (
      SELECT
        i.timestamp AS in_ts,
        (
          SELECT o.timestamp
          FROM time_entries o, params p2
          WHERE o.owner_id = i.owner_id
            AND o.employee_name = i.employee_name
            AND o.type = 'punch_out'
            AND o.timestamp > i.timestamp
          ORDER BY o.timestamp
          LIMIT 1
        ) AS out_ts
      FROM time_entries i, params p
      WHERE i.owner_id=p.owner_id
        AND i.employee_name=p.emp
        AND i.type='punch_in'
        AND i.timestamp < p.e
        AND i.timestamp >= (p.s - INTERVAL '40 days')
    ),
    work_intervals AS (
      SELECT
        GREATEST(in_ts, (SELECT s FROM params)) AS start_utc,
        LEAST(out_ts, (SELECT e FROM params)) AS end_utc,
        (SELECT tz FROM params) AS tz
      FROM punch_pairs
      WHERE out_ts IS NOT NULL
        AND GREATEST(in_ts, (SELECT s FROM params)) < LEAST(out_ts, (SELECT e FROM params))
    ),
    weekly AS (
      SELECT
        wr.week_start,
        COALESCE(SUM(
          GREATEST(0, EXTRACT(EPOCH FROM (
            LEAST(w.end_utc, (wr.week_end AT TIME ZONE w.tz)) -
            GREATEST(w.start_utc, (wr.week_start AT TIME ZONE w.tz))
          )))
        ),0) AS seconds
      FROM week_ranges wr
      LEFT JOIN work_intervals w
        ON w.start_utc < (wr.week_end AT TIME ZONE w.tz)
       AND w.end_utc > (wr.week_start AT TIME ZONE w.tz)
      GROUP BY 1
      ORDER BY 1
    )
    SELECT week_start, seconds FROM weekly;
  `;
  const { rows } = await query(q, [ownerId, employeeName, startUtc, endUtc, tz]);
  return rows.map((r, i) => ({ idx: i + 1, weekStart: String(r.week_start), seconds: Number(r.seconds) || 0 }));
}

function startOfLocalDay(date, tz) {
  const z = utcToZonedTime(date, tz);
  z.setHours(0, 0, 0, 0);
  const y = z.getFullYear(), m = z.getMonth() + 1, d = z.getDate();
  return zonedTimeToUtc(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} 00:00:00`, tz);
}

function endOfLocalDay(date, tz) {
  const z = utcToZonedTime(date, tz);
  z.setHours(23, 59, 59, 999);
  const y = z.getFullYear(), m = z.getMonth() + 1, d = z.getDate();
  return zonedTimeToUtc(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} 23:59:59.999`, tz);
}

function startOfLocalWeek(date, tz, weekStartsOn = 1) {
  const z = utcToZonedTime(date, tz);
  const day = z.getDay();
  const diff = (day - weekStartsOn + 7) % 7;
  z.setDate(z.getDate() - diff);
  return startOfLocalDay(z, tz);
}

function startOfLocalMonth(date, tz) {
  const z = utcToZonedTime(date, tz);
  z.setDate(1);
  return startOfLocalDay(z, tz);
}

async function generateTimesheet(arg1, arg2, arg3, arg4, arg5) {
  if (typeof arg1 === 'object' && arg1 !== null && !Array.isArray(arg1)) {
    const {
      ownerId,
      person,
      period,
      tz = 'America/Toronto',
      now = new Date(),
    } = arg1;

    if (!ownerId || !person) {
      throw new Error('generateTimesheet(options): ownerId and person are required');
    }

    let startUtc, endUtc;
    if (period === 'day') {
      startUtc = startOfLocalDay(now, tz);
      endUtc = endOfLocalDay(now, tz);
    } else if (period === 'week') {
      startUtc = startOfLocalWeek(now, tz, 1);
      const sixDaysLater = new Date(startUtc.getTime() + 6 * 24 * 60 * 60 * 1000);
      endUtc = endOfLocalDay(sixDaysLater, tz);
    } else if (period === 'month') {
      startUtc = startOfLocalMonth(now, tz);
      endUtc = endOfLocalDay(now, tz);
    } else {
      throw new Error('period must be "day", "week", or "month"');
    }

    const { workSeconds, driveSeconds } = await getWorkAndDriveIntervals({
      ownerId, employeeName: person, startUtc, endUtc,
    });

    let breakdownLines = [];
    if (period === 'week') {
      const dayBuckets = await getWeekDayBuckets({ ownerId, employeeName: person, startUtc, endUtc, tz });
      const toDateSafe = (v) => {
        if (v instanceof Date) return v;
        const parsed = Date.parse(v);
        if (!Number.isNaN(parsed)) return new Date(parsed);
        return new Date(`${String(v).slice(0, 10)}T00:00:00Z`);
      };
      breakdownLines = dayBuckets.map((b) => {
        const d = toDateSafe(b.day);
        const label = formatInTimeZone(d, tz, 'EEEE');
        const hrs = (b.seconds / 3600).toFixed(2);
        return `${label} ${hrs} hours`;
      });
    } else if (period === 'month') {
      const weeks = await getMonthWeekBuckets({ ownerId, employeeName: person, startUtc, endUtc, tz });
      breakdownLines = weeks.map(w => `Week ${w.idx}: ${(w.seconds / 3600).toFixed(2)} hours`);
    }

    const totalHours = (workSeconds / 3600).toFixed(2);
    const driveHours = (driveSeconds / 3600).toFixed(2);
    const startLabel = formatInTimeZone(startUtc, tz, 'MMM d, yyyy');
    const endLabel = formatInTimeZone(endUtc, tz, 'MMM d, yyyy');

    let message = `${person} worked ${totalHours} hours`;
    if (period === 'day') {
      message = `${person} worked ${totalHours} hours today (${startLabel}).`;
    } else if (period === 'week') {
      message = `${person} worked ${totalHours} hours this week (${startLabel}–${endLabel}):\n` + breakdownLines.join('\n');
    } else if (period === 'month') {
      message = `${person} worked ${totalHours} hours so far this month (as of ${endLabel}):\n` + breakdownLines.join('\n');
    }
    message += `\nDrive Hours: ${driveHours}`;

    return {
      message,
      totalHours: Number(totalHours),
      driveHours: Number(driveHours),
      startUtc: startUtc.toISOString(),
      endUtc: endUtc.toISOString(),
      period,
      person,
    };
  }

  const ownerId = arg1, employeeName = arg2, period = arg3, date = arg4, tz = arg5 || 'America/Toronto';
  const entries = await getTimeEntries(ownerId, employeeName, period, date, tz);

  let totalHours = 0;
  let driveHours = 0;
  let lastPunchIn = null;
  let lastDriveStart = null;
  for (const e of entries) {
    const ts = new Date(e.timestamp);
    if (e.type === 'punch_in') lastPunchIn = ts;
    else if (e.type === 'punch_out' && lastPunchIn) {
      totalHours += (ts - lastPunchIn) / 3600000;
      lastPunchIn = null;
    } else if (e.type === 'drive_start') lastDriveStart = ts;
    else if (e.type === 'drive_end' && lastDriveStart) {
      driveHours += (ts - lastDriveStart) / 3600000;
      lastDriveStart = null;
    }
  }

  return {
    employeeName,
    period,
    startDate: new Date(date || new Date()).toISOString().split('T')[0],
    totalHours,
    driveHours,
    entriesByDay: {},
  };
}

async function createTimePrompt(ownerId, employeeName, kind, context = {}) {
  const q = `
    INSERT INTO timeclock_prompts (owner_id, employee_name, kind, context)
    VALUES ($1,$2,$3,$4::jsonb)
    RETURNING *`;
  const { rows } = await query(q, [ownerId, employeeName, kind, JSON.stringify(context)]);
  return rows[0];
}

async function getPendingPrompt(ownerId) {
  await query(`DELETE FROM timeclock_prompts WHERE expires_at < now() AND owner_id = $1`, [ownerId]);
  const { rows } = await query(
    `SELECT * FROM timeclock_prompts
     WHERE owner_id = $1 AND (expires_at IS NULL OR expires_at >= now())
     ORDER BY created_at DESC
     LIMIT 1`,
    [ownerId]
  );
  return rows?.[0] || null;
}

async function clearPrompt(id) {
  await query(`DELETE FROM timeclock_prompts WHERE id = $1`, [id]);
}

async function getOpenShift(ownerId, employeeName) {
  const q = `
    SELECT t.*, job_name
    FROM time_entries t
    WHERE t.owner_id = $1
      AND t.employee_name = $2
      AND t.type = 'punch_in'
      AND NOT EXISTS (
        SELECT 1 FROM time_entries o
        WHERE o.owner_id = t.owner_id
          AND o.employee_name = t.employee_name
          AND o.type = 'punch_out'
          AND o.timestamp > t.timestamp
      )
    ORDER BY t.timestamp DESC
    LIMIT 1`;
  const { rows } = await query(q, [ownerId, employeeName]);
  return rows[0] || null;
}

async function getOpenBreakSince(ownerId, employeeName, sinceUtcIso) {
  const q = `
    SELECT b.*, job_name
    FROM time_entries b
    WHERE b.owner_id = $1
      AND b.employee_name = $2
      AND b.type = 'break_start'
      AND b.timestamp >= $3::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM time_entries e
        WHERE e.owner_id = b.owner_id
          AND e.employee_name = b.employee_name
          AND e.type = 'break_end'
          AND e.timestamp > b.timestamp
      )
    ORDER BY b.timestamp DESC
    LIMIT 1`;
  const { rows } = await query(q, [ownerId, employeeName, sinceUtcIso]);
  return rows[0] || null;
}

async function closeOpenBreakIfAny(ownerId, employeeName, sinceUtcIso, endUtcIso, tz = 'America/Toronto') {
  const open = await getOpenBreakSince(ownerId, employeeName, sinceUtcIso);
  if (!open) return null;
  const localStr = formatInTimeZone(new Date(endUtcIso), tz, 'yyyy-MM-dd HH:mm:ss');
  const q = `
    INSERT INTO time_entries (owner_id, employee_name, type, timestamp, job_name, tz, local_time, created_at)
    VALUES ($1,$2,'break_end',$3::timestamptz,$4,$5,$6::timestamp,NOW())
    RETURNING id`;
  const { rows } = await query(q, [ownerId, employeeName, endUtcIso, open.job_name || null, tz, localStr]);
  return rows[0] || null;
}

// --- Time Entries: limits & audit ---
const TIER_LIMITS = { starter: 50, pro: 200, enterprise: 1000 };
function tierLimitFor(tier) {
  const key = String(tier || 'starter').toLowerCase();
  return { tierKey: key, tierLimit: TIER_LIMITS[key] ?? TIER_LIMITS.starter };
}

let HAS_CREATED_BY_CACHE = null;
async function hasCreatedByColumn() {
  if (HAS_CREATED_BY_CACHE !== null) return HAS_CREATED_BY_CACHE;
  try {
    const { rows } = await query(
      `SELECT 1
         FROM information_schema.columns
        WHERE table_name = 'time_entries'
          AND column_name = 'created_by'
        LIMIT 1`
    );
    HAS_CREATED_BY_CACHE = rows && rows.length > 0;
  } catch {
    HAS_CREATED_BY_CACHE = false;
  }
  return HAS_CREATED_BY_CACHE;
}

async function checkTimeEntryLimit(ownerId, tier) {
  const { tierKey, tierLimit } = tierLimitFor(tier);
  const { rows } = await query(
    `SELECT COUNT(*) AS count
       FROM time_entries
      WHERE owner_id = $1
        AND DATE(timestamp AT TIME ZONE 'UTC') = CURRENT_DATE`,
    [ownerId]
  );
  const count = parseInt(rows?.[0]?.count || '0', 10);
  return { ok: count < tierLimit, tierKey, tierLimit, count };
}

async function checkActorLimit(ownerId, actorId) {
  if (!(await hasCreatedByColumn())) return true;
  const { rows } = await query(
    `SELECT COUNT(*) AS count
       FROM time_entries
      WHERE owner_id = $1
        AND created_by = $2
        AND DATE(timestamp AT TIME ZONE 'UTC') = CURRENT_DATE`,
    [ownerId, String(actorId)]
  );
  const n = parseInt(rows?.[0]?.count || '0', 10);
  return n < 100;
}

async function generateReport(ownerId, tier) {
  try {
    const res = await query(
      `SELECT
         COALESCE(SUM(CASE WHEN type='revenue' THEN amount::numeric ELSE 0 END),0) AS revenue,
         COALESCE(SUM(CASE WHEN type IN ('expense','bill') THEN amount::numeric ELSE 0 END),0) AS expenses
       FROM transactions
       WHERE owner_id=$1`,
      [ownerId]
    );
    const revenue = parseFloat(res.rows[0].revenue) || 0;
    const expenses = parseFloat(res.rows[0].expenses) || 0;
    const report = { revenue, expenses, profit: revenue - expenses, tier };
    const reportId = crypto.randomBytes(8).toString('hex');
    await query(
      `INSERT INTO reports (owner_id, report_id, data, created_at)
       VALUES ($1,$2,$3::jsonb,NOW())`,
      [ownerId, reportId, JSON.stringify(report)]
    );
    const url = `https://chief-ai-refactored.vercel.app/reports/${reportId}`;
    return { url };
  } catch (error) {
    console.error('[ERROR] generateReport failed:', error.message);
    throw error;
  }
}

async function exportTimesheetXlsx({ ownerId, startIso, endIso, employeeName = null, tz = 'America/Toronto' }) {
  const params = employeeName
    ? [ownerId, startIso, endIso, tz, employeeName]
    : [ownerId, startIso, endIso, tz];

  const { rows } = await query(
    `SELECT employee_name, type, timestamp, COALESCE(job_name,'') AS job_name, COALESCE(tz,$4) AS tz
     FROM time_entries
     WHERE owner_id = $1
       AND timestamp >= $2::timestamptz
       AND timestamp <= $3::timestamptz
       ${employeeName ? 'AND employee_name = $5' : ''}
     ORDER BY employee_name, timestamp ASC`,
    params
  );

  const wb = new ExcelJS.Workbook();
  const byEmp = groupBy(rows, 'employee_name');

  const sum = wb.addWorksheet('Summary');
  sum.columns = [
    { header: 'Employee', key: 'employee', width: 24 },
    { header: 'Entries', key: 'entries', width: 10 },
    { header: 'Shift Hours', key: 'hours', width: 14 },
    { header: 'Drive Hours', key: 'drive', width: 14 },
    { header: 'Break Minutes', key: 'breaks', width: 16 },
    { header: 'Start', key: 'start', width: 12 },
    { header: 'End', key: 'end', width: 12 },
  ];
  const startStr = (startIso || '').slice(0, 10);
  const endStr = (endIso || '').slice(0, 10);
  for (const emp of Object.keys(byEmp)) {
    const summary = computeEmployeeSummary(byEmp[emp]);
    sum.addRow({
      employee: emp,
      entries: byEmp[emp].length,
      hours: summary.totalHours,
      drive: summary.driveHours,
      breaks: summary.breakMinutes,
      start: startStr,
      end: endStr,
    });
  }
  sum.getRow(1).font = { bold: true };

  for (const emp of Object.keys(byEmp)) {
    const safeName = String(emp).slice(0, 31).replace(/[\\/?*[\]:]/g, ' ');
    const ws = wb.addWorksheet(safeName || 'Employee');
    ws.columns = [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Local Time', key: 'local', width: 20 },
      { header: 'UTC Time', key: 'utc', width: 20 },
      { header: 'Type', key: 'type', width: 16 },
      { header: 'Job', key: 'job', width: 28 },
    ];
    for (const r of byEmp[emp]) {
      const ts = new Date(r.timestamp);
      ws.addRow({
        date: ts.toISOString().slice(0, 10),
        local: formatInTimeZone(ts, r.tz, 'yyyy-MM-dd HH:mm'),
        utc: ts.toISOString().slice(11, 19) + 'Z',
        type: r.type,
        job: r.job_name || '',
      });
    }
    ws.getRow(1).font = { bold: true };
  }

  const buf = await wb.xlsx.writeBuffer();
  const id = crypto.randomBytes(12).toString('hex');
  const filename = `timesheet_${startStr}_${endStr}${employeeName ? '_' + employeeName.replace(/\s+/g, '_') : ''}.xlsx`;
  const contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  await query(
    `INSERT INTO file_exports (id, owner_id, filename, content_type, bytes, created_at)
     VALUES ($1,$2,$3,$4,$5,NOW())`,
    [id, ownerId, filename, contentType, Buffer.from(buf)]
  );

  const baseUrl = process.env.PUBLIC_BASE_URL || 'https://chief-ai-refactored.vercel.app';
  return { url: `${baseUrl}/exports/${id}`, id, filename, contentType };
}

async function exportTimesheetPdf({ ownerId, startIso, endIso, employeeName = null, tz = 'America/Toronto' }) {
  const params = employeeName
    ? [ownerId, startIso, endIso, tz, employeeName]
    : [ownerId, startIso, endIso, tz];

  const { rows } = await query(
    `SELECT employee_name, type, timestamp, COALESCE(job_name,'') AS job_name, COALESCE(tz,$4) AS tz
     FROM time_entries
     WHERE owner_id = $1
       AND timestamp >= $2::timestamptz
       AND timestamp <= $3::timestamptz
       ${employeeName ? 'AND employee_name = $5' : ''}
     ORDER BY employee_name, timestamp ASC`,
    params
  );

  const byEmp = groupBy(rows, 'employee_name');

  const doc = new PDFDocument({ size: 'LETTER', margin: 40 });
  const chunks = [];
  doc.on('data', d => chunks.push(d));
  const done = new Promise(res => doc.on('end', res));

  const title = `Timesheet ${startIso.slice(0, 10)} → ${endIso.slice(0, 10)}`;
  doc.fontSize(16).text(title, { align: 'center' }).moveDown();

  for (const emp of Object.keys(byEmp)) {
    doc.fontSize(13).text(emp, { underline: true }).moveDown(0.5);
    const summary = computeEmployeeSummary(byEmp[emp]);
    doc.fontSize(10).text(
      `Shift Hours: ${summary.totalHours.toFixed(2)}   ` +
      `Drive Hours: ${summary.driveHours.toFixed(2)}   ` +
      `Break Minutes: ${summary.breakMinutes}`
    ).moveDown(0.4);

    doc.fontSize(10)
      .text('Date', 40)
      .text('Local Time', 130)
      .text('UTC', 240)
      .text('Type', 320)
      .text('Job', 420)
      .moveDown(0.2);
    doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke().moveDown(0.3);

    for (const r of byEmp[emp]) {
      const ts = new Date(r.timestamp);
      doc.text(ts.toISOString().slice(0, 10), 40)
         .text(formatInTimeZone(ts, r.tz, 'yyyy-MM-dd HH:mm'), 130)
         .text(ts.toISOString().slice(11, 19) + 'Z', 240)
         .text(r.type, 320)
         .text(r.job_name || '', 420)
         .moveDown(0.1);
      if (doc.y > 720) doc.addPage();
    }

    doc.moveDown(0.6);
    doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke().moveDown(0.6);
  }

  doc.end();
  await done;
  const buffer = Buffer.concat(chunks);

  const id = crypto.randomBytes(12).toString('hex');
  const filename = `timesheet_${startIso.slice(0, 10)}_${endIso.slice(0, 10)}${employeeName ? '_' + employeeName.replace(/\s+/g, '_') : ''}.pdf`;
  const contentType = 'application/pdf';

  await query(
    `INSERT INTO file_exports (id, owner_id, filename, content_type, bytes, created_at)
     VALUES ($1,$2,$3,$4,$5,NOW())`,
    [id, ownerId, filename, contentType, buffer]
  );

  const baseUrl = process.env.PUBLIC_BASE_URL || 'https://chief-ai-refactored.vercel.app';
  return { url: `${baseUrl}/exports/${id}`, id, filename, contentType };
}

async function getUserBasic(userId) {
  const uid = normalizePhoneNumber(userId);
  try {
    const { rows } = await query(
      `SELECT user_id, owner_id, name, role, can_edit_time
       FROM users
       WHERE user_id=$1`,
      [uid]
    );
    return rows[0] || null;
  } catch (error) {
    console.error('[ERROR] getUserBasic failed:', error.message);
    throw error;
  }
}

async function getUserByName(ownerId, nameLike) {
  try {
    const { rows } = await query(
      `SELECT user_id, name, role
       FROM users
       WHERE owner_id=$1 AND name ILIKE $2
       ORDER BY (CASE WHEN name ILIKE $3 THEN 0 ELSE 1 END), name ASC
       LIMIT 1`,
      [ownerId, `${nameLike}%`, nameLike]
    );
    return rows[0] || null;
  } catch (error) {
    console.error('[ERROR] getUserByName failed:', error.message);
    throw error;
  }
}

async function createTask({
  ownerId,
  createdBy,
  assignedTo = null,
  title,
  body = null,
  type = 'general',
  relatedEntryId = null,
  dueAt = null,
}) {
  if (!ownerId || !createdBy || !title) throw new Error('Missing required fields');

  try {
    const { rows } = await query(
      `
      INSERT INTO tasks
        (owner_id, created_by, assigned_to, title, body, status, type, related_entry_id, due_at)
      VALUES
        ($1, $2, $3, $4, $5, 'open', $6, $7, $8)
      RETURNING id, task_no, owner_id, created_by, assigned_to, title, due_at, status, type, related_entry_id, created_at, updated_at
      `,
      [
        ownerId,
        normalizePhoneNumber(createdBy),
        assignedTo ? normalizePhoneNumber(assignedTo) : null,
        title,
        body,
        type,
        relatedEntryId,
        dueAt,
      ]
    );
    return rows[0]; // includes task_no (set by trigger)
  } catch (error) {
    console.error('[ERROR] createTask failed:', error.message);
    throw error;
  }
}

async function listMyTasks({ ownerId, userId, status = 'open' }) {
  try {
    const { rows } = await query(
      `
      SELECT
        t.task_no,
        t.title,
        t.due_at,
        t.status,
        COALESCE(c.name, t.created_by) AS creator_name
      FROM tasks t
      LEFT JOIN users c ON c.user_id = t.created_by
      WHERE t.owner_id = $1
        AND t.assigned_to = $2
        AND t.status = $3
      ORDER BY t.due_at ASC NULLS LAST, t.task_no ASC
      `,
      [ownerId, normalizePhoneNumber(userId), status]
    );
    return rows;
  } catch (error) {
    console.error('[ERROR] listMyTasks failed:', error.message);
    throw error;
  }
}

async function listInboxTasks({ ownerId, status = 'open' }) {
  try {
    const { rows } = await query(
      `
      SELECT
        t.task_no,
        t.title,
        t.due_at,
        t.status,
        t.created_by,
        COALESCE(c.name, t.created_by) AS creator_name
      FROM tasks t
      LEFT JOIN users c ON c.user_id = t.created_by
      WHERE t.owner_id = $1
        AND t.assigned_to IS NULL
        AND t.status = $2
      ORDER BY t.due_at ASC NULLS LAST, t.task_no ASC
      `,
      [ownerId, status]
    );
    return rows;
  } catch (error) {
    console.error('[ERROR] listInboxTasks failed:', error.message);
    throw error;
  }
}

async function listTasksForUser({ ownerId, nameOrId, status = 'open' }) {
  try {
    let user = null;
    if (/^\+?\d{10,15}$/.test(String(nameOrId))) {
      user = await getUserBasic(nameOrId);
    } else {
      user = await getUserByName(ownerId, nameOrId);
    }
    if (!user) return [];
    return await listMyTasks({ ownerId, userId: user.user_id, status });
  } catch (error) {
    console.error('[ERROR] listTasksForUser failed:', error.message);
    throw error;
  }
}

async function markTaskDone({ ownerId, taskNo, actorId }) {
  try {
    const actor = normalizePhoneNumber(actorId);
    const { rows } = await query(
      `
      UPDATE tasks
         SET status = 'done',
             updated_at = NOW()
       WHERE owner_id = $1
         AND task_no  = $2
         AND (
               assigned_to = $3
               OR (assigned_to IS NULL AND created_by = $3)
             )
       RETURNING task_no, title
      `,
      [ownerId, taskNo, actor]
    );
    if (!rows.length) throw new Error('Task not found');
    return rows[0];
  } catch (error) {
    console.error('[ERROR] markTaskDone failed:', error.message);
    throw error;
  }
}

async function reopenTask({ ownerId, taskNo, actorId }) {
  try {
    const actor = normalizePhoneNumber(actorId);
    const { rows } = await query(
      `
      UPDATE tasks
         SET status = 'open',
             updated_at = NOW()
       WHERE owner_id = $1
         AND task_no  = $2
         AND (
               assigned_to = $3
               OR (assigned_to IS NULL AND created_by = $3)
             )
       RETURNING task_no, title
      `,
      [ownerId, taskNo, actor]
    );
    if (!rows.length) throw new Error('Task not found');
    return rows[0];
  } catch (error) {
    console.error('[ERROR] reopenTask failed:', error.message);
    throw error;
  }
}

async function createTimeEditRequestTask({
  ownerId,
  employeeId,
  requesterId,
  title,
  body,
  relatedEntryId = null,
}) {
  try {
    const task = await createTask({
      ownerId,
      createdBy: requesterId,
      assignedTo: null,
      title,
      body,
      type: 'time_edit_request',
      relatedEntryId,
    });
    return task;
  } catch (error) {
    console.error('[ERROR] createTimeEditRequestTask failed:', error.message);
    throw error;
  }
}

async function getCurrentStatus(ownerId, employeeName) {
  const res = await query(
    `
    SELECT type, timestamp
      FROM time_entries
     WHERE owner_id = $1
       AND employee_name = $2
     ORDER BY timestamp DESC
     LIMIT 2
    `,
    [ownerId, employeeName]
  );

  let onShift = false;
  let onBreak = false;
  let lastShiftStart = null;
  let lastBreakStart = null;

  for (const entry of res.rows) {
    if (entry.type === 'punch_in') {
      onShift = true;
      lastShiftStart = entry.timestamp;
      break;
    } else if (entry.type === 'punch_out') {
      onShift = false;
      break;
    } else if (entry.type === 'break_start') {
      onBreak = true;
      lastBreakStart = entry.timestamp;
    } else if (entry.type === 'break_end') {
      onBreak = false;
    }
  }

  return { onShift, onBreak, lastShiftStart, lastBreakStart };
}

// --- Exports ---
module.exports = {
  get pool() { return getPool(); },
  getPool,
  query,
  withClient,
  appendToUserSpreadsheet,
  saveExpense,
  deleteExpense,
  saveBill,
  updateBill,
  deleteBill,
  saveRevenue,
  saveQuote,
  addPricingItem,
  getPricingItems,
  updatePricingItem,
  deletePricingItem,
  getActiveJob,
  saveJob,
  setActiveJob,
  finishJob,
  createJob,
  finalizeJobCreation,
  pauseJob,
  resumeJob,
  listOpenJobs,
  summarizeJob,
  createUserProfile,
  saveUserProfile,
  getUserProfile,
  getOwnerProfile,
  getCurrentStatus,
  parseFinancialFile,
  parseReceiptText,
  generateOTP,
  verifyOTP,
  logTimeEntry,
  moveLastEntryToJob,
  getTimeEntries,
  getEntriesBetween,
  generateTimesheet,
  createTimePrompt,
  getPendingPrompt,
  clearPrompt,
  getOpenShift,
  getOpenBreakSince,
  closeOpenBreakIfAny,
  generateReport,
  exportTimesheetXlsx,
  exportTimesheetPdf,
  createTask,
  listMyTasks,
  listInboxTasks,
  listTasksForUser,
  markTaskDone,
  reopenTask,
  createTimeEditRequestTask,
  getUserBasic,
  getUserByName,
  normalizePhoneNumber,
  checkTimeEntryLimit,
  checkActorLimit,
  hasCreatedByColumn,
};
