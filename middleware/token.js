const { db } = require('../services/firebase');
const { sendTemplateMessage } = require('../services/twilio');

/**
 * Token management middleware for Express routes.
 * Updates token usage, checks subscription tier limits, and enforces restrictions.
 * @param {Object} req - The Express request object.
 * @param {Object} res - The Express response object.
 * @param {Function} next - The next middleware function.
 */
async function tokenMiddleware(req, res, next) {
  const isWebhook = req.path === '/webhook' && req.body.From;
  const userId = isWebhook ? req.body.From.replace(/\D/g, "") : req.body.userId;
  if (!userId) {
    console.error('[ERROR] Missing userId in request');
    return isWebhook
      ? res.send(`<Response><Message>⚠️ Invalid user ID. Please try again.</Message></Response>`)
      : res.status(400).json({ error: 'Missing user ID' });
  }

  try {
    const userProfile = await db.collection('users').doc(userId).get();
    if (!userProfile.exists) {
      console.error(`[ERROR] No user profile found for ${userId}`);
      return isWebhook
        ? res.send(`<Response><Message>⚠️ User not found. Please start onboarding.</Message></Response>`)
        : res.status(404).json({ error: 'User not found' });
    }

    const ownerId = userProfile.data().ownerId || userId;
    let subscriptionTier = userProfile.data().subscriptionTier || 'basic';
    
    // Set default subscription tier for new users
    if (!userProfile.data().subscriptionTier) {
      subscriptionTier = 'basic';
      await db.collection('users').doc(userId).update({
        subscriptionTier: 'basic',
        tokenUsage: { messages: 0, aiCalls: 0 }
      });
      console.log(`[✅] Set default subscription tier to 'basic' for ${userId}`);
    }

    // Update token usage for webhook or deep-dive requests
    const isDeepDive = req.path === '/deep-dive';
    const tokenUpdate = isDeepDive
      ? { messages: 1, aiCalls: 1 }
      : isWebhook && req.body.Body
        ? {
            messages: 1,
            aiCalls: (req.body.Body.includes('$') || req.body.Body.toLowerCase().includes('received') || req.body.Body.toLowerCase().startsWith('quote') || req.body.MediaUrl0) ? 1 : 0
          }
        : { messages: 0, aiCalls: 0 };

    await updateUserTokenUsage(ownerId, tokenUpdate);

    // Check token limits
    const withinLimit = await checkTokenLimit(ownerId, subscriptionTier);
    if (withinLimit.exceeded) {
      if (isWebhook) {
        const lockKey = `lock:${userId}`;
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${userId} (trial limit exceeded)`);
        return res.send(`<Response><Message>⚠️ Trial limit reached! Reply 'Upgrade' to continue.</Message></Response>`);
      } else {
        return res.status(403).json({ error: 'Trial limit reached' });
      }
    }

    // Set subscription tier for deep-dive new users
    if (isDeepDive && !userProfile.data().subscriptionTier) {
      await db.collection('users').doc(userId).update({
        subscriptionTier: 'Pro',
        trialStart: new Date().toISOString(),
        trialEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        tokenUsage: { messages: 0, aiCalls: 0 }
      });
      await sendTemplateMessage(userId, 'HXwelcome_trial', [
        { type: 'text', text: userProfile.data().name || 'User' },
        { type: 'text', text: '30-day trial activated! Start logging expenses via WhatsApp.' }
      ]);
      console.log(`[✅] Set Pro trial for ${userId}`);
    }

    next();
  } catch (error) {
    console.error(`[ERROR] Token middleware failed for ${userId}:`, error.message);
    if (isWebhook) {
      const lockKey = `lock:${userId}`;
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${userId} (error)`);
      return res.send(`<Response><Message>⚠️ An error occurred. Please try again later.</Message></Response>`);
    } else {
      return res.status(500).json({ error: 'Token processing failed' });
    }
  }
}

/**
 * Updates token usage for a user in Firestore.
 * @param {string} userId - The user’s ID (phone number or ownerId).
 * @param {Object} usage - Token usage to increment { messages, aiCalls }.
 */
async function updateUserTokenUsage(userId, usage) {
  try {
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    const currentUsage = doc.data().tokenUsage || { messages: 0, aiCalls: 0 };
    await userRef.update({
      tokenUsage: {
        messages: currentUsage.messages + (usage.messages || 0),
        aiCalls: currentUsage.aiCalls + (usage.aiCalls || 0)
      }
    });
    console.log(`[✅] Updated token usage for ${userId}: ${JSON.stringify(usage)}`);
  } catch (error) {
    console.error(`[ERROR] Failed to update token usage for ${userId}:`, error.message);
    throw error;
  }
}

/**
 * Retrieves the user’s subscription tier from Firestore.
 * @param {string} userId - The user’s ID.
 * @returns {Promise<string>} The subscription tier (e.g., 'basic', 'Pro').
 */
async function getSubscriptionTier(userId) {
  try {
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    const tier = doc.data().subscriptionTier || 'basic';
    console.log(`[✅] Retrieved subscription tier for ${userId}: ${tier}`);
    return tier;
  } catch (error) {
    console.error(`[ERROR] Failed to retrieve subscription tier for ${userId}:`, error.message);
    throw error;
  }
}

/**
 * Checks if the user’s token usage is within their tier’s limits.
 * @param {string} userId - The user’s ID.
 * @param {string} tier - The subscription tier.
 * @returns {Promise<{ exceeded: boolean }>} Whether the limit is exceeded.
 */
async function checkTokenLimit(userId, tier) {
  try {
    const limits = {
      Free: { messages: 100, aiCalls: 10 },
      basic: { messages: 1000, aiCalls: 100 },
      Pro: { messages: 5000, aiCalls: 500 },
      Enterprise: { messages: Infinity, aiCalls: Infinity }
    };
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    const tokenUsage = doc.data().tokenUsage || { messages: 0, aiCalls: 0 };
    const tierLimits = limits[tier] || limits.basic;
    const exceeded = tokenUsage.messages > tierLimits.messages || tokenUsage.aiCalls > tierLimits.aiCalls;
    console.log(`[✅] Checked token limit for ${userId} (${tier}): ${exceeded ? 'exceeded' : 'within limit'}`);
    return { exceeded };
  } catch (error) {
    console.error(`[ERROR] Failed to check token limit for ${userId}:`, error.message);
    throw error;
  }
}

module.exports = {
  tokenMiddleware,
  updateUserTokenUsage,
  getSubscriptionTier,
  checkTokenLimit
};