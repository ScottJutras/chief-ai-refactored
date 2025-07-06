const axios = require('axios');
const { processDocumentAI } = require('../services/documentAI');
const { transcribeAudio } = require('../utils/transcriptionService');
const { callOpenAI } = require('../services/openAI');
const { appendToUserSpreadsheet, logTimeEntry, getActiveJob, parseReceiptText } = require('../services/postgres');
const { setPendingTransactionState, getPendingTransactionState, deletePendingTransactionState } = require('../utils/stateManager');
const { sendTemplateMessage, sendMessage } = require('../services/twilio');
const { db } = require('../services/firebase');
const { confirmationTemplates } = require('../config');

async function handleMedia(from, mediaUrl, mediaType, userProfile, ownerId, ownerProfile, isOwner, res) {
  const lockKey = `lock:${from}`;
  let reply;

  try {
    console.log(`[DEBUG] Processing media from ${from}: type=${mediaType}, url=${mediaUrl}`);
    
    const validImageTypes = ['image/jpeg', 'image/png'];
    const validAudioTypes = ['audio/mpeg', 'audio/wav', 'audio/ogg'];
    if (!validImageTypes.includes(mediaType) && !validAudioTypes.includes(mediaType)) {
      reply = `⚠️ Unsupported media type: ${mediaType}. Please send a JPEG/PNG image or MP3/WAV/OGG audio.`;
      await db.collection('locks').doc(lockKey).delete();
 console.log(`[LOCK] Released lock for ${from} (unsupported media type)`);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    const pendingState = await getPendingTransactionState(from);
    if (pendingState?.pendingMedia) {
      const { type } = pendingState.pendingMedia;
      if (type === 'receipt' && validImageTypes.includes(mediaType)) {
        const text = await processDocumentAI(mediaUrl);
        const data = await parseReceiptText(text);
        const category = await callOpenAI(
          `Categorize this expense: ${JSON.stringify(data)}. Available categories: Miscellaneous, Supplies, Labor, Equipment, Other. Return a single category name.`,
          'Categorize the expense.',
          'gpt-3.5-turbo',
          50,
          0.3
        );
        reply = `Please confirm: Log expense ${data.amount} for ${data.item} from ${data.store} on ${data.date} (Category: ${category})? Reply 'yes', 'no', or 'edit'.`;
        await setPendingTransactionState(from, {
          pendingExpense: { ...data, suggestedCategory: category, mediaUrl }
        });
        await db.collection('locks').doc(lockKey).delete();
 console.log(`[LOCK] Released lock for ${from} (expense confirmation)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else if (type === 'timesheet' && validImageTypes.includes(mediaType)) {
        const text = await processDocumentAI(mediaUrl);
        const prompt = `Parse timesheet image text: "${text}". Return JSON: { employeeName: "string", type: "punch_in|punch_out|break_start|break_end|lunch_start|lunch_end|drive_start|drive_end", timestamp: "ISO string" }`;
        const { employeeName, type, timestamp } = JSON.parse(await callOpenAI(prompt, text, 'gpt-3.5-turbo', 100, 0.3));
        if (!employeeName || !type || !timestamp) {
          throw new Error('Invalid timesheet format');
        }
        const activeJob = await getActiveJob(ownerId);
        reply = `Please confirm: Log ${type.replace('_', ' ')} for ${employeeName} at ${new Date(timestamp).toLocaleString()}${activeJob !== 'Uncategorized' ? ` on ${activeJob}` : ''}? Reply 'yes', 'no', or 'edit'.`;
        await setPendingTransactionState(from, {
          pendingTimeEntry: { employeeName, type, timestamp, job: activeJob !== 'Uncategorized' ? activeJob : null, mediaUrl }
        });
        await db.collection('locks').doc(lockKey).delete();
 console.log(`[LOCK] Released lock for ${from} (timesheet confirmation)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
    }

    if (pendingState?.pendingExpense || pendingState?.pendingRevenue || pendingState?.pendingTimeEntry) {
      const lcInput = pendingState.input?.toLowerCase() || '';
      if (lcInput === 'yes') {
        if (pendingState.pendingExpense) {
          const data = pendingState.pendingExpense;
          const category = data.suggestedCategory || await callOpenAI(
            `Categorize this expense: ${JSON.stringify(data)}. Available categories: Miscellaneous, Supplies, Labor, Equipment, Other. Return a single category name.`,
            'Categorize the expense.',
            'gpt-3.5-turbo',
            50,
            0.3
          );
          await appendToUserSpreadsheet(ownerId, [
            data.date,
            data.item,
            data.amount,
            data.store,
            await getActiveJob(ownerId) || "Uncategorized",
            'expense',
            category,
            data.mediaUrl || '',
            userProfile.name || 'Unknown User'
          ]);
          await db.collection('users').doc(ownerId).collection('expenses').add({
            date: data.date,
            item: data.item,
            amount: parseFloat(data.amount.replace(/[^0-9.]/g, '')),
            store: data.store,
            job: await getActiveJob(ownerId) || "Uncategorized",
            category,
            mediaUrl: data.mediaUrl || '',
            created_at: new Date().toISOString()
          });
          reply = `✅ Expense logged: ${data.amount} for ${data.item} from ${data.store} (Category: ${category})`;
          await deletePendingTransactionState(from);
          await db.collection('locks').doc(lockKey).delete();
 console.log(`[LOCK] Released lock for ${from} (expense logged)`);
          return res.send(`<Response><Message>${reply}</Message></Response>`);
        } else if (pendingState.pendingRevenue) {
          const data = pendingState.pendingRevenue;
          const category = data.suggestedCategory || await callOpenAI(
            `Categorize this revenue: ${JSON.stringify(data)}. Available categories: Miscellaneous, Service, Product, Other. Return a single category name.`,
            'Categorize the revenue.',
            'gpt-3.5-turbo',
            50,
            0.3
          );
          await appendToUserSpreadsheet(ownerId, [
            data.date,
            data.description,
            data.amount,
            data.source || data.client,
            await getActiveJob(ownerId) || "Uncategorized",
            'revenue',
            category,
            data.mediaUrl || '',
            userProfile.name || 'Unknown User'
          ]);
          await db.collection('users').doc(ownerId).collection('revenues').add({
            date: data.date,
            description: data.description,
            amount: parseFloat(data.amount.replace(/[^0-9.]/g, '')),
            source: data.source || data.client,
            job: await getActiveJob(ownerId) || "Uncategorized",
            category,
            mediaUrl: data.mediaUrl || '',
            created_at: new Date().toISOString()
          });
          reply = `✅ Revenue logged: ${data.amount} from ${data.source || data.client} (Category: ${category})`;
          await deletePendingTransactionState(from);
          await db.collection('locks').doc(lockKey).delete();
 console.log(`[LOCK] Released lock for ${from} (revenue logged)`);
          return res.send(`<Response><Message>${reply}</Message></Response>`);
        } else if (pendingState.pendingTimeEntry) {
          const { employeeName, type, timestamp, job, mediaUrl } = pendingState.pendingTimeEntry;
          await logTimeEntry(ownerId, employeeName, type, timestamp, job);
          await db.collection('users').doc(ownerId).collection('time_entries').add({
            employee_name: employeeName,
            type,
            timestamp,
            job,
            media_url: mediaUrl || '',
            created_at: new Date().toISOString()
          });
          reply = `✅ ${type.replace('_', ' ')} logged for ${employeeName} at ${new Date(timestamp).toLocaleString()}${job ? ` on ${job}` : ''}`;
          await deletePendingTransactionState(from);
          await db.collection('locks').doc(lockKey).delete();
 console.log(`[LOCK] Released lock for ${from} (time entry logged)`);
          return res.send(`<Response><Message>${reply}</Message></Response>`);
        }
      } else if (lcInput === 'no' || lcInput === 'cancel') {
        reply = `❌ ${pendingState.pendingExpense ? 'Expense' : pendingState.pendingRevenue ? 'Revenue' : 'Time entry'} cancelled.`;
        await deletePendingTransactionState(from);
        await db.collection('locks').doc(lockKey).delete();
 console.log(`[LOCK] Released lock for ${from} (operation cancelled)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else if (lcInput === 'edit') {
        reply = `Please resend the ${pendingState.pendingExpense ? 'expense' : pendingState.pendingRevenue ? 'revenue' : 'time entry'} details.`;
        await deletePendingTransactionState(from);
        await db.collection('locks').doc(lockKey).delete();
 console.log(`[LOCK] Released lock for ${from} (edit requested)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else {
        const type = pendingState.pendingExpense ? 'expense' : pendingState.pendingRevenue ? 'revenue' : 'time_entry';
        reply = `⚠️ Please reply with 'yes', 'no', or 'edit' to confirm or cancel the ${type.replace('_', ' ')} entry.`;
        await sendTemplateMessage(from, confirmationTemplates[type], {
          "1": pendingState.pendingExpense
            ? `Expense: ${pendingState.pendingExpense.amount} for ${pendingState.pendingExpense.item} from ${pendingState.pendingExpense.store} on ${pendingState.pendingExpense.date}`
            : pendingState.pendingRevenue
            ? `Revenue: ${pendingState.pendingRevenue.amount} from ${pendingState.pendingRevenue.source || pendingState.pendingRevenue.client} on ${pendingState.pendingRevenue.date}`
            : `Time entry: ${pendingState.pendingTimeEntry.type.replace('_', ' ')} for ${pendingState.pendingTimeEntry.employeeName} at ${new Date(pendingState.pendingTimeEntry.timestamp).toLocaleString()}`
        });
        await db.collection('locks').doc(lockKey).delete();
 console.log(`[LOCK] Released lock for ${from} (pending ${type} clarification)`);
        return res.send(`<Response></Response>`);
      }
    }

    let combinedText = '';
    if (validAudioTypes.includes(mediaType)) {
      const audioResponse = await axios.get(mediaUrl, {
        responseType: 'arraybuffer',
        auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN }
      });
      combinedText = await transcribeAudio(Buffer.from(audioResponse.data)) || '';
    } else if (validImageTypes.includes(mediaType)) {
      console.log(`[DEBUG] Processing image from ${mediaUrl}`);
      const imageResponse = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
      combinedText = await processDocumentAI(Buffer.from(imageResponse.data), mediaType);
    }

    if (combinedText) {
      const prompt = `Parse media input: "${combinedText}". Return JSON: { type: "expense|revenue|time_entry", data: { employeeName: "string|null", type: "punch_in|punch_out|break_start|break_end|lunch_start|lunch_end|drive_start|drive_end|null", timestamp: "ISO string|null", amount: "string|null", item: "string|null", store: "string|null", description: "string|null", source: "string|null", client: "string|null" } }`;
      const result = JSON.parse(await callOpenAI(prompt, combinedText, 'gpt-3.5-turbo', 150, 0.3));

      if (result.type === 'time_entry') {
        const { employeeName, type, timestamp } = result.data;
        if (!employeeName || !type || !timestamp) {
          throw new Error('Invalid time entry format');
        }
        const activeJob = await getActiveJob(ownerId);
        reply = `Please confirm: Log ${type.replace('_', ' ')} for ${employeeName} at ${new Date(timestamp).toLocaleString()}${activeJob !== 'Uncategorized' ? ` on ${activeJob}` : ''}? Reply 'yes', 'no', or 'edit'.`;
        await setPendingTransactionState(from, {
          pendingTimeEntry: { employeeName, type, timestamp, job: activeJob !== 'Uncategorized' ? activeJob : null, mediaUrl }
        });
        await db.collection('locks').doc(lockKey).delete();
 console.log(`[LOCK] Released lock for ${from} (time entry confirmation)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else if (result.type === 'expense') {
        const { item, amount, store, date } = result.data;
        if (!item || !amount || !store) {
          throw new Error('Invalid expense format');
        }
        const category = await callOpenAI(
          `Categorize this expense: ${JSON.stringify({ item, amount, store, date })}. Available categories: Miscellaneous, Supplies, Labor, Equipment, Other. Return a single category name.`,
          'Categorize the expense.',
          'gpt-3.5-turbo',
          50,
          0.3
        );
        reply = `Please confirm: Log expense ${amount} for ${item} from ${store} on ${date} (Category: ${category})? Reply 'yes', 'no', or 'edit'.`;
        await setPendingTransactionState(from, {
          pendingExpense: { item, amount, store, date, suggestedCategory: category, mediaUrl }
        });
        await db.collection('locks').doc(lockKey).delete();
 console.log(`[LOCK] Released lock for ${from} (expense confirmation)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else if (result.type === 'revenue') {
        const { description, amount, source, client, date } = result.data;
        if (!description || !amount || (!source && !client)) {
          throw new Error('Invalid revenue format');
        }
        const category = await callOpenAI(
          `Categorize this revenue: ${JSON.stringify({ description, amount, source, client, date })}. Available categories: Miscellaneous, Service, Product, Other. Return a single category name.`,
          'Categorize the revenue.',
          'gpt-3.5-turbo',
          50,
          0.3
        );
        reply = `Please confirm: Log revenue ${amount} from ${source || client} on ${date} (Category: ${category})? Reply 'yes', 'no', or 'edit'.`;
        await setPendingTransactionState(from, {
          pendingRevenue: { description, amount, source, client, date, suggestedCategory: category, mediaUrl }
        });
        await db.collection('locks').doc(lockKey).delete();
 console.log(`[LOCK] Released lock for ${from} (revenue confirmation)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
    }

    reply = `Is this an expense receipt or a timesheet? Reply 'receipt' or 'timesheet'.`;
    await setPendingTransactionState(from, {
      pendingMedia: { url: mediaUrl, type: null }
    });
    await db.collection('locks').doc(lockKey).delete();
 console.log(`[LOCK] Released lock for ${from} (media type clarification)`);
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  } catch (err) {
    console.error(`Error in handleMedia: ${err.message}`);
    await db.collection('locks').doc(lockKey).delete();
 console.log(`[LOCK] Released lock for ${from} (error)`);
    return res.send(`<Response><Message>⚠️ Failed to process media: ${err.message}</Message></Response>`);
  }
}

module.exports = { handleMedia };