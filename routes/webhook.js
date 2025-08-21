// routes/webhook.js
const express = require('express');
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// --- Robust import for command handler (supports CJS default, named, or ESM default) ---
const commandsMod = require('../handlers/commands');
const handleCommands =
  (typeof commandsMod === 'function' && commandsMod) ||
  (commandsMod && commandsMod.handleCommands) ||
  (commandsMod && commandsMod.default);

if (typeof handleCommands !== 'function') {
  console.error(
    '[BOOT] handlers/commands did not export a callable handleCommands. Export keys:',
    commandsMod && Object.keys(commandsMod)
  );
  throw new TypeError('handleCommands is not a function');
}

const { handleMedia } = require('../handlers/media');
const { handleOnboarding } = require('../handlers/onboarding');
const { handleTimeclock } = require('../handlers/commands/timeclock');

const { lockMiddleware, releaseLock } = require('../middleware/lock');
const { userProfileMiddleware } = require('../middleware/userProfile');
const { tokenMiddleware } = require('../middleware/token');
const { errorMiddleware } = require('../middleware/error');

const { sendMessage, sendTemplateMessage } = require('../services/twilio');
const { parseUpload } = require('../services/deepDive');
const { getPendingTransactionState, setPendingTransactionState } = require('../utils/stateManager');

const router = express.Router();

/** For logs only (don’t use for IDs) */
function maskPhone(p) {
  return p ? String(p).replace(/^(\d{4})\d+(\d{2})$/, '$1…$2') : '';
}

/** Ensure Twilio gets a TwiML reply if a handler forgot to res.send() */
function ensureReply(res, text) {
  if (!res.headersSent) {
    res.status(200).send(`<Response><Message>${text}</Message></Response>`);
  }
}

router.post(
  '/',
  lockMiddleware,
  userProfileMiddleware,
  tokenMiddleware,
  async (req, res, next) => {
    const { From, Body, MediaUrl0, MediaContentType0 } = req.body || {};

    // userProfileMiddleware sets req.from to digits-only
    const from = req.from || String(From || '').replace(/^whatsapp:/, '').replace(/\D/g, '');
    const input = (Body || '').trim();
    const mediaUrl = MediaUrl0 || null;
    const mediaType = MediaContentType0 || null;

    const { userProfile, ownerId, ownerProfile, isOwner } = req;

    try {
      // ===== 0) Onboarding path =====
      if (
        (userProfile && userProfile.onboarding_in_progress) ||
        input.toLowerCase().includes('start onboarding')
      ) {
        await handleOnboarding(from, input, userProfile, ownerId, res);
        ensureReply(res, `Welcome to Chief AI! Quick question — what's your name?`);
        return;
      }

      // ===== 1) UPGRADE FLOW (Stripe) =====
      {
        const lc = input.toLowerCase();
        const wantsUpgrade = lc.includes('upgrade to pro') || lc.includes('upgrade to enterprise');

        if (wantsUpgrade) {
          try {
            if (userProfile?.stripe_subscription_id) {
              await sendMessage(
                from,
                `⚠️ You already have an active ${userProfile.subscription_tier} subscription. Contact support to change plans.`
              );
              ensureReply(res, 'Already subscribed!');
              return;
            }

            const tier = lc.includes('pro') ? 'pro' : 'enterprise';
            const priceId =
              tier === 'pro' ? process.env.PRO_PRICE_ID : process.env.ENTERPRISE_PRICE_ID;
            const priceText = tier === 'pro' ? '$29' : '$99';

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

            await sendTemplateMessage(
              from,
              process.env.HEX_UPGRADE_NOW,
              [`Upgrade to ${tier} for ${priceText}/month CAD: ${paymentLink.url}`]
            );

            ensureReply(res, 'Upgrade link sent!');
            return;
          } catch (err) {
            console.error('[UPGRADE] error:', err?.message);
            return next(err);
          }
        }
      }

      // ===== 2) DEEPDIVE / HISTORICAL UPLOAD FLOW =====
      {
        const lc = input.toLowerCase();
        const triggersDeepDive =
          lc.includes('upload history') ||
          lc.includes('historical data') ||
          lc.includes('deepdive') ||
          lc.includes('deep dive');

        const tierLimits = {
          starter: {
            years: 7,
            transactions: 5000,
            parsingPriceId: process.env.HISTORICAL_PARSING_PRICE_STARTER,
            parsingPriceText: '$19'
          },
          pro: {
            years: 7,
            transactions: 20000,
            parsingPriceId: process.env.HISTORICAL_PARSING_PRICE_PRO,
            parsingPriceText: '$49'
          },
          enterprise: {
            years: 7,
            transactions: 50000,
            parsingPriceId: process.env.HISTORICAL_PARSING_PRICE_ENTERPRISE,
            parsingPriceText: '$99'
          }
        };

        const tier = (userProfile?.subscription_tier || 'starter').toLowerCase();
        const limit = tierLimits[tier] || tierLimits.starter;

        if (triggersDeepDive) {
          await setPendingTransactionState(from, {
            historicalDataUpload: true,
            deepDiveUpload: true,
            maxTransactions: limit.transactions,
            uploadType: 'csv'
          });

          if (mediaUrl && mediaType && ['application/pdf', 'image/jpeg', 'image/png', 'audio/mpeg'].includes(mediaType)) {
            try {
              if (!userProfile?.historical_parsing_purchased) {
                const paymentLink = await stripe.paymentLinks.create({
                  line_items: [{ price: limit.parsingPriceId, quantity: 1 }],
                  metadata: { user_id: userProfile.user_id, type: 'historical_parsing' }
                });

                await sendTemplateMessage(
                  from,
                  process.env.HEX_DEEPDIVE_CONFIRMATION,
                  [
                    `Upload up to 7 years of historical data via CSV/Excel for free (${limit.transactions} transactions). For historical image/audio parsing, unlock Chief AI’s DeepDive for ${limit.parsingPriceText}: ${paymentLink.url}`
                  ]
                );
                ensureReply(res, 'DeepDive payment link sent!');
                return;
              }
            } catch (err) {
              console.error('[DEEPDIVE] payment init error:', err?.message);
              return next(err);
            }
          }

          const dashUrl = `/dashboard/${from}?token=${userProfile?.dashboard_token || ''}`;
          ensureReply(
            res,
            `Ready to upload historical data (up to ${limit.years} years, ${limit.transactions} transactions). Send CSV/Excel for free or PDFs/images/audio for ${limit.parsingPriceText} via DeepDive. Track progress on your dashboard: ${dashUrl}`
          );
          return;
        }

        // If mid DeepDive upload and sent a media file, process it here
        const deepDiveState = await getPendingTransactionState(from);
        const isInDeepDiveUpload =
          deepDiveState?.deepDiveUpload === true || deepDiveState?.historicalDataUpload === true;

        if (isInDeepDiveUpload && mediaUrl && mediaType) {
          try {
            const allowed = [
              'application/pdf',
              'image/jpeg',
              'image/png',
              'audio/mpeg',
              'text/csv',
              'application/vnd.ms-excel',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            ];
            if (!allowed.includes(mediaType)) {
              ensureReply(res, 'Unsupported file type. Please upload a PDF, image, audio, CSV, or Excel.');
              return;
            }

            if (
              ['application/pdf', 'image/jpeg', 'image/png', 'audio/mpeg'].includes(mediaType) &&
              !userProfile?.historical_parsing_purchased
            ) {
              const paymentLink = await stripe.paymentLinks.create({
                line_items: [{ price: limit.parsingPriceId, quantity: 1 }],
                metadata: { user_id: userProfile.user_id, type: 'historical_parsing' }
              });
              await sendTemplateMessage(
                from,
                process.env.HEX_DEEPDIVE_CONFIRMATION,
                [
                  `To parse PDFs/images/audio, unlock DeepDive for ${limit.parsingPriceText}: ${paymentLink.url}. CSV/Excel uploads remain free (${limit.transactions} transactions).`
                ]
              );
              ensureReply(res, 'DeepDive payment link sent!');
              return;
            }

            const fileResp = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(fileResp.data);
            const filename = mediaUrl.split('/').pop() || 'upload';

            const summary = await parseUpload(
              buffer,
              filename,
              from,
              mediaType,
              deepDiveState.uploadType || 'csv',
              userProfile?.fiscal_year_start
            );

            if (deepDiveState.historicalDataUpload) {
              const transactionCount = summary?.transactions?.length || 0;
              if (transactionCount > (deepDiveState.maxTransactions || limit.transactions)) {
                ensureReply(res, `Upload exceeds ${deepDiveState.maxTransactions || limit.transactions} transactions. Contact support for larger datasets.`);
                return;
              }
              const dashUrl = `/dashboard/${from}?token=${userProfile?.dashboard_token || ''}`;
              ensureReply(res, `✅ ${transactionCount} new transactions processed. Track progress on your dashboard: ${dashUrl}`);
              deepDiveState.historicalDataUpload = false;
              deepDiveState.deepDiveUpload = false;
              await setPendingTransactionState(from, deepDiveState);
              return;
            }

            ensureReply(res, `File received and processed. ${summary ? 'Summary: ' + JSON.stringify(summary) : 'OK'}.`);
            deepDiveState.deepDiveUpload = false;
            await setPendingTransactionState(from, deepDiveState);
            return;
          } catch (err) {
            console.error('[DEEPDIVE] parse error:', err?.message);
            return next(err);
          }
        }
      }

      // ===== 3) MEDIA (non-DeepDive flow) =====
      if (mediaUrl && mediaType) {
        await handleMedia(
          from,
          mediaUrl,
          mediaType,
          userProfile,
          ownerId,
          ownerProfile,
          isOwner,
          res
        );
        ensureReply(res, 'Got your file — processing complete.');
        return;
      }

      // ===== 4) TIMECLOCK =====
      {
        const lower = input.toLowerCase();
        if (
          lower.includes('punch') ||
          lower.includes('break') ||
          lower.includes('lunch') ||
          lower.includes('drive') ||
          lower.includes('hours')
        ) {
          await handleTimeclock(
            from,
            input,
            userProfile,
            ownerId,
            ownerProfile,
            isOwner,
            res
          );
          ensureReply(res, '✅ Timeclock request received.');
          return;
        }
      }

      // ===== 5) GENERAL COMMANDS / AI fallback (delegated) =====
      await handleCommands(
        from,
        input,
        userProfile,
        ownerId,
        ownerProfile,
        isOwner,
        res
      );
      ensureReply(res, "I'm here to help. Try 'expense $100 tools', 'create job Roof Repair', or 'help'.");
      return;
    } catch (error) {
      console.error(`[ERROR] Webhook processing failed for ${maskPhone(from)}:`, error.message);
      return next(error);
    } finally {
      try {
        await releaseLock(req.lockKey, req.lockToken);
        console.log('[LOCK] released for', req.lockKey);
      } catch (e) {
        console.error('[WARN] Failed to release lock for', req.lockKey, ':', e.message);
      }
    }
  },
  // Centralized error handler (kept last)
  errorMiddleware
);

module.exports = router;
