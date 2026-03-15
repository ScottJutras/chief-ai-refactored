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
async function getActiveTenantForPhone(phoneDigits, markDegraded) {
  const p = normalizeDigits(phoneDigits);
  if (!p) return null;

  const r = await safeQuery(
    `
    select tenant_id, actor_id
    from public.chiefos_phone_active_tenant
    where phone_digits = $1
    limit 1
    `,
    [p],
    markDegraded
  );

  return r?.rows?.[0] || null;
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
// Returns ALL candidates (multi-tenant safe). Caller decides.
async function resolveActorIdentities({ kind, identifier }, markDegraded) {
  const k = String(kind || "").trim().toLowerCase();
  const raw = String(identifier || "").trim();
  if (!k || !raw) return [];

  const digits = raw.replace(/\D/g, "");

  const candidates =
    k === "whatsapp"
      ? Array.from(
          new Set(
            [
              digits,
              "+" + digits,
              "whatsapp:+" + digits,
              "whatsapp:" + digits,
              raw
            ].filter(Boolean)
          )
        )
      : [raw.toLowerCase()];

  try {
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
      order by
        tenant_id asc,
        (actor_id is not null) desc
      `,
      [k, candidates]
    );

    return rows || [];
  } catch (e) {
    const msg = String(e?.message || "");
    const code = String(e?.code || "");
    const looksTransient =
      code === "57P01" ||
      code === "57P02" ||
      code === "53300" ||
      /timeout|ECONNRESET|ENETUNREACH|EAI_AGAIN|connection/i.test(msg);

    if (looksTransient && typeof markDegraded === "function") markDegraded();
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

async function loadTenantNames(tenantIds, markDegraded) {
  const ids = (tenantIds || []).map(String).filter(Boolean);
  if (!ids.length) return new Map();

  const r = await safeQuery(
    `
    select id::text as tenant_id,
           coalesce(nullif(business_name,''), nullif(name,''), 'Business') as tenant_name
      from public.chiefos_tenants
     where id = any($1::uuid[])
    `,
    [ids],
    markDegraded
  );

  const m = new Map();
  for (const row of (r?.rows || [])) {
    m.set(String(row.tenant_id), String(row.tenant_name || "Business"));
  }
  return m;
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
// MULTI-TENANT SAFE: may return multiple candidates
// -----------------------------
let resolvedRows = [];
try {
  resolvedRows = await resolveActorIdentities({ kind: "whatsapp", identifier: from }, markDegraded);
} catch (e) {
  console.warn("[userProfile] actor identity resolver failed:", e?.message);
  resolvedRows = [];
}

const candidates = (resolvedRows || []).filter(r => !!r?.tenant_id);
const uniqTenantIds = Array.from(new Set(candidates.map(r => String(r.tenant_id))));

if (uniqTenantIds.length > 1) {
  // Multi-tenant phone: require an active tenant selection or fail closed.
  let active = null;
  try {
    active = await getActiveTenantForPhone(from, markDegraded);
  } catch (e) {
    console.warn("[userProfile] getActiveTenantForPhone failed:", e?.message);
    active = null;
  }

  if (!active?.tenant_id) {
    // FAIL CLOSED: do not set tenant/actor.
    req.multiTenant = true;
    const names = await loadTenantNames(uniqTenantIds, markDegraded);

req.multiTenantChoices = uniqTenantIds.map((tid) => {
  const row = candidates.find((x) => String(x.tenant_id) === String(tid));
  return {
    tenant_id: tid,
    tenant_name: names.get(String(tid)) || null,
    owner_phone_digits: row?.owner_phone_digits || null,
    role: row?.role || null,
    tz: row?.tz || null,
    actor_id: row?.actor_id || null,
  };
});

    try {
      console.info("[userProfile] multi-tenant detected, no active tenant → selection required", {
        from,
        tenantCount: uniqTenantIds.length,
      });
    } catch {}

    // leave req.tenantId / req.actorId null
    return next();
  }

  // active tenant exists → pick matching candidate
  const chosen = candidates.find((x) => String(x.tenant_id) === String(active.tenant_id)) || null;
  if (!chosen) {
    // active tenant points to something no longer valid → fail closed
    req.multiTenant = true;
    req.multiTenantChoices = uniqTenantIds.map((tid) => ({ tenant_id: tid }));
    return next();
  }

  // proceed as normal with chosen
  req.tenantId = chosen.tenant_id;
  req.ownerId = normalizeDigits(chosen.owner_phone_digits) || from;
  req.isOwner = String(chosen.role || "").toLowerCase() === "owner";
  req.tz = pickTz(chosen) || DEFAULT_TZ;
  req.actorId = chosen.actor_id || null;

} else if (uniqTenantIds.length === 1) {
  // single tenant mapping
  const chosen = candidates[0];
  req.tenantId = chosen.tenant_id;
  req.ownerId = normalizeDigits(chosen.owner_phone_digits) || from;
  req.isOwner = String(chosen.role || "").toLowerCase() === "owner";
  req.tz = pickTz(chosen) || DEFAULT_TZ;
  req.actorId = chosen.actor_id || null;
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
  } catch (e) {
    console.warn("[userProfile] resolveOwnerPlan failed (default free):", e?.message);
    plan = "free";
  }

  req.userProfile = shapeMinimalProfile({
    from,
    ownerId: req.ownerId,
    role: req.isOwner ? "owner" : (candidates?.[0]?.role || null),
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
