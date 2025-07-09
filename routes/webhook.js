const express = require('express');
const twilio = require('twilio');
const commandHandlers = require('../handlers/commands');
const { handleMedia } = require('../handlers/media');
const { handleOnboarding } = require('../handlers/onboarding');
const { handleTimeclock } = require('../handlers/commands/timeclock');
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

    const signature = req.headers['x-twilio-signature'];
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const url = 'https://chief-ai-refactored.vercel.app/api/webhook';
    const isValid = twilio.validateRequest(authToken, signature, url, req.body);
    console.log('[WEBHOOK] Twilio signature validation:', { isValid });
    if (!isValid) {
      console.log('[WEBHOOK] Invalid Twilio signature');
      return res.status(403).send('Invalid signature');
    }

    const { From, Body, MediaUrl0, MediaContentType0 } = req.body;
    const from = req.from || 'UNKNOWN_FROM';
    const input = Body?.trim() || '';
    const mediaUrl = MediaUrl0 || null;
    const mediaType = MediaContentType0 || null;
    const { userProfile, ownerId, ownerProfile, isOwner } = req;
    const lockKey = `lock:${from}`;

    try {
      if (userProfile.onboarding_in_progress || input.toLowerCase().includes('start onboarding')) {
        return await handleOnboarding(from, input, userProfile, ownerId, res);
      }
      if (mediaUrl && mediaType) {
        return await handleMedia(from, mediaUrl, mediaType, userProfile, ownerId, ownerProfile, isOwner, res);
      }
      if (['punch', 'break', 'lunch', 'drive', 'hours'].some(cmd => input.toLowerCase().includes(cmd))) {
        return await handleTimeclock(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
      }

      const lcInput = input.toLowerCase().trim();
      if (lcInput.startsWith('expense')) {
        return await commandHandlers.expense.handleExpense(from, input, userProfile, ownerId);
      } else if (lcInput.startsWith('revenue')) {
        return await commandHandlers.revenue.handleRevenue(from, input, userProfile, ownerId);
      } else if (lcInput.startsWith('bill')) {
        return await commandHandlers.bill.handleBill(from, input, userProfile, ownerId);
      } else if (lcInput.startsWith('start job') || lcInput.startsWith('finish job')) {
        return await commandHandlers.job.handleJob(from, input, userProfile, ownerId);
      } else if (lcInput.startsWith('quote')) {
        return await commandHandlers.quote.handleQuote(from, input, userProfile, ownerId);
      } else if (lcInput.startsWith('metrics')) {
        return await commandHandlers.metrics.handleMetrics(from, input, userProfile, ownerId);
      } else if (lcInput.startsWith('tax')) {
        return await commandHandlers.tax.handleTax(from, input, userProfile, ownerId);
      } else if (lcInput.startsWith('receipt')) {
        return await commandHandlers.receipt.handleReceipt(from, input, userProfile, ownerId);
      } else if (lcInput.startsWith('team')) {
        return await commandHandlers.team.handleTeam(from, input, userProfile, ownerId);
      } else if (lcInput === 'chief!!') {
        return res.send('<Response><Message>🔥 You’re the boss, Chief! What’s the next move?</Message></Response>');
      } else if (lcInput.startsWith('stats')) {
        const currency = userProfile.country === 'United States' ? 'USD' : 'CAD';
        const expenses = await commandHandlers.metrics.getTotalExpenses(ownerId);
        const revenue = await commandHandlers.metrics.getTotalRevenue(ownerId);
        const profit = revenue - expenses;
        let reply = `📊 Your Stats, ${userProfile.name || 'User'}:\nRevenue: ${currency} ${revenue.toFixed(2)}\nExpenses: ${currency} ${expenses.toFixed(2)}\nProfit: ${currency} ${profit.toFixed(2)}`;
        if (userProfile.goalProgress) {
          reply += `\nGoal Progress: ${currency} ${userProfile.goalProgress.current.toFixed(2)} / ${currency} ${userProfile.goalProgress.target.toFixed(2)} (${((userProfile.goalProgress.current / userProfile.goalProgress.target) * 100).toFixed(1)}%)`;
        }
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else if (lcInput.startsWith('goal')) {
        const currency = userProfile.country === 'United States' ? 'USD' : 'CAD';
        if (!userProfile.goal) {
          return res.send('<Response><Message>You haven’t set a financial goal yet. Reply with something like "Grow profit by $10,000" or "Pay off $5,000 debt".</Message></Response>');
        }
        const progress = userProfile.goalProgress?.current || 0;
        const target = userProfile.goalProgress?.target || 0;
        return res.send(`<Response><Message>🎯 Goal: ${userProfile.goal}\nProgress: ${currency} ${progress.toFixed(2)} / ${currency} ${target.toFixed(2)} (${((progress / target) * 100).toFixed(1)}%)</Message></Response>`);
      }
      return res.send(`<Response><Message>🤔 Unrecognized command: "${input}". Try "start job [name]" or "expense $100 tools".</Message></Response>`);
    } catch (error) {
      console.error(`[ERROR] Webhook processing failed for ${from}:`, error);
      await releaseLock(lockKey);
      throw error;
    }
  },
  errorMiddleware
);

module.exports = router;