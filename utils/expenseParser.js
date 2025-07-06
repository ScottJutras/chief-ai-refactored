// utils/expenseParser.js
const OpenAI = require('openai');
const chrono = require('chrono-node');
const materialsList = require('./materialsList');
const toolsList = require('./toolsList');
const storeList = require('./storeList');
const constructionStores = storeList.map(store => store.toLowerCase());
const allItemsList = [...materialsList, ...toolsList];
const { isValidExpenseInput, isOnboardingTrigger } = require('./inputValidator');

async function parseExpenseMessage(message) {
    console.log(`[DEBUG] Parsing expense message with AI: "${message}"`);
    
    // Validate input
    if (isOnboardingTrigger(message)) {
        console.log(`[INFO] Onboarding trigger detected in expense parsing for message: "${message}"`);
        return null;
    }
    if (!isValidExpenseInput(message)) {
        console.log(`[INFO] Non-expense input detected in expense parsing for message: "${message}"`);
        return null;
    }

    const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    try {
        const prompt = `
            Extract structured expense data from: "${message}".
            Return JSON with:
            - date (ISO, e.g., "2025-03-13", default to today)
            - item (e.g., "nails")
            - amount (e.g., "$50.00")
            - store (e.g., "Home Depot", default "Unknown Store")
            Infer sensibly if ambiguous.
        `;

        const gptResponse = await openaiClient.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{ role: "system", content: prompt }, { role: "user", content: message }],
            max_tokens: 100,
            temperature: 0.3
        });

        let expenseData = JSON.parse(gptResponse.choices[0].message.content);
        expenseData.date = chrono.parseDate(message)?.toISOString().split('T')[0] || new Date().toISOString().split('T')[0];
        expenseData.item = expenseData.item || allItemsList.find(i => message.toLowerCase().includes(i.toLowerCase())) || "Miscellaneous Purchase";
        expenseData.amount = expenseData.amount ? `$${parseFloat(expenseData.amount.replace('$', '')).toFixed(2)}` : null;
        expenseData.store = expenseData.store || "Unknown Store";
        expenseData.suggestedCategory = "General";
        
        if (!expenseData.amount || !expenseData.item) return null;

        console.log(`[DEBUG] Parsed Expense Data: item="${expenseData.item}", amount="${expenseData.amount}", store="${expenseData.store}", date="${expenseData.date}", category="${expenseData.suggestedCategory}"`);
        return expenseData;
    } catch (error) {
        console.error("[ERROR] AI parsing failed:", error.message);
        return null;
    }
}
async function parseRevenueMessage(message) {
    console.log(`[DEBUG] Parsing revenue message with AI: "${message}"`);
    
    // Validate input
    if (isOnboardingTrigger(message)) {
        console.log(`[INFO] Onboarding trigger detected in revenue parsing for message: "${message}"`);
        return null;
    }
    if (!isValidExpenseInput(message)) {
        console.log(`[INFO] Non-revenue input detected in revenue parsing for message: "${message}"`);
        return null;
    }

    const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    try {
        const prompt = `
            Extract structured revenue data from: "${message}".
            Return JSON with:
            - date (ISO, e.g., "2025-03-13", default to today)
            - amount (e.g., "$50.00")
            - source (e.g., "John Doe", default "Unknown Client")
            Infer sensibly if ambiguous.
        `;

        const gptResponse = await openaiClient.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{ role: "system", content: prompt }, { role: "user", content: message }],
            max_tokens: 100,
            temperature: 0.3
        });

        let revenueData = JSON.parse(gptResponse.choices[0].message.content);
        revenueData.date = chrono.parseDate(message)?.toISOString().split('T')[0] || new Date().toISOString().split('T')[0];
        revenueData.amount = revenueData.amount ? `$${parseFloat(revenueData.amount.replace('$', '')).toFixed(2)}` : null;
        revenueData.source = revenueData.source || "Unknown Client";

        if (!revenueData.amount) return null;

        console.log(`[DEBUG] Parsed Revenue Data: amount="${revenueData.amount}", source="${revenueData.source}", date="${revenueData.date}"`);
        return revenueData;
    } catch (error) {
        console.error("[ERROR] AI parsing failed:", error.message);
        return null;
    }
}

module.exports = { parseExpenseMessage, parseRevenueMessage };