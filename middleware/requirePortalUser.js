// middleware/requirePortalUser.js
const { createClient } = require("@supabase/supabase-js");

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

    // Save token for downstream calls if needed
    req.supabaseAccessToken = token;

    return next();
  } catch (e) {
    console.error("[PORTAL_AUTH_ERR]", e?.message || e);
    return res.status(500).json({ ok: false, error: "portal_auth_error" });
  }
}

module.exports = { requirePortalUser };
