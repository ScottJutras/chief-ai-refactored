// routes/receipts.js
const express = require("express");

// If you're on Node 18+ you likely have global fetch.
// If not, install node-fetch and uncomment next line:
// const fetch = require("node-fetch");

const router = express.Router();

/**
 * REQUIRED ENV (core only):
 * - NEXT_PUBLIC_SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 * - TWILIO_ACCOUNT_SID
 * - TWILIO_AUTH_TOKEN
 *
 * REQUIRED DB access:
 * - a pg helper exposing `query(text, params)`
 *   (adjust the require path below to match your backend)
 */
const pg = require("../services/postgres"); // <-- ADJUST if your path differs

// Supabase admin client (service role) — used ONLY in core backend
const { createClient } = require("@supabase/supabase-js");

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getBearerToken(req) {
  const h = req.headers.authorization || req.headers.Authorization;
  if (!h) return null;
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return (m && m[1]) || null;
}

function isTruthy(v) {
  return v === "1" || v === "true" || v === "yes";
}

function safeFilenameFromContentType(ct) {
  const x = String(ct || "").toLowerCase();
  if (x.includes("pdf")) return "receipt.pdf";
  if (x.includes("png")) return "receipt.png";
  if (x.includes("jpeg") || x.includes("jpg")) return "receipt.jpg";
  if (x.includes("webp")) return "receipt.webp";
  return "receipt";
}

function supabaseAdmin() {
  const url = mustEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Resolve ownerDigits from portal auth:
 * Supabase bearer -> auth.user.id (UUID)
 * -> chiefos_portal_users.user_id (UUID) => tenant_id
 * -> chiefos_tenants.id => owner_id (digits)
 */
async function resolveOwnerDigitsFromPortalBearer(token) {
  const sb = supabaseAdmin();

  const userRes = await sb.auth.getUser(token);
  const user = userRes?.data?.user;
  if (!user) return { ok: false, status: 401, code: "AUTH_REQUIRED", message: "Invalid session." };

  const pu = await sb
    .from("chiefos_portal_users")
    .select("user_id, tenant_id, role")
    .eq("user_id", user.id)
    .maybeSingle();

  const portalUser = pu.data || null;
  if (!portalUser?.tenant_id) {
    return {
      ok: false,
      status: 403,
      code: "NOT_LINKED",
      message: "Account not linked to a business.",
    };
  }

  const ten = await sb
    .from("chiefos_tenants")
    .select("id, owner_id, tz")
    .eq("id", portalUser.tenant_id)
    .maybeSingle();

  const tenant = ten.data || null;
  const ownerDigits = String(tenant?.owner_id || "").replace(/\D/g, "").trim();
  if (!ownerDigits) {
    return {
      ok: false,
      status: 403,
      code: "NOT_LINKED",
      message: "Business owner phone not linked.",
    };
  }

  return {
    ok: true,
    status: 200,
    ownerDigits,
    portalRole: String(portalUser.role || "").toLowerCase(),
    supabaseUserId: user.id,
  };
}

/**
 * GET /api/receipts/:transactionId
 * - Validates portal bearer token
 * - Authorizes by owner_id (digits) using public.transactions.owner_id
 * - Joins media_assets and streams Twilio temp media
 *
 * Query:
 * - ?download=1 -> attachment
 */
router.get("/api/receipts/:transactionId", async (req, res) => {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res
        .status(401)
        .json({ ok: false, code: "AUTH_REQUIRED", message: "Missing session." });
    }

    const ctx = await resolveOwnerDigitsFromPortalBearer(token);
    if (!ctx.ok) {
      return res.status(ctx.status || 403).json({
        ok: false,
        code: ctx.code || "PERMISSION_DENIED",
        message: ctx.message || "Denied.",
      });
    }

    const transactionId = String(req.params.transactionId || "").trim();
    if (!transactionId) {
      return res.status(400).json({ ok: false, code: "ERROR", message: "Missing transactionId." });
    }

    // ✅ Single source of truth lookup (owner-scoped)
    const q = `
      select
        t.id as transaction_id,
        t.owner_id,
        t.media_asset_id,
        m.storage_provider,
        m.storage_path,
        m.content_type
      from public.transactions t
      join public.media_assets m on m.id = t.media_asset_id
      where t.id = $1
        and t.owner_id::text = $2
      limit 1;
    `;

    const out = await pg.query(q, [transactionId, ctx.ownerDigits]);
    const row = out?.rows?.[0] || null;

    if (!row) {
      return res.status(404).json({
        ok: false,
        code: "ERROR",
        message: "Receipt not found for this transaction (or access denied).",
      });
    }

    const provider = String(row.storage_provider || "").toLowerCase();
    const storagePath = String(row.storage_path || "");
    const contentType = String(row.content_type || "application/octet-stream");

    const download = isTruthy(req.query.download);
    const disposition = download ? "attachment" : "inline";
    const filename = safeFilenameFromContentType(contentType);

    if (provider !== "twilio_temp") {
      return res.status(400).json({
        ok: false,
        code: "ERROR",
        message: `Unsupported storage_provider: ${provider}`,
      });
    }

    if (!storagePath.startsWith("http")) {
      return res.status(500).json({ ok: false, code: "ERROR", message: "Invalid Twilio media URL." });
    }

    const sid = mustEnv("TWILIO_ACCOUNT_SID");
    const auth = mustEnv("TWILIO_AUTH_TOKEN");

    const tw = await fetch(storagePath, {
      headers: {
        Authorization: "Basic " + Buffer.from(`${sid}:${auth}`).toString("base64"),
      },
    });

    if (!tw.ok) {
      const t = await tw.text().catch(() => "");
      return res.status(502).json({
        ok: false,
        code: "ERROR",
        message: "Failed to fetch receipt from Twilio.",
        details: t.slice(0, 200),
      });
    }

    // Stream bytes to browser
    res.status(200);
    res.setHeader("Content-Type", tw.headers.get("content-type") || contentType);
    res.setHeader("Content-Disposition", `${disposition}; filename="${filename}"`);
    res.setHeader("Cache-Control", "private, no-store");

    // node-fetch + global fetch both expose a readable body
    tw.body.pipe(res);
  } catch (e) {
    res.status(500).json({ ok: false, code: "ERROR", message: e?.message || "Receipt failed." });
  }
});

module.exports = router;