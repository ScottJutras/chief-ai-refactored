// routes/billing.js (DROP-IN)
// Billing API for portal (owner-context auth)
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

// ✅ Robust middleware import (supports either module.exports = fn OR module.exports = { requireOwnerContext: fn })
const requireOwnerContextMod = require("../middleware/requireOwnerContext");
const requireOwnerContext =
  typeof requireOwnerContextMod === "function"
    ? requireOwnerContextMod
    : requireOwnerContextMod?.requireOwnerContext;

const { getEffectivePlanKey } = require("../src/config/getEffectivePlanKey");
const { plan_capabilities } = require("../src/config/planCapabilities");

function bad(res, code, error) {
  return res.status(code).json({ ok: false, error });
}

function requireAppBaseUrl() {
  const base = String(process.env.APP_BASE_URL || "").trim();
  return base && /^https?:\/\//i.test(base) ? base.replace(/\/+$/, "") : null;
}

function capsForPlanKey(planKey) {
  const k = String(planKey || "free").toLowerCase().trim();
  return plan_capabilities?.[k] || plan_capabilities?.free || null;
}

// ✅ Canonical owner id getter (supports multiple middleware shapes)
function getOwnerIdFromReq(req) {
  // Most common: middleware sets req.ownerId
  if (req?.ownerId) return String(req.ownerId).trim();

  // Some implementations set req.auth.owner_id
  if (req?.auth?.owner_id) return String(req.auth.owner_id).trim();

  // Some set req.auth.ownerId
  if (req?.auth?.ownerId) return String(req.auth.ownerId).trim();

  return null;
}

function requireOwner(req, res) {
  const ownerId = getOwnerIdFromReq(req);
  if (!ownerId) {
    bad(res, 401, "Missing owner context");
    return null;
  }
  return ownerId;
}

const PRICE_BY_PLAN = {
  starter: process.env.STRIPE_PRICE_STARTER,
  pro: process.env.STRIPE_PRICE_PRO,
};

// ✅ Stripe init (fail loud in logs if missing)
const STRIPE_SECRET_KEY = String(process.env.STRIPE_SECRET_KEY || "").trim();
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// ✅ Billing routes are normal HTTP calls, so require owner context auth
if (typeof requireOwnerContext !== "function") {
  console.error("[BILLING] requireOwnerContext middleware missing/invalid export");
  // Don’t throw at import-time in serverless; respond per-request instead
  router.use((req, res) => bad(res, 500, "Auth middleware misconfigured"));
} else {
  router.use(requireOwnerContext);
}

// ✅ Because index.js intentionally has NO global body parsers
router.use(express.json({ limit: "200kb" }));

// -----------------------------
// POST /api/billing/checkout
// -----------------------------
router.post("/checkout", async (req, res) => {
  try {
    // Debug auth context for checkout too (helps when status works but checkout fails)
    console.log("[BILLING_AUTH_CHECKOUT]", {
      ownerId: req.ownerId || req?.auth?.owner_id || null,
      supabaseUserId: req.supabaseUserId || req?.auth?.supabase_user_id || null,
    });

    const ownerId = requireOwner(req, res);
    if (!ownerId) return;

    const appBase = requireAppBaseUrl();
    if (!appBase) return bad(res, 500, "APP_BASE_URL missing/invalid");

    if (!stripe) return bad(res, 500, "STRIPE_SECRET_KEY missing/invalid");

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

      // ✅ Return to authenticated portal billing page
      success_url: `${appBase}/app/settings/billing?session_id={CHECKOUT_SESSION_ID}&plan=${planKey}`,
      cancel_url: `${appBase}/app/settings/billing?canceled=1`,

      client_reference_id: String(ownerId),

      metadata: {
        owner_id: String(ownerId),
        plan_key_requested: String(planKey),
      },
    });

    return res.json({ ok: true, url: session.url });
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
    console.log("[BILLING_AUTH]", {
      ownerId: req.ownerId || req?.auth?.owner_id || null,
      supabaseUserId: req.supabaseUserId || req?.auth?.supabase_user_id || null,
      hasOwnerId: !!(req.ownerId || req?.auth?.owner_id),
    });

    const ownerId = requireOwner(req, res);
    if (!ownerId) return;

    const owner = await db.getOwner(ownerId);
    if (!owner) return bad(res, 404, "Owner not found");

    const linked = true;

    const effective_plan = getEffectivePlanKey(owner); // free|starter|pro|...
    const caps = capsForPlanKey(effective_plan);

    return res.json({
      ok: true,
      linked,
      owner_id: String(ownerId),

      plan_key: String(owner.plan_key || "free").toLowerCase(),
      sub_status: owner.sub_status || null,
      effective_plan,

      cancel_at_period_end: !!owner.cancel_at_period_end,
      current_period_start: owner.current_period_start || null,
      current_period_end: owner.current_period_end || null,

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
    console.log("[BILLING_AUTH_PORTAL]", {
      ownerId: req.ownerId || req?.auth?.owner_id || null,
      supabaseUserId: req.supabaseUserId || req?.auth?.supabase_user_id || null,
    });

    const ownerId = requireOwner(req, res);
    if (!ownerId) return;

    const appBase = requireAppBaseUrl();
    if (!appBase) return bad(res, 500, "APP_BASE_URL missing/invalid");

    if (!stripe) return bad(res, 500, "STRIPE_SECRET_KEY missing/invalid");

    const owner = await db.getOwner(ownerId);
    if (!owner) return bad(res, 404, "Owner not found");

    const customerId = owner?.stripe_customer_id;
    if (!customerId) return bad(res, 400, "No Stripe customer on file");

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appBase}/app/settings/billing`,
    });

    return res.json({ ok: true, url: session.url });
  } catch (e) {
    console.error("[BILLING_PORTAL_ERR]", e?.message || e);
    return bad(res, 500, "portal_failed");
  }
});

module.exports = router;