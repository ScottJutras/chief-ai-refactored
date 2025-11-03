// api/webhook.js
const serverless = require('serverless-http');
const express = require('express');

const app = express();

// Very early log (Vercel strips /api/webhook before this app)
app.use((req, _res, next) => {
  console.log('[SVLESS] hit', {
    route: '/api/webhook' + (req.originalUrl || '/'),
    method: req.method,
    ct: req.headers['content-type'] || null,
    cl: req.headers['content-length'] || null,
  });
  next();
});

// === Exact-path guard for non-POST "/" (handles Twilio/edge GET probes) ===
app.all('/', (req, res, next) => {
  if (req.method === 'POST') return next();

  // Nuke Content-Length so the platform never waits for a body
  if (req.headers['content-length']) delete req.headers['content-length'];

  // Best-effort drain any bytes without buffering
  try {
    req.on('error', () => {});
    req.resume();
  } catch {}

  // Fast, valid TwiML (prevents 11200)
  return res
    .status(200)
    .type('application/xml')
    .send('<Response><Message>OK</Message></Response>');
});

// ---------- Lazy mount the heavy router ----------
let _router = null;
function getRouter() {
  if (_router) return _router;
  try {
    _router = require('../routes/webhook');
  } catch (e) {
    console.error('[SVLESS] failed to load routes/webhook:', e?.message);
    const r = express.Router();
    r.post('/', (_req, res) =>
      res
        .status(200)
        .type('application/xml')
        .send('<Response><Message>Temporarily unavailable. Try again.</Message></Response>')
    );
    _router = r;
  }
  return _router;
}

// Mount via delegator so require happens only when needed
app.use('/', (req, res, next) => getRouter().handle(req, res, next));

// Optional health (kept exact-path and below router, harmless)
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
