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
const { handleTimeclock } = require('./commands/timeclock');
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

function toAmPm(tsIso, tz) {
  try {
    return new Date(tsIso).toLocaleString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).toLowerCase();
  } catch {
    return new Date(tsIso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  }
}

function inferIntentFromText(s = '') {
  const lc = String(s).toLowerCase();
  if (/\b(clock|punch)\s+in\b/.test(lc) || /\bstart\s+(work|shift)\b/.test(lc)) return 'punch_in';
  if (/\b(clock|punch)\s+out\b/.test(lc) || /\b(end|finish|stop)\s+(work|shift)\b/.test(lc)) return 'punch_out';
  if (/\b(start|begin)\s+(break|lunch)\b/.test(lc) || /\bon\s+break\b/.test(lc)) return 'break_start';
  if (/\b(end|finish)\s+(break|lunch)\b/.test(lc) || /\boff\s+break\b/.test(lc)) return 'break_end';
  return null;
}

function friendlyTypeLabel(type) {
  if (!type) return 'entry';
  if (type === 'time_entry') return 'time entry';
  if (type === 'hours_inquiry') return 'hours inquiry';
  return String(type).replace('_', ' ');
}

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

async function handleMedia(from, input, userProfile, ownerId, mediaUrl, mediaType) {
  let reply;
  try {
    console.log(`[MEDIA] incoming`, { from, mediaType, hasUrl: !!mediaUrl, inputLen: (input || '').length });

    const validImageTypes = ['image/jpeg', 'image/png'];
    const validAudioTypes = [
      'audio/mpeg',
      'audio/wav',
      'audio/ogg',
      'audio/webm',
      'audio/ogg; codecs=opus',
      'audio/webm; codecs=opus',
    ];

    const baseType = String(mediaType || '').split(';')[0].trim().toLowerCase();
    const isSupportedImage = validImageTypes.includes(baseType);
    const isSupportedAudio = validAudioTypes.some(t => baseType === String(t).split(';')[0].toLowerCase());

    if (!isSupportedImage && !isSupportedAudio) {
      reply = `⚠️ Unsupported media type: ${mediaType}. Please send a JPEG/PNG image or MP3/WAV/OGG/WEBM audio.`;
      return twiml(reply);
    }

    // ---------- Pending confirmation (text-only replies) ----------
    {
      const pendingState = await getPendingTransactionState(from);
      if (pendingState?.pendingMedia && !mediaUrl) {
        const { type } = pendingState.pendingMedia;
        const rawInput = String(input || '');
        const lcInput = rawInput.toLowerCase().trim().replace(/[.!?]$/, '');
        const isYes = lcInput === 'yes' || lcInput === 'y';
        const isNo = lcInput === 'no' || lcInput === 'n' || lcInput === 'cancel';
        const label = friendlyTypeLabel(type);

        if (type != null) {
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
                data.mediaUrl || null,
                userProfile.name || 'Unknown',
              ]);
              await deletePendingTransactionState(from);
              return twiml(`✅ Expense logged: ${data.amount} for ${data.item} from ${data.store} (Category: ${data.category})`);
            }
            if (type === 'revenue' && pendingState.pendingRevenue) {
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
              return twiml(`✅ Revenue logged: ${data.amount} from ${data.source} (Category: ${data.category})`);
            }
            if (type === 'time_entry' && pendingState.pendingTimeEntry) {
              const { employeeName, type: entryType, timestamp, job } = pendingState.pendingTimeEntry;
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
              return twiml(`✅ ${entryType.replace('_', ' ')} logged for ${employeeName} at ${fmtLocal(timestamp, tz)}${job ? ` on ${job}` : ''}`);
            }
            if (type === 'hours_inquiry') {
              await deletePendingTransactionState(from);
              return twiml(`Please specify: today, this week, or this month.`);
            }
            await deletePendingTransactionState(from);
            return twiml(`Hmm, I lost the details for that ${label}. Please resend.`);
          }

          if (isNo) {
            await deletePendingTransactionState(from);
            return twiml(`❌ ${label} cancelled.`);
          }

          if (lcInput === 'edit') {
            await deletePendingTransactionState(from);
            return twiml(`Please resend the ${label} details.`);
          }

          if (type === 'hours_inquiry') {
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
          }

          return twiml(`⚠️ Reply 'yes', 'no', or 'edit' to confirm or cancel the ${label}.`);
        } else if (type == null && !mediaUrl) {
          return twiml(`Is this an expense receipt, revenue, or timesheet? Reply 'expense', 'revenue', or 'timesheet'.`);
        }
      }
    }

    // ---------- Build text from media ----------
    let extractedText = String(input || '').trim();

    // AUDIO
    if (isSupportedAudio) {
      console.log('[MEDIA] starting transcription', { mediaType, urlLen: (mediaUrl || '').length });
      let transcript = '';
      try {
        const resp = await axios.get(mediaUrl, {
          responseType: 'arraybuffer',
          auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN },
        });
        const audioBuf = Buffer.from(resp.data);
        console.log('[MEDIA] audio bytes', audioBuf?.length, 'mime', mediaType);
        transcript = await transcribeAudio(audioBuf, mediaType, 'both');
        console.log('[MEDIA] transcript bytes', transcript ? transcript.length : 0);
        console.log('[MEDIA] transcript text', transcript || '(none)');
      } catch (e) {
        console.error('[MEDIA] transcribe failed:', e.message);
      }

      if (!transcript) {
        return twiml(`⚠️ I couldn’t understand the audio. Try again, or text me the details like "task - buy tape" or "remind me to call Dylan".`);
      }

      // If it smells like finance/timeclock, fall through to the existing media flow
      const lc = transcript.toLowerCase();
      const looksHours   = /\bhours?\b/.test(lc) || /\btimesheet\b/.test(lc);
      const looksExpense = /\b(expense|receipt|spent|cost)\b/.test(lc);
      const looksRevenue = /\b(revenue|payment|paid|deposit|sale)\b/.test(lc);
      const timeclockIntent = inferIntentFromText(transcript);

      if (timeclockIntent || looksHours || looksExpense || looksRevenue) {
        extractedText = transcript.trim();
      } else {
        // Primary: simple voice “task … / remind me …”
        return { transcript: transcript.trim() };
      }
    }

    // IMAGE
    if (isSupportedImage) {
      const { text } = await extractTextFromImage(mediaUrl);
      console.log('[MEDIA] OCR text length', (text || '').length);
      extractedText = (text || extractedText || '').trim();
    }

    if (!extractedText) {
      const msg = `Is this an expense receipt, revenue, or timesheet? Reply 'expense', 'revenue', or 'timesheet'.`;
      await setPendingTransactionState(from, { pendingMedia: { url: mediaUrl, type: null } });
      return twiml(msg);
    }

    // ---------- Parse ----------
    console.log('[MEDIA] parseMediaText()', { excerpt: (extractedText || '').slice(0, 80) });
    let result;
    try {
      result = await parseMediaText(extractedText);
    } catch (e) {
      console.error('[MEDIA] parseMediaText failed:', e.message);
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
      let { employeeName, type, timestamp, job } = result.data;

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

      const activeJob = await getActiveJob(ownerId);
      reply = `✅ ${type.replace('_', ' ')} logged for ${employeeName || userProfile?.name || 'Unknown'} at ${humanTime}${activeJob && activeJob !== 'Uncategorized' ? ` on ${activeJob}` : ''}.${summaryTail}`;
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
    console.error(`[MEDIA] handleMedia failed for ${from}:`, error.message);
    reply = `⚠️ Failed to process media: ${error.message}`;
    return twiml(reply);
  }
}

module.exports = { handleMedia };
