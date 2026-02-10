// routes/billing.js
const express = require('express');
const Stripe = require('stripe');
const router = express.Router();

const db = require('../services/postgres');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const { requireDashboardOwner } = require('../middleware/requireDashboardOwner');

// ✅ Billing routes are normal HTTP calls (not Twilio), so use dashboard token auth
router.use(requireDashboardOwner);

// ✅ Because index.js intentionally has NO global body parsers
router.use(express.json({ limit: '200kb' }));

const PRICE_BY_PLAN = {
  starter: process.env.STRIPE_PRICE_STARTER,
  pro: process.env.STRIPE_PRICE_PRO,
};

function requireOwner(req, res) {
  const ownerId = req.ownerId;
  if (!ownerId) {
    res.status(401).json({ error: 'Missing owner context' });
    return null;
  }
  return ownerId;
}

router.post('/checkout', async (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;

  const { planKey } = req.body;
  if (!PRICE_BY_PLAN[planKey]) return res.status(400).json({ error: 'Invalid plan' });

  const owner = await db.getOwner(ownerId);

  let customerId = owner?.stripe_customer_id || null;
  if (!customerId) {
    const customer = await stripe.customers.create({
      metadata: { ownerId: String(ownerId) },
    });
    customerId = customer.id;
    await db.updateOwnerBilling(ownerId, { stripe_customer_id: customerId });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: PRICE_BY_PLAN[planKey], quantity: 1 }],
    success_url: `${process.env.APP_BASE_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.APP_BASE_URL}/billing/cancel`,
    metadata: { ownerId: String(ownerId), planKey: String(planKey) },
  });

  return res.json({ url: session.url });
});

router.post('/portal', async (req, res) => {
  const ownerId = requireOwner(req, res);
  if (!ownerId) return;

  const owner = await db.getOwner(ownerId);
  const customerId = owner?.stripe_customer_id;

  if (!customerId) return res.status(400).json({ error: 'No Stripe customer on file' });

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${process.env.APP_BASE_URL}/billing`,
  });

  return res.json({ url: session.url });
});

module.exports = router;
