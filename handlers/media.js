// handlers/media.js
const axios = require('axios');
const { parseMediaText } = require('../services/mediaParser');
const { extractTextFromImage } = require('../utils/visionService');
const { transcribeAudio } = require('../utils/transcriptionService');

const {
  logTimeEntry,
  getActiveJob,
  appendToUserSpreadsheet,
  generateTimesheet,
} = require('../services/postgres');

// ⬇️ NEW: reuse your canonical timeclock pipeline (enforces guardrails)
const { handleTimeclock } = require('../handlers/commands/timeclock');

const {
  getPendingTransactionState,
  setPendingTransactionState,
  deletePendingTransactionState
} = require('../utils/stateManager');

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
    return new Date(tsIso).toLocaleString('en-CA', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  } catch {
    return new Date(tsIso).toLocaleString();
  }
}

function friendlyTypeLabel(type) {
  if (!type) return 'entry';
  if (type === 'time_entry') return 'time entry';
  if (type === 'hours_inquiry') return 'hours inquiry';
  return String(type).replace('_', ' ');
}

// ⬇️ helper to feed time_entry into timeclock handler and capture its TwiML
async function runTimeclockPipeline(from, normalized, userProfile, ownerId) {
  // minimal stub of res to capture the TwiML
  let payload = null;
  const resStub = {
    headersSent: false,
    status() { return this; },
    type() { return this; },
    send(body) { payload = String(body || ''); this.headersSent = true; return this; }
  };
  try {
    // ownerProfile/isOwner/extras are optional for core flows; pass safest defaults
    await handleTimeclock(from, normalized, userProfile, ownerId, null, false, resStub, {});
  } catch (e) {
    console.error('[MEDIA] handleTimeclock failed:', e?.message);
  }
  return payload; // TwiML string or null
}

function toAmPm(tsIso, tz) {
  try {
    return new Date(tsIso).toLocaleString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).toLowerCase();
  } catch {
    return new Date(tsIso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  }
}

async function handleMedia(from, input, userProfile, ownerId, mediaUrl, mediaType) {
  let reply;
  try {
    console.log(`[DEBUG] Processing media from ${from}: type=${mediaType}, url=${mediaUrl}, input=${input || ''}`);

    const validImageTypes = ['image/jpeg', 'image/png'];
    const validAudioTypes = [
      'audio/mpeg',
      'audio/wav',
      'audio/ogg',
      'audio/ogg; codecs=opus',
      'audio/webm',
      'audio/webm; codecs=opus'
    ];

    // --------- Basic media guard ---------
    if (
      !validImageTypes.includes(mediaType) &&
      !validAudioTypes.some(t => (mediaType || '').toLowerCase().startsWith(t.split(';')[0]))
    ) {
      reply = `⚠️ Unsupported media type: ${mediaType}. Please send a JPEG/PNG image or MP3/WAV/OGG audio.`;
      return twiml(reply);
    }

    // ---------- Pending confirmation flow (do not block if NEW MEDIA arrived) ----------
    {
      const pendingState = await getPendingTransactionState(from);
      if (pendingState?.pendingMedia) {
        const { type } = pendingState.pendingMedia; // can be null (unknown) or a string
        const rawInput = String(input || '');
        const lcInput = rawInput.toLowerCase().trim().replace(/[.!?]$/,'');
        const isYes = lcInput === 'yes' || lcInput === 'y';
        const isNo  = lcInput === 'no'  || lcInput === 'n' || lcInput === 'cancel';

        const label = friendlyTypeLabel(type);

        if (mediaUrl && mediaType) {
          await deletePendingTransactionState(from);

        } else if (type != null) {
          if (isYes) {
            if (type === 'expense' && pendingState.pendingExpense) {
              const data = pendingState.pendingExpense;
              await appendToUserSpreadsheet(ownerId, [
                data.date,
                data.item,
                data.amount,
                data.store,
                (await getActiveJob(ownerId)) || 'Uncategorized',
                'expense',
                data.category,
                data.mediaUrl || mediaUrl,
                userProfile.name || 'Unknown',
              ]);
              reply = `✅ Expense logged: ${data.amount} for ${data.item} from ${data.store} (Category: ${data.category})`;

            } else if (type === 'revenue' && pendingState.pendingRevenue) {
              const data = pendingState.pendingRevenue;
              await appendToUserSpreadsheet(ownerId, [
                data.date,
                data.description,
                data.amount,
                data.source,
                (await getActiveJob(ownerId)) || 'Uncategorized',
                'revenue',
                data.category,
                data.mediaUrl || mediaUrl,
                userProfile.name || 'Unknown',
              ]);
              reply = `✅ Revenue logged: ${data.amount} from ${data.source} (Category: ${data.category})`;

            } else if (type === 'time_entry' && pendingState.pendingTimeEntry) {
              // Defer to canonical handler to enforce “no double clock-ins”, break rules, etc.
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
              return tw || twiml(`✅ ${entryType.replace('_', ' ')} logged for ${employeeName} at ${fmtLocal(timestamp, tz)}`);

            } else if (type === 'hours_inquiry') {
              reply = `Please specify: today, this week, or this month.`;

            } else {
              reply = `Hmm, I lost the details for that ${label}. Please resend.`;
            }
            await deletePendingTransactionState(from);
            return twiml(reply);

          } else if (isNo) {
            reply = `❌ ${label} cancelled.`;
            await deletePendingTransactionState(from);
            return twiml(reply);

          } else if (lcInput === 'edit') {
            reply = `Please resend the ${label} details.`;
            await deletePendingTransactionState(from);
            return twiml(reply);

          } else if (type === 'hours_inquiry') {
            let periodWord = lcInput.match(/\b(today|day|this\s+week|week|this\s+month|month|now)\b/i)?.[1]?.toLowerCase();
            if (periodWord) {
              if (periodWord === 'now') periodWord = 'today';
              if (periodWord === 'this week') periodWord = 'week';
              if (periodWord === 'this month') periodWord = 'month';
              const period = periodWord === 'today' ? 'day' : periodWord;
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
              return twiml(message);
            }
            return twiml(`Got it. Do you want **today**, **this week**, or **this month** for ${pendingState.pendingHours?.employeeName || 'them'}?`);
          } else {
            return twiml(`⚠️ Please reply with 'yes', 'no', or 'edit' to confirm or cancel the ${label}.`);
          }

        } else if (type == null && !mediaUrl) {
          return twiml(`Is this an expense receipt, revenue, or timesheet? Reply 'expense', 'revenue', or 'timesheet'.`);
        }
      }
    }

    // ---------- Build text from media ----------
    let extractedText = String(input || '').trim();

    if (validAudioTypes.some(t => mediaType && mediaType.toLowerCase().startsWith(t.split(';')[0]))) {
      try {
        const resp = await axios.get(mediaUrl, {
          responseType: 'arraybuffer',
          auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN },
        });
        const audioBuf = Buffer.from(resp.data);
        console.log('[DEBUG] audio bytes:', audioBuf?.length, 'mime:', mediaType);
        const transcript = await transcribeAudio(audioBuf, mediaType);
        const len = transcript ? transcript.length : 0;
        console.log(`[DEBUG] Transcription${transcript ? '' : ' (none)'}${len ? ' length: ' + len : ''}`);
        extractedText = (transcript || extractedText || '').trim();
      } catch (e) {
        console.error('[ERROR] audio download/transcribe failed:', e.message);
      }

      // When both engines only return "Now.", don’t pretend we can act—guide quickly.
      if (/^now\.?$/i.test(extractedText)) {
        return twiml(`Heard “now”. If you’re clocking someone, say “clock in Justin now” or “punch out Justin”.`);
      }

      if (!extractedText) {
        return twiml(`⚠️ I couldn’t understand the audio. Try again, or text me the details like "Justin hours week" or "expense $12 coffee".`);
      }
    } else if (validImageTypes.includes(mediaType)) {
      const { text } = await extractTextFromImage(mediaUrl);
      console.log('[DEBUG] OCR text length:', (text || '').length);
      extractedText = (text || extractedText || '').trim();
    }

    if (!extractedText) {
      const msg = `Is this an expense receipt, revenue, or timesheet? Reply 'expense', 'revenue', or 'timesheet'.`;
      await setPendingTransactionState(from, { pendingMedia: { url: mediaUrl, type: null } });
      return twiml(msg);
    }

    // ---------- Parse ----------
    console.log('[DEBUG] parseMediaText called:', { text: extractedText || '(empty)' });
    let result;
    try {
      result = await parseMediaText(extractedText);
    } catch (e) {
      console.error('[ERROR] parseMediaText failed:', e.message);
      const msg = `I couldn’t read that. Is this an expense receipt, revenue, or timesheet? Reply 'expense', 'revenue', or 'timesheet'.`;
      await setPendingTransactionState(from, { pendingMedia: { url: mediaUrl, type: null } });
      return twiml(msg);
    }

    // ---------- Handle parse result ----------
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

      await setPendingTransactionState(from, {
        pendingMedia: { type: 'hours_inquiry' },
        pendingHours: { employeeName: name }
      });
      return twiml(`Looks like you’re asking about ${name}’s hours. Do you want **today**, **this week**, or **this month**?`);
    }

    if (result.type === 'time_entry') {
      // Route voice time entries through the canonical timeclock command handler (enforces guardrails).
      const { employeeName, type, timestamp } = result.data;
      const tz = getUserTz(userProfile);
      const hhmm = toAmPm(timestamp, tz);

      let normalized;
      if (type === 'punch_in') normalized = `${employeeName} punched in at ${hhmm}`;
      else if (type === 'punch_out') normalized = `${employeeName} punched out at ${hhmm}`;
      else if (type === 'break_start') normalized = `start break for ${employeeName} at ${hhmm}`;
      else if (type === 'break_end') normalized = `end break for ${employeeName} at ${hhmm}`;
      else if (type === 'drive_start') normalized = `start drive for ${employeeName} at ${hhmm}`;
      else if (type === 'drive_end') normalized = `end drive for ${employeeName} at ${hhmm}`;
      else normalized = `${employeeName} punched in at ${hhmm}`;

      const tw = await runTimeclockPipeline(from, normalized, userProfile, ownerId);
      if (tw) return tw;

      // Fallback (if the handler didn’t emit TwiML for some reason)
      const humanTime = fmtLocal(timestamp, tz);
      let summaryTail = '';
      try {
        if (type === 'punch_out') {
          const { message } = await generateTimesheet({
            ownerId,
            person: employeeName,
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
      const job = await getActiveJob(ownerId);
      reply = `✅ ${type.replace('_', ' ')} logged for ${employeeName} at ${humanTime}${job && job !== 'Uncategorized' ? ` on ${job}` : ''}.${summaryTail}`;
      return twiml(reply);
    }

    if (result.type === 'expense') {
      const { item, amount, store, date, category } = result.data;
      reply = `Please confirm: Log expense ${amount} for ${item} from ${store} on ${date} (Category: ${category})? Reply 'yes', 'no', or 'edit'.`;
      await setPendingTransactionState(from, {
        pendingMedia: { type: 'expense' },
        pendingExpense: { item, amount, store, date, category, mediaUrl }
      });
      return twiml(reply);
    }

    if (result.type === 'revenue') {
      const { description, amount, source, date, category } = result.data;
      reply = `Please confirm: Log revenue ${amount} from ${source} on ${date} (Category: ${category})? Reply 'yes', 'no', or 'edit'.`;
      await setPendingTransactionState(from, {
        pendingMedia: { type: 'revenue' },
        pendingRevenue: { description, amount, source, date, category, mediaUrl }
      });
      return twiml(reply);
    }

    // Fallback
    reply = `Is this an expense receipt, revenue, or timesheet? Reply 'expense', 'revenue', or 'timesheet'.`;
    await setPendingTransactionState(from, { pendingMedia: { url: mediaUrl, type: null } });
    return twiml(reply);

  } catch (error) {
    console.error(`[ERROR] handleMedia failed for ${from}:`, error.message);
    reply = `⚠️ Failed to process media: ${error.message}`;
    return twiml(reply);
  }
}

module.exports = { handleMedia };
