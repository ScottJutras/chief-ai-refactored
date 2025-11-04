// api/webhook.js
import express from 'express';
const app = express();

// MUST BE FIRST
app.use(express.urlencoded({ extended: true })); // ← fixes Twilio signature
app.use(express.json());

// Export as .handler for Vercel
module.exports.handler = (req, res) => {
  // Handle Twilio GET probes / non-POST
  if (req.method !== 'POST') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/xml');
    return res.end('<Response><Message>OK</Message></Response>');
  }

  // Lazy-load real router
  let router;
  try {
    router = require('../routes/webhook');
  } catch (e) {
    console.error('[WEBHOOK] Failed to load router:', e?.message);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/xml');
    return res.end('<Response><Message>Service unavailable. Try again.</Message></Response>');
  }

  // Delegate to Express router
  return router(req, res);
};