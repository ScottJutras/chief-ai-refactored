// middleware/requireDashboardOwner.js
const pg = require("../services/postgres");

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

async function requireDashboardOwner(req, res, next) {
  try {
    // Billing/auth responses should never be cached by proxies/browsers
    res.set("Cache-Control", "no-store");

    const token = parseBearer(req);
    if (!token) return res.status(401).json({ error: "Missing dashboard token" });

    const result = await pg.getOwnerByDashboardToken(token);

    const ownerIdRaw =
      typeof result === "string" || typeof result === "number"
        ? String(result)
        : result?.user_id
          ? String(result.user_id)
          : null;

    const ownerId = DIGITS(ownerIdRaw);
    if (!ownerId) return res.status(401).json({ error: "Invalid dashboard token" });

    req.ownerId = ownerId;

    // Optional but useful: attach owner profile so routes can avoid extra DB fetch
    try {
      if (typeof pg.getOwner === "function") {
        req.ownerProfile = await pg.getOwner(ownerId);
      } else {
        req.ownerProfile = null;
      }
    } catch (e) {
      console.warn("[DASH_AUTH] failed to load owner profile:", e?.message);
      req.ownerProfile = null; // fail-open (auth ok, profile missing)
    }

    return next();
  } catch (e) {
    console.error("[DASH_AUTH_ERR]", e?.message || e);
    return res.status(500).json({ error: "Auth error" });
  }
}

module.exports = { requireDashboardOwner };
