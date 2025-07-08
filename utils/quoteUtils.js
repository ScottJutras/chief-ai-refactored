// utils/quoteUtils.js

const { getPricingItems } = require('../services/postgres');

/**
 * Parses a “quote for <jobName>: …” message into its components.
 */
function parseQuoteMessage(message) {
  const match = message.match(/quote for\s+([^:]+)(?::\s*(.+))?/i);
  if (!match) return null;

  const jobName = match[1].trim();
  const itemsText = match[2]?.trim() || '';
  if (!itemsText) return { jobName, items: [], overallMarkup: 1.40 };

  // detect an overall markup at the end
  const overallMarkupMatch = itemsText.match(/plus\s+(\d+)%$/i);
  const overallMarkup = overallMarkupMatch
    ? 1 + parseInt(overallMarkupMatch[1], 10) / 100
    : 1.40;
  const rawList = overallMarkupMatch
    ? itemsText.replace(overallMarkupMatch[0], '').trim()
    : itemsText;

  const items = rawList
    .split(',')
    .map(entry => entry.trim())
    .map(entry => {
      // custom‐price item: “$50 for paint”
      let m = entry.match(/^\$(\d+(?:\.\d{1,2})?)\s+for\s+(.+)$/i);
      if (m) {
        return { quantity: 1, item: m[2].trim(), price: parseFloat(m[1]) };
      }
      // quantity + optional per‐item markup
      m = entry.match(/^(\d+)\s+(.+?)(?:\s+plus\s+(\d+)%|)$/i);
      if (m) {
        return {
          quantity: parseInt(m[1], 10),
          item: m[2].trim(),
          markup: m[3] ? 1 + parseInt(m[3], 10) / 100 : overallMarkup
        };
      }
      return null;
    })
    .filter(x => x);

  return { jobName, items, overallMarkup };
}

/**
 * Loads user‐specific pricing from Postgres and calculates:
 *  - per‐item line totals
 *  - overall quote total
 *  - any missing items
 */
async function buildQuoteDetails(parsedQuote, ownerId) {
  // 1) get this user’s pricing table
  const pricing = await getPricingItems(ownerId);
  const priceMap = Object.fromEntries(
    pricing.map(p => [p.item_name.toLowerCase(), p.unit_cost])
  );

  const quoteItems = [];
  let total = 0;
  const missingItems = [];

  for (const { quantity, item, price, markup } of parsedQuote.items) {
    if (price !== undefined) {
      // fixed‐price line
      quoteItems.push({ item, quantity, price });
      total += price * quantity;
    } else {
      // lookup base cost and apply markup
      const key = item.toLowerCase().trim();
      const base = priceMap[key];
      if (base != null) {
        const perUnit = base * (markup || parsedQuote.overallMarkup);
        quoteItems.push({ item, quantity, price: perUnit });
        total += perUnit * quantity;
      } else {
        missingItems.push(item);
      }
    }
  }

  return { items: quoteItems, total, missingItems };
}

module.exports = { parseQuoteMessage, buildQuoteDetails };
