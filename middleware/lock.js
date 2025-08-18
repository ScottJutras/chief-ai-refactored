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

// --- NEW: ensure table exists (idempotent)
async function ensureLocksTable() {
  const ddl = `
    create table if not exists public.locks (
      lock_key   text primary key,
      token      text not null,
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists idx_locks_expires_at on public.locks (expires_at);
  `;
  await pool.query(ddl);
}

/**
 * Try to acquire a per-key lock.
 * Success if: no existing lock, or existing lock is expired, or we already own it (same token).
 */
async function acquireLock(lockKey, token, ttlMs = LOCK_TTL_MS) {
  const client = await pool.connect();
  try {
    await ensureLocksTable(); // <-- NEW

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

/** Release lock if we own it. */
async function releaseLock(lockKey, token) {
  const client = await pool.connect();
  try {
    await client.query(`delete from locks where lock_key = $1 and token = $2`, [lockKey, token]);
  } finally {
    client.release();
  }
}

/** Express middleware */
async function lockMiddleware(req, res, next) {
  try {
    const { From } = req.body || {};
    const rawFrom = req.from || From || 'UNKNOWN_FROM';
    // normalize: drop whatsapp: prefix and leading +
    const from = String(rawFrom).replace(/^whatsapp:/, '').replace(/^\+/, '');
    const lockKey = `lock:${from}`;

    const token =
      req.headers['i-twilio-idempotency-token'] ||
      req.get?.('i-twilio-idempotency-token') ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    console.log('[LOCK] Attempting to acquire lock for', lockKey);

    const ok = await acquireLock(lockKey, token);
    if (!ok) {
      console.log('[LOCK] Busy; returning busy TwiML for', lockKey);
      return res
        .status(200)
        .send(`<Response><Message>I'm processing your previous message—try again in a moment.</Message></Response>`);
    }

    req.lockKey = lockKey;
    req.lockToken = token;
    return next();
  } catch (err) {
    console.error('[ERROR] lockMiddleware failed:', err?.message);
    return next(err);
  }
}

module.exports = { acquireLock, releaseLock, lockMiddleware };
