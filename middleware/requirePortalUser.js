// middleware/requirePortalUser.js
const { createClient } = require("@supabase/supabase-js");
const pg = require("../services/postgres");

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function parseBearer(req) {
  const raw = req.get("authorization") || req.get("Authorization") || "";
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^bearer\s+(.+)$/i);
  return (m ? m[1] : s).trim() || null;
}

function DIGITS(x) {
  return String(x ?? "").replace(/\D/g, "");
}

function supabaseAdmin() {
  const url = mustEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceKey = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

/**
 * Portal auth middleware.
 *
 * Default:
 *   - requires valid Supabase bearer token
 *   - requires portal membership + tenant
 *
 * Optional:
 *   - allowUnlinked: true
 *     lets authenticated users through even if tenant/membership
 *     does not exist yet (used for whoami / finish-signup style flows)
 *
 * Sets:
 *   req.portalUserId (auth user uuid)
 *   req.tenantId (uuid|null)
 *   req.portalRole (text|null)
 *   req.tenant (row|null)
 *   req.ownerId (digits|null)
 *   req.actorId (uuid|null)
 *   req.supabaseAccessToken
 */
function requirePortalUser(opts = {}) {
  const allowUnlinked = !!opts.allowUnlinked;

  return async function portalAuthMiddleware(req, res, next) {
    try {
      const token = parseBearer(req);
      if (!token) {
        return res.status(401).json({ ok: false, error: "missing_bearer" });
      }

      const sb = supabaseAdmin();

      // 1) Verify user session token
      const userRes = await sb.auth.getUser(token);
      const user = userRes?.data?.user || null;
      if (!user?.id) {
        return res.status(401).json({ ok: false, error: "invalid_session" });
      }

      // Always attach authenticated portal user id
      req.portalUserId = user.id;
      req.tenantId = null;
      req.portalRole = null;
      req.tenant = null;
      req.ownerId = null;
      req.actorId = null;
      req.supabaseAccessToken = token;

      // 2) Resolve membership (portal user -> tenant)
      const mem = await sb
        .from("chiefos_portal_users")
        .select("user_id, tenant_id, role, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const membership = mem?.data || null;

      // If user is authenticated but not linked yet, allow only when explicitly requested.
      if (!membership?.tenant_id) {
        if (allowUnlinked) {
          return next();
        }
        return res.status(403).json({ ok: false, error: "not_linked" });
      }

      // 3) Load tenant
      const ten = await sb
        .from("chiefos_tenants")
        .select("id, name, owner_id, tz, created_at")
        .eq("id", membership.tenant_id)
        .maybeSingle();

      const tenant = ten?.data || null;

      if (!tenant?.id) {
        if (allowUnlinked) {
          req.tenantId = null;
          req.portalRole = membership.role || null;
          return next();
        }
        return res.status(403).json({ ok: false, error: "tenant_missing" });
      }

      req.tenantId = tenant.id;
      req.portalRole = membership.role || null;
      req.tenant = tenant;
      req.ownerId = DIGITS(tenant.owner_id || "") || null;

      // 4) Resolve portal actorId by email identity (preferred)
      try {
        const email = String(user.email || "").trim().toLowerCase();
        if (email) {
          const r = await pg.query(
            `
            select actor_id
            from public.v_actor_identity_resolver
            where kind = 'email'
              and identifier = $1
              and tenant_id = $2
            limit 1
            `,
            [email, tenant.id]
          );

          req.actorId = r?.rows?.[0]?.actor_id || null;
        }
      } catch (e) {
        console.warn("[PORTAL_ACTOR_RESOLVE] failed:", e?.message);
      }

      // 5) If still missing and owner/admin, fallback to tenant owner/admin actor
      if (!req.actorId && req.tenantId && (req.portalRole === "owner" || req.portalRole === "admin")) {
        try {
          const r2 = await pg.query(
            `
            select actor_id
            from public.chiefos_tenant_actors
            where tenant_id = $1
              and role in ('owner','admin')
            order by case role when 'owner' then 0 else 1 end
            limit 1
            `,
            [req.tenantId]
          );
          req.actorId = r2?.rows?.[0]?.actor_id || null;
        } catch (e) {
          console.warn("[PORTAL_ACTOR_FALLBACK] failed:", e?.message);
        }
      }

      return next();
    } catch (e) {
      console.error("[PORTAL_AUTH_ERR]", e?.message || e);
      return res.status(500).json({ ok: false, error: "portal_auth_error" });
    }
  };
}

/**
 * withPlanKey — resolves req.planKey from the authenticated tenant's owner.
 * Must run AFTER requirePortalUser(). Sets req.planKey to 'free'|'starter'|'pro'.
 */
function normalizePlanKey(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return 'free';
  if (v.includes('pro')) return 'pro';
  if (v.includes('starter')) return 'starter';
  return 'free';
}

async function withPlanKey(req, res, next) {
  // Default to free — fail closed
  req.planKey = 'free';

  try {
    const ownerId = req.ownerId || null;
    const tenantId = req.tenantId || null;

    if (ownerId) {
      const r = await pg.query(
        `SELECT plan_key, subscription_tier, paid_tier FROM public.users WHERE owner_id = $1 LIMIT 1`,
        [String(ownerId)]
      );
      const row = r.rows?.[0];
      if (row) {
        req.planKey =
          normalizePlanKey(row.plan_key) ||
          normalizePlanKey(row.subscription_tier) ||
          normalizePlanKey(row.paid_tier) ||
          'free';
        return next();
      }
    }

    // Fallback: billing_subscriptions by tenant_id
    if (tenantId) {
      const r2 = await pg.query(
        `SELECT plan_key FROM public.billing_subscriptions WHERE tenant_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
        [tenantId]
      );
      const row2 = r2.rows?.[0];
      if (row2) {
        req.planKey = normalizePlanKey(row2.plan_key);
      }
    }
  } catch (e) {
    console.warn('[WITH_PLAN_KEY] plan resolution failed, defaulting to free:', e?.message);
  }

  return next();
}

module.exports = { requirePortalUser, withPlanKey };