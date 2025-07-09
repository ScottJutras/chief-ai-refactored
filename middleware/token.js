const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function updateUserTokenUsage(userId, { messages = 0, aiCalls = 0 }) {
  console.log(`[DEBUG] updateUserTokenUsage called for ${userId}: messages+${messages}, aiCalls+${aiCalls}`);
  try {
    const res = await pool.query(
      `UPDATE users
       SET token_usage = token_usage + $1::jsonb
       WHERE user_id = $2
       RETURNING token_usage`,
      [JSON.stringify({ messages, aiCalls }), userId]
    );
    console.log(`[✅] Updated token usage for ${userId}:`, res.rows[0]?.token_usage);
  } catch (error) {
    console.error(`[ERROR] updateUserTokenUsage failed for ${userId}:`, error.message);
    throw error;
  }
}

async function checkTokenLimit(userId, tier) {
  const limits = {
    Free: { messages: 100, aiCalls: 10 },
    basic: { messages: 1000, aiCalls: 100 },
    Pro: { messages: 5000, aiCalls: 500 },
    Enterprise: { messages: Infinity, aiCalls: Infinity }
  };
  try {
    const res = await pool.query(
      `SELECT token_usage FROM users WHERE user_id = $1`,
      [userId]
    );
    const usage = res.rows[0]?.token_usage || { messages: 0, aiCalls: 0 };
    const { messages: msgLimit, aiCalls: aiLimit } = limits[tier] || limits.basic;
    const exceeded = usage.messages > msgLimit || usage.aiCalls > aiLimit;
    console.log(`[✅] Token check for ${userId} (${tier}): ${exceeded ? '❌ exceeded' : '✅ within limits'}`);
    return { exceeded };
  } catch (error) {
    console.error(`[ERROR] checkTokenLimit failed for ${userId}:`, error.message);
    throw error;
  }
}

async function tokenMiddleware(req, res, next) {
  const raw = req.ownerId || req.body.userId;
  const userId = raw ? raw.replace(/\D/g, '') : null;
  const isWebhook = Boolean(req.body.From && req.ownerId);

  if (!userId) {
    console.error('[ERROR] Missing userId');
    if (isWebhook) {
      return res.send(`<Response><Message>⚠️ Invalid user ID. Please try again.</Message></Response>`);
    }
    return res.status(400).json({ error: 'Missing user ID' });
  }

  try {
    const res = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]);
    if (!res.rows[0]) {
      console.error(`[ERROR] No profile for ${userId}`);
      if (isWebhook) {
        return res.send(`<Response><Message>⚠️ User not found. Please start onboarding.</Message></Response>`);
      }
      return res.status(404).json({ error: 'User not found' });
    }

    const data = res.rows[0];
    const ownerId = data.owner_id || userId;
    let tier = data.subscription_tier || 'basic';

    if (!data.subscription_tier) {
      await pool.query(
        `UPDATE users
         SET subscription_tier = $1, token_usage = $2
         WHERE user_id = $3`,
        ['basic', JSON.stringify({ messages: 0, aiCalls: 0 }), userId]
      );
      console.log(`[✅] Initialized tier/basic usage for ${userId}`);
    }

    const isDeepDive = req.path.includes('/deep-dive');
    const didMessage = isWebhook && Boolean(req.body.Body);
    const didAICall =
      isDeepDive ||
      (didMessage && (
         req.body.Body.includes('$') ||
         req.body.Body.toLowerCase().startsWith('quote') ||
         Boolean(req.body.MediaUrl0)
       ));

    await updateUserTokenUsage(ownerId, {
      messages: didMessage ? 1 : 0,
      aiCalls: didAICall ? 1 : 0
    });

    const { exceeded } = await checkTokenLimit(ownerId, tier);
    if (exceeded) {
      console.log(`[⚠️] ${ownerId} exceeded tokens`);
      if (isWebhook) {
        await pool.query('DELETE FROM locks WHERE lock_key = $1', [`lock:${userId}`]);
        return res.send(`<Response><Message>⚠️ Trial limit reached! Reply 'Upgrade' to continue.</Message></Response>`);
      }
      return res.status(403).json({ error: 'Trial limit reached' });
    }

    next();
  } catch (error) {
    console.error(`[ERROR] tokenMiddleware for ${userId}:`, error.message);
    if (isWebhook) {
      await pool.query('DELETE FROM locks WHERE lock_key = $1', [`lock:${userId}`]);
      return res.send(`<Response><Message>⚠️ An error occurred. Please try again later.</Message></Response>`);
    }
    return res.status(500).json({ error: 'Token processing failed' });
  }
}

module.exports = { tokenMiddleware };