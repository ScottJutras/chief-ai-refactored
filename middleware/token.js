// middleware/token.js
// Verifies Twilio X-Twilio-Signature with strict URL canonicalization.

const twilio = require('twilio');

function buildFullUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();

  // originalUrl includes path + query (what Twilio signs)
  const path = req.originalUrl || req.url || '';

  // Avoid accidental double slashes
  return `${proto}://${host}${path.startsWith('/') ? path : `/${path}`}`;
}

function tokenMiddleware(req, res, next) {
  if (req.method !== 'POST') return next();

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.warn('[token] Missing TWILIO_AUTH_TOKEN — skipping verification');
    req.signatureOk = false;
    return next();
  }

  const signature = req.headers['x-twilio-signature'] || '';
  const url = req.twilioUrl || buildFullUrl(req);

  const ct = String(req.headers['content-type'] || '').toLowerCase();
  const isForm = ct.includes('application/x-www-form-urlencoded');

  let expectedOk = false;
  try {
    if (isForm) {
      const params = req.body && typeof req.body === 'object' ? req.body : {};
      expectedOk = twilio.validateRequest(authToken, signature, url, params);
    } else {
      const raw = typeof req.rawBody === 'string' ? req.rawBody : '';
      expectedOk = twilio.validateRequestBody(authToken, signature, url, raw);
    }
  } catch (e) {
    console.warn('[token] Validation error:', e?.message);
    expectedOk = false;
  }

  if (!expectedOk) {
    try {
      const sortedKeys = Object.keys(req.body || {}).sort();
      const postData = sortedKeys.map((k) => `${k}${req.body[k]}`).join('');
      console.warn('[token] Invalid signature', { url, received: signature, postData, sortedKeys });
    } catch {}

    req.signatureOk = false;

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
