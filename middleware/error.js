// middleware/error.js
const crypto = require('crypto');

async function auditError(req, err) {
  try {
    const pg = require('../services/postgres'); // lazy to avoid cycles
    const traceId = req.traceId || crypto.randomBytes(8).toString('hex');
    const from = req.from || 'unknown';
    const ctx = { path: req.path, method: req.method };
    await pg.query(
      `INSERT INTO error_logs (user_id, trace_id, error_message, error_stack, context, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW())`,
      [from, traceId, String(err?.message || err), String(err?.stack || ''), ctx]
    );
    return traceId;
  } catch {
    return req?.traceId || '';
  }
}

function errorMiddleware(err, req, res, _next) {
  try {
    const { releaseLock } = require('./lock');
    try { releaseLock(req?.ownerId || req?.from || 'GLOBAL'); } catch {}
    const trace = (req?.traceId || '').slice(0, 8);
    console.error('[ERR', trace, ']', err?.stack || err?.message || err);

    // fire-and-forget audit
    auditError(req, err).catch(() => {});

    if (!res.headersSent) {
      res
        .status(200)
        .type('application/xml')
        .send('<Response><Message>Something went wrong. Try again.</Message></Response>');
    }
  } catch {
    if (!res.headersSent) {
      res.status(200).type('application/xml').send('<Response><Message>OK</Message></Response>');
    }
  }
}

module.exports = { errorMiddleware };
