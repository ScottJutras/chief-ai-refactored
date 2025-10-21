// handlers/commands/index.js

const { handleExpense } = require('./expense');
const { handleRevenue } = require('./revenue');
const { handleBill } = require('./bill');

const handleJob = require('./job');

const { handleQuote } = require('./quote');
const { handleMetrics } = require('./metrics');
const { handleTax } = require('./tax');
const { handleReceipt } = require('./receipt');
const { handleTimeclock } = require('./timeclock');
const { tasksHandler } = require('./tasks');
// --- Robust import for team handler (supports both export styles) ---
const teamMod = require('./team');
const teamFn = (typeof teamMod === 'function') ? teamMod : teamMod.handleTeam;

// Utilities / services referenced by handleCommands
const { isOnboardingTrigger, isValidCommand, isValidExpenseInput } = require('../../utils/inputValidator');
const { db, admin } = require('../../services/firebase');
const {
  getOnboardingState, setOnboardingState, deleteOnboardingState,
  getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState
} = require('../../utils/stateManager');
const { saveUserProfile } = require('../../services/postgres.js');
const { sendTemplateMessage, sendMessage } = require('../../services/twilio');
const { confirmationTemplates } = require('../../config');
const OpenAI = require('openai');
const { google } = require('googleapis');
const { getAuthorizedClient } = require('../../services/postgres.js');
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
// NOTE: if you reference helpers like categorizeEntry / appendToUserSpreadsheet / getActiveJob / getLastQuery,
// ensure they are imported where they actually live in your codebase.
let categorizeEntry, appendToUserSpreadsheet, getActiveJob, getLastQuery, addPricingItem, detectErrors, correctErrorsWithAI;
try {
  // adjust paths as needed:
  ({ categorizeEntry, appendToUserSpreadsheet, getActiveJob, getLastQuery, addPricingItem, detectErrors, correctErrorsWithAI } =
    require('../../services/postgres_extras')); // <— put the real module here
} catch {
  categorizeEntry = async () => 'Uncategorized';
  appendToUserSpreadsheet = async () => {};
  getActiveJob = async () => null;
  getLastQuery = async () => null;
  addPricingItem = async () => {};
  detectErrors = () => null;
  correctErrorsWithAI = async () => null;
}

// ---------- Generic AI fallback ----------
async function handleGenericQuery(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  try {
    const response = await openaiClient.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: `You are a financial assistant for a small business. Answer the query "${input}" based on user profile: industry=${userProfile.industry}, country=${userProfile.country}.` },
        { role: 'user', content: input }
      ],
      max_tokens: 200,
      temperature: 0.5
    });
    const reply = response.choices[0].message.content;
    await sendMessage(from, reply);
    return res.send('<Response></Response>');
  } catch (error) {
    console.error(`[ERROR] Generic query failed: ${error.message}`);
    await sendMessage(from, "⚠️ Couldn’t process your query. Try a specific command like 'stats' or 'expense $100 tools'.");
    return res.send('<Response></Response>');
  }
}


// ---------- Your main commands aggregator (keep this; don't import another) ----------
async function handleCommands(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  const lockKey = `lock:${from}`;
  let reply;
  try {
    console.log(`[DEBUG] Attempting command processing for ${from}: "${input}"`);
    const lcInput = String(input || '').toLowerCase();

    // Check pending transaction confirmation
    const pendingState = await getPendingTransactionState(from);
    if (pendingState && (pendingState.pendingExpense || pendingState.pendingRevenue || pendingState.pendingBill)) {
      const type = pendingState.pendingExpense ? 'expense' : pendingState.pendingRevenue ? 'revenue' : 'bill';
      const pendingData = pendingState.pendingExpense || pendingState.pendingRevenue || pendingState.pendingBill;
      const activeJob = await getActiveJob(ownerId) || 'Uncategorized';
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
          type === 'expense' ? confirmationTemplates.expense : type === 'revenue' ? confirmationTemplates.revenue : confirmationTemplates.bill,
          {
            '1': type === 'expense' ? `${pendingData.amount} for ${pendingData.item} from ${pendingData.store}` :
                 type === 'revenue' ? `${pendingData.amount} from ${pendingData.source || pendingData.client}` :
                 `${pendingData.amount} for ${pendingData.billName} (${pendingData.recurrence})`,
            '2': pendingData.amount,
            '3': pendingData.date,
            '4': pendingData.recurrence || ''
          }
        );
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (pending ${type} confirmation)`);
        return sent ? res.send('<Response></Response>') : res.send(`<Response><Message>${reply}</Message></Response>`);
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
      if (userProfile.subscription_tier === 'starter') {
        reply = await sendTemplateMessage(from, confirmationTemplates.upgradeNow, { "1": `⚠️ Delete features require Pro or Enterprise plan.` });
        await db.collection('locks').doc(lockKey).delete();
        return res.send(`<Response></Response>`);
      }
      console.log("[DEBUG] Detected delete request:", input);

      const auth = await getAuthorizedClient();
      const sheets = google.sheets({ version: 'v4', auth });
      const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const gptResponse = await openaiClient.chat.completions.create({
        model: "gpt-4o",
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
      if (userProfile.subscription_tier === 'starter') {
        reply = await sendTemplateMessage(from, confirmationTemplates.upgradeNow, { "1": `⚠️ Delete features require Pro or Enterprise plan.` });
        await db.collection('locks').doc(lockKey).delete();
        return res.send(`<Response></Response>`);
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

    // Handle pricing item addition
    if (lcInput.startsWith('add material') || lcInput.startsWith('add pricing')) {
      if (userProfile.subscription_tier === 'starter') {
        reply = await sendTemplateMessage(from, confirmationTemplates.upgradeNow, { "1": `⚠️ Pricing items require Pro or Enterprise plan.` });
        await db.collection('locks').doc(lockKey).delete();
        return res.send(`<Response></Response>`);
      }
      const match = input.match(/^add (?:material|pricing)\s+(.+?)\s+at\s+\$?(\d+(?:\.\d{1,2})?)\s*(?:as\s+(.+))?$/i);
      if (!match) {
        reply = "Please provide valid pricing details (e.g., 'add material Nails at $59.99 as material').";
        await db.collection('locks').doc(lockKey).delete();
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
      const [, itemName, unitCost, category = 'material'] = match;
      await setPendingTransactionState(from, { pendingPricing: { itemName, unitCost, category } });
      reply = await sendTemplateMessage(from, confirmationTemplates.pricingConfirmation, {
        "1": itemName,
        "2": `$${unitCost}`,
        "3": category
      });
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (pricing confirmation)`);
      return res.send(`<Response></Response>`);
    } else if (pendingState && pendingState.pendingPricing) {
      if (lcInput === 'yes') {
        const { itemName, unitCost, category } = pendingState.pendingPricing;
        await addPricingItem(ownerId, itemName, unitCost, 'each', category);
        reply = `✅ Added pricing item: ${itemName} at $${unitCost} (${category}).`;
        await deletePendingTransactionState(from);
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (pricing confirmed)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else if (lcInput === 'edit') {
        reply = "Please provide corrected pricing details (e.g., 'add material Nails at $59.99 as material').";
        await setPendingTransactionState(from, { isEditing: true, type: 'pricing' });
        await deletePendingTransactionState(from);
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (pricing edit)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else if (lcInput === 'cancel') {
        await deletePendingTransactionState(from);
        reply = "❌ Pricing addition cancelled.";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (pricing cancelled)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else {
        reply = "Please reply with 'yes', 'edit', or 'cancel'.";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (pricing invalid response)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
    }

    // Handle historical data payment
    if (pendingState && pendingState.pendingHistoricalData) {
      if (lcInput === 'upgrade now') {
        const upgradeTo = userProfile.subscription_tier === 'starter' ? 'pro' : 'enterprise';
        const priceId = upgradeTo === 'pro' ? process.env.PRO_PRICE_ID : process.env.ENTERPRISE_PRICE_ID;
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          line_items: [{ price: priceId, quantity: 1 }],
          mode: 'subscription',
          success_url: `https://your-domain.com/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `https://your-domain.com/cancel`,
          metadata: { userId: from, type: 'upgrade', tier: upgradeTo }
        });
        reply = `Please complete your ${upgradeTo} upgrade: ${session.url}`;
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (upgrade initiated)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else if (lcInput === 'pay one-time fee') {
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          line_items: [{
            price_data: {
              currency: userProfile.country === 'United States' ? 'usd' : 'cad',
              product_data: { name: 'Historical Data Upload' },
              unit_amount: 5000 // $50.00
            },
            quantity: 1
          }],
          mode: 'payment',
          success_url: `https://your-domain.com/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `https://your-domain.com/cancel`,
          metadata: { userId: from, type: 'historical_data' }
        });
        reply = `Please complete your one-time payment for historical data: ${session.url}`;
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (one-time fee initiated)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else if (lcInput === 'no thanks') {
        await deletePendingTransactionState(from);
        reply = "Okay, you can add historical data later with 'stats' or 'metrics'.";
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (historical data declined)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else {
        reply = "Please reply with 'Upgrade Now', 'Pay one-time fee', or 'No thanks'.";
        await db.collection('locks').doc(lockKey).delete();
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
    }

    // Onboarding flow
    let state = await getOnboardingState(from);
    if (isOnboardingTrigger(input) || userProfile.onboarding_in_progress) {
      if (!state) {
        state = { step: 0, responses: {}, detectedLocation: { country: userProfile?.country || "Unknown Country", province: userProfile?.province || "Unknown Province" } };
        await setOnboardingState(from, state);
      }

      if (state.step === 0) {
        await db.runTransaction(async (transaction) => {
          const userRef = db.collection('users').doc(from);
          transaction.update(userRef, { onboarding_in_progress: true });
        });
        reply = "Welcome! What's your name?";
        await setOnboardingState(from, { ...state, step: 1 });
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (onboarding name)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else if (state.step === 1) {
        userProfile.name = input;
        await saveUserProfile(userProfile);
        reply = await sendTemplateMessage(from, confirmationTemplates.locationConfirmation, {
          "1": state.detectedLocation.country,
          "2": state.detectedLocation.province
        });
        await setOnboardingState(from, { ...state, step: 2, responses: { ...state.responses, name: input } });
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (onboarding location)`);
        return res.send(`<Response></Response>`);
      } else if (state.step === 2) {
        if (lcInput === 'yes') {
          userProfile.country = state.detectedLocation.country;
          userProfile.province = state.detectedLocation.province;
          await saveUserProfile(userProfile);
          reply = await sendTemplateMessage(from, confirmationTemplates.businessLocationConfirmation);
          await setOnboardingState(from, { ...state, step: 3 });
        } else if (lcInput === 'edit') {
          reply = "Please provide your country and province (e.g., Canada, Ontario).";
          await setOnboardingState(from, { ...state, step: 2.1 });
        } else if (lcInput === 'cancel') {
          await deleteOnboardingState(from);
          userProfile.onboarding_in_progress = false;
          await saveUserProfile(userProfile);
          reply = "Onboarding cancelled. Send 'start' to try again.";
        } else {
          reply = "Please reply with 'yes', 'edit', or 'cancel'.";
        }
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (onboarding location response)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else if (state.step === 2.1) {
        const [country, province] = input.split(',').map(s => s.trim());
        if (!country || !province) {
          reply = "Please provide both country and province (e.g., Canada, Ontario).";
          await db.collection('locks').doc(lockKey).delete();
          return res.send(`<Response><Message>${reply}</Message></Response>`);
        }
        userProfile.country = country;
        userProfile.province = province;
        await saveUserProfile(userProfile);
        reply = await sendTemplateMessage(from, confirmationTemplates.businessLocationConfirmation);
        await setOnboardingState(from, { ...state, step: 3, responses: { ...state.responses, country, province } });
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (onboarding manual location)`);
        return res.send(`<Response></Response>`);
      } else if (state.step === 3) {
        if (lcInput === 'yes') {
          userProfile.business_country = userProfile.country;
          userProfile.business_province = userProfile.province;
          await saveUserProfile(userProfile);
        } else if (lcInput === 'no') {
          reply = "Please provide your business country and province (e.g., Canada, Ontario).";
          await setOnboardingState(from, { ...state, step: 3.1 });
          await db.collection('locks').doc(lockKey).delete();
          console.log(`[LOCK] Released lock for ${from} (onboarding business location)`);
          return res.send(`<Response><Message>${reply}</Message></Response>`);
        } else {
          reply = "Please reply with 'yes' or 'no'.";
          await db.collection('locks').doc(lockKey).delete();
          return res.send(`<Response><Message>${reply}</Message></Response>`);
        }
        reply = await sendTemplateMessage(from, confirmationTemplates.industryOptions);
        await setOnboardingState(from, { ...state, step: 4 });
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (onboarding industry)`);
        return res.send(`<Response></Response>`);
      } else if (state.step === 3.1) {
        const [business_country, business_province] = input.split(',').map(s => s.trim());
        if (!business_country || !business_province) {
          reply = "Please provide both business country and province (e.g., Canada, Ontario).";
          await db.collection('locks').doc(lockKey).delete();
          return res.send(`<Response><Message>${reply}</Message></Response>`);
        }
        userProfile.business_country = business_country;
        userProfile.business_province = business_province;
        await saveUserProfile(userProfile);
        reply = await sendTemplateMessage(from, confirmationTemplates.industryOptions);
        await setOnboardingState(from, { ...state, step: 4, responses: { ...state.responses, business_country, business_province } });
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (onboarding manual business location)`);
        return res.send(`<Response></Response>`);
      } else if (state.step === 4) {
        if (!['construction', 'real estate', 'retail', 'freelancer', 'finance'].includes(lcInput)) {
          reply = "Please select an industry: Construction, Real Estate, Retail, Freelancer, or Finance.";
          await db.collection('locks').doc(lockKey).delete();
          return res.send(`<Response><Message>${reply}</Message></Response>`);
        }
        userProfile.industry = input;
        await saveUserProfile(userProfile);
        reply = await sendTemplateMessage(from, confirmationTemplates.financialGoal);
        await setOnboardingState(from, { ...state, step: 5, responses: { ...state.responses, industry: input } });
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (onboarding industry set)`);
        return res.send(`<Response></Response>`);
      } else if (state.step === 5) {
        if (['pay off debt', 'save to invest', 'lower tax bracket', 'spend to invest'].includes(lcInput)) {
          reply = `Great! How much for ${input}? (e.g., $10,000)`;
          await setOnboardingState(from, { ...state, step: 5.1, responses: { ...state.responses, goalType: input } });
        } else {
          reply = "Please select 'Pay off debt', 'Save to invest', 'Lower tax bracket', or 'Spend to invest'.";
        }
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (onboarding goal)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else if (state.step === 5.1) {
        const amountMatch = input.match(/\$?(\d+(?:\.\d{1,2})?)/);
        if (!amountMatch) {
          reply = "Please provide a valid amount (e.g., $10,000).";
          await db.collection('locks').doc(lockKey).delete();
          return res.send(`<Response><Message>${reply}</Message></Response>`);
        }
        const amount = parseFloat(amountMatch[1]) * 1000; // NOTE: adjust if not intentional
        userProfile.goal = state.responses.goalType;
        userProfile.goalProgress = {
          target: state.responses.goalType === 'pay off debt' ? -amount : amount,
          current: 0
        };
        await saveUserProfile(userProfile);
        reply = await sendTemplateMessage(from, confirmationTemplates.billTracking);
        await setOnboardingState(from, { ...state, step: 6, responses: { ...state.responses, goalAmount: amount } });
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (onboarding goal amount)`);
        return res.send(`<Response></Response>`);
      } else if (state.step === 6) {
        if (lcInput === 'yes') {
          reply = "Please provide bill details (e.g., 'Truck Payment $500 monthly').";
          await setOnboardingState(from, { ...state, step: 6.1 });
        } else if (lcInput === 'no') {
          reply = await sendTemplateMessage(from, confirmationTemplates.addEmployees);
          await setOnboardingState(from, { ...state, step: 7 });
        } else {
          reply = "Please reply with 'yes' or 'no'.";
        }
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (onboarding bill tracking)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else if (state.step === 6.1) {
        const billMatch = input.match(/^(.+?)\s+\$?(\d+(?:\.\d{1,2})?)\s+(yearly|monthly|weekly|bi-weekly|one-time)$/i);
        if (!billMatch) {
          reply = "Please provide valid bill details (e.g., 'Truck Payment $500 monthly').";
          await db.collection('locks').doc(lockKey).delete();
          return res.send(`<Response><Message>${reply}</Message></Response>`);
        }
        const [, billName, amount, recurrence] = billMatch;
        const billData = { billName, amount, recurrence, date: new Date().toISOString().split('T')[0] };
        const category = await categorizeEntry('bill', billData, ownerProfile);
        await appendToUserSpreadsheet(ownerId, [billData.date, billName, amount, '', await getActiveJob(ownerId) || 'Uncategorized', 'bill', category, '', userProfile.name || 'Unknown User']);
        reply = await sendTemplateMessage(from, confirmationTemplates.addEmployees);
        await setOnboardingState(from, { ...state, step: 7 });
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (onboarding bill added)`);
        return res.send(`<Response></Response>`);
      } else if (state.step === 7) {
        if (lcInput === 'yes') {
          reply = "Please provide employee details (e.g., 'John, Manager').";
          await setOnboardingState(from, { ...state, step: 7.1 });
        } else if (lcInput === 'no') {
          if (!userProfile.historicalDataYears && userProfile.subscription_tier !== 'enterprise') {
            reply = await sendTemplateMessage(from, confirmationTemplates.goalOptions);
            await setOnboardingState(from, { ...state, step: 8 });
          } else {
            userProfile.onboarding_in_progress = false;
            userProfile.onboarding_completed = true;
            await saveUserProfile(userProfile);
            await deleteOnboardingState(from);
            reply = `Onboarding complete, ${userProfile.name}! You're ready to roll. Try 'expense $100 tools' or 'stats' to get started.`;
          }
        } else {
          reply = "Please reply with 'yes' or 'no'.";
        }
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (onboarding team)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else if (state.step === 7.1) {
        const [name, role] = input.split(',').map(s => s.trim());
        if (!name || !role) {
          reply = "Please provide both name and role (e.g., 'John, Manager').";
          await db.collection('locks').doc(lockKey).delete();
          return res.send(`<Response><Message>${reply}</Message></Response>`);
        }
        await handleTeam(from, `add member ${name}, ${role}`, userProfile, ownerId, ownerProfile, isOwner, res);
        if (!userProfile.historicalDataYears && userProfile.subscription_tier !== 'enterprise') {
          reply = await sendTemplateMessage(from, confirmationTemplates.goalOptions);
          await setOnboardingState(from, { ...state, step: 8 });
        } else {
          userProfile.onboarding_in_progress = false;
          userProfile.onboarding_completed = true;
          await saveUserProfile(userProfile);
          await deleteOnboardingState(from);
          reply = `Onboarding complete, ${userProfile.name}! Team member ${name} added. Try 'expense $100 tools' or 'stats' to get started.`;
        }
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (onboarding team added)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else if (state.step === 8) {
        if (lcInput === 'yes, deeper insights') {
          if (userProfile.subscription_tier === 'enterprise') {
            reply = "Great! Please upload your historical financial data (CSV or Excel) or reply with the number of years (e.g., '2 years').";
            await setOnboardingState(from, { ...state, step: 8.1 });
          } else {
            const upgradeTo = userProfile.subscription_tier === 'starter' ? 'pro' : 'enterprise';
            reply = await sendTemplateMessage(from, confirmationTemplates.upgradeNow, {
              "1": `Historical data requires ${upgradeTo} plan or a one-time $50 fee.`
            });
            await setPendingTransactionState(from, { pendingHistoricalData: true });
          }
        } else if (lcInput === 'no, skip insights') {
          userProfile.onboarding_in_progress = false;
          userProfile.onboarding_completed = true;
          await saveUserProfile(userProfile);
          await deleteOnboardingState(from);
          reply = `Onboarding complete, ${userProfile.name}! You're ready to roll. Try 'expense $100 tools' or 'stats' to get started.`;
        } else {
          reply = "Please reply with 'Yes, deeper insights' or 'No, skip insights'.";
        }
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (onboarding historical data)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      } else if (state.step === 8.1) {
        const yearsMatch = input.match(/^(\d+)\s*years?$/i);
        if (yearsMatch) {
          userProfile.historicalDataYears = parseInt(yearsMatch[1]);
          await saveUserProfile(userProfile);
          userProfile.onboarding_in_progress = false;
          userProfile.onboarding_completed = true;
          await saveUserProfile(userProfile);
          await deleteOnboardingState(from);
          reply = `Onboarding complete, ${userProfile.name}! Historical data set for ${userProfile.historicalDataYears} years. Try 'stats' to see insights.`;
        } else {
          reply = "Please specify the number of years (e.g., '2 years') or upload a CSV/Excel file.";
        }
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (onboarding historical data years)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
    }

    // 🔎 Job intents (handle BEFORE expense/revenue heuristics)
    if (/^(create|new|add)\s+job\b/i.test(lcInput) ||
        /^(start|pause|resume|finish|summarize)\s+job\b/i.test(lcInput)) {
      if (userProfile.subscription_tier === 'starter') {
        const sent = await sendTemplateMessage(from, confirmationTemplates.upgradeNow, {
          "1": `⚠️ Jobs require Pro or Enterprise plan.`
        });
        await db.collection('locks').doc(lockKey).delete();
        return res.send(`<Response></Response>`);
      }
      // Let job.js own the response lifecycle; release our lock first.
      await db.collection('locks').doc(lockKey).delete();
      return await handleJob(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
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
      if (userProfile.subscription_tier === 'starter') {
        reply = await sendTemplateMessage(from, confirmationTemplates.upgradeNow, { "1": `⚠️ Bills require Pro or Enterprise plan.` });
        await db.collection('locks').doc(lockKey).delete();
        return res.send(`<Response></Response>`);
      }
      return await handleBill(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
    } else if (lcInput.startsWith('quote')) {
      if (userProfile.subscription_tier === 'starter') {
        reply = await sendTemplateMessage(from, confirmationTemplates.upgradeNow, { "1": `⚠️ Quotes require Pro or Enterprise plan.` });
        await db.collection('locks').doc(lockKey).delete();
        return res.send(`<Response></Response>`);
      }
      return await handleQuote(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
    } else if (lcInput.includes('profit') || lcInput.includes('margin') || lcInput.includes('spend') || lcInput.includes('spent') || (lcInput.includes('how about') && (await getLastQuery(from))?.intent)) {
      if (userProfile.subscription_tier === 'starter') {
        reply = await sendTemplateMessage(from, confirmationTemplates.upgradeNow, { "1": `⚠️ Metrics require Pro or Enterprise plan.` });
        await db.collection('locks').doc(lockKey).delete();
        return res.send(`<Response></Response>`);
      }
      if (!userProfile.historicalDataYears) {
        reply = await sendTemplateMessage(from, confirmationTemplates.goalOptions);
        await setOnboardingState(from, { step: 8, responses: {} });
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (metrics historical data prompt)`);
        return res.send(`<Response></Response>`);
      }
      return await handleMetrics(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
    } else if (lcInput.includes('find receipt') || lcInput.includes('where’s my receipt') || lcInput.includes('show me the receipt')) {
      return await handleReceipt(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
    } else if (lcInput.startsWith('team') || lcInput.includes('add member') || lcInput.includes('remove member')) {
      if (userProfile.subscription_tier === 'starter') {
        reply = await sendTemplateMessage(from, confirmationTemplates.upgradeNow, { "1": `⚠️ Team features require Pro or Enterprise plan.` });
        await db.collection('locks').doc(lockKey).delete();
        return res.send(`<Response></Response>`);
      }
      return await handleTeam(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
    } else if (lcInput.includes('tax rate') || lcInput.startsWith('export tax')) {
      if (userProfile.subscription_tier === 'starter') {
        reply = await sendTemplateMessage(from, confirmationTemplates.upgradeNow, { "1": `⚠️ Tax features require Pro or Enterprise plan.` });
        await db.collection('locks').doc(lockKey).delete();
        return res.send(`<Response></Response>`);
      }
      return await handleTax(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
    } else if (lcInput === 'chief!!') {
      reply = '🔥 You’re the boss, Chief! What’s the next move?';
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (chief command)`);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    } else if (lcInput.startsWith('stats')) {
      if (!userProfile.historicalDataYears && userProfile.subscription_tier !== 'enterprise') {
        reply = await sendTemplateMessage(from, confirmationTemplates.goalOptions);
        await setOnboardingState(from, { step: 8, responses: {} });
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (stats historical data prompt)`);
        return res.send(`<Response></Response>`);
      }
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
        reply = await sendTemplateMessage(from, confirmationTemplates.financialGoal);
        await setOnboardingState(from, { step: 5, responses: {} });
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (goal prompt)`);
        return res.send(`<Response></Response>`);
      } else {
        const progress = userProfile.goalProgress?.current || 0;
        const target = userProfile.goalProgress?.target || 0;
        reply = `🎯 Goal: ${userProfile.goal}\nProgress: ${currency} ${progress.toFixed(2)} / ${currency} ${target.toFixed(2)} (${((progress / target) * 100).toFixed(1)}%)`;
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (goal)`);
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
    }

    // Fallback
    if (userProfile.subscription_tier !== 'starter') {
      return await handleGenericQuery(from, input, userProfile, ownerId, ownerProfile, isOwner, res);
    } else {
      reply = await sendTemplateMessage(from, confirmationTemplates.upgradeNow, { "1": `⚠️ Command not recognized. Try "help" for options. Advanced queries require Pro or Enterprise.` });
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (unrecognized command)`);
      return res.send(`<Response></Response>`);
    }
  } catch (err) {
    console.error(`Error in handleCommands: ${err.message}`);
    const reply = '⚠️ An error occurred. Please try again later.';
    await db.collection('locks').doc(lockKey).delete();
    console.log(`[LOCK] Released lock for ${from} (error)`);
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  }
}

// ---- Exports ----
module.exports = {
  expense: handleExpense,
  revenue: handleRevenue,
  bill: handleBill,
  job: handleJob,
  quote: handleQuote,
  metrics: handleMetrics,
  tax: handleTax,
  receipt: handleReceipt,
  timeclock: handleTimeclock,
  team: teamFn, 
  tasks: tasksHandler,         
  handleCommands,       
};


