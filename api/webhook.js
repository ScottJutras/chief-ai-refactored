// api/webhook.js
console.log('[BOOT] pid', process.pid, 'ts', Date.now());

const serverless = require('serverless-http');
const express = require('express');
const app = express();

// Very early log
app.use((req, _res, next) => {
  console.log('[SVLESS] hit', {
    route: '/api/webhook' + (req.originalUrl || '/'),
    method: req.method,
    ct: req.headers['content-type'] || null,
    cl: req.headers['content-length'] || null,
  });
  next();
});

// === App-level 8s safety (fires even if router load is slow) ===
app.use((req, res, next) => {
  if (!res.locals.__appSafety) {
    res.locals.__appSafety = setTimeout(() => {
      if (!res.headersSent) {
        console.warn('[SVLESS] app-level safety reply (8s)');
        res
          .status(200)
          .type('application/xml')
          .send('<Response><Message>OK</Message></Response>');
      }
    }, 8000);
    const clear = () => { try { clearTimeout(res.locals.__appSafety); } catch {} };
    res.on('finish', clear);
    res.on('close', clear);
  }
  next();
});

// === Exact-path guard for non-POST probes on "/" ===
app.all('/', (req, res, next) => {
  if (req.method === 'POST') return next();
  if (req.headers['content-length']) delete req.headers['content-length'];
  try { req.on('error', () => {}); req.resume(); } catch {}
  return res.status(200).type('application/xml').send('<Response><Message>OK</Message></Response>');
});

// ---------- Lazy-load the heavy router ----------
let _router = null;
function getRouter() {
  if (_router) return _router;
  try {
    _router = require('../routes/webhook');
  } catch (e) {
    console.error('[SVLESS] failed to load routes/webhook:', e?.message);
    const r = express.Router();
    r.post('/', (_req, res) =>
      res.status(200).type('application/xml')
         .send('<Response><Message>Temporarily unavailable. Try again.</Message></Response>')
    );
    _router = r;
  }
  return _router;
}

// Delegate to the router (loaded on first hit)
app.use('/', (req, res, next) => getRouter().handle(req, res, next));

// Optional health
app.get('/', (_req, res) => {
  res.status(200).type('text/plain').send('Webhook OK');
});

// Final safeguard
app.use((req, res) => {
  if (!res.headersSent) {
    console.warn('[SVLESS] fell-through final safeguard');
    res.status(200).type('application/xml').send('<Response><Message>OK</Message></Response>');
  }
});

module.exports = serverless(app);
