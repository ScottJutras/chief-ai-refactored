// middleware/lock.js
// Per-owner lock: prevents concurrent conflicting mutations.
// Uses Redis if available; falls back to in-process (single instance).
let redis = null;
try {
  if (process.env.REDIS_URL) {
    const Redis = require('ioredis');
    redis = new Redis(process.env.REDIS_URL);
  }
} catch { /* optional */ }

const localLocks = new Set();
const keyFor = (req) => `lock:${req.ownerId || 'GLOBAL'}`;

async function lockMiddleware(req, res, next) {
  const k = keyFor(req);

  if (redis) {
    try {
      const ok = await redis.set(k, '1', 'NX', 'EX', 10); // 10s TTL
      if (!ok) {
        return res.status(200).type('application/xml')
          .send('<Response><Message>Busy, try again in a moment.</Message></Response>');
      }
      const cleanup = () => { try { redis.del(k); } catch {} };
      res.on('finish', cleanup); res.on('close', cleanup);
      return next();
    } catch (e) {
      console.warn('[lock] redis failed, falling back:', e?.message);
    }
  }

  // Fallback in-process
  if (localLocks.has(k)) {
    return res.status(200).type('application/xml')
      .send('<Response><Message>Busy, try again in a moment.</Message></Response>');
  }
  localLocks.add(k);
  const cleanup = () => localLocks.delete(k);
  res.on('finish', cleanup); res.on('close', cleanup);
  next();
}

module.exports = { lockMiddleware };
