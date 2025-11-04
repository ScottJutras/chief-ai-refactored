// middleware/error.js
const crypto = require('crypto');
const pg = require('../services/postgres');
const { releaseLock } = require('./lock');

async function auditError(req, err) {
  const traceId = req.traceId || crypto.randomBytes(8).toString('hex');
  const from = req.from || 'unknown';
  try {
    await pg.query(
      `INSERT INTO error_logs (user_id, trace_id, error_message, error_stack, context, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW())`,
      [from, traceId, err.message, err.stack, { path: req.path, method: req.method }]
    );
  } catch (e) {
    console.error('[error] audit failed:', e.message);
  }
  return traceId;
}

function errorMiddleware(err, req, res, _next) {
  const traceId = req.traceId || crypto.randomBytes(8).toString('hex');
  console.error(`[ERR ${traceId}]`, err?.stack || err?.message || err);

  // ---- 1. Release any lock we own (ownerId or from) ----
  const lockKey = `lock:${req.ownerId || req.from || 'GLOBAL'}`;
  releaseLock(lockKey).catch(() => {});

  // ---- 2. User-facing friendly message (preserve old mapping) ----
  let message = 'Something went wrong. Try again.';
  if (err.message.includes('Trial limit reached')) message = 'Trial limit reached! Reply "Upgrade".';
  else if (err.message.includes('Invalid userId or tier')) message = 'Invalid request. Check your input.';
  // … (keep the full list from the old file – they are cheap string checks)

  // ---- 3. Audit (SOC-2) ----
  auditError(req, err).catch(() => {});

  // ---- 4. Respond (webhook vs API) ----
  if (req.path.includes('/webhook')) {
    if (!res.headersSent) {
      res.status(200).type('application/xml')
        .send(`<Response><Message>${message}</Message></Response>`);
    }
  } else {
    if (!res.headersSent) {
      res.status(500).json({ error: message, traceId });
    }
  }
}
module.exports = { errorMiddleware };