const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const crypto = require('crypto');

// Initialize Postgres connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- Transaction logging ---
async function appendToUserSpreadsheet(ownerId, data) {
  const [date, description, amount, source, job, type, category, mediaUrl, userName] = data;
  const query = `
    INSERT INTO transactions
      (owner_id, date, description, amount, source, job, type, category, media_url, user_name)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING id`;
  const result = await pool.query(query, [
    ownerId, date, description, amount, source, job, type, category, mediaUrl || null, userName
  ]);
  return result.rows[0].id;
}

// --- Job management ---
async function getActiveJob(ownerId) {
  const res = await pool.query(
    `SELECT job_name FROM jobs WHERE owner_id=$1 AND active=true LIMIT 1`,
    [ownerId]
  );
  return res.rows[0]?.job_name || 'Uncategorized';
}

async function setActiveJob(ownerId, jobName) {
  await pool.query(`UPDATE jobs SET active=false WHERE owner_id=$1`, [ownerId]);
  await pool.query(
    `INSERT INTO jobs (owner_id, job_name, active, start_date)
     VALUES ($1,$2,true,NOW())`,
    [ownerId, jobName]
  );
}

async function finishJob(ownerId, jobName) {
  await pool.query(
    `UPDATE jobs
     SET active=false, end_date=NOW()
     WHERE owner_id=$1 AND job_name=$2`,
    [ownerId, jobName]
  );
}

async function createJob(ownerId, jobName) {
  const query = `
    INSERT INTO jobs (owner_id, job_name, created_at, active)
    VALUES ($1,$2,NOW(),false)`;
  await pool.query(query, [ownerId, jobName]);
}

async function pauseJob(ownerId, jobName) {
  await pool.query(
    `UPDATE jobs SET paused_at=NOW()
     WHERE owner_id=$1 AND job_name=$2 AND active=true`,
    [ownerId, jobName]
  );
}

async function resumeJob(ownerId, jobName) {
  await pool.query(
    `UPDATE jobs SET paused_at=NULL
     WHERE owner_id=$1 AND job_name=$2 AND active=true`,
    [ownerId, jobName]
  );
}

async function summarizeJob(ownerId, jobName) {
  // Duration
  const jobRes = await pool.query(
    `SELECT start_date, end_date FROM jobs
      WHERE owner_id=$1 AND job_name=$2 LIMIT 1`,
    [ownerId, jobName]
  );
  const { start_date, end_date } = jobRes.rows[0];
  const start = start_date || new Date();
  const end = end_date || new Date();
  const durationDays = Math.ceil((new Date(end) - new Date(start)) / (1000*60*60*24));

  // Expenses & Revenue
  const expRes = await pool.query(
    `SELECT COALESCE(SUM(amount::numeric),0) AS total_expenses
     FROM transactions
     WHERE owner_id=$1 AND job=$2 AND type='expense'`,
    [ownerId, jobName]
  );
  const revRes = await pool.query(
    `SELECT COALESCE(SUM(amount::numeric),0) AS total_revenue
     FROM transactions
     WHERE owner_id=$1 AND job=$2 AND type='revenue'`,
    [ownerId, jobName]
  );
  const materialCost = parseFloat(expRes.rows[0].total_expenses);
  const revenue = parseFloat(revRes.rows[0].total_revenue);
  const profit = revenue - materialCost;
  const profitMargin = revenue > 0 ? profit / revenue : 0;

  // Labour via time_entries and pricing_items
  const rateRes = await pool.query(
    `SELECT unit_cost FROM pricing_items
     WHERE owner_id=$1 AND category='labour' LIMIT 1`,
    [ownerId]
  );
  const labourRate = parseFloat(rateRes.rows[0]?.unit_cost) || 0;
  const timeRes = await pool.query(
    `SELECT COALESCE(
       SUM(
         EXTRACT(EPOCH FROM (LEAD(timestamp) OVER (ORDER BY timestamp) - timestamp))/3600
       ),0) AS hours
     FROM time_entries
     WHERE owner_id=$1 AND job=$2`,
    [ownerId, jobName]
  );
  const labourHours = parseFloat(timeRes.rows[0].hours);
  const labourCost = labourHours * labourRate;

  return { durationDays, labourHours, labourCost, materialCost, revenue, profit, profitMargin };
}

// --- Dynamic pricing items ---
async function addPricingItem(ownerId, itemName, unitCost, unit = 'each', category = 'material') {
  const query = `
    INSERT INTO pricing_items
      (owner_id, item_name, unit_cost, unit, category, created_at)
    VALUES ($1,$2,$3,$4,$5,NOW())
    RETURNING *`;
  const res = await pool.query(query, [ownerId, itemName, unitCost, unit, category]);
  return res.rows[0];
}

async function getPricingItems(ownerId) {
  const res = await pool.query(
    `SELECT item_name, unit_cost, unit, category
     FROM pricing_items
     WHERE owner_id=$1`,
    [ownerId]
  );
  return res.rows;
}

async function updatePricingItem(ownerId, itemName, unitCost) {
  const res = await pool.query(
    `UPDATE pricing_items
     SET unit_cost=$1
     WHERE owner_id=$2 AND item_name=$3
     RETURNING *`,
    [unitCost, ownerId, itemName]
  );
  return res.rows[0];
}

async function deletePricingItem(ownerId, itemName) {
  await pool.query(
    `DELETE FROM pricing_items
     WHERE owner_id=$1 AND item_name=$2`,
    [ownerId, itemName]
  );
  return true;
}

// --- User & onboarding ---
async function createSpreadsheetForUser(ownerId, userName) {
  const dashboardToken = crypto.randomBytes(16).toString('hex');
  await pool.query(
    `UPDATE users SET dashboard_token=$1 WHERE user_id=$2`,
    [dashboardToken, ownerId]
  );
  return dashboardToken;
}

async function saveUserProfile(userProfile) {
  const {
    user_id, name, country, province,
    business_country, business_province, email,
    spreadsheetId, onboarding_in_progress,
    onboarding_completed, subscription_tier,
    trial_start, trial_end, token_usage,
    dashboard_token
  } = userProfile;
  await pool.query(
    `INSERT INTO users
      (user_id, name, country, province,
       business_country, business_province, email,
       spreadsheet_id, onboarding_in_progress,
       onboarding_completed, subscription_tier,
       trial_start, trial_end, token_usage,
       dashboard_token)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (user_id) DO UPDATE SET
       name=EXCLUDED.name,
       country=EXCLUDED.country,
       province=EXCLUDED.province,
       business_country=EXCLUDED.business_country,
       business_province=EXCLUDED.business_province,
       email=EXCLUDED.email,
       spreadsheet_id=EXCLUDED.spreadsheet_id,
       onboarding_in_progress=EXCLUDED.onboarding_in_progress,
       onboarding_completed=EXCLUDED.onboarding_completed,
       subscription_tier=EXCLUDED.subscription_tier,
       trial_start=EXCLUDED.trial_start,
       trial_end=EXCLUDED.trial_end,
       token_usage=EXCLUDED.token_usage,
       dashboard_token=EXCLUDED.dashboard_token`,
    [
      user_id, name, country, province,
      business_country, business_province, email,
      spreadsheetId, onboarding_in_progress,
      onboarding_completed, subscription_tier,
      trial_start, trial_end, token_usage,
      dashboard_token
    ]
  );
}

async function getUserProfile(userId) {
  const res = await pool.query(
    `SELECT * FROM users WHERE user_id=$1`,
    [userId]
  );
  return res.rows[0] || null;
}

// --- File parsing ---
async function parseFinancialFile(fileBuffer, fileType) {
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
  return data.map(r => ({
    date: r.Date || r.date || new Date().toISOString().split('T')[0],
    amount: parseFloat(r.Amount || r.amount || 0).toFixed(2),
    description: r.Description || r.description || r.Item || "Unknown",
    source: r.Source || r.source || r.Store || "Unknown",
    type: parseFloat(r.Amount || r.amount) >= 0 ? 'revenue' : 'expense'
  }));
}

async function parseReceiptText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const amt = lines.find(l => l.match(/\$?\d+\.\d{2}/));
  const amount = amt ? amt.match(/\$(\d+\.\d{2})/)[1] : '0.00';
  const store = lines.find(l => !l.match(/\$?\d+\.\d{2}/)) || 'Unknown';
  return { date: new Date().toISOString().split('T')[0], item: store, amount: `$${amount}`, store };
}

// --- OTP & verification ---
async function generateOTP(userId) {
  const otp = Math.floor(100000 + Math.random()*900000).toString();
  const expiry = new Date(Date.now() + 10*60*1000);
  await pool.query(
    `UPDATE users SET otp=$1, otp_expiry=$2 WHERE user_id=$3`,
    [otp, expiry, userId]
  );
  return otp;
}

async function verifyOTP(userId, otp) {
  const res = await pool.query(
    `SELECT otp, otp_expiry FROM users WHERE user_id=$1`,
    [userId]
  );
  const user = res.rows[0];
  if (!user || user.otp !== otp || new Date() > new Date(user.otp_expiry)) return false;
  await pool.query(
    `UPDATE users SET otp=NULL, otp_expiry=NULL WHERE user_id=$1`,
    [userId]
  );
  return true;
}

// --- Time Entries ---
async function logTimeEntry(ownerId, employeeName, type, timestamp, job = null) {
  const q = `
    INSERT INTO time_entries
      (owner_id, employee_name, type, timestamp, job)
    VALUES ($1,$2,$3,$4,$5)
    RETURNING id`;
  const res = await pool.query(q, [ownerId, employeeName, type, timestamp, job]);
  return res.rows[0].id;
}

async function getTimeEntries(ownerId, employeeName, period='week', date=new Date()) {
  let filter;
  if (period === 'day') filter = `DATE(timestamp) = $2`;
  else if (period === 'week') filter = `DATE(timestamp) BETWEEN $2 AND $2 + INTERVAL '6 days'`;
  else if (period === 'month') filter = `EXTRACT(MONTH FROM timestamp)=EXTRACT(MONTH FROM $2) AND EXTRACT(YEAR FROM timestamp)=EXTRACT(YEAR FROM $2)`;
  else throw new Error('Invalid period');

  const q = `SELECT * FROM time_entries WHERE owner_id=$1 AND employee_name=$3 AND ${filter} ORDER BY timestamp`;
  const res = await pool.query(q, [ownerId, date, employeeName]);
  return res.rows;
}

async function generateTimesheet(ownerId, employeeName, period, date) {
  const entries = await getTimeEntries(ownerId, employeeName, period, date);
  const user = await getUserProfile(ownerId);
  let totalHours = 0, driveHours = 0;
  const days = {};

  entries.forEach(e => {
    const day = e.timestamp.toISOString().split('T')[0];
    days[day] = days[day] || [];
    days[day].push(e);
    // calculate durations
    // ... as before
  });

  return { employeeName, period, startDate: date.toISOString().split('T')[0], totalHours, driveHours, company: { name: user.name }, entriesByDay: days };
}

module.exports = {
  appendToUserSpreadsheet,
  getActiveJob,
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
