// routes/deepDive.js
const express = require('express');
const router = express.Router();
const { parseUpload } = require('../services/deepDive');

// Simple health check
router.get('/health', (req, res) => {
  res.json({ ok: true });
});

/**
 * POST /deep-dive
 * Body (JSON):
 * {
 *   "from": "19053279955",
 *   "filename": "upload.csv",
 *   "mimeType": "text/csv",
 *   "uploadType": "csv",
 *   "fiscalYearStart": "2025-01-01",
 *   "bufferBase64": "<base64 file bytes>"
 * }
 */
router.post('/', async (req, res) => {
  try {
    const {
      from,
      filename = 'upload.csv',
      mimeType = 'text/csv',
      uploadType = 'csv',
      fiscalYearStart,
      bufferBase64,
    } = req.body || {};

    if (!from || !bufferBase64) {
      return res.status(400).json({ error: 'Missing "from" or "bufferBase64".' });
    }

    const buffer = Buffer.from(bufferBase64, 'base64');
    const result = await parseUpload(
      buffer,
      filename,
      from,
      mimeType,
      uploadType,
      fiscalYearStart
    );

    res.json(result);
  } catch (err) {
    console.error('[deep-dive] upload failed:', err.message);
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
