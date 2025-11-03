// api/webhook.js
const serverless = require('serverless-http');
const express = require('express');
const webhookRouter = require('../routes/webhook');

// Build a tiny app that just mounts the router.
// Do NOT attach json/urlencoded parsers here — the router does its own urlencoded.
const app = express();
app.use('/', webhookRouter);

// Optional health
app.get('/', (_req, res) => res.status(200).send('Webhook OK'));

module.exports = serverless(app);
