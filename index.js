// index.js
if (!process.env.VERCEL) { require('dotenv').config(); } // local only

const express = require('express');

const webhookRouter   = require('./routes/webhook');
const parseRouter     = require('./routes/parse');
const deepDiveRouter  = require('./routes/deepDive');
const dashboardRouter = require('./routes/dashboard');

const app = express();

/* ---------------- Hardening / perf (no global parsers) ---------------- */
app.disable('x-powered-by');
app.set('query parser', 'simple');          // predictable query parsing
app.set('trust proxy', 1);                  // Vercel/Proxies (IP rate limits etc.)
app.disable('etag');                        // avoid 304 complexity on serverless

/* ---------------- Health checks ---------------- */
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store').send('Chief AI Webhook Server is running!');
});
app.get('/api/healthz', (req, res) => {
  res.set('Cache-Control', 'no-store').status(200).json({ ok: true, ts: Date.now() });
});

/* ---------------- Mount order (NO global body parsers) ---------------- */
// Webhook first; it does its own tolerant urlencoded/body handling.
app.use('/api/webhook', webhookRouter);
app.use('/webhook', webhookRouter); // temporary alias

// Other routers can attach their own parsers internally as needed.
app.use('/parse',      parseRouter);
app.use('/deep-dive',  deepDiveRouter);
app.use('/dashboard',  dashboardRouter);

/* ---------------- Local dev only ---------------- */
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
}

module.exports = app;
