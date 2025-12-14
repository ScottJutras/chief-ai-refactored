const { query } = require('../../services/postgres');
const { releaseLock } = require('../../middleware/lock');

function parseReceiptQuery(input) {
  const lcInput = input.toLowerCase().trim();
  const itemMatch = lcInput.match(/(?:find receipt for|receipt)\s+(.+)/i);
  return {
    item: itemMatch ? itemMatch[1].trim() : null
  };
}

async function handleReceipt(from, input, userProfile, ownerId) {
  const lockKey = `lock:${from}`;
  let reply;

  try {
    const query = parseReceiptQuery(input);
    if (!query.item) {
      reply = "⚠️ Please specify an item to search for. Try: 'find receipt for Hammer'";
      return `<Response><Message>${reply}</Message></Response>`;
    }

    const res = await query(
      `SELECT date, amount, item, store, media_url
       FROM transactions
       WHERE owner_id = $1
       AND type = 'expense'
       AND LOWER(item) LIKE $2
       AND media_url IS NOT NULL`,
      [ownerId, `%${query.item.toLowerCase()}%`]
    );

    const receipts = res.rows;
    if (!receipts.length) {
      reply = `🤔 No receipts found for "${query.item}". Try a different item or check your expenses.`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    reply = `📄 Found ${receipts.length} receipt${receipts.length > 1 ? 's' : ''} for "${query.item}":\n`;
    receipts.slice(0, 3).forEach((data, i) => {
      reply += `${i + 1}. ${data.date} - ${data.amount.toFixed(2)} from ${data.store}\nLink: ${data.media_url}\n`;
    });
    if (receipts.length > 3) reply += `...and ${receipts.length - 3} more. Refine your search for more details.`;

    return `<Response><Message>${reply}</Message></Response>`;
  } catch (error) {
    console.error(`[ERROR] handleReceipt failed for ${from}:`, error.message);
    reply = `⚠️ Failed to process receipt: ${error.message}`;
    return `<Response><Message>${reply}</Message></Response>`;
  } finally {
    await releaseLock(lockKey);
  }
}

module.exports = { handleReceipt };