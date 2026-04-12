// middleware/requireOwnerContext.js
const { queryWithTimeout } = require("../services/postgres");

// Supabase "who am I" via REST (works server-side with anon key)
async function getSupabaseUserIdFromBearer(bearer) {
  const token = String(bearer || "").trim();
  if (!token) return null;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

  if (!url || !anon) {
    throw new Error("Supabase env missing (SUPABASE_URL / SUPABASE_ANON_KEY)");
  }

  const r = await fetch(`${url}/auth/v1/user`, {
    headers: {
      apikey: anon,
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  });

  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j?.id || null;
}

function getBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const s = String(h || "");
  if (!s.toLowerCase().startsWith("bearer ")) return "";
  return s.slice(7).trim();
}

function jsonErr(res, status, code, message) {
  return res.status(status).json({ ok: false, code: String(code), message: String(message) });
}

module.exports = async function requireOwnerContext(req, res, next) {
  try {
    const bearer = getBearer(req);
    const user_id = await getSupabaseUserIdFromBearer(bearer);

    if (!user_id) {
      return jsonErr(res, 401, "401", "Missing session (invalid token). Please log in again.");
    }

    // Resolve tenant + owner deterministically
    // - portal membership gives tenant_id
    // - tenant row gives owner_id
    const { rows } = await queryWithTimeout(
      `
      select
        pu.tenant_id,
        t.owner_id
      from public.chiefos_portal_users pu
      join public.chiefos_tenants t
        on t.id = pu.tenant_id
      where pu.user_id = $1
      limit 1
      `,
      [user_id],
      8000
    );

    const tenant_id = rows?.[0]?.tenant_id || null;
    const owner_id = rows?.[0]?.owner_id || null;

    if (!tenant_id) {
      return jsonErr(res, 401, "401", "Missing owner context");
    }

    if (!owner_id) {
      // Portal user exists but has no WhatsApp owner linked yet
      return jsonErr(res, 401, "NOT_LINKED", "not_linked");
    }

    // Attach context for routes
    req.auth = { user_id, tenant_id, owner_id };
    return next();
  } catch (e) {
    const msg = String(e?.message || e || "Unknown error");
    return jsonErr(res, 500, "500", msg);
  }
};