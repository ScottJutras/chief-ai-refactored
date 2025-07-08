const { getPricingItems } = require('../services/postgres');
const { pdfKitQuote } = require('./pdfService');
const pricing = await getPricingItems(ownerId);

function parseQuoteMessage(message) {
  const match = message.match(/quote for\s+([^:]+)(?::\s*(.+))?/i);
  if (!match) return null;

  const jobName = match[1].trim();
  const itemsText = match[2]?.trim() || '';
  if (!itemsText) return { jobName, items: [], overallMarkup: 1.40 };

  const overallMarkupMatch = itemsText.match(/plus\s+(\d+)%$/i);
  const overallMarkup = overallMarkupMatch
    ? (1 + parseInt(overallMarkupMatch[1], 10) / 100)
    : 1.40;
  const textNoMarkup = overallMarkupMatch
    ? itemsText.replace(overallMarkupMatch[0], '').trim()
    : itemsText;

  const entries = textNoMarkup.split(',').map(s => s.trim());
  const items = [];

  for (const entry of entries) {
    const custom = entry.match(/\$(\d+(?:\.\d{1,2})?)\s+for\s+(.+)/i);
    if (custom) {
      items.push({ quantity: 1, item: custom[2].trim(), price: parseFloat(custom[1]) });
    } else {
      const m = entry.match(/(\d+)\s+(.+?)(?:\s+plus\s+(\d+)%|$)/i);
      if (m) {
        const quantity = parseInt(m[1], 10);
        const item = m[2].trim();
        const markup = m[3] ? (1 + parseInt(m[3], 10) / 100) : overallMarkup;
        items.push({ quantity, item, markup });
      }
    }
  }

  return { jobName, items, overallMarkup };
}

/**
 * Builds quote pricing using user-specific pricing items from Postgres.
 * @param {Object} parsedQuote - result of parseQuoteMessage()
 * @param {string} ownerId - user id to fetch pricing
 */
async function buildQuoteDetails(parsedQuote, ownerId) {
  // load dynamic pricing
  const pricing = await getPricingItems(ownerId);
  const priceMap = Object.fromEntries(
    pricing.map(({ item_name, unit_cost }) => [item_name.toLowerCase(), unit_cost])
  );

  const quoteItems = [];
  let total = 0;
  const missingItems = [];

  for (const { quantity, item, price, markup } of parsedQuote.items) {
    if (price !== undefined) {
      total += price * quantity;
      quoteItems.push({ item, quantity, price });
    } else {
      const key = item.toLowerCase().replace(/\s+/g, ' ').trim();
      const base = priceMap[key];
      if (base != null) {
        const unitPrice = base * (markup || parsedQuote.overallMarkup);
        total += unitPrice * quantity;
        quoteItems.push({ item, quantity, price: unitPrice });
      } else {
        missingItems.push(item);
      }
    }
  }

  return { items: quoteItems, total, missingItems };
}

module.exports = { parseQuoteMessage, buildQuoteDetails };
