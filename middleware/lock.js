// middleware/lock.js
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
});

// Normalize a Twilio From value -> digits only user_id (e.g., "whatsapp:+1905..." => "1905...")
function normalizeFrom(raw) {
  return String(raw || '')
    .replace(/^whatsapp:/i, '')
    .replace(/^\+/, '')
    .replace(/\D/g, '');
}

/**
 * Acquire a lock for the given key+user.
 * Returns true if acquired, false if already locked.
 */
async function acquireLock(lockKey, userId) {
  console.log('[LOCK] Attempting to acquire lock for', lockKey);
  try {
    const result = await pool.query(
      `
      INSERT INTO public.locks (lock_key, user_id, created_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (lock_key) DO NOTHING
      RETURNING lock_key
      `,
      [lockKey, userId]
    );

    if (result.rows.length === 0) {
      console.log('[LOCK] Lock acquisition failed for', lockKey, ': already locked');
      return false;
    }

    console.log('[LOCK] Acquired lock for', lockKey);
    return true;
  } catch (err) {
    console.error('[ERROR] acquireLock failed for', lockKey, ':', err.message);
    throw err;
  }
}

/**
 * Release a lock for the given key.
 */
async function releaseLock(lockKey) {
  console.log('[LOCK] Releasing lock for', lockKey);
  try {
    await pool.query(`DELETE FROM public.locks WHERE lock_key = $1`, [lockKey]);
    console.log('[LOCK] Released lock for', lockKey);
  } catch (err) {
    console.error('[ERROR] releaseLock failed for', lockKey, ':', err.message);
    throw err;
  }
}

/**
 * Express middleware to enforce per-number locking.
 */
async function lockMiddleware(req, res, next) {
  const { From } = req.body || {};
  const fromRaw = req.from || From || null;
  const userId = normalizeFrom(fromRaw);
  const lockKey = userId ? `lock:${userId}` : null;

  if (!lockKey) {
    console.error('[ERROR] Missing From in lockMiddleware');
    return res
      .status(200)
      .send(`<Response><Message>⚠️ Invalid request. Please try again.</Message></Response>`);
  }

  try {
    const acquired = await acquireLock(lockKey, userId);
    if (!acquired) {
      return res
        .status(200)
        .send(`<Response><Message>⚠️ Another request is being processed. Please try again shortly.</Message></Response>`);
    }

    req.lockKey = lockKey; // router uses this in finally
    next();
  } catch (err) {
    console.error('[ERROR] lockMiddleware failed for', lockKey, ':', err.message);
    next(err);
  }
}

module.exports = {
  acquireLock,
  releaseLock,
  lockMiddleware
};
