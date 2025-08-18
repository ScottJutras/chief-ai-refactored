// routes/webhook.js
const express = require('express');
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const { handleCommands } = require('../handlers/commands');
const { handleMedia } = require('../handlers/media');
const { handleOnboarding } = require('../handlers/onboarding');
const { handleTimeclock } = require('../handlers/timeclock');

const { lockMiddleware, releaseLock } = require('../middleware/lock');
const { userProfileMiddleware } = require('../middleware/userProfile');
const { tokenMiddleware } = require('../middleware/token');
const { errorMiddleware } = require('../middleware/error');

const { sendMessage, sendTemplateMessage } = require('../services/twilio');
const { parseUpload } = require('../services/deepDive');
const { getPendingTransactionState, setPendingTransactionState } = require('../utils/stateManager');

const router = express.Router();

/**
 * For logs only (don’t use for IDs)
 */
function maskPhone(p) {
  return p ? p.replace(/^(\d{4})\d+(\d{2})$/, '$1…$2') : '';
}

/**
 * POST /api/webhook
 * Twilio sends application/x-www-form-urlencoded body:
 *  - From, Body, MediaUrl0, MediaContentType0, etc.
 *
 * Notes:
 *  - NEVER reference a lowercase `body` variable; use `req.body` or the destructured `Body`.
 *  - Always release the per-number lock in a `finally` block.
 */
router.post(
  '/',
  lockMiddleware,
  userProfileMiddleware,
  tokenMiddleware,
  async (req, res, next) => {
    // Destructure from req.body (Twilio param casing)
    const { From, Body, MediaUrl0, MediaContentType0 } = req.body || {};
    const from = req.from || From || 'UNKNOWN_FROM';
    const input = (Body || '').trim();
    const mediaUrl = MediaUrl0 || null;
    const mediaType = MediaContentType0 || null;

    // Enriched by userProfileMiddleware / tokenMiddleware
    const { userProfile, ownerId, ownerProfile, isOwner } = req;

    // Lock is created in lockMiddleware; keep the key consistent here
    const lockKey = `lock:${from}`;

    try {
      // ===== 0) Onboarding path =====
      if (
        (userProfile && userProfile.onboarding_in_progress) ||
        input.toLowerCase().includes('start onboarding')
      ) {
        await handleOnboarding(from, input, userProfile, ownerId, res);
        return;
      }

      // ===== 1) UPGRADE FLOW (Stripe) =====
      // Matches: "upgrade to pro" or "upgrade to enterprise"
      {
        const lc = input.toLowerCase();
        const wantsUpgrade =
          lc.includes('upgrade to pro') || lc.includes('upgrade to enterprise');

        if (wantsUpgrade) {
          try {
            if (userProfile?.stripe_subscription_id) {
              await sendMessage(
                from,
                `⚠️ You already have an active ${userProfile.subscription_tier} subscription. Contact support to change plans.`
              );
              res.status(200).send(`<Response><Message>Already subscribed!</Message></Response>`);
              return;
            }

            const tier = lc.includes('pro') ? 'pro' : 'enterprise';
            const priceId =
              tier === 'pro' ? process.env.PRO_PRICE_ID : process.env.ENTERPRISE_PRICE_ID;
            const priceText = tier === 'pro' ? '$29' : '$99';

            // Create/ensure Stripe customer and a payment link
            const customer = await stripe.customers.create({
              phone: from,
              metadata: { user_id: userProfile.user_id }
            });

            const paymentLink = await stripe.paymentLinks.create({
              line_items: [{ price: priceId, quantity: 1 }],
              metadata: { user_id: userProfile.user_id }
            });

            // Persist minimal customer + desired tier (sub is activated via webhook)
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

            res.status(200).send(`<Response><Message>Upgrade link sent!</Message></Response>`);
            return;
          } catch (err) {
            console.error('[UPGRADE] error:', err?.message);
            // Fall through to error handler
            return next(err);
          }
        }
      }

      // ===== 2) DEEPDIVE / HISTORICAL UPLOAD FLOW =====
      // Triggers: "upload history", "historical data", "deepdive", or "deep dive"
      //   - Sets state with per-tier limits
      //   - While active, media uploads get parsed via parseUpload
      {
        const lc = input.toLowerCase();
        const triggersDeepDive =
          lc.includes('upload history') ||
          lc.includes('historical data') ||
          lc.includes('deepdive') ||
          lc.includes('deep dive');

        // Per-tier limits & parsing price (only needed for paid parsing of images/audio)
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
          // Default to CSV/Excel path free-of-charge
          await setPendingTransactionState(from, {
            historicalDataUpload: true,
            deepDiveUpload: true,
            maxTransactions: limit.transactions,
            uploadType: 'csv'
          });

          // If user immediately sends paid media (image/pdf/audio), require purchase (if not already purchased)
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
                res.status(200).send(`<Response><Message>DeepDive payment link sent!</Message></Response>`);
                return;
              }
            } catch (err) {
              console.error('[DEEPDIVE] payment init error:', err?.message);
              return next(err);
            }
          }

          // Prompt user to upload now
          const dashUrl = `/dashboard/${from}?token=${userProfile?.dashboard_token || ''}`;
          res.status(200).send(
            `<Response><Message>Ready to upload historical data (up to ${limit.years} years, ${limit.transactions} transactions). Send CSV/Excel for free or PDFs/images/audio for ${limit.parsingPriceText} via DeepDive. Track progress on your dashboard: ${dashUrl}</Message></Response>`
          );
          return;
        }

        // If they’re mid DeepDive upload and sent a media file, process it here
        const deepDiveState = await getPendingTransactionState(from);
        const isInDeepDiveUpload = deepDiveState?.deepDiveUpload === true || deepDiveState?.historicalDataUpload === true;

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
              res.status(200).send(`<Response><Message>Unsupported file type. Please upload a PDF, image, audio, CSV, or Excel.</Message></Response>`);
              return;
            }

            // If uploading paid media and not purchased, gate it
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
              res.status(200).send(`<Response><Message>DeepDive payment link sent!</Message></Response>`);
              return;
            }

            // Pull file from Twilio URL and parse
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
                res.status(200).send(
                  `<Response><Message>Upload exceeds ${deepDiveState.maxTransactions || limit.transactions} transactions. Contact support for larger datasets.</Message></Response>`
                );
                return;
              }
              const dashUrl = `/dashboard/${from}?token=${userProfile?.dashboard_token || ''}`;
              res.status(200).send(
                `<Response><Message>✅ ${transactionCount} new transactions processed. Track progress on your dashboard: ${dashUrl}</Message></Response>`
              );
              deepDiveState.historicalDataUpload = false;
              deepDiveState.deepDiveUpload = false;
              await setPendingTransactionState(from, deepDiveState);
              return;
            }

            res.status(200).send(
              `<Response><Message>File received and processed. ${summary ? 'Summary: ' + JSON.stringify(summary) : 'OK'}.</Message></Response>`
            );
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
        return;
      }

      // ===== 4) TIMECLOCK =====
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
        return;
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
      return;
    } catch (error) {
      console.error(`[ERROR] Webhook processing failed for ${maskPhone(from)}:`, error.message);
      // Defer to centralized error handler
      return next(error);
    } finally {
      try {
        await releaseLock(lockKey);
        console.log('[LOCK] released for', maskPhone(from));
      } catch (e) {
        console.error(`[WARN] Failed to release lock for ${maskPhone(from)}:`, e.message);
      }
    }
  },
  // Centralized error handler (kept last)
  errorMiddleware
);

module.exports = router;
