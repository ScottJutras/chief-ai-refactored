const expenseHandler = require('./expense');
const revenueHandler = require('./revenue');
const billHandler = require('./bill');
const jobHandler = require('./job');
const quoteHandler = require('./quote');
const metricsHandler = require('./metrics');
const taxHandler = require('./tax');
const receiptHandler = require('./receipt');
const teamHandler = require('./team');
const timeclockHandler = require('./timeClock');

async function handleCommands(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  const lockKey = `lock:${from}`;
  let reply;
  try {
    console.log(`[DEBUG] Attempting command processing for ${from}: "${input}"`);
    const lcInput = input.toLowerCase();

    // Check for pending transaction confirmation
    const pendingState = await getPendingTransactionState(from);
    if (pendingState && (pendingState.pendingExpense || pendingState.pendingRevenue || pendingState.pendingBill)) {
      const type = pendingState.pendingExpense ? 'expense' : pendingState.pendingRevenue ? 'revenue' : 'bill';
      const pendingData = pendingState.pendingExpense || pendingState.pendingRevenue || pendingState.pendingBill;
      const activeJob = await getActiveJob(ownerId) || "Uncategorized";
      const userName = userProfile.name || 'Unknown User';

      if (lcInput === 'yes') {
        const category = pendingData.suggestedCategory || await categorizeEntry(type, pendingData, ownerProfile);
        if (type === 'expense') {
          await appendToUserSpreadsheet(ownerId, [pendingData.date, pendingData.item, pendingData.amount, pendingData.store, activeJob, 'expense', category, '', userName]);
        } else if (type === 'revenue') {
          await appendToUserSpreadsheet(ownerId, [pendingData.date, pendingData.description, pendingData.amount, pendingData.source || pendingData.client, activeJob, 'revenue', category, '', userName]);
        } else if (type === 'bill') {
          await appendToUserSpreadsheet(ownerId, [pendingData.date, pendingData.billName, pendingData.amount, pendingData.recurrence, activeJob, 'bill', category, '', userName]);
        }
        await deletePendingTransactionState(from);
        reply = `✅ ${type} logged: ${pendingData.amount} ${type === 'expense' ? `for ${pendingData.item} from ${pendingData.store}` : type === 'revenue' ? `from ${pendingData.source || pendingData.client}` : `for ${pendingData.billName}`} on ${pendingData.date} by ${userName} (Category: ${category})`;
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (pending ${type} confirmed)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else if (lcInput === 'no' || lcInput === 'edit') {
        reply = "✏️ Okay, please resend the correct details.";
        await setPendingTransactionState(from, { isEditing: true, type });
        await deletePendingTransactionState(from);
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (pending ${type} edit)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else if (lcInput === 'cancel') {
        await deletePendingTransactionState(from);
        reply = "❌ Transaction cancelled.";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (pending ${type} cancelled)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else {
        const errors = detectErrors(pendingData, type);
        const category = await categorizeEntry(type, pendingData, ownerProfile);
        pendingData.suggestedCategory = category;
        if (errors) {
          const corrections = await correctErrorsWithAI(errors);
          if (corrections) {
            await setPendingTransactionState(from, {
              [type === 'expense' ? 'pendingExpense' : type === 'revenue' ? 'pendingRevenue' : 'pendingBill']: pendingData,
              pendingCorrection: true,
              suggestedCorrections: corrections,
              type
            });
            const correctionText = Object.entries(corrections).map(([k, v]) => `${k}: ${pendingData[k] || 'missing'} → ${v}`).join('\n');
            reply = `🤔 Issues detected:\n${correctionText}\nReply 'yes' to accept or 'no' to edit.\nSuggested Category: ${category}`;
            await db.collection('locks').doc(lockKey).delete();
            console.log(`[LOCK] Released lock for ${from} (${type} correction)`);
            return res.send(`<Response><Message>${reply}</Message></Response>`);
          }
        }
        reply = `⚠️ Please respond with 'yes', 'no', 'edit', or 'cancel' to proceed.\nSuggested Category: ${category}`;
        const sent = await sendTemplateMessage(
          from,
          type === 'expense' || type === 'bill' ? confirmationTemplates.expense : confirmationTemplates.revenue,
          { "1": `Please confirm: ${type === 'expense' || type === 'bill' ? `${pendingData.amount} for ${pendingData.item || pendingData.source || pendingData.billName} on ${pendingData.date}` : `Revenue of ${pendingData.amount} from ${pendingData.source} on ${pendingData.date}`} (Category: ${category})` }
        );
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (pending ${type} confirmation)`);
        return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>${reply}</Message></Response>`);
      }
    }

    // Handle delete commands
    if (lcInput.includes("delete") || lcInput.includes("remove")) {
      if (!isOwner) {
        reply = "⚠️ Only the owner can delete entries.";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (not owner)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
      console.log("[DEBUG] Detected delete request:", input);

      const auth = await getAuthorizedClient();
      const sheets = google.sheets({ version: 'v4', auth });
      const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const gptResponse = await openaiClient.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: `Parse a delete request: "${input}". Return JSON: { type: 'revenue|expense|job|bill', criteria: { item: 'string|null', amount: 'string|null', date: 'string|null', store: 'string|null', source: 'string|null', billName: 'string|null', jobName: 'string|null' } }. Set unmatched fields to null.` },
          { role: "user", content: input }
        ],
        max_tokens: 150,
        temperature: 0.3
      });
      const deleteRequest = JSON.parse(gptResponse.choices[0].message.content);
      console.log("[DEBUG] Delete request parsed:", deleteRequest);

      let sheetName, range, data;
      if (deleteRequest.type === 'revenue') {
        sheetName = 'Revenue';
        range = 'Revenue!A:F';
      } else {
        sheetName = 'Sheet1';
        range = 'Sheet1!A:I';
      }

      try {
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: ownerProfile.spreadsheetId, range });
        data = (response.data.values || []).slice(1);
      } catch (error) {
        console.error("[ERROR] Failed to fetch data for deletion:", error);
        reply = "⚠️ Could not retrieve your data. Please try again later.";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (delete data fetch error)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      const matches = data.map((row, index) => ({ row, index })).filter(({ row }) => {
        if (deleteRequest.type === 'revenue' && row[5] !== 'revenue') return false;
        if (deleteRequest.type === 'expense' && row[5] !== 'expense') return false;
        if (deleteRequest.type === 'bill' && row[5] !== 'bill') return false;
        if (deleteRequest.type === 'job' && row[4] !== deleteRequest.criteria.jobName) return false;

        const [date, itemOrDesc, amount, storeOrSource] = row;
        return (
          (!deleteRequest.criteria.item || itemOrDesc.toLowerCase().includes(deleteRequest.criteria.item?.toLowerCase())) &&
          (!deleteRequest.criteria.amount || amount.toLowerCase().includes(deleteRequest.criteria.amount?.toLowerCase())) &&
          (!deleteRequest.criteria.date || date.toLowerCase().includes(deleteRequest.criteria.date?.toLowerCase())) &&
          (!deleteRequest.criteria.store || storeOrSource?.toLowerCase().includes(deleteRequest.criteria.store?.toLowerCase())) &&
          (!deleteRequest.criteria.source || storeOrSource?.toLowerCase().includes(deleteRequest.criteria.source?.toLowerCase())) &&
          (!deleteRequest.criteria.billName || itemOrDesc.toLowerCase().includes(deleteRequest.criteria.billName?.toLowerCase())) &&
          (!deleteRequest.criteria.jobName || row[4]?.toLowerCase() === deleteRequest.criteria.jobName?.toLowerCase())
        );
      });

      if (matches.length === 0) {
        reply = `🤔 No ${deleteRequest.type} entries found matching "${input}". Try providing more details.`;
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (no delete matches)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else if (matches.length === 1) {
        const { row, index } = matches[0];
        const [date, itemOrDesc, amount, storeOrSource] = row;
        const summary = `${deleteRequest.type === 'expense' ? `${amount} for ${itemOrDesc} from ${storeOrSource}` : deleteRequest.type === 'revenue' ? `${amount} from ${storeOrSource}` : deleteRequest.type === 'bill' ? `${amount} for ${itemOrDesc}` : `job ${deleteRequest.criteria.jobName}`} on ${date}`;
        await setPendingTransactionState(from, { pendingDelete: { type: deleteRequest.type, rowIndex: index, sheetName } });
        const sent = await sendTemplateMessage(from, confirmationTemplates.deleteConfirmation, {
          "1": `Are you sure you want to delete this ${deleteRequest.type}: ${summary}? Reply 'yes' or 'no'.`
        });
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (delete confirmation)`);
        return sent ? res.send(`<Response></Response>`) : res.send(`<Response><Message>Are you sure you want to delete this ${deleteRequest.type}: ${summary}? Reply 'yes' or 'no'.</Message></Response>`);
      } else {
        reply = `🤔 Found ${matches.length} matching ${deleteRequest.type} entries:\n`;
        matches.slice(0, 3).forEach(({ row }, i) => {
          const [date, itemOrDesc, amount, storeOrSource] = row;
          reply += `${i + 1}. ${date} - ${itemOrDesc} (${amount}) ${storeOrSource ? `from ${storeOrSource}` : ''}\n`;
        });
        if (matches.length > 3) reply += `...and ${matches.length - 3} more. Please refine your request.`;
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (multiple delete matches)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
    }

    // Handle pending delete confirmation
    if (pendingState && pendingState.pendingDelete) {
      if (!isOwner) {
        await deletePendingTransactionState(from);
        reply = "⚠️ Only the owner can delete entries.";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (pending delete not owner)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
      if (lcInput === 'yes') {
        const { type, rowIndex, sheetName } = pendingState.pendingDelete;
        const auth = await getAuthorizedClient();
        const sheets = google.sheets({ version: 'v4', auth });
        await sheets.spreadsheets.values.update({
          spreadsheetId: ownerProfile.spreadsheetId,
          range: `${sheetName}!A${rowIndex + 2}:I${rowIndex + 2}`,
          valueInputOption: 'RAW',
          resource: { values: [[]] }
        });
        reply = `✅ Deleted ${type} entry successfully.`;
        await deletePendingTransactionState(from);
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (pending delete confirmed)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else if (lcInput === 'no' || lcInput === 'cancel') {
        await deletePendingTransactionState(from);
        reply = "❌ Deletion cancelled.";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (pending delete cancelled)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else {
        reply = "⚠️ Please reply with 'yes' or 'no' to confirm deletion.";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (pending delete invalid response)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
    }

    // Check for onboarding triggers
    if (isOnboardingTrigger(input)) {
      console.log(`[INFO] Onboarding trigger detected in quick match for ${from}: input="${input}"`);
      if (userProfile.onboarding_in_progress) {
        reply = "Please respond to the current onboarding question or cancel to restart.";
      } else {
        await db.runTransaction(async (transaction) => {
          const userRef = db.collection('users').doc(from);
          transaction.update(userRef, {
            onboarding_in_progress: true,
            name: admin.firestore.FieldValue.delete(),
            country: admin.firestore.FieldValue.delete(),
            province: admin.firestore.FieldValue.delete(),
            email: admin.firestore.FieldValue.delete(),
            business_province: admin.firestore.FieldValue.delete(),
            business_country: admin.firestore.FieldValue.delete(),
            spreadsheetId: admin.firestore.FieldValue.delete(),
            onboarding_completed: admin.firestore.FieldValue.delete()
          });
        });
        await db.collection('onboarding').doc(from).delete();
        const newState = {
          step: 0,
          responses: {},
          detectedLocation: {
            country: userProfile?.country || "Unknown Country",
            province: userProfile?.province || "Unknown Province"
          }
        };
        await setOnboardingState(from, newState);
        reply = "Welcome! What's your name?";
      }
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (onboarding trigger)`);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // Check for valid commands
    if (isValidCommand(input)) {
      console.error(`[ERROR] Unhandled command in quick match for ${from}: ${input}`);
      reply = `⚠️ Command "${input}" was not processed correctly. Please try again.`;
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (unhandled command)`);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // Check for expense/revenue/bill triggers
    if (!isValidExpenseInput(input)) {
      console.log(`[INFO] Non-expense/revenue/bill input detected in quick match for ${from}: input="${input}"`);
      reply = `🤔 I didn't understand "${input}". Please provide a valid command (e.g., "team", "edit bill", "expense $100 tools") or reply 'start' to begin onboarding.`;
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (invalid input)`);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // Onboarding checks for industry and goal
    let state = await getOnboardingState(from);
    if (!userProfile.industry && input.includes('$') && !state?.dynamicStep) {
      await setOnboardingState(from, { step: 0, responses: {}, dynamicStep: 'industry' });
      reply = "Hey, what industry are you in? (e.g., Construction, Freelancer)";
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (industry onboarding)`);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }
    if (state?.dynamicStep === 'industry') {
      userProfile.industry = input;
      await saveUserProfile(userProfile);
      reply = `Got it, ${userProfile.name}! Industry set to ${input}. Keep logging—next up, I’ll ask your financial goal when you add a bill or revenue.`;
      await deleteOnboardingState(from);
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (industry set)`);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }
    if (!userProfile.goal && (lcInput.includes('bill') || lcInput.includes('revenue')) && !state?.dynamicStep) {
      await setOnboardingState(from, { step: 0, responses: {}, dynamicStep: 'goal' });
      reply = "What’s your financial goal, boss? (e.g., Grow profit by $10,000, Pay off $5,000 debt)";
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (goal onboarding)`);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }
    if (state?.dynamicStep === 'goal') {
      if (!input.match(/\d+/) || (!input.includes('profit') && !input.includes('debt'))) {
        reply = "⚠️ That doesn’t look like a goal. Try 'Grow profit by $10,000' or 'Pay off $5,000 debt'.";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (invalid goal)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
      userProfile.goal = input;
      userProfile.goalProgress = {
        target: input.includes('debt')
          ? -parseFloat(input.match(/\d+/)?.[0] || 5000) * 1000
          : parseFloat(input.match(/\d+/)?.[0] || 10000) * 1000,
        current: 0
      };
      await saveUserProfile(userProfile);
      const currency = userProfile.country === 'United States' ? 'USD' : 'CAD';
      reply = `Goal locked in: "${input}" (${currency} ${userProfile.goalProgress.target.toFixed(2)}). You’re unstoppable, ${userProfile.name}!`;
      await deleteOnboardingState(from);
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (goal set)`);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // Quick match for expense, revenue, bill
    const expenseMatch = input.match(/^(?:expense\s+)?\$?(\d+(?:\.\d{1,2})?)\s+(.+?)(?:\s+from\s+(.+))?$/i);
    const revenueMatch = input.match(/^(?:revenue\s+)?(?:received\s+)?\$?(\d+(?:\.\d{1,2})?)\s+(?:from\s+)?(.+)/i);
    const billMatch = input.match(/^bill\s+(.+?)\s+\$?(\d+(?:\.\d{1,2})?)\s+(yearly|monthly|weekly|bi-weekly|one-time)$/i);

    if (expenseMatch) {
      return await handleExpense(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
    } else if (revenueMatch) {
      return await handleRevenue(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
    } else if (billMatch) {
      return await handleBill(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
    } else if (lcInput.startsWith('start job') || lcInput.startsWith('finish job')) {
      return await handleJob(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
    } else if (lcInput.startsWith('quote')) {
      return await handleQuote(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
    } else if (lcInput.includes('profit') || lcInput.includes('margin') || lcInput.includes('spend') || lcInput.includes('spent') || (lcInput.includes('how about') && (await getLastQuery(from))?.intent)) {
      return await handleMetrics(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
    } else if (lcInput.includes('find receipt') || lcInput.includes('where’s my receipt') || lcInput.includes('show me the receipt')) {
      return await handleReceipt(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
    } else if (lcInput.startsWith('team') || lcInput.includes('add member') || lcInput.includes('remove member')) {
      return await handleTeam(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
    } else if (lcInput.includes('tax rate') || lcInput.startsWith('export tax')) {
      return await handleTax(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
    } else if (lcInput === 'chief!!') {
      reply = '🔥 You’re the boss, Chief! What’s the next move?';
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (chief command)`);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    } else if (lcInput.startsWith('stats')) {
      try {
        const auth = await getAuthorizedClient();
        const sheets = google.sheets({ version: 'v4', auth });
        const expenses = await sheets.spreadsheets.values.get({ spreadsheetId: ownerProfile.spreadsheetId, range: 'Sheet1!A:I' });
        const revenues = await sheets.spreadsheets.values.get({ spreadsheetId: ownerProfile.spreadsheetId, range: 'Revenue!A:I' });
        const expenseData = expenses.data.values?.slice(1).filter(row => row[5] === 'expense') || [];
        const revenueData = revenues.data.values?.slice(1) || [];
        const totalExpenses = expenseData.reduce((sum, row) => sum + parseFloat(row[2].replace(/[^0-9.]/g, '') || 0), 0);
        const totalRevenue = revenueData.reduce((sum, row) => sum + parseFloat(row[2].replace(/[^0-9.]/g, '') || 0), 0);
        const profit = totalRevenue - totalExpenses;
        const currency = userProfile.country === 'United States' ? 'USD' : 'CAD';
        reply = `📊 Your Stats, ${userProfile.name || 'User'}:\nRevenue: ${currency} ${totalRevenue.toFixed(2)}\nExpenses: ${currency} ${totalExpenses.toFixed(2)}\nProfit: ${currency} ${profit.toFixed(2)}`;
        if (userProfile.goalProgress) {
          reply += `\nGoal Progress: ${currency} ${userProfile.goalProgress.current.toFixed(2)} / ${currency} ${userProfile.goalProgress.target.toFixed(2)} (${((userProfile.goalProgress.current / userProfile.goalProgress.target) * 100).toFixed(1)}%)`;
        }
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (stats)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } catch (error) {
        console.error("[ERROR] Stats failed:", error.message);
        reply = "⚠️ Couldn’t fetch stats. Try again.";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (stats error)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
    } else if (lcInput.startsWith('goal')) {
      const currency = userProfile.country === 'United States' ? 'USD' : 'CAD';
      if (!userProfile.goal) {
        reply = "You haven’t set a financial goal yet. Reply with something like 'Grow profit by $10,000' or 'Pay off $5,000 debt'.";
      } else {
        const progress = userProfile.goalProgress?.current || 0;
        const target = userProfile.goalProgress?.target || 0;
        reply = `🎯 Goal: ${userProfile.goal}\nProgress: ${currency} ${progress.toFixed(2)} / ${currency} ${target.toFixed(2)} (${((progress / target) * 100).toFixed(1)}%)`;
      }
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (goal)`);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // Fallback
    reply = `⚠️ Command not recognized. Try "help" for options.`;
    await db.collection('locks').doc(lockKey).delete();
    console.log(`[LOCK] Released lock for ${from} (unrecognized command)`);
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  } catch (err) {
    console.error(`Error in handleCommands: ${err.message}`);
    reply = `⚠️ An error occurred. Please try again later.`;
    await db.collection('locks').doc(lockKey).delete();
    console.log(`[LOCK] Released lock for ${from} (error)`);
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  }
}

module.exports = {
  expense: expenseHandler,
  revenue: revenueHandler,
  bill: billHandler,
  job: jobHandler,
  quote: quoteHandler,
  metrics: metricsHandler,
  tax: taxHandler,
  receipt: receiptHandler,
  team: teamHandler,
  timeclock: timeclockHandler
};