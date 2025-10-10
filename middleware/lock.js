// middleware/lock.js
const { query } = require('../services/postgres');

const LOCK_TTL_MS = parseInt(process.env.LOCK_TTL_MS || '10000', 10); // default 10s

// Normalize a Twilio From value -> digits only (e.g., "whatsapp:+1905..." => "1905...")
function normalizeFrom(raw) {
  return String(raw || '')
    .replace(/^whatsapp:/i, '')
    .replace(/^\+/, '')
    .replace(/\D/g, '');
}

function tsPlus(ms) {
  return new Date(Date.now() + Number(ms || 0));
}

/**
 * Acquire (or re-acquire) a lock:
 *   - If no row, insert (lock taken)
 *   - If expired, take over
 *   - If same holder, refresh
 *
 * NOTE: `token` is accepted for signature compatibility but not persisted
 * (your table has no `token` column). We use `holder` for ownership checks.
 */
async function acquireLock(lockKey, userId, token, ttlMs = LOCK_TTL_MS) {
  if (!lockKey) return true;

  if (!userId) {
    // Handler-level call without userId — treat as a no-op so we don't write NULL
    console.log('[LOCK] acquireLock called without userId; no-op for', lockKey);
    return true;
  }

  console.log('[LOCK] Attempting to acquire lock for', lockKey);

  const sql = `
    INSERT INTO public.locks (lock_key, holder, expires_at, created_at, updated_at)
    VALUES ($1, $2, $3, NOW(), NOW())
    ON CONFLICT (lock_key)
    DO UPDATE
       SET holder     = EXCLUDED.holder,
           expires_at = EXCLUDED.expires_at,
           updated_at = NOW()
     WHERE public.locks.expires_at <= NOW()
        OR public.locks.holder     = EXCLUDED.holder
    RETURNING holder
  `;
  const params = [lockKey, userId, tsPlus(ttlMs)];

  try {
    const res = await query(sql, params);
    const ok = res.rowCount === 1 && res.rows[0]?.holder === userId;
    if (!ok) {
      console.log('[LOCK] Lock acquisition failed for', lockKey, ': already locked by another holder');
    } else {
      console.log('[LOCK] Acquired lock for', lockKey);
    }
    return ok;
  } catch (err) {
    console.error('[ERROR] acquireLock failed for', lockKey, ':', err.message);
    throw err;
  }
}

/**
 * Release lock. If you want stricter ownership, add a `userId` param and include `AND holder=$2`.
 * `token` is ignored for schema compatibility.
 */
async function releaseLock(lockKey, token) {
  if (!lockKey) return true;
  try {
    await query(`DELETE FROM public.locks WHERE lock_key = $1`, [lockKey]);
    console.log('[LOCK] Released lock for', lockKey);
    return true;
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

    // Use Twilio idempotency token if present (not stored in DB, only for caller correlation)
    const token =
      (typeof req.get === 'function' && req.get('i-twilio-idempotency-token')) ||
      req.headers?.['i-twilio-idempotency-token'] ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const ok = await acquireLock(lockKey, userId, token);
    if (!ok) {
      return res
        .status(200)
        .send(
          `<Response><Message>⚠️ Another request is being processed. Please try again shortly.</Message></Response>`
        );
    }

    // Expose for router finally{} cleanup
    req.lockKey = lockKey;
    req.lockToken = token; // not used in DB, kept for compatibility
    return next();
  } catch (err) {
    console.error('[ERROR] lockMiddleware failed:', err?.message);
    return next(err);
  }
}

/** Optional: best-effort cleanup of expired locks */
async function cleanupExpiredLocks() {
  try {
    const { rowCount } = await query(`DELETE FROM public.locks WHERE expires_at <= NOW()`);
    if (rowCount) console.log(`[LOCK] Cleaned up ${rowCount} expired locks`);
  } catch (err) {
    console.warn('[LOCK] cleanupExpiredLocks failed:', err.message);
  }
}

module.exports = { acquireLock, releaseLock, lockMiddleware, normalizeFrom, cleanupExpiredLocks };
