const express = require('express');
const bodyParser = require('body-parser');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const rateLimit = require('express-rate-limit');

require('dotenv').config({ path: './config/.env' });

console.log('[BOOT] Starting Chief AI...');

const app = express();

app.use((req, res, next) => {
  console.log(`[INCOMING] ${req.method} ${req.originalUrl}`);
  console.log('  headers:', JSON.stringify(req.headers));
  next();
});

app.use(bodyParser.urlencoded({ extended: false, limit: '50mb' }));
app.use(bodyParser.json({ limit: '50mb' }));

// Stripe webhook with rate-limiting
const stripeWebhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // 100 requests per window
});

app.post('/api/stripe-webhook', stripeWebhookLimiter, bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    const { saveUserProfile } = require('./services/postgres');
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        const subscription = event.data.object;
        const user = await pool.query(
          `SELECT * FROM users WHERE stripe_customer_id=$1`,
          [subscription.customer]
        );
        if (user.rows[0]) {
          await saveUserProfile({
            ...user.rows[0],
            subscription_tier: subscription.items.data[0].price.metadata.plan || 'starter',
            stripe_subscription_id: subscription.id
          });
        }
        break;
      case 'customer.subscription.deleted':
        const deletedSub = event.data.object;
        const deletedUser = await pool.query(
          `SELECT * FROM users WHERE stripe_subscription_id=$1`,
          [deletedSub.id]
        );
        if (deletedUser.rows[0]) {
          await saveUserProfile({
            ...deletedUser.rows[0],
            subscription_tier: 'starter',
            stripe_subscription_id: null
          });
        }
        break;
      case 'invoice.paid':
        const invoice = event.data.object;
        const paidUser = await pool.query(
          `SELECT * FROM users WHERE stripe_customer_id=$1`,
          [invoice.customer]
        );
        if (paidUser.rows[0]) {
          const { sendMessage } = require('./services/twilio');
          await sendMessage(paidUser.rows[0].user_id, `✅ Payment of ${invoice.amount_paid / 100} CAD succeeded for your ${paidUser.rows[0].subscription_tier} plan.`);
        }
        break;
      case 'invoice.payment_failed':
        const failedInvoice = event.data.object;
        const failedUser = await pool.query(
          `SELECT * FROM users WHERE stripe_customer_id=$1`,
          [failedInvoice.customer]
        );
        if (failedUser.rows[0]) {
          const { sendMessage } = require('./services/twilio');
          await sendMessage(failedUser.rows[0].user_id, `⚠️ Payment failed for your ${failedUser.rows[0].subscription_tier} plan. Please update your payment method.`);
        }
        break;
    }
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[ERROR] Stripe webhook error:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

app.get('/', (req, res) => {
  console.log('[DEBUG] GET /');
  res.send('👋 Chief AI Webhook Server is up!');
});

app.use('/api/webhook', require('./routes/webhook'));
app.use('/parse', require('./routes/parse'));
app.use('/deep-dive', require('./routes/deepDive'));
app.use('/dashboard', require('./routes/dashboard'));

app.use((req, res) => {
  console.warn(`[404] No route for ${req.method} ${req.originalUrl}`);
  res.status(404).send('Not Found');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});