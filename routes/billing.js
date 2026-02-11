// routes/billing.js
const express = require("express");
const Stripe = require("stripe");
const router = express.Router();

const db = require("../services/postgres");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const { requireDashboardOwner } = require("../middleware/requireDashboardOwner");

// ✅ Billing routes are normal HTTP calls (not Twilio), so use dashboard token auth
router.use(requireDashboardOwner);

// ✅ Because index.js intentionally has NO global body parsers
router.use(express.json({ limit: "200kb" }));

const PRICE_BY_PLAN = {
  starter: process.env.STRIPE_PRICE_STARTER,
  pro: process.env.STRIPE_PRICE_PRO,
};

function requireOwner(req, res) {
  const ownerId = req.ownerId;
  if (!ownerId) {
    res.status(401).json({ error: "Missing owner context" });
    return null;
  }
  return ownerId;
}

router.post("/checkout", async (req, res) => {
  try {
    const ownerId = requireOwner(req, res);
    if (!ownerId) return;

    const { planKey } = req.body || {};
    if (!PRICE_BY_PLAN[planKey]) return res.status(400).json({ error: "Invalid plan" });

    const owner = await db.getOwner(ownerId);
    if (!owner) return res.status(404).json({ error: "Owner not found" });

    let customerId = owner?.stripe_customer_id || null;

    // If switching between test/live, a stored customer may not exist in this mode.
    // Safest: attempt to retrieve; if not found, create a new one and overwrite DB.
    if (customerId) {
      try {
        await stripe.customers.retrieve(customerId);
      } catch (e) {
        customerId = null;
      }
    }

    if (!customerId) {
      const customer = await stripe.customers.create({
        metadata: { ownerId: String(ownerId) },
      });
      customerId = customer.id;
      await db.updateOwnerBilling(ownerId, { stripe_customer_id: customerId });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: PRICE_BY_PLAN[planKey], quantity: 1 }],
      success_url: `${process.env.APP_BASE_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.APP_BASE_URL}/billing/cancel`,
      metadata: { ownerId: String(ownerId), planKey: String(planKey) },
    });

    return res.json({ url: session.url });
  } catch (e) {
    console.error("[BILLING_CHECKOUT_ERR]", e);
    return res.status(500).json({ error: "checkout_failed" });
  }
});

router.get("/status", async (req, res) => {
  try {
    const ownerId = requireOwner(req, res);
    if (!ownerId) return;

    const owner = await db.getOwner(ownerId);
    if (!owner) return res.status(404).json({ error: "Owner not found" });

    return res.json({
      plan_key: owner.plan_key,
      sub_status: owner.sub_status,
      cancel_at_period_end: owner.cancel_at_period_end,
      current_period_start: owner.current_period_start,
      current_period_end: owner.current_period_end,
      stripe_customer_id: !!owner.stripe_customer_id,
    });
  } catch (e) {
    console.error("[BILLING_STATUS_ERR]", e);
    return res.status(500).json({ error: "status_failed" });
  }
});

router.post("/portal", async (req, res) => {
  try {
    const ownerId = requireOwner(req, res);
    if (!ownerId) return;

    const owner = await db.getOwner(ownerId);
    if (!owner) return res.status(404).json({ error: "Owner not found" });

    const customerId = owner?.stripe_customer_id;
    if (!customerId) return res.status(400).json({ error: "No Stripe customer on file" });

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${process.env.APP_BASE_URL}/billing`,
    });

    return res.json({ url: session.url });
  } catch (e) {
    console.error("[BILLING_PORTAL_ERR]", e);
    return res.status(500).json({ error: "portal_failed" });
  }
});

module.exports = router;
