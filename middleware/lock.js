// middleware/lock.js
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
});

const LOCK_TTL_MS = parseInt(process.env.LOCK_TTL_MS || '10000', 10); // 10s

// Normalize a Twilio From value -> digits only (e.g., "whatsapp:+1905..." => "1905...")
function normalizeFrom(raw) {
  return String(raw || '')
    .replace(/^whatsapp:/i, '')
    .replace(/^\+/, '')
    .replace(/\D/g, '');
}

function tsPlus(ms) {
  return new Date(Date.now() + ms);
}

/**
 * Acquire (or re-acquire) a lock:
 * - If no row, insert (lock taken)
 * - If expired, take over
 * - If same token, refresh
 */
async function acquireLock(lockKey, userId, token, ttlMs = LOCK_TTL_MS) {
  console.log('[LOCK] Attempting to acquire lock for', lockKey);
  const q = `
    insert into public.locks (lock_key, user_id, token, expires_at, created_at, updated_at)
    values ($1, $2, $3, $4, now(), now())
    on conflict (lock_key) do update
      set token = excluded.token,
          user_id = excluded.user_id,
          expires_at = excluded.expires_at,
          updated_at = now()
    where public.locks.expires_at < now() or public.locks.token = excluded.token
    returning token
  `;
  const params = [lockKey, userId, token, tsPlus(ttlMs)];
  const res = await pool.query(q, params);
  const ok = res.rowCount === 1 && res.rows[0]?.token === token;
  if (!ok) console.log('[LOCK] Lock acquisition failed for', lockKey, ': already locked');
  else console.log('[LOCK] Acquired lock for', lockKey);
  return ok;
}

/** Release lock; if token provided, require ownership */
async function releaseLock(lockKey, token) {
  if (!lockKey) return;
  const q = token
    ? `delete from public.locks where lock_key = $1 and token = $2`
    : `delete from public.locks where lock_key = $1`;
  const params = token ? [lockKey, token] : [lockKey];
  try {
    await pool.query(q, params);
    console.log('[LOCK] Released lock for', lockKey);
  } catch (err) {
    console.error('[ERROR] releaseLock failed for', lockKey, ':', err.message);
    throw err;
  }
}

/** Express middleware to enforce per-number locking with TTL */
async function lockMiddleware(req, res, next) {
  try {
    const { From } = req.body || {};
    const userId = normalizeFrom(req.from || From || '');
    if (!userId) {
      console.error('[ERROR] Missing From in lockMiddleware');
      return res
        .status(200)
        .send(`<Response><Message>⚠️ Invalid request. Please try again.</Message></Response>`);
    }
    const lockKey = `lock:${userId}`;

    // Use Twilio idempotency token; fallback to random
    const token =
      req.headers['i-twilio-idempotency-token'] ||
      (typeof req.get === 'function' && req.get('i-twilio-idempotency-token')) ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const ok = await acquireLock(lockKey, userId, token);
    if (!ok) {
      return res
        .status(200)
        .send(`<Response><Message>⚠️ Another request is being processed. Please try again shortly.</Message></Response>`);
    }

    // Expose for router finally{}
    req.lockKey = lockKey;
    req.lockToken = token;
    return next();
  } catch (err) {
    console.error('[ERROR] lockMiddleware failed:', err?.message);
    return next(err);
  }
}

module.exports = { acquireLock, releaseLock, lockMiddleware };
