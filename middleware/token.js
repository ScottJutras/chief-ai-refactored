// middleware/token.js
// Verifies Twilio X-Twilio-Signature with strict URL canonicalization.
// Uses form-encoded param verification (WhatsApp inbound is x-www-form-urlencoded).

const twilio = require('twilio');

function buildFullUrl(req) {
  // Respect Vercel/Proxies
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host  = (req.headers['x-forwarded-host']  || req.headers.host || '').split(',')[0].trim();
  // originalUrl includes path + query (what Twilio signs)
  const full  = `${proto}://${host}${req.originalUrl || req.url || ''}`;
  return full;
}

function tokenMiddleware(req, res, next) {
  // Only verify POST webhooks
  if (req.method !== 'POST') return next();

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.warn('[token] Missing TWILIO_AUTH_TOKEN — skipping verification');
    req.signatureOk = false;
    return next();
  }

  // Grab signature & compute expected
  const signature = req.headers['x-twilio-signature'] || '';
  const url = req.twilioUrl || buildFullUrl(req);

  // If content-type is form-encoded (WhatsApp), we should have req.body as an object
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  const isForm = ct.includes('application/x-www-form-urlencoded');

  let expectedOk = false;
  try {
    if (isForm) {
      // Ensure req.body exists (routes/webhook.js raw parser sets it)
      const params = req.body && typeof req.body === 'object' ? req.body : {};
      expectedOk = twilio.validateRequest(authToken, signature, url, params);
    } else {
      // For JSON/raw (not typical for WhatsApp inbound), use raw body method
      const raw = typeof req.rawBody === 'string' ? req.rawBody : '';
      expectedOk = twilio.validateRequestBody(authToken, signature, url, raw);
    }
  } catch (e) {
    console.warn('[token] Validation error:', e?.message);
    expectedOk = false;
  }

  if (!expectedOk) {
    // Rich diagnostics to logs only (never echo to user)
    try {
      const sortedKeys = Object.keys(req.body || {}).sort();
      const postData = sortedKeys.map(k => `${k}${req.body[k]}`).join('');
      console.warn('[token] Invalid signature', {
        url,
        received: signature,
        // DO NOT log auth token or headers.
        postData,
        sortedKeys
      });
    } catch {}

    req.signatureOk = false;
    // Fail closed in production; stay tolerant elsewhere during refactor
    if (process.env.NODE_ENV === 'production') {
      res.status(403).type('application/xml').send('<Response><Message>Forbidden</Message></Response>');
      return;
    }
    return next();
  }

  req.signatureOk = true;
  return next();
}

module.exports = { tokenMiddleware };
