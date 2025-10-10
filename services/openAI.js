require('dotenv').config();
const OpenAI = require('openai');
const { query } = require('./postgres');

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('[ERROR] OPENAI_API_KEY is missing');
    throw new Error('Missing OpenAI API key');
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

async function callOpenAI(systemPrompt, userInput, model = 'gpt-4o', maxTokens = 150, temperature = 0.3) {
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
      return JSON.parse(responseText);
    } catch {
      return responseText;
    }
  } catch (error) {
    console.error(`[ERROR] OpenAI API call failed: ${error.message}`);
    throw new Error(`OpenAI processing failed: ${error.message}`);
  }
}

async function handleGenericQuery(input, userProfile) {
  const prompt = `
    You are Chief AI, a pocket CFO for small businesses. Provide a concise, actionable financial response based on the user's industry (${userProfile.industry || 'Unknown'}) and context. Input: "${input}". Return a string with a helpful answer or suggestion.
  `;
  return await callOpenAI(prompt, input, 'gpt-4o', 200, 0.7);
}

async function parseDeleteRequest(input) {
  const prompt = `Parse a delete request: "${input}". Return JSON: { type: 'revenue|expense|job|bill', criteria: { item: 'string|null', amount: 'string|null', date: 'string|null', store: 'string|null', source: 'string|null', billName: 'string|null', jobName: 'string|null' } }. Set unmatched fields to null.`;
  return await callOpenAI(prompt, input, 'gpt-4o', 150, 0.3);
}

async function parseFinancialQuery(input) {
  const prompt = `Interpret financial query: "${input}". Return JSON: { intent: 'profit|spend|revenue|margin|help|unknown', job: 'name or null', period: 'ytd|month|specific month|null', response: 'text' }. If unclear, suggest a correction in 'response'.`;
  return await callOpenAI(prompt, input, 'gpt-4o', 150, 0.3);
}

async function parseLocation(input) {
  const prompt = `Parse this location string: "${input}". Return JSON: { province: "string", country: "string" }.`;
  return await callOpenAI(prompt, input, 'gpt-4o', 50, 0.3);
}

async function suggestDeductions(description, category) {
  const prompt = `Suggest a tax deduction for an expense with description "${description}" and category "${category}". Return a string like "Deduction: [category] ([description])".`;
  return await callOpenAI(prompt, description, 'gpt-4o', 50, 0.3);
}

async function categorizeEntry(type, data, userProfile, categories) {
  const inputText = type === 'expense'
    ? `${data.item} from ${data.store}`
    : type === 'revenue'
    ? `${data.description} from ${data.source || data.client}`
    : `${data.billName}`;
  const industry = userProfile.industry || 'Other';
  const ownerId = userProfile.owner_id || userProfile.user_id;
  const res = await query(
    `SELECT item_name, category FROM pricing_items WHERE owner_id = $1 AND category != 'labour'`,
    [ownerId]
  );
  const items = res.rows;
  const itemName = type === 'expense' ? data.item : type === 'revenue' ? data.source || data.client : data.billName;
  const match = items.find(item => itemName?.toLowerCase().includes(item.item_name.toLowerCase()));
  if (match) return match.category;
  const prompt = `
    Categorize this ${type} for tax preparation based on a CFO's perspective:
    - Input: "${inputText}"
    - Industry: "${industry}"
    - Available ${type} categories: ${JSON.stringify(categories, null, 2)}
    Return JSON: { category: "string" }
  `;
  const result = await callOpenAI(prompt, inputText, 'gpt-4o', 50, 0.3);
  return result.category || (type === 'expense' ? 'Other Expenses' : type === 'revenue' ? 'Revenue - Other' : 'Bill');
}

module.exports = {
  getOpenAIClient,
  callOpenAI,
  handleGenericQuery,
  parseDeleteRequest,
  parseFinancialQuery,
  parseLocation,
  suggestDeductions,
  categorizeEntry
};