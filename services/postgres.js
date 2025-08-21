// services/postgres.js
const { Pool } = require('pg');
const crypto = require('crypto');
const ExcelJS = require('exceljs');

// --- Postgres pool ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

// Safe debug for DATABASE_URL host (non-prod)
if (process.env.NODE_ENV !== 'production') {
  try {
    if (process.env.DATABASE_URL) {
      console.log('[DEBUG] DATABASE_URL host:', new URL(process.env.DATABASE_URL).hostname);
    } else {
      console.warn('[DEBUG] DATABASE_URL is not set');
    }
  } catch (e) {
    console.warn('[DEBUG] Could not parse DATABASE_URL:', e.message);
  }
}

// --- Helpers ---
function normalizePhoneNumber(phone = '') {
  const val = String(phone || '');
  const noWa = val.startsWith('whatsapp:') ? val.slice('whatsapp:'.length) : val;
  return noWa.replace(/^\+/, '').trim();
}

// --- OTP & verification (moved up so exports always see them) ---
async function generateOTP(userId) {
  const normalizedId = normalizePhoneNumber(userId);
  try {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    await pool.query(
      `UPDATE users SET otp=$1, otp_expiry=$2 WHERE user_id=$3`,
      [otp, expiry, normalizedId],
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
    const res = await pool.query(
      `SELECT otp, otp_expiry FROM users WHERE user_id=$1`,
      [normalizedId],
    );
    const user = res.rows[0];
    const isValid = !!user && user.otp === otp && new Date() <= new Date(user.otp_expiry);

    if (!isValid) return false;

    await pool.query(`UPDATE users SET otp=NULL, otp_expiry=NULL WHERE user_id=$1`, [normalizedId]);
    return true;
  } catch (error) {
    console.error('[ERROR] verifyOTP failed:', error.message);
    throw error;
  }
}

// --- Transactions / Expenses / Bills / Revenue / Quotes ---
async function appendToUserSpreadsheet(ownerId, data) {
  console.log('[DEBUG] appendToUserSpreadsheet called:', { ownerId, data });
  try {
    const [date, item, amount, store, jobName, type, category, mediaUrl, userName] = data;
    const query = `
      INSERT INTO transactions
        (owner_id, date, item, amount, store, job_name, type, category, media_url, user_name, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
      RETURNING id`;
    const result = await pool.query(query, [
      ownerId, date, item, parseFloat(amount), store, jobName, type, category, mediaUrl || null, userName,
    ]);
    console.log('[DEBUG] appendToUserSpreadsheet success:', { id: result.rows[0].id });
    return result.rows[0].id;
  } catch (error) {
    console.error('[ERROR] appendToUserSpreadsheet failed:', error.message);
    throw error;
  }
}

async function saveExpense({ ownerId, date, item, amount, store, jobName, category, user, mediaUrl }) {
  console.log('[DEBUG] saveExpense called for ownerId:', ownerId);
  try {
    await pool.query(
      `INSERT INTO transactions (owner_id, type, date, item, amount, store, job_name, category, user_name, media_url, created_at)
       VALUES ($1,'expense',$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
      [ownerId, date, item, parseFloat(String(amount).replace('$', '')), store, jobName, category, user, mediaUrl || null],
    );
    console.log('[DEBUG] saveExpense success for', ownerId);
  } catch (error) {
    console.error('[ERROR] saveExpense failed for', ownerId, ':', error.message);
    throw error;
  }
}

async function deleteExpense(ownerId, criteria) {
  console.log('[DEBUG] deleteExpense called for ownerId:', ownerId, ', criteria:', criteria);
  try {
    const res = await pool.query(
      `DELETE FROM transactions
       WHERE owner_id=$1 AND type='expense' AND item=$2 AND amount=$3 AND store=$4
       RETURNING *`,
      [ownerId, criteria.item, parseFloat(String(criteria.amount).replace('$', '')), criteria.store],
    );
    console.log('[DEBUG] deleteExpense result:', res.rows[0]);
    return res.rows.length > 0;
  } catch (error) {
    console.error('[ERROR] deleteExpense failed for', ownerId, ':', error.message);
    return false;
  }
}

async function saveBill(ownerId, billData) {
  console.log('[DEBUG] saveBill called for ownerId:', ownerId);
  try {
    await pool.query(
      `INSERT INTO transactions (owner_id, type, date, item, amount, recurrence, job_name, category, created_at)
       VALUES ($1,'bill',$2,$3,$4,$5,$6,$7,NOW())`,
      [
        ownerId,
        billData.date,
        billData.billName,
        parseFloat(String(billData.amount).replace('$', '')),
        billData.recurrence,
        billData.jobName,
        billData.category,
      ],
    );
    console.log('[DEBUG] saveBill success for', ownerId);
  } catch (error) {
    console.error('[ERROR] saveBill failed:', error.message);
    throw error;
  }
}

async function updateBill(ownerId, billData) {
  console.log('[DEBUG] updateBill called for ownerId:', ownerId);
  try {
    const res = await pool.query(
      `UPDATE transactions
       SET amount = COALESCE($1, amount),
           recurrence = COALESCE($2, recurrence),
           date = COALESCE($3, date),
           updated_at = NOW()
       WHERE owner_id=$4 AND type='bill' AND item=$5
       RETURNING *`,
      [
        billData.amount ? parseFloat(String(billData.amount).replace('$', '')) : null,
        billData.recurrence,
        billData.date,
        ownerId,
        billData.billName,
      ],
    );
    console.log('[DEBUG] updateBill result:', res.rows[0]);
    return res.rows.length > 0;
  } catch (error) {
    console.error('[ERROR] updateBill failed:', error.message);
    return false;
  }
}

async function deleteBill(ownerId, billName) {
  console.log('[DEBUG] deleteBill called for ownerId:', ownerId);
  try {
    const res = await pool.query(
      `DELETE FROM transactions WHERE owner_id=$1 AND type='bill' AND item=$2 RETURNING *`,
      [ownerId, billName],
    );
    console.log('[DEBUG] deleteBill result:', res.rows[0]);
    return res.rows.length > 0;
  } catch (error) {
    console.error('[ERROR] deleteBill failed:', error.message);
    return false;
  }
}

async function saveRevenue(ownerId, revenueData) {
  console.log('[DEBUG] saveRevenue called for ownerId:', ownerId);
  try {
    // Align to transactions schema using item/store
    await pool.query(
      `INSERT INTO transactions (owner_id, type, amount, item, store, category, date, job_name, created_at)
       VALUES ($1,'revenue',$2,$3,$4,$5,$6,$7,NOW())`,
      [
        ownerId,
        parseFloat(String(revenueData.amount).replace('$', '')),
        revenueData.description, // -> item
        revenueData.source,      // -> store
        revenueData.category,
        revenueData.date,
        revenueData.jobName,
      ],
    );
    console.log('[DEBUG] saveRevenue success for', ownerId);
  } catch (error) {
    console.error('[ERROR] saveRevenue failed:', error.message);
    throw error;
  }
}

async function saveQuote(ownerId, quoteData) {
  console.log('[DEBUG] saveQuote called for ownerId:', ownerId);
  try {
    await pool.query(
      `INSERT INTO quotes (owner_id, amount, description, client, job_name, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW())`,
      [ownerId, parseFloat(quoteData.amount), quoteData.description, quoteData.client, quoteData.jobName],
    );
    console.log('[DEBUG] saveQuote success for', ownerId);
  } catch (error) {
    console.error('[ERROR] saveQuote failed:', error.message);
    throw error;
  }
}

// --- Jobs ---
async function getActiveJob(ownerId) {
  console.log('[DEBUG] getActiveJob called:', { ownerId });
  try {
    const res = await pool.query(
      `SELECT job_name FROM jobs WHERE owner_id=$1 AND active=true LIMIT 1`,
      [ownerId],
    );
    const name = res.rows[0]?.job_name || 'Uncategorized';
    console.log('[DEBUG] getActiveJob result:', name);
    return name;
  } catch (error) {
    console.error('[ERROR] getActiveJob failed:', error.message);
    return 'Uncategorized';
  }
}

async function saveJob(ownerId, jobName, startDate) {
  console.log('[DEBUG] saveJob called:', { ownerId, jobName });
  try {
    await pool.query(
      `INSERT INTO jobs (owner_id, job_name, start_date, active, created_at)
       VALUES ($1,$2,$3,true,NOW())`,
      [ownerId, jobName, startDate],
    );
    console.log('[DEBUG] saveJob success');
  } catch (error) {
    console.error('[ERROR] saveJob failed:', error.message);
    throw error;
  }
}

async function setActiveJob(ownerId, jobName) {
  console.log('[DEBUG] setActiveJob called:', { ownerId, jobName });
  try {
    await pool.query(`UPDATE jobs SET active=false WHERE owner_id=$1`, [ownerId]);
    await pool.query(
      `UPDATE jobs SET active=true, start_date=NOW() WHERE owner_id=$1 AND job_name=$2`,
      [ownerId, jobName],
    );
    console.log('[DEBUG] setActiveJob success');
  } catch (error) {
    console.error('[ERROR] setActiveJob failed:', error.message);
    throw error;
  }
}

async function finishJob(ownerId, jobName) {
  console.log('[DEBUG] finishJob called:', { ownerId, jobName });
  try {
    await pool.query(
      `UPDATE jobs
       SET active=false, end_date=NOW()
       WHERE owner_id=$1 AND job_name=$2`,
      [ownerId, jobName],
    );
    console.log('[DEBUG] finishJob success');
  } catch (error) {
    console.error('[ERROR] finishJob failed:', error.message);
    throw error;
  }
}

async function createJob(ownerId, jobName) {
  console.log('[DEBUG] createJob called:', { ownerId, jobName });
  try {
    await pool.query(
      `INSERT INTO jobs (owner_id, job_name, active, created_at)
       VALUES ($1,$2,false,NOW())`,
      [ownerId, jobName],
    );
    console.log('[DEBUG] createJob success');
  } catch (error) {
    console.error('[ERROR] createJob failed:', error.message);
    throw error;
  }
}

async function finalizeJobCreation(ownerId, jobName, activate) {
  console.log('[DEBUG] finalizeJobCreation called:', { ownerId, jobName, activate });
  try {
    await createJob(ownerId, jobName);
    if (activate) {
      await setActiveJob(ownerId, jobName);
    }
    console.log('[DEBUG] finalizeJobCreation success');
  } catch (error) {
    console.error('[ERROR] finalizeJobCreation failed:', error.message);
    throw error;
  }
}

async function pauseJob(ownerId, jobName) {
  console.log('[DEBUG] pauseJob called:', { ownerId, jobName });
  try {
    await pool.query(
      `UPDATE jobs SET active=false WHERE owner_id=$1 AND job_name=$2`,
      [ownerId, jobName],
    );
    console.log('[DEBUG] pauseJob success');
  } catch (error) {
    console.error('[ERROR] pauseJob failed:', error.message);
    throw error;
  }
}

async function resumeJob(ownerId, jobName) {
  console.log('[DEBUG] resumeJob called:', { ownerId, jobName });
  try {
    await pool.query(
      `UPDATE jobs SET active=true WHERE owner_id=$1 AND job_name=$2`,
      [ownerId, jobName],
    );
    console.log('[DEBUG] resumeJob success');
  } catch (error) {
    console.error('[ERROR] resumeJob failed:', error.message);
    throw error;
  }
}

async function summarizeJob(ownerId, jobName) {
  console.log('[DEBUG] summarizeJob called:', { ownerId, jobName });
  try {
    const jobRes = await pool.query(
      `SELECT start_date, end_date FROM jobs
       WHERE owner_id=$1 AND job_name=$2 LIMIT 1`,
      [ownerId, jobName],
    );
    const { start_date, end_date } = jobRes.rows[0] || {};
    const start = start_date || new Date();
    const end = end_date || new Date();
    const durationDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24));

    const expRes = await pool.query(
      `SELECT COALESCE(SUM(amount::numeric),0) AS total_expenses
       FROM transactions
       WHERE owner_id=$1 AND job_name=$2 AND (type='expense' OR type='bill')`,
      [ownerId, jobName],
    );
    const revRes = await pool.query(
      `SELECT COALESCE(SUM(amount::numeric),0) AS total_revenue
       FROM transactions
       WHERE owner_id=$1 AND job_name=$2 AND type='revenue'`,
      [ownerId, jobName],
    );
    const materialCost = parseFloat(expRes.rows[0].total_expenses);
    const revenue = parseFloat(revRes.rows[0].total_revenue);
    const profit = revenue - materialCost;
    const profitMargin = revenue > 0 ? profit / revenue : 0;

    const rateRes = await pool.query(
      `SELECT unit_cost FROM pricing_items
       WHERE owner_id=$1 AND category='labour' LIMIT 1`,
      [ownerId],
    );
    const labourRate = parseFloat(rateRes.rows[0]?.unit_cost) || 0;

    const timeRes = await pool.query(
      `SELECT COALESCE(
         SUM(
           EXTRACT(EPOCH FROM (LEAD(timestamp) OVER (ORDER BY timestamp) - timestamp))/3600
         ),0) AS hours
       FROM time_entries
       WHERE owner_id=$1 AND job_name=$2`,
      [ownerId, jobName],
    );
    const labourHours = parseFloat(timeRes.rows[0].hours);
    const labourCost = labourHours * labourRate;

    console.log('[DEBUG] summarizeJob result:', { durationDays, labourHours, labourCost, materialCost, revenue, profit, profitMargin });
    return { durationDays, labourHours, labourCost, materialCost, revenue, profit, profitMargin };
  } catch (error) {
    console.error('[ERROR] summarizeJob failed:', error.message);
    throw error;
  }
}

// --- Pricing Items ---
async function addPricingItem(ownerId, itemName, unitCost, unit = 'each', category = 'material') {
  console.log('[DEBUG] addPricingItem called:', { ownerId, itemName, unitCost, unit, category });
  try {
    const res = await pool.query(
      `INSERT INTO pricing_items
        (owner_id, item_name, unit_cost, unit, category, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       RETURNING *`,
      [ownerId, itemName, unitCost, unit, category],
    );
    console.log('[DEBUG] addPricingItem success:', res.rows[0]);
    return res.rows[0];
  } catch (error) {
    console.error('[ERROR] addPricingItem failed:', error.message);
    throw error;
  }
}

async function getPricingItems(ownerId) {
  console.log('[DEBUG] getPricingItems called:', { ownerId });
  try {
    const res = await pool.query(
      `SELECT item_name, unit_cost, unit, category
       FROM pricing_items
       WHERE owner_id=$1`,
      [ownerId],
    );
    console.log('[DEBUG] getPricingItems result:', res.rows);
    return res.rows;
  } catch (error) {
    console.error('[ERROR] getPricingItems failed:', error.message);
    throw error;
  }
}

async function updatePricingItem(ownerId, itemName, unitCost) {
  console.log('[DEBUG] updatePricingItem called:', { ownerId, itemName, unitCost });
  try {
    const res = await pool.query(
      `UPDATE pricing_items
       SET unit_cost=$1
       WHERE owner_id=$2 AND item_name=$3
       RETURNING *`,
      [unitCost, ownerId, itemName],
    );
    console.log('[DEBUG] updatePricingItem result:', res.rows[0]);
    return res.rows[0];
  } catch (error) {
    console.error('[ERROR] updatePricingItem failed:', error.message);
    throw error;
  }
}

async function deletePricingItem(ownerId, itemName) {
  console.log('[DEBUG] deletePricingItem called:', { ownerId, itemName });
  try {
    await pool.query(
      `DELETE FROM pricing_items
       WHERE owner_id=$1 AND item_name=$2`,
      [ownerId, itemName],
    );
    console.log('[DEBUG] deletePricingItem success');
    return true;
  } catch (error) {
    console.error('[ERROR] deletePricingItem failed:', error.message);
    throw error;
  }
}

// --- Users ---
async function createUserProfile({ user_id, ownerId, onboarding_in_progress = false }) {
  const normalizedId = normalizePhoneNumber(user_id);
  const normalizedOwnerId = normalizePhoneNumber(ownerId);
  console.log('[DEBUG] createUserProfile called:', { user_id: normalizedId, ownerId: normalizedOwnerId, onboarding_in_progress });
  try {
    const dashboard_token = crypto.randomBytes(16).toString('hex');
    const result = await pool.query(
      `INSERT INTO users
         (user_id, owner_id, onboarding_in_progress, onboarding_completed, subscription_tier, dashboard_token, created_at)
       VALUES
         ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET onboarding_in_progress = EXCLUDED.onboarding_in_progress
       RETURNING *`,
      [normalizedId, normalizedOwnerId, onboarding_in_progress, false, 'basic', dashboard_token],
    );
    console.log('[DEBUG] createUserProfile success:', result.rows[0]);
    return result.rows[0];
  } catch (error) {
    console.error('[ERROR] createUserProfile failed:', error.message);
    throw error;
  }
}

/**
 * Upsert user profile with whatever fields are provided.
 * Supports stripe ids, goal_context, terms_accepted_at, etc.
 */
async function saveUserProfile(profile) {
  const normalizedId = normalizePhoneNumber(profile.user_id);
  console.log('[DEBUG] saveUserProfile called:', { user_id: normalizedId });

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
    const result = await pool.query(sql, values);
    console.log('[DEBUG] saveUserProfile success:', result.rows[0]);
    return result.rows[0];
  } catch (error) {
    console.error('[ERROR] saveUserProfile failed:', error.message);
    throw error;
  }
}

async function getUserProfile(userId) {
  const normalizedId = normalizePhoneNumber(userId);
  console.log('[DEBUG] getUserProfile called:', { userId: normalizedId });
  try {
    const res = await pool.query('SELECT * FROM users WHERE user_id=$1', [normalizedId]);
    console.log('[DEBUG] getUserProfile result:', res.rows[0] || 'No user found');
    return res.rows[0] || null;
  } catch (error) {
    console.error('[ERROR] getUserProfile failed:', error.message);
    throw error;
  }
}

async function getOwnerProfile(ownerId) {
  const normalizedId = normalizePhoneNumber(ownerId);
  console.log('[DEBUG] getOwnerProfile called:', { ownerId: normalizedId });
  try {
    const res = await pool.query('SELECT * FROM users WHERE user_id=$1', [normalizedId]);
    console.log('[DEBUG] getOwnerProfile result:', res.rows[0] || 'No owner found');
    return res.rows[0] || null;
  } catch (error) {
    console.error('[ERROR] getOwnerProfile failed:', error.message);
    throw error;
  }
}

// --- File parsing ---
async function parseFinancialFile(fileBuffer, fileType) {
  console.log('[DEBUG] parseFinancialFile called:', { fileType });
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
      type: parseFloat(r.Amount || r.amount) >= 0 ? 'revenue' : 'expense',
    }));
    console.log('[DEBUG] parseFinancialFile result:', result);
    return result;
  } catch (error) {
    console.error('[ERROR] parseFinancialFile failed:', error.message);
    throw error;
  }
}

async function parseReceiptText(text) {
  console.log('[DEBUG] parseReceiptText called:', { text });
  try {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const amt = lines.find(l => l.match(/\$?\d+\.\d{2}/));
    const amount = amt ? (amt.match(/\$?(\d+\.\d{2})/)?.[1] || '0.00') : '0.00';
    const store = lines.find(l => !l.match(/\$?\d+\.\d{2}/)) || 'Unknown';
    const result = {
      date: new Date().toISOString().split('T')[0],
      item: store,
      amount: `$${amount}`,
      store,
    };
    console.log('[DEBUG] parseReceiptText result:', result);
    return result;
  } catch (error) {
    console.error('[ERROR] parseReceiptText failed:', error.message);
    throw error;
  }
}

// --- Time entries / Timesheets ---
async function logTimeEntry(ownerId, employeeName, type, timestamp, jobName = null) {
  console.log('[DEBUG] logTimeEntry called:', { ownerId, employeeName, type, timestamp, jobName });
  try {
    const res = await pool.query(
      `INSERT INTO time_entries
        (owner_id, employee_name, type, timestamp, job_name, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       RETURNING id`,
      [ownerId, employeeName, type, timestamp, jobName],
    );
    console.log('[DEBUG] logTimeEntry success:', { id: res.rows[0].id });
    return res.rows[0].id;
  } catch (error) {
    console.error('[ERROR] logTimeEntry failed:', error.message);
    throw error;
  }
}

async function getTimeEntries(ownerId, employeeName, period = 'week', date = new Date()) {
  console.log('[DEBUG] getTimeEntries called:', { ownerId, employeeName, period, date });
  try {
    let filter;
    if (period === 'day') filter = `DATE(timestamp) = $2`;
    else if (period === 'week') filter = `DATE(timestamp) BETWEEN $2 AND $2 + INTERVAL '6 days'`;
    else if (period === 'month') filter = `EXTRACT(MONTH FROM timestamp)=EXTRACT(MONTH FROM $2) AND EXTRACT(YEAR FROM timestamp)=EXTRACT(YEAR FROM $2)`;
    else throw new Error('Invalid period');

    const q = `SELECT * FROM time_entries WHERE owner_id=$1 AND employee_name=$3 AND ${filter} ORDER BY timestamp`;
    const res = await pool.query(q, [ownerId, date, employeeName]);
    console.log('[DEBUG] getTimeEntries result:', res.rows);
    return res.rows;
  } catch (error) {
    console.error('[ERROR] getTimeEntries failed:', error.message);
    throw error;
  }
}

async function generateTimesheet(ownerId, employeeName, period, date) {
  console.log('[DEBUG] generateTimesheet called:', { ownerId, employeeName, period, date });
  try {
    const entries = await getTimeEntries(ownerId, employeeName, period, date);
    const user = await getUserProfile(ownerId);

    let totalHours = 0;
    let driveHours = 0;
    const days = {};

    let lastPunchIn = null;
    let lastDriveStart = null;

    entries.forEach(e => {
      const day = e.timestamp.toISOString().split('T')[0];
      days[day] = days[day] || [];
      days[day].push(e);

      if (e.type === 'punch_in') {
        lastPunchIn = new Date(e.timestamp);
      } else if (e.type === 'punch_out' && lastPunchIn) {
        totalHours += (new Date(e.timestamp) - lastPunchIn) / (1000 * 60 * 60);
        lastPunchIn = null;
      } else if (e.type === 'drive_start') {
        lastDriveStart = new Date(e.timestamp);
      } else if (e.type === 'drive_end' && lastDriveStart) {
        driveHours += (new Date(e.timestamp) - lastDriveStart) / (1000 * 60 * 60);
        lastDriveStart = null;
      }
    });

    return {
      employeeName,
      period,
      startDate: date.toISOString().split('T')[0],
      totalHours,
      driveHours,
      company: { name: user?.name },
      entriesByDay: days,
    };
  } catch (error) {
    console.error('[ERROR] generateTimesheet failed:', error.message);
    throw error;
  }
}

// --- Reports ---
async function generateReport(ownerId, tier) {
  console.log('[DEBUG] generateReport called:', { ownerId, tier });
  try {
    const res = await pool.query(
      `SELECT 
         COALESCE(SUM(CASE WHEN type='revenue' THEN amount ELSE 0 END),0) AS revenue,
         COALESCE(SUM(CASE WHEN type IN ('expense','bill') THEN amount ELSE 0 END),0) AS expenses
       FROM transactions
       WHERE owner_id=$1`,
      [ownerId],
    );
    const revenue = parseFloat(res.rows[0].revenue) || 0;
    const expenses = parseFloat(res.rows[0].expenses) || 0;
    const report = { revenue, expenses, profit: revenue - expenses, tier };

    const reportId = crypto.randomBytes(8).toString('hex');
    await pool.query(
      `INSERT INTO reports (owner_id, report_id, data, created_at)
       VALUES ($1,$2,$3::jsonb,NOW())`,
      [ownerId, reportId, JSON.stringify(report)],
    );

    const url = `https://chief-ai-refactored.vercel.app/reports/${reportId}`;
    console.log('[DEBUG] generateReport success:', { url });
    return { url };
  } catch (error) {
    console.error('[ERROR] generateReport failed:', error.message);
    throw error;
  }
}

// --- Exports ---
module.exports = {
  appendToUserSpreadsheet,
  saveExpense,
  deleteExpense,
  saveBill,
  updateBill,
  deleteBill,
  saveRevenue,
  saveQuote,

  getActiveJob,
  saveJob,
  setActiveJob,
  finishJob,
  createJob,
  finalizeJobCreation,
  pauseJob,
  resumeJob,
  summarizeJob,

  addPricingItem,
  getPricingItems,
  updatePricingItem,
  deletePricingItem,

  createUserProfile,
  saveUserProfile,
  getUserProfile,
  getOwnerProfile,

  parseFinancialFile,
  parseReceiptText,

  // OTP helpers (now definitely defined above)
  generateOTP,
  verifyOTP,

  logTimeEntry,
  getTimeEntries,
  generateTimesheet,

  generateReport,

  normalizePhoneNumber,
};
