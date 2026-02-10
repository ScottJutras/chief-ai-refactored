// handlers/stripeWebhook.js
const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function priceIdToPlanKey(priceId) {
  if (!priceId) return 'free';
  if (priceId === process.env.STRIPE_PRICE_STARTER) return 'starter';
  if (priceId === process.env.STRIPE_PRICE_PRO) return 'pro';
  return 'free';
}

async function stripeWebhookHandler(req, res) {
  const sig = req.headers['stripe-signature'];
  const whsec = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, whsec);
  } catch (err) {
    console.warn('[STRIPE] webhook signature failed:', err?.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // ✅ idempotency (must implement db.hasStripeEvent/db.insertStripeEvent)
    const seen = await db.hasStripeEvent(event.id);
    if (seen) return res.json({ received: true, deduped: true });
    await db.insertStripeEvent(event.id);

    // ---- Handle events ----
    switch (event.type) {
      case 'checkout.session.completed': {
        // Usually contains customer + subscription when mode=subscription
        const sess = event.data.object;
        const ownerId = sess?.metadata?.ownerId || null;
        const planKey = sess?.metadata?.planKey || null;

        // We still rely on subscription.updated for canonical period_end, etc.
        if (ownerId && sess.customer) {
          await db.updateOwnerBilling(ownerId, {
            stripe_customer_id: String(sess.customer),
            stripe_subscription_id: sess.subscription ? String(sess.subscription) : null,
            plan_key: planKey || null,
          });
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object;

        const customerId = String(sub.customer || '');
        const subscriptionId = String(sub.id || '');
        const status = String(sub.status || '');
        const cancelAtPeriodEnd = !!sub.cancel_at_period_end;

        const priceId =
          sub?.items?.data?.[0]?.price?.id ? String(sub.items.data[0].price.id) : null;

        const planKey = priceIdToPlanKey(priceId);

        const ownerId = await db.findOwnerIdByStripeCustomer(customerId);
        if (ownerId) {
          await db.updateOwnerBilling(ownerId, {
            plan_key: status === 'active' || status === 'trialing' ? planKey : 'free',
            sub_status: status,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            stripe_price_id: priceId,
            cancel_at_period_end: cancelAtPeriodEnd,
            current_period_start: sub.current_period_start ? new Date(sub.current_period_start * 1000) : null,
            current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
          });
        } else {
          console.warn('[STRIPE] subscription event but no owner found for customer', customerId);
        }
        break;
      }

      case 'invoice.payment_failed':
      case 'invoice.payment_succeeded':
        // optional: you can log, or map to owner and update sub_status if you want
        break;

      default:
        // ignore
        break;
    }

    return res.json({ received: true });
  } catch (e) {
    console.error('[STRIPE] webhook handler error:', e?.message);
    // Stripe expects 2xx usually; but if you want retry, return 500.
    return res.status(500).json({ error: 'webhook_failed' });
  }
}

module.exports = { stripeWebhookHandler };
