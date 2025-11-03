// api/webhook.js — tiny delegator (no express, no serverless-http)
module.exports = (req, res) => {
  if (req.method !== 'POST') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/xml');
    return res.end('<Response><Message>OK</Message></Response>');
  }
  let handler;
  try {
    handler = require('../routes/webhook');
  } catch (e) {
    console.error('[WEBHOOK] router load failed:', e && e.message);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/xml');
    return res.end('<Response><Message>Temporarily unavailable. Try again.</Message></Response>');
  }
  return handler(req, res);
};
