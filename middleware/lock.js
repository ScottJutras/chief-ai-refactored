// middleware/lock.js
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
});

/**
 * Acquire a lock for the given key.
 * Returns true if acquired, false if already locked.
 */
async function acquireLock(key) {
  console.log('[LOCK] Attempting to acquire lock for', key);
  try {
    const result = await pool.query(
      `
      INSERT INTO locks (lock_key, created_at)
      VALUES ($1, NOW())
      ON CONFLICT (lock_key) DO NOTHING
      RETURNING lock_key
      `,
      [key]
    );

    if (result.rows.length === 0) {
      console.log('[LOCK] Lock acquisition failed for', key, ': already locked');
      return false;
    }

    console.log('[LOCK] Acquired lock for', key);
    return true;
  } catch (err) {
    console.error('[ERROR] acquireLock failed for', key, ':', err.message);
    throw err;
  }
}

/**
 * Release a lock for the given key.
 */
async function releaseLock(key) {
  console.log('[LOCK] Releasing lock for', key);
  try {
    await pool.query(`DELETE FROM locks WHERE lock_key = $1`, [key]);
    console.log('[LOCK] Released lock for', key);
  } catch (err) {
    console.error('[ERROR] releaseLock failed for', key, ':', err.message);
    throw err;
  }
}

/**
 * Express middleware to enforce per-number locking.
 */
async function lockMiddleware(req, res, next) {
  const { From } = req.body || {};
  const from = req.from || From || null;
  const lockKey = from ? `lock:${from.replace(/\D/g, '')}` : null;

  if (!lockKey) {
    console.error('[ERROR] Missing From in lockMiddleware');
    return res
      .status(200)
      .send(`<Response><Message>⚠️ Invalid request. Please try again.</Message></Response>`);
  }

  try {
    const acquired = await acquireLock(lockKey);
    if (!acquired) {
      return res
        .status(200)
        .send(`<Response><Message>⚠️ Another request is being processed. Please try again shortly.</Message></Response>`);
    }

    req.lockKey = lockKey;
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
