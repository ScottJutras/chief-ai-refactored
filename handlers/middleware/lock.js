// middleware/lock.js
const { Pool } = require('pg');

// ---------- helpers ----------
function digitsOnlyPhone(req) {
  const from =
    req.from ||
    String(req.body?.From || '')
      .replace(/^whatsapp:/i, '')
      .replace(/\D/g, '');
  return from || 'unknown';
}

function isPgShutdown(err) {
  const code = err?.code || '';
  const msg = String(err?.message || '');
  // Common termination/transport codes
  return (
    code === '57P01' || // admin_shutdown
    code === '57P02' || // crash_shutdown
    code === '57P03' || // cannot_connect_now
    code === '08006' || // connection_failure
    /db_termination|terminated unexpectedly|connection terminated/i.test(msg)
  );
}

// ---------- pool (lazy) ----------
let pool = null;

async function initPool() {
  if (!process.env.DATABASE_URL) return null;
  if (pool) return pool;
  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 2,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 10_000,
      allowExitOnIdle: true, // ok on serverless
    });

    // Prevent idle client errors from crashing the process
    pool.on('error', (err) => {
      if (isPgShutdown(err)) {
        console.warn('[LOCK] PG idle client error (shutdown):', err.message);
      } else {
        console.warn('[LOCK] PG idle client error:', err.message);
      }
      // Tear down so we can lazily re-init on next request
      try { pool.end().catch(() => {}); } catch {}
      pool = null;
    });

    // Sanity check connectivity
    await pool.query('SELECT 1');
    console.log('[LOCK] PG pool ready');
    return pool;
  } catch (e) {
    console.warn('[LOCK] PG init failed, using soft locks:', e.message);
    try { if (pool) await pool.end().catch(() => {}); } catch {}
    pool = null;
    return null;
  }
}

// ---------- advisory lock (md5 -> 2 ints) ----------
async function pgAcquire(lockKey) {
  const p = await initPool();
  if (!p) return { ok: false, reason: 'no-pool' };
  try {
    const sql = `
      SELECT pg_try_advisory_lock(
        ('x' || substr(md5($1), 1, 8))::bit(32)::int,
        ('x' || substr(md5($1), 9, 8))::bit(32)::int
      ) AS ok
    `;
    const { rows } = await p.query(sql, [lockKey]);
    return { ok: !!rows?.[0]?.ok };
  } catch (e) {
    if (isPgShutdown(e)) {
      console.warn('[LOCK] PG acquire shutdown for', lockKey, ':', e.message);
      try { await p.end().catch(() => {}); } catch {}
      pool = null;
    } else {
      console.warn('[LOCK] PG acquire failed for', lockKey, ':', e.message);
    }
    return { ok: false, reason: e.message };
  }
}

async function pgRelease(lockKey) {
  const p = await initPool();
  if (!p) return false;
  try {
    const sql = `
      SELECT pg_advisory_unlock(
        ('x' || substr(md5($1), 1, 8))::bit(32)::int,
        ('x' || substr(md5($1), 9, 8))::bit(32)::int
      ) AS ok
    `;
    const { rows } = await p.query(sql, [lockKey]);
    return !!rows?.[0]?.ok;
  } catch (e) {
    if (isPgShutdown(e)) {
      console.warn('[LOCK] PG release shutdown for', lockKey, ':', e.message);
      try { await p.end().catch(() => {}); } catch {}
      pool = null;
    } else {
      console.warn('[LOCK] PG release failed for', lockKey, ':', e.message);
    }
    return false;
  }
}

// ---------- soft lock fallback (per instance) ----------
const softLocks = new Map();

function softAcquire(key) {
  if (softLocks.has(key)) return null;
  const token = Date.now() + ':' + Math.random().toString(36).slice(2);
  softLocks.set(key, token);
  return token;
}

function softRelease(key, token) {
  if (softLocks.get(key) === token) {
    softLocks.delete(key);
    return true;
  }
  return false;
}

// ---------- middleware ----------
async function lockMiddleware(req, res, next) {
  try {
    const phone = digitsOnlyPhone(req);
    const ownerId =
      req.ownerId || req.userProfile?.owner_id || req.userProfile?.user_id || phone;

    if (!ownerId || ownerId === 'unknown') {
      console.error('[LOCK] No valid ownerId/phone for locking');
      res
        .status(400)
        .send('<Response><Message>Invalid request: user not found. Please start onboarding.</Message></Response>');
      return;
    }

    const lockKey = `lock:${ownerId}`;
    req.lockKey = lockKey;

    // Try PG lock first
    const got = await pgAcquire(lockKey);
    if (got.ok) {
      req.lockToken = 'pg';
      console.log('[LOCK] Acquired DB lock for', lockKey);
      return next();
    }

    // Soft-lock fallback
    const soft = softAcquire(lockKey);
    if (!soft) {
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

  const okSoft = softRelease(lockKey, lockToken);
  if (okSoft) console.log('[LOCK] Released soft lock for', lockKey);
  else console.log('[LOCK] Soft unlock no-op for', lockKey);
}

module.exports = { lockMiddleware, releaseLock };
