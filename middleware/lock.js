// middleware/lock.js
// Lightweight, serverless-safe(ish) in-process lock.
// In multi-instance, collisions are unlikely at low QPS; upgrade to Redis later.

const locks = new Map(); // key -> { at: number }
const TTL_MS = 8_000;

function _now() { return Date.now(); }
function _key(req) {
  // Lock per owner; fall back to sender or GLOBAL
  return `lock:${req.ownerId || req.from || 'GLOBAL'}`;
}

function releaseLock(keyOrReq) {
  const key = typeof keyOrReq === 'string' ? keyOrReq : _key(keyOrReq || {});
  if (locks.has(key)) locks.delete(key);
}

function lockMiddleware(req, res, next) {
  const key = _key(req);
  const now = _now();

  // Expire stale lock
  const existing = locks.get(key);
  if (existing && now - existing.at > TTL_MS) {
    locks.delete(key);
  }

  if (locks.has(key)) {
    // Busy — reply quickly so Twilio doesn't retry.
    try {
      if (!res.headersSent) {
        res.status(200).type('application/xml')
          .send('<Response><Message>Busy, try again in a moment.</Message></Response>');
      }
    } catch {}
    return;
  }

  // Acquire
  locks.set(key, { at: now });

  // Auto-release after response completes
  const clear = () => releaseLock(key);
  res.on('finish', clear);
  res.on('close', clear);

  // Also expose on req for handlers that want manual release
  req.releaseLock = () => releaseLock(key);

  return next();
}

module.exports = { lockMiddleware, releaseLock };
