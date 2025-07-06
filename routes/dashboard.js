const express = require('express');
const { Pool } = require('pg');
const { userProfileMiddleware } = require('../middleware/userProfile');
const { errorMiddleware } = require('../middleware/error');
const { generateOTP, verifyOTP } = require('../services/postgres');
const { sendMessage } = require('../services/twilio');

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

router.get('/:userId', userProfileMiddleware, async (req, res, next) => {
  const { userId } = req.params;
  const { userProfile, ownerId } = req;
  const token = req.query.token;

  if (userId !== userProfile.user_id && userId !== ownerId) {
    throw new Error('Unauthorized access');
  }

  if (!token || token !== userProfile.dashboard_token) {
    throw new Error('Invalid or missing dashboard token');
  }

  try {
    const otp = await generateOTP(userId);
    await sendMessage(userId, `Your Chief AI dashboard OTP is ${otp}. It expires in 10 minutes.`);
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
        </body>
      </html>
    `);
  } catch (error) {
    console.error(`[ERROR] OTP generation failed for ${userId}:`, error.message);
    next(error);
  }
});

router.post('/:userId/verify', userProfileMiddleware, async (req, res, next) => {
  const { userId } = req.params;
  const { userProfile, ownerId } = req;
  const { otp, token } = req.body;

  if (userId !== userProfile.user_id && userId !== ownerId) {
    throw new Error('Unauthorized access');
  }

  if (!token || token !== userProfile.dashboard_token) {
    throw new Error('Invalid or missing dashboard token');
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

    const transactions = await pool.query(
      `SELECT * FROM transactions WHERE owner_id = $1 ORDER BY date DESC`,
      [ownerId]
    );
    const jobs = await pool.query(
      `SELECT * FROM jobs WHERE owner_id = $1 ORDER BY start_date DESC`,
      [ownerId]
    );
    const quotes = await pool.query(
      `SELECT * FROM quotes WHERE owner_id = $1 ORDER BY created_at DESC`,
      [ownerId]
    );
    const timeEntries = await pool.query(
      `SELECT * FROM time_entries WHERE owner_id = $1 ORDER BY timestamp DESC`,
      [ownerId]
    );

    res.send(`
      <html>
        <head>
          <title>Chief AI Dashboard</title>
          <style>
            table { width: 100%; border-collapse: collapse; }
            th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
            th { background-color: #f2f2f2; }
          </style>
        </head>
        <body>
          <h1>Chief AI Dashboard for ${userProfile.name || 'User'}</h1>
          <h2>Transactions</h2>
          <table>
            <tr>
              <th>Date</th><th>Description</th><th>Amount</th><th>Source</th><th>Job</th><th>Type</th><th>Category</th><th>Media URL</th>
            </tr>
            ${transactions.rows.map(t => `
              <tr>
                <td>${t.date}</td>
                <td>${t.description}</td>
                <td>$${t.amount}</td>
                <td>${t.source || ''}</td>
                <td>${t.job || ''}</td>
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
              <th>Job Name</th><th>Amount</th><th>Description</th><th>Client</th><th>PDF</th>
            </tr>
            ${quotes.rows.map(q => `
              <tr>
                <td>${q.job_name || ''}</td>
                <td>$${q.amount}</td>
                <td>${q.description}</td>
                <td>${q.client}</td>
                <td>${q.pdf_url ? `<a href="${q.pdf_url}" target="_blank">View</a>` : ''}</td>
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
                <td>${t.job || ''}</td>
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
}, errorMiddleware);

module.exports = router;