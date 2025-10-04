// handlers/media.js
const axios = require('axios');
const { parseMediaText } = require('../services/mediaParser'); // <- was documentAI
const { extractTextFromImage } = require('../utils/visionService');
const { transcribeAudio /*, inferMissingData */ } = require('../utils/transcriptionService');

const { logTimeEntry, getActiveJob, appendToUserSpreadsheet } = require('../services/postgres');
const {
  getPendingTransactionState,
  setPendingTransactionState,
  deletePendingTransactionState
} = require('../utils/stateManager');

function twiml(text) {
  return `<Response><Message>${text}</Message></Response>`;
}

async function downloadTwilioMedia(url) {
  // Twilio media requires basic auth with your Account SID and Auth Token
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN,
    },
  });
  return Buffer.from(resp.data);
}

async function handleMedia(from, input, userProfile, ownerId, mediaUrl, mediaType) {
  let reply;
  try {
    console.log(`[DEBUG] Processing media from ${from}: type=${mediaType}, url=${mediaUrl}, input=${input || ''}`);

    const validImageTypes = ['image/jpeg', 'image/png'];
    const validAudioTypes = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/ogg; codecs=opus', 'audio/webm'];

    if (!validImageTypes.includes(mediaType) && !validAudioTypes.some(t => mediaType.startsWith(t.split(';')[0]))) {
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
          reply = `✅ ${entryType.replace('_', ' ')} logged for ${employeeName} at ${new Date(timestamp).toLocaleString()}${job ? ` on ${job}` : ''}`;
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

      } else {
        reply = `⚠️ Please reply with 'yes', 'no', or 'edit' to confirm or cancel the ${type.replace('_', ' ')} entry.`;
        return twiml(reply);
      }
    }

    // ---------- Build text from media ----------
    let extractedText = String(input || '').trim();

    if (validAudioTypes.some(t => mediaType.startsWith(t.split(';')[0]))) {
      // AUDIO: download & transcribe to text
      const audioBuf = await downloadTwilioMedia(mediaUrl);
      const transcript = await transcribeAudio(audioBuf);
      console.log('[DEBUG] Audio transcript:', transcript);
      extractedText = (transcript || extractedText || '').trim();
      if (!extractedText) {
        return twiml(`⚠️ I couldn’t understand the audio. Try again, or text me the details like "Justin hours week" or "expense $12 coffee".`);
      }
    } else if (validImageTypes.includes(mediaType)) {
      // IMAGE: OCR to text, then parse
      const { text } = await extractTextFromImage(mediaUrl);
      console.log('[DEBUG] OCR text length:', (text || '').length);
      extractedText = (text || extractedText || '').trim();
      // Note: even if OCR text is empty, we proceed to ask the user what it is below
    }

    // If we still lack any text, ask user what it is.
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
      // Fall back to asking what it is
      const msg = `I couldn’t read that. Is this an expense receipt, revenue, or timesheet? Reply 'expense', 'revenue', or 'timesheet'.`;
      await setPendingTransactionState(from, { pendingMedia: { url: mediaUrl, type: null } });
      return twiml(msg);
    }

    if (result.type === 'time_entry') {
      const { employeeName, type, timestamp } = result.data;
      const activeJob = await getActiveJob(ownerId);
      reply =
        `Please confirm: Log ${type.replace('_', ' ')} for ${employeeName} at ${new Date(timestamp).toLocaleString()}` +
        `${activeJob !== 'Uncategorized' ? ` on ${activeJob}` : ''}? Reply 'yes', 'no', or 'edit'.`;
      await setPendingTransactionState(from, {
        pendingMedia: { type: 'time_entry' },
        pendingTimeEntry: {
          employeeName,
          type,
          timestamp,
          job: activeJob !== 'Uncategorized' ? activeJob : null,
          mediaUrl
        }
      });
      return twiml(reply);

    } else if (result.type === 'expense') {
      const { item, amount, store, date, category } = result.data;
      reply = `Please confirm: Log expense ${amount} for ${item} from ${store} on ${date} (Category: ${category})? Reply 'yes', 'no', or 'edit'.`;
      await setPendingTransactionState(from, {
        pendingMedia: { type: 'expense' },
        pendingExpense: { item, amount, store, date, category, mediaUrl }
      });
      return twiml(reply);

    } else if (result.type === 'revenue') {
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
