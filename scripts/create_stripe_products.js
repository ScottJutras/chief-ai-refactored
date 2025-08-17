require('dotenv').config({ path: './config/.env' });
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

/** Helper: find price by lookup_key, else create */
async function ensurePrice({ product, unit_amount, lookup_key }) {
  const existing = await stripe.prices.list({ lookup_keys: [lookup_key], limit: 1 });
  if (existing.data[0]) return existing.data[0];

  return stripe.prices.create({
    currency: 'cad',
    unit_amount,               // in cents (e.g., 2900 = $29.00 CAD)
    recurring: { interval: 'month' },
    product: product.id,
    lookup_key,
    nickname: lookup_key,
    metadata: { plan: lookup_key.split('_')[1] || 'pro' }
  });
}

/** Helper: find product by ID or metadata.tier, else create */
async function ensureProduct({ name, tier, description, limits, flags, productId }) {
  if (productId) {
    try {
      const p = await stripe.products.retrieve(productId);
      if (!p.deleted) return p;
    } catch (_) {}
  }
  // Try by metadata.tier (idempotent-ish)
  const candidates = await stripe.products.list({ active: true, limit: 100 });
  const found = candidates.data.find(p => p.metadata?.tier === tier);
  if (found) return found;

  return stripe.products.create({
    name,
    description,
    metadata: {
      tier,                                // "pro" | "enterprise"
      limits: JSON.stringify(limits),      // compact JSON for gating on backend
      flags: JSON.stringify(flags)
    }
  });
}

(async () => {
  try {
    // ---- PRO ($29 CAD / month)
    const proProduct = await ensureProduct({
      name: 'Chief Pro',
      tier: 'pro',
      description: 'Pro plan for Chief (monthly)',
      limits: {
        jobs: 10,
        employees: 10,
        teamMembers: 3,
        historicalImportYears: 1
      },
      flags: {
        whatsappAccess: true,
        expenseRevenueUnlimited: true,
        aiInsights: 'real-time',
        dashboard: 'advanced',
        storage: 'encrypted-consent',
        recurringBills: true,
        reports: 'quarterly',
        quoteInvoiceReceipt: true,
        hubIntegrations: 'qb_xero_wave',
        bookkeeperSeat: true
      }
    });

    const proMonthly = await ensurePrice({
      product: proProduct,
      unit_amount: 2900,           // $29.00 CAD
      lookup_key: 'chief_pro_monthly_cad'
    });

    // ---- ENTERPRISE ($99 CAD / month)
    const entProduct = await ensureProduct({
      name: 'Chief Enterprise',
      tier: 'enterprise',
      description: 'Enterprise plan for Chief (monthly)',
      limits: {
        jobs: -1,                 // -1 = unlimited (your app logic)
        employees: 50,
        teamMembers: 10,
        historicalImportYears: 3
      },
      flags: {
        whatsappAccess: true,
        expenseRevenueUnlimited: true,
        aiInsights: 'real-time-plus',
        dashboard: 'advanced-plus',
        storage: 'encrypted-compliance',
        recurringBills: true,
        reports: 'weekly_monthly_quarterly',
        quoteInvoiceReceipt: true,
        hubIntegrations: 'qb_xero_wave',
        bookkeeperSeat: true
      }
    });

    const entMonthly = await ensurePrice({
      product: entProduct,
      unit_amount: 9900,          // $99.00 CAD
      lookup_key: 'chief_enterprise_monthly_cad'
    });

    console.log('✅ Created/verified:');
    console.log({
      pro_product_id: proProduct.id,
      pro_price_id: proMonthly.id,
      enterprise_product_id: entProduct.id,
      enterprise_price_id: entMonthly.id
    });
  } catch (err) {
    console.error('Stripe setup failed:', err?.message || err);
    process.exit(1);
  }
})();