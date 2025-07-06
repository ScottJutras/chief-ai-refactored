const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function appendToUserSpreadsheet(ownerId, data) {
  const [date, description, amount, source, job, type, category, mediaUrl, userName] = data;
  const query = `
    INSERT INTO transactions (owner_id, date, description, amount, source, job, type, category, media_url, user_name)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING id
  `;
  const result = await pool.query(query, [ownerId, date, description, amount, source, job, type, category, mediaUrl || null, userName]);
  return result.rows[0].id;
}

async function getActiveJob(ownerId) {
  const query = `SELECT job_name FROM jobs WHERE owner_id = $1 AND active = true LIMIT 1`;
  const result = await pool.query(query, [ownerId]);
  return result.rows[0]?.job_name || 'Uncategorized';
}

async function setActiveJob(ownerId, jobName) {
  await pool.query(`UPDATE jobs SET active = false WHERE owner_id = $1`, [ownerId]);
  await pool.query(`INSERT INTO jobs (owner_id, job_name, active) VALUES ($1, $2, true)`, [ownerId, jobName]);
}

async function finishJob(ownerId, jobName) {
  await pool.query(`UPDATE jobs SET active = false, end_date = $1 WHERE owner_id = $2 AND job_name = $3`, [new Date().toISOString(), ownerId, jobName]);
}

async function createSpreadsheetForUser(ownerId, userName) {
  const dashboardToken = crypto.randomBytes(16).toString('hex');
  await pool.query(`UPDATE users SET dashboard_token = $1 WHERE user_id = $2`, [dashboardToken, ownerId]);
  return `postgresql-user-${ownerId}`;
}

async function saveUserProfile(userProfile) {
  const { user_id, name, country, province, business_country, business_province, email, spreadsheetId, onboarding_in_progress, onboarding_completed, subscription_tier, trial_start, trial_end, token_usage, dashboard_token } = userProfile;
  await pool.query(`
    INSERT INTO users (user_id, name, country, province, business_country, business_province, email, spreadsheet_id, onboarding_in_progress, onboarding_completed, subscription_tier, trial_start, trial_end, token_usage, dashboard_token)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    ON CONFLICT (user_id) DO UPDATE
    SET name = EXCLUDED.name,
        country = EXCLUDED.country,
        province = EXCLUDED.province,
        business_country = EXCLUDED.business_country,
        business_province = EXCLUDED.business_province,
        email = EXCLUDED.email,
        spreadsheet_id = EXCLUDED.spreadsheet_id,
        onboarding_in_progress = EXCLUDED.onboarding_in_progress,
        onboarding_completed = EXCLUDED.onboarding_completed,
        subscription_tier = EXCLUDED.subscription_tier,
        trial_start = EXCLUDED.trial_start,
        trial_end = EXCLUDED.trial_end,
        token_usage = EXCLUDED.token_usage,
        dashboard_token = EXCLUDED.dashboard_token
  `, [user_id, name, country, province, business_country, business_province, email, spreadsheetId, onboarding_in_progress, onboarding_completed, subscription_tier, trial_start, trial_end, token_usage, dashboard_token]);
}

async function getUserProfile(userId) {
  const result = await pool.query(`SELECT * FROM users WHERE user_id = $1`, [userId]);
  return result.rows[0] || null;
}

async function parseFinancialFile(fileBuffer, fileType) {
  let data = [];
  if (fileType === 'text/csv') {
    const csvText = fileBuffer.toString('utf-8');
    const result = require('papaparse').parse(csvText, { header: true, skipEmptyLines: true });
    data = result.data;
  } else if (fileType === 'application/vnd.ms-excel' || fileType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(fileBuffer);
    const worksheet = workbook.worksheets[0];
    data = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return; // Skip header
      const rowData = {};
      row.eachCell((cell, colNumber) => {
        const header = worksheet.getRow(1).getCell(colNumber).value;
        rowData[header] = cell.value;
      });
      data.push(rowData);
    });
  }
  return data.map(row => ({
    date: row.Date || row.date || new Date().toISOString().split('T')[0],
    amount: parseFloat(row.Amount || row.amount || 0).toFixed(2),
    description: row.Description || row.description || row.Item || row.item || "Unknown",
    source: row.Source || row.source || row.Store || row.store || "Unknown",
    type: row.Type || row.type || (parseFloat(row.Amount || row.amount) >= 0 ? 'revenue' : 'expense')
  }));
}

async function parseReceiptText(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line);
  const amountMatch = lines.find(line => line.match(/\$?\d+\.\d{2}/));
  const amount = amountMatch ? amountMatch.match(/\$?(\d+\.\d{2})/)[1] : '0.00';
  const store = lines.find(line => !line.match(/\$?\d+\.\d{2}/)) || 'Unknown Store';
  return { date: new Date().toISOString().split('T')[0], item: store, amount: `$${amount}`, store };
}

async function generateOTP(userId) {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiry = new Date(Date.now() + 10 * 60 * 1000);
  await pool.query(`UPDATE users SET otp = $1, otp_expiry = $2 WHERE user_id = $3`, [otp, expiry, userId]);
  return otp;
}

async function verifyOTP(userId, otp) {
  const result = await pool.query(`SELECT otp, otp_expiry FROM users WHERE user_id = $1`, [userId]);
  const user = result.rows[0];
  if (!user || user.otp !== otp || new Date() > new Date(user.otp_expiry)) {
    return false;
  }
  await pool.query(`UPDATE users SET otp = NULL, otp_expiry = NULL WHERE user_id = $1`, [userId]);
  return true;
}

async function logTimeEntry(ownerId, employeeName, type, timestamp, job = null) {
  const query = `
    INSERT INTO time_entries (owner_id, employee_name, type, timestamp, job)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `;
  const result = await pool.query(query, [ownerId, employeeName, type, timestamp, job]);
  return result.rows[0].id;
}

async function getTimeEntries(ownerId, employeeName, period = 'week', date = new Date()) {
  let dateFilter;
  if (period === 'day') {
    dateFilter = `DATE(timestamp) = $2`;
  } else if (period === 'week') {
    dateFilter = `DATE(timestamp) BETWEEN $2 AND $2 + INTERVAL '6 days'`;
  } else if (period === 'month') {
    dateFilter = `EXTRACT(MONTH FROM timestamp) = EXTRACT(MONTH FROM $2) AND EXTRACT(YEAR FROM timestamp) = EXTRACT(YEAR FROM $2)`;
  } else {
    throw new Error('Invalid period');
  }
  const query = `
    SELECT * FROM time_entries
    WHERE owner_id = $1 AND employee_name = $3 AND ${dateFilter}
    ORDER BY timestamp
  `;
  const result = await pool.query(query, [ownerId, date, employeeName]);
  return result.rows;
}

async function generateTimesheet(ownerId, employeeName, period, date) {
  const entries = await getTimeEntries(ownerId, employeeName, period, date);
  const user = await getUserProfile(ownerId);
  let totalHours = 0;
  let driveHours = 0;
  const days = {};

  entries.forEach(entry => {
    const dateKey = entry.timestamp.toISOString().split('T')[0];
    if (!days[dateKey]) days[dateKey] = [];
    days[dateKey].push(entry);

    if (entry.type === 'punch_in' && entries.find(e => e.type === 'punch_out' && e.timestamp > entry.timestamp)) {
      const out = entries.find(e => e.type === 'punch_out' && e.timestamp > entry.timestamp);
      totalHours += (new Date(out.timestamp) - new Date(entry.timestamp)) / (1000 * 60 * 60);
    }
    if (entry.type === 'drive_start' && entries.find(e => e.type === 'drive_end' && e.timestamp > entry.timestamp)) {
      const end = entries.find(e => e.type === 'drive_end' && e.timestamp > entry.timestamp);
      driveHours += (new Date(end.timestamp) - new Date(entry.timestamp)) / (1000 * 60 * 60);
    }
  });

  return {
    employeeName,
    period,
    startDate: date.toISOString().split('T')[0],
    totalHours: totalHours.toFixed(2),
    driveHours: driveHours.toFixed(2),
    company: {
      name: user.name || 'Chief AI User',
      country: user.business_country || user.country,
      province: user.business_province || user.province
    },
    entriesByDay: days
  };
}

module.exports = {
  appendToUserSpreadsheet,
  getActiveJob,
  setActiveJob,
  finishJob,
  createSpreadsheetForUser,
  saveUserProfile,
  getUserProfile,
  parseFinancialFile,
  parseReceiptText,
  generateOTP,
  verifyOTP,
  logTimeEntry,
  getTimeEntries,
  generateTimesheet
};