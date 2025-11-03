// api/webhook.js
const serverless = require('serverless-http');
const express = require('express');
const webhookRouter = require('../routes/webhook');

const app = express();

// Early, unconditional log so we know every invocation made it this far
app.use((req, _res, next) => {
  console.log('[SVLESS] hit', {
    url: req.originalUrl,
    method: req.method,
    ct: req.headers['content-type'] || null,
    cl: req.headers['content-length'] || null
  });
  next();
});

// Mount router (router does its own tolerant parsing)
app.use('/', webhookRouter);

// Optional health
app.get('/', (_req, res) => res.status(200).send('Webhook OK'));

module.exports = serverless(app);
