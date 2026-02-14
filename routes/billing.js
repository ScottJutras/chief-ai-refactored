// routes/billing.js (DROP-IN)
// Billing API for portal (dashboard token auth)
// - GET  /api/billing/status
// - POST /api/billing/checkout
// - POST /api/billing/portal
//
// Truth rules:
// - Webhook writes plan_key + sub_status on owner row.
// - Effective plan is computed from (plan_key + sub_status) server-side.
// - UI never "assumes" payment succeeded; it polls /status after checkout.

const express = require("express");
const Stripe = require("stripe");
const router = express.Router();

const db = require("../services/postgres");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const { requireDashboardOwner } = require("../middleware/requireDashboardOwner");
const { getEffectivePlanKey } = require("../src/config/getEffectivePlanKey");
const { plan_capabilities } = require("../src/config/planCapabilities");

// ✅ Billing routes are normal HTTP calls (not Twilio), so use dashboard token auth
router.use(requireDashboardOwner);

// ✅ Because index.js intentionally has NO global body parsers
router.use(express.json({ limit: "200kb" }));

const PRICE_BY_PLAN = {
  starter: process.env.STRIPE_PRICE_STARTER,
  pro: process.env.STRIPE_PRICE_PRO,
};

function ok(res, payload) {
  return res.json({ ok: true, ...payload });
}
function bad(res, code, error) {
  return res.status(code).json({ ok: false, error });
}

function requireOwner(req, res) {
  const ownerId = req.ownerId;
  if (!ownerId) {
    bad(res, 401, "Missing owner context");
    return null;
  }
  return ownerId;
}

function requireAppBaseUrl() {
  const base = String(process.env.APP_BASE_URL || "").trim();
  return base && /^https?:\/\//i.test(base) ? base.replace(/\/+$/, "") : null;
}

function capsForPlanKey(planKey) {
  const k = String(planKey || "free").toLowerCase().trim();
  return plan_capabilities?.[k] || plan_capabilities?.free || null;
}

// -----------------------------
// POST /api/billing/checkout
// -----------------------------
router.post("/checkout", async (req, res) => {
  try {
    const ownerId = requireOwner(req, res);
    if (!ownerId) return;

    const appBase = requireAppBaseUrl();
    if (!appBase) return bad(res, 500, "APP_BASE_URL missing/invalid");

    // Accept either planKey or plan_key (prevents frontend/backend drift)
    const body = req.body || {};
    const planKeyRaw = body.planKey || body.plan_key || body.plan || null;
    const planKey = String(planKeyRaw || "").toLowerCase().trim();

    const priceId = PRICE_BY_PLAN[planKey];
    if (!planKey || !priceId) {
      return bad(res, 400, "Invalid plan");
    }

    const owner = await db.getOwner(ownerId);
    if (!owner) return bad(res, 404, "Owner not found");

    let customerId = owner?.stripe_customer_id || null;

    // If switching between test/live, a stored customer may not exist in this mode.
    // Safest: attempt to retrieve; if not found, create a new one and overwrite DB.
    if (customerId) {
      try {
        await stripe.customers.retrieve(customerId);
      } catch {
        customerId = null;
      }
    }

    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: { owner_id: String(ownerId), ownerId: String(ownerId) },
      });

      customerId = customer.id;
      await db.updateOwnerBilling(ownerId, { stripe_customer_id: customerId });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],

      // Redirects are just UX; webhook is truth.
      // We add activating=1 so the billing page can poll.
      success_url: `${appBase}/app/settings/billing?activating=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appBase}/app/settings/billing?canceled=1`,

      client_reference_id: String(ownerId),

      // Metadata is informative only; webhook must map price_id → plan_key
      metadata: {
        owner_id: String(ownerId),
        ownerId: String(ownerId),
        plan_key_requested: String(planKey),
        planKey: String(planKey),
      },
    });

    return ok(res, { url: session.url });
  } catch (e) {
    console.error("[BILLING_CHECKOUT_ERR]", e?.message || e);
    return bad(res, 500, "checkout_failed");
  }
});

// -----------------------------
// GET /api/billing/status
// -----------------------------
router.get("/status", async (req, res) => {
  try {
    const ownerId = requireOwner(req, res);
    if (!ownerId) return;

    const owner = await db.getOwner(ownerId);
    if (!owner) return bad(res, 404, "Owner not found");

    // "linked" is already enforced by requireDashboardOwner,
    // but we return it so UI can render cleanly.
    const linked = true;

    const effective_plan = getEffectivePlanKey(owner); // free|starter|pro|enterprise (if you add later)
    const caps = capsForPlanKey(effective_plan);

    return ok(res, {
      owner_id: String(ownerId),
      linked,

      plan_key: String(owner.plan_key || "free").toLowerCase(),
      sub_status: owner.sub_status || null,
      effective_plan,

      cancel_at_period_end: !!owner.cancel_at_period_end,
      current_period_start: owner.current_period_start || null,
      current_period_end: owner.current_period_end || null,

      // IDs (return actual values; UI can choose to display or not)
      stripe_customer_id: owner.stripe_customer_id || null,
      stripe_subscription_id: owner.stripe_subscription_id || null,
      stripe_price_id: owner.stripe_price_id || null,

      caps,
    });
  } catch (e) {
    console.error("[BILLING_STATUS_ERR]", e?.message || e);
    return bad(res, 500, "status_failed");
  }
});

// -----------------------------
// POST /api/billing/portal
// -----------------------------
router.post("/portal", async (req, res) => {
  try {
    const ownerId = requireOwner(req, res);
    if (!ownerId) return;

    const appBase = requireAppBaseUrl();
    if (!appBase) return bad(res, 500, "APP_BASE_URL missing/invalid");

    const owner = await db.getOwner(ownerId);
    if (!owner) return bad(res, 404, "Owner not found");

    const customerId = owner?.stripe_customer_id;
    if (!customerId) return bad(res, 400, "No Stripe customer on file");

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appBase}/app/settings/billing`,
    });

    return ok(res, { url: session.url });
  } catch (e) {
    console.error("[BILLING_PORTAL_ERR]", e?.message || e);
    return bad(res, 500, "portal_failed");
  }
});

module.exports = router;
