// api/webhook.js
const serverless = require('serverless-http');
const express = require('express');
const webhookRouter = require('../routes/webhook');

const app = express();

// Do NOT add body parsers here; the router handles Twilio's urlencoded already.
app.use('/', webhookRouter);
app.get('/', (_req, res) => res.status(200).send('Webhook OK'));

module.exports = serverless(app);
