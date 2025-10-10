// utils/lockManager.js
// DB-backed lock utilities that match your public.locks schema.
// Columns: lock_key (UNIQUE), holder (text), expires_at (timestamptz), created_at, updated_at

const { query } = require('../services/postgres');

const DEFAULT_TTL_SEC = parseInt(process.env.LOCK_TTL_SEC || '10', 10); // 10s

function normalizePhoneNumber(userId = '') {
  const val = String(userId || '');
  const noWa = val.startsWith('whatsapp:') ? val.slice('whatsapp:'.length) : val;
  return noWa.replace(/^\+/, '').replace(/\D/g, '').trim();
}

function tsPlusSeconds(sec) {
  return new Date(Date.now() + Number(sec || 0) * 1000);
}

/**
 * Acquire (or re-acquire) a lock for a given user:
 * - If no row, insert (lock taken)
 * - If expired, take over
 * - If same holder, refresh/extend
 *
 * Returns true if *this* caller now holds the lock.
 */
async function acquireLock(userId, token, ttlSec = DEFAULT_TTL_SEC) {
  const normalizedId = normalizePhoneNumber(userId);
  if (!normalizedId) return true; // no-op if no user id

  const lockKey = `lock:${normalizedId}`;
  const expiresAt = tsPlusSeconds(ttlSec);

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
  const params = [lockKey, normalizedId, expiresAt];
  const res = await query(sql, params);
  return res.rowCount === 1 && res.rows[0]?.holder === normalizedId;
}

/**
 * Optionally refresh/extend an existing lock you own.
 * Returns true if extended; false if you don’t currently own it.
 */
async function refreshLock(userId, ttlSec = DEFAULT_TTL_SEC) {
  const normalizedId = normalizePhoneNumber(userId);
  if (!normalizedId) return false;

  const lockKey = `lock:${normalizedId}`;
  const expiresAt = tsPlusSeconds(ttlSec);

  const sql = `
    UPDATE public.locks
       SET expires_at = $3, updated_at = NOW()
     WHERE lock_key = $1
       AND holder   = $2
    RETURNING lock_key
  `;
  const params = [lockKey, normalizedId, expiresAt];
  const res = await query(sql, params);
  return res.rowCount === 1;
}

/**
 * Release the lock (best-effort).
 * If you want strict ownership checks, add holder = $2 to the WHERE clause.
 */
async function releaseLock(userId) {
  const normalizedId = normalizePhoneNumber(userId);
  if (!normalizedId) return true;

  const lockKey = `lock:${normalizedId}`;
  await query(`DELETE FROM public.locks WHERE lock_key = $1`, [lockKey]);
  return true;
}

module.exports = {
  acquireLock,
  refreshLock,
  releaseLock,
  normalizePhoneNumber,
};
