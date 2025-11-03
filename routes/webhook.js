// routes/webhook.js
const express = require('express');
const app = express();
const router = express.Router();

// --- tolerant urlencoded parser for POST form bodies only (no heavy body parsers) ---
const querystring = require('querystring');
router.use((req, _res, next) => {
  if (req.method !== 'POST') return next();
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/x-www-form-urlencoded')) return next();
  if (req.body && Object.keys(req.body).length) return next();

  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 1_000_000) { try { req.destroy(); } catch {} } // 1MB safety
  });
  req.on('end', () => {
    try { req.body = raw ? querystring.parse(raw) : {}; }
    catch { req.body = {}; }
    next();
  });
  req.on('error', () => { req.body = {}; next(); });
});

// --------- quick safety + version ping before any heavy logic ----------
router.post('*', async (req, res, next) => {
  try {
    // 8s safety: ensure Twilio gets 200 even if something stalls
    if (!res.locals._safety) {
      res.locals._safety = setTimeout(() => {
        if (!res.headersSent) {
          console.warn('[WEBHOOK] 8s safety reply');
          res.status(200).type('application/xml').send('<Response><Message>OK</Message></Response>');
        }
      }, 8000);
      const clear = () => { try { clearTimeout(res.locals._safety); } catch {} };
      res.on('finish', clear); res.on('close', clear);
    }

    // DEBUG (temp): log path + body seen by router
    console.log('[ROUTER.POST*]', { url: req.originalUrl, bodyBody: req.body?.Body });

    // "version" fast-path
    const bodyText = String(req.body?.Body || '').trim().toLowerCase();
    if (bodyText === 'version') {
      const v = process.env.VERCEL_GIT_COMMIT_SHA || process.env.COMMIT_SHA || 'dev-local';
      return res
        .status(200)
        .type('application/xml')
        .send(`<Response><Message>build ${String(v).slice(0,7)} OK</Message></Response>`);
    }

    // ---------- light routing (expand later) ----------
    const text = String(req.body?.Body || '').toLowerCase();

    // Tasks help
    if (/\bhow (do|to).*\btask/.test(text) || /\btasks?\b/.test(text)) {
      return res
        .status(200)
        .type('application/xml')
        .send('<Response><Message>Tasks — quick guide:\n• task – buy nails (adds to active job)\n• tasks / my tasks (list)\n• done #4 (mark done)\n• due #3 Friday</Message></Response>');
    }

    // Jobs help
    if (/\bjob(s)?\b/.test(text)) {
      return res
        .status(200)
        .type('application/xml')
        .send(
          '<Response><Message>' +
            'Jobs — quick guide:\n' +
            '• create job &lt;name&gt;\n' +
            '• list jobs\n' +
            '• set active job &lt;name&gt;\n' +
            '• active job?\n' +
            '• close job &lt;name&gt;\n' +
            '• move last log to &lt;name&gt;\n' +
          '</Message></Response>'
        );
    }

    // Default: timeclock help
    return res
      .status(200)
      .type('application/xml')
      .send(
        '<Response><Message>' +
          'Here’s what to know (timeclock):\n' +
          '• Clock in — “clock in” (uses active job) or “clock in @ Roof Repair 7am”\n' +
          '• Clock out — “clock out”\n' +
          '• Break/Drive — “start break”, “end break”, “start drive”, “end drive”\n' +
        '</Message></Response>'
      );
  } catch (err) {
    return next(err);
  }
});

// ---- final Twilio safety to avoid 11200 on fall-through ----
router.use((req, res, next) => {
  if (!res.headersSent) {
    console.warn('[WEBHOOK] fell-through fallback');
    return res.status(200).type('application/xml').send('<Response><Message>OK</Message></Response>');
  }
  next();
});

// Export as plain Node handler for the tiny delegator in api/webhook.js
app.use('/', router);
module.exports = (req, res) => app.handle(req, res);
