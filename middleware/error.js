// middleware/error.js
const crypto = require('crypto');

function short(s, n = 256) {
  try {
    const t = String(s ?? '');
    return t.length > n ? t.slice(0, n) + '…' : t;
  } catch {
    return '';
  }
}

const digits = (s = '') => String(s || '').replace(/\D/g, '');

function buildContext(req) {
  const headers = req?.headers || {};
  return {
    when: new Date().toISOString(),
    nodeEnv: process.env.NODE_ENV || 'development',
    commit: process.env.VERCEL_GIT_COMMIT_SHA || process.env.COMMIT_SHA || 'dev-local',
    route: short(req?.originalUrl || req?.url, 256),
    method: req?.method || 'GET',
    path: req?.path || '',
    ownerId: digits(req?.ownerId || ''),
    from: digits(req?.from || ''),
    isOwner: !!req?.isOwner,
    signatureOk: !!req?.signatureOk,
    userAgent: short(headers['user-agent'], 128),
    xForwardedFor: short(headers['x-forwarded-for'], 256),
    xForwardedProto: short(headers['x-forwarded-proto'], 32),
    xForwardedHost: short(headers['x-forwarded-host'], 128),
    hasBody: !!req?.body && Object.keys(req.body).length > 0,
    bodyKeys: req?.body ? Object.keys(req.body).slice(0, 25) : [],
    traceId: req?.traceId || ''
  };
}

async function auditError(req, err) {
  try {
    const pg = require('../services/postgres');
    const traceId = req.traceId || crypto.randomBytes(8).toString('hex');
    const from = digits(req.from) || 'unknown';
    const ctx = buildContext(req);

    await pg.query(
      `INSERT INTO error_logs (user_id, trace_id, error_message, error_stack, context, created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,NOW())`,
      [from, traceId, String(err?.message || err), String(err?.stack || ''), JSON.stringify(ctx)]
    );
    return traceId;
  } catch {
    return req?.traceId || '';
  }
}

function errorMiddleware(err, req, res, _next) {
  try {
    if (!req.traceId) req.traceId = crypto.randomBytes(8).toString('hex');
    const traceShort = req.traceId.slice(0, 8);

    try {
      const { releaseLock } = require('./lock');
      try {
        releaseLock(req?.ownerId || req?.from || 'GLOBAL');
      } catch {}
    } catch {}

    const summary = err && (err.stack || err.message) ? err.stack || err.message : String(err);
    console.error('[ERR', traceShort, ']', summary);

    auditError(req, err).catch(() => {});

    if (!res.headersSent) {
      res
        .status(200)
        .type('application/xml; charset=utf-8')
        .send('<Response><Message>Something went wrong. Try again.</Message></Response>');
    }
  } catch {
    try {
      if (!res.headersSent) {
        res.status(200).type('application/xml; charset=utf-8').send('<Response><Message>OK</Message></Response>');
      }
    } catch {}
  }
}

module.exports = { errorMiddleware };
