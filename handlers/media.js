// handlers/media.js
const axios = require('axios');
const { parseMediaText } = require('../services/mediaParser');
const { extractTextFromImage } = require('../utils/visionService');

// ✅ Backwards-compatible transcription import (fixes: "transcribeAudio is not a function")
const tsMod = require('../utils/transcriptionService');
const transcribeAudio =
  (tsMod && typeof tsMod.transcribeAudio === 'function' && tsMod.transcribeAudio) ||
  (tsMod && typeof tsMod.transcribe === 'function' && tsMod.transcribe) ||
  (typeof tsMod === 'function' && tsMod) ||
  null;

if (!transcribeAudio) {
  console.warn('[MEDIA] transcriptionService export missing: expected transcribeAudio()', {
    type: typeof tsMod,
    keys: Object.keys(tsMod || {})
  });
}

const {
  getActiveJob,
  generateTimesheet,
} = require('../services/postgres');

const { handleTimeclock } = require('./commands/timeclock');

const {
  getPendingTransactionState,
  mergePendingTransactionState,
  deletePendingTransactionState
} = require('../utils/stateManager');

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

// Normalize media content-type (strip params like "; codecs=opus")
function normalizeContentType(mediaType) {
  return String(mediaType || '').split(';')[0].trim().toLowerCase();
}

// Try to interpret transcribeAudio return values tolerantly:
// - string
// - { transcript } / { text } / { confidence }
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

// Store media meta into pending state so revenue/expense handlers can persist it later.
// This is fail-open and never blocks the user flow.
async function attachPendingMediaMeta(from, pending, meta) {
  try {
    const url = String(meta?.url || '').trim() || null;
    const type = String(meta?.type || '').trim() || null;
    const transcript = truncateText(meta?.transcript, MAX_MEDIA_TRANSCRIPT_CHARS);
    const confidence = Number.isFinite(Number(meta?.confidence)) ? Number(meta.confidence) : null;

    // Nothing useful to store
    if (!url && !type && !transcript && confidence == null) return;

    await mergePendingTransactionState(from, {
      ...(pending || {}),
      pendingMediaMeta: { url, type, transcript, confidence },
      // pendingMedia stays as-is; caller decides its lifecycle
    });
  } catch (e) {
    console.warn('[MEDIA] attachPendingMediaMeta failed (ignored):', e?.message);
  }
}

/* ---------------- main ---------------- */

async function handleMedia(from, input, userProfile, ownerId, mediaUrl, mediaType) {
  let reply;
  try {
    console.log(`[MEDIA] incoming`, { from, mediaType, hasUrl: !!mediaUrl, inputLen: (input || '').length });

    const validImageTypes = ['image/jpeg', 'image/png', 'image/webp'];

    // Normalized allow-list for audio (params like "; codecs=opus" are stripped below)
    const validAudioTypes = new Set([
      'audio/mpeg',
      'audio/mp3',
      'audio/wav',
      'audio/vnd.wave',
      'audio/ogg',
      'audio/webm',
      'audio/mp4',
      'audio/x-m4a',
      'audio/aac',
      'audio/3gpp',
      'audio/3gpp2',
      'audio/basic',
      'audio/l24',
      'audio/vnd.rn-realaudio',
      'audio/ac3',
      'audio/amr-nb',
      'audio/amr',
      'audio/opus',
    ]);

    const baseType = normalizeContentType(mediaType);
    console.log('[MEDIA] normalized content-type', { original: mediaType, baseType });

    const isSupportedImage = validImageTypes.includes(baseType);

    // Be resilient: accept any audio/*
    const isAudioFamily = baseType.startsWith('audio/');
    const isWhitelistedAudio = validAudioTypes.has(baseType);
    const isSupportedAudio = isAudioFamily;

    if (!isSupportedImage && !isSupportedAudio) {
      reply = `⚠️ Unsupported media type: ${mediaType}. Please send an image (JPEG/PNG/WEBP) or an audio/voice note.`;
      return twiml(reply);
    }
    if (isAudioFamily && !isWhitelistedAudio) {
      console.warn('[MEDIA] audio/* accepted but not on allow-list', { baseType });
    }

    /* ---------- Pending confirmation (text-only replies) ----------
       IMPORTANT:
       - For expense/revenue confirmation we want webhook.js to route into expense.js/revenue.js.
       - So when pendingMedia exists and this is a text-only reply (no mediaUrl),
         we return { transcript: input } and let the main router handle it.
    */
    {
      const pendingState = await getPendingTransactionState(from);

      // Only if we were expecting media follow-up and we got text-only
      if (pendingState?.pendingMedia && !mediaUrl) {
        const pendingType = pendingState?.pendingMedia?.type || null;

        // If it’s finance confirmations, DO NOT handle here.
        // Let webhook → expense/revenue handler process "yes/edit/cancel".
        if (pendingType === 'expense' || pendingType === 'revenue') {
          return { transcript: String(input || '').trim(), twiml: null };
        }

        const rawInput = String(input || '');
        const lcInput = rawInput.toLowerCase().trim().replace(/[.!?]$/, '');
        const isYes = lcInput === 'yes' || lcInput === 'y';
        const isNo  = lcInput === 'no'  || lcInput === 'n' || lcInput === 'cancel';

        if (pendingType != null) {
          if (isYes) {
            if (pendingType === 'time_entry' && pendingState.pendingTimeEntry) {
              const { employeeName, type: entryType, timestamp } = pendingState.pendingTimeEntry;
              const tz = getUserTz(userProfile);
              const hhmm = toAmPm(timestamp, tz);

              let normalized;
              if (entryType === 'punch_in') normalized = `${employeeName} punched in at ${hhmm}`;
              else if (entryType === 'punch_out') normalized = `${employeeName} punched out at ${hhmm}`;
              else if (entryType === 'break_start') normalized = `start break for ${employeeName} at ${hhmm}`;
              else if (entryType === 'break_end') normalized = `end break for ${employeeName} at ${hhmm}`;
              else if (entryType === 'drive_start') normalized = `start drive for ${employeeName} at ${hhmm}`;
              else if (entryType === 'drive_end') normalized = `end drive for ${employeeName} at ${hhmm}`;
              else normalized = `${employeeName} punched in at ${hhmm}`;

              const tw = await runTimeclockPipeline(from, normalized, userProfile, ownerId);
              await deletePendingTransactionState(from);
              if (typeof tw === 'string' && tw.trim()) return tw;
              return twiml(`✅ ${entryType.replace('_', ' ')} logged for ${employeeName} at ${fmtLocal(timestamp, tz)}`);
            }

            if (pendingType === 'hours_inquiry') {
              await deletePendingTransactionState(from);
              return twiml(`Please specify: today, this week, or this month.`);
            }

            await deletePendingTransactionState(from);
            return twiml(`Hmm, I lost the details. Please resend.`);
          }

          if (isNo) {
            await deletePendingTransactionState(from);
            return twiml(`❌ Cancelled.`);
          }

          if (lcInput === 'edit') {
            await deletePendingTransactionState(from);
            return twiml(`Please resend the details.`);
          }

          if (pendingType === 'hours_inquiry') {
            let periodWord =
              lcInput.match(/\b(today|day|this\s*week|week|this\s*month|month|now)\b/i)?.[1]?.toLowerCase() ||
              (/\bthisweek\b/i.test(lcInput) ? 'this week' : null) ||
              (/\bthismonth\b/i.test(lcInput) ? 'this month' : null);

            if (periodWord) {
              if (periodWord === 'now') periodWord = 'day';
              if (periodWord === 'this week') periodWord = 'week';
              if (periodWord === 'this month') periodWord = 'month';
              const period = periodWord === 'today' ? 'day' : periodWord;

              const tz = getUserTz(userProfile);
              const name = pendingState.pendingHours?.employeeName || userProfile?.name || '';
              const { message } = await generateTimesheet({ ownerId, person: name, period, tz, now: new Date() });
              await deletePendingTransactionState(from);
              return twiml(message);
            }
            return twiml(`Got it. Do you want **today**, **this week**, or **this month**?`);
          }

          return twiml(`⚠️ Reply 'yes', 'no', or 'edit' to confirm or cancel.`);
        } else if (pendingType == null && !mediaUrl) {
          return twiml(`Is this an expense receipt, revenue, or timesheet? Reply 'expense', 'revenue', or 'timesheet'.`);
        }
      }
    }

    /* ---------- Build text from media ---------- */
    let extractedText = String(input || '').trim();

    // Normalize once
    const normType = normalizeContentType(mediaType);

    // We’ll collect mediaMeta for auditability + DB persistence
    let mediaMeta = {
      url: mediaUrl || null,
      type: normType || null,
      transcript: null,
      confidence: null
    };

    // AUDIO
    if (isAudioFamily) {
      if (!transcribeAudio) {
        return twiml(`⚠️ Audio transcription isn’t configured yet (server). Please text the details for now.`);
      }

      const urlLen = (mediaUrl || '').length;
      console.log('[MEDIA] starting transcription', { mediaType, normType, urlLen });

      let transcript = '';
      let confidence = null;

      try {
        // Twilio media requires Basic Auth
        const resp = await axios.get(mediaUrl, {
          responseType: 'arraybuffer',
          auth: {
            username: process.env.TWILIO_ACCOUNT_SID,
            password: process.env.TWILIO_AUTH_TOKEN
          },
          maxContentLength: 8 * 1024 * 1024, // 8MB cap
        });

        const audioBuf = Buffer.from(resp.data);
        console.log('[MEDIA] audio bytes', audioBuf?.length || 0, 'mime', mediaType, 'norm', normType, 'baseType', baseType);

        // Attempt 1: normalized mime
        const r1 = await transcribeAudio(audioBuf, normType, 'both');
        const n1 = normalizeTranscriptionResult(r1);
        transcript = n1.transcript;
        confidence = n1.confidence;

        console.log('[MEDIA] transcript bytes', transcript ? transcript.length : 0);

        // Fallback: OGG/Opus sometimes needs a different label
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
          `⚠️ I couldn’t understand the audio. Try again, or text me the details like "received $100 for 1556 Medway Park Dr today".`
        );
      }

      // Store transcript in meta (truncated)
      mediaMeta.transcript = truncateText(transcript.trim(), MAX_MEDIA_TRANSCRIPT_CHARS);
      mediaMeta.confidence = Number.isFinite(Number(confidence)) ? Number(confidence) : null;

      // Decide whether to pass transcript into the main webhook pipeline
      const lc = transcript.toLowerCase();
      const looksHours   = /\bhours?\b/.test(lc) || /\btimesheet\b/.test(lc);
      const looksExpense = /\b(expense|receipt|spent|cost)\b/.test(lc);
      const looksRevenue = /\b(revenue|payment|paid|deposit|sale|received)\b/.test(lc);
      const timeclockIntent = inferIntentFromText(transcript);

      // If it smells like finance/timeclock/hours, fall through and attach meta to pending state
      if (timeclockIntent || looksHours || looksExpense || looksRevenue) {
        // Attach meta now so revenue/expense can persist it after parse/confirm
        const pending = await getPendingTransactionState(from);
        await attachPendingMediaMeta(from, pending, mediaMeta);

        extractedText = transcript.trim();
      } else {
        // Voice task / general: DO NOT attach mediaMeta (prevents mis-attachment to next transaction)
        return { transcript: transcript.trim(), twiml: null };
      }
    }

    // IMAGE
    if (isSupportedImage) {
      // NOTE: ensure extractTextFromImage fetches Twilio media with Basic Auth as well
      const { text } = await extractTextFromImage(mediaUrl);
      console.log('[MEDIA] OCR text length', (text || '').length);
      extractedText = (text || extractedText || '').trim();

      // Store OCR text as transcript for auditability
      mediaMeta.transcript = truncateText(extractedText, MAX_MEDIA_TRANSCRIPT_CHARS);
      mediaMeta.confidence = null;

      // Attach meta now (images are overwhelmingly finance receipts / audit-relevant)
      const pending = await getPendingTransactionState(from);
      await attachPendingMediaMeta(from, pending, mediaMeta);
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

    let result;
    try {
      result = await parseMediaText(extractedText);
    } catch (e) {
      console.error('[MEDIA] parseMediaText failed:', e.message);
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
      if (inferred === 'drive_start' && type === 'drive_end')  type = 'drive_start';
      if (inferred === 'drive_end'   && type === 'drive_start')type = 'drive_end';

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
        const who = employeeName || userProfile?.name || 'Unknown';
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

      const activeJob = await getActiveJob(ownerId);
      reply = `✅ ${type.replace('_', ' ')} logged for ${employeeName || userProfile?.name || 'Unknown'} at ${humanTime}${activeJob && activeJob !== 'Uncategorized' ? ` on ${activeJob}` : ''}.${summaryTail}`;
      return twiml(reply);
    }

    // EXPENSE (parsed from media)
    if (result.type === 'expense') {
      const { item, amount, store, date, category, jobName } = result.data;

      // Ensure pendingMedia exists so webhook can route text-only follow-ups.
      const pending = await getPendingTransactionState(from);

      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingMedia: { type: 'expense' },
        pendingExpense: { item, amount, store, date, category, jobName },
        type: 'expense',
        expenseSourceMsgId: `${from}:${Date.now()}`
      });

      reply = `Please confirm: Log expense ${amount} for ${item}${store ? ` from ${store}` : ''} on ${date}${category ? ` (Category: ${category})` : ''}. Reply yes/edit/cancel.`;
      return twiml(reply);
    }

    // REVENUE (parsed from media)
    if (result.type === 'revenue') {
      const { description, amount, source, date, category, jobName } = result.data;

      const pending = await getPendingTransactionState(from);

      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingMedia: { type: 'revenue' },
        pendingRevenue: { description, amount, source, date, category, jobName },
        type: 'revenue',
        revenueSourceMsgId: `${from}:${Date.now()}`
      });

      reply = `Please confirm: Payment ${amount}${source ? ` from ${source}` : ''} on ${date}${jobName ? ` for ${jobName}` : ''}${category ? ` (Category: ${category})` : ''}. Reply yes/edit/cancel.`;
      return twiml(reply);
    }

    // Fallback
    reply = `Is this an expense receipt, revenue, or timesheet? Reply 'expense', 'revenue', or 'timesheet'.`;
    const pending = await getPendingTransactionState(from);
    await mergePendingTransactionState(from, {
      ...(pending || {}),
      pendingMedia: { url: mediaUrl, type: null }
    });
    return twiml(reply);

  } catch (error) {
    console.error(`[MEDIA] handleMedia failed for ${from}:`, error.message);
    reply = `⚠️ Failed to process media: ${error.message}`;
    return twiml(reply);
  }
}

module.exports.handleMedia = handleMedia;
