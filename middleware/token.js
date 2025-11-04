// middleware/token.js
const { validateRequest } = require('twilio').Webhook;
const pg = require('../services/postgres');   // for cheap tier lookup only

const AUTH = process.env.TWILIO_AUTH_TOKEN;

async function tokenMiddleware(req, res, next) {
  // ---- 1. Twilio signature (fail-closed) ----
  if (AUTH) {
    const sig = req.headers['x-twilio-signature'];
    const url = req.twilioUrl || `https://${req.headers.host}${req.originalUrl}`;
    const ok = validateRequest(AUTH, sig, url, req.body || {});
    if (!ok) {
      console.warn('[token] invalid Twilio signature', { url });
      return res.status(403).type('application/xml')
        .send('<Response><Message>Invalid request.</Message></Response>');
    }
  } else {
    console.warn('[token] TWILIO_AUTH_TOKEN missing – signature skipped');
  }

  // ---- 2. Cheap tier gate (no token count on every msg) ----
  const from = req.from;
  if (!from) return next();               // non-WhatsApp paths (e.g., cron)
  try {
    const row = await pg.query(
      `SELECT subscription_tier FROM users WHERE user_id=$1 LIMIT 1`,
      [from]
    );
    const tier = (row.rows[0]?.subscription_tier || 'basic').toLowerCase();
    req.subscriptionTier = tier;

    // Block Agent for free/basic on high-cost paths
    const isAgentPath = req.path.includes('/agent') || /agent/i.test(req.body?.Body || '');
    if (isAgentPath && !['pro', 'enterprise'].includes(tier)) {
      return res.status(200).type('application/xml')
        .send('<Response><Message>Upgrade to Pro to use AI.</Message></Response>');
    }
  } catch (e) {
    console.warn('[token] tier lookup failed:', e.message);
  }

  next();
}
module.exports = { tokenMiddleware };