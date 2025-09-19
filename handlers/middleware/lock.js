// middleware/lock.js
const { Pool } = require('pg');

// Optional PG pool (we'll fall back to soft locks if unavailable)
let pool = null;

if (process.env.DATABASE_URL) {
  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 2,
    });
  } catch (e) {
    console.warn('[LOCK] PG pool init failed, will use soft locks only:', e.message);
    pool = null;
  }
}

// Best-effort soft locks (per serverless instance)
const softLocks = new Map();

function digitsOnlyPhone(req) {
  const from =
    req.from ||
    String(req.body?.From || '')
      .replace(/^whatsapp:/i, '')
      .replace(/\D/g, '');
  return from || 'unknown';
}

// Use 2×INT advisory locks derived from md5(lockKey) to avoid hashtext() dependency
async function pgAcquire(lockKey) {
  if (!pool) return { ok: false, reason: 'no-pool' };
  try {
    const sql = `
      SELECT pg_try_advisory_lock(
        ('x' || substr(md5($1), 1, 8))::bit(32)::int,
        ('x' || substr(md5($1), 9, 8))::bit(32)::int
      ) AS ok
    `;
    const { rows } = await pool.query(sql, [lockKey]);
    return { ok: !!rows?.[0]?.ok };
  } catch (e) {
    console.warn('[LOCK] PG acquire failed for', lockKey, ':', e.message);
    return { ok: false, reason: e.message };
  }
}

async function pgRelease(lockKey) {
  if (!pool) return false;
  try {
    const sql = `
      SELECT pg_advisory_unlock(
        ('x' || substr(md5($1), 1, 8))::bit(32)::int,
        ('x' || substr(md5($1), 9, 8))::bit(32)::int
      ) AS ok
    `;
    const { rows } = await pool.query(sql, [lockKey]);
    return !!rows?.[0]?.ok;
  } catch (e) {
    console.warn('[LOCK] PG release failed for', lockKey, ':', e.message);
    return false;
  }
}

function softAcquire(lockKey) {
  if (softLocks.has(lockKey)) return null; // busy
  const token = Date.now() + ':' + Math.random().toString(36).slice(2);
  softLocks.set(lockKey, token);
  return token;
}

function softRelease(lockKey, token) {
  if (softLocks.get(lockKey) === token) {
    softLocks.delete(lockKey);
    return true;
  }
  return false;
}

/**
 * lockMiddleware
 * Tries PG advisory lock with a stable key. If user/tenant is unknown or PG
 * isn’t available, falls back to a soft in-memory lock.
 */
async function lockMiddleware(req, res, next) {
  try {
    // Prefer an owner/user id if profile middleware set it, else phone fallback
    const phone = digitsOnlyPhone(req);
    const ownerId =
      req.ownerId || req.userProfile?.owner_id || req.userProfile?.user_id || phone;

    if (!ownerId || ownerId === 'unknown') {
      console.error('[LOCK] No valid ownerId or phone found for locking');
      res
        .status(400)
        .send('<Response><Message>Invalid request: User not found. Please start onboarding.</Message></Response>');
      return;
    }

    // Single, consistent key shape
    const lockKey = `lock:${ownerId}`;
    req.lockKey = lockKey;

    // Try PG advisory lock first (best for duplicate webhook attempts)
    const got = await pgAcquire(lockKey);
    if (got.ok) {
      req.lockToken = 'pg';
      console.log('[LOCK] Acquired DB lock for', lockKey);
      return next();
    }

    // Soft lock fallback (per instance)
    const soft = softAcquire(lockKey);
    if (!soft) {
      // Already in-flight on this instance; respond 409 to hint retry
      console.warn('[LOCK] Soft lock busy for', lockKey);
      res.status(409).send('<Response><Message>Busy. Please retry shortly.</Message></Response>');
      return;
    }

    req.lockToken = soft;
    console.log('[LOCK] (soft) acquired for', lockKey);
    return next();
  } catch (err) {
    console.error('[LOCK] Unexpected failure:', err.message);
    res.status(500).send('<Response><Message>Internal error. Please try again.</Message></Response>');
    return;
  }
}

async function releaseLock(lockKey, lockToken) {
  if (!lockKey || !lockToken) return;

  try {
    if (lockToken === 'pg') {
      const ok = await pgRelease(lockKey);
      console.log(ok ? '[LOCK] Released DB lock for' : '[LOCK] DB unlock no-op for', lockKey);
      return;
    }
  } catch (e) {
    console.warn('[LOCK] DB release failed for', lockKey, e.message);
  }

  // Otherwise, try soft release
  const okSoft = softRelease(lockKey, lockToken);
  if (okSoft) {
    console.log('[LOCK] Released soft lock for', lockKey);
  } else {
    console.log('[LOCK] Soft unlock no-op for', lockKey);
  }
}

module.exports = {
  lockMiddleware,
  releaseLock,
};
