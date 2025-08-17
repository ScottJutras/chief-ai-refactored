const OpenAI = require('openai');
const { sendMessage } = require('../../services/twilio');

async function handleGenericQuery(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  try {
    const response = await openaiClient.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: `You are a financial assistant for a small business. Answer the query "${input}" based on user profile: industry=${userProfile.industry}, country=${userProfile.country}.` },
        { role: "user", content: input }
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

module.exports = { handleGenericQuery };