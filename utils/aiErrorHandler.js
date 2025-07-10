const { Pool } = require('pg');
const { create } = require('axios');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('./stateManager');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
});

const xaiClient = create({
  baseURL: 'https://api.x.ai',
  headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` }
});

const CODEBASE_CONTEXT = `
You are Chief AI, a WhatsApp-based CFO assistant. Valid commands include:
• expense $100 tools from Home Depot
• revenue $200 from Alice
• bill Truck Payment $760 monthly
• create job Roof Repair (then 'yes'/'no' to activate)
• start job Roof Repair, pause job…, resume job…, finish job…, summarize job…
• quote $500 for Roof Repair to John
• time entries: "Alex punched in at 9am", "Alex hours week"
• team: "add member +1234567890"
• receipts: "find receipt for Hammer"
• metrics: "profit for Roof Repair this month"
• tax: "tax rate"
If a user sends an invalid command, infer their intent, suggest a specific command (e.g., "expense $50 tools from Home Depot" for "add $50 for tools"), and ask a clarifying question if needed (e.g., "Did you mean to log an expense?"). Respond conversationally, considering their state (e.g., onboarding step, recent commands).
`;

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
  const match = input.match(/^(start job|create job)\s+(.+)/i);
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

async function detectErrors(data, type = 'expense') {
  console.log(`[DEBUG] detectErrors called for type: ${type}, data:`, data);
  try {
    const errors = {};
    if (!data.amount || isNaN(parseFloat(data.amount?.replace('$', '')))) {
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
    console.error('[ERROR] detectErrors failed:', error.message);
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
    console.error('[ERROR] correctErrorsWithAI failed:', error.message);
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
    console.error('[ERROR] categorizeEntry failed:', error.message);
    throw error;
  }
}

async function handleInputWithAI(from, input, type, parseFn, defaultData = {}) {
  console.log(`[DEBUG] Parsing ${type} message with AI: "${input}"`);
  try {
    const state = await getPendingTransactionState(from) || {};
    if (['expense', 'revenue', 'bill'].includes(type)) {
      if (isOnboardingTrigger(input)) {
        return {
          data: null,
          reply: `It looks like you’re trying to start onboarding. Please send 'start' to begin.`,
          confirmed: false
        };
      }
      if (!isValidExpenseInput(input)) {
        const response = await xaiClient.post('/grok', {
          prompt: `${CODEBASE_CONTEXT}\nUser sent "${input}" for ${type}, but it lacks valid expense/revenue/bill data. Infer their intent, suggest a specific command (e.g., "expense $50 tools from Home Depot"), and ask a clarifying question if needed (e.g., "Did you mean to log an expense?"). Respond conversationally, considering state: ${JSON.stringify(state)}.`
        });
        const aiMessage = response.data.choices?.[0]?.text?.trim() || `🤔 I couldn’t find any ${type} in "${input}". Try "${type} $100 ${type === 'expense' ? 'tools' : type === 'revenue' ? 'from John' : 'Truck Payment monthly'}".`;
        return { data: null, reply: aiMessage, confirmed: false };
      }
    }

    if (state.pendingCorrection && state.type === type) {
      if (/^yes$/i.test(input)) {
        const data = { ...state.pendingData, ...state.suggestedCorrections };
        await deletePendingTransactionState(from);
        return { data, reply: null, confirmed: true };
      } else if (/^(no|edit)$/i.test(input)) {
        await deletePendingTransactionState(from);
        await setPendingTransactionState(from, { isEditing: true, type });
        return { data: null, reply: `✏️ Please correct your ${type} details.`, confirmed: false };
      } else if (/^cancel$/i.test(input)) {
        await deletePendingTransactionState(from);
        return { data: null, reply: `❌ ${type} entry cancelled.`, confirmed: false };
      }
    }

    let data = await parseFn(input);
    if (!data) {
      const response = await xaiClient.post('/grok', {
        prompt: `${CODEBASE_CONTEXT}\nUser sent "${input}" for ${type}, but it couldn't be parsed. Infer their intent, suggest a specific command (e.g., "expense $50 tools from Home Depot"), and ask a clarifying question if needed (e.g., "Did you mean to log an expense?"). Respond conversationally, considering state: ${JSON.stringify(state)}.`
      });
      const aiMessage = response.data.choices?.[0]?.text?.trim() || `🤔 Can't parse "${input}" as a ${type}. Try "${{
        expense: 'expense $100 tools from Home Depot',
        revenue: 'received $100 from John',
        bill: 'bill Truck Payment $760 monthly',
        job: 'start job Roof Repair',
        quote: 'quote $500 for Roof Repair to John'
      }[type]}"`;
      return { data: null, reply: aiMessage, confirmed: false };
    }

    const errors = await detectErrors(data, type);
    if (errors) {
      const corrections = await correctErrorsWithAI(`Error in ${type} input: ${JSON.stringify(errors)}`);
      if (corrections) {
        await setPendingTransactionState(from, {
          pendingData: data,
          pendingCorrection: true,
          suggestedCorrections: corrections,
          type
        });
        const text = Object.entries(corrections)
          .map(([k, v]) => `${k}: ${data[k] || 'missing'} → ${v}`)
          .join('\n');
        return {
          data: null,
          reply: `🤔 I found issues:\n${text}\nReply 'yes' to accept, 'no' to edit, 'cancel' to abort.`,
          confirmed: false
        };
      }
      return {
        data: null,
        reply: `⚠️ Issues with ${type}: ${JSON.stringify(errors)}. Please correct and resend.`,
        confirmed: false
      };
    }

    console.log(`[DEBUG] Parsed ${type}:`, data);
    return { data, reply: null, confirmed: true };
  } catch (error) {
    console.error('[ERROR] handleInputWithAI failed:', error.message);
    return await handleError(from, error, `handleInputWithAI-${type}`, input);
  }
}

async function handleError(from, error, context, originalMessage) {
  console.log('[DEBUG] handleError called:', { from, context, originalMessage });
  try {
    const state = await getPendingTransactionState(from) || {};
    const response = await xaiClient.post('/grok', {
      prompt: `${CODEBASE_CONTEXT}\nUser sent "${originalMessage}" in context "${context}" (state: ${JSON.stringify(state)}), but got error "${error.message}". Infer their intent, explain the issue conversationally, suggest a specific command to fix it, and ask a clarifying question if needed.`
    });
    const aiMessage = response.data.choices?.[0]?.text?.trim() || `Sorry, something went wrong: ${error.message}.`;
    return `<Response><Message>${aiMessage}</Message></Response>`;
  } catch (aiError) {
    console.error('[ERROR] AI error handling failed:', aiError.message);
    return `<Response><Message>⚠️ ${error.message}. Please try again later or contact support.</Message></Response>`;
  }
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
  handleError
};