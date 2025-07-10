const { parseMediaText, handleReceiptImage } = require('../services/documentAI');
const { logTimeEntry, getActiveJob, appendToUserSpreadsheet } = require('../services/postgres');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('../utils/stateManager');

async function handleMedia(from, input, userProfile, ownerId, mediaUrl, mediaType) {
  const lockKey = `lock:${from}`;
  let reply;

  try {
    console.log(`[DEBUG] Processing media from ${from}: type=${mediaType}, url=${mediaUrl}, input=${input}`);
    const validImageTypes = ['image/jpeg', 'image/png'];
    const validAudioTypes = ['audio/mpeg', 'audio/wav', 'audio/ogg'];
    if (!validImageTypes.includes(mediaType) && !validAudioTypes.includes(mediaType)) {
      reply = `⚠️ Unsupported media type: ${mediaType}. Please send a JPEG/PNG image or MP3/WAV/OGG audio.`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    const pendingState = await getPendingTransactionState(from);
    if (pendingState?.pendingMedia) {
      const { type } = pendingState.pendingMedia;
      const lcInput = input.toLowerCase().trim();
      if (lcInput === 'yes') {
        if (type === 'expense') {
          const data = pendingState.pendingExpense;
          await appendToUserSpreadsheet(ownerId, [
            data.date,
            data.item,
            data.amount,
            data.store,
            await getActiveJob(ownerId) || 'Uncategorized',
            'expense',
            data.category,
            data.mediaUrl || mediaUrl,
            userProfile.name || 'Unknown'
          ]);
          reply = `✅ Expense logged: ${data.amount} for ${data.item} from ${data.store} (Category: ${data.category})`;
        } else if (type === 'revenue') {
          const data = pendingState.pendingRevenue;
          await appendToUserSpreadsheet(ownerId, [
            data.date,
            data.description,
            data.amount,
            data.source,
            await getActiveJob(ownerId) || 'Uncategorized',
            'revenue',
            data.category,
            data.mediaUrl || mediaUrl,
            userProfile.name || 'Unknown'
          ]);
          reply = `✅ Revenue logged: ${data.amount} from ${data.source} (Category: ${data.category})`;
        } else if (type === 'time_entry') {
          const { employeeName, type: entryType, timestamp, job } = pendingState.pendingTimeEntry;
          await logTimeEntry(ownerId, employeeName, entryType, timestamp, job);
          reply = `✅ ${entryType.replace('_', ' ')} logged for ${employeeName} at ${new Date(timestamp).toLocaleString()}${job ? ` on ${job}` : ''}`;
        }
        await deletePendingTransactionState(from);
        return `<Response><Message>${reply}</Message></Response>`;
      } else if (lcInput === 'no' || lcInput === 'cancel') {
        reply = `❌ ${type} cancelled.`;
        await deletePendingTransactionState(from);
        return `<Response><Message>${reply}</Message></Response>`;
      } else if (lcInput === 'edit') {
        reply = `Please resend the ${type.replace('_', ' ')} details.`;
        await deletePendingTransactionState(from);
        return `<Response><Message>${reply}</Message></Response>`;
      } else {
        reply = `⚠️ Please reply with 'yes', 'no', or 'edit' to confirm or cancel the ${type.replace('_', ' ')} entry.`;
        return `<Response><Message>${reply}</Message></Response>`;
      }
    }

    const text = input || 'Unknown';
    const result = await parseMediaText(text);
    if (result.type === 'time_entry') {
      const { employeeName, type, timestamp } = result.data;
      const activeJob = await getActiveJob(ownerId);
      reply = `Please confirm: Log ${type.replace('_', ' ')} for ${employeeName} at ${new Date(timestamp).toLocaleString()}${activeJob !== 'Uncategorized' ? ` on ${activeJob}` : ''}? Reply 'yes', 'no', or 'edit'.`;
      await setPendingTransactionState(from, {
        pendingMedia: { type: 'time_entry' },
        pendingTimeEntry: { employeeName, type, timestamp, job: activeJob !== 'Uncategorized' ? activeJob : null, mediaUrl }
      });
      return `<Response><Message>${reply}</Message></Response>`;
    } else if (result.type === 'expense') {
      const { item, amount, store, date, category } = result.data;
      reply = `Please confirm: Log expense ${amount} for ${item} from ${store} on ${date} (Category: ${category})? Reply 'yes', 'no', or 'edit'.`;
      await setPendingTransactionState(from, {
        pendingMedia: { type: 'expense' },
        pendingExpense: { item, amount, store, date, category, mediaUrl }
      });
      return `<Response><Message>${reply}</Message></Response>`;
    } else if (result.type === 'revenue') {
      const { description, amount, source, date, category } = result.data;
      reply = `Please confirm: Log revenue ${amount} from ${source} on ${date} (Category: ${category})? Reply 'yes', 'no', or 'edit'.`;
      await setPendingTransactionState(from, {
        pendingMedia: { type: 'revenue' },
        pendingRevenue: { description, amount, source, date, category, mediaUrl }
      });
      return `<Response><Message>${reply}</Message></Response>`;
    }

    reply = `Is this an expense receipt, revenue, or timesheet? Reply 'expense', 'revenue', or 'timesheet'.`;
    await setPendingTransactionState(from, {
      pendingMedia: { url: mediaUrl, type: null }
    });
    return `<Response><Message>${reply}</Message></Response>`;
  } catch (error) {
    console.error(`[ERROR] handleMedia failed for ${from}:`, error.message);
    reply = `⚠️ Failed to process media: ${error.message}`;
    return `<Response><Message>${reply}</Message></Response>`;
  } finally {
    await require('../../middleware/lock').releaseLock(lockKey);
  }
}

module.exports = { handleMedia };