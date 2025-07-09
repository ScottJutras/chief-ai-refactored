const express = require('express');
const { handleCommands } = require('../handlers/commands');
const { handleMedia } = require('../handlers/media');
const { handleOnboarding } = require('../handlers/onboarding');
const { handleTimeclock } = require('../handlers/timeClock');
const { lockMiddleware, releaseLock } = require('../middleware/lock');
const { userProfileMiddleware } = require('../middleware/userProfile');
const { tokenMiddleware } = require('../middleware/token');
const { errorMiddleware } = require('../middleware/error');
const router = express.Router();

// 1️⃣ Health‐check endpoint
router.get('/', (req, res) => {
  console.log('[WEBHOOK] GET /');
  res.send('👋 Chief AI webhook endpoint is live. POST here for Twilio events.');
});

// 2️⃣ Main Twilio webhook
router.post(
  '/',
  // 🔍 Route‐level sanity check
  (req, res, next) => {
    console.log('[ROUTE] hit POST /api/webhook');
    next();
  },
  lockMiddleware,
  userProfileMiddleware,
  tokenMiddleware,
  async (req, res, next) => {
    const rawFrom = req.body.From || '';
    const from = rawFrom.replace(/\D/g, '');
    console.log(`[WEBHOOK] processing message from ${from}`);

    const input = (req.body.Body || '').trim();
    const mediaUrl = req.body.MediaUrl0 || null;
    const mediaType = req.body.MediaContentType0 || null;

    const { userProfile, ownerId, ownerProfile, isOwner } = req;
    const lockKey = `lock:${from}`;

    try {
      // 1) Onboarding
      if (userProfile.onboarding_in_progress || input.toLowerCase().includes('start onboarding')) {
        return await handleOnboarding(from, input, userProfile, ownerId, res);
      }

      // 2) Media (images, audio, etc.)
      if (mediaUrl && mediaType) {
        return await handleMedia(from, mediaUrl, mediaType, userProfile, ownerId, ownerProfile, isOwner, res);
      }

      // 3) Timeclock commands
      const lc = input.toLowerCase();
      if (lc.includes('punch') || lc.includes('break') || lc.includes('lunch') || lc.includes('drive') || lc.includes('hours')) {
        return await handleTimeclock(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
      }

      // 4) Everything else
      return await handleCommands(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
    } catch (error) {
      console.error(`[ERROR] Webhook processing failed for ${from}:`, error);
      await releaseLock(lockKey);
      throw error; // let errorMiddleware handle response
    }
  },
  errorMiddleware
);

module.exports = router;
