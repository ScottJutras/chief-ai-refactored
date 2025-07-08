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

// 1️⃣ Respond to GET so browsers (or health checks) don’t 404
router.get('/', (req, res) => {
  res.send('👋 Chief AI webhook endpoint is live. POST here for Twilio events.');
});

// 2️⃣ Your existing POST handler
router.post(
  '/',
  lockMiddleware,
  userProfileMiddleware,
  tokenMiddleware,
  async (req, res, next) => {
    const { From, Body, MediaUrl0, MediaContentType0 } = req.body;
    const from = req.from || 'UNKNOWN_FROM';
    const input = Body?.trim() || '';
    const mediaUrl = MediaUrl0 || null;
    const mediaType = MediaContentType0 || null;
    const { userProfile, ownerId, ownerProfile, isOwner } = req;
    const lockKey = `lock:${from}`;

    try {
      // onboarding flow
      if (userProfile.onboarding_in_progress || input.toLowerCase().includes('start onboarding')) {
        return await handleOnboarding(from, input, userProfile, ownerId, res);
      }

      // media uploads
      if (mediaUrl && mediaType) {
        return await handleMedia(from, mediaUrl, mediaType, userProfile, ownerId, ownerProfile, isOwner, res);
      }

      // timeclock commands
      if (
        input.toLowerCase().includes('punch') ||
        input.toLowerCase().includes('break') ||
        input.toLowerCase().includes('lunch') ||
        input.toLowerCase().includes('drive') ||
        input.toLowerCase().includes('hours')
      ) {
        return await handleTimeclock(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
      }

      // all other commands
      return await handleCommands(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
    } catch (error) {
      console.error(`[ERROR] Webhook processing failed for ${from}:`, error.message);
      await releaseLock(lockKey);
      throw error;
    }
  },
  errorMiddleware
);

module.exports = router;
