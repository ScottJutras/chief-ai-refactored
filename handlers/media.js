// handlers/media.js
const axios = require('axios');
const { parseMediaText } = require('../services/mediaParser');
const { extractTextFromImage } = require('../utils/visionService');
const { transcribeAudio } = require('../utils/transcriptionService');

const { logTimeEntry, getActiveJob, appendToUserSpreadsheet, generateTimesheet } = require('../services/postgres');
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

async function handleMedia(from, input, userProfile, ownerId, mediaUrl, mediaType) {
  let reply;
  try {
    console.log(`[DEBUG] Processing media from ${from}: type=${mediaType}, url=${mediaUrl}, input=${input || ''}`);

    const validImageTypes = ['image/jpeg', 'image/png'];
    const validAudioTypes = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/ogg; codecs=opus', 'audio/webm'];

    if (!validImageTypes.includes(mediaType) && !validAudioTypes.some(t => (mediaType || '').startsWith(t.split(';')[0]))) {
      reply = `⚠️ Unsupported media type: ${mediaType}. Please send a JPEG/PNG image or MP3/WAV/OGG audio.`;
      return twiml(reply);
    }

    // ---------- Pending confirmation flow ----------
    const pendingState = await getPendingTransactionState(from);
    if (pendingState?.pendingMedia) {
      const { type } = pendingState.pendingMedia;
      const lcInput = String(input || '').toLowerCase().trim();

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
            data.mediaUrl || mediaUrl,
            userProfile.name || 'Unknown',
          ]);
          reply = `✅ Expense logged: ${data.amount} for ${data.item} from ${data.store} (Category: ${data.category})`;
        } else if (type === 'revenue') {
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
        } else if (type === 'time_entry') {
          const { employeeName, type: entryType, timestamp, job } = pendingState.pendingTimeEntry;
          await logTimeEntry(ownerId, employeeName, entryType, timestamp, job);
          const tz = getUserTz(userProfile);
          reply = `✅ ${entryType.replace('_', ' ')} logged for ${employeeName} at ${fmtLocal(timestamp, tz)}${job ? ` on ${job}` : ''}`;
        } else if (type === 'hours_inquiry') {
          // Clarification response "today/week/month" came in as YES/NO flow — ignore yes and fall back
          // We won’t use this, but keep for symmetry.
          reply = `Please specify: today, this week, or this month.`;
        }
        await deletePendingTransactionState(from);
        return twiml(reply);

      } else if (lcInput === 'no' || lcInput === 'cancel') {
        reply = `❌ ${type} cancelled.`;
        await deletePendingTransactionState(from);
        return twiml(reply);

      } else if (lcInput === 'edit') {
        reply = `Please resend the ${type.replace('_', ' ')} details.`;
        await deletePendingTransactionState(from);
        return twiml(reply);

      } else if (type === 'hours_inquiry') {
        // Expecting a period like "today", "week", "month"
        const periodWord = lcInput.match(/\b(today|day|week|month)\b/i)?.[1]?.toLowerCase();
        if (periodWord) {
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
        // Not a period → re-prompt
        return twiml(`Got it. Do you want **today**, **this week**, or **this month** for ${pendingState.pendingHours?.employeeName || 'them'}?`);
      } else {
        reply = `⚠️ Please reply with 'yes', 'no', or 'edit' to confirm or cancel the ${type.replace('_', ' ')} entry.`;
        return twiml(reply);
      }
    }

    // ---------- Build text from media ----------
    let extractedText = String(input || '').trim();

    if (validAudioTypes.some(t => mediaType && mediaType.toLowerCase().startsWith(t))) {
      try {
        const resp = await axios.get(mediaUrl, {
          responseType: 'arraybuffer',
          auth: {
            username: process.env.TWILIO_ACCOUNT_SID,
            password: process.env.TWILIO_AUTH_TOKEN,
          },
        });
        const audioBuf = Buffer.from(resp.data);
        console.log('[DEBUG] audio bytes:', audioBuf?.length, 'mime:', mediaType);
        // transcribe (may try Google first, then Whisper inside your service)
        const transcript = await transcribeAudio(audioBuf, mediaType);
        const len = transcript ? transcript.length : 0;
        console.log(`[DEBUG] Transcription${transcript ? '' : ' (none)'}${len ? ' length: ' + len : ''}`);
        extractedText = (transcript || extractedText || '').trim();
      } catch (e) {
        console.error('[ERROR] audio download/transcribe failed:', e.message);
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

    // ---------- Try to parse ----------
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

  // If the user already specified a period, answer right away.
  if (result.data.period) {
    const { message } = await generateTimesheet({
      ownerId,
      person: name,
      period: result.data.period, // 'day'|'week'|'month'
      tz,
      now: new Date()
    });
    return twiml(message);
  }

  // Otherwise, save pending state and ask for period to keep UX smooth.
  await setPendingTransactionState(from, {
    pendingMedia: { type: 'hours_inquiry' },
    pendingHours: { employeeName: name }
  });
  return twiml(`Looks like you’re asking about ${name}’s hours. Do you want **today**, **this week**, or **this month**?`);
}


    if (result.type === 'time_entry') {
      // Voice UX: auto-commit (no confirmation). Use user TZ; include quick summary.
      const { employeeName, type, timestamp, implicitNow } = result.data;
      const tz = getUserTz(userProfile);
      const activeJob = await getActiveJob(ownerId);
      await logTimeEntry(ownerId, employeeName, type, timestamp, activeJob !== 'Uncategorized' ? activeJob : null);

      // Optional quick weekly snapshot to make it "sticky"
      let summaryTail = '';
      try {
        const { message } = await generateTimesheet({
          ownerId,
          person: employeeName,
          period: 'week',
          tz,
          now: new Date()
        });
        // Use only the first line for brevity after the success tick
        const firstLine = String(message || '').split('\n')[0] || '';
        if (firstLine) summaryTail = `\n${firstLine.replace(/^[^A-Za-z0-9]*/,'')}`;
      } catch (e) {
        // If summary fails, just skip it—don’t block success
        console.warn('[MEDIA] timesheet summary failed:', e.message);
      }

      const humanTime = fmtLocal(timestamp, tz);
      reply = `✅ ${type.replace('_', ' ')} logged for ${employeeName} at ${humanTime}${activeJob !== 'Uncategorized' ? ` on ${activeJob}` : ''}.${summaryTail}`;
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

    // Fallback if parser returns an unexpected shape
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
