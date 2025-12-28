// handlers/media.js
// COMPLETE DROP-IN (aligned with expense.js Option A + webhook passthrough + timeclock signature)
//
// Fixes included:
// ✅ Central "trade-term correction" layer after transcription/OCR (Gentek/Gen Tech, siding/sighting, etc.)
// ✅ Corrections applied to BOTH returned transcript AND pendingMediaMeta transcript
// ✅ Stable idempotency key for media: prefers Twilio MediaSid, falls back to MessageSid, then time
// ✅ Never logs expense/revenue here; attaches pendingMediaMeta + returns transcript to router
// ✅ Marks pending finance kind + stores stableMediaMsgId in pending state
// ✅ Text-only messages pass through (not treated as media)
// ✅ Safer TwiML escaping and consistent return shape: { transcript, twiml }

const axios = require('axios');
const { parseMediaText } = require('../services/mediaParser');
const { extractTextFromImage } = require('../utils/visionService');
const transcriptionMod = require('../utils/transcriptionService');
const { handleTimeclock } = require('./commands/timeclock');

// Some builds export generateTimesheet from postgres; some from pg service layer.
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
const getPendingTransactionState = state.getPendingTransactionState || (async () => null);

const mergePendingTransactionState =
  state.mergePendingTransactionState ||
  (async (userId, patch) => state.setPendingTransactionState(userId, patch, { merge: true }));

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
    return new Date(tsIso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
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

const MAX_MEDIA_TRANSCRIPT_CHARS = 8000;

function normalizeContentType(mediaType) {
  return String(mediaType || '').split(';')[0].trim().toLowerCase();
}

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
 * ✅ Trade-term correction layer (centralized).
 */
function correctTradeTerms(text) {
  let s = String(text || '');

  // Gentek variants
  s = s.replace(/\bgen\s*tech\b/gi, 'Gentek');
  s = s.replace(/\bgentech\b/gi, 'Gentek');
  s = s.replace(/\bgentek\b/gi, 'Gentek');

  // siding mis-hear
  s = s.replace(/\bsighting\b/gi, 'siding');

  // other common trade terms
  s = s.replace(/\bsoffet\b/gi, 'soffit');
  s = s.replace(/\bfacia\b/gi, 'fascia');
  s = s.replace(/\beaves\s*trough\b/gi, 'eavestrough');

  return s.replace(/\s+/g, ' ').trim();
}

function getTwilioMediaSid(mediaUrl) {
  try {
    const u = new URL(String(mediaUrl || ''));
    return u.searchParams.get('MediaSid') || u.searchParams.get('mediaSid') || null;
  } catch {
    return null;
  }
}

async function attachPendingMediaMeta(from, meta) {
  try {
    const url = String(meta?.url || '').trim() || null;
    const type = String(meta?.type || '').trim() || null;
    const transcript = truncateText(meta?.transcript, MAX_MEDIA_TRANSCRIPT_CHARS);
    const confidence = Number.isFinite(Number(meta?.confidence)) ? Number(meta.confidence) : null;
    const source_msg_id = meta?.source_msg_id ? String(meta.source_msg_id) : null;

    if (!url && !type && !transcript && confidence == null && !source_msg_id) return;

    const pending = await getPendingTransactionState(from);
    await mergePendingTransactionState(from, {
      ...(pending || {}),
      pendingMediaMeta: { url, type, transcript, confidence, source_msg_id }
    });
  } catch (e) {
    console.warn('[MEDIA] attachPendingMediaMeta failed (ignored):', e?.message);
  }
}

function financeIntentFromText(text) {
  const lc = String(text || '').toLowerCase();

  const looksExpense =
    /\b(expense|receipt|spent|cost|paid|bought|buy|purchase|purchased|ordered|charge|charged)\b/.test(lc) ||
    /\b(home\s*depot|rona|lowe'?s|home\s*hardware|beacon|abc\s*supply|convoy|gentek)\b/.test(lc);

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
  try {
    const pending = await getPendingTransactionState(from);
    await mergePendingTransactionState(from, {
      ...(pending || {}),
      type: kind,
      pendingMedia: { type: kind },
      expenseSourceMsgId: kind === 'expense' ? stableMediaMsgId : pending?.expenseSourceMsgId || null,
      revenueSourceMsgId: kind === 'revenue' ? stableMediaMsgId : pending?.revenueSourceMsgId || null,
      mediaSourceMsgId: stableMediaMsgId
    });
  } catch (e) {
    console.warn('[MEDIA] markPendingFinance failed (ignored):', e?.message);
  }
}

async function passThroughTextOnly(_from, input) {
  const t = String(input || '').trim();
  if (!t) return { transcript: '', twiml: null };
  return { transcript: correctTradeTerms(t), twiml: null };
}

async function runTimeclockPipeline(from, normalized, userProfile, ownerId) {
  let payload = null;

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
    // signature: (from, text, userProfile, ownerId, ownerProfile, isOwner, res)
    await handleTimeclock(from, normalized, userProfile, ownerIdFromProfile || ownerId, null, isOwner, resStub);
  } catch (e) {
    console.error('[MEDIA] handleTimeclock failed:', e?.message);
  }
  return payload;
}

/* ---------------- main ---------------- */

async function handleMedia(from, input, userProfile, ownerId, mediaUrl, mediaType, sourceMsgId) {
  try {
    if (!mediaUrl) return await passThroughTextOnly(from, input);

    const baseType = normalizeContentType(mediaType);
    const validImageTypes = ['image/jpeg', 'image/png', 'image/webp'];
    const isSupportedImage = validImageTypes.includes(baseType);
    const isAudioFamily = baseType.startsWith('audio/');
    const isSupportedAudio = isAudioFamily;

    if (!isSupportedImage && !isSupportedAudio) {
      return {
        transcript: null,
        twiml: twiml(`⚠️ Unsupported media type: ${mediaType}. Please send an image (JPEG/PNG/WEBP) or an audio note.`)
      };
    }

    // Stable idempotency key: prefer MediaSid, else webhook MessageSid, else time.
    const mediaSid = getTwilioMediaSid(mediaUrl);
    const stableMediaMsgId =
      (mediaSid ? `${from}:${mediaSid}` : null) ||
      (String(sourceMsgId || '').trim() ? `${from}:${String(sourceMsgId).trim()}` : null) ||
      `${from}:${Date.now()}`;

    let extractedText = String(input || '').trim();
    const normType = baseType;

    const mediaMeta = {
      url: mediaUrl || null,
      type: normType || null,
      transcript: null,
      confidence: null,
      source_msg_id: stableMediaMsgId
    };

    // AUDIO
    if (isAudioFamily) {
      if (typeof transcribeAudio !== 'function') {
        return { transcript: null, twiml: twiml(`⚠️ Voice transcription isn’t available. Please type the details.`) };
      }

      let transcript = '';
      let confidence = null;

      try {
        const resp = await axios.get(mediaUrl, {
          responseType: 'arraybuffer',
          auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN },
          maxContentLength: 8 * 1024 * 1024
        });

        const audioBuf = Buffer.from(resp.data);

        const r1 = await transcribeAudio(audioBuf, normType, 'both');
        const n1 = normalizeTranscriptionResult(r1);
        transcript = n1.transcript;
        confidence = n1.confidence;

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
        return { transcript: null, twiml: twiml(`⚠️ I couldn’t understand the audio. Try again or type it.`) };
      }

      transcript = correctTradeTerms(transcript);

      mediaMeta.transcript = truncateText(transcript, MAX_MEDIA_TRANSCRIPT_CHARS);
      mediaMeta.confidence = Number.isFinite(Number(confidence)) ? Number(confidence) : null;

      await attachPendingMediaMeta(from, mediaMeta);

      // ✅ Avoid misclassifying time-related voice as finance
      const tc = inferTimeclockIntentFromText(transcript);
      if (tc) {
        extractedText = transcript; // let parser/timeclock flow decide
      } else {
        const fin = financeIntentFromText(transcript);
        if (fin.kind === 'expense' || fin.kind === 'revenue') {
          await markPendingFinance({ from, kind: fin.kind, stableMediaMsgId });
          return { transcript, twiml: null };
        }
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

      extractedText = correctTradeTerms((ocrText || extractedText || '').trim());

      mediaMeta.transcript = truncateText(extractedText, MAX_MEDIA_TRANSCRIPT_CHARS);
      mediaMeta.confidence = null;

      await attachPendingMediaMeta(from, mediaMeta);

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
        pendingMedia: { url: mediaUrl, type: null },
        mediaSourceMsgId: stableMediaMsgId
      });

      return {
        transcript: null,
        twiml: twiml(`Is this an expense receipt, revenue, or timesheet? Reply "expense", "revenue", or "timesheet".`)
      };
    }

    const result = await parseMediaText(extractedText);

    // HOURS inquiry
    if (result?.type === 'hours_inquiry') {
      const name = result?.data?.employeeName || userProfile?.name || '';
      const tz = getUserTz(userProfile);

      if (result?.data?.period && typeof generateTimesheet === 'function') {
        const { message } = await generateTimesheet({ ownerId, person: name, period: result.data.period, tz, now: new Date() });
        return { transcript: null, twiml: twiml(message) };
      }

      const pending = await getPendingTransactionState(from);
      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingMedia: { type: 'hours_inquiry' },
        pendingHours: { employeeName: name },
        mediaSourceMsgId: stableMediaMsgId
      });

      return { transcript: null, twiml: twiml(`Looks like you’re asking about ${name}’s hours. Do you want today, this week, or this month?`) };
    }

    // TIME entry (from parser)
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
      return { transcript: null, twiml: twiml(`✅ ${String(type || '').replace('_', ' ')} logged for ${who} at ${when}.`) };
    }

    // Expense / Revenue detected by parser
    if (result?.type === 'expense' || result?.type === 'revenue') {
      await markPendingFinance({ from, kind: result.type, stableMediaMsgId });
      return { transcript: extractedText, twiml: null };
    }

    // Otherwise: pass transcript to router
    return { transcript: extractedText, twiml: null };
  } catch (error) {
    console.error(`[MEDIA] handleMedia failed for ${from}:`, error?.message);
    return { transcript: null, twiml: twiml(`⚠️ Failed to process media. Please try again.`) };
  }
}

module.exports = { handleMedia };
