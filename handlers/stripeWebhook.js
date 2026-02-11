// handlers/stripeWebhook.js
const Stripe = require("stripe");
const db = require("../services/postgres");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Map a Stripe price.id → canonical plan_key.
 * IMPORTANT: This relies on the env vars matching the current Stripe mode (test vs live).
 */
function priceIdToPlanKey(priceId) {
  if (!priceId) return "free";
  if (priceId === process.env.STRIPE_PRICE_STARTER) return "starter";
  if (priceId === process.env.STRIPE_PRICE_PRO) return "pro";
  return "free";
}

async function stripeWebhookHandler(req, res) {
  const sig = req.headers["stripe-signature"];
  const whsec = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    // req.body MUST be the raw Buffer (route must use express.raw({ type: "application/json" }))
    event = stripe.webhooks.constructEvent(req.body, sig, whsec);
  } catch (err) {
    console.warn("[STRIPE] webhook signature failed:", err?.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // ✅ idempotency (backed by public.stripe_events(event_id, received_at))
    const seen = await db.hasStripeEvent(event.id);
    if (seen) return res.json({ received: true, deduped: true });
    await db.insertStripeEvent(event.id);

    switch (event.type) {
      /**
       * Checkout completion: helpful to ensure customer is linked + subscription id captured.
       * NOTE: Stripe sometimes includes sess.subscription; sometimes you rely on subscription.created/updated.
       */
      case "checkout.session.completed": {
        const sess = event.data.object;
        const ownerId = sess?.metadata?.ownerId ? String(sess.metadata.ownerId) : null;
        const planKeyFromMeta = sess?.metadata?.planKey ? String(sess.metadata.planKey) : null;

        if (ownerId && sess?.customer) {
          // Build patch safely (do NOT set plan_key to null)
          const patch = {
            stripe_customer_id: String(sess.customer),
            stripe_subscription_id: sess.subscription ? String(sess.subscription) : null,
          };

          // Optional: set plan_key if you intentionally want checkout meta to set it.
          // Safer: only set if present (never null it out).
          if (planKeyFromMeta) patch.plan_key = planKeyFromMeta;

          await db.updateOwnerBilling(ownerId, patch);
        }
        break;
      }

      /**
       * Subscription lifecycle: this is the canonical place to set entitlement + plan_key.
       */
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object;

        const customerId = String(sub.customer || "");
        const subscriptionId = String(sub.id || "");
        const status = String(sub.status || "");
        const cancelAtPeriodEnd = !!sub.cancel_at_period_end;

        const priceId = sub?.items?.data?.[0]?.price?.id
          ? String(sub.items.data[0].price.id)
          : null;

        const mappedPlanKey = priceIdToPlanKey(priceId);

        // ownerId is resolved from our DB using the customer id
        const ownerId = await db.findOwnerIdByStripeCustomer(customerId);

        if (!ownerId) {
          console.warn("[STRIPE] subscription event but no owner found for customer", customerId, {
            eventType: event.type,
            subscriptionId,
          });
          break;
        }

        const isEntitled = status === "active" || status === "trialing";

        // If entitled but price id is unknown, warn loudly (prevents silent downgrade to free)
        if (isEntitled && mappedPlanKey === "free" && priceId) {
          console.warn("[STRIPE] entitled subscription has unmapped priceId; defaulting plan_key to free", {
            ownerId: String(ownerId),
            customerId,
            subscriptionId,
            status,
            priceId,
            STRIPE_PRICE_STARTER: process.env.STRIPE_PRICE_STARTER,
            STRIPE_PRICE_PRO: process.env.STRIPE_PRICE_PRO,
          });
        }

        await db.updateOwnerBilling(ownerId, {
          plan_key: isEntitled ? mappedPlanKey : "free",
          sub_status: status,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          stripe_price_id: priceId,
          cancel_at_period_end: cancelAtPeriodEnd,
          current_period_start: sub.current_period_start
            ? new Date(sub.current_period_start * 1000)
            : null,
          current_period_end: sub.current_period_end
            ? new Date(sub.current_period_end * 1000)
            : null,
        });

        break;
      }

      /**
       * Invoice events are optional; useful for “paid vs failed” state,
       * but subscription.updated generally covers entitlement.
       */
      case "invoice.paid":
      case "invoice.payment_failed": {
        // No-op for now (keep for future hooks / logging if desired)
        break;
      }

      default:
        break;
    }

    return res.json({ received: true });
  } catch (e) {
    console.error("[STRIPE] webhook handler error:", e?.message || e);
    return res.status(500).json({ error: "webhook_failed" });
  }
}

module.exports = { stripeWebhookHandler };
