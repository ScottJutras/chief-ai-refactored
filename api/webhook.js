// api/webhook.js
const serverless = require('serverless-http');
const express = require('express');
const webhookRouter = require('../routes/webhook');

const app = express();

// Very early log (note: Vercel strips /api/webhook before this app)
app.use((req, _res, next) => {
  console.log('[SVLESS] hit', {
    route: '/api/webhook' + (req.originalUrl || '/'),
    method: req.method,
    ct: req.headers['content-type'] || null,
    cl: req.headers['content-length'] || null,
  });
  next();
});

// Mount the webhook router (it handles tolerant parsing + non-POST '/')
app.use('/', webhookRouter);

// Optional: health check for GET '/' (does NOT catch other paths)
app.get('/', (_req, res) => {
  res.status(200).type('text/plain').send('Webhook OK');
});

// Final safeguard (rare)
app.use((req, res) => {
  if (!res.headersSent) {
    console.warn('[SVLESS] fell-through final safeguard');
    res.status(200).type('application/xml').send('<Response><Message>OK</Message></Response>');
  }
});

module.exports = serverless(app);
