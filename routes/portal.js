// routes/portal.js
const express = require("express");
const router = express.Router();
const pg = require("../services/postgres");
const { requirePortalUser } = require("../middleware/requirePortalUser");

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
      const r = await pg.query(
        `
        select email, has_whatsapp
        from public.chiefos_portal_users
        where user_id = $1::uuid
        order by created_at desc
        limit 1
        `,
        [req.portalUserId]
      );

      const row = r.rows?.[0] || null;
      email = row?.email ?? null;
      hasWhatsApp = !!row?.has_whatsapp;
    } catch {
      email = null;
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

      // canonical paid-plan field
      planKey: entitlement.planKey,

      // existing frontend beta-compatible fields
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
   LINK PHONE START
========================= */
router.post("/link-phone/start", requirePortalUser, async (req, res) => {
  return res.json({ ok: true });
});

/* =========================
   LINK PHONE VERIFY
========================= */
router.post("/link-phone/verify", requirePortalUser, async (req, res) => {
  return res.json({ ok: true });
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