const express = require('express');
const { Pool } = require('pg');
const { userProfileMiddleware } = require('../middleware/userProfile');
const { tokenMiddleware } = require('../middleware/token');
const { errorMiddleware } = require('../middleware/error');

const router = express.Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const DEEP_DIVE_TIERS = {
  BASIC: { price: 49, name: 'Basic Report', features: ['historical'] },
  FULL: { price: 99, name: 'Full Deep Dive', features: ['historical', 'forecast_1yr'] },
  ENTERPRISE: { price: 199, name: 'Enterprise Custom', features: ['historical', 'forecast_10yr', 'goals'] }
};

async function generateDeepDiveReport({ expenses, revenues, userProfile, tier }) {
  const report = {
    user_id: userProfile.user_id,
    tier: tier.name,
    created_at: new Date().toISOString(),
    historical: { expenses: [], revenues: [] },
    forecast_1yr: tier.features.includes('forecast_1yr') ? {} : null,
    forecast_10yr: tier.features.includes('forecast_10yr') ? {} : null,
    goals: tier.features.includes('goals') ? userProfile.goalProgress : null
  };

  report.historical.expenses = expenses.map(e => ({
    date: e.date,
    item: e.item,
    amount: e.amount,
    store: e.store,
    category: e.category
  }));
  report.historical.revenues = revenues.map(r => ({
    date: r.date,
    description: r.description,
    amount: r.amount,
    source: r.source
  }));

  if (tier.features.includes('forecast_1yr')) {
    const totalExpenses = expenses.reduce((sum, e) => sum + parseFloat(e.amount.replace('$', '')), 0);
    const totalRevenues = revenues.reduce((sum, r) => sum + parseFloat(r.amount.replace('$', '')), 0);
    report.forecast_1yr = {
      projectedExpenses: totalExpenses * 1.1,
      projectedRevenues: totalRevenues * 1.2
    };
  }

  if (tier.features.includes('forecast_10yr')) {
    report.forecast_10yr = {
      projectedExpenses: report.forecast_1yr.projectedExpenses * 10,
      projectedRevenues: report.forecast_1yr.projectedRevenues * 10
    };
  }

  await pool.query(
    `INSERT INTO reports (user_id, tier, report_data, created_at)
     VALUES ($1, $2, $3, $4)`,
    [userProfile.user_id, tier.name, JSON.stringify(report), new Date()]
  );

  return { report, reportUrl: `https://chief-ai-refactored.vercel.app/reports/${userProfile.user_id}/${Date.now()}` };
}

router.post('/', userProfileMiddleware, tokenMiddleware, async (req, res, next) => {
  const { tier = 'BASIC' } = req.body;
  const { userProfile, ownerId } = req;

  if (!DEEP_DIVE_TIERS[tier]) {
    throw new Error('Invalid tier. Use: BASIC, FULL, ENTERPRISE');
  }

  try {
    const expenseResult = await pool.query(`SELECT * FROM transactions WHERE owner_id = $1 AND type IN ('expense', 'bill')`, [ownerId]);
    const revenueResult = await pool.query(`SELECT * FROM transactions WHERE owner_id = $1 AND type = 'revenue'`, [ownerId]);
    const expenses = expenseResult.rows;
    const revenues = revenueResult.rows;

    if (!expenses.length && !revenues.length) {
      throw new Error('No financial data provided');
    }

    const { report, reportUrl } = await generateDeepDiveReport({
      expenses,
      revenues,
      userProfile,
      tier: DEEP_DIVE_TIERS[tier]
    });

    await pool.query(
      `UPDATE users SET subscription_tier = $1, trial_start = $2, trial_end = $3, token_usage = $4 WHERE user_id = $5`,
      [
        userProfile.subscriptionTier || 'Pro',
        userProfile.trialStart || new Date().toISOString(),
        userProfile.trialEnd || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        JSON.stringify({ messages: (userProfile.tokenUsage?.messages || 0) + 1, aiCalls: (userProfile.tokenUsage?.aiCalls || 0) + 1 }),
        ownerId
      ]
    );

    res.json({ reportUrl, message: 'Deep Dive report generated successfully' });
  } catch (error) {
    console.error('[ERROR] Deep Dive processing failed:', error.message);
    next(error);
  }
}, errorMiddleware);

module.exports = router;