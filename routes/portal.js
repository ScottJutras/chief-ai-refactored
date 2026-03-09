// routes/portal.js
const express = require("express");
const router = express.Router();
const pg = require("../services/postgres");
const { requirePortalUser } = require("../middleware/requirePortalUser");

function jsonErr(res, status, code, message) {
  return res.status(status).json({ ok: false, code, message: message || code });
}

/* =========================
   WHOAMI (frontend contract)
   GET /api/whoami
========================= */
router.get("/whoami", requirePortalUser({ allowUnlinked: true }), async (req, res) => {
  try {
    // Try to enrich with portal user profile fields if available.
    // (This is safe even if table/cols differ — we catch errors.)
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
      // If your portal user table doesn't have these columns, just fall back.
      email = null;
      hasWhatsApp = false;
    }

    // Billing/entitlement fields the frontend expects.
    // If you don't have approvals wired yet, keep these null.
    // If you *do* have a subscription row, we can map plan_key -> betaEntitlementPlan.
    let betaEntitlementPlan = null;
    let betaStatus = null; // "requested" | "approved" | "denied" | null
    let betaPlan = null;   // only when approved

    try {
      if (req.tenantId) {
        const sub = await pg.query(
          `
          select plan_key, status
          from public.billing_subscriptions
          where tenant_id = $1::uuid
          order by created_at desc
          limit 1
          `,
          [req.tenantId]
        );
        const row = sub.rows?.[0] || null;

        // Map plan_key to your BetaPlan union.
        // Adjust these strings to match your real Stripe plan keys.
        const planKey = String(row?.plan_key || "").toLowerCase();
        const status = row?.status ? String(row.status).toLowerCase() : "";

        if (planKey.includes("pro")) betaEntitlementPlan = "pro";
        else if (planKey.includes("starter")) betaEntitlementPlan = "starter";
        else if (planKey) betaEntitlementPlan = "free";

        // Optional mapping if you use statuses like active/trialing/canceled, etc.
        // You can tighten this later.
        if (status === "active" || status === "trialing") {
          betaStatus = "approved";
          betaPlan = betaEntitlementPlan;
        } else if (status === "canceled" || status === "past_due" || status === "unpaid") {
          betaStatus = "denied";
          betaPlan = null;
        } else if (status) {
          betaStatus = "requested";
          betaPlan = null;
        }
      }
    } catch {
      // leave entitlement fields null
    }

    return res.json({
      ok: true,
      userId: req.portalUserId,
      tenantId: req.tenantId || null,
      hasWhatsApp,
      email,

      // these fields are required by your WhoamiOk type
      betaPlan,
      betaStatus,
      betaEntitlementPlan,

      // keep extra fields for debugging (harmless)
      role: req.portalRole || null,
      ownerId: req.ownerId || null,
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
    if (!req.tenantId) {
      return res.json({ ok: true, tenantId: null, plan: "free", status: null });
    }

    const r = await pg.query(
      `select plan_key, status
       from public.billing_subscriptions
       where tenant_id = $1::uuid
       order by created_at desc
       limit 1`,
      [req.tenantId]
    );

    const row = r.rows?.[0] || null;

    return res.json({
      ok: true,
      tenantId: req.tenantId,
      plan: row?.plan_key || "free",
      status: row?.status || null,
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