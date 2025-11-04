// routes/dashboard.js
const express = require('express');
const { query } = require('../services/postgres');
const { getUserProfile, generateOTP, verifyOTP } = require('../services/postgres');
const { sendMessage } = require('../services/twilio');
const { errorMiddleware } = require('../middleware/error');
const multer = require('multer');
const { parseUpload } = require('../services/deepDive');
const upload = multer({ storage: multer.memoryStorage() });

async function userProfileMiddleware(req, res, next) {
  const phone = (req.body.From || req.params.userId || '').replace(/\D/g, '');
  if (!phone) return res.status(400).send('Missing sender');
  const profile = await getUserProfile(phone) || await pg.createUserProfile({ user_id: phone, ownerId: phone, onboarding_in_progress: true });
  req.userProfile = profile;
  req.ownerId = profile.owner_id;
  req.isOwner = profile.user_id === profile.owner_id;
  next();
}

const router = express.Router();

// GET dashboard (OTP flow)
router.get('/:userId', userProfileMiddleware, async (req, res) => {
  const { userId } = req.params;
  const { userProfile } = req;
  const token = req.query.token;
  if (userId !== userProfile.user_id) return res.status(403).send('Unauthorized');
  if (!token || token !== userProfile.dashboard_token) return res.status(403).send('Invalid token');

  // Starter → upload UI
  if (userProfile.subscription_tier === 'starter') {
    const { rows } = await query(`SELECT COUNT(*) FROM transactions WHERE owner_id=$1`, [userId]);
    const count = parseInt(rows[0].count) || 0;
    const max = 5000;
    const prog = (count / max) * 100;
    return res.send(`
      <html><head><title>Upload Historical Data</title></head>
      <body>
        <h1>Upload CSV/Excel (free) or Image/Audio (DeepDive)</h1>
        <form action="/dashboard/${userId}/upload" method="POST" enctype="multipart/form-data">
          <input type="hidden" name="token" value="${token}">
          <input type="file" name="file" required>
          <button>Upload</button>
        </form>
        <div style="width:100%;background:#ddd;"><div style="width:${prog}%;background:#4CAF50;color:white;">${count}/${max}</div></div>
      </body></html>
    `);
  }

  // Pro/Enterprise → OTP verify
  res.send(`
    <html><body>
      <h1>Enter OTP</h1>
      <form action="/dashboard/${userId}/verify" method="POST">
        <input type="hidden" name="token" value="${token}">
        <input name="otp" required>
        <button>Verify</button>
      </form>
    </body></html>
  `);
});

// Resend OTP
router.post('/:userId/resend-otp', userProfileMiddleware, async (req, res) => {
  const { userId } = req.params;
  const { userProfile } = req;
  const token = req.body.token;
  if (userId !== userProfile.user_id || token !== userProfile.dashboard_token) return res.status(403).send('Forbidden');
  const otp = await generateOTP(userId);
  await sendMessage(userId, `Dashboard OTP: ${otp} (expires 10 min)`);
  res.send(`<html><body>OTP resent. <a href="/dashboard/${userId}?token=${token}">Back</a></body></html>`);
});

// Verify OTP → full dashboard
router.post('/:userId/verify', userProfileMiddleware, async (req, res) => {
  const { userId } = req.params;
  const { userProfile } = req;
  const { otp, token } = req.body;
  if (userId !== userProfile.user_id || token !== userProfile.dashboard_token) return res.status(403).send('Forbidden');
  const ok = await verifyOTP(userId, otp);
  if (!ok) return res.send(`<html><body>Invalid OTP. <a href="/dashboard/${userId}?token=${token}">Try again</a></body></html>`);
  // Render full dashboard (same as your original, trimmed for brevity)
  res.send(`<html><body><h1>Welcome ${userProfile.name || ''}</h1>…full tables…</body></html>`);
});

// Upload handling (CSV / DeepDive)
router.post('/:userId/upload', upload.single('file'), userProfileMiddleware, async (req, res) => {
  const { userId } = req.params;
  const { userProfile } = req;
  const token = req.body.token;
  if (userId !== userProfile.user_id || token !== userProfile.dashboard_token) return res.status(403).send('Forbidden');
  if (!req.file) return res.status(400).send('No file');
  const summary = await parseUpload(req.file.buffer, req.file.originalname, userId, req.file.mimetype, req.body.uploadType, userProfile.fiscal_year_start);
  res.send(`<html><body>Uploaded! ${summary.transactions} transactions. <a href="/dashboard/${userId}?token=${token}">Back</a></body></html>`);
});

router.use(errorMiddleware);
module.exports = router;