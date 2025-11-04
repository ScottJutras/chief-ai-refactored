// api/webhook.js — tiny delegator (no express, no serverless-http)
module.exports = (req, res) => {
  // Instantly 200 for non-POST (Twilio GET probes / redirects)
  if (req.method !== 'POST') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/xml');
    return res.end('<Response><Message>OK</Message></Response>');
  }

  // Lazy load the real router only on POST (keeps cold start tiny)
  let handler;
  try {
    handler = require('../routes/webhook'); // must export a (req,res) handler
  } catch (e) {
    console.error('[WEBHOOK] router load failed:', e && e.message);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/xml');
    return res.end('<Response><Message>Temporarily unavailable. Try again.</Message></Response>');
  }

  // Hand off to the Express app handler exported by routes/webhook.js
  return handler(req, res);
};
