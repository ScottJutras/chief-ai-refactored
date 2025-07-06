const { fetchMaterialPrices } = require('../legacy/googleSheetsnewer'); // Adjust path as needed

function parseQuoteMessage(message) {
    // Handles: "quote for Job 75: 10 nails plus 40%, $50 for paint" or "quote for Job 75: 100 for painting"
    const match = message.match(/quote for\s+([^:]+)(?::\s*(.+))?/i);
    if (!match) return null;

    const jobName = match[1].trim();
    const itemsText = match[2]?.trim() || '';
    if (!itemsText) return { jobName, items: [], overallMarkup: 1.40 }; // Default markup if no items

    const overallMarkupMatch = itemsText.match(/plus\s+(\d+)%$/i);
    const overallMarkup = overallMarkupMatch ? (1 + parseInt(overallMarkupMatch[1]) / 100) : 1.40;
    const itemsTextWithoutMarkup = overallMarkupMatch ? itemsText.replace(overallMarkupMatch[0], '').trim() : itemsText;

    const itemList = itemsTextWithoutMarkup.split(',').map(item => item.trim());
    const items = [];
    for (const itemEntry of itemList) {
        const customMatch = itemEntry.match(/\$(\d+(?:\.\d{1,2})?)\s+for\s+(.+)/i);
        if (customMatch) {
            items.push({ quantity: 1, item: customMatch[2].trim(), price: parseFloat(customMatch[1]) });
        } else {
            const match = itemEntry.match(/(\d+)\s+(.+?)(?:\s+plus\s+(\d+)%|$)/i);
            if (match) {
                const quantity = parseInt(match[1], 10);
                const item = match[2].trim();
                const itemMarkup = match[3] ? (1 + parseInt(match[3]) / 100) : overallMarkup;
                items.push({ quantity, item, markup: itemMarkup });
            }
        }
    }
    return { jobName, items, overallMarkup };
}

async function buildQuoteDetails(parsedQuote, ownerProfile) {
    const pricingSpreadsheetId = process.env.PRICING_SPREADSHEET_ID;
    if (!pricingSpreadsheetId) throw new Error('Pricing spreadsheet not configured');
    const priceMap = await fetchMaterialPrices(pricingSpreadsheetId);
    const quoteItems = [];
    let total = 0;
    const missingItems = [];

    parsedQuote.items.forEach(({ quantity, item, price, markup }) => {
        if (price !== undefined) {
            // Fixed price item (e.g., "$50 for paint")
            total += price * quantity;
            quoteItems.push({ item, quantity, price });
        } else {
            // Item with markup (e.g., "10 nails plus 40%")
            const normalizedItem = item.toLowerCase().replace(/\s+/g, ' ').trim();
            const basePrice = priceMap[normalizedItem] || 0;
            if (basePrice > 0) {
                const markedUpPrice = basePrice * (markup || parsedQuote.overallMarkup);
                total += markedUpPrice * quantity;
                quoteItems.push({ item, quantity, price: markedUpPrice });
            } else {
                missingItems.push(item);
            }
        }
    });

    return { items: quoteItems, total, missingItems };
}

module.exports = { parseQuoteMessage, buildQuoteDetails };