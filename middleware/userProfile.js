// middleware/userProfile.js (DROP-IN)
// Canonical identity resolution via tenant actor mapping (secure).
// Falls back to legacy public.users only if resolver has no row.
//
// Adds:
// - req.dbDegraded (boolean): true if DB was unavailable / timed out.
// - short cache (positive mapping) to survive transient DB outages.
//
// Sets:
// - req.from (digits)
// - req.tenantId (uuid)
// - req.ownerId (digits string, legacy compatibility)
// - req.isOwner (role === 'owner')
// - req.userProfile (shaped minimal profile)
// - req.ownerProfile (shaped minimal owner profile)
// - req.tz (tenant tz)

const pg = require('../services/postgres');
const { getEffectivePlanKey } = require("../src/config/getEffectivePlanKey");
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

// ---- Resolver query (actor identity system) ----
async function resolveActorIdentity({ kind, identifier }, markDegraded) {
  const k = String(kind || "").trim().toLowerCase();
  const raw = String(identifier || "").trim();

  // For whatsapp: normalize to digits, but also try common stored variants
  const digits = raw.replace(/\D/g, "");
  const candidates =
    k === "whatsapp"
      ? Array.from(
          new Set([
            digits,
            raw,
            raw.startsWith("whatsapp:") ? raw : `whatsapp:${raw}`,
            raw.startsWith("whatsapp:+") ? raw : `whatsapp:+${digits}`,
            raw.startsWith("+") ? raw : `+${digits}`,
          ].filter(Boolean))
        )
      : [raw.toLowerCase()];

  try {
    // IMPORTANT: select actor_id explicitly
    const { rows } = await pg.query(
      `
      select
        kind,
        identifier,
        tenant_id,
        role,
        owner_phone_digits,
        tz,
        actor_id
      from public.v_actor_identity_resolver
      where kind = $1
        and identifier = any($2::text[])
      order by updated_at desc nulls last
      limit 1
      `,
      [k, candidates]
    );

    return rows?.[0] || null;
  } catch (e) {
    if (markDegraded) markDegraded();
    throw e;
  }
}

async function resolveOwnerPlan(ownerDigits, markDegraded) {
  const owner = normalizeDigits(ownerDigits);
  if (!owner) return { plan: "free", plan_key: null, sub_status: null };

  const r = await safeQuery(
    `select plan_key, sub_status
       from public.users
      where user_id = $1
      limit 1`,
    [owner],
    markDegraded
  );

  const row = r?.rows?.[0] || null;

  return {
    plan: getEffectivePlanKey(row),
    plan_key: row?.plan_key ?? null,
    sub_status: row?.sub_status ?? null
  };
}

// ---- Legacy fallback (public.users) ----
async function resolveLegacyUser(fromDigits, markDegraded) {
  // Prefer helper if present
  try {
    if (typeof pg.getUserProfile === 'function') {
      const u = await pg.getUserProfile(fromDigits);
      return u || null;
    }
  } catch (e) {
    if (isTransientDbError(e)) markDegraded();
    // fall through to direct SQL
  }

  const r = await safeQuery(
    `select user_id, owner_id, role, plan_key, sub_status, timezone
       from public.users
      where user_id = $1
      limit 1`,
    [fromDigits],
    markDegraded
  );
  return r?.rows?.[0] || null;
}

async function userProfileMiddleware(req, _res, next) {
  const markDegraded = () => {
    req.dbDegraded = true;
  };

  try {
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

    // new flag
    req.dbDegraded = false;

    if (!from) {
      // allow internal/system calls to pass through without From
      req.ownerId = req.ownerId || "GLOBAL";
      return next();
    }

    // -----------------------------
    // 0) Cache fast path
    // ONLY accept cache-hit if it includes actorId
    // -----------------------------
    const cached = cacheGet(from);

    const hasCore = !!(cached?.tenantId && cached?.ownerId);
    const hasActor = !!cached?.actorId;

    if (hasCore && hasActor) {
      req.tenantId = cached.tenantId;
      req.ownerId = cached.ownerId;
      req.isOwner = !!cached.isOwner;
      req.tz = cached.tz || DEFAULT_TZ;
      req.actorId = cached.actorId || null;

      const plan = String(cached.plan || "free").trim().toLowerCase();
      const plan_key = cached?.plan_key ?? null;
      const sub_status = cached?.sub_status ?? null;

      // ✅ Debug: confirms what plan we are using on warm/cache path
      try {
        console.info("[PLAN_RESOLVE][userProfile][cache]", {
          from,
          ownerId: req.ownerId,
          tenantId: req.tenantId,
          role: cached.role || null,
          resolvedPlan: plan,
          plan_key,
          sub_status,
          note: "plan comes from identityCache; stored onto req.userProfile.plan / req.ownerProfile.plan",
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

      // ✅ Attach raw plan truth for downstream gating/debugging
      req.ownerProfile.plan_key = plan_key;
      req.ownerProfile.sub_status = sub_status;

      return next();
    }

    // ✅ Cache entry exists but is missing actorId (old cache schema)
    // Treat as miss so resolver runs and re-caches correctly.
    if (hasCore && !hasActor) {
      try {
        console.info("[userProfile] cache hit missing actorId → bypassing cache", {
          from,
          tenantId: cached?.tenantId || null,
          ownerId: cached?.ownerId || null,
        });
      } catch {}
    }

    // -----------------------------
    // 1) Canonical resolver (whatsapp identity -> tenant + role + actorId)
    // -----------------------------
    let resolved = null;
    try {
      resolved = await resolveActorIdentity({ kind: "whatsapp", identifier: from }, markDegraded);
    } catch (e) {
      console.warn("[userProfile] actor identity resolver failed:", e?.message);
      // If transient, we marked dbDegraded; continue to legacy paths.
      resolved = null;
    }

    if (resolved?.tenant_id) {
      req.tenantId = resolved.tenant_id;
      req.ownerId = normalizeDigits(resolved.owner_phone_digits) || from; // legacy compat
      req.isOwner = String(resolved.role || "").toLowerCase() === "owner";
      req.tz = pickTz(resolved) || DEFAULT_TZ;

      req.actorId =
        resolved.actor_id ||
        resolved.actorId ||
        resolved.actor ||
        null;

      // ✅ debug (remove once stable)
      try {
        console.info("[userProfile] resolver ctx", {
          from,
          tenantId: req.tenantId,
          ownerId: req.ownerId,
          actorId: req.actorId,
          role: resolved?.role || null,
        });
      } catch {}

      // Plan resolve (best-effort, fail-soft)
      let plan = "free";
      let plan_key = null;
      let sub_status = null;

      try {
        const out = await resolveOwnerPlan(req.ownerId, markDegraded);
        plan = String(out?.plan || "free").trim().toLowerCase();
        plan_key = out?.plan_key ?? null;
        sub_status = out?.sub_status ?? null;
      } catch (e) {
        console.warn("[userProfile] resolveOwnerPlan failed (default free):", e?.message);
        plan = "free";
        plan_key = null;
        sub_status = null;
      }

      req.userProfile = shapeMinimalProfile({
        from,
        ownerId: req.ownerId,
        role: resolved.role,
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

      // ✅ Cache positive mapping (now includes actorId)
      cacheSet(from, {
        tenantId: req.tenantId,
        ownerId: req.ownerId,
        actorId: req.actorId || null,
        isOwner: req.isOwner,
        tz: req.tz,
        role: resolved.role || null,
        plan,
        plan_key,
        sub_status,
      });

      return next();
    }

    // -----------------------------
    // 2) Legacy fallback (public.users / old systems)
    // -----------------------------
    let legacy = null;
    try {
      legacy = await resolveLegacyUser(from, markDegraded);
    } catch (e) {
      console.warn("[userProfile] legacy lookup failed:", e?.message);
      legacy = null;
    }

    if (legacy) {
      const ownerId = normalizeDigits(legacy.owner_id) || from;
      const role = legacy.role || (String(legacy.user_id) === String(ownerId) ? "owner" : "employee");
      const tz = legacy.timezone || DEFAULT_TZ;
      const plan = String(getEffectivePlanKey(legacy) || "free").trim().toLowerCase();

      req.ownerId = ownerId;
      req.isOwner = String(role).toLowerCase() === "owner";
      req.tz = tz;

      req.userProfile = shapeMinimalProfile({ from, ownerId, role, tz, plan });
      req.ownerProfile = shapeMinimalProfile({ from: ownerId, ownerId, role: "owner", tz, plan });

      // ✅ Attach raw plan truth if present on legacy row
      req.ownerProfile.plan_key = legacy?.plan_key ?? null;
      req.ownerProfile.sub_status = legacy?.sub_status ?? null;

      // ✅ Cache positive mapping (legacy has no actorId)
      cacheSet(from, {
        tenantId: null,
        ownerId,
        actorId: null,
        isOwner: req.isOwner,
        tz: req.tz,
        role,
        plan,
        plan_key: legacy?.plan_key ?? null,
        sub_status: legacy?.sub_status ?? null,
      });

      return next();
    }

    // -----------------------------
    // 3) Unknown identity (not linked)
    // -----------------------------
    req.ownerId = null;
    req.isOwner = false;
    req.userProfile = null;
    req.ownerProfile = null;
    req.tenantId = null;
    req.actorId = null;
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
