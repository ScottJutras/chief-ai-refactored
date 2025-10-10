const express = require('express');
const { query } = require('../services/postgres');
const { getUserProfile, getOwnerProfile, createUserProfile, generateOTP, verifyOTP } = require('../services/postgres');
const { sendMessage } = require('../services/twilio');
const { errorMiddleware } = require('../middleware/error');
const multer = require('multer');
const { parseUpload } = require('../services/deepDive');
const upload = multer({ storage: multer.memoryStorage() });

async function userProfileMiddleware(req, res, next) {
  let phone;
  if (req.body.From) {
    phone = req.body.From.replace(/\D/g, '');
  } else if (req.params.userId) {
    phone = req.params.userId;
  } else {
    console.error('[ERROR] Missing sender in request');
    return res.status(400).send('Invalid Request: missing sender');
  }
  let profile = await getUserProfile(phone);
  if (!profile) {
    profile = await createUserProfile({
      user_id: phone,
      ownerId: process.env.DEFAULT_OWNER_ID || phone,
      onboarding_in_progress: true
    });
    console.log(`[INFO] Created new user profile for ${phone}`);
  }
  req.userProfile = profile;
  req.ownerId = profile.owner_id;
  req.ownerProfile = await getOwnerProfile(profile.owner_id);
  req.isOwner = req.ownerProfile.owner_id === profile.owner_id;
  next();
}

const router = express.Router();

router.get('/:userId', userProfileMiddleware, async (req, res, next) => {
  const { userId } = req.params;
  const { userProfile } = req;
  const token = req.query.token;
  if (userId !== userProfile.user_id) {
    return res.status(403).send('Unauthorized access');
  }
  if (!token || token !== userProfile.dashboard_token) {
    return res.status(403).send('Invalid or missing dashboard token');
  }
  const transCountRes = await query(`SELECT COUNT(*) FROM transactions WHERE owner_id = $1`, [userId]);
  const transactionCount = parseInt(transCountRes.rows[0].count) || 0;
  const maxTransactions = { starter: 5000, pro: 20000, enterprise: 50000 }[userProfile.subscription_tier || 'starter'];
  const progress = (transactionCount / maxTransactions) * 100;
  if (userProfile.subscription_tier === 'starter') {
    res.send(`
      <html>
        <head>
          <title>Chief AI Dashboard - Historical Upload</title>
          <style>
            .upload-section { margin-top: 20px; }
            .progress-bar { width: 100%; background-color: #ddd; }
            .progress { height: 20px; background-color: #4CAF50; text-align: center; color: white; }
            .tab { overflow: hidden; border: 1px solid #ccc; background-color: #f1f1f1; }
            .tab button { background-color: inherit; float: left; border: none; outline: none; cursor: pointer; padding: 14px 16px; }
            .tab button.active { background-color: #ccc; }
            .tabcontent { display: none; padding: 6px 12px; border: 1px solid #ccc; border-top: none; }
            .tabcontent.active { display: block; }
          </style>
          <script>
            function openTab(evt, tabName) {
              var i, tabcontent, tablinks;
              tabcontent = document.getElementsByClassName("tabcontent");
              for (i = 0; i < tabcontent.length; i++) {
                tabcontent[i].style.display = "none";
              }
              tablinks = document.getElementsByClassName("tablinks");
              for (i = 0; i < tablinks.length; i++) {
                tablinks[i].className = tablinks[i].className.replace(" active", "");
              }
              document.getElementById(tabName).style.display = "block";
              evt.currentTarget.className += " active";
            }
          </script>
        </head>
        <body>
          <h1>Chief AI Historical Data Upload</h1>
          <div class="upload-section">
            <p>Upload up to 7 years of historical data (CSV/Excel free, image/audio via DeepDive).</p>
            <div class="tab">
              <button class="tablinks active" onclick="openTab(event, 'CSV')">CSV/Excel</button>
              <button class="tablinks" onclick="openTab(event, 'ImageAudio')">Image/Audio</button>
            </div>
            <div id="CSV" class="tabcontent active">
              <form action="/dashboard/${userId}/upload" method="POST" enctype="multipart/form-data">
                <input type="hidden" name="token" value="${token}">
                <input type="hidden" name="uploadType" value="csv">
                <input type="file" name="file" accept=".csv,.xls,.xlsx" required>
                <button type="submit">Upload CSV/Excel</button>
              </form>
            </div>
            <div id="ImageAudio" class="tabcontent">
              <form action="/dashboard/${userId}/upload" method="POST" enctype="multipart/form-data">
                <input type="hidden" name="token" value="${token}">
                <input type="hidden" name="uploadType" value="image">
                <input type="file" name="file" accept=".pdf,.jpg,.png,.mp3" required>
                <button type="submit">Upload Image/Audio</button>
              </form>
            </div>
            <div class="progress-bar">
              <div class="progress" style="width: ${progress}%;">${transactionCount}/${maxTransactions} (${progress.toFixed(2)}%)</div>
            </div>
          </div>
        </body>
      </html>
    `);
    return;
  }
  res.send(`
    <html>
      <head><title>Chief AI Dashboard - OTP Verification</title></head>
      <body>
        <h1>Chief AI Dashboard</h1>
        <p>Please enter the OTP sent to your WhatsApp number:</p>
        <form action="/dashboard/${userId}/verify" method="POST">
          <input type="hidden" name="token" value="${token}">
          <input type="text" name="otp" placeholder="Enter OTP" required>
          <button type="submit">Verify</button>
        </form>
        <form action="/dashboard/${userId}/resend-otp" method="POST" style="margin-top:10px;">
          <input type="hidden" name="token" value="${token}">
          <button type="submit">Resend OTP</button>
        </form>
      </body>
    </html>
  `);
});

router.post('/:userId/resend-otp', userProfileMiddleware, async (req, res, next) => {
  const { userId } = req.params;
  const { userProfile } = req;
  const token = req.body.token;
  if (userId !== userProfile.user_id) {
    return res.status(403).send('Unauthorized access');
  }
  if (!token || token !== userProfile.dashboard_token) {
    return res.status(403).send('Invalid or missing dashboard token');
  }
  try {
    const otp = await generateOTP(userId);
    await sendMessage(userId, `Your Chief AI dashboard OTP is ${otp}. It expires in 10 minutes.`);
    res.send(`
      <html>
        <body>
          <h1>OTP Resent</h1>
          <p>We’ve sent you a new OTP! Please check your WhatsApp and enter it below.</p>
          <form action="/dashboard/${userId}/verify" method="POST">
            <input type="hidden" name="token" value="${token}">
            <input type="text" name="otp" placeholder="Enter OTP" required>
            <button type="submit">Verify</button>
          </form>
        </body>
      </html>
    `);
  } catch (error) {
    next(error);
  }
});

router.post('/:userId/verify', userProfileMiddleware, async (req, res, next) => {
  const { userId } = req.params;
  const { userProfile } = req;
  const { otp, token } = req.body;
  if (userId !== userProfile.user_id) {
    return res.status(403).send('Unauthorized access');
  }
  if (!token || token !== userProfile.dashboard_token) {
    return res.status(403).send('Invalid or missing dashboard token');
  }
  try {
    const isValid = await verifyOTP(userId, otp);
    if (!isValid) {
      res.send(`
        <html>
          <body>
            <h1>Invalid OTP</h1>
            <p>The OTP is incorrect or expired. <a href="/dashboard/${userId}?token=${token}">Try again</a>.</p>
          </body>
        </html>
      `);
      return;
    }
    const transactions = await query(
      `SELECT * FROM transactions WHERE owner_id = $1 ORDER BY date DESC`,
      [userId]
    );
    const jobs = await query(
      `SELECT * FROM jobs WHERE owner_id = $1 ORDER BY start_date DESC`,
      [userId]
    );
    const quotes = await query(
      `SELECT * FROM quotes WHERE owner_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    const timeEntries = await query(
      `SELECT * FROM time_entries WHERE owner_id = $1 ORDER BY timestamp DESC`,
      [userId]
    );
    const reports = await query(
      `SELECT * FROM reports WHERE owner_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    const transCountRes = await query(`SELECT COUNT(*) FROM transactions WHERE owner_id = $1`, [userId]);
    const transactionCount = parseInt(transCountRes.rows[0].count) || 0;
    const maxTransactions = { starter: 5000, pro: 20000, enterprise: 50000 }[userProfile.subscription_tier || 'starter'];
    const progress = (transactionCount / maxTransactions) * 100;
    res.send(`
      <html>
        <head>
          <title>Chief AI Dashboard</title>
          <style>
            table { width: 100%; border-collapse: collapse; }
            th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
            th { background-color: #f2f2f2; }
            .upload-section { margin-top: 20px; }
            .progress-bar { width: 100%; background-color: #ddd; }
            .progress { height: 20px; background-color: #4CAF50; text-align: center; color: white; }
            .tab { overflow: hidden; border: 1px solid #ccc; background-color: #f1f1f1; }
            .tab button { background-color: inherit; float: left; border: none; outline: none; cursor: pointer; padding: 14px 16px; }
            .tab button.active { background-color: #ccc; }
            .tabcontent { display: none; padding: 6px 12px; border: 1px solid #ccc; border-top: none; }
            .tabcontent.active { display: block; }
          </style>
          <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
          <script>
            function openTab(evt, tabName) {
              var i, tabcontent, tablinks;
              tabcontent = document.getElementsByClassName("tabcontent");
              for (i = 0; i < tabcontent.length; i++) {
                tabcontent[i].style.display = "none";
              }
              tablinks = document.getElementsByClassName("tablinks");
              for (i = 0; i < tablinks.length; i++) {
                tablinks[i].className = tablinks[i].className.replace(" active", "");
              }
              document.getElementById(tabName).style.display = "block";
              evt.currentTarget.className += " active";
            }
          </script>
        </head>
        <body>
          <h1>Chief AI Dashboard for ${userProfile.name || 'User'}</h1>
          <div class="upload-section">
            <h2>Historical Data Upload</h2>
            <p>Upload up to 7 years of historical data (CSV/Excel free, image/audio via DeepDive).</p>
            <div class="tab">
              <button class="tablinks active" onclick="openTab(event, 'CSV')">CSV/Excel</button>
              <button class="tablinks" onclick="openTab(event, 'ImageAudio')">Image/Audio</button>
            </div>
            <div id="CSV" class="tabcontent active">
              <form action="/dashboard/${userId}/upload" method="POST" enctype="multipart/form-data">
                <input type="hidden" name="token" value="${token}">
                <input type="hidden" name="uploadType" value="csv">
                <input type="file" name="file" accept=".csv,.xls,.xlsx" required>
                <button type="submit">Upload CSV/Excel</button>
              </form>
            </div>
            <div id="ImageAudio" class="tabcontent">
              <form action="/dashboard/${userId}/upload" method="POST" enctype="multipart/form-data">
                <input type="hidden" name="token" value="${token}">
                <input type="hidden" name="uploadType" value="image">
                <input type="file" name="file" accept=".pdf,.jpg,.png,.mp3" required>
                <button type="submit">Upload Image/Audio</button>
              </form>
            </div>
            <div class="progress-bar">
              <div class="progress" style="width: ${progress}%;">${transactionCount}/${maxTransactions} (${progress.toFixed(2)}%)</div>
            </div>
          </div>
          <h2>DeepDive Report</h2>
          <form action="/dashboard/${userId}/report" method="POST">
            <input type="hidden" name="token" value="${token}">
            <select name="tier">
              <option value="BASIC">Basic Report ($49)</option>
              <option value="FULL">Full Report ($99)</option>
              <option value="ENTERPRISE">Enterprise Report ($199)</option>
            </select>
            <button type="submit">Generate Report</button>
          </form>
          <h2>Transactions</h2>
          <table>
            <tr>
              <th>Date</th><th>Description</th><th>Amount</th><th>Source</th><th>Job</th><th>Type</th><th>Category</th><th>Media URL</th>
            </tr>
            ${transactions.rows.map(t => `
              <tr>
                <td>${t.date}</td>
                <td>${t.description || t.item || ''}</td>
                <td>$${t.amount}</td>
                <td>${t.source || t.store || ''}</td>
                <td>${t.job_name || ''}</td>
                <td>${t.type}</td>
                <td>${t.category || ''}</td>
                <td>${t.media_url ? `<a href="${t.media_url}" target="_blank">View</a>` : ''}</td>
              </tr>
            `).join('')}
          </table>
          <h2>Jobs</h2>
          <table>
            <tr>
              <th>Job Name</th><th>Active</th><th>Start Date</th><th>End Date</th>
            </tr>
            ${jobs.rows.map(j => `
              <tr>
                <td>${j.job_name}</td>
                <td>${j.active ? 'Yes' : 'No'}</td>
                <td>${j.start_date}</td>
                <td>${j.end_date || ''}</td>
              </tr>
            `).join('')}
          </table>
          <h2>Quotes</h2>
          <table>
            <tr>
              <th>Job Name</th><th>Amount</th><th>Customer</th><th>Status</th>
            </tr>
            ${quotes.rows.map(q => `
              <tr>
                <td>${q.job_name || ''}</td>
                <td>$${q.total}</td>
                <td>${q.customer_name}</td>
                <td>${q.status}</td>
              </tr>
            `).join('')}
          </table>
          <h2>Time Entries</h2>
          <table>
            <tr>
              <th>Employee</th><th>Type</th><th>Timestamp</th><th>Job</th>
            </tr>
            ${timeEntries.rows.map(t => `
              <tr>
                <td>${t.employee_name}</td>
                <td>${t.type.replace('_', ' ')}</td>
                <td>${new Date(t.timestamp).toLocaleString()}</td>
                <td>${t.job_name || ''}</td>
              </tr>
            `).join('')}
          </table>
          <h2>Reports</h2>
          <table>
            <tr>
              <th>Tier</th><th>Created At</th><th>Data</th>
            </tr>
            ${reports.rows.map(r => `
              <tr>
                <td>${r.tier}</td>
                <td>${new Date(r.created_at).toLocaleString()}</td>
                <td><pre>${JSON.stringify(r.data, null, 2)}</pre></td>
              </tr>
            `).join('')}
          </table>
        </body>
      </html>
    `);
  } catch (error) {
    console.error(`[ERROR] OTP verification failed for ${userId}:`, error.message);
    next(error);
  }
});

router.post('/:userId/report', userProfileMiddleware, async (req, res, next) => {
  const { userId } = req.params;
  const { userProfile } = req;
  const { token, tier = 'BASIC' } = req.body;
  if (userId !== userProfile.user_id) {
    return res.status(403).send('Unauthorized access');
  }
  if (!token || token !== userProfile.dashboard_token) {
    return res.status(403).send('Invalid or missing dashboard token');
  }
  if (userProfile.subscription_tier === 'starter') {
    return res.status(403).send('Reports require Pro or Enterprise plan. Upgrade via WhatsApp.');
  }
  const DEEP_DIVE_TIERS = {
    BASIC: { price: 49, name: 'Basic Report', features: ['historical'] },
    FULL: { price: 99, name: 'Full Report', features: ['historical', 'forecast_1yr'] },
    ENTERPRISE: { price: 199, name: 'Enterprise Report', features: ['historical', 'forecast_10yr', 'goals'] }
  };
  if (!DEEP_DIVE_TIERS[tier]) {
    return res.status(400).send('Invalid tier. Use: BASIC, FULL, ENTERPRISE');
  }
  try {
    const expenseResult = await query(`SELECT * FROM transactions WHERE owner_id = $1 AND type IN ('expense', 'bill')`, [userId]);
    const revenueResult = await query(`SELECT * FROM transactions WHERE owner_id = $1 AND type = 'revenue'`, [userId]);
    const expenses = expenseResult.rows;
    const revenues = revenueResult.rows;
    if (!expenses.length && !revenues.length) {
      return res.status(400).send('No financial data provided');
    }
    const report = {
      user_id: userProfile.user_id,
      tier: DEEP_DIVE_TIERS[tier].name,
      created_at: new Date().toISOString(),
      historical: {
        expenses: expenses.map(e => ({
          date: e.date,
          item: e.description,
          amount: e.amount,
          store: e.source,
          category: e.category
        })),
        revenues: revenues.map(r => ({
          date: r.date,
          description: r.description,
          amount: r.amount,
          source: r.source
        }))
      },
      forecast_1yr: DEEP_DIVE_TIERS[tier].features.includes('forecast_1yr') ? {
        projectedExpenses: expenses.reduce((sum, e) => sum + parseFloat(e.amount), 0) * 1.1,
        projectedRevenues: revenues.reduce((sum, r) => sum + parseFloat(r.amount), 0) * 1.2
      } : null,
      forecast_10yr: DEEP_DIVE_TIERS[tier].features.includes('forecast_10yr') ? {
        projectedExpenses: expenses.reduce((sum, e) => sum + parseFloat(e.amount), 0) * 10,
        projectedRevenues: revenues.reduce((sum, r) => sum + parseFloat(r.amount), 0) * 10
      } : null,
      goals: DEEP_DIVE_TIERS[tier].features.includes('goals') ? userProfile.goalProgress : null
    };
    await query(
      `INSERT INTO reports (user_id, tier, report_data, created_at)
       VALUES ($1, $2, $3, $4)`,
      [userProfile.user_id, DEEP_DIVE_TIERS[tier].name, JSON.stringify(report), new Date()]
    );
    res.send(`
      <html>
        <body>
          <h1>DeepDive Report Generated</h1>
          <p>Report generated successfully: ${DEEP_DIVE_TIERS[tier].name}</p>
          <pre>${JSON.stringify(report, null, 2)}</pre>
          <a href="/dashboard/${userId}?token=${token}">Back to Dashboard</a>
        </body>
      </html>
    `);
  } catch (error) {
    console.error(`[ERROR] Report generation failed for ${userId}:`, error.message);
    next(error);
  }
});

router.post('/:userId/upload', upload.single('file'), userProfileMiddleware, async (req, res, next) => {
  const { userId } = req.params;
  const { userProfile } = req;
  const token = req.body.token;
  const uploadType = req.body.uploadType || 'csv';
  if (userId !== userProfile.user_id) {
    return res.status(403).send('Unauthorized access');
  }
  if (!token || token !== userProfile.dashboard_token) {
    return res.status(403).send('Invalid or missing dashboard token');
  }
  try {
    if (!req.file) throw new Error('No file uploaded');
    const { buffer, originalname, mimetype } = req.file;
    const summary = await parseUpload(buffer, originalname, userId, mimetype, uploadType, userProfile.fiscal_year_start);
    const transCountRes = await query(`SELECT COUNT(*) FROM transactions WHERE owner_id = $1`, [userId]);
    const transactionCount = parseInt(transCountRes.rows[0].count) || 0;
    const maxTransactions = { starter: 5000, pro: 20000, enterprise: 50000 }[userProfile.subscription_tier || 'starter'];
    const progress = (transactionCount / maxTransactions) * 100;
    res.send(`
      <html>
        <body>
          <h1>Upload Success</h1>
          <p>✅ ${summary.transactions} new transactions processed. ${summary.summary}</p>
          <div class="progress-bar">
            <div class="progress" style="width: ${progress}%;">${transactionCount}/${maxTransactions} (${progress.toFixed(2)}%)</div>
          </div>
          <a href="/dashboard/${userId}?token=${token}">Back to Dashboard</a>
        </body>
      </html>
    `);
  } catch (error) {
    res.send(`
      <html>
        <body>
          <h1>Upload Failed</h1>
          <p>Error: ${error.message}</p>
          <a href="/dashboard/${userId}?token=${token}">Back to Dashboard</a>
        </body>
      </html>
    `);
  }
});

router.use(errorMiddleware);
module.exports = router;