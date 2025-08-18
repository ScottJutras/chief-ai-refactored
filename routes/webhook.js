const express = require('express');
const axios = require('axios');
const { getUserProfile, getOwnerProfile, createUserProfile } = require('../services/postgres');
const { acquireLock, releaseLock } = require('../utils/lockManager');
const { logError } = require('../middleware/error');
const { tokenMiddleware } = require('../middleware/token');
const { userProfileMiddleware } = require('../middleware/userProfile');
const { sendMessage, sendTemplateMessage } = require('../services/twilio');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { parseUpload } = require('../services/deepDive');
const { getPendingTransactionState, setPendingTransactionState } = require('../utils/stateManager');
const { handleGenericQuery } = require('../services/openAI');
const { handleOnboarding } = require('../handlers/onboarding');
const { handleTeamSetup } = require('../handlers/teamSetup');
const { handleExpense } = require('../handlers/commands/expense');
const { handleBill } = require('../handlers/commands/bill');
const { handleRevenue } = require('../handlers/commands/revenue');
const { handleQuote } = require('../handlers/commands/quote');
const { handleJob } = require('../handlers/commands/job');
const { handleTax } = require('../handlers/commands/tax');
const { handleReceipt } = require('../handlers/commands/receipt');
const { handlePricing } = require('../handlers/commands/pricing');
const { handleTimeclock } = require('../handlers/commands/timeclock');
const { handleMedia } = require('../handlers/media');
const { handleError } = require('../utils/aiErrorHandler');
const router = express.Router();

/**
 * Normalize phone to digits-only (remove '+' and non-digits)
 */
function normalizePhone(rawFrom = '') {
  return rawFrom.replace(/\D/g, '');
}

router.post('/', async (req, res) => {
  const rawFrom = req.body.From || '';
  const from = normalizePhone(rawFrom);
  const idempotencyToken =
    req.headers['i-twilio-idempotency-token'] ||
    req.get('i-twilio-idempotency-token') ||
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  console.log('[LOCK] trying for', from, 'token=', idempotencyToken);

  const gotLock = await acquireLock(from, idempotencyToken).catch(err => {
    console.error('[LOCK] acquire error:', err.message);
    return false;
  });

  if (!gotLock) {
    console.log('[LOCK] busy; returning busy response');
    return res
      .status(200)
      .send(`<Response><Message>I'm processing your previous message—try again in a moment.</Message></Response>`);
  }

  try {
    await userProfileMiddleware(req, res, async () => {
      await tokenMiddleware(req, res, async () => {
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
        const { userProfile, ownerId } = req;
        let response;
        const lc = body?.toLowerCase();
        if (lc?.includes('upgrade to pro') || lc?.includes('upgrade to enterprise')) {
          if (userProfile.stripe_subscription_id) {
            await sendMessage(from, `⚠️ You already have an active ${userProfile.subscription_tier} subscription. Contact support to change plans.`);
            return res.status(200).send(`<Response><Message>Already subscribed!</Message></Response>`);
          }
          let tier = lc.includes('pro') ? 'pro' : 'enterprise';
          let priceId = tier === 'pro' ? process.env.PRO_PRICE_ID : process.env.ENTERPRISE_PRICE_ID;
          let priceText = tier === 'pro' ? '$29' : '$99';
          const customer = await stripe.customers.create({
            phone: from,
            metadata: { user_id: userProfile.user_id }
          });
          const paymentLink = await stripe.paymentLinks.create({
            line_items: [{ price: priceId, quantity: 1 }],
            metadata: { user_id: userProfile.user_id }
          });
          const { Pool } = require('pg');
          const pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false }
          });
          await pool.query(
            `UPDATE users SET stripe_customer_id=$1, subscription_tier=$2 WHERE user_id=$3`,
            [customer.id, tier, userProfile.user_id]
          );
          await sendTemplateMessage(from, [{ type: 'text', text: `Upgrade to ${tier} for ${priceText}/month CAD: ${paymentLink.url}` }], process.env.HEX_UPGRADE_NOW);
          return res.status(200).send(`<Response><Message>Upgrade link sent!</Message></Response>`);
        }
        if (lc?.includes('upload history') || lc?.includes('historical data') || lc?.includes('deepdive')) {
          const tierLimits = {
            starter: { years: 7, transactions: 5000, parsingPriceId: process.env.HISTORICAL_PARSING_PRICE_STARTER, parsingPriceText: '$19' },
            pro: { years: 7, transactions: 20000, parsingPriceId: process.env.HISTORICAL_PARSING_PRICE_PRO, parsingPriceText: '$49' },
            enterprise: { years: 7, transactions: 50000, parsingPriceId: process.env.HISTORICAL_PARSING_PRICE_ENTERPRISE, parsingPriceText: '$99' }
          };
          const tier = userProfile.subscription_tier || 'starter';
          const limit = tierLimits[tier];
          await setPendingTransactionState(from, { historicalDataUpload: true, maxTransactions: limit.transactions, uploadType: 'csv' });
          if (mediaUrl && mediaType && ['application/pdf', 'image/jpeg', 'image/png', 'audio/mpeg'].includes(mediaType)) {
            if (!userProfile.historical_parsing_purchased) {
              const paymentLink = await stripe.paymentLinks.create({
                line_items: [{ price: limit.parsingPriceId, quantity: 1 }],
                metadata: { user_id: userProfile.user_id, type: 'historical_parsing' }
              });
              await sendTemplateMessage(from, [{ type: 'text', text: `Upload up to 7 years of historical data via CSV/Excel for free (${limit.transactions} transactions). For historical image/audio parsing, unlock Chief AI’s DeepDive for ${limit.parsingPriceText}: ${paymentLink.url}`}], process.env.HEX_DEEPDIVE_CONFIRMATION);
              return res.status(200).send(`<Response><Message>DeepDive payment link sent!</Message></Response>`);
            }
          }
          response = `<Response><Message>Ready to upload historical data (up to ${limit.years} years, ${limit.transactions} transactions). Send CSV/Excel for free or PDFs/images/audio for ${limit.parsingPriceText} via DeepDive. Track progress on your dashboard: /dashboard/${from}?token=${userProfile.dashboard_token}</Message></Response>`;
        }
        const stage = userProfile.current_stage || (userProfile.onboarding_in_progress ? 'onboarding' : 'complete');
        let deepDiveState = await getPendingTransactionState(from);
        const isInDeepDiveUpload = deepDiveState?.deepDiveUpload === true || deepDiveState?.historicalDataUpload === true;
        switch (stage) {
          case 'onboarding':
          case 'userInfo':
          case 'email':
          case 'industry':
          case 'teamSetup':
            response = await handleOnboarding(from, body, userProfile, ownerId);
            break;
          case 'addEmployees':
            response = await handleTeamSetup(from, body, userProfile, ownerId, req.ownerProfile, req.isOwner);
            break;
          case 'complete':
            if (mediaUrl && mediaType) {
              if (isInDeepDiveUpload) {
                try {
                  const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'audio/mpeg', 'text/csv', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
                  if (!allowed.includes(mediaType)) {
                    response = `<Response><Message>Unsupported file type. Please upload a PDF, image, audio, CSV, or Excel.</Message></Response>`;
                  } else {
                    const fileResp = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
                    const buffer = Buffer.from(fileResp.data);
                    const filename = mediaUrl.split('/').pop() || 'upload';
                    const summary = await parseUpload(buffer, filename, from, mediaType, deepDiveState.uploadType, userProfile.fiscal_year_start);
                    if (deepDiveState.historicalDataUpload) {
                      const transactionCount = summary.transactions?.length || 0;
                      if (transactionCount > deepDiveState.maxTransactions) {
                        response = `<Response><Message>Upload exceeds ${deepDiveState.maxTransactions} transactions. Contact support for larger datasets.</Message></Response>`;
                      } else {
                        response = `<Response><Message>✅ ${transactionCount} new transactions processed. Track progress on your dashboard: /dashboard/${from}?token=${userProfile.dashboard_token}</Message></Response>`;
                        deepDiveState.historicalDataUpload = false;
                        await setPendingTransactionState(from, deepDiveState);
                      }
                    } else {
                      response = `<Response><Message>File received and processed. ${summary ? 'Summary: ' + JSON.stringify(summary) : 'OK'}.</Message></Response>`;
                      deepDiveState.deepDiveUpload = false;
                      await setPendingTransactionState(from, deepDiveState);
                    }
                  }
                } catch (err) {
                  response = `<Response><Message>Error parsing upload: ${err.message}</Message></Response>`;
                }
              } else {
                response = await handleMedia(from, body, userProfile, ownerId, mediaUrl, mediaType);
              }
            } else if (body) {
              const lowerBody = body.toLowerCase();
              if (lowerBody.includes('upload') || lowerBody.includes('deep dive')) {
                deepDiveState = deepDiveState || {};
                deepDiveState.deepDiveUpload = true;
                await setPendingTransactionState(from, deepDiveState);
                response = `<Response><Message>Ready for upload! Please send your business documents (PDF, image, audio, CSV, or Excel).</Message></Response>`;
              } else if (lowerBody.startsWith('expense') || lowerBody.startsWith('spent')) {
                response = await handleExpense(from, body, userProfile, ownerId, req.ownerProfile, req.isOwner);
              } else if (lowerBody.startsWith('bill')) {
                response = await handleBill(from, body, userProfile, ownerId, req.ownerProfile, req.isOwner);
              } else if (lowerBody.startsWith('received') || lowerBody.startsWith('revenue')) {
                response = await handleRevenue(from, body, userProfile, ownerId, req.ownerProfile, req.isOwner);
              } else if (lowerBody.startsWith('quote')) {
                response = await handleQuote(from, body, userProfile, ownerId, req.ownerProfile, req.isOwner);
              } else if (lowerBody.includes('job')) {
                response = await handleJob(from, body, userProfile, ownerId, req.ownerProfile, req.isOwner);
              } else if (lowerBody.includes('tax')) {
                response = await handleTax(from, body, userProfile, ownerId);
              } else if (lowerBody.includes('find receipt')) {
                response = await handleReceipt(from, body, userProfile, ownerId);
              } else if (lowerBody.includes('material') || lowerBody.includes('pricing')) {
                response = await handlePricing(from, body, userProfile, ownerId, req.ownerProfile, req.isOwner, res);
              } else if (lowerBody.includes('punch') || lowerBody.includes('hours')) {
                response = await handleTimeclock(from, body, userProfile, ownerId, req.ownerProfile, req.isOwner);
              } else if (lowerBody.includes('help')) {
                response = `<Response><Message>I can help with expenses, jobs, and more. Try ‘expense $100 tools’, ‘create job Roof Repair’, ‘recap month’, or ‘summarize job Roof Repair’. What would you like to do?</Message></Response>`;
              } else if (lowerBody === 'hi') {
                response = await handleOnboarding(from, body, userProfile, ownerId);
              } else {
                if (userProfile.subscription_tier === 'starter') {
                  response = `<Response><Message>⚠️ Advanced queries require Pro or Enterprise plan. Reply 'upgrade to pro' or 'upgrade to enterprise'.</Message></Response>`;
                } else {
                  const aiResponse = await handleGenericQuery(body, userProfile);
                  response = `<Response><Message>${aiResponse}</Message></Response>`;
                }
              }
            } else {
              response = `<Response><Message>I didn’t catch that—what can I help you with today? Try ‘expense $100 tools’, ‘start job Roof Repair’, or ‘help’.</Message></Response>`;
            }
            break;
          default:
            response = await handleOnboarding(from, body, userProfile, ownerId);
        }
        res.status(200).send(response);
      });
    });
  } catch (error) {
    console.error('[ERROR] Webhook processing failed for', from, ':', error.message);
    await logError(from, error, 'webhook');
    res.status(200).send(await handleError(from, error, 'webhook', body));
  } finally {
    await releaseLock(from, idempotencyToken);
    console.log('[LOCK] released for', from);
  }
});

module.exports = router;