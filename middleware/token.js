// middleware/token.js
function tokenMiddleware(req, res, next) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers['x-twilio-signature'];

  if (!authToken || !signature) {
    return res.status(400).send('Missing auth token or signature');
  }

  // --- 1. Get raw body as string (Twilio sends form-urlencoded) ---
  const params = req.body;

  // --- 2. Sort keys alphabetically ---
  const sortedKeys = Object.keys(params).sort();

  // --- 3. Concatenate key + value (no =, no &) ---
  let postData = '';
  for (const key of sortedKeys) {
    postData += key + (params[key] || '');
  }

  // --- 4. HMAC-SHA1 ---
  const expected = require('crypto')
    .createHmac('sha1', authToken)
    .update(postData, 'utf-8')
    .digest('base64');

  // --- 5. Compare ---
  if (signature !== expected) {
    console.warn('[token] Invalid signature', {
      url: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
      received: signature,
      expected,
      postData,
      sortedKeys,
    });
    return res.status(403).send('Invalid signature');
  }

  next();
}

module.exports = { tokenMiddleware };