const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function lockMiddleware(req, res, next) {
  const from = req.body.From ? req.body.From.replace(/\D/g, '') : 'UNKNOWN_FROM';
  const lockKey = `lock:${from}`;
  const ttlSeconds = 5;
  console.log('[LOCK] Attempting to acquire lock for', from);

  try {
    const res = await pool.query(
      `INSERT INTO locks (lock_key, created_at)
       VALUES ($1, NOW())
       ON CONFLICT (lock_key) DO UPDATE
       SET created_at = NOW()
       WHERE locks.created_at < NOW() - INTERVAL '5 seconds'
       RETURNING *`,
      [lockKey]
    );
    if (res.rows.length === 0) {
      console.log('[LOCK] Stale lock detected for', from);
      return res.status(429).send('<Response><Message>Too many requests, please try again later.</Message></Response>');
    }
    console.log('[LOCK] Acquired lock for', from);
    req.lockKey = lockKey;
    next();
  } catch (error) {
    console.error('[ERROR] Lock acquisition failed:', error.message);
    return res.status(500).send('<Response><Message>⚠️ Server error, please try again later.</Message></Response>');
  }
}

async function releaseLock(lockKey) {
  console.log('[LOCK] Releasing lock for', lockKey);
  try {
    await pool.query('DELETE FROM locks WHERE lock_key = $1', [lockKey]);
    console.log('[LOCK] Released lock for', lockKey);
  } catch (error) {
    console.error('[ERROR] Lock release failed:', error.message);
  }
}

module.exports = { lockMiddleware, releaseLock };