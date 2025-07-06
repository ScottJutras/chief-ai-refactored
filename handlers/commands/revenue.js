const { appendToUserSpreadsheet, getActiveJob, saveUserProfile } = require('../../services/postgres.js');
const { parseRevenueMessage, handleInputWithAI } = require('../../utils/aiErrorHandler');
const { categorizeEntry } = require('../../services/openAI');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('../../utils/stateManager');
const { sendTemplateMessage } = require('../../services/twilio');
const { getTaxRate } = require('../../utils/taxRate');
const { db } = require('../../services/firebase');
const { confirmationTemplates } = require('../../config');

/**
 * Deletes a revenue entry from the user's Google Sheet.
 * @param {string} ownerId - The owner's user ID.
 * @param {Object} criteria - The criteria to identify the revenue entry (e.g., { amount, source, date }).
 * @returns {Promise<boolean>} Success status.
 */
async function deleteRevenueInSheets(ownerId, criteria) {
  try {
    const userProfile = await db.collection('users').doc(ownerId).get();
    const spreadsheetId = userProfile.data().spreadsheetId;
    const auth = await getAuthorizedClient();
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Revenue!A:I'
    });
    const rows = response.data.values || [];
    const revenueIndex = rows.findIndex(row => 
      row[5] === 'revenue' &&
      (!criteria.amount || row[2] === `$${parseFloat(criteria.amount).toFixed(2)}`) &&
      (!criteria.source || row[3] === criteria.source) &&
      (!criteria.date || row[0] === criteria.date)
    );
    if (revenueIndex === -1) return false;

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Revenue!A${revenueIndex + 1}:I${revenueIndex + 1}`,
      valueInputOption: 'RAW',
      resource: { values: [[]] }
    });
    return true;
  } catch (error) {
    console.error(`[ERROR] Failed to delete revenue: ${error.message}`);
    return false;
  }
}

async function handleRevenue(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  const lockKey = `lock:${from}`;
  let reply;

  try {
    // Default revenue data structure
    const defaultData = { 
      date: new Date().toISOString().split('T')[0], 
      description: "Payment", 
      amount: "$0.00", 
      source: "Unknown Client" 
    };

    // Check for pending revenue or delete confirmation
    const pendingState = await getPendingTransactionState(from);
    if (pendingState?.pendingRevenue || pendingState?.pendingDelete?.type === 'revenue') {
      const lcInput = input.toLowerCase();
      if (lcInput === 'yes') {
        if (pendingState.pendingRevenue) {
          const data = pendingState.pendingRevenue;
          const category = data.suggestedCategory || await categorizeEntry('revenue', data, ownerProfile);
          const taxRate = getTaxRate(userProfile.country, userProfile.province);
          const amount = parseFloat(data.amount.replace(/[^0-9.]/g, ''));
          const taxAmount = amount * taxRate;
          const currency = userProfile.country === 'United States' ? 'USD' : 'CAD';
          const activeJob = await getActiveJob(ownerId) || "Uncategorized";
          reply = await appendToUserSpreadsheet(ownerId, [
            data.date, 
            data.description, 
            data.amount, 
            data.source || data.client, 
            activeJob, 
            'revenue', 
            category, 
            '', 
            userProfile.name || 'Unknown User'
          ]);
          // Store in Firestore for analytics
          await db.collection('users').doc(ownerId).collection('revenues').add({
            date: data.date,
            description: data.description,
            amount,
            source: data.source || data.client,
            job: activeJob,
            category,
            createdAt: new Date().toISOString()
          });
          reply += `. Tax: ${currency} ${taxAmount.toFixed(2)} (${(taxRate * 100).toFixed(2)}%)`;
          await deletePendingTransactionState(from);
          await db.collection('locks').doc(lockKey).delete();
          console.log(`[LOCK] Released lock for ${from} (revenue confirmed and logged)`);
          return res.send(`<Response><Message>${reply} (Category: ${category})</Message></Response>`);
        } else if (pendingState.pendingDelete?.type === 'revenue') {
          const success = await deleteRevenueInSheets(ownerId, pendingState.pendingDelete);
          if (success) {
            await db.collection('users').doc(ownerId).collection('revenues')
              .where('amount', '==', parseFloat(pendingState.pendingDelete.amount))
              .where('source', '==', pendingState.pendingDelete.source)
              .where('date', '==', pendingState.pendingDelete.date)
              .get()
              .then(snapshot => snapshot.forEach(doc => doc.ref.delete()));
            reply = `✅ Revenue entry deleted: ${pendingState.pendingDelete.amount} from ${pendingState.pendingDelete.source}.`;
          } else {
            reply = `⚠️ Revenue entry not found or deletion failed.`;
          }
          await deletePendingTransactionState(from);
          await db.collection('locks').doc(lockKey).delete();
          console.log(`[LOCK] Released lock for ${from} (revenue deleted)`);
          return res.send(`<Response><Message>${reply}</Message></Response>`);
        }
      } else if (lcInput === 'no' || lcInput === 'cancel') {
        await deletePendingTransactionState(from);
        reply = "❌ Operation cancelled.";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (operation cancelled)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else {
        reply = `⚠️ Please reply with 'yes' or 'no' to confirm or cancel the ${pendingState.pendingRevenue ? 'revenue entry' : 'revenue deletion'}.`;
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (pending revenue/delete clarification)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
    }

    // Handle delete revenue command
    if (input.toLowerCase().startsWith('delete revenue') || input.toLowerCase().startsWith('remove revenue')) {
      if (!isOwner) {
        reply = "⚠️ Only the owner can delete revenue entries.";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (not owner)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      const { parseDeleteRequest } = require('../../services/openAI');
      const deleteRequest = await parseDeleteRequest(input);
      if (deleteRequest.type !== 'revenue') {
        reply = `⚠️ Invalid delete request. Try: 'delete revenue $100 from John'`;
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (invalid delete request)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      const criteria = deleteRequest.criteria;
      if (!criteria.amount || !criteria.source) {
        reply = `⚠️ Please specify amount and source. Try: 'delete revenue $100 from John'`;
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (missing criteria)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      await setPendingTransactionState(from, { pendingDelete: { type: 'revenue', ...criteria } });
      const sent = await sendTemplateMessage(from, confirmationTemplates.deleteConfirmation, [
        { type: "text", text: `Are you sure you want to delete revenue '${criteria.amount} from ${criteria.source}'? Reply 'yes' or 'no'.` }
      ]);
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (delete revenue prompt)`);
      return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>Are you sure you want to delete revenue '${criteria.amount} from ${criteria.source}'? Reply 'yes' or 'no'.</Message></Response>`);
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
      reply = `Got it, ${userProfile.name}! Industry set to ${input}. Now, let’s log that revenue.`;
      await deletePendingTransactionState(from);
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (industry set)`);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // Handle goal onboarding if not set
    if (!userProfile.goal) {
      await setPendingTransactionState(from, { pendingGoal: true });
      reply = "What’s your financial goal? (e.g., Grow profit by $10,000, Pay off $5,000 debt)";
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (goal onboarding)`);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }
    if (pendingState?.pendingGoal) {
      if (!input.match(/\d+/) || (!input.toLowerCase().includes('profit') && !input.toLowerCase().includes('debt'))) {
        reply = "⚠️ That doesn’t look like a goal. Try 'Grow profit by $10,000' or 'Pay off stressing debt by $5,000'.'";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (invalid goal)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
      userProfile.goal = input;
      userProfile.goalProgress = { 
        target: input.toLowerCase().includes('debt') 
          ? -parseFloat(input.match(/\d+/)?.[0] || 5000) * 1000 
          : parseFloat(input.match(/\d+/)?.[0] || 10000) * 1000, 
        current: 0 
      };
      await saveUserProfile(userProfile);
      const currency = userProfile.country === 'United States' ? 'USD' : 'CAD';
      reply = `Goal locked in: "${input}" (${currency} ${userProfile.goalProgress.target.toFixed(2)}). You’re unstoppable, ${userProfile.name}! Now, let’s log that revenue.`;
      await deletePendingTransactionState(from);
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (goal set)`);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // Quick match for simple revenue input
    const revenueMatch = input.match(/^(?:revenue\s+)?(?:received\s+)?\$?(\d+(?:\.\d{1,2})?)\s+(?:from\s+)?(.+)/i);
    if (revenueMatch) {
      const [, amount, source] = revenueMatch;
      const date = new Date().toISOString().split('T')[0];
      const activeJob = await getActiveJob(ownerId) || "Uncategorized";
      const data = { date, description: source, amount: `$${parseFloat(amount).toFixed(2)}`, source };
      const category = await categorizeEntry('revenue', data, ownerProfile);
      const taxRate = getTaxRate(userProfile.country, userProfile.province);
      const parsedAmount = parseFloat(amount);
      const taxAmount = parsedAmount * taxRate;
      const currency = userProfile.country === 'United States' ? 'USD' : 'CAD';

      reply = await appendToUserSpreadsheet(ownerId, [
        date, 
        source, 
        data.amount, 
        source, 
        activeJob, 
        'revenue', 
        category, 
        '', 
        userProfile.name || 'Unknown User'
      ]);
      await db.collection('users').doc(ownerId).collection('revenues').add({
        date,
        description: source,
        amount: parsedAmount,
        source,
        job: activeJob,
        category,
        createdAt: new Date().toISOString()
      });
      reply += `. Tax: ${currency} ${taxAmount.toFixed(2)} (${(taxRate * 100).toFixed(2)}%)`;
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (quick revenue logged)`);
      return res.send(`<Response><Message>${reply} (Category: ${category})</Message></Response>`);
    }

    // Parse revenue input with AI
    const { data, reply: aiReply, confirmed } = await handleInputWithAI(from, input, 'revenue', parseRevenueMessage, defaultData);
    if (aiReply) {
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (revenue AI reply)`);
      return res.send(`<Response><Message>${aiReply}</Message></Response>`);
    }

    if (data && data.amount && data.amount !== "$0.00" && (data.source || data.client)) {
      const category = await categorizeEntry('revenue', data, ownerProfile);
      const taxRate = getTaxRate(userProfile.country, userProfile.province);
      const amount = parseFloat(data.amount.replace(/[^0-9.]/g, ''));
      const taxAmount = amount * taxRate;
      const currency = userProfile.country === 'United States' ? 'USD' : 'CAD';
      data.suggestedCategory = category;

      if (confirmed) {
        reply = await appendToUserSpreadsheet(ownerId, [
          data.date, 
          data.description, 
          data.amount, 
          data.source || data.client, 
          await getActiveJob(ownerId) || "Uncategorized", 
          'revenue', 
          category, 
          '', 
          userProfile.name || 'Unknown User'
        ]);
        await db.collection('users').doc(ownerId).collection('revenues').add({
          date: data.date,
          description: data.description,
          amount,
          source: data.source || data.client,
          job: await getActiveJob(ownerId) || "Uncategorized",
          category,
          createdAt: new Date().toISOString()
        });
        reply += `. Tax: ${currency} ${taxAmount.toFixed(2)} (${(taxRate * 100).toFixed(2)}%)`;
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (revenue logged)`);
        return res.send(`<Response><Message>${reply} (Category: ${category})</Message></Response>`);
      } else {
        await setPendingTransactionState(from, { pendingRevenue: { ...data, suggestedCategory: category } });
        const sent = await sendTemplateMessage(from, confirmationTemplates.revenue, {
          "1": `Revenue: ${currency} ${amount.toFixed(2)} from ${data.source || data.client} on ${data.date} (Category: ${category})`
        });
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (pending revenue)`);
        return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>⚠️ Failed to send revenue confirmation.</Message></Response>`);
      }
    }

    reply = `🤔 Couldn’t parse a valid revenue from "${input}". Try "received $100 from John".`;
    await db.collection('locks').doc(lockKey).delete();
    console.log(`[LOCK] Released lock for ${from} (invalid revenue)`);
    return res.send(`<Response><Message>${reply}</Message></Response>`);

  } catch (err) {
    console.error(`Error in handleRevenue: ${err.message}`);
    await db.collection('locks').doc(lockKey).delete();
    console.log(`[LOCK] Released lock for ${from} (error)`);
    return res.send(`<Response><Message>⚠️ Failed to process revenue: ${err.message}</Message></Response>`);
  }
}

module.exports = { handleRevenue, deleteRevenueInSheets };