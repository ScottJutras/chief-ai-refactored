// routes/webhook.js
// Serverless-safe WhatsApp webhook router for Vercel + Express (conversational + memory)
const express = require('express');
const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Handlers / services
const commands = require('../handlers/commands');
const tasksHandler = require('../handlers/commands/tasks'); // direct import fallback for tasks
const { handleMedia } = require('../handlers/media');
const { handleOnboarding } = require('../handlers/onboarding');
const { handleTimeclock } = require('../handlers/commands/timeclock');
const { handleOwnerApproval } = require('../handlers/commands/owner_approval');

// Middleware
const { lockMiddleware, releaseLock } = require('../middleware/lock');
const { userProfileMiddleware } = require('../middleware/userProfile');
const { tokenMiddleware } = require('../middleware/token');
const { errorMiddleware } = require('../middleware/error');

// Services
const { sendMessage, sendTemplateMessage } = require('../services/twilio');
const { parseUpload } = require('../services/deepDive');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('../utils/stateManager');

// AI routers
const { routeWithAI } = require('../nlp/intentRouter');           // tool-calls (strict)
const { converseAndRoute } = require('../nlp/conversation');

// Memory
const { logEvent, getConvoState, saveConvoState, getMemory, upsertMemory } = require('../services/memory');

// ⬅️ NEW: pull pending-prompt checker from Postgres layer
const { getPendingPrompt, logTimeEntry, getActiveJob, appendToUserSpreadsheet, generateTimesheet } = require('../services/postgres');

const router = express.Router();

// ----------------- helpers -----------------
function maskPhone(p) {
  return p ? String(p).replace(/^(\d{4})\d+(\d{2})$/, '$1…$2') : '';
}

function ensureReply(res, text) {
  if (!res.headersSent) {
    res.status(200).type('text/xml').send(`<Response><Message>${text}</Message></Response>`);
  }
}

// ⬇️ NEW: small helpers used by the pending text-reply handler
function twiml(text) {
  return `<Response><Message>${text}</Message></Response>`;
}
function getUserTz(userProfile) {
  return userProfile?.timezone || userProfile?.tz || userProfile?.time_zone || 'America/Toronto';
}
function friendlyTypeLabel(type) {
  if (!type) return 'entry';
  if (type === 'time_entry') return 'time entry';
  if (type === 'hours_inquiry') return 'hours inquiry';
  return String(type).replace('_', ' ');
}

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

function normalizeTimeclockInput(input, userProfile) {
  const original = String(input || '');
  let s = original.trim();

  const findTime = (text) => {
    let m = text.match(/\b(\d{1,2}):(\d{2})\s*([ap])\.?m\.?\b/i);
    if (m) return { t: `${parseInt(m[1],10)}:${m[2]} ${m[3].toLowerCase()==='a'?'am':'pm'}`, rest: text.replace(m[0],'').trim() };
    m = text.match(/\b(\d{1,2})(\d{2})\s*([ap])\.?m\.?\b/i);
    if (m) return { t: `${parseInt(m[1],10)}:${m[2]} ${m[3].toLowerCase()==='a'?'am':'pm'}`, rest: text.replace(m[0],'').trim() };
    m = text.match(/\b(\d{1,2})\s*([ap])\.?m\.?\b/i);
    if (m) return { t: `${parseInt(m[1],10)}:00 ${m[2].toLowerCase()==='a'?'am':'pm'}`, rest: text.replace(m[0],'').trim() };
    return { t: null, rest: text };
  };

  s = s.replace(/\bclock(?:ed)?\s*in\b/gi, 'punched in')
       .replace(/\bclock(?:ed)?\s*out\b/gi, 'punched out')
       .replace(/\b(punch\s*in)\b/gi, 'punched in')
       .replace(/\b(punch\s*out)\b/gi, 'punched out');

  const timeHit = findTime(s);
  const timeStr = timeHit.t;
  s = timeHit.rest;

  // name first → “Justin punched in …”
  let m = s.match(/^\s*([a-z][\w\s.'-]{1,50}?)\s+punched\s+(in|out)\b/i);
  if (m) return `${m[1].trim()} punched ${m[2].toLowerCase()}${timeStr ? ` at ${timeStr}` : ''}`.trim();

  // action first, name after → “punched in Justin …”
  // allow punctuation or “at …” right after the name
  m = s.match(/\bpunched\s+(in|out)\s+([a-z][\w\s.'-]{1,50}?)(?=\s|$|[,.!?]|(?:\s+at\b))/i);
  if (m) return `${m[2].trim()} punched ${m[1].toLowerCase()}${timeStr ? ` at ${timeStr}` : ''}`.trim();

  // bare “punched in/out” → default to self
  m = s.match(/\bpunched\s+(in|out)\b/i);
  if (m) {
    const who = (userProfile && userProfile.name) ? userProfile.name : '';
    return `${who ? who + ' ' : ''}punched ${m[1].toLowerCase()}${timeStr ? ` at ${timeStr}` : ''}`.trim();
  }
  return timeStr ? `${s} at ${timeStr}`.trim() : original;
}

function getHandler(key) {
  if (key === 'tasks') {
    return (typeof commands.tasks === 'function') ? commands.tasks
         : (typeof tasksHandler === 'function') ? tasksHandler
         : null;
  }
  return (typeof commands[key] === 'function') ? commands[key] : null;
}

async function dispatchCommands(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  const order = ['tasks', 'job', 'timeclock', 'expense', 'revenue', 'bill', 'quote', 'metrics', 'tax', 'receipt', 'team'];
  for (const key of order) {
    if (key === 'timeclock' && !isTimeclockMessage(input)) continue;

    const fn = getHandler(key);
    if (typeof fn !== 'function') continue;

    const out = await fn(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
    if (res.headersSent) return true;

    if (typeof out === 'string' && out.trim().startsWith('<Response>')) {
      res.status(200).type('text/xml').send(out); return true;
    }
    if (out && typeof out === 'object' && typeof out.twiml === 'string') {
      res.status(200).type('text/xml').send(out.twiml); return true;
    }
    if (out === true) { ensureReply(res, ''); return true; }
  }
  return false;
}

// ----------------- routes -----------------
router.get('/', (_req, res) => res.status(200).send('Webhook OK'));

router.post(
  '/',
  (req, res, next) => {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    if ((req.headers['content-length'] || '0') > 5 * 1024 * 1024) return res.status(413).send('Payload too large');
    next();
  },
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
      if (!Number.isNaN(lat) && !Number.isNaN(lng)) { extras.lat = lat; extras.lng = lng; }
      if (req.body.Address) extras.address = String(req.body.Address).trim() || undefined;
      console.log('[WEBHOOK] location payload:', { lat: extras.lat, lng: extras.lng, address: extras.address || null });
    }

    const { userProfile, ownerId, ownerProfile, isOwner } = req;

    // ⬇️⬇️⬇️ NEW: Handle pending confirmations for TEXT-ONLY replies (no media) ⬇️⬇️⬇️
    try {
      const pendingState = await getPendingTransactionState(from);
      const hasPending = !!pendingState?.pendingMedia;
      const isTextOnly = !mediaUrl && !!input;

      if (hasPending && isTextOnly) {
        const type = pendingState.pendingMedia.type; // may be null
        const lcInput = String(input || '').toLowerCase().trim();

        // Hours inquiry → expect “today / week / month”
        if (type === 'hours_inquiry') {
          const m = lcInput.match(/\b(today|day|this day|week|this week|month|this month)\b/i);
          if (m) {
            const raw = m[1].toLowerCase();
            const period = raw.includes('week') ? 'week' : raw.includes('month') ? 'month' : 'day';
            const tz = getUserTz(userProfile);
            const name = pendingState.pendingHours?.employeeName || userProfile?.name || '';
            const { message } = await generateTimesheet({
              ownerId,
              person: name,
              period,
              tz,
              now: new Date()
            });
            await deletePendingTransactionState(from);
            return res.status(200).type('text/xml').send(twiml(message));
          }
          // Not a valid period → re-prompt
          return res
            .status(200)
            .type('text/xml')
            .send(twiml(`Got it. Do you want **today**, **this week**, or **this month** for ${pendingState.pendingHours?.employeeName || 'them'}?`));
        }

        // Expense / Revenue / Time entry confirmation
        if (type === 'expense' || type === 'revenue' || type === 'time_entry') {
          if (lcInput === 'yes') {
            if (type === 'expense') {
              const data = pendingState.pendingExpense;
              await appendToUserSpreadsheet(ownerId, [
                data.date,
                data.item,
                data.amount,
                data.store,
                (await getActiveJob(ownerId)) || 'Uncategorized',
                'expense',
                data.category,
                data.mediaUrl || null,
                userProfile.name || 'Unknown',
              ]);
              await deletePendingTransactionState(from);
              return res.status(200).type('text/xml')
                .send(twiml(`✅ Expense logged: ${data.amount} for ${data.item} from ${data.store} (Category: ${data.category})`));
            }
            if (type === 'revenue') {
              const data = pendingState.pendingRevenue;
              await appendToUserSpreadsheet(ownerId, [
                data.date,
                data.description,
                data.amount,
                data.source,
                (await getActiveJob(ownerId)) || 'Uncategorized',
                'revenue',
                data.category,
                data.mediaUrl || null,
                userProfile.name || 'Unknown',
              ]);
              await deletePendingTransactionState(from);
              return res.status(200).type('text/xml')
                .send(twiml(`✅ Revenue logged: ${data.amount} from ${data.source} (Category: ${data.category})`));
            }
            if (type === 'time_entry') {
              const { employeeName, type: entryType, timestamp, job } = pendingState.pendingTimeEntry;
              await logTimeEntry(ownerId, employeeName, entryType, timestamp, job);
              const tz = getUserTz(userProfile);
              await deletePendingTransactionState(from);
              return res.status(200).type('text/xml')
                .send(twiml(`✅ ${entryType.replace('_', ' ')} logged for ${employeeName} at ${new Date(timestamp).toLocaleString('en-CA', { timeZone: tz, hour: 'numeric', minute: '2-digit' })}${job ? ` on ${job}` : ''}`));
            }
          }

          if (lcInput === 'no' || lcInput === 'cancel') {
            await deletePendingTransactionState(from);
            return res.status(200).type('text/xml')
              .send(twiml(`❌ ${friendlyTypeLabel(type)} cancelled.`));
          }

          if (lcInput === 'edit') {
            await deletePendingTransactionState(from);
            return res.status(200).type('text/xml')
              .send(twiml(`Please resend the ${friendlyTypeLabel(type)} details.`));
          }

          // Not yes/no/edit → gentle nudge
          return res.status(200).type('text/xml')
            .send(twiml(`⚠️ Please reply with 'yes', 'no', or 'edit' to confirm or cancel the ${friendlyTypeLabel(type)}.`));
        }

        // Pending type is null (we previously asked “expense/revenue/timesheet?”)
        if (type == null) {
          return res.status(200).type('text/xml')
            .send(twiml(`Is this an expense receipt, revenue, or timesheet? Reply 'expense', 'revenue', or 'timesheet'.`));
        }
      }
    } catch (e) {
      console.warn('[WEBHOOK] pending text-reply handler skipped:', e?.message);
    }
    // ⬆️⬆️⬆️ END new pending text-reply handler ⬆️⬆️⬆️

    // ---------- memory bootstrapping ----------
    const tenantId = ownerId;
    const userId = from;
    let convo = await getConvoState(tenantId, userId);     // DB snapshot (aliases, history, active_job…)
    const state = {
      user_id: userId,
      tenant_id: tenantId,
      active_job: null,
      active_job_id: null,
      aliases: {},
      history: []
    };
    state.active_job = convo.active_job || null;
    state.active_job_id = convo.active_job_id || null;
    state.aliases = convo.aliases || {};
    state.history = Array.isArray(convo.history) ? convo.history.slice(-5) : [];

    // Optional fetch of defaults you may use in your nlp/router
    const memory = await getMemory(tenantId, userId, [
      'default.expense.bucket',
      'labor_rate',
      'default.markup',
      'client.default_terms'
    ]);

    try {
      // 0) Onboarding
      if ((userProfile && userProfile.onboarding_in_progress) || input.toLowerCase().includes('start onboarding')) {
        const response = await handleOnboarding(from, input, userProfile, ownerId, res);
        await logEvent(tenantId, userId, 'onboarding', { input, response });
        await saveConvoState(tenantId, userId, {
          history: [...(convo.history || []).slice(-4), { input, response, intent: 'onboarding' }]
        });
        ensureReply(res, `Welcome to Chief AI! Quick question — what's your name?`);
        return;
      }

      // 0.5) Owner approval command ("approve Justin as team")
      if (/^approve\s+/i.test(input)) {
        const handled = await handleOwnerApproval(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
        if (handled !== false) {
          await logEvent(tenantId, userId, 'owner_approval', { input });
          await saveConvoState(tenantId, userId, {
            history: [...(convo.history || []).slice(-4), { input, response: 'Approval processed.', intent: 'owner_approval' }]
          });
          if (!res.headersSent) ensureReply(res, 'Approval processed.');
          return;
        }
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

            const { query } = require('../services/postgres');

            const customer = await stripe.customers.create({ phone: from, metadata: { user_id: userProfile.user_id } });
            const paymentLink = await stripe.paymentLinks.create({
              line_items: [{ price: priceId, quantity: 1 }],
              metadata: { user_id: userProfile.user_id }
            });

            await query(
              `UPDATE users SET stripe_customer_id=$1, subscription_tier=$2 WHERE user_id=$3`,
              [customer.id, tier, userProfile.user_id]
            );

            await sendTemplateMessage(from, process.env.HEX_UPGRADE_NOW, [`Upgrade to ${tier} for ${priceText}/month CAD: ${paymentLink.url}`]);
            await logEvent(tenantId, userId, 'upgrade', { tier, link: paymentLink.url });
            await saveConvoState(tenantId, userId, {
              history: [...(convo.history || []).slice(-4), { input, response: 'Upgrade link sent!', intent: 'upgrade' }]
            });
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
                await logEvent(tenantId, userId, 'deepdive_paylink', { link: paymentLink.url, tier });
                ensureReply(res, 'DeepDive payment link sent!');
                return;
              }
            } catch (err) {
              console.error('[DEEPDIVE] payment init error:', err?.message);
              return next(err);
            }
          }

          const dashUrl = `/dashboard/${from}?token=${userProfile?.dashboard_token || ''}`;
          await logEvent(tenantId, userId, 'deepdive_init', { tier, maxTransactions: limit.transactions });
          await saveConvoState(tenantId, userId, {
            history: [...(convo.history || []).slice(-4), { input, response: `Ready to upload historical data…`, intent: 'deepdive' }]
          });
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
              await logEvent(tenantId, userId, 'deepdive_blocked_payment_required', { link: paymentLink.url });
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
              await logEvent(tenantId, userId, 'deepdive_upload', { transactionCount, mediaType });
              await saveConvoState(tenantId, userId, {
                history: [...(convo.history || []).slice(-4), { input: `file:${mediaType}`, response: `✅ ${transactionCount} new transactions processed.`, intent: 'deepdive_upload' }]
              });
              ensureReply(res, `✅ ${transactionCount} new transactions processed. Track progress on your dashboard: ${dashUrl}`);
              deepDiveState.historicalDataUpload = false;
              deepDiveState.deepDiveUpload = false;
              await setPendingTransactionState(from, deepDiveState);
              return;
            }

            await logEvent(tenantId, userId, 'deepdive_file_processed', { mediaType, filename });
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
  const twimlOut = await handleMedia(from, input, userProfile, ownerId, mediaUrl, mediaType);
  await logEvent(tenantId, userId, 'media', { mediaType, mediaUrl });
  await saveConvoState(tenantId, userId, {
    history: [...(convo.history || []).slice(-4), { input: `file:${mediaType}`, response: 'media handled', intent: 'media' }]
  });
  if (typeof twimlOut === 'string') {
    res.status(200).type('text/xml').send(twimlOut);
  } else {
    ensureReply(res, 'Got your file — processing complete.');
  }
  return;
}


      // 3.5) ⬅️ NEW: Fast-path for pending timeclock prompts (must run BEFORE conversational/AI routers)
      try {
        const pending = await getPendingPrompt(ownerId);
        if (pending) {
          const normalized = normalizeTimeclockInput(input, userProfile);
          const handled = await handleTimeclock(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res, extras);
          await logEvent(tenantId, userId, 'timeclock_prompt_reply', { input, normalized, pending_kind: pending.kind });
          if (!res.headersSent) ensureReply(res, handled ? '' : ''); // handler already replies; this is a safety net
          return;
        }
      } catch (e) {
        console.warn('[WEBHOOK] pending prompt check failed:', e?.message);
      }
      
      // 3.6) PRIORITY: Direct timeclock route on explicit timeclock language
if (isTimeclockMessage(input)) {
  const normalized = normalizeTimeclockInput(input, userProfile);
  await handleTimeclock(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res, extras);
  await logEvent(tenantId, userId, 'timeclock_direct', { normalized });
  if (!res.headersSent) ensureReply(res, '✅ Timeclock request received.');
  return;
}


      // 4) Conversational router first (prevents misroutes, emits handler-safe strings)
      try {
        const conv = await converseAndRoute(input, { userProfile, ownerId: tenantId, convoState: state });

        // Quick helper to pluck plain text from TwiML when we want to log it
        const extractMsg = (twimlStr) => {
          if (!twimlStr) return '';
          const m = twimlStr.match(/<Message>([\s\S]*?)<\/Message>/);
          return m ? m[1] : '';
        };

        if (conv?.handled && conv.twiml) {
          const responseText = extractMsg(conv.twiml);
          await logEvent(tenantId, userId, 'clarify', { input, response: responseText, intent: conv.intent || null });
          await saveConvoState(tenantId, userId, {
            last_intent: conv.intent || convo.last_intent || null,
            last_args: conv.args || convo.last_args || {},
            history: [...(convo.history || []).slice(-4), { input, response: responseText, intent: conv.intent || null }]
          });
          res.status(200).type('text/xml').send(conv.twiml);
          return;
        }

        if (conv && conv.route && conv.normalized) {
          let responseText = extractMsg(conv.twiml);
          let handled = false;

          if (conv.route === 'tasks') {
            const tasksFn = getHandler('tasks');
            if (typeof tasksFn === 'function') {
              handled = await tasksFn(from, conv.normalized, userProfile, ownerId, ownerProfile, isOwner, res);
              responseText = responseText || 'Task created!';
              await logEvent(tenantId, userId, 'tasks.create', { normalized: conv.normalized, args: conv.args || {} });
            }
          } else if (conv.route === 'expense') {
            const expenseFn = getHandler('expense');
            if (typeof expenseFn === 'function') {
              handled = await expenseFn(from, conv.normalized, userProfile, ownerId, ownerProfile, isOwner, res);
              responseText = responseText || 'Expense logged!';
              await logEvent(tenantId, userId, 'expense.add', { normalized: conv.normalized, args: conv.args || {} });

              // Example: learn an alias/vendor default if present
              if (conv.args?.alias && (conv.args.vendor || conv.args.job)) {
                await upsertMemory(tenantId, userId, `alias.vendor.${conv.args.alias.toLowerCase()}`, { name: conv.args.vendor || conv.args.job });
              }
              // Example: if user repeatedly targets Overhead, you could set a default (lightweight; keep/adjust rule in your router)
              if (conv.args?.bucket === 'Overhead') {
                await upsertMemory(tenantId, userId, 'default.expense.bucket', { bucket: 'Overhead' });
              }
            }
          } else if (conv.route === 'timeclock') {
            const normalized = normalizeTimeclockInput(conv.normalized, userProfile);
            handled = await handleTimeclock(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res, extras);
            responseText = responseText || '✅ Timeclock request received.';
            await logEvent(tenantId, userId, 'timeclock', { normalized, args: conv.args || {} });

            // If router resolved a job, keep it active
            if (conv.args?.job || conv.args?.job_id) {
              await saveConvoState(tenantId, userId, {
                active_job: conv.args.job || convo.active_job || null,
                active_job_id: conv.args.job_id || convo.active_job_id || null
              });
            }
          } else if (conv.route === 'job') {
            const jobFn = getHandler('job');
            if (typeof jobFn === 'function') {
              handled = await jobFn(from, conv.normalized, userProfile, ownerId, ownerProfile, isOwner, res);
              responseText = responseText || 'Job created!';
              await logEvent(tenantId, userId, 'job.create', { normalized: conv.normalized, args: conv.args || {} });
            }
          }

          if (handled) {
            await saveConvoState(tenantId, userId, {
              last_intent: conv.intent || convo.last_intent || null,
              last_args: conv.args || convo.last_args || {},
              history: [...(convo.history || []).slice(-4), { input, response: responseText, intent: conv.intent || null }]
            });
            if (!res.headersSent && conv.twiml) res.status(200).type('text/xml').send(conv.twiml);
            return;
          }
        }
      } catch (e) {
        console.warn('[Conversational Router] error:', e?.message);
      }

      // 5) Timeclock (direct keywords)
      if (isTimeclockMessage(input)) {
        const normalized = normalizeTimeclockInput(input, userProfile);
        await handleTimeclock(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res, extras);
        await logEvent(tenantId, userId, 'timeclock', { normalized });
        if (!res.headersSent) ensureReply(res, '✅ Timeclock request received.');
        return;
      }

      // 6) AI intent router (tool-calls)
      try {
        const ai = await routeWithAI(input, { userProfile });
        if (ai) {
          let handled = false;
          let responseText = 'Action completed!';
          let normalizedForLog = null;

          if (ai.intent === 'timeclock.clock_in') {
            const who = ai.args.person || userProfile?.name || 'Unknown';
            const jobHint = ai.args.job ? ` @ ${ai.args.job}` : '';
            const t = ai.args.time ? ` at ${ai.args.time}` : '';
            const normalized = `${who} punched in${jobHint}${t}`;
            normalizedForLog = normalized;
            handled = await handleTimeclock(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res, extras);
            responseText = `Punched in${jobHint}! What’s next?`;
          } else if (ai.intent === 'timeclock.clock_out') {
            const who = ai.args.person || userProfile?.name || 'Unknown';
            const t = ai.args.time ? ` at ${ai.args.time}` : '';
            const normalized = `${who} punched out${t}`;
            normalizedForLog = normalized;
            handled = await handleTimeclock(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res, extras);
            responseText = `Clocked out${t}! Anything else?`;
          } else if (ai.intent === 'job.create') {
            const name = ai.args.name?.trim();
            if (name && typeof commands.job === 'function') {
              const normalized = `create job ${name}`;
              normalizedForLog = normalized;
              handled = await commands.job(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res);
              responseText = `Created job: ${name}. Need tasks for it?`;
            }
          } else if (ai.intent === 'expense.add') {
            const amt = ai.args.amount;
            const cat = ai.args.category ? ` ${ai.args.category}` : '';
            const fromWho = ai.args.merchant ? ` from ${ai.args.merchant}` : '';
            const normalized = `expense $${amt}${cat}${fromWho}`.trim();
            normalizedForLog = normalized;
            const expenseFn = getHandler('expense');
            if (typeof expenseFn === 'function') {
              handled = await expenseFn(from, normalized, userProfile, ownerId, ownerProfile, isOwner, res);
              responseText = `Logged $${amt}${fromWho}! Got more expenses?`;
              if (ai.args.merchant) {
                await upsertMemory(tenantId, userId, `alias.vendor.${ai.args.merchant.toLowerCase()}`, { name: ai.args.merchant });
              }
            }
          }

          if (handled) {
            await logEvent(tenantId, userId, ai.intent, { normalized: normalizedForLog, args: ai.args });
            await saveConvoState(tenantId, userId, {
              last_intent: ai.intent,
              last_args: ai.args,
              history: [...(convo.history || []).slice(-4), { input, response: responseText, intent: ai.intent }]
            });
            if (!res.headersSent) ensureReply(res, responseText);
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
              await logEvent(tenantId, userId, 'job', { input });
              await saveConvoState(tenantId, userId, {
                history: [...(convo.history || []).slice(-4), { input, response: 'Job action completed.', intent: 'job' }]
              });
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

      // 8) General dispatch (with internal timeclock guard)
      {
        const handled = await dispatchCommands(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
        if (handled) {
          await logEvent(tenantId, userId, 'dispatch', { input });
          await saveConvoState(tenantId, userId, {
            history: [...(convo.history || []).slice(-4), { input, response: 'Action completed.', intent: 'dispatch' }]
          });
          return;
        }
      }

      // 9) Legacy combined handler
      if (typeof commands.handleCommands === 'function') {
        try {
          const handled = await commands.handleCommands(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
          if (handled !== false) {
            await logEvent(tenantId, userId, 'legacy', { input });
            await saveConvoState(tenantId, userId, {
              history: [...(convo.history || []).slice(-4), { input, response: 'Action completed.', intent: 'legacy' }]
            });
            return;
          }
        } catch (e) {
          console.error('[ERROR] handleCommands threw:', e?.message);
        }
      }

      // Fallback helper
      const response = "I'm here to help! Try 'expense $100 tools', 'create job Roof Repair', 'task - buy tape', or 'help'.";
      await logEvent(tenantId, userId, 'fallback', { input, response });
      await saveConvoState(tenantId, userId, {
        history: [...(convo.history || []).slice(-4), { input, response, intent: null }]
      });
      ensureReply(res, response);
      return;
    } catch (error) {
      console.error(`[ERROR] Webhook processing failed for ${maskPhone(from)}:`, error.message);
      await logEvent(tenantId, userId, 'error', { input, error: error.message });
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
  errorMiddleware
);

module.exports = router;
