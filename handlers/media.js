// handlers/media.js
// COMPLETE DROP-IN (BETA-ready; aligned to job.js + revenue.js + expense.js + postgres.js)
//
// ✅ Alignment / beta-hardening changes (no unnecessary logic loss):
// - Pending media meta schema matches what revenue.js/expense.js consume:
//     { url, type, transcript, confidence, source_msg_id }
// - Stable idempotency key for media: prefers Twilio MediaSid, else MessageSid, else time
// - Stores mediaSourceMsgId + (expenseSourceMsgId / revenueSourceMsgId) in pending state (same pattern)
// - Does NOT log expense/revenue; only attaches pendingMediaMeta + returns transcript to router
// - Conservative finance intent detection; avoids timeclock misclassification
// - Adds "job picker token scrubber" so we never persist tokens like jobno_6 into transcripts unintentionally
// - Uses pg.truncateText / pg.normalizeMediaMeta / pg.MEDIA_TRANSCRIPT_MAX_CHARS when available (aligns postgres.js)
// - Keeps timesheet/hours inquiry support via generateTimesheet (if exported), else defers to router via transcript
// - Text-only messages pass through (not treated as media)
// - ✅ Twilio payload unpredictability hardening: tolerate missing/odd mediaType, fail-open everywhere
//
// Signature (router/webhook):
//   handleMedia(from, input, userProfile, ownerId, mediaUrl, mediaType, sourceMsgId)
//
// Returns:
//   { transcript: string|null, twiml: string|null }

const axios = require('axios');
const { parseMediaText } = require('../services/mediaParser');
const { extractTextFromImage } = require('../utils/visionService'); // now Document AI-backed
const transcriptionMod = require('../utils/transcriptionService');
const { handleTimeclock } = require('./commands/timeclock');
const pg = require('../services/postgres');
function getDbQuery(pg) {
  return (
    (pg && typeof pg.query === 'function' && pg.query.bind(pg)) ||
    (pg && pg.pool && typeof pg.pool.query === 'function' && pg.pool.query.bind(pg.pool)) ||
    (pg && pg._pool && typeof pg._pool.query === 'function' && pg._pool.query.bind(pg._pool)) ||
    null
  );
}

const dbQuery = getDbQuery(pg);


// Some builds export generateTimesheet from postgres; some from pg service layer.
let generateTimesheet = null;
try {
  ({ generateTimesheet } = require('../services/postgres'));
} catch {
  try {
    generateTimesheet = pg.generateTimesheet || null;
  } catch {}
}

const state = require('../utils/stateManager');
const getPendingTransactionState =
  state.getPendingTransactionState || state.getPendingState || (async () => null);

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

function DIGITS(x) {
  return String(x ?? '')
    .replace(/^whatsapp:/i, '')
    .replace(/^\+/, '')
    .replace(/\D/g, '');
}

function getUserTz(userProfile) {
  return userProfile?.timezone || userProfile?.tz || userProfile?.time_zone || 'America/Toronto';
}
async function upsertMediaAsset({
  ownerId,
  from,
  stableMediaMsgId,
  mediaUrl,
  contentType,
  sizeBytes,
  jobId,
  jobNo,
  jobName,
  ocrText,
  ocrFields
}) {
  if (!dbQuery) {
    console.warn('[MEDIA] upsertMediaAsset: no dbQuery available on pg export');
    return null;
  }

  const storageProvider = 'twilio_temp';
  const storagePath = String(mediaUrl || '').trim() || `twilio:${stableMediaMsgId}`;

  const sql = `
    insert into public.media_assets (
      owner_id, user_id, source_msg_id,
      kind, storage_provider, storage_path,
      content_type, size_bytes,
      job_id, job_no, job_name,
      ocr_text, ocr_fields
    )
    values ($1,$2,$3,'receipt_image',$4,$5,$6,$7,$8,$9,$10,$11,$12)
    on conflict (owner_id, source_msg_id)
      where source_msg_id is not null
    do update set
      content_type = coalesce(excluded.content_type, public.media_assets.content_type),
      size_bytes   = coalesce(excluded.size_bytes,   public.media_assets.size_bytes),
      job_id       = coalesce(excluded.job_id,       public.media_assets.job_id),
      job_no       = coalesce(excluded.job_no,       public.media_assets.job_no),
      job_name     = coalesce(excluded.job_name,     public.media_assets.job_name),

      -- IMPORTANT: allow OCR text to update if we now have better text
      ocr_text   = case
        when excluded.ocr_text is not null and length(excluded.ocr_text) > length(coalesce(public.media_assets.ocr_text, ''))
        then excluded.ocr_text
        else public.media_assets.ocr_text
      end,

      ocr_fields = coalesce(excluded.ocr_fields, public.media_assets.ocr_fields),
      updated_at = now()
    returning id
  `;

  const owner = String(ownerId || '').trim();
  const userId = DIGITS(from);

  try {
    const r = await dbQuery(sql, [
      owner,
      userId || null,
      stableMediaMsgId || null,
      storageProvider,
      storagePath,
      contentType || null,
      Number.isFinite(Number(sizeBytes)) ? Number(sizeBytes) : null,
      jobId && String(jobId).trim() ? String(jobId).trim() : null,
      Number.isFinite(Number(jobNo)) ? Number(jobNo) : null,
      jobName ? String(jobName).trim() : null,
      ocrText ? String(ocrText).slice(0, 8000) : null,
      ocrFields ? JSON.stringify(ocrFields) : null
    ]);

    const id = r?.rows?.[0]?.id || null;
    console.info('[MEDIA_ASSET_UPSERT]', {
      owner_id: owner,
      source_msg_id: stableMediaMsgId,
      id: id || null,
      hasText: !!(ocrText && String(ocrText).trim())
    });
    return id;
  } catch (e) {
    console.warn('[MEDIA] upsertMediaAsset failed (ignored):', e?.message);
    return null;
  }
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

function normalizeContentType(mediaType) {
  // Twilio can send "image/jpeg; charset=binary" or sometimes null/empty.
  return String(mediaType || '').split(';')[0].trim().toLowerCase();
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

const MAX_MEDIA_TRANSCRIPT_CHARS =
  (typeof pg.MEDIA_TRANSCRIPT_MAX_CHARS === 'number' && pg.MEDIA_TRANSCRIPT_MAX_CHARS) || 8000;

const truncateText =
  (typeof pg.truncateText === 'function' && pg.truncateText) ||
  ((str, maxChars) => {
    if (!str) return null;
    const s = String(str);
    if (s.length <= maxChars) return s;
    return s.slice(0, maxChars);
  });

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

  s = s.replace(/\bgen\s*tech\b/gi, 'Gentek');
  s = s.replace(/\bgentech\b/gi, 'Gentek');
  s = s.replace(/\bgentek\b/gi, 'Gentek');

  s = s.replace(/\bsighting\b/gi, 'siding');

  s = s.replace(/\bsoffet\b/gi, 'soffit');
  s = s.replace(/\bfacia\b/gi, 'fascia');
  s = s.replace(/\beaves\s*trough\b/gi, 'eavestrough');

  return s.replace(/\s+/g, ' ').trim();
}

function fixCommonTranscriptionTypos(text) {
  let s = String(text || '');

  s = s.replace(/\blotters\b/gi, 'ladders');
  s = s.replace(/\blotter\b/gi, 'ladder');

  s = s.replace(/\bshingle's\b/gi, 'shingles');
  s = s.replace(/\bhome\s*hardwear\b/gi, 'Home Hardware');
  s = s.replace(/\bmedway\s*park\s*drive\b/gi, 'Medway Park Dr');

  return s.replace(/\s+/g, ' ').trim();
}

/**
 * ✅ Prevent “picker token bleed” into saved transcripts (jobno_ / jobix_ tokens).
 */
function scrubPickerTokens(text) {
  let s = String(text || '');
  s = s.replace(/\bjobno_\d{1,10}\b/gi, (m) => m.replace(/_/g, ' '));
  s = s.replace(/\bjobix_\d{1,10}\b/gi, (m) => m.replace(/_/g, ' '));
  s = s.replace(/\bjob_\d{1,10}_[0-9a-z]+\b/gi, '');
  return s.replace(/\s{2,}/g, ' ').trim();
}

function normalizeHumanText(text) {
  return scrubPickerTokens(correctTradeTerms(fixCommonTranscriptionTypos(text)));
}

function getTwilioMediaSid(mediaUrl) {
  try {
    const u = new URL(String(mediaUrl || ''));
    return u.searchParams.get('MediaSid') || u.searchParams.get('mediaSid') || null;
  } catch {
    return null;
  }
}

/* ---------------- pending state + meta ---------------- */

async function attachPendingMediaMeta(from, meta) {
  try {
    const raw = {
      url: meta?.url || meta?.media_url || null,
      type: meta?.type || meta?.media_type || null,
      transcript: truncateText(meta?.transcript || meta?.media_transcript || null, MAX_MEDIA_TRANSCRIPT_CHARS),
      confidence: meta?.confidence ?? meta?.media_confidence ?? null,
      source_msg_id: meta?.source_msg_id ? String(meta.source_msg_id) : null,
      media_asset_id: meta?.media_asset_id || meta?.mediaAssetId || null
    };

    const normalized = typeof pg.normalizeMediaMeta === 'function' ? pg.normalizeMediaMeta(raw) : raw;

    if (
      !normalized?.url &&
      !normalized?.type &&
      !normalized?.transcript &&
      normalized?.confidence == null &&
      !normalized?.source_msg_id
    ) {
      return;
    }

    const pending = await getPendingTransactionState(from);
    await mergePendingTransactionState(from, {
      ...(pending || {}),
      pendingMediaMeta: normalized
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
  return { transcript: normalizeHumanText(t), twiml: null };
}

async function runTimeclockPipeline(from, normalized, userProfile, ownerId) {
  let payload = null;

  const up = userProfile || {};
  const ownerIdFromProfile = up.owner_id || up.ownerId || ownerId || null;

  const isOwner = (() => {
    try {
      const a = DIGITS(up.user_id || up.id || '');
      const b = DIGITS(ownerIdFromProfile || '');
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
    await handleTimeclock(from, normalized, userProfile, ownerIdFromProfile || ownerId, null, isOwner, resStub);
  } catch (e) {
    console.error('[MEDIA] handleTimeclock failed:', e?.message);
  }
  return payload;
}

/* ---------------- main ---------------- */

async function handleMedia(from, input, userProfile, ownerId, mediaUrl, mediaType, sourceMsgId) {
  try {
    // text-only messages pass through
    if (!mediaUrl) return await passThroughTextOnly(from, input);

    const baseType = normalizeContentType(mediaType);
    const isAudio = baseType ? baseType.startsWith('audio/') : false;

    // Twilio sometimes omits type; infer from URL extension as a weak hint.
    const urlLc = String(mediaUrl || '').toLowerCase();
    const maybeImage =
      !baseType && (urlLc.includes('.jpg') || urlLc.includes('.jpeg') || urlLc.includes('.png') || urlLc.includes('.webp'));
    const maybeAudio =
      !baseType && (urlLc.includes('.ogg') || urlLc.includes('.opus') || urlLc.includes('.mp3') || urlLc.includes('.wav') || urlLc.includes('.webm'));

    const isImage =
      baseType === 'image/jpeg' || baseType === 'image/png' || baseType === 'image/webp' || maybeImage;

    const isSupportedAudio = isAudio || maybeAudio;

    if (!isImage && !isSupportedAudio) {
      // fail-open: ask user instead of crashing
      return {
        transcript: null,
        twiml: twiml(`Is this an expense receipt, revenue, or timesheet? Reply "expense", "revenue", or "timesheet".`)
      };
    }

    // Stable idempotency key: prefer MediaSid, else webhook MessageSid, else time.
    // Stable idempotency key: prefer MediaSid, else webhook MessageSid, else time.
const mediaSid = getTwilioMediaSid(mediaUrl);
const stableMediaMsgId =
  (mediaSid ? `${from}:${mediaSid}` : null) ||
  (String(sourceMsgId || '').trim() ? `${from}:${String(sourceMsgId).trim()}` : null) ||
  `${from}:${Date.now()}`;

// Resolve active job once (job-first identifier)
let activeJobName = null;
let activeJobNo = null;
let activeJobId = null;

try {
  if (typeof pg.getActiveJobForIdentity === 'function') {
    const row = await pg.getActiveJobForIdentity(String(ownerId).trim(), DIGITS(from));
    if (row) {
      activeJobName = row.name || row.job_name || null;
      activeJobNo = row.job_no != null ? Number(row.job_no) : null;
      activeJobId = row.id && String(row.id).trim() ? String(row.id).trim() : null;
    }
  }
} catch (e) {
  console.warn('[MEDIA] getActiveJobForIdentity failed (ignored):', e?.message);
}

let extractedText = String(input || '').trim();
const normType = baseType || 'application/octet-stream';

let mediaAssetId = null;

const mediaMeta = {
  url: mediaUrl || null,
  type: normType || null,
  transcript: null,
  confidence: null,
  source_msg_id: stableMediaMsgId,
  media_asset_id: null
};

// AUDIO
if (isSupportedAudio) {
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

  transcript = normalizeHumanText(transcript);
  extractedText = transcript;

  // ✅ Create / update media asset AFTER transcription
  mediaAssetId = await upsertMediaAsset({
    ownerId,
    from,
    stableMediaMsgId,
    mediaUrl,
    contentType: normType,
    sizeBytes: null,
    jobId: activeJobId,
    jobNo: activeJobNo,
    jobName: activeJobName,
    ocrText: transcript,
    ocrFields: null
  });

  mediaMeta.transcript = truncateText(transcript, MAX_MEDIA_TRANSCRIPT_CHARS);
  mediaMeta.confidence = Number.isFinite(Number(confidence)) ? Number(confidence) : null;
  mediaMeta.media_asset_id = mediaAssetId;

  await attachPendingMediaMeta(from, mediaMeta);

  const tc = inferTimeclockIntentFromText(transcript);
  if (!tc) {
    const fin = financeIntentFromText(transcript);
    if (fin.kind === 'expense' || fin.kind === 'revenue') {
      await markPendingFinance({ from, kind: fin.kind, stableMediaMsgId });
      return { transcript, twiml: null };
    }
    return { transcript, twiml: null };
  }
}

// IMAGE
if (isImage) {
  let ocrText = '';
  let ocrFields = null;

  try {
    const out = await extractTextFromImage(mediaUrl, { fetchBytes: true, mediaType: normType });
    ocrText = String(out?.text || out?.transcript || '').trim();
    // if you later return fields: ocrFields = out?.fields || null;
  } catch (e) {
    console.warn('[MEDIA] OCR failed (ignored):', e?.message);
  }

  extractedText = normalizeHumanText((ocrText || extractedText || '').trim());

  // ✅ Create / update media asset AFTER OCR
  mediaAssetId = await upsertMediaAsset({
    ownerId,
    from,
    stableMediaMsgId,
    mediaUrl,
    contentType: normType,
    sizeBytes: null,
    jobId: activeJobId,
    jobNo: activeJobNo,
    jobName: activeJobName,
    ocrText: extractedText,
    ocrFields
  });

  mediaMeta.transcript = truncateText(extractedText, MAX_MEDIA_TRANSCRIPT_CHARS);
  mediaMeta.confidence = null;
  mediaMeta.media_asset_id = mediaAssetId;

  await attachPendingMediaMeta(from, mediaMeta);

  const fin = financeIntentFromText(extractedText);
  if (fin.kind === 'expense' || fin.kind === 'revenue') {
    await markPendingFinance({ from, kind: fin.kind, stableMediaMsgId });
    return { transcript: extractedText, twiml: null };
  }
}

    // If still nothing, ask user what it is (keep your existing UX)
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

    // Let media parser classify structured intents (time, hours, expense/revenue)
    const result = await parseMediaText(extractedText);

    // HOURS inquiry
    if (result?.type === 'hours_inquiry') {
      const name = result?.data?.employeeName || userProfile?.name || '';
      const tz = getUserTz(userProfile);

      if (result?.data?.period && typeof generateTimesheet === 'function') {
        try {
          const { message } = await generateTimesheet({
            ownerId,
            person: name,
            period: result.data.period,
            tz,
            now: new Date()
          });
          return { transcript: null, twiml: twiml(message) };
        } catch (e) {
          console.warn('[MEDIA] generateTimesheet failed; falling back to prompt:', e?.message);
        }
      }

      const pending = await getPendingTransactionState(from);
      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingMedia: { type: 'hours_inquiry' },
        pendingHours: { employeeName: name },
        mediaSourceMsgId: stableMediaMsgId
      });

      return {
        transcript: null,
        twiml: twiml(`Looks like you’re asking about ${name}’s hours. Do you want today, this week, or this month?`)
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
      return { transcript: null, twiml: twiml(`✅ ${String(type || '').replace('_', ' ')} logged for ${who} at ${when}.`) };
    }

    // Expense / Revenue
    if (result?.type === 'expense' || result?.type === 'revenue') {
      await markPendingFinance({ from, kind: result.type, stableMediaMsgId });
      return { transcript: extractedText, twiml: null };
    }

    // Otherwise pass transcript to router
    return { transcript: extractedText, twiml: null };
  } catch (error) {
    console.error(`[MEDIA] handleMedia failed for ${from}:`, error?.message);
    return { transcript: null, twiml: twiml(`⚠️ Failed to process media. Please try again.`) };
  }
}

module.exports = { handleMedia };
