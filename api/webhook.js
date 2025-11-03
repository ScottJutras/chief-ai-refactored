// api/webhook.js
const serverless = require('serverless-http');
const express = require('express');
const webhookRouter = require('../routes/webhook');

const app = express();

// 0) Wrapper-level log (very early)
app.use((req, _res, next) => {
  console.log('[SVLESS] hit', {
    url: req.originalUrl,
    method: req.method,
    ct: req.headers['content-type'] || null,
    cl: req.headers['content-length'] || null,
  });
  next();
});

// 1) Hard short-circuit: ANY GET → fast TwiML (prevents 11200 on probes / misrouted GETs)
app.get('/*', (_req, res) => {
  return res
    .status(200)
    .type('application/xml')
    .send('<Response><Message>OK</Message></Response>');
});

// 2) POST and others go to the webhook router (which has tolerant parsing)
app.use('/', webhookRouter);

// 3) Final safeguard: if nothing handled it, send OK TwiML.
app.use((req, res) => {
  if (!res.headersSent) {
    console.warn('[SVLESS] fell-through final safeguard');
    res.status(200).type('application/xml').send('<Response><Message>OK</Message></Response>');
  }
});

module.exports = serverless(app);
