// middleware/lock.js
// Lightweight, serverless-safe(ish) in-process lock.
// In multi-instance, collisions are unlikely at low QPS; upgrade to Redis later.

const locks = new Map(); // key -> { at: number }
const TTL_MS = 8_000;

function _now() { return Date.now(); }

function _key(req) {
  const owner =
    (req && (req.owner_id || req.ownerId)) ||
    (req && req.from) ||
    'GLOBAL';
  return `lock:${String(owner).trim() || 'GLOBAL'}`;
}

function releaseLock(keyOrReq) {
  const key = typeof keyOrReq === 'string' ? keyOrReq : _key(keyOrReq || {});
  locks.delete(key);
}

function lockMiddleware(req, res, next) {
  const key = _key(req);
  const now = _now();

  const existing = locks.get(key);
  if (existing && now - existing.at > TTL_MS) locks.delete(key);

  if (locks.has(key)) {
    try {
      if (!res.headersSent) {
        res.status(200).type('application/xml')
          .send('<Response><Message>Busy, try again in a moment.</Message></Response>');
      }
    } catch {}
    return;
  }

  locks.set(key, { at: now });

  const clear = () => releaseLock(key);
  res.on('finish', clear);
  res.on('close', clear);

  req.releaseLock = () => releaseLock(key);
  return next();
}

module.exports = { lockMiddleware, releaseLock };
