// middleware/lock.js
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
});

const LOCK_TTL_MS = parseInt(process.env.LOCK_TTL_MS || '10000', 10); // 10s default

function nowPlusMs(ms) {
  return new Date(Date.now() + ms);
}

/**
 * Try to acquire a per-key lock.
 * Success if: no existing lock, or existing lock is expired, or we already own it (same token).
 */
async function acquireLock(lockKey, token, ttlMs = LOCK_TTL_MS) {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `
      insert into locks (lock_key, token, expires_at)
      values ($1, $2, $3)
      on conflict (lock_key) do update
        set token = excluded.token,
            expires_at = excluded.expires_at,
            updated_at = now()
      where locks.expires_at < now() or locks.token = excluded.token
      returning token
      `,
      [lockKey, token, nowPlusMs(ttlMs)]
    );

    const acquired = res.rowCount === 1 && res.rows[0]?.token === token;
    if (!acquired) {
      console.error('[ERROR] acquireLock failed for', lockKey, ': already locked');
    }
    return acquired;
  } finally {
    client.release();
  }
}

/**
 * Release lock if we own it.
 */
async function releaseLock(lockKey, token) {
  const client = await pool.connect();
  try {
    await client.query(`delete from locks where lock_key = $1 and token = $2`, [lockKey, token]);
    // no throw if 0 rows; maybe it already expired/was taken over
  } finally {
    client.release();
  }
}

/**
 * Express middleware:
 * - Derives lockKey from sender phone (normalizes optional whatsapp: prefix)
 * - Uses Twilio idempotency token (or a generated fallback) as the lock token
 * - Acquires or returns a "busy" TwiML message
 */
async function lockMiddleware(req, res, next) {
  try {
    const { From } = req.body || {};
    const rawFrom = req.from || From || 'UNKNOWN_FROM';
    const from = String(rawFrom).replace(/^whatsapp:/, '');
    const lockKey = `lock:${from}`;

    // Prefer Twilio’s idempotency token (unique per inbound message)
    const token =
      req.headers['i-twilio-idempotency-token'] ||
      req.get?.('i-twilio-idempotency-token') ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    console.log('[LOCK] Attempting to acquire lock for', lockKey);

    const ok = await acquireLock(lockKey, token);
    if (!ok) {
      // Busy response—Twilio expects 200 + TwiML
      console.log('[LOCK] Busy; returning busy TwiML for', lockKey);
      return res
        .status(200)
        .send(`<Response><Message>I'm processing your previous message—try again in a moment.</Message></Response>`);
    }

    // Expose for downstream handlers
    req.lockKey = lockKey;
    req.lockToken = token;

    // Ensure we always release in router finally
    return next();
  } catch (err) {
    console.error('[ERROR] lockMiddleware failed:', err?.message);
    return next(err);
  }
}

module.exports = {
  acquireLock,
  releaseLock,
  lockMiddleware
};
