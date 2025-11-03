// api/webhook.js
const serverless = require('serverless-http');
const express = require('express');
const webhookRouter = require('../routes/webhook');

const app = express();

// Log every invocation so we can see method & headers
app.use((req, _res, next) => {
  console.log('[SVLESS] hit', {
    url: req.originalUrl,
    method: req.method,
    ct: req.headers['content-type'] || null,
    cl: req.headers['content-length'] || null,
  });
  next();
});

/**
 * IMPORTANT
 * On Vercel, external /api/webhook maps to internal "/".
 * We respond immediately to all non-POST methods (e.g., Twilio GET probes),
 * and only route POST "/" into the real webhook router.
 */
app.all('/', (req, res, next) => {
  if (req.method !== 'POST') {
    return res
      .status(200)
      .type('text/xml')
      .send('<Response><Message>OK</Message></Response>');
  }
  // POST -> hand off to router
  return webhookRouter(req, res, next);
});

// Any other paths (e.g., cron /reminders/cron/...) go to the router
app.all('*', webhookRouter);

module.exports = serverless(app);
