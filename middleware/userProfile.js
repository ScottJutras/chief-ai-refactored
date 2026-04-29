// middleware/userProfile.js
// Direct-query identity resolution against rebuild schema (public.users PK).
//
// Sets:
// - req.from (digits)
// - req.tenantId (uuid)
// - req.ownerId (digits string)
// - req.isOwner (role === 'owner')
// - req.userProfile (shaped minimal profile)
// - req.ownerProfile (shaped minimal owner profile)
// - req.tz (tenant tz)
// - req.dbDegraded (boolean): true if DB was unavailable / timed out.
// - req.actorId (reserved, always null in rebuild — redesigned in R3)

const pg = require('../services/postgres');
const { getEffectivePlanKey } = require("../src/config/getEffectivePlanKey");
const { ensureCorrelationId } = require('../services/actorContext');
const DEFAULT_TZ = 'America/Toronto';


/* ------------------------ tiny in-memory cache ------------------------ */
/**
 * 5–10 min memory helps during provider hiccups.
 * Cache ONLY positive tenant mappings (never cache "unlinked").
 * Keyed by whatsapp digits (req.from).
 */
const IDENTITY_CACHE_TTL_MS = parseInt(process.env.IDENTITY_CACHE_TTL_MS || '600000', 10); // 10 min default
const identityCache = new Map(); // key -> { value, exp }

function cacheGet(key) {
  if (!key) return null;
  const hit = identityCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    identityCache.delete(key);
    return null;
  }
  return hit.value || null;
}

function cacheSet(key, value) {
  if (!key || !value) return;
  identityCache.set(key, { value, exp: Date.now() + IDENTITY_CACHE_TTL_MS });

  // simple cap to prevent unbounded growth in serverless warm instances
  const MAX = parseInt(process.env.IDENTITY_CACHE_MAX || '2000', 10);
  if (identityCache.size > MAX) {
    // delete oldest-ish by iterating (Map preserves insertion order)
    const firstKey = identityCache.keys().next().value;
    if (firstKey) identityCache.delete(firstKey);
  }
}

/* ------------------------ helpers ------------------------ */

function normalizeDigits(raw) {
  return (
    String(raw || '')
      .replace(/^whatsapp:/i, '')
      .replace(/^\+/, '')
      .replace(/\D/g, '')
      .trim() || null
  );
}

function pickTz(obj) {
  const tz = (obj && (obj.tz || obj.timezone || obj.time_zone)) || null;
  return tz ? String(tz).trim() : null;
}

function shapeMinimalProfile({ from, ownerId, role, tz, plan, plan_key, sub_status }) {
  const safeRole = role || null;
  const safePlan = (plan || 'free').toLowerCase();

  return {
    user_id: from,
    owner_id: ownerId,
    ownerId,
    role: safeRole,
    plan: safePlan,
    plan_key: plan_key ?? null,
    sub_status: sub_status ?? null,
    tz: tz || DEFAULT_TZ
  };
}

// Detect transient DB/provider issues that should set dbDegraded=true
function isTransientDbError(e) {
  const msg = String(e?.message || '');
  const code = String(e?.code || '');
  const status = String(e?.status || '');

  // Supabase / network / pooler / timeouts
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|EPIPE|ENOTFOUND|socket hang up|Connection terminated|server closed the connection/i.test(msg)) return true;

  // Postgres transient codes / conditions (best-effort)
  if (/(57P01|57P02|57P03|53300|53400|08006|08003|08001|08004)/.test(code)) return true;

  // HTTP-ish 5xx may appear in some wrappers/logs
  if (/^5\d\d$/.test(status)) return true;

  // Supabase incident patterns often bubble as 500-ish or "internal server error"
  if (/internal server error|unexpected response|fetch failed/i.test(msg)) return true;

  return false;
}
// A safe query wrapper that can signal dbDegraded without changing pg.js
async function safeQuery(sql, params, markDegraded) {
  try {
    return await pg.query(sql, params);
  } catch (e) {
    if (isTransientDbError(e)) {
      markDegraded();
    }
    throw e;
  }
}

/* ------------------------ resolver queries ------------------------ */

// Direct-query identity resolver against the rebuild schema.
// public.users.user_id is the phone-digit PK; one phone → one tenant by PK
// uniqueness (see migrations/2026_04_21_rebuild_identity_tenancy.sql §2).
// Returns the tenant row for this phone, or null if unknown.
async function resolveWhatsAppIdentity(phoneDigits, markDegraded) {
  const p = normalizeDigits(phoneDigits);
  if (!p) return null;

  const r = await safeQuery(
    `
    select
      u.user_id,
      u.owner_id,
      u.tenant_id,
      u.role,
      u.plan_key,
      u.sub_status,
      coalesce(u.tz, t.tz) as tz
    from public.users u
    join public.chiefos_tenants t on t.id = u.tenant_id
    where u.user_id = $1
    limit 1
    `,
    [p],
    markDegraded
  );

  return r?.rows?.[0] || null;
}

async function resolveOwnerPlan(ownerDigits, markDegraded) {
  const owner = normalizeDigits(ownerDigits);

  if (!owner) {
    return {
      plan: "free",
      plan_key: null,
      sub_status: null,
      reason: "missing_owner_id",
    };
  }

  const r = await safeQuery(
    `
    select owner_id, user_id, plan_key, sub_status, created_at
    from public.users
    where owner_id = $1
    order by created_at desc nulls last
    limit 1
    `,
    [owner],
    markDegraded
  );

  const row = r?.rows?.[0] || null;

  return {
    plan: getEffectivePlanKey(row),
    plan_key: row?.plan_key ?? null,
    sub_status: row?.sub_status ?? null,
    reason: row ? "users.owner_id" : "free_fallback",
  };
}

async function userProfileMiddleware(req, _res, next) {
  const markDegraded = () => {
    req.dbDegraded = true;
  };

  try {
    // R3a: ensure correlation_id is threaded per §17.21. Idempotent across
    // middleware layers; safe if requirePortalUser also called it for the
    // same request.
    ensureCorrelationId(req);

    const from = normalizeDigits(req.body?.From || req.from);
    req.from = from;

    // -----------------------------
    // default safe values
    // -----------------------------
    req.tz = DEFAULT_TZ;
    req.isOwner = false;
    req.tenantId = null;
    req.ownerId = req.ownerId || null;
    req.userProfile = null;
    req.ownerProfile = null;
    req.actorId = null;
    req.actorRole = null;

    // new flag
    req.dbDegraded = false;

    if (!from) {
      // allow internal/system calls to pass through without From
      req.ownerId = req.ownerId || "GLOBAL";
      return next();
    }

    // -----------------------------
    // 0) Cache fast path — accept any positive mapping.
    // -----------------------------
    const cached = cacheGet(from);

    if (cached?.tenantId && cached?.ownerId) {
      req.tenantId = cached.tenantId;
      req.ownerId = cached.ownerId;
      req.isOwner = !!cached.isOwner;
      req.tz = cached.tz || DEFAULT_TZ;
      req.actorId = cached.actorId || null;
      req.actorRole = cached.actorRole || null;
      req.multiTenant = false;
      req.multiTenantChoices = [];

      const plan = String(cached.plan || "free").trim().toLowerCase();
      const plan_key = cached?.plan_key ?? null;
      const sub_status = cached?.sub_status ?? null;

      try {
        console.info("[PLAN_RESOLVE][userProfile][cache]", {
          from,
          ownerId: req.ownerId,
          tenantId: req.tenantId,
          role: cached.role || null,
          resolvedPlan: plan,
          plan_key,
          sub_status,
        });
      } catch {}

      req.userProfile = shapeMinimalProfile({
        from,
        ownerId: req.ownerId,
        role: cached.role || (req.isOwner ? "owner" : null),
        tz: req.tz,
        plan,
      });

      req.ownerProfile = shapeMinimalProfile({
        from: req.ownerId,
        ownerId: req.ownerId,
        role: "owner",
        tz: req.tz,
        plan,
      });

      req.ownerProfile.plan_key = plan_key;
      req.ownerProfile.sub_status = sub_status;

      return next();
    }

    // -----------------------------
    // 1) Canonical resolver (phone digits -> users row -> tenant)
    // Rebuild schema enforces one-phone-one-tenant via users.user_id PK.
    // Multi-tenant phone is architecturally impossible here.
    // -----------------------------
    req.multiTenant = false;
    req.multiTenantChoices = [];

    let chosen = null;
    try {
      chosen = await resolveWhatsAppIdentity(from, markDegraded);
    } catch (e) {
      console.warn("[userProfile] resolveWhatsAppIdentity failed:", e?.message);
      chosen = null;
    }

    if (chosen?.tenant_id) {
      req.tenantId = String(chosen.tenant_id);
      req.ownerId = normalizeDigits(chosen.owner_id) || from;
      req.isOwner = String(chosen.role || "").toLowerCase() === "owner";
      req.tz = pickTz(chosen) || DEFAULT_TZ;
      // R3: actor = public.users.user_id (phone-digit PK). chosen.user_id
      // already came from the direct-query resolver; fall back to `from` if
      // the column somehow isn't present.
      req.actorId = String(chosen.user_id || from);
      req.actorRole = chosen.role || null;

      try {
        console.info("[userProfile] whatsapp identity resolved", {
          from,
          tenantId: req.tenantId,
          ownerId: req.ownerId,
          actorId: req.actorId,
          role: chosen.role || null,
          source: "users_direct",
        });
      } catch {}
    }

if (req.tenantId) {
  // Plan resolve (best-effort, fail-soft)
  let plan = "free";
  let plan_key = null;
  let sub_status = null;

      try {
    const out = await resolveOwnerPlan(req.ownerId, markDegraded);
    plan = String(out?.plan || "free").trim().toLowerCase();
    plan_key = out?.plan_key ?? null;
    sub_status = out?.sub_status ?? null;

    try {
      console.info("[PLAN_RESOLUTION][whatsapp]", {
        from,
        resolvedOwnerId: req.ownerId || null,
        resolvedTenantId: req.tenantId || null,
        actorId: req.actorId || null,
        plan,
        plan_key,
        sub_status,
        source: out?.reason || "unknown",
        dbDegraded: !!req.dbDegraded,
      });
    } catch {}
  } catch (e) {
    console.warn("[userProfile] resolveOwnerPlan failed (default free):", e?.message);
    plan = "free";
  }

  req.userProfile = shapeMinimalProfile({
    from,
    ownerId: req.ownerId,
    role: req.isOwner ? "owner" : (chosen?.role || null),
    tz: req.tz,
    plan,
  });

  req.ownerProfile = shapeMinimalProfile({
    from: req.ownerId,
    ownerId: req.ownerId,
    role: "owner",
    tz: req.tz,
    plan,
  });

  req.ownerProfile.plan_key = plan_key;
  req.ownerProfile.sub_status = sub_status;

  cacheSet(from, {
    tenantId: req.tenantId,
    ownerId: req.ownerId,
    actorId: req.actorId || null,
    actorRole: req.actorRole || null,
    isOwner: req.isOwner,
    tz: req.tz,
    role: req.userProfile.role || null,
    plan,
    plan_key,
    sub_status,
  });

  return next();
}

    // -----------------------------
    // 2) Unknown identity (not linked)
    // -----------------------------
    req.ownerId = null;
    req.isOwner = false;
    req.userProfile = null;
    req.ownerProfile = null;
    req.tenantId = null;
    req.actorId = null;
    req.actorRole = null;
    req.tz = DEFAULT_TZ;

    return next();
  } catch (e) {
    console.warn("[userProfile] failed:", e?.message);
    if (isTransientDbError(e)) req.dbDegraded = true;
    req.tz = req.tz || DEFAULT_TZ;
    return next();
  }
}

module.exports = { userProfileMiddleware };
