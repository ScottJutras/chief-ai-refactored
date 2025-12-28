// handlers/media.js
// COMPLETE DROP-IN (aligned with latest expense.js / revenue.js / timeclock.js / tasks.js + router patterns)
//
// Alignments included:
// - Never “logs” expense/revenue inside media.js. Instead: attaches pendingMediaMeta + returns transcript
//   so expense.js / revenue.js can run their normal confirm + idempotent insert flows.
// - Uses stable idempotency key for media: prefers Twilio MediaSid, falls back to MessageSid, then time.
// - Fixes timeclock invocation: your handleTimeclock signature is (from, text, userProfile, ownerId, ownerProfile, isOwner, res)
//   (your prior stub passed extra args).
// - Safer TwiML escaping and consistent return shape: { transcript, twiml }.
// - Text-only messages: pass through to router (don’t treat as “media”).
// - Pending finance type markers set in state so confirm replies route correctly.
// - Conservative intent detection for receipts vs timeclock.

const axios = require('axios');
const { parseMediaText } = require('../services/mediaParser');
const { extractTextFromImage } = require('../utils/visionService');
const transcriptionMod = require('../utils/transcriptionService');
const { handleTimeclock } = require('./commands/timeclock');

// Some builds export generateTimesheet from postgres; some from pg service layer.
// Keep compatibility.
let generateTimesheet = null;
try {
  ({ generateTimesheet } = require('../services/postgres'));
} catch {
  try {
    const pg = require('../services/postgres');
    generateTimesheet = pg.generateTimesheet || null;
  } catch {}
}

const state = require('../utils/stateManager');
const getPendingTransactionState =
  state.getPendingTransactionState ||
  (async () => null);

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
  return `<Response><Message>${xmlEsc(String(text || '').trim())}</Message></Response>`;
}

function getUserTz(userProfile) {
  return userProfile?.timezone || userProfile?.tz || userProfile?.time_zone || 'America/Toronto';
}

function fmtLocal(tsIso, tz) {
  try {
    return new Date(tsIso).toLocaleString('en-CA', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
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

function inferTimeclockIntentFromText(s = '') {
  const lc = String(s).toLowerCase();
  if (/\b(clock|punch)\s+in\b/.test(lc) || /\bstart\s+(work|shift)\b/.test(lc)) return 'punch_in';
  if (/\b(clock|punch)\s+out\b/.test(lc) || /\b(end|finish|stop)\s+(work|shift)\b/.test(lc)) return 'punch_out';
  if (/\b(start|begin)\s+(break|lunch)\b/.test(lc) || /\bon\s+break\b/.test(lc)) return 'break_start';
  if (/\b(end|finish|stop)\s+(break|lunch)\b/.test(lc) || /\boff\s+break\b/.test(lc)) return 'break_end';
  if (/\b(start|begin)\s+drive\b/.test(lc)) return 'drive_start';
  if (/\b(end|finish|stop)\s+drive\b/.test(lc)) return 'drive_end';
  if (/\b(timesheet|hours\s+for|how\s+many\s+hours)\b/.test(lc)) return 'hours_inquiry';
  return null;
}

function truncateText(str, maxChars) {
  if (!str) return null;
  const s = String(str);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars);
}

// Keep aligned with expense.js MAX_MEDIA_TRANSCRIPT_CHARS default (or pg constant, but pg is not imported here)
const MAX_MEDIA_TRANSCRIPT_CHARS = 8000;

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
 * Finance intent classifier used for media ONLY.
 * The actual parsing + confirmation is done by expense.js / revenue.js.
 */
function financeIntentFromText(text) {
  const lc = String(text || '').toLowerCase();

  const looksExpense =
    /\b(expense|receipt|spent|cost|paid|bought|buy|purchase|purchased|ordered|charge|charged)\b/.test(lc) ||
    /\b(home\s*depot|rona|lowe'?s|home\s*hardware|beacon|abc\s*supply|convoy)\b/.test(lc);

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

/**
 * Mark pending flow type + stable source msg id key used by expense.js / revenue.js
 */
async function markPendingFinance({ from, kind, stableMediaMsgId }) {
  try {
    const pending = await getPendingTransactionState(from);
    await mergePendingTransactionState(from, {
      ...(pending || {}),
      type: kind,
      pendingMedia: { type: kind },
      expenseSourceMsgId: kind === 'expense' ? stableMediaMsgId : (pending?.expenseSourceMsgId || null),
      revenueSourceMsgId: kind === 'revenue' ? stableMediaMsgId : (pending?.revenueSourceMsgId || null)
    });
  } catch (e) {
    console.warn('[MEDIA] markPendingFinance failed (ignored):', e?.message);
  }
}

/**
 * IMPORTANT:
 * If this is text-only (no mediaUrl), do NOT handle as media.
 * Return transcript and let webhook/router route it to revenue.js/expense.js/etc.
 */
async function passThroughTextOnly(from, input) {
  const t = String(input || '').trim();
  if (!t) return { transcript: '', twiml: null };
  return { transcript: t, twiml: null };
}

async function runTimeclockPipeline(from, normalized, userProfile, ownerId) {
  let payload = null;

  // Determine isOwner best-effort (don’t block correctness; timeclock has its own permissions)
  const up = userProfile || {};
  const ownerIdFromProfile = up.owner_id || up.ownerId || ownerId || null;

  const isOwner = (() => {
    try {
      const a = String(up.user_id || up.id || '').replace(/\D/g, '');
      const b = String(ownerIdFromProfile || '').replace(/\D/g, '');
      if (!a || !b) return false;
      return a === b;
    } catch {
      return false;
    }
  })();

  const resStub = {
    headersSent: false,
    req: { body: {} },
    status() { return this; },
    type() { return this; },
    send(body) {
      payload = String(body || '');
      this.headersSent = true;
      return this;
    }
  };

  try {
    // NOTE: signature: (from, text, userProfile, ownerId, ownerProfile, isOwner, res)
    await handleTimeclock(from, normalized, userProfile, ownerIdFromProfile || ownerId, null, isOwner, resStub);
  } catch (e) {
    console.error('[MEDIA] handleTimeclock failed:', e?.message);
  }
  return payload;
}

/* ---------------- main ---------------- */

async function handleMedia(from, input, userProfile, ownerId, mediaUrl, mediaType, sourceMsgId) {
  try {
    console.log('[MEDIA] incoming', {
      from,
      mediaType,
      hasUrl: !!mediaUrl,
      inputLen: (input || '').length
    });

    // ✅ Text-only: let webhook/router handle it
    if (!mediaUrl) return await passThroughTextOnly(from, input);

    const baseType = normalizeContentType(mediaType);
    const validImageTypes = ['image/jpeg', 'image/png', 'image/webp'];
    const isSupportedImage = validImageTypes.includes(baseType);

    // Be resilient: accept any audio/*
    const isAudioFamily = baseType.startsWith('audio/');
    const isSupportedAudio = isAudioFamily;

    if (!isSupportedImage && !isSupportedAudio) {
      return {
        transcript: null,
        twiml: twiml(
          `⚠️ Unsupported media type: ${mediaType}. Please send an image (JPEG/PNG/WEBP) or an audio/voice note.`
        )
      };
    }

    // Stable idempotency key: prefer MediaSid, else webhook MessageSid, else time.
    const mediaSid = getTwilioMediaSid(mediaUrl);
    const stableMediaMsgId =
      (mediaSid ? `${from}:${mediaSid}` : null) ||
      (String(sourceMsgId || '').trim() ? `${from}:${String(sourceMsgId).trim()}` : null) ||
      `${from}:${Date.now()}`;

    /* ---------- Build text from media ---------- */
    let extractedText = String(input || '').trim();
    const normType = baseType;

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
          twiml: twiml(
            `⚠️ Voice transcription isn’t available right now. Please type: "expense $84.12 nails from Home Depot".`
          )
        };
      }

      let transcript = '';
      let confidence = null;

      try {
        const resp = await axios.get(mediaUrl, {
          responseType: 'arraybuffer',
          auth: {
            username: process.env.TWILIO_ACCOUNT_SID,
            password: process.env.TWILIO_AUTH_TOKEN
          },
          maxContentLength: 8 * 1024 * 1024
        });

        const audioBuf = Buffer.from(resp.data);

        const r1 = await transcribeAudio(audioBuf, normType, 'both');
        const n1 = normalizeTranscriptionResult(r1);
        transcript = n1.transcript;
        confidence = n1.confidence;

        // Some engines need a different label for ogg/opus
        if (!transcript && normType === 'audio/ogg') {
          try {
            const r2 = await transcribeAudio(audioBuf, 'audio/webm', 'both');
            const n2 = normalizeTranscriptionResult(r2);
            transcript = n2.transcript;
            confidence = confidence ?? n2.confidence;
          } catch (e2) {
            console.warn('[MEDIA] fallback transcribe failed:', e2?.message);
          }
        }
      } catch (e) {
        console.error('[MEDIA] transcribe fetch/exec failed:', e?.message);
      }

      transcript = String(transcript || '').trim();
      if (!transcript) {
        return {
          transcript: null,
          twiml: twiml(
            `⚠️ I couldn’t understand the audio. Try again, or text: "expense $500 materials from Home Depot today".`
          )
        };
      }

      mediaMeta.transcript = truncateText(transcript, MAX_MEDIA_TRANSCRIPT_CHARS);
      mediaMeta.confidence = Number.isFinite(Number(confidence)) ? Number(confidence) : null;

      // Attach media meta for audit + later persistence by expense/revenue confirm
      await attachPendingMediaMeta(from, mediaMeta);

      // Finance voice -> return transcript to router + mark pending kind (so "yes" uses stable ids)
      const fin = financeIntentFromText(transcript);
      if (fin.kind === 'expense' || fin.kind === 'revenue') {
        await markPendingFinance({ from, kind: fin.kind, stableMediaMsgId });
        return { transcript, twiml: null };
      }

      // Timeclock/hours -> run timeclock pipeline; otherwise pass-through transcript
      const tc = inferTimeclockIntentFromText(transcript);
      if (tc === 'hours_inquiry' || tc) {
        extractedText = transcript;
      } else {
        return { transcript, twiml: null };
      }
    }

    // IMAGE
    if (isSupportedImage) {
      let ocrText = '';
      try {
        const out = await extractTextFromImage(mediaUrl);
        ocrText = String(out?.text || '').trim();
      } catch (e) {
        console.warn('[MEDIA] extractTextFromImage failed:', e?.message);
      }

      extractedText = (ocrText || extractedText || '').trim();

      mediaMeta.transcript = truncateText(extractedText, MAX_MEDIA_TRANSCRIPT_CHARS);
      mediaMeta.confidence = null;

      // Attach for audit
      await attachPendingMediaMeta(from, mediaMeta);

      // If clearly finance, just pass transcript to router
      const fin = financeIntentFromText(extractedText);
      if (fin.kind === 'expense' || fin.kind === 'revenue') {
        await markPendingFinance({ from, kind: fin.kind, stableMediaMsgId });
        return { transcript: extractedText, twiml: null };
      }
    }

    if (!extractedText) {
      const pending = await getPendingTransactionState(from);
      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingMedia: { url: mediaUrl, type: null }
      });

      return {
        transcript: null,
        twiml: twiml(`Is this an expense receipt, revenue, or timesheet? Reply "expense", "revenue", or "timesheet".`)
      };
    }

    /* ---------- Parse ---------- */
    const result = await parseMediaText(extractedText);

    // HOURS inquiry
    if (result?.type === 'hours_inquiry') {
      const name = result?.data?.employeeName || userProfile?.name || '';
      const tz = getUserTz(userProfile);

      if (result?.data?.period && typeof generateTimesheet === 'function') {
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
        twiml: twiml(
          `Looks like you’re asking about ${name}’s hours. Do you want **today**, **this week**, or **this month**?`
        )
      };
    }

    // TIME entry
    if (result?.type === 'time_entry') {
      const data = result.data || {};
      let { employeeName, type, timestamp } = data;

      const inferred = inferTimeclockIntentFromText(extractedText);
      if (inferred === 'punch_in' && type === 'punch_out') type = 'punch_in';
      if (inferred === 'punch_out' && type === 'punch_in') type = 'punch_out';
      if (inferred === 'break_start' && type === 'break_end') type = 'break_start';
      if (inferred === 'break_end' && type === 'break_start') type = 'break_end';

      const tz = getUserTz(userProfile);
      const who = employeeName || userProfile?.name || 'Unknown';

      const timeSuffix = timestamp && /T/.test(timestamp) ? ` at ${toAmPm(timestamp, tz)}` : '';
      let normalized;

      if (type === 'punch_in') normalized = `${who} clock in${timeSuffix}`;
      else if (type === 'punch_out') normalized = `${who} clock out${timeSuffix}`;
      else if (type === 'break_start') normalized = `break start for ${who}${timeSuffix}`;
      else if (type === 'break_end') normalized = `break stop for ${who}${timeSuffix}`;
      else if (type === 'drive_start') normalized = `drive start for ${who}${timeSuffix}`;
      else if (type === 'drive_end') normalized = `drive stop for ${who}${timeSuffix}`;
      else normalized = `${who} clock in${timeSuffix}`;

      const tw = await runTimeclockPipeline(from, normalized, userProfile, ownerId);
      if (typeof tw === 'string' && tw.trim()) return { transcript: null, twiml: tw };

      const when = timestamp ? fmtLocal(timestamp, tz) : 'now';
      return { transcript: null, twiml: twiml(`✅ ${type.replace('_', ' ')} logged for ${who} at ${when}.`) };
    }

    // Expense / Revenue detected by parser
    if (result?.type === 'expense' || result?.type === 'revenue') {
      const kind = result.type;
      await markPendingFinance({ from, kind, stableMediaMsgId });
      return { transcript: extractedText, twiml: null };
    }

    // Otherwise: pass transcript to router (agent can handle)
    return { transcript: extractedText, twiml: null };

  } catch (error) {
    console.error(`[MEDIA] handleMedia failed for ${from}:`, error?.message);
    return { transcript: null, twiml: twiml(`⚠️ Failed to process media. Please try again.`) };
  }
}

module.exports = { handleMedia };
