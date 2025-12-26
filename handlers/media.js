// handlers/media.js
const axios = require('axios');
const { parseMediaText } = require('../services/mediaParser');
const { extractTextFromImage } = require('../utils/visionService');
const transcriptionMod = require('../utils/transcriptionService');
const { handleTimeclock } = require('./commands/timeclock');

const { generateTimesheet } = require('../services/postgres');

const state = require('../utils/stateManager');
const getPendingTransactionState = state.getPendingTransactionState;

const mergePendingTransactionState =
  state.mergePendingTransactionState ||
  (async (userId, patch) => state.setPendingTransactionState(userId, patch, { merge: true }));

// Be tolerant about how transcriptionService exports
const transcribeAudio =
  (transcriptionMod && typeof transcriptionMod.transcribeAudio === 'function' && transcriptionMod.transcribeAudio) ||
  (transcriptionMod && typeof transcriptionMod.default === 'function' && transcriptionMod.default) ||
  (typeof transcriptionMod === 'function' ? transcriptionMod : null);

/* ---------------- helpers ---------------- */

function xmlEsc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function twiml(text) {
  return `<Response><Message>${xmlEsc(text)}</Message></Response>`;
}

function getUserTz(userProfile) {
  return userProfile?.timezone || userProfile?.tz || userProfile?.time_zone || 'America/Toronto';
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
    return new Date(tsIso)
      .toLocaleString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })
      .toLowerCase();
  } catch {
    return new Date(tsIso)
      .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      .toLowerCase();
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

function truncateText(str, maxChars) {
  if (!str) return null;
  const s = String(str);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars);
}

const MAX_MEDIA_TRANSCRIPT_CHARS = 8000;

async function runTimeclockPipeline(from, normalized, userProfile, ownerId) {
  let payload = null;

  // NOTE: ownerId may be UUID in your system. For timeclock we keep legacy behavior:
  // derive "isOwner" by comparing digit-only strings if possible, but pass through ownerId untouched.
  const up = userProfile || {};
  const ownerIdFromProfile = up.owner_id || up.ownerId || ownerId || null;

  const isOwner = (() => {
    try {
      const a = String(up.user_id || '').replace(/\D/g, '');
      const b = String(ownerIdFromProfile || '').replace(/\D/g, '');
      if (!a || !b) return false;
      return a === b;
    } catch {
      return false;
    }
  })();

  const resStub = {
    headersSent: false,
    status() { return this; },
    type() { return this; },
    send(body) {
      payload = String(body || '');
      this.headersSent = true;
      return this;
    }
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

/**
 * Finance intent classifier used for media ONLY.
 * NOTE: We intentionally keep this lightweight and deterministic.
 * The actual parsing + confirmation is done by expense.js / revenue.js.
 */
function financeIntentFromText(text) {
  const lc = String(text || '').toLowerCase();

  // Expense-ish words
  const looksExpense =
    /\b(expense|receipt|spent|cost|paid|bought|buy|purchase|purchased|ordered|charge|charged)\b/.test(lc);

  // Revenue-ish words
  const looksRevenue =
    /\b(revenue|payment|paid\s+by|deposit|deposited|sale|received|got\s+paid|invoice\s+paid)\b/.test(lc);

  if (looksExpense && looksRevenue) {
    if (/\b(received|deposit|deposited|got\s+paid|invoice\s+paid)\b/.test(lc)) return { kind: 'revenue' };
    return { kind: 'expense' };
  }

  if (looksExpense) return { kind: 'expense' };
  if (looksRevenue) return { kind: 'revenue' };
  return { kind: null };
}

async function markPendingFinance({ from, kind, stableMediaMsgId }) {
  const pending = await getPendingTransactionState(from);
  await mergePendingTransactionState(from, {
    ...(pending || {}),
    type: kind,
    pendingMedia: { type: kind },
    // ✅ alignment: handlers use these as the stable idempotency keys
    expenseSourceMsgId: kind === 'expense' ? stableMediaMsgId : (pending?.expenseSourceMsgId || null),
    revenueSourceMsgId: kind === 'revenue' ? stableMediaMsgId : (pending?.revenueSourceMsgId || null),
  });
}

/* ---------------- main ---------------- */

async function handleMedia(from, input, userProfile, ownerId, mediaUrl, mediaType) {
  try {
    console.log('[MEDIA] incoming', {
      from,
      mediaType,
      hasUrl: !!mediaUrl,
      inputLen: (input || '').length
    });

    // ✅ Text-only: let webhook/router handle it
    if (!mediaUrl) {
      const pass = await maybePassThroughFinanceTextOnly(from, input);
      if (pass) return pass;
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
      return {
        transcript: null,
        twiml: twiml(`⚠️ Unsupported media type: ${mediaType}. Please send an image (JPEG/PNG/WEBP) or an audio/voice note.`)
      };
    }

    // Stable id for idempotency: use MediaSid when available
    const mediaSid = getTwilioMediaSid(mediaUrl);
    const stableMediaMsgId = mediaSid ? `${from}:${mediaSid}` : `${from}:${Date.now()}`;

    /* ---------- Build text from media ---------- */
    let extractedText = String(input || '').trim();
    const normType = normalizeContentType(mediaType);

    const mediaMeta = {
      url: mediaUrl || null,
      type: normType || null,
      transcript: null,
      confidence: null
    };

    // AUDIO
    if (isAudioFamily) {
      if (typeof transcribeAudio !== 'function') {
        return {
          transcript: null,
          twiml: twiml(`⚠️ Voice transcription isn’t available right now. Please type: "expense $84.12 nails from Home Depot".`)
        };
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

        // OGG/Opus sometimes needs a different label for some engines
        if (!transcript && normType === 'audio/ogg') {
          try {
            console.log('[MEDIA] retry transcription with fallback mime: audio/webm');
            const r2 = await transcribeAudio(audioBuf, 'audio/webm', 'both');
            const n2 = normalizeTranscriptionResult(r2);
            transcript = n2.transcript;
            confidence = confidence ?? n2.confidence;
          } catch (e2) {
            console.warn('[MEDIA] fallback transcribe failed:', e2.message);
          }
        }

        console.log('[MEDIA] transcript text', transcript || '(none)');
      } catch (e) {
        console.error('[MEDIA] transcribe fetch/exec failed:', e.message);
      }

      if (!transcript) {
        return {
          transcript: null,
          twiml: twiml(`⚠️ I couldn’t understand the audio. Try again, or text: "expense $500 materials from Home Depot today".`)
        };
      }

      mediaMeta.transcript = truncateText(transcript.trim(), MAX_MEDIA_TRANSCRIPT_CHARS);
      mediaMeta.confidence = Number.isFinite(Number(confidence)) ? Number(confidence) : null;

      // Always attach meta for audit trail
      await attachPendingMediaMeta(from, mediaMeta);

      const timeclockIntent = inferIntentFromText(transcript);
      const intent = financeIntentFromText(transcript);
      const lc = String(transcript).toLowerCase();
      const looksHours = /\bhours?\b/.test(lc) || /\btimesheet\b/.test(lc);

      // ✅ Finance voice → return transcript (so expense.js/revenue.js sends template quick replies)
      if (intent.kind === 'expense' || intent.kind === 'revenue') {
        await markPendingFinance({ from, kind: intent.kind, stableMediaMsgId });
        return { transcript: transcript.trim(), twiml: null };
      }

      // Timeclock/hours → keep parsing path
      if (timeclockIntent || looksHours) {
        extractedText = transcript.trim();
      } else {
        // General voice note: pass transcript to normal router
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

      // Images are audit-relevant
      await attachPendingMediaMeta(from, mediaMeta);

      // Try to detect if OCR likely represents a receipt/payment
      const intent = financeIntentFromText(extractedText);

      // ✅ Image finance → return transcript to router
      if (intent.kind === 'expense' || intent.kind === 'revenue') {
        await markPendingFinance({ from, kind: intent.kind, stableMediaMsgId });
        return { transcript: extractedText, twiml: null };
      }

      // Extra: receipts often lack explicit "expense" words; give a hint using parser result too
      // (We do NOT mark pending finance here unless parser says so.)
      const parsed = await parseMediaText(extractedText);
      if (parsed?.type === 'expense' || parsed?.type === 'revenue') {
        // If your router supports direct "expense" / "revenue" commands only,
        // you can still just return extractedText and let the router decide.
        // We do NOT force kind here to avoid false positives.
        return { transcript: extractedText, twiml: null };
      }
    }

    if (!extractedText) {
      const msg = `Is this an expense receipt, revenue, or timesheet? Reply 'expense', 'revenue', or 'timesheet'.`;
      const pending = await getPendingTransactionState(from);
      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingMedia: { url: mediaUrl, type: null }
      });
      return { transcript: null, twiml: twiml(msg) };
    }

    /* ---------- Parse ---------- */
    console.log('[MEDIA] parseMediaText()', { excerpt: (extractedText || '').slice(0, 80) });

    // parseMediaText returns {type:'unknown'} instead of throwing (per your mediaParser.js)
    const result = await parseMediaText(extractedText);

    /* ---------- Handle parse result ---------- */

    if (result?.type === 'hours_inquiry') {
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
        return { transcript: null, twiml: twiml(message) };
      }

      const pending = await getPendingTransactionState(from);
      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingMedia: { type: 'hours_inquiry' },
        pendingHours: { employeeName: name }
      });

      return {
        transcript: null,
        twiml: twiml(`Looks like you’re asking about ${name}’s hours. Do you want **today**, **this week**, or **this month**?`)
      };
    }

    if (result?.type === 'time_entry') {
      let { employeeName, type, timestamp } = result.data;

      const inferred = inferIntentFromText(extractedText);
      if (inferred === 'punch_in' && type === 'punch_out') type = 'punch_in';
      if (inferred === 'punch_out' && type === 'punch_in') type = 'punch_out';
      if (inferred === 'break_start' && type === 'break_end') type = 'break_start';
      if (inferred === 'break_end' && type === 'break_start') type = 'break_end';

      const tz = getUserTz(userProfile);
      const timeSuffix = /T/.test(timestamp) ? ` at ${toAmPm(timestamp, tz)}` : '';

      const who = employeeName || userProfile?.name || 'Unknown';

      let normalized;
      if (type === 'punch_in') normalized = `${who} punched in${timeSuffix}`;
      else if (type === 'punch_out') normalized = `${who} punched out${timeSuffix}`;
      else if (type === 'break_start') normalized = `start break for ${who}${timeSuffix}`;
      else if (type === 'break_end') normalized = `end break for ${who}${timeSuffix}`;
      else if (type === 'drive_start') normalized = `start drive for ${who}${timeSuffix}`;
      else if (type === 'drive_end') normalized = `end drive for ${who}${timeSuffix}`;
      else normalized = `${who} punched in${timeSuffix}`;

      const tw = await runTimeclockPipeline(from, normalized, userProfile, ownerId);
      if (typeof tw === 'string' && tw.trim()) return { transcript: null, twiml: tw };

      const humanTime = fmtLocal(timestamp, tz);
      return { transcript: null, twiml: twiml(`✅ ${type.replace('_', ' ')} logged for ${who} at ${humanTime}.`) };
    }

    // If parser detected expense/revenue here (non-media keywords), do NOT handle inside media.js;
    // return transcript and let router send confirm templates.
    if (result?.type === 'expense' || result?.type === 'revenue') {
      const kind = result.type;
      await markPendingFinance({ from, kind, stableMediaMsgId });
      return { transcript: extractedText, twiml: null };
    }

    // Unknown / other
    const pending = await getPendingTransactionState(from);
    await mergePendingTransactionState(from, {
      ...(pending || {}),
      pendingMedia: { url: mediaUrl, type: null }
    });

    return {
      transcript: null,
      twiml: twiml(`Is this an expense receipt, revenue, or timesheet? Reply 'expense', 'revenue', or 'timesheet'.`)
    };

  } catch (error) {
    console.error(`[MEDIA] handleMedia failed for ${from}:`, error.message);
    return { transcript: null, twiml: twiml(`⚠️ Failed to process media: ${error.message}`) };
  }
}

module.exports.handleMedia = handleMedia;
