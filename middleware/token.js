// middleware/token.js
function tokenMiddleware(req, res, next) {
  const signature = req.headers['x-twilio-signature'];
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const params = req.body;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!signature || !authToken) {
    return res.status(400).send('Missing signature or auth token');
  }

  const expected = require('crypto')
    .createHmac('sha1', authToken)
    .update(Buffer.from(url + JSON.stringify(params)))
    .digest('base64');

  if (signature !== expected) {
    return res.status(403).send('Invalid signature');
  }

  next();
}

module.exports = { tokenMiddleware };