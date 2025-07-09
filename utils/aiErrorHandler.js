const { Pool } = require('pg');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('./stateManager');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function isValidDate(dateString) {
  const date = Date.parse(dateString);
  return !isNaN(date) && new Date(dateString) <= new Date();
}

function isOnboardingTrigger(input) {
  const triggers = ['start', 'hi', 'hello', 'onboarding', 'begin', 'get started'];
  return triggers.some(trigger => input.toLowerCase().includes(trigger));
}

function isValidExpenseInput(input) {
  return input.match(/\$?\d+(\.\d{1,2})?/i) || input.match(/(expense|revenue|bill)/i);
}

async function detectErrors(data, type = 'expense') {
  console.log(`[DEBUG] detectErrors called for type: ${type}, data:`, data);
  try {
    const errors = {};
    if (!data.amount || isNaN(parseFloat(data.amount.replace('$', '')))) {
      errors.amount = 'Missing or invalid amount';
    }
    if (type === 'expense') {
      if (!data.item || data.item.length < 2) errors.item = 'Missing or too short item description';
      if (!data.store || data.store.length < 3) errors.store = 'Missing or too short store name';
    } else if (type === 'revenue') {
      if (!data.description || data.description.length < 2) errors.description = 'Missing or too short description';
      if (!data.source && !data.client) errors.source = 'Missing source/client';
    } else if (type === 'bill') {
      if (!data.billName || data.billName.length < 2) errors.billName = 'Missing or too short bill name';
      if (!data.recurrence || !['yearly', 'monthly', 'weekly', 'bi-weekly', 'one-time'].includes(data.recurrence?.toLowerCase())) {
        errors.recurrence = 'Invalid recurrence (use: yearly, monthly, weekly, bi-weekly, one-time)';
      }
    } else if (type === 'job') {
      if (!data.jobName || data.jobName.length < 3) errors.jobName = 'Missing or too short job name';
    } else if (type === 'quote') {
      if (!data.jobName || data.jobName.length < 3) errors.jobName = 'Missing or too short job name';
      if (!data.amount && (!data.items || !data.items.length)) errors.amount = 'Missing amount or items list';
    }
    if (!data.date || !isValidDate(data.date)) {
      errors.date = 'Invalid or future date';
    }
    console.log(`[DEBUG] detectErrors result:`, errors);
    return Object.keys(errors).length ? errors : null;
  } catch (error) {
    console.error(`[ERROR] detectErrors failed:`, error.message);
    throw error;
  }
}

async function correctErrorsWithAI(errorMessage) {
  console.log(`[DEBUG] correctErrorsWithAI called with error: ${errorMessage}`);
  try {
    const corrections = {};
    if (errorMessage.includes('amount')) corrections.amount = '$100.00';
    if (errorMessage.includes('item')) corrections.item = 'Generic Item';
    if (errorMessage.includes('store')) corrections.store = 'Unknown Store';
    if (errorMessage.includes('description') || errorMessage.includes('source')) corrections.source = 'Unknown Client';
    if (errorMessage.includes('billName')) corrections.billName = 'Generic Bill';
    if (errorMessage.includes('recurrence')) corrections.recurrence = 'one-time';
    if (errorMessage.includes('jobName')) corrections.jobName = 'Generic Job';
    if (errorMessage.includes('date')) corrections.date = new Date().toISOString().split('T')[0];
    console.log(`[DEBUG] correctErrorsWithAI result:`, corrections);
    return corrections;
  } catch (error) {
    console.error(`[ERROR] correctErrorsWithAI failed:`, error.message);
    return null;
  }
}

async function categorizeEntry(type, data, ownerProfile) {
  console.log(`[DEBUG] categorizeEntry called for type: ${type}, data:`, data);
  try {
    const ownerId = ownerProfile.owner_id || ownerProfile.user_id;
    const res = await pool.query(
      `SELECT item_name, category FROM pricing_items WHERE owner_id = $1 AND category != 'labour'`,
      [ownerId]
    );
    const items = res.rows;
    const itemName = type === 'expense' ? data.item : type === 'revenue' ? data.source : data.billName;
    const match = items.find(item => itemName?.toLowerCase().includes(item.item_name.toLowerCase()));
    const category = match ? match.category : type === 'expense' ? 'material' : type === 'revenue' ? 'revenue' : 'bill';
    console.log(`[DEBUG] categorizeEntry result: ${category}`);
    return category;
  } catch (error) {
    console.error(`[ERROR] categorizeEntry failed:`, error.message);
    throw error;
  }
}

function parseExpenseMessage(input) {
  const match = input.match(/^(?:expense\s+)?\$?(\d+(?:\.\d{1,2})?)\s+(.+?)(?:\s+from\s+(.+))?$/i);
  if (!match) return null;
  return {
    date: new Date().toISOString().split('T')[0],
    item: match[2].trim(),
    amount: `$${parseFloat(match[1]).toFixed(2)}`,
    store: match[3]?.trim() || 'Unknown Store'
  };
}

function parseRevenueMessage(input) {
  const match = input.match(/^(?:revenue\s+)?(?:received\s+)?\$?(\d+(?:\.\d{1,2})?)\s+(?:from\s+)?(.+)/i);
  if (!match) return null;
  return {
    date: new Date().toISOString().split('T')[0],
    description: match[2].trim(),
    amount: `$${parseFloat(match[1]).toFixed(2)}`,
    source: match[2].trim()
  };
}

function parseBillMessage(input) {
  const match = input.match(/^bill\s+(.+?)\s+\$?(\d+(?:\.\d{1,2})?)\s+(yearly|monthly|weekly|bi-weekly|one-time)$/i);
  if (!match) return null;
  return {
    date: new Date().toISOString().split('T')[0],
    billName: match[1].trim(),
    amount: `$${parseFloat(match[2]).toFixed(2)}`,
    recurrence: match[3].toLowerCase()
  };
}

function parseJobMessage(input) {
  const match = input.match(/^(start job|job start)\s+(.+)/i);
  if (!match) return null;
  return {
    jobName: match[2].trim()
  };
}

function parseQuoteMessage(input) {
  const match = input.match(/^quote\s+(\$?\d+\.?\d*)\s+for\s+(.+?)\s+to\s+(.+)/i) ||
    input.match(/^quote\s+for\s+(.+?)\s+with\s+(.+)/i);
  if (!match) return null;
  return match[2] ? {
    amount: parseFloat(match[1].replace('$', '')),
    description: match[2],
    client: match[3],
    jobName: match[2]
  } : {
    jobName: match[1],
    items: match[2].split(',').map(item => {
      const [name, qty, price] = item.trim().split(/\s+/);
      return { item: name, quantity: parseInt(qty), price: parseFloat(price) };
    })
  };
}

async function handleInputWithAI(from, input, type, parseFn, defaultData = {}) {
  console.log(`[DEBUG] Parsing ${type} message with AI: "${input}"`);

  if (['expense', 'revenue', 'bill'].includes(type)) {
    if (isOnboardingTrigger(input)) {
      console.log(`[INFO] Onboarding trigger detected in ${type} input for ${from}: input="${input}"`);
      return {
        data: null,
        reply: `It looks like you’re trying to start onboarding. Please send a text message like 'start' or 'hi' to begin.`,
        confirmed: false
      };
    }
    if (!isValidExpenseInput(input)) {
      console.log(`[INFO] Non-${type} input detected for ${from}: input="${input}"`);
      return {
        data: null,
        reply: `🤔 The input "${input}" doesn't seem to contain ${type} information. Please provide details like "${type} $100 ${type === 'expense' ? 'tools' : type === 'revenue' ? 'from John' : 'Truck Payment monthly'}".`,
        confirmed: false
      };
    }
  }

  const pendingState = await getPendingTransactionState(from);
  let data = await parseFn(input);

  if (pendingState && pendingState.pendingCorrection && pendingState.type === type) {
    if (input.toLowerCase() === 'yes') {
      data = { ...pendingState.pendingData, ...pendingState.suggestedCorrections };
      await deletePendingTransactionState(from);
      return { data, reply: null, confirmed: true };
    } else if (input.toLowerCase() === 'no' || input.toLowerCase() === 'edit') {
      await deletePendingTransactionState(from);
      await setPendingTransactionState(from, { isEditing: true, type });
      return { data: null, reply: `✏️ Please provide the correct ${type} details.`, confirmed: false };
    } else if (input.toLowerCase() === 'cancel') {
      await deletePendingTransactionState(from);
      return { data: null, reply: `❌ ${type} entry cancelled.`, confirmed: false };
    }
  }

  if (!data) {
    console.log(`[INFO] Failed to parse ${type} input for ${from}: input="${input}"`);
    return {
      data: null,
      reply: `🤔 I couldn’t parse "${input}" as a ${type}. Please try again with a format like "${type === 'expense' ? 'expense $100 tools from Home Depot' : type === 'revenue' ? 'received $100 from John' : type === 'bill' ? 'bill Truck Payment $760 monthly' : type === 'job' ? 'start job Roof Repair' : 'quote $500 for Roof Repair to John'}".`,
      confirmed: false
    };
  }

  const errors = await detectErrors(data, type);
  if (errors) {
    const corrections = await correctErrorsWithAI(`Error in ${type} input: ${input} - ${errors}`);
    if (corrections) {
      await setPendingTransactionState(from, { 
        pendingData: data, 
        pendingCorrection: true, 
        suggestedCorrections: corrections, 
        type 
      });
      const correctionText = Object.entries(corrections).map(([k, v]) => `${k}: ${data[k] || 'missing'} → ${v}`).join('\n');
      return {
        data: null,
        reply: `🤔 Detected issues in ${type}:\n${correctionText}\nReply 'yes' to accept, 'no' to edit, or 'cancel' to discard.`,
        confirmed: false
      };
    }
    return {
      data: null,
      reply: `⚠️ Issues with ${type}: ${errors}. Please correct and resend.`,
      confirmed: false
    };
  }

  console.log(`[DEBUG] Parsed ${type} Data: ${JSON.stringify(data)}`);
  return { data, reply: null, confirmed: true };
}

module.exports = {
  handleInputWithAI,
  detectErrors,
  correctErrorsWithAI,
  categorizeEntry,
  parseExpenseMessage,
  parseRevenueMessage,
  parseBillMessage,
  parseJobMessage,
  parseQuoteMessage,
  isValidExpenseInput,
  isOnboardingTrigger
};