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
  const serviceKey = mustEnv("SUPABASE_SERVICE_ROLE_KEY"); // ✅ backend-only
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

/**
 * Portal auth:
 * - Validates Supabase session token
 * - Resolves tenant + role via chiefos_portal_users
 * - Loads tenant row from chiefos_tenants
 *
 * Sets:
 *   req.portalUserId (uuid)
 *   req.tenantId (uuid)
 *   req.portalRole (text)
 *   req.tenant (row)
 *   req.ownerId (digits)  // best-effort (from tenant.owner_id)
 */
async function requirePortalUser(req, res, next) {
  try {
    const token = parseBearer(req);
    if (!token) return res.status(401).json({ ok: false, error: "missing_bearer" });

    const sb = supabaseAdmin();

    // 1) Verify user session token
    const userRes = await sb.auth.getUser(token);
    const user = userRes?.data?.user || null;
    if (!user?.id) return res.status(401).json({ ok: false, error: "invalid_session" });

    // 2) Resolve membership (portal user → tenant)
    const mem = await sb
      .from("chiefos_portal_users")
      .select("user_id, tenant_id, role, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const membership = mem?.data || null;
    if (!membership?.tenant_id) {
      return res.status(403).json({ ok: false, error: "not_linked" });
    }

    // 3) Load tenant
    const ten = await sb
      .from("chiefos_tenants")
      .select("id, name, owner_id, tz, created_at")
      .eq("id", membership.tenant_id)
      .maybeSingle();

    const tenant = ten?.data || null;
    if (!tenant?.id) return res.status(403).json({ ok: false, error: "tenant_missing" });

    req.portalUserId = user.id;
    req.tenantId = tenant.id;
    req.portalRole = membership.role || null;
    req.tenant = tenant;

    // Optional convenience: many of your systems key owner by digits
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
    // Save token for downstream calls if needed
    req.supabaseAccessToken = token;

    return next();
  } catch (e) {
    console.error("[PORTAL_AUTH_ERR]", e?.message || e);
    return res.status(500).json({ ok: false, error: "portal_auth_error" });
  }
}

module.exports = { requirePortalUser };
