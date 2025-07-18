const express = require('express');
const { getUserProfile, getOwnerProfile, createUserProfile } = require('../services/postgres');
const { lockMiddleware } = require('../middleware/lock');
const { logError } = require('../middleware/error');
const { tokenMiddleware } = require('../middleware/token');
const { userProfileMiddleware } = require('../middleware/userProfile');
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
const { handleError } = require('../utils/aiErrorHandler');

const router = express.Router();

router.post('/', lockMiddleware, userProfileMiddleware, tokenMiddleware, async (req, res) => {
  const from = req.body.From ? req.body.From.replace(/\D/g, '') : '';
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
    return res.status(200).send(`<Response><Message>⚠️ Invalid request: missing sender.</Message></Response>`);
  }

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
      } else if (lowerBody.includes('help')) {
        response = `<Response><Message>I can help with expenses, jobs, and more. Try ‘expense $100 tools’, ‘create job Roof Repair’, or ‘summarize job Roof Repair’. What would you like to do?</Message></Response>`;
      } else {
        // Lightweight regex-based suggestions
        let suggestion = null;
        if (lowerBody.match(/add.*\$\d+/)) {
          suggestion = `It seems you’re trying to log an expense. Try ‘expense $50 tools from Home Depot’. Did you mean to specify a store?`;
        } else if (lowerBody.match(/track.*time|hours/)) {
          suggestion = `You might be trying to log time. Try ‘John punched in at 9am’. Are you tracking hours for an employee?`;
        } else if (lowerBody.match(/profit|metrics/)) {
          suggestion = `Looks like you want profit metrics. Try ‘profit for Roof Repair this month’. Which job are you interested in?`;
        } else if (lowerBody.match(/job/)) {
          suggestion = `It looks like you’re trying to manage a job. Try ‘create job Roof Repair’ or ‘start job Roof Repair’. What job action are you attempting?`;
        }
        if (suggestion) {
          response = `<Response><Message>${suggestion}</Message></Response>`;
        } else {
          response = await handleError(from, new Error('Unrecognized command'), 'webhook', body);
        }
      }
    } else {
      response = `<Response><Message>I didn’t catch that—what can I help you with today? You can say things like ‘expense $100 tools’, ‘start job Roof Repair’, or ‘help’.</Message></Response>`;
    }

    res.status(200).send(response);
  } catch (error) {
    console.error('[ERROR] Webhook processing failed for', from, ':', error.message);
    await logError(from, error, 'webhook');
    res.status(200).send(await handleError(from, error, 'webhook', body));
  }
});

module.exports = router;