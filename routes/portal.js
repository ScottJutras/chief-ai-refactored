// routes/portal.js
//
// Related middleware (R2.5):
//   - middleware/requirePhonePaired.js — exported gate that returns 403
//     PHONE_LINK_REQUIRED when req.isPhonePaired is false. Not mounted
//     globally here; individual routes opt in per product decision.
const express = require("express");
const router = express.Router();
const pg = require("../services/postgres");
const { requirePortalUser } = require("../middleware/requirePortalUser");
const { isPhonePaired, generatePhoneLinkOtp } = require("../services/phoneLinkOtp");

function jsonErr(res, status, code, message) {
  return res.status(status).json({ ok: false, code, message: message || code });
}

function normalizePlanKey(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return "free";
  if (v.includes("pro")) return "pro";
  if (v.includes("starter")) return "starter";
  return "free";
}

function normalizePlanStatus(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return null;
  if (["active", "trialing", "approved"].includes(v)) return "approved";
  if (["canceled", "cancelled", "past_due", "unpaid", "denied", "inactive"].includes(v)) return "denied";
  return "requested";
}

async function resolvePortalEntitlement({ tenantId, ownerId }) {
  // ------------------------------------------------------------
  // Canonical plan resolution path:
  // portal auth -> tenant -> owner_id -> public.users.plan_key
  //
  // This is the constitutional path for ChiefOS:
  // - portal boundary = tenant_id
  // - monetization / quota boundary = owner_id
  // ------------------------------------------------------------
  const out = {
    planKey: "free",
    betaPlan: null,
    betaStatus: null,
    betaEntitlementPlan: null,
    source: "free_fallback",
  };

  if (!ownerId) return out;

  // 1) Primary authority: public.users by owner_id
  try {
    const userRes = await pg.query(
      `
      select owner_id, plan_key, subscription_tier, paid_tier, sub_status
      from public.users
      where owner_id = $1
      limit 1
      `,
      [String(ownerId)]
    );

    const row = userRes.rows?.[0] || null;
    if (row) {
      const canonicalPlan =
        normalizePlanKey(row.plan_key) ||
        normalizePlanKey(row.subscription_tier) ||
        normalizePlanKey(row.paid_tier) ||
        "free";

      const canonicalStatus = normalizePlanStatus(row.sub_status) || (canonicalPlan === "free" ? null : "approved");

      out.planKey = canonicalPlan;
      out.betaEntitlementPlan = canonicalPlan === "free" ? null : canonicalPlan;
      out.betaStatus = canonicalStatus;
      out.betaPlan = canonicalStatus === "approved" ? canonicalPlan : null;
      out.source = "users_owner_id";

      return out;
    }
  } catch {
    // fall through safely
  }

  // 2) Fallback only if needed: billing_subscriptions by tenant_id
  // Keep this as secondary compatibility only, NOT primary authority.
  try {
    if (tenantId) {
      const subRes = await pg.query(
        `
        select plan_key, status
        from public.billing_subscriptions
        where tenant_id = $1::uuid
        order by created_at desc
        limit 1
        `,
        [tenantId]
      );

      const row = subRes.rows?.[0] || null;
      if (row) {
        const fallbackPlan = normalizePlanKey(row.plan_key);
        const fallbackStatus = normalizePlanStatus(row.status);

        out.planKey = fallbackPlan;
        out.betaEntitlementPlan = fallbackPlan === "free" ? null : fallbackPlan;
        out.betaStatus = fallbackStatus;
        out.betaPlan = fallbackStatus === "approved" ? fallbackPlan : null;
        out.source = "billing_subscriptions_tenant";

        return out;
      }
    }
  } catch {
    // fail closed
  }

  return out;
}

/* =========================
   WHOAMI (frontend contract)
   GET /api/whoami
========================= */
router.get("/whoami", requirePortalUser({ allowUnlinked: true }), async (req, res) => {
  try {
    let email = null;
    let hasWhatsApp = false;

    try {
      const portalRes = await pg.query(
        `
        select email
        from public.chiefos_portal_users
        where user_id = $1::uuid
        order by created_at desc
        limit 1
        `,
        [req.portalUserId]
      );

      email = portalRes?.rows?.[0]?.email ?? null;
    } catch {
      email = null;
    }

    // R2.5: durable check against public.users.auth_user_id (P1A-4 column).
    // Works for owners AND non-owner portal users (employees, board members).
    // Prefer req.isPhonePaired populated by requirePortalUser; fall back to
    // a direct lookup if the middleware's cache path didn't set it.
    try {
      if (typeof req.isPhonePaired === 'boolean') {
        hasWhatsApp = req.isPhonePaired;
      } else if (req.portalUserId) {
        hasWhatsApp = await isPhonePaired(req.portalUserId);
      }
    } catch (e) {
      console.warn("[WHOAMI_WHATSAPP_CHECK] failed:", e?.message);
      hasWhatsApp = false;
    }

    const entitlement = await resolvePortalEntitlement({
      tenantId: req.tenantId || null,
      ownerId: req.ownerId || null,
    });

    return res.json({
      ok: true,
      userId: req.portalUserId,
      tenantId: req.tenantId || null,
      ownerId: req.ownerId || null,
      hasWhatsApp,
      email,
      planKey: entitlement.planKey,
      betaPlan: entitlement.betaPlan,
      betaStatus: entitlement.betaStatus,
      betaEntitlementPlan: entitlement.betaEntitlementPlan,
      role: req.portalRole || null,
      entitlementSource: entitlement.source,
    });
  } catch (e) {
    return jsonErr(res, 500, "WHOAMI_FAILED", "whoami_failed");
  }
});

/* =========================
   ENTITLEMENT
   GET /api/health/entitlement
========================= */
router.get("/health/entitlement", requirePortalUser, async (req, res) => {
  try {
    if (!req.tenantId || !req.ownerId) {
      return res.json({
        ok: true,
        tenantId: req.tenantId || null,
        ownerId: req.ownerId || null,
        plan: "free",
        planKey: "free",
        status: null,
        source: "free_fallback",
      });
    }

    const entitlement = await resolvePortalEntitlement({
      tenantId: req.tenantId,
      ownerId: req.ownerId,
    });

    return res.json({
      ok: true,
      tenantId: req.tenantId,
      ownerId: req.ownerId,
      plan: entitlement.planKey,
      planKey: entitlement.planKey,
      status: entitlement.betaStatus,
      source: entitlement.source,
    });
  } catch (e) {
    return jsonErr(res, 500, "ENTITLEMENT_FAILED", "entitlement_failed");
  }
});

/* =========================
   LINK PHONE START (R2.5)
   POST body: { phoneDigits: string, ownerPhone?: string }  ← ownerPhone kept for
     backward compat with legacy LinkPhoneClient.tsx; prefer phoneDigits.
   Returns: { ok: true, code: string, expiresAt: string }
   Plaintext code is returned for portal display ONLY; user sends it from
   phoneDigits to the ChiefOS WhatsApp number. Verification happens in
   routes/webhook.js via services/phoneLinkOtp.verifyPhoneLinkOtp.
========================= */
router.post("/link-phone/start", requirePortalUser(), async (req, res) => {
  // Diagnostic logging added 2026-04-28 to root-cause /api/link-phone/start
  // 504 hang. Remove once the underlying issue is resolved.
  const t0 = Date.now();
  console.log("[LINK_PHONE_START] step=enter portalUserId=" + req.portalUserId + " tenantId=" + (req.tenantId || "null") + " isPhonePaired=" + req.isPhonePaired);
  try {
    const raw = String(req.body?.phoneDigits ?? req.body?.ownerPhone ?? "");
    const phoneDigits = raw.replace(/\D/g, "");
    console.log(`[LINK_PHONE_START] step=validated phoneDigits.length=${phoneDigits.length} elapsed=${Date.now() - t0}ms`);
    if (!phoneDigits || phoneDigits.length < 7) {
      return res.status(400).json({
        ok: false,
        error: { code: "INVALID_PHONE", message: "phoneDigits must be digit-only, length >= 7", traceId: req.traceId || null },
      });
    }
    if (!req.portalUserId) {
      return res.status(401).json({ ok: false, error: { code: "MISSING_AUTH", message: "missing_auth" } });
    }

    console.log(`[LINK_PHONE_START] step=calling_generate elapsed=${Date.now() - t0}ms`);
    const { code, expiresAt } = await generatePhoneLinkOtp(req.portalUserId, phoneDigits);
    console.log(`[LINK_PHONE_START] step=generated elapsed=${Date.now() - t0}ms`);
    return res.json({ ok: true, code, expiresAt: expiresAt.toISOString() });
  } catch (e) {
    console.warn(`[LINK_PHONE_START] step=catch elapsed=${Date.now() - t0}ms err=${e?.message} stack=${e?.stack?.split("\n").slice(0, 3).join(" | ")}`);
    return jsonErr(res, 500, "LINK_PHONE_START_FAILED", "link_phone_start_failed");
  }
});

/* =========================
   LINK PHONE VERIFY (R2.5)
   The actual verification happens inside routes/webhook.js when the user
   texts the code from WhatsApp. This endpoint is retained as a "check current
   pairing state" helper for portal UIs polling for completion.
   Returns: { ok: true, paired: boolean }
========================= */
router.post("/link-phone/verify", requirePortalUser(), async (req, res) => {
  try {
    const paired = await isPhonePaired(req.portalUserId);
    return res.json({ ok: true, paired });
  } catch (e) {
    console.warn("[LINK_PHONE_VERIFY] failed:", e?.message);
    return jsonErr(res, 500, "LINK_PHONE_VERIFY_FAILED", "link_phone_verify_failed");
  }
});

/* =========================
   REVENUE LIST
   GET /api/revenue/list
========================= */
router.get("/revenue/list", requirePortalUser, async (req, res) => {
  try {
    const r = await pg.query(
      `
      select id, date, amount_cents, description, job_name, created_at
      from public.transactions
      where tenant_id = $1::uuid
        and kind = 'revenue'
      order by date desc, created_at desc
      limit 200
      `,
      [req.tenantId]
    );

    return res.json({ ok: true, rows: r.rows });
  } catch (e) {
    return jsonErr(res, 500, "REVENUE_LIST_FAILED", "revenue_list_failed");
  }
});

/* =========================
   TASKS LIST
   GET /api/tasks/list
========================= */
router.get("/tasks/list", requirePortalUser, async (req, res) => {
  try {
    const r = await pg.query(
      `
      select id, title, body, status, created_at, updated_at
      from public.tasks
      where owner_id = $1
      order by created_at desc
      limit 300
      `,
      [req.ownerId]
    );

    return res.json({ ok: true, rows: r.rows });
  } catch (e) {
    return jsonErr(res, 500, "TASKS_LIST_FAILED", "tasks_list_failed");
  }
});

module.exports = router;