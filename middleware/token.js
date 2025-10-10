const { query } = require('../services/postgres');
const { releaseLock } = require('./lock');

async function checkTokenLimit(userId, tier) {
  console.log('[DEBUG] checkTokenLimit called:', { userId, tier });
  const limits = {
    Free: { messages: 100, aiCalls: 10 },
    basic: { messages: 1000, aiCalls: 100 },
    Pro: { messages: 5000, aiCalls: 500 },
    Enterprise: { messages: Infinity, aiCalls: Infinity }
  };
  try {
    const res = await query(
      `SELECT token_usage FROM users WHERE user_id = $1`,
      [userId]
    );
    const usage = res.rows[0]?.token_usage || { messages: 0, aiCalls: 0 };
    const { messages: msgLimit, aiCalls: aiLimit } = limits[tier] || limits.basic;
    const exceeded = usage.messages > msgLimit || usage.aiCalls > aiLimit;
    console.log(`[DEBUG] Token check for ${userId} (${tier}): ${exceeded ? 'exceeded' : 'within limits'}`);
    return { exceeded };
  } catch (error) {
    console.error('[ERROR] checkTokenLimit failed for', userId, ':', error.message);
    throw error;
  }
}

async function updateUserTokenUsage(userId, { messages = 0, aiCalls = 0 }) {
  console.log('[DEBUG] updateUserTokenUsage called:', { userId, messages, aiCalls });
  try {
    const res = await query(
      `UPDATE users
       SET token_usage = COALESCE(token_usage, '{}')::jsonb || $1::jsonb
       WHERE user_id = $2
       RETURNING token_usage`,
      [JSON.stringify({ messages, aiCalls }), userId]
    );
    console.log('[DEBUG] updateUserTokenUsage success:', res.rows[0]?.token_usage);
  } catch (error) {
    console.error('[ERROR] updateUserTokenUsage failed for', userId, ':', error.message);
    throw error;
  }
}

async function tokenMiddleware(req, res, next) {
  const raw = req.ownerId || req.body.userId || req.body.From;
  const userId = raw ? raw.replace(/\D/g, '') : null;
  const isWebhook = Boolean(req.body.From && req.ownerId);
  console.log('[DEBUG] tokenMiddleware invoked:', { userId, isWebhook });

  if (!userId) {
    console.error('[ERROR] Missing userId');
    if (isWebhook) {
      return res.send(`<Response><Message>⚠️ Invalid user ID. Please try again.</Message></Response>`);
    }
    return res.status(400).json({ error: 'Missing user ID' });
  }

  try {
    const res = await query('SELECT subscription_tier, trial_end, token_usage FROM users WHERE user_id = $1', [userId]);
    if (!res.rows[0]) {
      console.error(`[ERROR] No profile for ${userId}`);
      if (isWebhook) {
        return res.send(`<Response><Message>⚠️ User not found. Please start onboarding.</Message></Response>`);
      }
      return res.status(404).json({ error: 'User not found' });
    }

    const user = res.rows[0];
    req.tokenUsage = user.token_usage || { messages: 0, aiCalls: 0 };
    const tier = user.subscription_tier || 'basic';

    if (!user.subscription_tier) {
      await query(
        `UPDATE users
         SET subscription_tier = $1, token_usage = $2
         WHERE user_id = $3`,
        ['basic', JSON.stringify({ messages: 0, aiCalls: 0 }), userId]
      );
      console.log(`[DEBUG] Initialized tier/basic usage for ${userId}`);
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

    await updateUserTokenUsage(userId, {
      messages: didMessage ? 1 : 0,
      aiCalls: didAICall ? 1 : 0
    });

    const { exceeded } = await checkTokenLimit(userId, tier);
    if (exceeded) {
      console.log(`[DEBUG] ${userId} exceeded tokens`);
      if (isWebhook) {
        await releaseLock(`lock:${userId}`);
        return res.send(`<Response><Message>⚠️ Trial limit reached! Reply 'Upgrade' to continue.</Message></Response>`);
      }
      return res.status(403).json({ error: 'Trial limit reached' });
    }

    req.tokenUsage = user.token_usage;
    next();
  } catch (error) {
    console.error('[ERROR] tokenMiddleware for', userId, ':', error.message);
    if (isWebhook) {
      await releaseLock(`lock:${userId}`);
      return res.send(`<Response><Message>⚠️ An error occurred. Please try again later.</Message></Response>`);
    }
    return res.status(500).json({ error: 'Token processing failed' });
  }
}

module.exports = { tokenMiddleware, updateUserTokenUsage, checkTokenLimit };