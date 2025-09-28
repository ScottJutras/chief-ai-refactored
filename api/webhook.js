const serverless = require('serverless-http');
const express = require('express');
const bodyParser = require('body-parser');
const webhookRouter = require('../routes/webhook');

const app = express();
app.use(bodyParser.urlencoded({ extended: false, limit: '50mb' }));
app.use(bodyParser.json({ limit: '50mb' }));

app.use('/', webhookRouter);
app.get('/', (_req, res) => res.status(200).send('Webhook OK'));

module.exports = serverless(app);
