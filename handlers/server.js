// handlers/server.js
// COMPLETE DROP-IN (aligned with your current folder layout + Stripe raw-body requirements)
//
// Key alignments:
// - Fixes postgres require path (handlers/* should import ../services/*, not ./services/*).
// - Keeps Stripe webhook FIRST with raw body (required for signature verification).
// - Adds `app.set('trust proxy', 1)` for rate-limit correctness behind proxies (Render/Fly/Cloud Run/etc).
// - Makes webhook handler idempotent-safe-ish (catches missing users, missing metadata).
// - Avoids crashing if Twilio sendMessage isn’t available.
// - Keeps your request logging but avoids dumping huge bodies / sensitive headers by default.

require('dotenv').config({ path: './config/.env' });

const express = require('express');
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');

// IMPORTANT: server.js is under /handlers, your services are at /services
// so this must be ../services/postgres (NOT ./services/postgres)
const pg = require('../services/postgres');
const query = pg.query || pg.pool?.query || pg.db?.query;
const saveUserProfile = pg.saveUserProfile;

console.log('[BOOT] Starting Chief AI...');

const app = express();

// If you’re behind a proxy (most hosted envs), rate-limit & IP detection need this.
app.set('trust proxy', 1);

// Log incoming requests (keep, but safer)
app.use((req, res, next) => {
  console.log(`[INCOMING] ${req.method} ${req.originalUrl}`);
  try {
    const safeHeaders = { ...req.headers };
    if (safeHeaders.authorization) safeHeaders.authorization = '[REDACTED]';
    if (safeHeaders['x-twilio-signature']) safeHeaders['x-twilio-signature'] = '[REDACTED]';
    if (safeHeaders['stripe-signature']) safeHeaders['stripe-signature'] = '[REDACTED]';
    console.log('  headers:', JSON.stringify(safeHeaders));
  } catch {}
  next();
});

/* ---------------- Stripe webhook FIRST (raw body) ---------------- */

const stripeWebhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
});

app.post(
  '/api/stripe-webhook',
  stripeWebhookLimiter,
  bodyParser.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];

    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      console.error('[STRIPE] Missing STRIPE_WEBHOOK_SECRET');
      return res.status(500).send('Server misconfigured');
    }
    if (!query || typeof query !== 'function') {
      console.error('[STRIPE] Postgres query() not available');
      return res.status(500).send('DB misconfigured');
    }
    if (!saveUserProfile || typeof saveUserProfile !== 'function') {
      console.error('[STRIPE] saveUserProfile() not available');
      return res.status(500).send('DB misconfigured');
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('[ERROR] Stripe webhook signature error:', err?.message);
      return res.status(400).send(`Webhook Error: ${err?.message}`);
    }

    try {
      switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
          const subscription = event.data.object;

          const plan =
            subscription?.items?.data?.[0]?.price?.metadata?.plan ||
            subscription?.items?.data?.[0]?.price?.nickname ||
            'starter';

          const userRes = await query(
            `SELECT * FROM users WHERE stripe_customer_id=$1`,
            [subscription.customer]
          );

          const user = userRes?.rows?.[0] || null;
          if (user) {
            await saveUserProfile({
              ...user,
              subscription_tier: String(plan || 'starter').toLowerCase(),
              stripe_subscription_id: subscription.id
            });
          } else {
            console.warn('[STRIPE] No user for stripe_customer_id', subscription.customer);
          }
          break;
        }

        case 'customer.subscription.deleted': {
          const deletedSub = event.data.object;

          const userRes = await query(
            `SELECT * FROM users WHERE stripe_subscription_id=$1`,
            [deletedSub.id]
          );

          const user = userRes?.rows?.[0] || null;
          if (user) {
            await saveUserProfile({
              ...user,
              subscription_tier: 'starter',
              stripe_subscription_id: null
            });
          } else {
            console.warn('[STRIPE] No user for deleted subscription', deletedSub.id);
          }
          break;
        }

        case 'invoice.paid': {
          const invoice = event.data.object;

          const userRes = await query(
            `SELECT * FROM users WHERE stripe_customer_id=$1`,
            [invoice.customer]
          );

          const user = userRes?.rows?.[0] || null;
          if (user) {
            try {
              const tw = require('../services/twilio');
              const sendMessage = tw.sendMessage || null;
              if (typeof sendMessage === 'function') {
                const amt = Number(invoice.amount_paid || 0) / 100;
                await sendMessage(
                  user.user_id,
                  `✅ Payment of ${amt.toFixed(2)} CAD succeeded for your ${user.subscription_tier || 'starter'} plan.`
                );
              }
            } catch (e) {
              console.warn('[STRIPE] invoice.paid twilio notify failed (ignored):', e?.message);
            }
          }
          break;
        }

        case 'invoice.payment_failed': {
          const failedInvoice = event.data.object;

          const userRes = await query(
            `SELECT * FROM users WHERE stripe_customer_id=$1`,
            [failedInvoice.customer]
          );

          const user = userRes?.rows?.[0] || null;
          if (user) {
            try {
              const tw = require('../services/twilio');
              const sendMessage = tw.sendMessage || null;
              if (typeof sendMessage === 'function') {
                await sendMessage(
                  user.user_id,
                  `⚠️ Payment failed for your ${user.subscription_tier || 'starter'} plan. Please update your payment method.`
                );
              }
            } catch (e) {
              console.warn('[STRIPE] invoice.payment_failed twilio notify failed (ignored):', e?.message);
            }
          }
          break;
        }

        default:
          // no-op
          break;
      }

      return res.status(200).json({ received: true });
    } catch (err) {
      console.error('[ERROR] Stripe webhook handler error:', err?.message);
      // Stripe expects 2xx to stop retries; but if we truly failed processing, return 500 to retry.
      return res.status(500).send('Webhook handler failed');
    }
  }
);

/* ---------------- General parsers AFTER Stripe raw endpoint ---------------- */

app.use(bodyParser.urlencoded({ extended: false, limit: '50mb' }));
app.use(bodyParser.json({ limit: '50mb' }));

/* ---------------- Routes ---------------- */

app.get('/', (req, res) => {
  console.log('[DEBUG] GET /');
  res.send('👋 Chief AI Webhook Server is up!');
});

// NOTE: server.js is under /handlers, routes are under /routes (not /handlers/routes)
// If your project actually has handlers/routes, change these back. This matches your posted line.
app.use('/api/webhook', require('../routes/webhook'));
app.use('/parse', require('../routes/parse'));
app.use('/deep-dive', require('../routes/deepDive'));
app.use('/dashboard', require('../routes/dashboard'));

/* ---------------- 404 + error safety ---------------- */

app.use((req, res) => {
  console.warn(`[404] No route for ${req.method} ${req.originalUrl}`);
  res.status(404).send('Not Found');
});

// Express error handler (last)
app.use((err, req, res, next) => {
  console.error('[SERVER] Unhandled error:', err?.message);
  res.status(500).send('Server error');
});

/* ---------------- Listen ---------------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});

module.exports = app; // harmless in node; helpful if you ever wrap with serverless-http
