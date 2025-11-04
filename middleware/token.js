// middleware/token.js
function tokenMiddleware(req, res, next) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers['x-twilio-signature'];
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

  if (!authToken || !signature) {
    return res.status(400).send('Missing auth token or signature');
  }

  // Twilio signs ONLY the POST body (form-urlencoded string)
  const params = req.body;
  const postData = Object.keys(params)
    .sort() // Keys must be sorted alphabetically
    .map(key => `${key}${params[key]}`)
    .join('');

  const expected = require('crypto')
    .createHmac('sha1', authToken)
    .update(Buffer.from(postData, 'utf-8'))
    .digest('base64');

  if (signature !== expected) {
    console.warn('[token] Invalid signature', {
      url,
      received: signature,
      expected,
      postData,
    });
    return res.status(403).send('Invalid signature');
  }

  next();
}

module.exports = { tokenMiddleware };