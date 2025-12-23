// handlers/media.js
const axios = require('axios');
const { parseMediaText } = require('../services/mediaParser');
const { extractTextFromImage } = require('../utils/visionService');
const transcriptionMod = require('../utils/transcriptionService');
const { handleTimeclock } = require('./commands/timeclock');

const {
  // NOTE: getActiveJob is legacy-stubbed in your postgres.js export and can throw.
  // We intentionally do NOT import or use it here.
  generateTimesheet,
} = require('../services/postgres');

const state = require('../utils/stateManager');
const getPendingTransactionState = state.getPendingTransactionState;
const deletePendingTransactionState = state.deletePendingTransactionState;

// Prefer mergePendingTransactionState; fall back to setPendingTransactionState (older builds)
const mergePendingTransactionState =
  state.mergePendingTransactionState ||
  (async (userId, patch) => state.setPendingTransactionState(userId, patch, { merge: true }));

// Be tolerant about how transcriptionService exports
const transcribeAudio =
  (transcriptionMod && typeof transcriptionMod.transcribeAudio === 'function' && transcriptionMod.transcribeAudio) ||
  (transcriptionMod && typeof transcriptionMod.default === 'function' && transcriptionMod.default) ||
  (typeof transcriptionMod === 'function' ? transcriptionMod : null);

/* ---------------- helpers ---------------- */

function twiml(text) {
  return `<Response><Message>${text}</Message></Response>`;
}

function getUserTz(userProfile) {
  return (
    userProfile?.timezone ||
    userProfile?.tz ||
    userProfile?.time_zone ||
    'America/Toronto'
  );
}

function fmtLocal(tsIso, tz) {
  try {
    return new Date(tsIso).toLocaleString('en-CA', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit'
    });
  } catch {
    return new Date(tsIso).toLocaleString();
  }
}

function toAmPm(tsIso, tz) {
  try {
    return new Date(tsIso).toLocaleString('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit'
    }).toLowerCase();
  } catch {
    return new Date(tsIso).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit'
    }).toLowerCase();
  }
}

function inferIntentFromText(s = '') {
  const lc = String(s).toLowerCase();
  if (/\b(clock|punch)\s+in\b/.test(lc) || /\bstart\s+(work|shift)\b/.test(lc)) return 'punch_in';
  if (/\b(clock|punch)\s+out\b/.test(lc) || /\b(end|finish|stop)\s+(work|shift)\b/.test(lc)) return 'punch_out';
  if (/\b(start|begin)\s+(break|lunch)\b/.test(lc) || /\bon\s+break\b/.test(lc)) return 'break_start';
  if (/\b(end|finish)\s+(break|lunch)\b/.test(lc) || /\boff\s+break\b/.test(lc)) return 'break_end';
  if (/\b(start|begin)\s+drive\b/.test(lc)) return 'drive_start';
  if (/\b(end|finish)\s+drive\b/.test(lc)) return 'drive_end';
  return null;
}

function normalizeExpenseFromTranscript(t) {
  const s = String(t || '').trim();

  // Try to grab amount
  const mAmt = s.match(/\$\s*([0-9]+(?:\.[0-9]{1,2})?)/i) || s.match(/\b([0-9]+(?:\.[0-9]{1,2})?)\b/);
  if (!mAmt) return null;

  const amt = mAmt[1];
  let store = null;
  let item = null;

  // store: "at Home Depot" OR "from Home Depot"
  const mStore = s.match(/\b(?:at|from)\s+([A-Za-z0-9&.'\- ]{2,60})(?:\s+on|\s+for|\s+today|\s+yesterday|\s+\d{4}-\d{2}-\d{2}|[.?!]|$)/i);
  if (mStore?.[1]) store = mStore[1].trim();

  // item: "on lumber" or "for lumber"
  const mItem = s.match(/\b(?:on|for)\s+(.+?)(?:\s+today|\s+yesterday|\s+\d{4}-\d{2}-\d{2}|[.?!]|$)/i);
  if (mItem?.[1]) item = mItem[1].trim();

  let dateToken = '';
  if (/\btoday\b/i.test(s)) dateToken = ' today';
  else if (/\byesterday\b/i.test(s)) dateToken = ' yesterday';

  const safeItem = item || 'items';
  const safeStore = store || 'Unknown Store';

  // Your expense.js deterministic regex: "expense 452 nails from Home Depot"
  return `expense ${amt} ${safeItem} from ${safeStore}${dateToken}`;
}

function normalizeRevenueFromTranscript(t) {
  const s = String(t || '').trim();
  const mAmt = s.match(/\$\s*([0-9]+(?:\.[0-9]{1,2})?)/i) || s.match(/\b([0-9]+(?:\.[0-9]{1,2})?)\b/);
  if (!mAmt) return null;
  const amt = mAmt[1];

  // job-ish token: for/on/job <...> OR from job <...>
  let job = null;

  // prefer "for/on"
  const mJob = s.match(/\b(?:for|on|job)\s+(.+?)(?:\s+today|\s+yesterday|\s+\d{4}-\d{2}-\d{2}|[.?!]|$)/i);
  if (mJob?.[1]) job = mJob[1].trim();

  // handle "from job 1556 ..."
  if (!job) {
    const mFromJob = s.match(/\bfrom\s+job\s+(.+?)(?:\s+today|\s+yesterday|\s+\d{4}-\d{2}-\d{2}|[.?!]|$)/i);
    if (mFromJob?.[1]) job = mFromJob[1].trim();
  }

  let dateToken = '';
  if (/\btoday\b/i.test(s)) dateToken = ' today';
  else if (/\byesterday\b/i.test(s)) dateToken = ' yesterday';

  if (!job) return `received $${amt}${dateToken}`;
  return `received $${amt} for ${job}${dateToken}`;
}

function truncateText(str, maxChars) {
  if (!str) return null;
  const s = String(str);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars);
}

const MAX_MEDIA_TRANSCRIPT_CHARS = 8000;

async function runTimeclockPipeline(from, normalized, userProfile, ownerId) {
  let payload = null;

  const up = userProfile || {};
  const ownerIdFromProfile = String(up.owner_id || up.ownerId || ownerId || '').replace(/\D/g, '');
  const isOwner = String(up.user_id || '').replace(/\D/g, '') === ownerIdFromProfile;

  const resStub = {
    headersSent: false,
    status() { return this; },
    type() { return this; },
    send(body) { payload = String(body || ''); this.headersSent = true; return this; }
  };

  try {
    await handleTimeclock(
      from,
      normalized,
      userProfile,
      ownerIdFromProfile || ownerId,
      null,
      isOwner,
      resStub,
      {}
    );
  } catch (e) {
    console.error('[MEDIA] handleTimeclock failed:', e?.message);
  }
  return payload;
}

function normalizeContentType(mediaType) {
  return String(mediaType || '').split(';')[0].trim().toLowerCase();
}

// handle string OR { transcript/text/confidence }
function normalizeTranscriptionResult(res) {
  if (!res) return { transcript: '', confidence: null };
  if (typeof res === 'string') return { transcript: res, confidence: null };
  if (typeof res === 'object') {
    const transcript = res.transcript || res.text || res.result || '';
    const confidence = Number.isFinite(Number(res.confidence)) ? Number(res.confidence) : null;
    return { transcript: String(transcript || ''), confidence };
  }
  return { transcript: '', confidence: null };
}

/**
 * Attempt to extract Twilio MediaSid from the mediaUrl query params.
 * This gives you a stable id for idempotency instead of `${from}:${Date.now()}`.
 */
function getTwilioMediaSid(mediaUrl) {
  try {
    const u = new URL(String(mediaUrl || ''));
    return u.searchParams.get('MediaSid') || u.searchParams.get('mediaSid') || null;
  } catch {
    return null;
  }
}

/**
 * Attach media meta to pending state so expense/revenue can persist it after confirmation.
 * Safe merge; never blocks.
 */
async function attachPendingMediaMeta(from, meta) {
  try {
    const url = String(meta?.url || '').trim() || null;
    const type = String(meta?.type || '').trim() || null;
    const transcript = truncateText(meta?.transcript, MAX_MEDIA_TRANSCRIPT_CHARS);
    const confidence = Number.isFinite(Number(meta?.confidence)) ? Number(meta.confidence) : null;

    if (!url && !type && !transcript && confidence == null) return;

    const pending = await getPendingTransactionState(from);
    await mergePendingTransactionState(from, {
      ...(pending || {}),
      pendingMediaMeta: { url, type, transcript, confidence }
    });
  } catch (e) {
    console.warn('[MEDIA] attachPendingMediaMeta failed (ignored):', e?.message);
  }
}

/**
 * IMPORTANT:
 * If this is text-only (no mediaUrl), and we're in a finance confirm flow,
 * do NOT "handle as media". Return transcript and let webhook route it to revenue.js/expense.js.
 */
async function maybePassThroughFinanceTextOnly(from, input) {
  if (!String(input || '').trim()) return null;

  const pendingState = await getPendingTransactionState(from);

  // pendingMedia can be boolean OR object in different builds. Be defensive.
  const pendingMedia = pendingState?.pendingMedia;
  const pendingMediaType =
    (pendingMedia && typeof pendingMedia === 'object' ? pendingMedia.type : null) ||
    pendingState?.type ||
    null;

  if (pendingMediaType === 'expense' || pendingMediaType === 'revenue') {
    return { transcript: String(input || '').trim(), twiml: null };
  }
  return null;
}

/* ---------------- main ---------------- */

async function handleMedia(from, input, userProfile, ownerId, mediaUrl, mediaType) {
  let reply;
  try {
    console.log('[MEDIA] incoming', { from, mediaType, hasUrl: !!mediaUrl, inputLen: (input || '').length });

    // ✅ Text-only replies MUST be allowed through (especially finance confirm "yes/edit/cancel")
    if (!mediaUrl) {
      const pass = await maybePassThroughFinanceTextOnly(from, input);
      if (pass) return pass;

      // If it's text-only but not a finance confirm, treat it as plain text
      // so webhook/router can handle it normally.
      return { transcript: String(input || '').trim(), twiml: null };
    }

    // From here: we DO have mediaUrl, so validate media types
    const validImageTypes = ['image/jpeg', 'image/png', 'image/webp'];

    const baseType = normalizeContentType(mediaType);
    console.log('[MEDIA] normalized content-type', { original: mediaType, baseType });

    const isSupportedImage = validImageTypes.includes(baseType);

    // Be resilient: accept any audio/*
    const isAudioFamily = baseType.startsWith('audio/');
    const isSupportedAudio = isAudioFamily;

    if (!isSupportedImage && !isSupportedAudio) {
      reply = `⚠️ Unsupported media type: ${mediaType}. Please send an image (JPEG/PNG/WEBP) or an audio/voice note.`;
      return twiml(reply);
    }

    // Stable id for idempotency: use MediaSid when available
    const mediaSid = getTwilioMediaSid(mediaUrl);
    const stableMediaMsgId = mediaSid ? `${from}:${mediaSid}` : `${from}:${Date.now()}`;

    /* ---------- Build text from media ---------- */
    let extractedText = String(input || '').trim();
    const normType = normalizeContentType(mediaType);

    let mediaMeta = {
      url: mediaUrl || null,
      type: normType || null,
      transcript: null,
      confidence: null
    };

    // AUDIO
    if (isAudioFamily) {
      if (typeof transcribeAudio !== 'function') {
        console.error('[MEDIA] transcribeAudio is not a function (check utils/transcriptionService exports)');
        return twiml(`⚠️ Voice transcription isn’t available right now. Please type the details like "received $500 for <job> today".`);
      }

      const urlLen = (mediaUrl || '').length;
      console.log('[MEDIA] starting transcription', { mediaType, normType, urlLen });

      let transcript = '';
      let confidence = null;

      try {
        const resp = await axios.get(mediaUrl, {
          responseType: 'arraybuffer',
          auth: {
            username: process.env.TWILIO_ACCOUNT_SID,
            password: process.env.TWILIO_AUTH_TOKEN
          },
          maxContentLength: 8 * 1024 * 1024,
        });

        const audioBuf = Buffer.from(resp.data);
        console.log('[MEDIA] audio bytes', audioBuf?.length || 0, 'mime', mediaType, 'norm', normType, 'baseType', baseType);

        const r1 = await transcribeAudio(audioBuf, normType, 'both');
        const n1 = normalizeTranscriptionResult(r1);
        transcript = n1.transcript;
        confidence = n1.confidence;

        console.log('[MEDIA] transcript bytes', transcript ? transcript.length : 0);

        // OGG/Opus sometimes needs a different label for some engines
        if (!transcript && normType === 'audio/ogg') {
          try {
            console.log('[MEDIA] retry transcription with fallback mime: audio/webm');
            const r2 = await transcribeAudio(audioBuf, 'audio/webm', 'both');
            const n2 = normalizeTranscriptionResult(r2);
            transcript = n2.transcript;
            confidence = confidence ?? n2.confidence;
            console.log('[MEDIA] fallback transcript bytes', transcript ? transcript.length : 0);
          } catch (e2) {
            console.warn('[MEDIA] fallback transcribe failed:', e2.message);
          }
        }

        console.log('[MEDIA] transcript text', transcript || '(none)');
      } catch (e) {
        console.error('[MEDIA] transcribe fetch/exec failed:', e.message);
      }

      if (!transcript) {
        return twiml(
          `⚠️ I couldn’t understand the audio. Try again, or text me the details like "received $500 for 1556 Medway Park Dr today".`
        );
      }

      mediaMeta.transcript = truncateText(transcript.trim(), MAX_MEDIA_TRANSCRIPT_CHARS);
      mediaMeta.confidence = Number.isFinite(Number(confidence)) ? Number(confidence) : null;

      const lc = transcript.toLowerCase();
      const looksHours   = /\bhours?\b/.test(lc) || /\btimesheet\b/.test(lc);
      const looksExpense = /\b(expense|receipt|spent|cost|paid|bought|purchase|purchased)\b/.test(lc);
      const looksRevenue = /\b(revenue|payment|paid|deposit|sale|received|got paid)\b/.test(lc);
      const timeclockIntent = inferIntentFromText(transcript);

      // If it smells like finance/timeclock/hours, attach meta and parse it.
      if (timeclockIntent || looksHours || looksExpense || looksRevenue) {
        await attachPendingMediaMeta(from, mediaMeta);
        extractedText = transcript.trim();
      } else {
        // Otherwise, treat as normal voice message (not finance)
        return { transcript: transcript.trim(), twiml: null };
      }
    }

    // IMAGE
    if (isSupportedImage) {
      const { text } = await extractTextFromImage(mediaUrl);
      console.log('[MEDIA] OCR text length', (text || '').length);
      extractedText = (text || extractedText || '').trim();

      mediaMeta.transcript = truncateText(extractedText, MAX_MEDIA_TRANSCRIPT_CHARS);
      mediaMeta.confidence = null;

      // Images are audit-relevant → attach meta
      await attachPendingMediaMeta(from, mediaMeta);
    }

    if (!extractedText) {
      const msg = `Is this an expense receipt, revenue, or timesheet? Reply 'expense', 'revenue', or 'timesheet'.`;
      const pending = await getPendingTransactionState(from);
      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingMedia: { url: mediaUrl, type: null }
      });
      return twiml(msg);
    }

    /* ---------- Parse ---------- */
    console.log('[MEDIA] parseMediaText()', { excerpt: (extractedText || '').slice(0, 80) });

    // ✅ parseMediaText now returns {type:'unknown'} instead of throwing (new drop-in mediaParser)
    const result = await parseMediaText(extractedText);

    // If parser returned unknown, try a last-mile normalize into a command (helps older flows)
    if (!result || result.type === 'unknown') {
      const lc = String(extractedText || '').toLowerCase();
      const looksExpense = /\b(expense|receipt|spent|cost|paid|bought|purchase|purchased)\b/.test(lc);
      const looksRevenue = /\b(revenue|payment|deposit|sale|received|got paid)\b/.test(lc);

      if (looksExpense) {
        const norm = normalizeExpenseFromTranscript(extractedText);
        if (norm) return { transcript: norm, twiml: null };
      }
      if (looksRevenue) {
        const norm = normalizeRevenueFromTranscript(extractedText);
        if (norm) return { transcript: norm, twiml: null };
      }

      const msg = `I couldn’t read that. Is this an expense receipt, revenue, or timesheet? Reply 'expense', 'revenue', or 'timesheet'.`;
      const pending = await getPendingTransactionState(from);
      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingMedia: { url: mediaUrl, type: null }
      });
      return twiml(msg);
    }

    /* ---------- Handle parse result ---------- */

    if (result.type === 'hours_inquiry') {
      const name = result.data.employeeName || userProfile?.name || '';
      const tz = getUserTz(userProfile);

      if (result.data.period) {
        const { message } = await generateTimesheet({
          ownerId,
          person: name,
          period: result.data.period,
          tz,
          now: new Date()
        });
        return twiml(message);
      }

      const pending = await getPendingTransactionState(from);
      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingMedia: { type: 'hours_inquiry' },
        pendingHours: { employeeName: name }
      });

      return twiml(`Looks like you’re asking about ${name}’s hours. Do you want **today**, **this week**, or **this month**?`);
    }

    if (result.type === 'time_entry') {
      let { employeeName, type, timestamp } = result.data;

      const inferred = inferIntentFromText(extractedText);
      if (inferred === 'punch_in'    && type === 'punch_out')  type = 'punch_in';
      if (inferred === 'punch_out'   && type === 'punch_in')   type = 'punch_out';
      if (inferred === 'break_start' && type === 'break_end')  type = 'break_start';
      if (inferred === 'break_end'   && type === 'break_start')type = 'break_end';

      let hasName = !!(employeeName && String(employeeName).trim());
      if (!hasName) {
        const mFor = extractedText.match(/\bfor\s+([A-Za-z][A-Za-z.'\- ]{0,60})\b/i);
        if (mFor) {
          employeeName = mFor[1].trim();
          hasName = true;
        }
      }

      const tz = getUserTz(userProfile);
      const timeSuffix = /T/.test(timestamp) ? ` at ${toAmPm(timestamp, tz)}` : '';

      let normalized;
      if (hasName) {
        const who = employeeName || userProfile.name || 'Unknown';
        if (type === 'punch_in')          normalized = `${who} punched in${timeSuffix}`;
        else if (type === 'punch_out')    normalized = `${who} punched out${timeSuffix}`;
        else if (type === 'break_start')  normalized = `start break for ${who}${timeSuffix}`;
        else if (type === 'break_end')    normalized = `end break for ${who}${timeSuffix}`;
        else if (type === 'drive_start')  normalized = `start drive for ${who}${timeSuffix}`;
        else if (type === 'drive_end')    normalized = `end drive for ${who}${timeSuffix}`;
        else                              normalized = `${who} punched in${timeSuffix}`;
      } else {
        normalized = extractedText;
      }

      const tw = await runTimeclockPipeline(from, normalized, userProfile, ownerId);
      if (typeof tw === 'string' && tw.trim()) return tw;

      const humanTime = fmtLocal(timestamp, tz);
      let summaryTail = '';
      try {
        if (type === 'punch_out') {
          const { message } = await generateTimesheet({
            ownerId,
            person: employeeName || userProfile?.name || '',
            period: 'day',
            tz,
            now: new Date()
          });
          const firstLine = String(message || '').split('\n')[0] || '';
          if (firstLine) summaryTail = `\n${firstLine.replace(/^[^A-Za-z0-9]*/, '')}`;
        }
      } catch (e) {
        console.warn('[MEDIA] timesheet summary failed:', e.message);
      }

      reply = `✅ ${type.replace('_', ' ')} logged for ${employeeName || userProfile?.name || 'Unknown'} at ${humanTime}.${summaryTail}`;
      return twiml(reply);
    }

    // EXPENSE parsed from media → confirm via expense.js
    if (result.type === 'expense') {
      const { item, amount, store, date, category, jobName } = result.data;

      const pending = await getPendingTransactionState(from);
      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingMedia: { type: 'expense' },
        pendingExpense: { item, amount, store, date, category, jobName },
        type: 'expense',

        // ✅ stable id for idempotency across confirm flow
        expenseSourceMsgId: stableMediaMsgId
      });

      reply = `Please confirm: Log expense ${amount} for ${item}${store ? ` from ${store}` : ''} on ${date}${jobName ? ` for ${jobName}` : ''}${category ? ` (Category: ${category})` : ''}. Reply yes/edit/cancel.`;
      return twiml(reply);
    }

    // REVENUE parsed from media → confirm via revenue.js
    if (result.type === 'revenue') {
      const { description, amount, source, date, category, jobName } = result.data;

      const pending = await getPendingTransactionState(from);
      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingMedia: { type: 'revenue' },
        pendingRevenue: { description, amount, source, date, category, jobName },
        type: 'revenue',

        // ✅ stable id for idempotency across confirm flow
        revenueSourceMsgId: stableMediaMsgId
      });

      const srcPart = (source && String(source).trim() && String(source).trim().toLowerCase() !== 'unknown')
        ? ` from ${source}`
        : '';

      reply = `Please confirm: Payment ${amount}${srcPart} on ${date}${jobName ? ` for ${jobName}` : ''}${category ? ` (Category: ${category})` : ''}. Reply yes/edit/cancel.`;
      return twiml(reply);
    }

    // Fallback
    reply = `Is this an expense receipt, revenue, or timesheet? Reply 'expense', 'revenue', or 'timesheet'.`;
    {
      const pending = await getPendingTransactionState(from);
      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingMedia: { url: mediaUrl, type: null }
      });
    }
    return twiml(reply);

  } catch (error) {
    console.error(`[MEDIA] handleMedia failed for ${from}:`, error.message);
    reply = `⚠️ Failed to process media: ${error.message}`;
    return twiml(reply);
  }
}

module.exports.handleMedia = handleMedia;
