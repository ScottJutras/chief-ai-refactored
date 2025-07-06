const { appendToUserSpreadsheet, getActiveJob } = require('../../services/postgres.js');
const { categorizeEntry } = require('../../services/openAI');
const { sendTemplateMessage } = require('../../services/twilio');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('../../utils/stateManager');
const { handleInputWithAI, detectErrors, correctErrorsWithAI } = require('../../utils/aiErrorHandler');
const { google } = require('googleapis');
const { getAuthorizedClient } = require('../../services/postgres.js');
const { db } = require('../../services/firebase');
const { confirmationTemplates } = require('../../config');

/**
 * Updates an existing bill in the user's Google Sheet.
 * @param {string} ownerId - The owner's user ID.
 * @param {Object} billData - The bill data to update (billName, amount, dueDate, recurrence).
 * @returns {Promise<boolean>} Success status.
 */
async function updateBillInSheets(ownerId, billData) {
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
    const billIndex = rows.findIndex(row => row[1] === billData.billName && row[5] === 'bill');
    if (billIndex === -1) return false;

    const updatedRow = [
      billData.date || rows[billIndex][0],
      billData.billName,
      billData.amount || rows[billIndex][2],
      billData.recurrence || rows[billIndex][3],
      rows[billIndex][4],
      'bill',
      rows[billIndex][6] || 'Miscellaneous',
      rows[billIndex][7] || '',
      rows[billIndex][8] || userProfile.data().name || 'Unknown User'
    ];
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Sheet1!A${billIndex + 1}:I${billIndex + 1}`,
      valueInputOption: 'RAW',
      resource: { values: [updatedRow] }
    });
    return true;
  } catch (error) {
    console.error(`[ERROR] Failed to update bill: ${error.message}`);
    return false;
  }
}

/**
 * Deletes a bill from the user's Google Sheet.
 * @param {string} ownerId - The owner's user ID.
 * @param {string} billName - The name of the bill to delete.
 * @returns {Promise<boolean>} Success status.
 */
async function deleteBillInSheets(ownerId, billName) {
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
    const billIndex = rows.findIndex(row => row[1] === billName && row[5] === 'bill');
    if (billIndex === -1) return false;

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Sheet1!A${billIndex + 1}:I${billIndex + 1}`,
      valueInputOption: 'RAW',
      resource: { values: [[]] }
    });
    return true;
  } catch (error) {
    console.error(`[ERROR] Failed to delete bill: ${error.message}`);
    return false;
  }
}

async function handleBill(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  const lockKey = `lock:${from}`;
  let reply;

  try {
    // Check for pending state
    const pendingState = await getPendingTransactionState(from);
    if (pendingState && (pendingState.pendingBill || pendingState.pendingDelete?.type === 'bill')) {
      if (!isOwner) {
        await deletePendingTransactionState(from);
        reply = "⚠️ Only the owner can manage bills.";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (not owner)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      if (input.toLowerCase() === 'yes') {
        if (pendingState.pendingBill) {
          const { date, billName, amount, recurrence } = pendingState.pendingBill;
          const category = pendingState.pendingBill.suggestedCategory || await categorizeEntry('bill', pendingState.pendingBill, ownerProfile);
          const activeJob = await getActiveJob(ownerId) || "Uncategorized";
          await appendToUserSpreadsheet(ownerId, [
            date,
            billName,
            amount,
            recurrence,
            activeJob,
            'bill',
            category,
            '',
            userProfile.name || 'Unknown User'
          ]);
          // Store in Firestore for income goal calculations
          await db.collection('users').doc(ownerId).collection('bills').add({
            billName,
            amount: parseFloat(amount.replace(/[^0-9.]/g, '')),
            recurrence,
            category,
            date,
            createdAt: new Date().toISOString()
          });
          reply = `✅ Bill logged: ${amount} for ${billName} (${recurrence}, Category: ${category})`;
        } else if (pendingState.pendingDelete?.type === 'bill') {
          const success = await deleteBillInSheets(ownerId, pendingState.pendingDelete.billName);
          if (success) {
            await db.collection('users').doc(ownerId).collection('bills')
              .where('billName', '==', pendingState.pendingDelete.billName)
              .get()
              .then(snapshot => snapshot.forEach(doc => doc.ref.delete()));
            reply = `✅ Bill "${pendingState.pendingDelete.billName}" deleted.`;
          } else {
            reply = `⚠️ Bill "${pendingState.pendingDelete.billName}" not found or deletion failed.`;
          }
        }
        await deletePendingTransactionState(from);
      } else if (input.toLowerCase() === 'no' || input.toLowerCase() === 'cancel') {
        await deletePendingTransactionState(from);
        reply = "❌ Operation cancelled.";
      } else if (input.toLowerCase() === 'edit') {
        reply = "✏️ Okay, please resend the correct bill details.";
        await setPendingTransactionState(from, { isEditing: true, type: 'bill' });
      } else {
        const errors = detectErrors(pendingState.pendingBill || pendingState.pendingDelete, 'bill');
        const category = pendingState.pendingBill ? await categorizeEntry('bill', pendingState.pendingBill, ownerProfile) : 'N/A';
        if (errors && pendingState.pendingBill) {
          const corrections = await correctErrorsWithAI(errors);
          if (corrections) {
            await setPendingTransactionState(from, {
              pendingBill: { ...pendingState.pendingBill, suggestedCategory: category },
              pendingCorrection: true,
              suggestedCorrections: corrections,
              type: 'bill'
            });
            const correctionText = Object.entries(corrections).map(([k, v]) => `${k}: ${(pendingState.pendingBill || pendingState.pendingDelete)[k] || 'missing'} → ${v}`).join('\n');
            reply = `🤔 Issues detected:\n${correctionText}\nReply 'yes' to accept, 'no' to edit, or 'cancel' to discard.\nSuggested Category: ${category}`;
          } else {
            reply = `⚠️ Please respond with 'yes', 'no', 'edit', or 'cancel' to proceed.\nSuggested Category: ${category}`;
          }
        } else {
          reply = `⚠️ Please respond with 'yes', 'no', 'edit', or 'cancel' to proceed.`;
        }
        const sent = await sendTemplateMessage(
          from,
          confirmationTemplates.bill,
          { "1": `Please confirm: ${pendingState.pendingBill ? `Bill "${pendingState.pendingBill.billName}" for ${pendingState.pendingBill.amount} (${pendingState.pendingBill.recurrence})` : `Delete bill "${pendingState.pendingDelete.billName}"`}` }
        );
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (pending bill/delete confirmation)`);
        return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>${reply}</Message></Response>`);
      }
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (pending state processed)`);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // Parse input for new bill operations
    if (input.toLowerCase().startsWith("edit bill ")) {
      if (!isOwner) {
        reply = "⚠️ Only the owner can edit bills.";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (not owner)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      const match = input.match(/edit bill\s+(.+?)(?:\s+amount\s+(\$?\d+\.?\d*))?(?:\s+due\s+(.+?))?(?:\s+(yearly|monthly|weekly|bi-weekly|one-time))?/i);
      if (!match) {
        reply = "⚠️ Format: 'edit bill [name] amount $[X] due [date] [recurrence]' (e.g., 'edit bill Rent amount $600 due June 1st monthly')";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (invalid edit format)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      const [, billName, amount, dueDate, recurrence] = match;
      const billData = {
        billName,
        date: new Date().toISOString().split('T')[0],
        amount: amount ? `$${parseFloat(amount.replace('$', '')).toFixed(2)}` : null,
        dueDate: dueDate || null,
        recurrence: recurrence || null
      };
      const success = await updateBillInSheets(ownerId, billData);
      if (success) {
        await db.collection('users').doc(ownerId).collection('bills')
          .where('billName', '==', billName)
          .get()
          .then(snapshot => snapshot.forEach(doc => doc.ref.update({
            amount: billData.amount || doc.data().amount,
            dueDate: billData.dueDate || doc.data().dueDate,
            recurrence: billData.recurrence || doc.data().recurrence,
            updatedAt: new Date().toISOString()
          })));
        reply = `✅ Bill "${billName}" updated${amount ? ` to ${billData.amount}` : ''}${dueDate ? ` due ${dueDate}` : ''}${recurrence ? ` (${recurrence})` : ''}.`;
      } else {
        reply = `⚠️ Bill "${billName}" not found or update failed.`;
      }
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (edit bill processed)`);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    } else if (input.toLowerCase().startsWith("delete bill ")) {
      if (!isOwner) {
        reply = "⚠️ Only the owner can delete bills.";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (not owner)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      const billName = input.replace(/^delete bill\s+/i, '').trim();
      if (!billName) {
        reply = "⚠️ Please provide a bill name. Try: 'delete bill Truck Payment'";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (invalid bill name)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      await setPendingTransactionState(from, { pendingDelete: { type: 'bill', billName } });
      const sent = await sendTemplateMessage(from, confirmationTemplates.deleteConfirmation, [
        { type: "text", text: `Are you sure you want to delete bill '${billName}'? Reply 'yes' or 'no'.` }
      ]);
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (delete bill prompt)`);
      return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>Are you sure you want to delete bill '${billName}'? Reply 'yes' or 'no'.</Message></Response>`);
    } else if (input.toLowerCase().includes("bill") && !input.toLowerCase().includes("delete")) {
      const billMatch = input.match(/^bill\s+(.+?)\s+\$?(\d+(?:\.\d{1,2})?)\s+(yearly|monthly|weekly|bi-weekly|one-time)$/i);
      if (billMatch) {
        const [, billName, amount, recurrence] = billMatch;
        const date = new Date().toISOString().slice(0, 10);
        const activeJob = await getActiveJob(ownerId) || "Uncategorized";
        const validRecurrences = ['yearly', 'monthly', 'weekly', 'bi-weekly', 'one-time'];
        if (!validRecurrences.includes(recurrence.toLowerCase())) {
          reply = `⚠️ Invalid recurrence. Use: yearly, monthly, weekly, bi-weekly, or one-time.`;
          await db.collection('locks').doc(lockKey).delete();
          console.log(`[LOCK] Released lock for ${from} (invalid recurrence)`);
          return res.send(`<Response><Message>${reply}</Message></Response>`);
        }
        const category = await categorizeEntry('bill', { billName, amount, recurrence, date }, ownerProfile);
        const pendingBill = { date, billName, amount: `$${parseFloat(amount).toFixed(2)}`, recurrence, suggestedCategory: category };
        await setPendingTransactionState(from, { pendingBill });
        const currency = userProfile.country === 'United States' ? 'USD' : 'CAD';
        const sent = await sendTemplateMessage(from, confirmationTemplates.bill, {
          "1": `Please confirm: Bill "${billName}" for ${currency} ${pendingBill.amount} (${recurrence})`
        });
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (bill confirmation)`);
        return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>⚠️ Failed to send bill confirmation.</Message></Response>`);
      } else {
        // AI-assisted parsing for complex bill inputs
        const defaultData = { date: new Date().toISOString().split('T')[0], billName: "Unknown", amount: "$0.00", recurrence: "one-time", dueDate: "Unknown" };
        const { data, reply: aiReply, confirmed } = await handleInputWithAI(
          from,
          input,
          'bill',
          (input) => {
            const billRegex = /bill\s+([\w\s]+)\s+\$([\d,]+(?:\.\d{1,2})?)\s+(?:per\s+)?(\w+)?\s*(?:on|due)\s+([\w\d\s,-]+)/i;
            const match = input.match(billRegex);
            if (match) {
              return {
                date: new Date().toISOString().split('T')[0],
                billName: match[1].trim(),
                amount: `$${parseFloat(match[2].replace(/,/g, '')).toFixed(2)}`,
                recurrence: match[3] ? (match[3].toLowerCase() === "month" ? "monthly" : match[3].toLowerCase()) : "one-time",
                dueDate: match[4].trim()
              };
            }
            return null;
          },
          defaultData
        );

        if (aiReply) {
          await db.collection('locks').doc(lockKey).delete();
          console.log(`[LOCK] Released lock for ${from} (AI reply)`);
          return res.send(`<Response><Message>${aiReply}</Message></Response>`);
        }

        if (data && data.billName && data.amount && data.amount !== "$0.00" && data.recurrence) {
          const validRecurrences = ['yearly', 'monthly', 'weekly', 'bi-weekly', 'one-time'];
          if (!validRecurrences.includes(data.recurrence.toLowerCase())) {
            reply = `⚠️ Invalid recurrence. Use: yearly, monthly, weekly, bi-weekly, or one-time.`;
            await db.collection('locks').doc(lockKey).delete();
            console.log(`[LOCK] Released lock for ${from} (invalid recurrence)`);
            return res.send(`<Response><Message>${reply}</Message></Response>`);
          }
          const refinedDueDate = data.dueDate.match(/(\w+)\s+(\d{1,2}),?\s*(\d{4})/i)
            ? `${data.dueDate.match(/(\w+)/)[1]} ${parseInt(data.dueDate.match(/(\d{1,2})/)[1]) === 1 ? "1st" : "2nd"}`
            : data.dueDate;
          const category = await categorizeEntry('bill', data, ownerProfile);
          await setPendingTransactionState(from, { pendingBill: { ...data, dueDate: refinedDueDate, suggestedCategory: category } });
          const currency = userProfile.country === 'United States' ? 'USD' : 'CAD';
          const sent = await sendTemplateMessage(from, confirmationTemplates.bill, {
            "1": `Please confirm: Bill "${data.billName}" for ${currency} ${data.amount} (${data.recurrence}, due ${refinedDueDate})`
          });
          await db.collection('locks').doc(lockKey).delete();
          console.log(`[LOCK] Released lock for ${from} (AI bill confirmation)`);
          return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>⚠️ Failed to send bill confirmation.</Message></Response>`);
        }

        reply = `🤔 Couldn’t parse a valid bill from "${input}". Try "bill Truck Payment $760 monthly".`;
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (invalid bill)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
    } else {
      reply = `⚠️ Invalid bill command. Try: 'bill Truck Payment $760 monthly', 'edit bill Rent amount $600 due June 1st monthly', or 'delete bill Truck Payment'.`;
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (invalid command)`);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }
  } catch (err) {
    console.error(`Error in handleBill: ${err.message}`);
    await db.collection('locks').doc(lockKey).delete();
    console.log(`[LOCK] Released lock for ${from} (error)`);
    return res.send(`<Response><Message>⚠️ Failed to process bill command: ${err.message}</Message></Response>`);
  }
}

module.exports = { handleBill, updateBillInSheets, deleteBillInSheets };