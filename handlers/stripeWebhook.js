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

/**
 * Robust price selection:
 * - Prefer the first recurring price on the subscription (future-proof for addons)
 * - Fallback to the first item if needed
 */
function subscriptionToPriceId(sub) {
  const items = Array.isArray(sub?.items?.data) ? sub.items.data : [];
  if (!items.length) return null;

  const recurringItem = items.find((it) => it?.price?.recurring);
  const price = recurringItem?.price || items[0]?.price || null;

  const id = price?.id ? String(price.id) : null;
  return id && id.trim() ? id.trim() : null;
}

/**
 * Convert Stripe unix seconds → JS Date (or null)
 */
function unixToDate(sec) {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec <= 0) return null;
  return new Date(sec * 1000);
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
    /**
     * ✅ Race-proof idempotency:
     * Your insertStripeEvent should be:
     *   INSERT ... ON CONFLICT DO NOTHING
     * and return whether it inserted.
     *
     * If you haven't updated insertStripeEvent to return a boolean,
     * this will still work if it returns { inserted: true/false } or boolean.
     */
    let inserted = true;
    try {
      const r = await db.insertStripeEvent(event.id, event.type);
      // Accept boolean OR object shapes, fail-open if unknown
      inserted =
        typeof r === "boolean"
          ? r
          : r && typeof r === "object" && "inserted" in r
            ? !!r.inserted
            : true;
    } catch (e) {
      // If insert fails for some reason, do NOT crash; fail-open and continue processing.
      console.warn("[STRIPE] insertStripeEvent failed (continuing):", e?.message);
      inserted = true;
    }

    if (!inserted) {
      return res.json({ received: true, deduped: true });
    }

    switch (event.type) {
      case "checkout.session.completed": {
        const sess = event.data.object;

        const ownerId = (
  (sess?.client_reference_id ? String(sess.client_reference_id) : "") ||
  (sess?.metadata?.owner_id ? String(sess.metadata.owner_id) : "") ||
  (sess?.metadata?.ownerId ? String(sess.metadata.ownerId) : "")
).trim() || null;


        if (ownerId && sess?.customer) {
          const patch = { stripe_customer_id: String(sess.customer) };
          if (sess.subscription) patch.stripe_subscription_id = String(sess.subscription);

          // ✅ DO NOT set plan_key here (entitlements only come from subscription events)
          await db.updateOwnerBilling(ownerId, patch);
        }

        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object;

        const customerId = String(sub.customer || "").trim();
        const subscriptionId = String(sub.id || "").trim();
        const status = String(sub.status || "").trim();
        const cancelAtPeriodEnd = !!sub.cancel_at_period_end;

        // ✅ recurring-first
        const priceId = subscriptionToPriceId(sub);
        const mappedPlanKey = priceIdToPlanKey(priceId);

        // ✅ Deterministic owner mapping: customerId → owner row
        const ownerId = await db.findOwnerIdByStripeCustomer(customerId);
        if (!ownerId) {
          console.warn("[STRIPE] subscription event but no owner found for customer", customerId, {
            eventType: event.type,
            subscriptionId,
          });
          break;
        }

        const isEntitled = status === "active" || status === "trialing";

        // Warn if entitled but we can't map the price → plan
        if (isEntitled && mappedPlanKey === "free" && priceId) {
          console.warn("[STRIPE] Unknown price ID for entitled subscription", {
            priceId,
            subscriptionId,
            customerId,
            status,
            eventType: event.type,
          });
        }

        // ✅ No extra Stripe API calls. Use event payload directly.
        const periodStart = unixToDate(sub.current_period_start);
        const periodEnd = unixToDate(sub.current_period_end);

        await db.updateOwnerBilling(ownerId, {
          plan_key: isEntitled ? mappedPlanKey : "free",
          sub_status: status,
          stripe_customer_id: customerId || null,
          stripe_subscription_id: subscriptionId || null,
          stripe_price_id: priceId || null,
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
