// services/owners.js
// Helper to map a WhatsApp phone number to an owner UUID (or fallback to digits)
// Adds:
//  - 10-min in-memory TTL cache (best effort)
//  - avoids creating provisional profiles when DB is degraded
//  - short deadline guards

const { DIGITS, getUserProfile, createUserProfile } = require('./postgres');

/* ---------------- Small utilities ---------------- */

function nowMs() {
  return Date.now();
}

function isTransientDbError(e) {
  const msg = String(e?.message || '');
  const code = String(e?.code || '');
  const status = String(e?.status || '');

  // Common network / pooler / serverless symptoms
  if (
    /timeout|timed out|ETIMEDOUT|ECONNRESET|EPIPE|ENOTFOUND|socket hang up/i.test(msg) ||
    /Connection terminated|server closed the connection|closed unexpectedly/i.test(msg) ||
    /read ECONNRESET/i.test(msg) ||
    /fetch failed|unexpected response/i.test(msg)
  ) return true;

  // Supabase / Postgres pooler pressure patterns
  if (
    /too many clients already|remaining connection slots are reserved/i.test(msg) ||
    /sorry, too many clients|connection limit exceeded/i.test(msg) ||
    /canceling statement due to statement timeout/i.test(msg)
  ) return true;

  // Postgres transient-ish class codes (when present)
  // 57P01 admin shutdown, 57P02 crash shutdown, 57P03 cannot connect now,
  // 53300 too many connections, 53400 config limit exceeded,
  // 0800x connection exceptions
  if (/(57P01|57P02|57P03|53300|53400|08006|08003|08001|08004)/.test(code)) return true;

  // If an upstream wrapper ever attaches HTTP status
  if (/^5\d\d$/.test(status)) return true;

  return false;
}


function withDeadline(promise, ms, label = 'deadline') {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms))
  ]);
}

/* ---------------- TTL cache (best-effort) ---------------- */

// key: digits phone, value: { v, exp }
const OWNER_UUID_CACHE = new Map();
const OWNER_UUID_TTL_MS = parseInt(process.env.OWNER_UUID_CACHE_TTL_MS || '600000', 10); // 10 min
const OWNER_UUID_CACHE_MAX = parseInt(process.env.OWNER_UUID_CACHE_MAX || '2000', 10);

function cacheGet(map, key) {
  const e = map.get(key);
  if (!e) return null;
  if (e.exp && e.exp < nowMs()) {
    map.delete(key);
    return null;
  }
  return e.v ?? null;
}

function cacheSet(map, key, value, ttlMs) {
  // soft cap: simple eviction of oldest-ish by deleting first iterator key
  if (map.size >= OWNER_UUID_CACHE_MAX) {
    const firstKey = map.keys().next().value;
    if (firstKey) map.delete(firstKey);
  }
  map.set(key, { v: value, exp: nowMs() + Math.max(1, ttlMs || OWNER_UUID_TTL_MS) });
}

/**
 * Given a phone number (string, e.g. "whatsapp:+1 905-327-9955"),
 * return an owner_id (UUID or legacy digits).
 *
 * Key safety rules:
 * - If DB read fails transiently, DO NOT create provisional profiles.
 * - Cache positive results for 10 minutes (best-effort).
 */
async function getOwnerUuidForPhone(rawPhone) {
  const userId = DIGITS(rawPhone);
  if (!userId) return null;

  // 0) Cache hit
  const cached = cacheGet(OWNER_UUID_CACHE, userId);
  if (cached) return cached;

  // 1) Try existing profile (deadline guarded)
  let profile = null;
  try {
    profile = await withDeadline(getUserProfile(userId), 2500, 'getUserProfile_timeout');
  } catch (e) {
    // If DB is degraded, bubble error so caller safeDb() can mark dbDegraded
    if (isTransientDbError(e) || String(e?.message || '').includes('getUserProfile_timeout')) {
      throw e;
    }
    // Non-transient: still bubble (better to see bug than silently create wrong profile)
    throw e;
  }

  // If we already have an owner_id, use it
  if (profile && profile.owner_id) {
    cacheSet(OWNER_UUID_CACHE, userId, profile.owner_id);
    return profile.owner_id;
  }

  // 2) No profile or no owner_id → create provisional one
  // BUT: only do this when DB is healthy (we got here after a successful read)
  try {
    profile = await withDeadline(
      createUserProfile({
        user_id: userId,
        ownerId: userId,              // owner = self for now
        onboarding_in_progress: true, // onboarding flow can pick up
      }),
      2500,
      'createUserProfile_timeout'
    );
  } catch (e) {
    // If DB degraded here, do NOT pretend onboarding changed—just fall back to digits
    console.warn('[owners] createUserProfile failed:', e?.message);
    return userId;
  }

  const out = profile?.owner_id || userId;
  cacheSet(OWNER_UUID_CACHE, userId, out);
  return out;
}

module.exports = {
  getOwnerUuidForPhone,
};
