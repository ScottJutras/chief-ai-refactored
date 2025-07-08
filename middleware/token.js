// middleware/token.js
const { db } = require('../services/firebase');
const { sendTemplateMessage } = require('../services/twilio');

/**
 * Increment a user's token usage counters.
 */
async function updateUserTokenUsage(userId, { messages = 0, aiCalls = 0 }) {
  const userRef = db.collection('users').doc(userId);
  const snap = await userRef.get();
  const current = snap.data().tokenUsage || { messages: 0, aiCalls: 0 };
  await userRef.update({
    tokenUsage: {
      messages: current.messages + messages,
      aiCalls: current.aiCalls + aiCalls,
    }
  });
  console.log(`[✅] Updated token usage for ${userId}: messages+${messages}, aiCalls+${aiCalls}`);
}

/**
 * Check if a user has exceeded their tier’s token limits.
 */
async function checkTokenLimit(userId, tier) {
  const limits = {
    Free: { messages: 100, aiCalls: 10 },
    basic: { messages: 1000, aiCalls: 100 },
    Pro: { messages: 5000, aiCalls: 500 },
    Enterprise: { messages: Infinity, aiCalls: Infinity },
  };
  const snap = await db.collection('users').doc(userId).get();
  const usage = snap.data().tokenUsage || { messages: 0, aiCalls: 0 };
  const { messages: msgLimit, aiCalls: aiLimit } = limits[tier] || limits.basic;
  const exceeded = usage.messages > msgLimit || usage.aiCalls > aiLimit;
  console.log(`[✅] Token check for ${userId} (${tier}): ${exceeded ? '❌ exceeded' : '✅ within limits'}`);
  return { exceeded };
}


async function tokenMiddleware(req, res, next) {
  // userProfileMiddleware already ran, so req.ownerId is set for webhooks
  const raw = req.ownerId || req.body.userId;
  const userId = raw ? raw.replace(/\D/g, '') : null;
  const isWebhook = Boolean(req.body.From && req.ownerId);

  if (!userId) {
    console.error('[ERROR] Missing userId');
    if (isWebhook) {
      return res.send(
        `<Response><Message>⚠️ Invalid user ID. Please try again.</Message></Response>`
      );
    }
    return res.status(400).json({ error: 'Missing user ID' });
  }

  try {
    const userSnap = await db.collection('users').doc(userId).get();
    if (!userSnap.exists) {
      console.error(`[ERROR] No profile for ${userId}`);
      if (isWebhook) {
        return res.send(
          `<Response><Message>⚠️ User not found. Please start onboarding.</Message></Response>`
        );
      }
      return res.status(404).json({ error: 'User not found' });
    }

    const data = userSnap.data();
    const ownerId = data.ownerId || userId;
    let tier = data.subscriptionTier || 'basic';

    // first‐time setup
    if (!data.subscriptionTier) {
      await db.collection('users').doc(userId).update({
        subscriptionTier: 'basic',
        tokenUsage: { messages: 0, aiCalls: 0 }
      });
      console.log(`[✅] Initialized tier/basic usage for ${userId}`);
    }

    // count this request
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

    // enforce limits
    const { exceeded } = await checkTokenLimit(ownerId, tier);
    if (exceeded) {
      console.log(`[⚠️] ${ownerId} exceeded tokens`);
      if (isWebhook) {
        // release any Twilio lock
        const lockKey = `lock:${userId}`;
        await db.collection('locks').doc(lockKey).delete().catch(() => {});
        return res.send(
          `<Response><Message>⚠️ Trial limit reached! Reply 'Upgrade' to continue.</Message></Response>`
        );
      }
      return res.status(403).json({ error: 'Trial limit reached' });
    }

    return next();
  } catch (err) {
    console.error(`[ERROR] tokenMiddleware for ${userId}`, err);
    if (isWebhook) {
      const lockKey = `lock:${userId}`;
      await db.collection('locks').doc(lockKey).delete().catch(() => {});
      return res.send(
        `<Response><Message>⚠️ An error occurred. Please try again later.</Message></Response>`
      );
    }
    return res.status(500).json({ error: 'Token processing failed' });
  }
}

module.exports = { tokenMiddleware };
