// routes/receipts.js (CommonJS)
const express = require("express");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const router = express.Router();
const pg = require("../services/postgres");

// Same middleware you already have in your core (matches askChief.js pattern)
const { requireDashboardOwner } = require("../middleware/requireDashboardOwner");
const { requirePortalUser } = require("../middleware/requirePortalUser");

/**
 * Dashboard token detection (copy from routes/askChief.js)
 */
function hasDashboardToken(req) {
  const cookie = String(req.headers?.cookie || "");
  return (
    cookie.includes("chiefos_dashboard_token=") ||
    cookie.includes("dashboard_token=") ||
    cookie.includes("dashboardToken=")
  );
}

const { createClient } = require("@supabase/supabase-js");

function getSupabaseAdmin() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
if (!url) throw new Error("Missing env var: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)");
  const serviceKey = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

function parseSupabasePath(storagePath) {
  // expected: "<bucket>/<objectPath>"
  const s = String(storagePath || "").replace(/^\/+/, "");
  const idx = s.indexOf("/");
  if (idx <= 0) return null;
  return { bucket: s.slice(0, idx), objectPath: s.slice(idx + 1) };
}

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function isTruthy(v) {
  return v === "1" || v === "true" || v === "yes";
}

function safeFilenameFromContentType(ct, txId) {
  const x = String(ct || "").toLowerCase();
  if (x.includes("pdf")) return `receipt-${txId}.pdf`;
  if (x.includes("png")) return `receipt-${txId}.png`;
  if (x.includes("jpeg") || x.includes("jpg")) return `receipt-${txId}.jpg`;
  if (x.includes("webp")) return `receipt-${txId}.webp`;
  if (x.includes("audio/ogg")) return `attachment-${txId}.ogg`;
  return `attachment-${txId}`;
}

/**
 * GET /api/receipts/:transactionId
 * Supports:
 * - Dashboard auth (cookie) via requireDashboardOwner -> req.ownerId digits
 * - Portal auth (bearer) via requirePortalUser -> req.ownerId digits
 *
 * Authorizes by public.transactions.owner_id (digits).
 */
router.get("/api/receipts/:transactionId", async (req, res) => {
  try {
    // ---------------- Auth (same split as askChief) ----------------
    if (hasDashboardToken(req)) {
      await new Promise((resolve, reject) =>
        requireDashboardOwner(req, res, (err) => (err ? reject(err) : resolve()))
      );
      if (res.headersSent) return;
    } else {
      await new Promise((resolve, reject) =>
        requirePortalUser(req, res, (err) => (err ? reject(err) : resolve()))
      );
      if (res.headersSent) return;
    }

    const ownerDigits = String(req.ownerId || "").trim();
    if (!ownerDigits) {
      return res.status(401).json({
        ok: false,
        code: "AUTH_REQUIRED",
        message: "Missing session. Please log in again.",
      });
    }

    // ---------------- Validate tx id ----------------
    const rawId = String(req.params.transactionId || "").trim();
    const txId = Number(rawId);
    if (!Number.isInteger(txId) || txId <= 0) {
      return res
        .status(400)
        .json({ ok: false, code: "ERROR", message: "Invalid transaction id." });
    }

    // ---------------- Lookup + authorize (owner scoped) ----------------
   // ---------------- Lookup + authorize (owner scoped) ----------------
const q = `
  select
    t.id as transaction_id,
    t.owner_id,
    t.media_asset_id,
    m.storage_provider,
    m.storage_path,
    m.content_type
  from public.transactions t
  left join public.media_assets m on m.id = t.media_asset_id
  where t.id = $1::int
    and t.owner_id::text = $2
  limit 1
`;

const out = await pg.query(q, [txId, ownerDigits]);
const row = out?.rows?.[0] || null;

if (!row) {
  return res.status(404).json({
    ok: false,
    code: "ERROR",
    message: "Transaction not found (or access denied).",
  });
}

if (!row.media_asset_id) {
  return res.status(404).json({
    ok: false,
    code: "NO_RECEIPT",
    message: "This transaction has no receipt attachment (media_asset_id is null).",
  });
}

if (!row.storage_path || !row.storage_provider) {
  return res.status(500).json({
    ok: false,
    code: "BROKEN_RECEIPT_LINK",
    message: "Receipt attachment record is missing storage_path/storage_provider.",
  });
}

    const provider = String(row.storage_provider || "").toLowerCase();
    const storagePath = String(row.storage_path || "");
    const contentType = String(row.content_type || "application/octet-stream");

    const download = isTruthy(req.query.download);
    const disposition = download ? "attachment" : "inline";
    const filename = safeFilenameFromContentType(contentType, txId);

    // NOTE: set headers before streaming
    res.status(200);
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `${disposition}; filename="${filename}"`);

    if (provider !== "twilio_temp") {
      return res.status(400).json({
        ok: false,
        code: "ERROR",
        message: `Unsupported storage_provider: ${provider}`,
      });
    }

    if (!storagePath.startsWith("http")) {
      return res
        .status(500)
        .json({ ok: false, code: "ERROR", message: "Invalid storage URL." });
    }

    const sid = mustEnv("TWILIO_ACCOUNT_SID");
    const auth = mustEnv("TWILIO_AUTH_TOKEN");

    const tw = await fetch(storagePath, {
      headers: {
        Authorization:
          "Basic " + Buffer.from(`${sid}:${auth}`).toString("base64"),
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

    if (!tw.body) {
      return res
        .status(502)
        .json({ ok: false, code: "ERROR", message: "Missing receipt body." });
    }

    // Node 18 safe streaming
    const bodyStream = Readable.fromWeb(tw.body);
    await pipeline(bodyStream, res);
  } catch (e) {
    console.warn("[RECEIPTS] failed:", e?.message);
    return res
      .status(500)
      .json({ ok: false, code: "ERROR", message: e?.message || "Receipt failed." });
  }
});

module.exports = router;