// middleware/requireDashboardOwner.js
const pg = require("../services/postgres");

function parseBearer(req) {
  const raw = req.get("authorization") || req.get("Authorization") || "";
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^bearer\s+(.+)$/i);
  return (m ? m[1] : s).trim() || null;
}

function parseCookieHeader(req) {
  const h = req.headers?.cookie;
  if (!h) return {};
  const out = {};
  String(h)
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .forEach((part) => {
      const i = part.indexOf("=");
      if (i > -1) {
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        out[k] = decodeURIComponent(v);
      }
    });
  return out;
}

function DIGITS(x) {
  return String(x ?? "").replace(/\D/g, "");
}

function supabaseEnv() {
  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    "";
  const anon =
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "";
  return {
    url: String(url).trim().replace(/\/+$/, ""),
    anon: String(anon).trim(),
  };
}

async function getSupabaseUser(accessToken) {
  const { url, anon } = supabaseEnv();
  if (!url || !anon) return null;

  // supabase: GET /auth/v1/user with apikey + Authorization
  const r = await fetch(`${url}/auth/v1/user`, {
    method: "GET",
    headers: {
      apikey: anon,
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!r.ok) return null;
  return await r.json();
}

async function requireDashboardOwner(req, res, next) {
  try {
    const cookies = parseCookieHeader(req);

    // Legacy dashboard token (cookie)
    const cookieToken =
      cookies["chiefos_dashboard_token"] ||
      cookies["dashboard_token"] ||
      cookies["dashboardToken"] ||
      null;

    // Supabase access token (Bearer)
    const bearerToken = parseBearer(req);

    // ---------------------------
    // 1) Legacy dashboard token path
    // ---------------------------
    if (cookieToken) {
      const result = await pg.getOwnerByDashboardToken(String(cookieToken).trim());

      const ownerIdRaw =
        typeof result === "string" || typeof result === "number"
          ? String(result)
          : result?.user_id
            ? String(result.user_id)
            : null;

      const ownerId = DIGITS(ownerIdRaw);
      if (!ownerId) return res.status(401).json({ error: "Missing owner context" });

      req.ownerId = ownerId;
      return next();
    }

    // ---------------------------
    // 2) Supabase bearer token path
    // ---------------------------
    if (bearerToken) {
      const u = await getSupabaseUser(String(bearerToken).trim());
      if (!u) return res.status(401).json({ error: "Invalid session" });

      // owner_id in your system is digits/phone-based
      const phone =
        u?.phone ||
        u?.user_metadata?.phone ||
        u?.user_metadata?.phone_number ||
        null;

      const ownerId = DIGITS(phone);
      if (!ownerId) {
        return res.status(401).json({ error: "Missing owner context" });
      }

      req.ownerId = ownerId;
      req.supabaseUserId = u?.id || null;
      return next();
    }

    return res.status(401).json({ error: "Missing auth" });
  } catch (e) {
    console.error("[DASH_AUTH_ERR]", e?.message || e);
    return res.status(500).json({ error: "Auth error" });
  }
}

module.exports = { requireDashboardOwner };