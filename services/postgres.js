const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
});

console.log('[DEBUG] DATABASE_URL host:', new URL(process.env.DATABASE_URL).hostname);

async function appendToUserSpreadsheet(ownerId, data) {
  console.log('[DEBUG] appendToUserSpreadsheet called:', { ownerId, data });
  try {
    const [date, item, amount, store, jobName, type, category, mediaUrl, userName] = data;
    const query = `
      INSERT INTO transactions
        (owner_id, date, item, amount, store, job_name, type, category, media_url, user_name, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      RETURNING id`;
    const result = await pool.query(query, [
      ownerId, date, item, parseFloat(amount), store, jobName, type, category, mediaUrl || null, userName
    ]);
    console.log('[DEBUG] appendToUserSpreadsheet success:', { id: result.rows[0].id });
    return result.rows[0].id;
  } catch (error) {
    console.error('[ERROR] appendToUserSpreadsheet failed:', error.message);
    throw error;
  }
}

async function saveExpense({ ownerId, date, item, amount, store, jobName, category, user }) {
  console.log('[DEBUG] saveExpense called for ownerId:', ownerId);
  try {
    await pool.query(
      `INSERT INTO transactions (owner_id, type, date, item, amount, store, job_name, category, user_name, created_at)
       VALUES ($1, 'expense', $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [ownerId, date, item, parseFloat(amount.replace('$', '')), store, jobName, category, user]
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
       WHERE owner_id = $1 AND type = 'expense' AND item = $2 AND amount = $3 AND store = $4
       RETURNING *`,
      [ownerId, criteria.item, parseFloat(criteria.amount.replace('$', '')), criteria.store]
    );
    console.log('[DEBUG] deleteExpense result:', res.rows[0]);
    return res.rows.length > 0;
  } catch (error) {
    console.error('[ERROR] deleteExpense failed for', ownerId, ':', error.message);
    return false;
  }
}

async function getActiveJob(ownerId) {
  console.log('[DEBUG] getActiveJob called:', { ownerId });
  try {
    const res = await pool.query(
      `SELECT active_job FROM users WHERE user_id = $1`,
      [ownerId]
    );
    console.log('[DEBUG] getActiveJob result:', res.rows[0]?.active_job || 'Uncategorized');
    return res.rows[0]?.active_job || 'Uncategorized';
  } catch (error) {
    console.error('[ERROR] getActiveJob failed:', error.message);
    return 'Uncategorized';
  }
}

async function saveJob(ownerId, jobName, startTime) {
  console.log('[DEBUG] saveJob called:', { ownerId, jobName });
  try {
    await pool.query(
      `INSERT INTO jobs (owner_id, job_name, start_time, status, created_at)
       VALUES ($1, $2, $3, 'active', NOW())`,
      [ownerId, jobName, startTime]
    );
    await pool.query(
      `UPDATE users
       SET active_job = $1, job_history = COALESCE(job_history, '[]'::jsonb) || $2::jsonb
       WHERE user_id = $3`,
      [jobName, JSON.stringify([{ jobName, startTime, status: 'active' }]), ownerId]
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
    await pool.query(
      `UPDATE users SET active_job = $1, updated_at = NOW() WHERE user_id = $2`,
      [jobName, ownerId]
    );
    await pool.query(
      `UPDATE jobs SET status = 'active', start_time = NOW() WHERE owner_id = $1 AND job_name = $2`,
      [ownerId, jobName]
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
       SET status = 'finished', updated_at = NOW()
       WHERE owner_id = $1 AND job_name = $2`,
      [ownerId, jobName]
    );
    await pool.query(
      `UPDATE users
       SET active_job = NULL,
           job_history = jsonb_set(
             COALESCE(job_history, '[]'::jsonb),
             ARRAY[(SELECT i FROM generate_series(0, jsonb_array_length(COALESCE(job_history, '[]'::jsonb)) - 1) i WHERE (job_history->i->>'jobName') = $1 LIMIT 1)::text, 'status']::text[],
             '"finished"')
       WHERE user_id = $2`,
      [jobName, ownerId]
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
      `INSERT INTO jobs (owner_id, job_name, status, created_at)
       VALUES ($1, $2, 'created', NOW())`,
      [ownerId, jobName]
    );
    console.log('[DEBUG] createJob success');
  } catch (error) {
    console.error('[ERROR] createJob failed:', error.message);
    throw error;
  }
}

async function pauseJob(ownerId, jobName) {
  console.log('[DEBUG] pauseJob called:', { ownerId, jobName });
  try {
    await pool.query(
      `UPDATE jobs SET status = 'paused', updated_at = NOW()
       WHERE owner_id = $1 AND job_name = $2`,
      [ownerId, jobName]
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
      `UPDATE jobs SET status = 'active', updated_at = NOW()
       WHERE owner_id = $1 AND job_name = $2`,
      [ownerId, jobName]
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
      `SELECT start_time FROM jobs
       WHERE owner_id = $1 AND job_name = $2 LIMIT 1`,
      [ownerId, jobName]
    );
    const startTime = jobRes.rows[0]?.start_time ? new Date(jobRes.rows[0].start_time) : new Date();
    const durationDays = ((new Date() - startTime) / (1000 * 60 * 60 * 24)).toFixed(2);

    const transRes = await pool.query(
      `SELECT type, amount FROM transactions
       WHERE owner_id = $1 AND job_name = $2`,
      [ownerId, jobName]
    );
    const materialCost = transRes.rows
      .filter(row => row.type === 'expense' || row.type === 'bill')
      .reduce((sum, row) => sum + parseFloat(row.amount || 0), 0);
    const revenue = transRes.rows
      .filter(row => row.type === 'revenue')
      .reduce((sum, row) => sum + parseFloat(row.amount || 0), 0);

    const timeRes = await pool.query(
      `SELECT type, timestamp FROM time_entries
       WHERE owner_id = $1 AND job_name = $2`,
      [ownerId, jobName]
    );
    let labourHours = 0;
    let lastPunchIn = null;
    timeRes.rows.forEach(row => {
      if (row.type === 'punch_in') {
        lastPunchIn = new Date(row.timestamp);
      } else if (row.type === 'punch_out' && lastPunchIn) {
        labourHours += (new Date(row.timestamp) - lastPunchIn) / (1000 * 60 * 60);
        lastPunchIn = null;
      }
    });
    const labourCost = labourHours * 50; // Assume $50/hour
    const profit = revenue - (materialCost + labourCost);
    const profitMargin = revenue ? profit / revenue : 0;

    console.log('[DEBUG] summarizeJob result:', { durationDays, labourHours, labourCost, materialCost, revenue, profit, profitMargin });
    return {
      durationDays,
      labourHours: labourHours.toFixed(2),
      labourCost: labourCost.toFixed(2),
      materialCost: materialCost.toFixed(2),
      revenue: revenue.toFixed(2),
      profit: profit.toFixed(2),
      profitMargin
    };
  } catch (error) {
    console.error('[ERROR] summarizeJob failed:', error.message);
    throw error;
  }
}

async function addPricingItem(ownerId, itemName, unitCost, unit = 'each', category = 'material') {
  console.log('[DEBUG] addPricingItem called:', { ownerId, itemName, unitCost, unit, category });
  try {
    const res = await pool.query(
      `INSERT INTO pricing_items
        (owner_id, item_name, price, unit, category, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING *`,
      [ownerId, itemName, unitCost, unit, category]
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
      `SELECT item_name, price, unit, category
       FROM pricing_items
       WHERE owner_id = $1`,
      [ownerId]
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
       SET price = $1
       WHERE owner_id = $2 AND item_name = $3
       RETURNING *`,
      [unitCost, ownerId, itemName]
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
       WHERE owner_id = $1 AND item_name = $2`,
      [ownerId, itemName]
    );
    console.log('[DEBUG] deletePricingItem success');
    return true;
  } catch (error) {
    console.error('[ERROR] deletePricingItem failed:', error.message);
    throw error;
  }
}

async function createUserProfile({ user_id, ownerId, onboarding_in_progress = false }) {
  console.log('[DEBUG] createUserProfile called:', { user_id, ownerId, onboarding_in_progress });
  try {
    const dashboard_token = crypto.randomBytes(16).toString('hex');
    const result = await pool.query(
      `INSERT INTO users
         (user_id, owner_id, onboarding_in_progress, onboarding_completed, subscription_tier, dashboard_token, created_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET onboarding_in_progress = EXCLUDED.onboarding_in_progress
       RETURNING *`,
      [user_id, ownerId, onboarding_in_progress, false, 'basic', dashboard_token]
    );
    console.log('[DEBUG] createUserProfile success:', result.rows[0]);
    return result.rows[0];
  } catch (error) {
    console.error('[ERROR] createUserProfile failed:', error.message);
    throw error;
  }
}

async function saveUserProfile(profile) {
  console.log('[DEBUG] saveUserProfile called:', { user_id: profile.user_id });
  try {
    const result = await pool.query(
      `UPDATE users
       SET name = $1, country = $2, province = $3, business_country = $4, business_province = $5,
           email = $6, onboarding_in_progress = $7, onboarding_completed = $8,
           subscription_tier = $9, trial_start = $10, trial_end = $11, token_usage = $12,
           goal = $13, goal_progress = $14, updated_at = NOW()
       WHERE user_id = $15
       RETURNING *`,
      [
        profile.name, profile.country, profile.province, profile.business_country,
        profile.business_province, profile.email, profile.onboarding_in_progress,
        profile.onboarding_completed, profile.subscription_tier || 'basic',
        profile.trial_start, profile.trial_end, profile.token_usage, profile.goal,
        profile.goalProgress, profile.user_id
      ]
    );
    console.log('[DEBUG] saveUserProfile success:', result.rows[0]);
    return result.rows[0];
  } catch (error) {
    console.error('[ERROR] saveUserProfile failed:', error.message);
    throw error;
  }
}

async function getUserProfile(userId) {
  console.log('[DEBUG] getUserProfile called:', { userId });
  try {
    const res = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]);
    console.log('[DEBUG] getUserProfile result:', res.rows[0] || 'No user found');
    return res.rows[0] || null;
  } catch (error) {
    console.error('[ERROR] getUserProfile failed:', error.message);
    throw error;
  }
}

async function getOwnerProfile(ownerId) {
  console.log('[DEBUG] getOwnerProfile called:', { ownerId });
  try {
    const res = await pool.query('SELECT * FROM users WHERE user_id = $1', [ownerId]);
    console.log('[DEBUG] getOwnerProfile result:', res.rows[0] || 'No owner found');
    return res.rows[0] || { ownerId };
  } catch (error) {
    console.error('[ERROR] getOwnerProfile failed:', error.message);
    throw error;
  }
}

async function parseFinancialFile(fileBuffer, fileType) {
  console.log('[DEBUG] parseFinancialFile called:', { fileType });
  try {
    let data = [];
    const ExcelJS = require('exceljs');
    if (fileType === 'text/csv') {
      const csvText = fileBuffer.toString('utf-8');
      data = require('papaparse').parse(csvText, { header: true, skipEmptyLines: true }).data;
    } else {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(fileBuffer);
      const ws = workbook.worksheets[0];
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
      item: r.Description || r.description || r.Item || 'Unknown',
      store: r.Source || r.source || r.Store || 'Unknown',
      type: parseFloat(r.Amount || r.amount) >= 0 ? 'revenue' : 'expense'
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
    const amount = amt ? amt.match(/\$?(\d+\.\d{2})/)?.[1] || '0.00' : '0.00';
    const store = lines.find(l => !l.match(/\$?\d+\.\d{2}/)) || 'Unknown';
    const result = { date: new Date().toISOString().split('T')[0], item: store, amount: `$${amount}`, store };
    console.log('[DEBUG] parseReceiptText result:', result);
    return result;
  } catch (error) {
    console.error('[ERROR] parseReceiptText failed:', error.message);
    throw error;
  }
}

async function logTimeEntry(ownerId, employeeName, type, timestamp, jobName = null) {
  console.log('[DEBUG] logTimeEntry called:', { ownerId, employeeName, type, timestamp, jobName });
  try {
    const res = await pool.query(
      `INSERT INTO time_entries
        (owner_id, employee_name, type, timestamp, job_name, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING id`,
      [ownerId, employeeName, type, timestamp, jobName]
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
    let sql = `SELECT type, timestamp, job_name FROM time_entries WHERE owner_id = $1 AND employee_name = $2`;
    const params = [ownerId, employeeName];
    if (period) {
      const now = new Date(date);
      let endDate;
      if (period === 'day') {
        endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      } else if (period === 'week') {
        endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7);
      } else if (period === 'month') {
        endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      } else {
        throw new Error('Invalid period');
      }
      sql += ` AND timestamp >= $3 AND timestamp <= $4 ORDER BY timestamp`;
      params.push(now.toISOString(), endDate.toISOString());
    }
    const res = await pool.query(sql, params);
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
    let totalHours = 0, driveHours = 0;
    let lastPunchIn = null;
    entries.forEach(entry => {
      if (entry.type === 'punch_in') {
        lastPunchIn = new Date(entry.timestamp);
      } else if (entry.type === 'punch_out' && lastPunchIn) {
        totalHours += (new Date(entry.timestamp) - lastPunchIn) / (1000 * 60 * 60);
        lastPunchIn = null;
      } else if (entry.type === 'drive_start') {
        lastPunchIn = new Date(entry.timestamp);
      } else if (entry.type === 'drive_end' && lastPunchIn) {
        driveHours += (new Date(entry.timestamp) - lastPunchIn) / (1000 * 60 * 60);
        lastPunchIn = null;
      }
    });
    const user = await getUserProfile(ownerId);
    console.log('[DEBUG] generateTimesheet result:', { totalHours, driveHours });
    return {
      employeeName,
      period,
      startDate: date.toISOString().split('T')[0],
      totalHours: totalHours.toFixed(2),
      driveHours: driveHours.toFixed(2),
      company: { name: user?.name }
    };
  } catch (error) {
    console.error('[ERROR] generateTimesheet failed:', error.message);
    throw error;
  }
}

async function generateOTP(userId) {
  console.log('[DEBUG] generateOTP called:', { userId });
  try {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query(
      `UPDATE users SET otp = $1, otp_expiry = $2 WHERE user_id = $3`,
      [otp, expiry, userId]
    );
    console.log('[DEBUG] generateOTP success:', { otp });
    return otp;
  } catch (error) {
    console.error('[ERROR] generateOTP failed:', error.message);
    throw error;
  }
}

async function verifyOTP(userId, otp) {
  console.log('[DEBUG] verifyOTP called:', { userId, otp });
  try {
    const res = await pool.query(
      `SELECT otp, otp_expiry FROM users WHERE user_id = $1`,
      [userId]
    );
    const user = res.rows[0];
    if (!user || user.otp !== otp || new Date() > new Date(user.otp_expiry)) {
      console.log('[DEBUG] verifyOTP failed: Invalid OTP or expired');
      return false;
    }
    await pool.query(
      `UPDATE users SET otp = NULL, otp_expiry = NULL WHERE user_id = $1`,
      [userId]
    );
    console.log('[DEBUG] verifyOTP success');
    return true;
  } catch (error) {
    console.error('[ERROR] verifyOTP failed:', error.message);
    throw error;
  }
}

module.exports = {
  appendToUserSpreadsheet,
  getActiveJob,
  saveExpense,
  deleteExpense,
  saveJob,
  setActiveJob,
  finishJob,
  createJob,
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
  logTimeEntry,
  getTimeEntries,
  generateTimesheet,
  generateOTP,
  verifyOTP
};