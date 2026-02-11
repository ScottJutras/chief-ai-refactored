// middleware/requireDashboardOwner.js
const pg = require("../services/postgres");

function parseBearer(req) {
  const raw = req.get("authorization") || req.get("Authorization") || "";
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^bearer\s+(.+)$/i);
  return (m ? m[1] : s).trim() || null;
}

async function requireDashboardOwner(req, res, next) {
  try {
    const token = parseBearer(req);

    

    if (!token) return res.status(401).json({ error: "Missing dashboard token" });

    const result = await pg.getOwnerByDashboardToken(token);

    // ✅ Support both return shapes:
    // - legacy: "19053279955"
    // - newer: { user_id: "19053279955", ... }
    const ownerId =
      typeof result === "string" || typeof result === "number"
        ? String(result)
        : result?.user_id
          ? String(result.user_id)
          : null;

    if (!ownerId) {
      return res.status(401).json({ error: "Missing owner context" });
    }

    req.ownerId = ownerId;
    return next();
  } catch (e) {
    console.error("[DASH_AUTH_ERR]", e);
    return res.status(500).json({ error: "Auth error" });
  }
}

module.exports = { requireDashboardOwner };
