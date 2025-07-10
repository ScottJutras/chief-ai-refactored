const express = require('express');
const { getUserProfile, getOwnerProfile, createUserProfile } = require('../services/postgres');
const { acquireLock, releaseLock } = require('../middleware/lock');
const { logError } = require('../middleware/error');
const { tokenMiddleware } = require('../middleware/token');
const { handleOnboarding } = require('../handlers/onboarding');
const { handleExpense } = require('../handlers/commands/expense');
const { handleBill } = require('../handlers/commands/bill');
const { handleRevenue } = require('../handlers/commands/revenue');
const { handleQuote } = require('../handlers/commands/quote');
const { handleJob } = require('../handlers/commands/job');
const { handleMetrics } = require('../handlers/commands/metrics');
const { handleTax } = require('../handlers/commands/tax');
const { handleReceipt } = require('../handlers/commands/receipt');
const { handleTeam } = require('../handlers/commands/team');
const { handleTimeclock } = require('../handlers/commands/timeclock');
const { handleMedia } = require('../handlers/media');

const router = express.Router();

async function userProfileMiddleware(req, res, next) {
  const from = req.body.From ? req.body.From.replace(/\D/g, '') : null;
  console.log('[DEBUG] userProfileMiddleware invoked:', { from, timestamp: new Date().toISOString() });

  if (!from) {
    console.error('[ERROR] Missing From in request body');
    return res.send(`<Response><Message>⚠️ Invalid request. Please try again.</Message></Response>`);
  }

  try {
    let userProfile = await getUserProfile(from);
    let ownerId = from;

    if (!userProfile) {
      userProfile = await createUserProfile({ user_id: from, ownerId: from, onboarding_in_progress: true });
      console.log('[INFO] Created new user profile for', from);
    } else {
      ownerId = userProfile.owner_id || from;
    }

    const ownerProfile = await getOwnerProfile(ownerId);
    req.userProfile = userProfile;
    req.ownerId = ownerId;
    req.ownerProfile = ownerProfile;

    console.log('[DEBUG] userProfileMiddleware result:', { userProfile });
    next();
  } catch (error) {
    console.error('[ERROR] userProfileMiddleware failed:', error.message);
    await logError(from, error, 'userProfileMiddleware');
    res.send(`<Response><Message>⚠️ Failed to process user profile: ${error.message}</Message></Response>`);
  }
}

router.post('/', async (req, res, next) => {
  const from = req.body.From ? req.body.From.replace(/\D/g, '') : null;
  const body = req.body.Body?.trim();
  const mediaUrl = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;

  console.log('[WEBHOOK] Incoming WhatsApp message:', {
    timestamp: new Date().toISOString(),
    from,
    body,
    mediaUrl,
    mediaType,
    headers: {
      'user-agent': req.headers['user-agent'],
      'x-twilio-signature': req.headers['x-twilio-signature']
    }
  });

  if (!from) {
    console.error('[ERROR] Missing From in webhook request');
    return res.send(`<Response><Message>⚠️ Invalid request. Please try again.</Message></Response>`);
  }

  const lockKey = `lock:${from}`;
  try {
    const lockAcquired = await acquireLock(lockKey);
    if (!lockAcquired) {
      console.log('[LOCK] Failed to acquire lock for', from);
      return res.send(`<Response><Message>⚠️ Another request is being processed. Please try again shortly.</Message></Response>`);
    }

    console.log('[LOCK] Acquired lock for', from);
    await userProfileMiddleware(req, res, async () => {
      await tokenMiddleware(req, res, async () => {
        try {
          const { userProfile, ownerId } = req;
          let response;

          if (userProfile.onboarding_in_progress) {
            response = await handleOnboarding(from, body, userProfile, ownerId);
          } else if (mediaUrl && mediaType) {
            response = await handleMedia(from, body, mediaUrl, mediaType, userProfile, ownerId);
          } else if (body) {
            const lowerBody = body.toLowerCase();
            if (lowerBody.startsWith('expense') || lowerBody.startsWith('spent')) {
              response = await handleExpense(from, body, userProfile, ownerId);
            } else if (lowerBody.startsWith('bill')) {
              response = await handleBill(from, body, userProfile, ownerId);
            } else if (lowerBody.startsWith('received') || lowerBody.startsWith('revenue')) {
              response = await handleRevenue(from, body, userProfile, ownerId);
            } else if (lowerBody.startsWith('quote')) {
              response = await handleQuote(from, body, userProfile, ownerId);
            } else if (lowerBody.includes('job')) {
              response = await handleJob(from, body, userProfile, ownerId);
            } else if (lowerBody.includes('profit') || lowerBody.includes('metrics')) {
              response = await handleMetrics(from, body, userProfile, ownerId);
            } else if (lowerBody.includes('tax')) {
              response = await handleTax(from, body, userProfile, ownerId);
            } else if (lowerBody.includes('find receipt')) {
              response = await handleReceipt(from, body, userProfile, ownerId);
            } else if (lowerBody.includes('member') || lowerBody.includes('team')) {
              response = await handleTeam(from, body, userProfile, ownerId);
            } else if (lowerBody.includes('punch') || lowerBody.includes('hours')) {
              response = await handleTimeclock(from, body, userProfile, ownerId);
            } else {
              response = `<Response><Message>⚠️ Unknown command. Try: expense $100 tools, start job TestJob, or profit for Roof Repair.</Message></Response>`;
            }
          } else {
            response = `<Response><Message>⚠️ Please provide a command or message.</Message></Response>`;
          }

          await releaseLock(lockKey);
          console.log('[LOCK] Released lock for', lockKey);
          res.send(response);
        } catch (error) {
          console.error('[ERROR] Webhook processing failed for', from, ':', error.message);
          await logError(from, error, 'webhook');
          await releaseLock(lockKey);
          console.log('[LOCK] Released lock for', lockKey);
          res.send(`<Response><Message>⚠️ Failed to process request: ${error.message}</Message></Response>`);
        }
      });
    });
  } catch (error) {
    console.error('[ERROR] Webhook failed to acquire lock for', from, ':', error.message);
    await logError(from, error, 'webhook-lock');
    await releaseLock(lockKey);
    res.send(`<Response><Message>⚠️ Server error. Please try again later.</Message></Response>`);
  }
});

module.exports = router;