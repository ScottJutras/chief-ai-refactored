// handlers/stripeWebhook.js
const Stripe = require("stripe");
const db = require("../services/postgres");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Map a Stripe price.id → canonical plan_key.
 * IMPORTANT: Env vars must match the current Stripe mode (test vs live).
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

  // ✅ event logging MUST happen after constructEvent
  console.log("[STRIPE_EVT]", {
    type: event?.type || null,
    id: event?.id || null,
    obj: event?.data?.object?.object || null,
    subId: event?.data?.object?.id || null,
    customer: event?.data?.object?.customer || null,
  });

  try {
    // ✅ idempotency (schema: public.stripe_events(event_id, received_at, event_type))
    const seen = await db.hasStripeEvent(event.id);
    if (seen) return res.json({ received: true, deduped: true });

    // Record event_type so we can debug what’s arriving
    await db.insertStripeEvent(event.id, event.type);

    switch (event.type) {
      case "checkout.session.completed": {
        const sess = event.data.object;

        const ownerId = sess?.metadata?.ownerId ? String(sess.metadata.ownerId) : null;
        const planKeyFromMeta = sess?.metadata?.planKey ? String(sess.metadata.planKey) : null;

        if (ownerId && sess?.customer) {
          // ✅ Never null-out subscription id here; only set if present
          const patch = { stripe_customer_id: String(sess.customer) };
          if (sess.subscription) patch.stripe_subscription_id = String(sess.subscription);

          // Only set plan_key if provided (never null it out)
          if (planKeyFromMeta) patch.plan_key = planKeyFromMeta;

          await db.updateOwnerBilling(ownerId, patch);
        }
        break;
      }

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

        const ownerId = await db.findOwnerIdByStripeCustomer(customerId);
        if (!ownerId) {
          console.warn("[STRIPE] subscription event but no owner found for customer", customerId, {
            eventType: event.type,
            subscriptionId,
          });
          break;
        }

        const isEntitled = status === "active" || status === "trialing";

        // Optional hardening: warn if an entitled sub has an unknown price id
        if (isEntitled && mappedPlanKey === "free" && priceId) {
          console.warn("[STRIPE] Unknown price ID for entitled subscription", {
            priceId,
            subscriptionId,
            customerId,
            status,
            eventType: event.type,
          });
        }

        // ✅ Period dates (robust): try subscription → fallback invoice line period
        let periodStart = null;
        let periodEnd = null;

        try {
          if (subscriptionId && isEntitled) {
            const fullSub = await stripe.subscriptions.retrieve(subscriptionId);

            const cps = fullSub?.current_period_start ?? null;
            const cpe = fullSub?.current_period_end ?? null;

            if (cps && cpe) {
              periodStart = new Date(cps * 1000);
              periodEnd = new Date(cpe * 1000);
            } else {
              // 🔁 Fallback: derive from latest invoice line period
              const invs = await stripe.invoices.list({
                subscription: subscriptionId,
                limit: 1,
              });
              const inv = invs?.data?.[0] || null;

              const linePeriod = inv?.lines?.data?.[0]?.period || null;
              const ps = linePeriod?.start ?? null;
              const pe = linePeriod?.end ?? null;

              periodStart = ps ? new Date(ps * 1000) : null;
              periodEnd = pe ? new Date(pe * 1000) : null;
            }
          } else {
            // fallback to event payload
            periodStart = sub.current_period_start ? new Date(sub.current_period_start * 1000) : null;
            periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
          }
        } catch (e) {
          console.warn("[STRIPE] failed to derive period dates", {
            subscriptionId,
            status,
            msg: e?.message,
          });

          // final fallback to payload if anything fails
          periodStart = sub.current_period_start ? new Date(sub.current_period_start * 1000) : null;
          periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
        }

        await db.updateOwnerBilling(ownerId, {
          plan_key: isEntitled ? mappedPlanKey : "free",
          sub_status: status,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          stripe_price_id: priceId,
          cancel_at_period_end: cancelAtPeriodEnd,
          current_period_start: periodStart,
          current_period_end: periodEnd,
        });

        break;
      }

      case "invoice.paid":
      case "invoice.payment_failed": {
        // Optional: add logging or billing state transitions later
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
