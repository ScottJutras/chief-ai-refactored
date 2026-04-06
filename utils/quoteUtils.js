// utils/quoteUtils.js

const { getPricingItems, searchAllCatalog } = require('../services/postgres');
const { normalizeJobNameCandidate } = require('./jobNameUtils'); // path may vary

/**
 * Parses a "quote for <jobName>: …" message into its components.
 */
function parseQuoteMessage(message) {
  const match = message.match(/quote for\s+([^:]+)(?::\s*(.+))?/i);
  if (!match) return null;

  const jobName = normalizeJobNameCandidate(match[1]) || match[1].trim();
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
      // custom‐price item: "$50 for paint"
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
 * Look up an item name in the supplier catalog.
 * Returns the best match product or null.
 */
async function resolvePriceFromCatalog(itemName) {
  try {
    const results = await searchAllCatalog(itemName, { limit: 3 });
    if (!results || results.length === 0) return null;
    // Take the top result — FTS already ranks by relevance
    return results[0];
  } catch (e) {
    console.warn('[quoteUtils] catalog lookup failed for item:', itemName, e?.message);
    return null;
  }
}

/**
 * Loads user‐specific pricing from Postgres and calculates:
 *  - per‐item line totals
 *  - overall quote total
 *  - any missing items (not found in custom pricing OR catalog)
 *
 * Each returned item may include:
 *  - from_catalog: true       — price sourced from supplier catalog
 *  - catalog_product_id       — UUID of the catalog_products row
 *  - catalog_snapshot         — frozen product details at quote time
 */
async function buildQuoteDetails(parsedQuote, ownerId) {
  // 1) get this user's pricing table
  const pricing = await getPricingItems(ownerId);
  const priceMap = Object.fromEntries(
    pricing.map(p => [p.item_name.toLowerCase(), p.unit_cost])
  );

  const quoteItems = [];
  let total = 0;
  const missingItems = [];

  for (const { quantity, item, price, markup } of parsedQuote.items) {
    if (price !== undefined) {
      // fixed‐price line — no catalog lookup needed
      quoteItems.push({ item, quantity, price });
      total += price * quantity;
    } else {
      const key = item.toLowerCase().trim();
      const base = priceMap[key];

      if (base != null) {
        // Found in custom pricing
        const perUnit = base * (markup || parsedQuote.overallMarkup);
        quoteItems.push({ item, quantity, price: perUnit });
        total += perUnit * quantity;
      } else {
        // Not in custom pricing — try catalog fallback
        const catalogProduct = await resolvePriceFromCatalog(item);

        if (catalogProduct && catalogProduct.unit_price_cents > 0) {
          const perUnitDollars = (catalogProduct.unit_price_cents / 100) * (markup || parsedQuote.overallMarkup);
          const snapshot = {
            product_id: catalogProduct.id,
            sku: catalogProduct.sku,
            supplier: catalogProduct.supplier_name || catalogProduct.supplier_slug || null,
            name: catalogProduct.name,
            unit_price_cents: catalogProduct.unit_price_cents,
            price_as_of: catalogProduct.price_effective_date || null,
            freshness: catalogProduct.freshness || 'UNKNOWN',
          };
          quoteItems.push({
            item: catalogProduct.name,  // use canonical catalog name
            quantity,
            price: perUnitDollars,
            from_catalog: true,
            catalog_product_id: catalogProduct.id,
            catalog_snapshot: snapshot,
          });
          total += perUnitDollars * quantity;
        } else {
          missingItems.push(item);
        }
      }
    }
  }

  return { items: quoteItems, total, missingItems };
}

module.exports = { parseQuoteMessage, buildQuoteDetails };
