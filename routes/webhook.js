// routes/webhook.js

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
  res.send('👋 Chief AI webhook endpoint is live. POST here for Twilio events.');
});

// 2️⃣ Main Twilio webhook
router.post(
  '/',
  lockMiddleware,
  userProfileMiddleware,
  tokenMiddleware,
  async (req, res, next) => {
    // Grab Twilio's sender and normalize to digits-only
    const rawFrom = req.body.From || '';
    const from = rawFrom.replace(/\D/g, '');

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
      // Let errorMiddleware pick it up
      throw error;
    }
  },
  errorMiddleware
);

module.exports = router;
