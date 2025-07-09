// routes/webhook.js

const express = require('express');
const { handleCommands } = require('../handlers/commands');
const { handleMedia } = require('../handlers/media');
const { handleOnboarding } = require('../handlers/onboarding');
const { handleTimeclock } = require('../handlers/timeclock');
const { lockMiddleware, releaseLock } = require('../middleware/lock');
const { userProfileMiddleware } = require('../middleware/userProfile');
const { tokenMiddleware } = require('../middleware/token');
const { errorMiddleware } = require('../middleware/error');

const router = express.Router();

router.post(
  '/',
  lockMiddleware,
  userProfileMiddleware,
  tokenMiddleware,
  async (req, res, next) => {
    // 👇 Log the incoming WhatsApp payload for Vercel runtime logs
    console.log('[WEBHOOK] Incoming WhatsApp message:', {
      timestamp: new Date().toISOString(),
      from: req.body.From,
      body: req.body.Body,
      mediaUrl: req.body.MediaUrl0,
      mediaType: req.body.MediaContentType0,
      headers: {
        'user-agent': req.headers['user-agent'],
        'x-twilio-signature': req.headers['x-twilio-signature']
      }
    });

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

      // media handling (e.g., receipt images)
      if (mediaUrl && mediaType) {
        return await handleMedia(from, mediaUrl, mediaType, userProfile, ownerId, ownerProfile, isOwner, res);
      }

      // timeclock commands (punch, break, etc.)
      if (
        ['punch', 'break', 'lunch', 'drive', 'hours']
          .some(cmd => input.toLowerCase().includes(cmd))
      ) {
        return await handleTimeclock(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
      }

      // default: command handler
      return await handleCommands(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
    } catch (error) {
      console.error(`[ERROR] Webhook processing failed for ${from}:`, error);
      await releaseLock(lockKey);
      throw error;
    }
  },
  errorMiddleware
);

module.exports = router;
