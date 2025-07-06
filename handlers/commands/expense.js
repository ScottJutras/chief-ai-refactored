const { appendToUserSpreadsheet, getActiveJob, saveUserProfile } = require('../../services/postgres.js');
const { parseExpenseMessage, handleInputWithAI, detectErrors, correctErrorsWithAI } = require('../../utils/aiErrorHandler');
const { categorizeEntry, parseDeleteRequest } = require('../../services/openAI');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('../../utils/stateManager');
const { sendTemplateMessage } = require('../../services/twilio');
const { google } = require('googleapis');
const { getAuthorizedClient } = require('../../legacy/googleSheetsnewer.js');
const { db } = require('../../services/firebase');
const { confirmationTemplates } = require('../../config');

/**
 * Deletes an expense entry from the user's Google Sheet and Firestore.
 * @param {string} ownerId - The owner's user ID.
 * @param {Object} criteria - The criteria to identify the expense entry (e.g., { item, amount, store, date }).
 * @returns {Promise<boolean>} Success status.
 */
async function deleteExpenseInSheets(ownerId, criteria) {
  try {
    const userProfile = await db.collection('users').doc(ownerId).get();
    const spreadsheetId = userProfile.data().spreadsheetId;
    const auth = await getAuthorizedClient();
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Sheet1!A:I'
    });
    const rows = response.data.values || [];
    const expenseIndex = rows.findIndex(row => 
      row[5] === 'expense' &&
      (!criteria.item || row[1] === criteria.item) &&
      (!criteria.amount || row[2] === `$${parseFloat(criteria.amount).toFixed(2)}`) &&
      (!criteria.store || row[3] === criteria.store) &&
      (!criteria.date || row[0] === criteria.date)
    );
    if (expenseIndex === -1) return false;

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Sheet1!A${expenseIndex + 1}:I${expenseIndex + 1}`,
      valueInputOption: 'RAW',
      resource: { values: [[]] }
    });
    await db.collection('users').doc(ownerId).collection('expenses')
      .where('item', '==', criteria.item)
      .where('amount', '==', parseFloat(criteria.amount))
      .where('store', '==', criteria.store)
      .where('date', '==', criteria.date)
      .get()
      .then(snapshot => snapshot.forEach(doc => doc.ref.delete()));
    return true;
  } catch (error) {
    console.error(`[ERROR] Failed to delete expense: ${error.message}`);
    return false;
  }
}

async function handleExpense(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  const lockKey = `lock:${from}`;
  let reply;

  try {
    // Default expense data structure
    const defaultData = { 
      date: new Date().toISOString().split('T')[0], 
      item: "Unknown", 
      amount: "$0.00", 
      store: "Unknown Store" 
    };

    // Check for pending expense or delete confirmation
    const pendingState = await getPendingTransactionState(from);
    if (pendingState?.pendingExpense || pendingState?.pendingDelete?.type === 'expense') {
      if (!isOwner) {
        await deletePendingTransactionState(from);
        reply = "⚠️ Only the owner can manage expenses.";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (not owner)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      const lcInput = input.toLowerCase();
      if (lcInput === 'yes') {
        if (pendingState.pendingExpense) {
          const data = pendingState.pendingExpense;
          const category = data.suggestedCategory || await categorizeEntry('expense', data, ownerProfile);
          reply = await appendToUserSpreadsheet(ownerId, [
            data.date, 
            data.item, 
            data.amount, 
            data.store, 
            await getActiveJob(ownerId) || "Uncategorized", 
            'expense', 
            category, 
            '', 
            userProfile.name || 'Unknown User'
          ]);
          await db.collection('users').doc(ownerId).collection('expenses').add({
            date: data.date,
            item: data.item,
            amount: parseFloat(data.amount.replace(/[^0-9.]/g, '')),
            store: data.store,
            job: await getActiveJob(ownerId) || "Uncategorized",
            category,
            createdAt: new Date().toISOString()
          });
          await deletePendingTransactionState(from);
          await db.collection('locks').doc(lockKey).delete();
          console.log(`[LOCK] Released lock for ${from} (expense confirmed and logged)`);
          return res.send(`<Response><Message>${reply} (Category: ${category})</Message></Response>`);
        } else if (pendingState.pendingDelete?.type === 'expense') {
          const success = await deleteExpenseInSheets(ownerId, pendingState.pendingDelete);
          reply = success
            ? `✅ Expense entry deleted: ${pendingState.pendingDelete.amount} for ${pendingState.pendingDelete.item} from ${pendingState.pendingDelete.store}.`
            : `⚠️ Expense entry not found or deletion failed.`;
          await deletePendingTransactionState(from);
          await db.collection('locks').doc(lockKey).delete();
          console.log(`[LOCK] Released lock for ${from} (expense deleted)`);
          return res.send(`<Response><Message>${reply}</Message></Response>`);
        }
      } else if (lcInput === 'no' || lcInput === 'cancel') {
        await deletePendingTransactionState(from);
        reply = "❌ Operation cancelled.";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (operation cancelled)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else if (lcInput === 'edit') {
        reply = "✏️ Okay, please resend the correct expense details.";
        await setPendingTransactionState(from, { isEditing: true, type: 'expense' });
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (expense edit)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else {
        const errors = detectErrors(pendingState.pendingExpense || pendingState.pendingDelete, 'expense');
        const category = pendingState.pendingExpense ? await categorizeEntry('expense', pendingState.pendingExpense, ownerProfile) : 'N/A';
        if (errors && pendingState.pendingExpense) {
          const corrections = await correctErrorsWithAI(errors);
          if (corrections) {
            await setPendingTransactionState(from, {
              pendingExpense: pendingState.pendingExpense,
              pendingCorrection: true,
              suggestedCorrections: corrections,
              type: 'expense'
            });
            const correctionText = Object.entries(corrections).map(([k, v]) => `${k}: ${(pendingState.pendingExpense || pendingState.pendingDelete)[k] || 'missing'} → ${v}`).join('\n');
            reply = `🤔 Issues detected:\n${correctionText}\nReply 'yes' to accept, 'no' to cancel, or 'edit' to resend.\nSuggested Category: ${category}`;
          } else {
            reply = `⚠️ Please respond with 'yes', 'no', or 'edit' to proceed.\nSuggested Category: ${category}`;
          }
        } else {
          reply = `⚠️ Please respond with 'yes', 'no', or 'edit' to proceed.`;
        }
        const sent = await sendTemplateMessage(
          from,
          confirmationTemplates.expense,
          { "1": pendingState.pendingExpense 
              ? `Expense: ${pendingState.pendingExpense.amount} for ${pendingState.pendingExpense.item} from ${pendingState.pendingExpense.store} on ${pendingState.pendingExpense.date}`
              : `Delete expense: ${pendingState.pendingDelete.amount} for ${pendingState.pendingDelete.item} from ${pendingState.pendingDelete.store}` }
        );
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (pending expense/delete clarification)`);
        return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>${reply}</Message></Response>`);
      }
    }

    // Handle delete expense command
    if (input.toLowerCase().startsWith('delete expense') || input.toLowerCase().startsWith('remove expense')) {
      if (!isOwner) {
        reply = "⚠️ Only the owner can delete expense entries.";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (not owner)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      const deleteRequest = await parseDeleteRequest(input);
      if (deleteRequest.type !== 'expense') {
        reply = `⚠️ Invalid delete request. Try: 'delete expense $100 tools from Home Depot'`;
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (invalid delete request)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      const criteria = deleteRequest.criteria;
      if (!criteria.item || !criteria.amount || !criteria.store) {
        reply = `⚠️ Please specify item, amount, and store. Try: 'delete expense $100 tools from Home Depot'`;
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (missing criteria)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      await setPendingTransactionState(from, { pendingDelete: { type: 'expense', ...criteria } });
      const sent = await sendTemplateMessage(from, confirmationTemplates.deleteConfirmation, [
        { type: "text", text: `Are you sure you want to delete expense '${criteria.amount} for ${criteria.item} from ${criteria.store}'? Reply 'yes' or 'no'.` }
      ]);
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (delete expense prompt)`);
      return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>Are you sure you want to delete expense '${criteria.amount} for ${criteria.item} from ${criteria.store}'? Reply 'yes' or 'no'.</Message></Response>`);
    }

    // Handle industry onboarding if not set
    if (!userProfile.industry) {
      await setPendingTransactionState(from, { pendingIndustry: true });
      reply = "Please provide your industry (e.g., Construction, Freelancer).";
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (industry onboarding)`);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }
    if (pendingState?.pendingIndustry) {
      if (!input) {
        reply = "Please provide your industry (e.g., Construction, Freelancer).";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (invalid industry)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
      userProfile.industry = input;
      await saveUserProfile(userProfile);
      reply = `Got it, ${userProfile.name}! Industry set to ${input}. Now, let’s log that expense.`;
      await deletePendingTransactionState(from);
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (industry set)`);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // Quick match for simple expense input
    const expenseMatch = input.match(/^(?:expense\s+)?\$?(\d+(?:\.\d{1,2})?)\s+(.+?)(?:\s+from\s+(.+))?$/i);
    if (expenseMatch) {
      const [, amount, item, store] = expenseMatch;
      const date = new Date().toISOString().split('T')[0];
      const activeJob = await getActiveJob(ownerId) || "Uncategorized";
      const data = { date, item, amount: `$${parseFloat(amount).toFixed(2)}`, store: store || 'Unknown Store' };
      const category = await categorizeEntry('expense', data, ownerProfile);
      data.suggestedCategory = category;
      reply = await appendToUserSpreadsheet(ownerId, [
        date, 
        item, 
        data.amount, 
        store || 'Unknown Store', 
        activeJob, 
        'expense', 
        category, 
        '', 
        userProfile.name || 'Unknown User'
      ]);
      await db.collection('users').doc(ownerId).collection('expenses').add({
        date,
        item,
        amount: parseFloat(amount),
        store: store || 'Unknown Store',
        job: activeJob,
        category,
        createdAt: new Date().toISOString()
      });
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (quick expense logged)`);
      return res.send(`<Response><Message>${reply} (Category: ${category})</Message></Response>`);
    }

    // Parse expense input with AI
    const { data, reply: aiReply, confirmed } = await handleInputWithAI(from, input, 'expense', parseExpenseMessage, defaultData);
    if (aiReply) {
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (expense AI reply)`);
      return res.send(`<Response><Message>${aiReply}</Message></Response>`);
    }

    if (data && data.amount && data.amount !== "$0.00" && data.item && data.store) {
      const errors = detectErrors(data, 'expense');
      const category = await categorizeEntry('expense', data, ownerProfile);
      data.suggestedCategory = category;
      if (errors) {
        const corrections = await correctErrorsWithAI(errors);
        if (corrections) {
          await setPendingTransactionState(from, {
            pendingExpense: data,
            pendingCorrection: true,
            suggestedCorrections: corrections,
            type: 'expense'
          });
          const correctionText = Object.entries(corrections).map(([k, v]) => `${k}: ${data[k] || 'missing'} → ${v}`).join('\n');
          reply = `🤔 Issues detected:\n${correctionText}\nReply 'yes' to accept, 'no' to cancel, or 'edit' to resend.\nSuggested Category: ${category}`;
          await db.collection('locks').doc(lockKey).delete();
          console.log(`[LOCK] Released lock for ${from} (expense correction)`);
          return res.send(`<Response><Message>${reply}</Message></Response>`);
        }
      }
      if (confirmed) {
        reply = await appendToUserSpreadsheet(ownerId, [
          data.date, 
          data.item, 
          data.amount, 
          data.store, 
          await getActiveJob(ownerId) || "Uncategorized", 
          'expense', 
          category, 
          '', 
          userProfile.name || 'Unknown User'
        ]);
        await db.collection('users').doc(ownerId).collection('expenses').add({
          date: data.date,
          item: data.item,
          amount: parseFloat(data.amount.replace(/[^0-9.]/g, '')),
          store: data.store,
          job: await getActiveJob(ownerId) || "Uncategorized",
          category,
          createdAt: new Date().toISOString()
        });
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (expense logged)`);
        return res.send(`<Response><Message>${reply} (Category: ${category})</Message></Response>`);
      } else {
        await setPendingTransactionState(from, { pendingExpense: { ...data, suggestedCategory: category }, type: 'expense' });
        const sent = await sendTemplateMessage(from, confirmationTemplates.expense, {
          "1": `Expense: ${data.amount} for ${data.item} from ${data.store} on ${data.date} (Category: ${category})`
        });
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (expense confirmation)`);
        return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>⚠️ Failed to send expense confirmation.</Message></Response>`);
      }
    }

    reply = `🤔 Couldn’t parse a valid expense from "${input}". Try "expense $100 tools from Home Depot".`;
    await db.collection('locks').doc(lockKey).delete();
    console.log(`[LOCK] Released lock for ${from} (invalid expense)`);
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  } catch (err) {
    console.error(`Error in handleExpense: ${err.message}`);
    await db.collection('locks').doc(lockKey).delete();
    console.log(`[LOCK] Released lock for ${from} (error)`);
    return res.send(`<Response><Message>⚠️ Failed to process expense: ${err.message}</Message></Response>`);
  }
}

module.exports = { handleExpense, deleteExpenseInSheets };