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

async function requireDashboardOwner(req, res, next) {
  try {
    // ✅ Prefer HttpOnly cookie (Option B)
    const cookies = parseCookieHeader(req);

    // Support a couple names to avoid drift
    const cookieToken =
      cookies["chiefos_dashboard_token"] ||
      cookies["dashboard_token"] ||
      cookies["dashboardToken"] ||
      null;

    // Fallback to Authorization header if you want (optional, safe)
    const bearerToken = parseBearer(req);

    const token = (cookieToken || bearerToken || "").trim();
    if (!token) return res.status(401).json({ error: "Missing dashboard token" });

    const result = await pg.getOwnerByDashboardToken(token);

    const ownerIdRaw =
      typeof result === "string" || typeof result === "number"
        ? String(result)
        : result?.user_id
          ? String(result.user_id)
          : null;

    const ownerId = DIGITS(ownerIdRaw);

    if (!ownerId) {
      return res.status(401).json({ error: "Missing owner context" });
    }

    req.ownerId = ownerId;
    return next();
  } catch (e) {
    console.error("[DASH_AUTH_ERR]", e?.message || e);
    return res.status(500).json({ error: "Auth error" });
  }
}

module.exports = { requireDashboardOwner };
