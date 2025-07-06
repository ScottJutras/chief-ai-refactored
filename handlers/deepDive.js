const express = require('express');
const { uploadFile, setFilePermissions } = require('../services/drive');
const { userProfileMiddleware } = require('../middleware/userProfile');
const { tokenMiddleware, updateUserTokenUsage } = require('../middleware/token');
const { errorMiddleware } = require('../middleware/error');
const { generateDeepDiveReport } = require('../utils/pdfService');
const { parseFinancialFile } = require('../services/postgres');
const { db } = require('../services/firebase');
const { Pool } = require('pg');
const fs = require('fs').promises;

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const DEEP_DIVE_TIERS = {
  BASIC: { price: 49, name: "Basic Report", features: ["historical"] },
  FULL: { price: 99, name: "Full Deep Dive", features: ["historical", "forecast_1yr"] },
  ENTERPRISE: { price: 199, name: "Enterprise Custom", features: ["historical", "forecast_10yr", "goals"] }
};

router.post('/', userProfileMiddleware, tokenMiddleware, async (req, res, next) => {
  const { tier = 'BASIC', file } = req.body;
  const { userProfile, ownerId } = req;

  if (!DEEP_DIVE_TIERS[tier]) {
    throw new Error("Invalid tier. Use: BASIC, FULL, ENTERPRISE");
  }

  try {
    let expenses = [];
    let revenues = [];
    const expenseResult = await pool.query(`SELECT * FROM transactions WHERE owner_id = $1 AND type IN ('expense', 'bill')`, [ownerId]);
    const revenueResult = await pool.query(`SELECT * FROM transactions WHERE owner_id = $1 AND type = 'revenue'`, [ownerId]);
    expenses = expenseResult.rows;
    revenues = revenueResult.rows;

    if (file) {
      const fileBuffer = Buffer.from(file, 'base64');
      const fileType = req.headers['content-type'] || 'text/csv';
      const uploadedData = parseFinancialFile(fileBuffer, fileType);
      uploadedData.forEach(entry => {
        if (entry.type === 'expense') {
          expenses.push(entry);
        } else if (entry.type === 'revenue') {
          revenues.push(entry);
        }
      });
    }

    if (!expenses.length && !revenues.length) {
      throw new Error("No financial data provided");
    }

    const outputPath = `/tmp/deep_dive_${ownerId}_${Date.now()}.pdf`;
    await generateDeepDiveReport({
      expenses,
      revenues,
      userProfile,
      tier: DEEP_DIVE_TIERS[tier]
    }, outputPath);

    const fileName = `Deep_Dive_${ownerId}_${Date.now()}.pdf`;
    const driveResponse = await uploadFile(fileName, 'application/pdf', fs.createReadStream(outputPath));
    await setFilePermissions(driveResponse.id, 'reader', 'anyone');
    const pdfUrl = driveResponse.webViewLink;

    if (!userProfile.subscriptionTier) {
      await db.collection('users').doc(ownerId).update({
        subscriptionTier: 'Pro',
        trialStart: new Date().toISOString(),
        trialEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        tokenUsage: { messages: 0, aiCalls: 0 }
      });
    } else {
      await updateUserTokenUsage(ownerId, { messages: 1, aiCalls: 1 });
    }

    res.json({ reportUrl: pdfUrl, message: "Deep Dive report generated successfully" });
  } catch (error) {
    console.error("[ERROR] Deep Dive processing failed:", error.message);
    next(error);
  }
}, errorMiddleware);

module.exports = router;