const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const DEFAULT_TTL_SEC = 25;

function normalizePhoneNumber(userId = '') {
  const val = String(userId || '');
  const noWa = val.startsWith('whatsapp:') ? val.slice('whatsapp:'.length) : val;
  return noWa.replace(/^\+/, '').trim();
}

async function acquireLock(userId, token, ttlSec = DEFAULT_TTL_SEC) {
  const normalizedId = normalizePhoneNumber(userId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT token, expires_at FROM locks WHERE user_id = $1 FOR UPDATE`,
      [normalizedId]
    );

    const now = new Date();
    const newExpiry = new Date(now.getTime() + ttlSec * 1000);

    if (rows.length === 0) {
      await client.query(
        `INSERT INTO locks (user_id, token, expires_at, updated_at)
         VALUES ($1, $2, $3, NOW())`,
        [normalizedId, token, newExpiry]
      );
      await client.query('COMMIT');
      return true;
    }

    const current = rows[0];
    const expired = new Date(current.expires_at) <= now;
    const sameToken = current.token === token;

    if (expired || sameToken) {
      await client.query(
        `UPDATE locks
           SET token = $2, expires_at = $3, updated_at = NOW()
         WHERE user_id = $1`,
        [normalizedId, token, newExpiry]
      );
      await client.query('COMMIT');
      return true;
    }

    await client.query('ROLLBACK');
    return false;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function releaseLock(userId, token) {
  const normalizedId = normalizePhoneNumber(userId);
  try {
    await pool.query(
      `DELETE FROM locks WHERE user_id = $1 AND token = $2`,
      [normalizedId, token]
    );
  } catch (e) {
    // swallow; don't crash webhook on release failure
  }
}

module.exports = { acquireLock, releaseLock };