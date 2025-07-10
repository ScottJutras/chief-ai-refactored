const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
});

async function acquireLock(key) {
  console.log('[LOCK] Attempting to acquire lock for', key);
  try {
    const result = await pool.query(
      `INSERT INTO locks (lock_key, created_at)
       VALUES ($1, NOW())
       ON CONFLICT (lock_key) DO NOTHING
       RETURNING *`,
      [key]
    );
    if (result.rows.length === 0) {
      console.log('[LOCK] Lock acquisition failed for', key, ': already locked');
      return false;
    }
    console.log('[LOCK] Acquired lock for', key);
    return true;
  } catch (error) {
    console.error('[ERROR] acquireLock failed for', key, ':', error.message);
    throw error;
  }
}

async function releaseLock(key) {
  console.log('[LOCK] Releasing lock for', key);
  try {
    await pool.query(`DELETE FROM locks WHERE lock_key = $1`, [key]);
    console.log('[LOCK] Released lock for', key);
  } catch (error) {
    console.error('[ERROR] releaseLock failed for', key, ':', error.message);
    throw error;
  }
}

async function lockMiddleware(req, res, next) {
  const key = req.body.From ? `lock:${req.body.From.replace(/\D/g, '')}` : null;
  if (!key) {
    console.error('[ERROR] Missing From in lockMiddleware');
    return res.send(`<Response><Message>⚠️ Invalid request. Please try again.</Message></Response>`);
  }
  try {
    const lockAcquired = await acquireLock(key);
    if (!lockAcquired) {
      console.log('[LOCK] Failed to acquire lock for', key);
      return res.send(`<Response><Message>⚠️ Another request is being processed. Please try again shortly.</Message></Response>`);
    }
    req.lockKey = key;
    next();
  } catch (err) {
    console.error('[ERROR] lockMiddleware failed for', key, ':', err.message);
    next(err);
  }
}

module.exports = { acquireLock, releaseLock, lockMiddleware };