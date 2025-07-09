const { Pool } = require('pg');
const { releaseLock } = require('../middleware/lock');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function getTaxRate(country, province) {
  const taxRates = {
    'United States': { default: 0.08 },
    'Canada': {
      'Ontario': 0.13,
      'British Columbia': 0.12,
      'Alberta': 0.05,
      default: 0.13
    }
  };
  return country === 'United States'
    ? taxRates['United States'].default
    : taxRates['Canada'][province] || taxRates['Canada'].default;
}

async function handleTax(from, input, userProfile, ownerId) {
  const lockKey = `lock:${from}`;
  let reply;

  try {
    const lcInput = input.toLowerCase().trim();
    if (lcInput.includes('tax rate')) {
      const taxRate = getTaxRate(userProfile.country, userProfile.province);
      const currency = userProfile.country === 'United States' ? 'USD' : 'CAD';
      reply = `📊 Tax rate for ${userProfile.country}, ${userProfile.province}: ${(taxRate * 100).toFixed(2)}%`;
      return `<Response><Message>${reply}</Message></Response>`;
    } else if (lcInput.startsWith('export tax')) {
      const res = await pool.query(
        `SELECT date, item, amount FROM transactions WHERE owner_id = $1 AND type IN ('expense', 'bill')`,
        [ownerId]
      );
      const taxRate = getTaxRate(userProfile.country, userProfile.province);
      const taxData = res.rows.map(row => ({
        date: row.date,
        item: row.item,
        amount: parseFloat(row.amount || 0),
        tax: parseFloat(row.amount || 0) * taxRate
      }));
      reply = `📊 Tax Export:\n${taxData.slice(0, 3).map((entry, i) => `${i + 1}. ${entry.date} - ${entry.item}: ${entry.amount.toFixed(2)} (Tax: ${entry.tax.toFixed(2)})`).join('\n')}`;
      if (taxData.length > 3) reply += `\n...and ${taxData.length - 3} more. Check your database for full details.`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    reply = "⚠️ Invalid tax command. Try: 'tax rate' or 'export tax'";
    return `<Response><Message>${reply}</Message></Response>`;
  } catch (error) {
    console.error(`[ERROR] handleTax failed for ${from}:`, error.message);
    reply = `⚠️ Failed to process tax command: ${error.message}`;
    return `<Response><Message>${reply}</Message></Response>`;
  } finally {
    await releaseLock(lockKey);
  }
}

module.exports = { handleTax };