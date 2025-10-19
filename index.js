// index.js
if (!process.env.VERCEL) { require('dotenv').config(); } // local only

const express = require('express');
const bodyParser = require('body-parser');

const webhookRouter = require('./routes/webhook');
const parseRouter = require('./routes/parse');
const deepDiveRouter = require('./routes/deepDive');
const dashboardRouter = require('./routes/dashboard');
// If you still need exports endpoints, uncomment the next line:
// const exportsRouter = require('./routes/exports');

const app = express();

// Basic hardening & parsing
app.disable('x-powered-by');
app.use(bodyParser.urlencoded({ extended: false, limit: '50mb' }));
app.use(bodyParser.json({ limit: '50mb' }));

app.get('/', (req, res) => {
  console.log('[DEBUG] GET request received at root URL');
  res.set('Cache-Control', 'no-store').send('Chief AI Webhook Server is running!');
});

// IMPORTANT: Twilio path must match your Twilio console
app.use('/api/webhook', webhookRouter);
app.use('/webhook', webhookRouter); // temporary alias
app.use('/parse', parseRouter);
app.use('/deep-dive', deepDiveRouter);
app.use('/dashboard', dashboardRouter);
// if (exportsRouter) app.use('/exports', exportsRouter);

// Only listen locally; Vercel uses serverless handler
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`✅ Server is running on port ${PORT}`);
  });
}

module.exports = app;
