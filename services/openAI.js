require('dotenv').config();
const OpenAI = require('openai');

/**
 * Creates an OpenAI client instance.
 * @returns {OpenAI} The OpenAI client.
 */
function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('[ERROR] OPENAI_API_KEY is missing');
    throw new Error('Missing OpenAI API key');
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/**
 * Generic function to call OpenAI's chat completions API.
 * @param {string} systemPrompt - The system prompt defining the task.
 * @param {string} userInput - The user input to process.
 * @param {string} [model='gpt-3.5-turbo'] - The OpenAI model to use.
 * @param {number} [maxTokens=50] - Maximum tokens for the response.
 * @param {number} [temperature=0.3] - Sampling temperature.
 * @returns {Promise<string|Object>} The parsed response (JSON or string).
 */
async function callOpenAI(systemPrompt, userInput, model = 'gpt-3.5-turbo', maxTokens = 50, temperature = 0.3) {
  const openaiClient = getOpenAIClient();
  try {
    const gptResponse = await openaiClient.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userInput }
      ],
      max_tokens: maxTokens,
      temperature
    });
    const responseText = gptResponse.choices[0].message.content;
    try {
      return JSON.parse(responseText); // Attempt to parse as JSON
    } catch {
      return responseText; // Return as string if not JSON
    }
  } catch (error) {
    console.error(`[ERROR] OpenAI API call failed: ${error.message}`);
    throw new Error(`OpenAI processing failed: ${error.message}`);
  }
}

/**
 * Parses a delete request for revenue, expense, job, or bill entries.
 * @param {string} input - The delete request text.
 * @returns {Promise<Object>} Parsed delete request { type, criteria }.
 */
async function parseDeleteRequest(input) {
  const prompt = `Parse a delete request: "${input}". Return JSON: { type: 'revenue|expense|job|bill', criteria: { item: 'string|null', amount: 'string|null', date: 'string|null', store: 'string|null', source: 'string|null', billName: 'string|null', jobName: 'string|null' } }. Set unmatched fields to null.`;
  return await callOpenAI(prompt, input, 'gpt-3.5-turbo', 150, 0.3);
}

/**
 * Interprets a financial query for metrics.
 * @param {string} input - The financial query text.
 * @returns {Promise<Object>} Parsed query { intent, job, period, response }.
 */
async function parseFinancialQuery(input) {
  const prompt = `Interpret financial query: "${input}". Return JSON: { intent: 'profit|spend|revenue|margin|help|unknown', job: 'name or null', period: 'ytd|month|specific month|null', response: 'text' }. If unclear, suggest a correction in 'response'.`;
  return await callOpenAI(prompt, input, 'gpt-3.5-turbo', 150, 0.3);
}

/**
 * Parses a location string for onboarding.
 * @param {string} input - The location string (e.g., "Ontario, Canada").
 * @returns {Promise<Object>} Parsed location { province, country }.
 */
async function parseLocation(input) {
  const prompt = `Parse this location string: "${input}". Return JSON: { province: "string", country: "string" }.`;
  return await callOpenAI(prompt, input, 'gpt-3.5-turbo', 50, 0.3);
}

/**
 * Suggests a tax deduction for an expense or bill.
 * @param {string} description - The expense/bill description.
 * @param {string} category - The expense/bill category.
 * @returns {Promise<string>} The suggested deduction string.
 */
async function suggestDeductions(description, category) {
  const prompt = `Suggest a tax deduction for an expense with description "${description}" and category "${category}". Return a string like "Deduction: [category] ([description])".`;
  return await callOpenAI(prompt, description, 'gpt-3.5-turbo', 50, 0.3);
}

/**
 * Categorizes a financial entry (expense or revenue) for tax preparation.
 * @param {string} type - The entry type ('expense' or 'revenue').
 * @param {Object} data - The entry data (e.g., { item, store } or { description, source }).
 * @param {Object} userProfile - The user profile with industry information.
 * @param {Object} categories - The default categories for expense or revenue.
 * @returns {Promise<string>} The suggested category.
 */
async function categorizeEntry(type, data, userProfile, categories) {
  const inputText = type === 'expense'
    ? `${data.item} from ${data.store}`
    : `${data.description} from ${data.source || data.client}`;
  const industry = userProfile.industry || "Other";
  const prompt = `
    Categorize this ${type} for tax preparation based on a CFO's perspective:
    - Input: "${inputText}"
    - Industry: "${industry}"
    - Available ${type} categories: ${JSON.stringify(categories, null, 2)}
    Return JSON: { category: "string" }
  `;
  const result = await callOpenAI(prompt, inputText, 'gpt-3.5-turbo', 50, 0.3);
  return result.category || (type === 'expense' ? "Other Expenses" : "Revenue - Other");
}

module.exports = {
  getOpenAIClient,
  callOpenAI,
  parseDeleteRequest,
  parseFinancialQuery,
  parseLocation,
  suggestDeductions,
  categorizeEntry
};