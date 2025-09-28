// routes/webhook.js
const express = require('express');
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Import the commands registry (collection of handlers; may also export handleCommands)
const commands = require('../handlers/commands');
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
const { routeWithAI } = require('../nlp/intentRouter');

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

/** True if the message is a timeclock intent (supports “clocked/punched” past tense, etc.) */
function isTimeclockMessage(s = '') {
  const lc = String(s).toLowerCase();

  // clock/punch (present or past) + in/out
  if (/\b(?:clock|punch)(?:ed)?\s*(?:in|out)\b/.test(lc)) return true;

  // standalones
  if (/\bclock-?in\b/.test(lc)) return true;
  if (/\bclock-?out\b/.test(lc)) return true;
  if (/\bclockin\b/.test(lc)) return true;
  if (/\bclockout\b/.test(lc)) return true;

  // shift verbs
  if (/\bstart\s+(?:shift|work)\b/.test(lc)) return true;
  if (/\bend\s+(?:shift|work)\b/.test(lc)) return true;

  // other common timeclock keywords
  if (/\b(break|lunch|drive|hours?)\b/.test(lc)) return true;

  return false;
}

/** Normalize timeclock phrasing into “[Name] punched in/out (at TIME)”. */
function normalizeTimeclockInput(input, userProfile) {
  const original = String(input || '');
  let s = original.trim();

  // Helper: extract time (handles "8am", "8 am", "8:30am", "830am")
  const findTime = (text) => {
    // h:mm am/pm
    let m = text.match(/\b(\d{1,2}):(\d{2})\s*([ap])\.?m\.?\b/i);
    if (m) {
      const h = parseInt(m[1], 10);
      const mm = m[2];
      const ap = m[3].toLowerCase() === 'a' ? 'am' : 'pm';
      const t = `${h}:${mm} ${ap}`;
      return { t, rest: text.replace(m[0], '').trim() };
    }
    // hhmmam
    m = text.match(/\b(\d{1,2})(\d{2})\s*([ap])\.?m\.?\b/i);
    if (m) {
      const hRaw = parseInt(m[1], 10);
      const mm = m[2];
      const ap = m[3].toLowerCase() === 'a' ? 'am' : 'pm';
      const t = `${hRaw}:${mm} ${ap}`;
      return { t, rest: text.replace(m[0], '').trim() };
    }
    // h am/pm
    m = text.match(/\b(\d{1,2})\s*([ap])\.?m\.?\b/i);
    if (m) {
      const h = parseInt(m[1], 10);
      const ap = m[2].toLowerCase() === 'a' ? 'am' : 'pm';
      const t = `${h}:00 ${ap}`;
      return { t, rest: text.replace(m[0], '').trim() };
    }
    return { t: null, rest: text };
  };

  // normalize verbs to “punched in/out”
  s = s.replace(/\bclock(?:ed)?\s*in\b/gi, 'punched in');
  s = s.replace(/\bclock(?:ed)?\s*out\b/gi, 'punched out');
  s = s.replace(/\bpunch\s*in\b/gi, 'punched in');
  s = s.replace(/\bpunch\s*out\b/gi, 'punched out');

  // extract time (optional)
  const timeHit = findTime(s);
  const timeStr = timeHit.t;
  s = timeHit.rest;

  // A: "Scott punched in"
  let m = s.match(/^\s*([a-z][\w\s.'-]{1,50}?)\s+punched\s+(in|out)\b/i);
  if (m) {
    const person = m[1].trim();
    const dir = m[2].toLowerCase();
    const when = timeStr ? ` at ${timeStr}` : '';
    return `${person} punched ${dir}${when}`.trim();
  }

  // B: "punched in Scott"
  m = s.match(/\bpunched\s+(in|out)\s+([a-z][\w\s.'-]{1,50}?)\b/i);
  if (m) {
    const dir = m[1].toLowerCase();
    const person = m[2].trim();
    const when = timeStr ? ` at ${timeStr}` : '';
    return `${person} punched ${dir}${when}`.trim();
  }

  // C: only "punched in/out" → use profile name if available
  m = s.match(/\bpunched\s+(in|out)\b/i);
  if (m) {
    const dir = m[1].toLowerCase();
    const who = (userProfile && userProfile.name) ? userProfile.name : '';
    const when = timeStr ? ` at ${timeStr}` : '';
    return `${who ? who + ' ' : ''}punched ${dir}${when}`.trim();
  }

  // else stitch time back if we had it
  return timeStr ? `${s} at ${timeStr}`.trim() : original;
}

/** Try command handlers one by one. Put tasks and timeclock before expense to avoid misroutes. */
async function dispatchCommands(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  const order = ['tasks', 'job', 'timeclock', 'expense', 'revenue', 'bill', 'quote', 'metrics', 'tax', 'receipt', 'team'];

  for (const key of order) {
    const fn = commands[key];
    if (typeof fn !== 'function') continue;

    const out = await fn(from, input, userProfile, ownerId, ownerProfile, isOwner, res);

    if (res.headersSent) return true;

    if (typeof out === 'string' && out.trim().startsWith('<Response>')) {
      res.status(200).send(out);
      return true;
    }
    if (out && typeof out === 'object' && typeof out.twiml === 'string') {
      res.status(200).send(out.twiml);
      return true;
    }
    if (out === true) {
      ensureReply(res, '');
      return true;
    }
  }

  return false;
}

router.post(
  '/',
  // IMPORTANT: normalize user (sets req.from/ownerId) BEFORE taking a lock
  userProfileMiddleware,
  lockMiddleware,
  tokenMiddleware,
  async (req, res, next) => {
    const { From, Body, MediaUrl0, MediaContentType0 } = req.body || {};

    // userProfileMiddleware sets req.from to digits-only
    const from = req.from || String(From || '').replace(/^whatsapp:/, '').replace(/\D/g, '');
    const input = (Body || '').trim();
    const mediaUrl = MediaUrl0 || null;
    const mediaType = MediaContentType0 || null;

    // Capture WhatsApp location, if present
    const isLocation =
      (!!req.body.Latitude && !!req.body.Longitude) ||
      (req.body.MessageType && String(req.body.MessageType).toLowerCase() === 'location');

    const extras = {};
    if (isLocation) {
      const lat = parseFloat(req.body.Latitude);
      const lng = parseFloat(req.body.Longitude);
      if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
        extras.lat = lat;
        extras.lng = lng;
      }
      if (req.body.Address) {
        // Human label provided by WhatsApp UI; we still reverse-geocode on the server for consistency
        extras.address = String(req.body.Address).trim() || undefined;
      }
      console.log('[WEBHOOK] location payload:', { lat: extras.lat, lng: extras.lng, address: extras.address || null });
    }

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
          starter: { years: 7, transactions: 5000, parsingPriceId: process.env.HISTORICAL_PARSING_PRICE_STARTER, parsingPriceText: '$19' },
          pro:      { years: 7, transactions: 20000, parsingPriceId: process.env.HISTORICAL_PARSING_PRICE_PRO,      parsingPriceText: '$49' },
          enterprise:{ years: 7, transactions: 50000, parsingPriceId: process.env.HISTORICAL_PARSING_PRICE_ENTERPRISE, parsingPriceText: '$99' }
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
              'application/pdf', 'image/jpeg', 'image/png', 'audio/mpeg',
              'text/csv', 'application/vnd.ms-excel',
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

      // ===== 4) TIMECLOCK (direct keywords) =====
      {
        if (isTimeclockMessage(input)) {
          const normalized = normalizeTimeclockInput(input, userProfile);
          await handleTimeclock(
            from,
            normalized,
            userProfile,
            ownerId,
            ownerProfile,
            isOwner,
            res,
            extras     // <-- passes lat/lng/address; ensure your timeclock handler forwards to logTimeEntry()
          );
          if (!res.headersSent) ensureReply(res, '✅ Timeclock request received.');
          return;
        }
      }

      // ===== AI INTENT ROUTER (OpenAI) =====
      try {
        const ai = await routeWithAI(input, { userProfile });
        if (ai) {
          // Map normalized intents to your existing handlers
          if (ai.intent === 'timeclock.clock_in') {
            const who = ai.args.person || userProfile?.name || 'Unknown';
            const jobHint = ai.args.job ? ` @ ${ai.args.job}` : '';
            const t = ai.args.time ? ` at ${ai.args.time}` : '';
            const normalized = `${who} punched in${jobHint}${t}`;
            await handleTimeclock(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res, extras);
            if (!res.headersSent) ensureReply(res, '✅ Timeclock request received.');
            return;
          }

          if (ai.intent === 'timeclock.clock_out') {
            const who = ai.args.person || userProfile?.name || 'Unknown';
            const t = ai.args.time ? ` at ${ai.args.time}` : '';
            const normalized = `${who} punched out${t}`;
            await handleTimeclock(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res, extras);
            if (!res.headersSent) ensureReply(res, '✅ Clocked out.');
            return;
          }

          if (ai.intent === 'job.create') {
            const name = ai.args.name?.trim();
            if (name && typeof commands.job === 'function') {
              const normalized = `create job ${name}`;
              await commands.job(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res);
              if (!res.headersSent) ensureReply(res, '');
              return;
            }
          }

          if (ai.intent === 'expense.add') {
            const amt = ai.args.amount;
            const cat = ai.args.category ? ` ${ai.args.category}` : '';
            const fromWho = ai.args.merchant ? ` from ${ai.args.merchant}` : '';
            const normalized = `expense $${amt}${cat}${fromWho}`.trim();
            if (typeof commands.expense === 'function') {
              await commands.expense(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res);
              if (!res.headersSent) ensureReply(res, '');
              return;
            }
          }
          // Unknown intents fall through.
        }
      } catch (e) {
        console.warn('[AI Router] skipped due to error:', e?.message);
      }

      // ===== 5) FAST INTENT ROUTER (prioritize job to avoid expense parser grabbing it) =====
      if (
        /^\s*(create|new|add)\s+job\b/i.test(input) ||
        /^\s*(start|pause|resume|finish|summarize)\s+job\b/i.test(input)
      ) {
        if (typeof commands.job === 'function') {
          try {
            const handled = await commands.job(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
            if (handled !== false) {
              if (!res.headersSent) ensureReply(res, '');
              return;
            }
          } catch (e) {
            console.error('[ERROR] job handler threw:', e?.message);
          }
        } else {
          console.warn('[WARN] commands.job not callable; exports:', Object.keys(commands || {}));
        }
        // If job handler didn’t handle it, continue to generic dispatch below
      }

      // ===== 6) GENERAL COMMANDS (dispatch to individual handlers) =====
      {
        const handled = await dispatchCommands(
          from,
          input,
          userProfile,
          ownerId,
          ownerProfile,
          isOwner,
          res
        );
        if (handled) return;
      }

      // ===== 7) LEGACY COMBINED HANDLER (if present) =====
      if (typeof commands.handleCommands === 'function') {
        try {
          const handled = await commands.handleCommands(
            from,
            input,
            userProfile,
            ownerId,
            ownerProfile,
            isOwner,
            res
          );
          if (handled !== false) return;
        } catch (e) {
          console.error('[ERROR] handleCommands threw:', e?.message);
        }
      }

      // Fallback helper prompt
      ensureReply(
        res,
        "I'm here to help. Try 'expense $100 tools', 'create job Roof Repair', 'task - buy tape', or 'help'."
      );
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
