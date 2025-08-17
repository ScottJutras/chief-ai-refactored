const { sendMessage } = require('../services/twilio');
const { callOpenAI } = require('../services/openAI');

async function handleError(from, error, context, input) {
  console.log('[DEBUG] handleError called:', { from, error: error.message, context, input });
  try {
    const prompt = `
      You are Chief AI, a pocket CFO for small businesses. An error occurred: "${error.message}" in context "${context}" with input "${input}".
      Provide a user-friendly error message and a specific suggestion to fix it. Return JSON: { message: "string", suggestion: "string" }
    `;
    const response = await callOpenAI(prompt, input, 'gpt-4o', 100, 0.5);
    const { message, suggestion } = response;
    await sendMessage(from, `${message}\n${suggestion}`);
    return `<Response><Message>${message}\n${suggestion}</Message></Response>`;
  } catch (aiError) {
    console.error(`[ERROR] handleError failed for ${from}:`, aiError.message);
    const fallback = `⚠️ An error occurred: ${error.message}. Please try again or contact support.`;
    await sendMessage(from, fallback);
    return `<Response><Message>${fallback}</Message></Response>`;
  }
}

async function handleInputWithAI(from, input, type, parseFn, defaultData = {}) {
  console.log(`[DEBUG] Parsing ${type} message with AI: "${input}"`);
  try {
    const data = parseFn(input);
    if (!data) {
      const prompt = `
        You are Chief AI, a pocket CFO. User sent "${input}" for ${type}, but it couldn't be parsed.
        Suggest a specific command (e.g., "expense $50 tools from Home Depot") and ask a clarifying question.
        If the input is an onboarding trigger (e.g., "start", "hi", "hello", "onboarding"), suggest "start".
        Return JSON: { data: null, reply: "string", confirmed: false }
      `;
      const response = await callOpenAI(prompt, input, 'gpt-4o', 100, 0.3);
      return response;
    }
    const errors = await detectErrors(data, type);
    if (errors) {
      const corrections = await correctErrorsWithAI(`Error in ${type} input: ${JSON.stringify(errors)}`);
      if (corrections) {
        await require('./stateManager').setPendingTransactionState(from, {
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
          reply: `🤔 Issues detected:\n${text}\nReply 'yes' to accept, 'no' to edit, 'cancel' to abort.`,
          confirmed: false
        };
      }
      return {
        data: null,
        reply: `⚠️ Issues with ${type}: ${JSON.stringify(errors)}. Please correct and resend.`,
        confirmed: false
      };
    }
    return { data, reply: null, confirmed: true };
  } catch (error) {
    console.error(`[ERROR] handleInputWithAI failed for ${from}:`, error.message);
    return { data: defaultData, reply: `⚠️ Invalid ${type} format. Please try again.`, confirmed: false };
  }
}

async function detectErrors(data, type) {
  return require('./errorDetector').detectErrors(data, type);
}

async function correctErrorsWithAI(errorContext) {
  const prompt = `
    Suggest corrections for this error context in a financial app: "${errorContext}".
    Return JSON with corrected fields or null if no corrections are possible.
  `;
  return await callOpenAI(prompt, errorContext, 'gpt-4o', 100, 0.3);
}

async function categorizeEntry(type, data, userProfile, categories) {
  return require('../services/openAI').categorizeEntry(type, data, userProfile, categories);
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

function parseBillMessage(input) {
  const match = input.match(/^bill\s+(.+?)\s+\$?(\d+(?:\.\d{1,2})?)(?:\s+(yearly|monthly|weekly|bi-weekly|one-time))?(?:\s+due\s+(.+))?$/i);
  if (!match) return null;
  return {
    date: match[4] ? new Date(match[4]).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
    billName: match[1].trim(),
    amount: `$${parseFloat(match[2]).toFixed(2)}`,
    recurrence: match[3]?.toLowerCase() || 'one-time'
  };
}

function parseRevenueMessage(input) {
  const match = input.match(/^(?:received|revenue)\s+\$?(\d+(?:\.\d{1,2})?)\s+(?:from\s+)?(.+)/i);
  if (!match) return null;
  return {
    date: new Date().toISOString().split('T')[0],
    description: match[2].trim(),
    amount: `$${parseFloat(match[1]).toFixed(2)}`,
    source: match[2].trim()
  };
}

function parseQuoteMessage(input) {
  const match = input.match(/^quote\s+\$?(\d+(?:\.\d{1,2})?)\s+(.+?)(?:\s+(?:to|for)\s+(.+))?$/i);
  if (!match) return null;
  return {
    amount: parseFloat(match[1]),
    description: match[2].trim(),
    client: match[3]?.trim() || 'Unknown',
    jobName: match[2].trim()
  };
}

function parseJobMessage(input) {
  const match = input.match(/^(start job|create job)\s+(.+)/i);
  if (!match) return null;
  return {
    jobName: match[2].trim()
  };
}

module.exports = {
  handleError,
  handleInputWithAI,
  detectErrors,
  correctErrorsWithAI,
  categorizeEntry,
  parseExpenseMessage,
  parseBillMessage,
  parseRevenueMessage,
  parseQuoteMessage,
  parseJobMessage
};