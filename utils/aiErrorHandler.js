const { callOpenAI } = require('../services/openAI');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('./stateManager');
const { isValidExpenseInput, isOnboardingTrigger } = require('./inputValidator');

/**
 * Validates a date string.
 * @param {string} dateString - The date string to validate.
 * @returns {boolean} True if valid and not in the future.
 */
function isValidDate(dateString) {
    const date = Date.parse(dateString);
    return !isNaN(date) && new Date(dateString) <= new Date();
}

/**
 * Detects errors in parsed data based on type.
 * @param {Object} data - The parsed data.
 * @param {string} type - The type of data ('expense', 'revenue', 'bill', 'job', 'quote').
 * @returns {string|null} Error message or null if valid.
 */
function detectErrors(data, type = 'expense') {
    let errors = [];
    if (!data.amount || isNaN(parseFloat(data.amount.replace('$', '')))) {
        errors.push("Missing or invalid amount");
    }
    if (type === 'expense') {
        if (!data.item || data.item.length < 2) errors.push("Item name is missing or too short");
        if (!data.store || data.store.length < 3) errors.push("Store name is missing or too short");
    }
    if (type === 'revenue') {
        if (!data.description || data.description.length < 2) errors.push("Description is missing or too short");
        if (!data.source && !data.client) errors.push("Source/client is missing");
    }
    if (type === 'bill') {
        if (!data.billName || data.billName.length < 2) errors.push("Bill name is missing or too short");
        if (!data.recurrence || !['yearly', 'monthly', 'weekly', 'bi-weekly', 'one-time'].includes(data.recurrence.toLowerCase())) {
            errors.push("Invalid recurrence (use: yearly, monthly, weekly, bi-weekly, one-time)");
        }
    }
    if (type === 'job') {
        if (!data.jobName || data.jobName.length < 3) errors.push("Job name is missing or too short");
    }
    if (type === 'quote') {
        if (!data.jobName || data.jobName.length < 3) errors.push("Job name is missing or too short");
        if (!data.amount && (!data.items || !data.items.length)) errors.push("Amount or items list is missing");
    }
    if (!data.date || !isValidDate(data.date)) {
        errors.push("Invalid or future date");
    }
    return errors.length ? errors.join(", ") : null;
}

/**
 * Suggests corrections for errors using OpenAI.
 * @param {string} errorMessage - The error message.
 * @returns {Promise<Object|null>} Suggested corrections or null.
 */
async function correctErrorsWithAI(errorMessage) {
    try {
        const prompt = `Suggest corrections for: "${errorMessage}". Return JSON with corrected fields.`;
        const response = await callOpenAI(prompt, "Suggest corrections.", 'gpt-3.5-turbo', 100, 0.3);
        return typeof response === 'string' ? JSON.parse(response) : response;
    } catch (error) {
        console.error("[ERROR] AI correction failed:", error.message);
        return null;
    }
}

/**
 * Parses expense input using regex.
 * @param {string} input - The input string.
 * @returns {Object|null} Parsed expense data or null.
 */
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

/**
 * Parses revenue input using regex.
 * @param {string} input - The input string.
 * @returns {Object|null} Parsed revenue data or null.
 */
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

/**
 * Parses bill input using regex.
 * @param {string} input - The input string.
 * @returns {Object|null} Parsed bill data or null.
 */
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

/**
 * Parses job input using regex.
 * @param {string} input - The input string.
 * @returns {Object|null} Parsed job data or null.
 */
function parseJobMessage(input) {
    const match = input.match(/^(start job|job start)\s+(.+)/i);
    if (!match) return null;
    return {
        jobName: match[2].trim()
    };
}

/**
 * Parses quote input using regex.
 * @param {string} input - The input string.
 * @returns {Object|null} Parsed quote data or null.
 */
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

/**
 * Handles input parsing with AI, including error detection and correction.
 * @param {string} from - The user's phone number.
 * @param {string} input - The input string.
 * @param {string} type - The type of input ('expense', 'revenue', 'bill', 'job', 'quote').
 * @param {Function} parseFn - The parsing function for the type.
 * @param {Object} defaultData - Default data structure for the type.
 * @returns {Promise<Object>} Parsed data, reply, and confirmation status.
 */
async function handleInputWithAI(from, input, type, parseFn, defaultData = {}) {
    console.log(`[DEBUG] Parsing ${type} message with AI: "${input}"`);

    // Validate input for expense/revenue/bill types
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

    const errors = detectErrors(data, type);
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
    parseExpenseMessage,
    parseRevenueMessage,
    parseBillMessage,
    parseJobMessage,
    parseQuoteMessage
};