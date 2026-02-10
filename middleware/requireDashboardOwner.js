// middleware/requireDashboardOwner.js
const db = require('../services/postgres');

function bearerToken(req) {
  const h = String(req.headers?.authorization || '').trim();
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function requireDashboardOwner(req, res, next) {
  try {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ error: 'Missing Authorization Bearer token' });

    const ownerId = await db.getOwnerByDashboardToken(token);
    if (!ownerId) return res.status(401).json({ error: 'Invalid token' });

    req.ownerId = String(ownerId);
    return next();
  } catch (e) {
    console.warn('[AUTH] requireDashboardOwner failed:', e?.message);
    return res.status(500).json({ error: 'auth_failed' });
  }
}

module.exports = { requireDashboardOwner };
