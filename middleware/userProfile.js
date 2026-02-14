// middleware/userProfile.js (DROP-IN)
// Canonical identity resolution via tenant actor mapping (secure).
// Falls back to legacy public.users only if resolver has no row.
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

function shapeMinimalProfile({ from, ownerId, role, tz, plan }) {
  const safeRole = role || null;
  const safePlan = (plan || 'free').toLowerCase();

  return {
    user_id: from,
    owner_id: ownerId,
    ownerId,
    role: safeRole,
    plan: safePlan,
    subscription_tier: safePlan,
    tz: tz || DEFAULT_TZ
  };
}

// ---- Resolver query (actor identity system) ----
async function resolveActorIdentity({ kind, identifier }) {
  try {
    const r = await pg.query(
      `
      select
        tenant_id,
        role,
        owner_phone_digits,
        tz
      from public.v_actor_identity_resolver
      where kind = $1 and identifier = $2
      limit 1
      `,
      [String(kind), String(identifier)]
    );
    return r?.rows?.[0] || null;
  } catch (e) {
    console.warn('[userProfile] actor identity resolver failed:', e?.message);
    return null;
  }
}
async function resolveOwnerPlan(ownerDigits) {
  const owner = normalizeDigits(ownerDigits);
  if (!owner) return "free";

  try {
    const r = await pg.query(
      `select plan_key, sub_status
         from public.users
        where user_id = $1
        limit 1`,
      [owner]
    );

    const row = r?.rows?.[0] || null;
    return getEffectivePlanKey(row);
  } catch (e) {
    console.warn("[userProfile] resolveOwnerPlan failed (default free):", e?.message);
    return "free";
  }
}

// ---- Legacy fallback (public.users) ----
async function resolveLegacyUser(fromDigits) {
  try {
    if (typeof pg.getUserProfile === 'function') {
      const u = await pg.getUserProfile(fromDigits);
      return u || null;
    }
  } catch (e) {
    console.warn('[userProfile] legacy getUserProfile failed:', e?.message);
  }

  // Direct SQL fallback if helper missing
  try {
    const r = await pg.query(
  `select user_id, owner_id, role, plan_key, sub_status, timezone
     from public.users
    where user_id = $1
    limit 1`,
  [fromDigits]
);
    return r?.rows?.[0] || null;
  } catch {
    return null;
  }
}

async function userProfileMiddleware(req, _res, next) {
  try {
    const from = normalizeDigits(req.body?.From || req.from);
    req.from = from;

    // default safe values
    req.tz = DEFAULT_TZ;
    req.isOwner = false;
    req.tenantId = null;

    if (!from) {
      req.userProfile = null;
      req.ownerProfile = null;
      req.ownerId = req.ownerId || 'GLOBAL';
      return next();
    }

    // 1) Try canonical resolver first (whatsapp identity -> tenant + role)
    const resolved = await resolveActorIdentity({ kind: 'whatsapp', identifier: from });

    if (resolved?.tenant_id) {
  req.tenantId = resolved.tenant_id;
  req.ownerId = normalizeDigits(resolved.owner_phone_digits) || from; // legacy compat
  req.isOwner = String(resolved.role || '').toLowerCase() === 'owner';
  req.tz = pickTz(resolved) || DEFAULT_TZ;

  // ✅ resolve the tenant's paid plan from the OWNER record (public.users)
  const plan = await resolveOwnerPlan(req.ownerId);
console.info('[PLAN_RESOLVED]', { ownerId: req.ownerId, plan });


  req.userProfile = shapeMinimalProfile({
    from,
    ownerId: req.ownerId,
    role: resolved.role,
    tz: req.tz,
    plan
  });

  req.ownerProfile = shapeMinimalProfile({
    from: req.ownerId,
    ownerId: req.ownerId,
    role: 'owner',
    tz: req.tz,
    plan
  });

  return next();
}


    // 2) Fallback: legacy public.users path (temporary)
    const legacy = await resolveLegacyUser(from);

    if (legacy) {
      const ownerId = normalizeDigits(legacy.owner_id) || from;
      const role = legacy.role || (String(legacy.user_id) === String(ownerId) ? 'owner' : 'employee');
      const tz = legacy.timezone || DEFAULT_TZ;
      const plan = getEffectivePlanKey(legacy);


      req.ownerId = ownerId;
      req.isOwner = String(role).toLowerCase() === 'owner';
      req.tz = tz;

      req.userProfile = shapeMinimalProfile({ from, ownerId, role, tz, plan });
      req.ownerProfile = shapeMinimalProfile({ from: ownerId, ownerId, role: 'owner', tz, plan });

      return next();
    }

    // 3) Fail-closed: unknown identity
req.ownerId = null;
req.isOwner = false;
req.userProfile = null;
req.ownerProfile = null;
req.tenantId = null;
req.tz = DEFAULT_TZ;
return next();

  } catch (e) {
    console.warn('[userProfile] failed:', e?.message);
    req.tz = req.tz || DEFAULT_TZ;
    return next();
  }
}

module.exports = { userProfileMiddleware };
