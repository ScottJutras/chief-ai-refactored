// routes/webhook.js
// Serverless-safe WhatsApp webhook router for Vercel + Express
const express = require('express');
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Handlers / services
const commands = require('../handlers/commands');
const tasksHandler = require('../handlers/commands/tasks'); // <-- direct import fallback
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

/** Mask phone in logs (do NOT use for IDs) */
function maskPhone(p) {
  return p ? String(p).replace(/^(\d{4})\d+(\d{2})$/, '$1…$2') : '';
}

/** Ensure Twilio gets a TwiML reply if a handler forgot to res.send() */
function ensureReply(res, text) {
  if (!res.headersSent) {
    res.status(200).type('text/xml').send(`<Response><Message>${text}</Message></Response>`);
  }
}

/** Timeclock keyword detection */
function isTimeclockMessage(s = '') {
  const lc = String(s).toLowerCase();
  if (/\b(?:clock|punch)(?:ed)?\s*(?:in|out)\b/.test(lc)) return true;
  if (/\bclock-?in\b/.test(lc)) return true;
  if (/\bclock-?out\b/.test(lc)) return true;
  if (/\bclockin\b/.test(lc)) return true;
  if (/\bclockout\b/.test(lc)) return true;
  if (/\bstart\s+(?:shift|work)\b/.test(lc)) return true;
  if (/\bend\s+(?:shift|work)\b/.test(lc)) return true;
  if (/\b(break|lunch|drive|hours?)\b/.test(lc)) return true;
  return false;
}

/** Normalize to “<Name> punched in/out (at TIME)” */
function normalizeTimeclockInput(input, userProfile) {
  const original = String(input || '');
  let s = original.trim();
  const findTime = (text) => {
    let m = text.match(/\b(\d{1,2}):(\d{2})\s*([ap])\.?m\.?\b/i);
    if (m) return { t: `${parseInt(m[1], 10)}:${m[2]} ${m[3].toLowerCase()==='a'?'am':'pm'}`, rest: text.replace(m[0],'').trim() };
    m = text.match(/\b(\d{1,2})(\d{2})\s*([ap])\.?m\.?\b/i);
    if (m) return { t: `${parseInt(m[1],10)}:${m[2]} ${m[3].toLowerCase()==='a'?'am':'pm'}`, rest: text.replace(m[0],'').trim() };
    m = text.match(/\b(\d{1,2})\s*([ap])\.?m\.?\b/i);
    if (m) return { t: `${parseInt(m[1],10)}:00 ${m[2].toLowerCase()==='a'?'am':'pm'}`, rest: text.replace(m[0],'').trim() };
    return { t: null, rest: text };
  };
  s = s.replace(/\bclock(?:ed)?\s*in\b/gi, 'punched in')
       .replace(/\bclock(?:ed)?\s*out\b/gi, 'punched out')
       .replace(/\bpunch\s*in\b/gi, 'punched in')
       .replace(/\bpunch\s*out\b/gi, 'punched out');
  const timeHit = findTime(s);
  const timeStr = timeHit.t;
  s = timeHit.rest;

  let m = s.match(/^\s*([a-z][\w\s.'-]{1,50}?)\s+punched\s+(in|out)\b/i);
  if (m) return `${m[1].trim()} punched ${m[2].toLowerCase()}${timeStr ? ` at ${timeStr}` : ''}`.trim();
  m = s.match(/\bpunched\s+(in|out)\s+([a-z][\w\s.'-]{1,50}?)\b/i);
  if (m) return `${m[2].trim()} punched ${m[1].toLowerCase()}${timeStr ? ` at ${timeStr}` : ''}`.trim();
  m = s.match(/\bpunched\s+(in|out)\b/i);
  if (m) {
    const who = (userProfile && userProfile.name) ? userProfile.name : '';
    return `${who ? who + ' ' : ''}punched ${m[1].toLowerCase()}${timeStr ? ` at ${timeStr}` : ''}`.trim();
  }
  return timeStr ? `${s} at ${timeStr}`.trim() : original;
}

/** Helper to resolve a handler by key with fallbacks */
function getHandler(key) {
  if (key === 'tasks') {
    return (typeof commands.tasks === 'function') ? commands.tasks
         : (typeof tasksHandler === 'function') ? tasksHandler
         : null;
  }
  return (typeof commands[key] === 'function') ? commands[key] : null;
}

/** Try command handlers in safe order (skip timeclock unless it actually matches) */
async function dispatchCommands(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  const order = ['tasks', 'job', 'timeclock', 'expense', 'revenue', 'bill', 'quote', 'metrics', 'tax', 'receipt', 'team'];
  for (const key of order) {
    if (key === 'timeclock' && !isTimeclockMessage(input)) continue; // guard

    const fn = getHandler(key);
    if (typeof fn !== 'function') continue;

    const out = await fn(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
    if (res.headersSent) return true;

    if (typeof out === 'string' && out.trim().startsWith('<Response>')) {
      res.status(200).type('text/xml').send(out);
      return true;
    }
    if (out && typeof out === 'object' && typeof out.twiml === 'string') {
      res.status(200).type('text/xml').send(out.twiml);
      return true;
    }
    if (out === true) {
      ensureReply(res, '');
      return true;
    }
  }
  return false;
}

// ---- ROUTES ----

// Basic GET for health (Twilio occasionally pings)
router.get('/', (_req, res) => res.status(200).send('Webhook OK'));

// Main WhatsApp webhook
router.post(
  '/',
  // Security/hardening first:
  (req, res, next) => {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    if ((req.headers['content-length'] || '0') > 5 * 1024 * 1024) return res.status(413).send('Payload too large');
    next();
  },

  // IMPORTANT: normalize + auth + lock before handlers
  userProfileMiddleware,
  lockMiddleware,
  tokenMiddleware,

  async (req, res, next) => {
    const { From, Body, MediaUrl0, MediaContentType0 } = req.body || {};
    const from = req.from || String(From || '').replace(/^whatsapp:/, '').replace(/\D/g, '');
    const input = (Body || '').trim();
    const mediaUrl = MediaUrl0 || null;
    const mediaType = MediaContentType0 || null;

    // WhatsApp location payload
    const isLocation = (!!req.body.Latitude && !!req.body.Longitude) ||
      (req.body.MessageType && String(req.body.MessageType).toLowerCase() === 'location');
    const extras = {};
    if (isLocation) {
      const lat = parseFloat(req.body.Latitude);
      const lng = parseFloat(req.body.Longitude);
      if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
        extras.lat = lat; extras.lng = lng;
      }
      if (req.body.Address) extras.address = String(req.body.Address).trim() || undefined;
      console.log('[WEBHOOK] location payload:', { lat: extras.lat, lng: extras.lng, address: extras.address || null });
    }

    const { userProfile, ownerId, ownerProfile, isOwner } = req;

    try {
      // 0) Onboarding
      if ((userProfile && userProfile.onboarding_in_progress) || input.toLowerCase().includes('start onboarding')) {
        await handleOnboarding(from, input, userProfile, ownerId, res);
        ensureReply(res, `Welcome to Chief AI! Quick question — what's your name?`);
        return;
      }

      // 1) Upgrade flow (Stripe)
      {
        const lc = input.toLowerCase();
        const wantsUpgrade = lc.includes('upgrade to pro') || lc.includes('upgrade to enterprise');
        if (wantsUpgrade) {
          try {
            if (userProfile?.stripe_subscription_id) {
              await sendMessage(from, `⚠️ You already have an active ${userProfile.subscription_tier} subscription. Contact support to change plans.`);
              ensureReply(res, 'Already subscribed!');
              return;
            }
            const tier = lc.includes('pro') ? 'pro' : 'enterprise';
            const priceId = tier === 'pro' ? process.env.PRO_PRICE_ID : process.env.ENTERPRISE_PRICE_ID;
            const priceText = tier === 'pro' ? '$29' : '$99';

            const customer = await stripe.customers.create({ phone: from, metadata: { user_id: userProfile.user_id } });
            const paymentLink = await stripe.paymentLinks.create({
              line_items: [{ price: priceId, quantity: 1 }],
              metadata: { user_id: userProfile.user_id }
            });

            const { Pool } = require('pg');
            const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
            await pool.query(`UPDATE users SET stripe_customer_id=$1, subscription_tier=$2 WHERE user_id=$3`, [customer.id, tier, userProfile.user_id]);

            await sendTemplateMessage(from, process.env.HEX_UPGRADE_NOW, [`Upgrade to ${tier} for ${priceText}/month CAD: ${paymentLink.url}`]);
            ensureReply(res, 'Upgrade link sent!');
            return;
          } catch (err) {
            console.error('[UPGRADE] error:', err?.message);
            return next(err);
          }
        }
      }

      // 2) DeepDive / historical upload
      {
        const lc = input.toLowerCase();
        const triggersDeepDive = lc.includes('upload history') || lc.includes('historical data') || lc.includes('deepdive') || lc.includes('deep dive');

        const tierLimits = {
          starter: { years: 7, transactions: 5000, parsingPriceId: process.env.HISTORICAL_PARSING_PRICE_STARTER, parsingPriceText: '$19' },
          pro: { years: 7, transactions: 20000, parsingPriceId: process.env.HISTORICAL_PARSING_PRICE_PRO, parsingPriceText: '$49' },
          enterprise: { years: 7, transactions: 50000, parsingPriceId: process.env.HISTORICAL_PARSING_PRICE_ENTERPRISE, parsingPriceText: '$99' }
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
                await sendTemplateMessage(from, process.env.HEX_DEEPDIVE_CONFIRMATION, [
                  `Upload up to 7 years of historical data via CSV/Excel for free (${limit.transactions} transactions). For historical image/audio parsing, unlock Chief AI’s DeepDive for ${limit.parsingPriceText}: ${paymentLink.url}`
                ]);
                ensureReply(res, 'DeepDive payment link sent!');
                return;
              }
            } catch (err) {
              console.error('[DEEPDIVE] payment init error:', err?.message);
              return next(err);
            }
          }

          const dashUrl = `/dashboard/${from}?token=${userProfile?.dashboard_token || ''}`;
          ensureReply(res, `Ready to upload historical data (up to ${limit.years} years, ${limit.transactions} transactions). Send CSV/Excel for free or PDFs/images/audio for ${limit.parsingPriceText} via DeepDive. Track progress on your dashboard: ${dashUrl}`);
          return;
        }

        // If mid DeepDive upload and sent a media file, process it here
        const deepDiveState = await getPendingTransactionState(from);
        const isInDeepDiveUpload = deepDiveState?.deepDiveUpload === true || deepDiveState?.historicalDataUpload === true;

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

            if (['application/pdf', 'image/jpeg', 'image/png', 'audio/mpeg'].includes(mediaType) && !userProfile?.historical_parsing_purchased) {
              const paymentLink = await stripe.paymentLinks.create({
                line_items: [{ price: limit.parsingPriceId, quantity: 1 }],
                metadata: { user_id: userProfile.user_id, type: 'historical_parsing' }
              });
              await sendTemplateMessage(from, process.env.HEX_DEEPDIVE_CONFIRMATION, [
                `To parse PDFs/images/audio, unlock DeepDive for ${limit.parsingPriceText}: ${paymentLink.url}. CSV/Excel uploads remain free (${limit.transactions} transactions).`
              ]);
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

      // 3) Media (non-DeepDive)
      if (mediaUrl && mediaType) {
        await handleMedia(from, mediaUrl, mediaType, userProfile, ownerId, ownerProfile, isOwner, res);
        ensureReply(res, 'Got your file — processing complete.');
        return;
      }

      // 4) TASKS (fast path) — catch "task ..." / "tasks ..." / "todo ..."
      {
        const m = input.match(/^\s*(tasks?|todo)\b[:\-]?\s*(.*)$/i);
        if (m) {
          const rest = m[2] && m[2].trim() ? m[2].trim() : '';
          const normalized = rest ? `task - ${rest}` : 'task';
          const tasksFn = getHandler('tasks');
          if (typeof tasksFn === 'function') {
            console.log('[ROUTER] Fast tasks path hit:', { from, normalized });
            try {
              const handled = await tasksFn(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res);
              if (handled !== false) {
                if (!res.headersSent) ensureReply(res, '');
                return;
              }
            } catch (e) {
              console.error('[ERROR] tasks handler threw:', e?.message);
            }
          } else {
            console.warn('[ROUTER] tasks handler not found in registry; using fallback failed.');
          }
          // Avoid misrouting to timeclock if we clearly meant tasks
          ensureReply(res, `Try "task - buy tape" or "task - order nails".`);
          return;
        }
      }

      // 5) Timeclock (direct keywords)
      if (isTimeclockMessage(input)) {
        console.log('[ROUTER] Direct timeclock path hit:', { from, input });
        const normalized = normalizeTimeclockInput(input, userProfile);
        await handleTimeclock(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res, extras);
        if (!res.headersSent) ensureReply(res, '✅ Timeclock request received.');
        return;
      }

      // 6) AI intent router
      try {
        const ai = await routeWithAI(input, { userProfile });
        if (ai) {
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
          if (ai.intent === 'job.create' && typeof commands.job === 'function') {
            const name = ai.args.name?.trim();
            if (name) {
              const normalized = `create job ${name}`;
              await commands.job(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res);
              if (!res.headersSent) ensureReply(res, '');
              return;
            }
          }
          if (ai.intent === 'expense.add' && typeof commands.expense === 'function') {
            const amt = ai.args.amount;
            const cat = ai.args.category ? ` ${ai.args.category}` : '';
            const fromWho = ai.args.merchant ? ` from ${ai.args.merchant}` : '';
            const normalized = `expense $${amt}${cat}${fromWho}`.trim();
            await commands.expense(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res);
            if (!res.headersSent) ensureReply(res, '');
            return;
          }
        }
      } catch (e) {
        console.warn('[AI Router] skipped due to error:', e?.message);
      }

      // 7) Fast intent router for jobs
      if (/^\s*(create|new|add)\s+job\b/i.test(input) || /^\s*(start|pause|resume|finish|summarize)\s+job\b/i.test(input)) {
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
      }

      // 8) General dispatch (with timeclock guard inside)
      {
        const handled = await dispatchCommands(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
        if (handled) return;
      }

      // 9) Legacy combined handler
      if (typeof commands.handleCommands === 'function') {
        try {
          const handled = await commands.handleCommands(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
          if (handled !== false) return;
        } catch (e) {
          console.error('[ERROR] handleCommands threw:', e?.message);
        }
      }

      // Fallback helper
      ensureReply(res, "I'm here to help. Try 'expense $100 tools', 'create job Roof Repair', 'task - buy tape', or 'help'.");
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

  // Centralized error handler (keep last)
  errorMiddleware
);

module.exports = router;
