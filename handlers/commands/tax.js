const { getTaxRate } = require('../../utils/taxRate');
const { getAuthorizedClient } = require('../../services/postgres.js');
const { google } = require('googleapis');
const { releaseLock } = require('../../middleware/lock');

async function handleTax(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  const lockKey = `lock:${from}`;
  let reply;

  try {
    const lcInput = input.toLowerCase();
    if (lcInput.includes('tax rate')) {
      const taxRate = getTaxRate(userProfile.country, userProfile.province);
      const currency = userProfile.country === 'United States' ? 'USD' : 'CAD';
      reply = `📊 Tax rate for ${userProfile.country}, ${userProfile.province}: ${(taxRate * 100).toFixed(2)}%`;
      await releaseLock(lockKey);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    } else if (lcInput.startsWith('export tax')) {
      const auth = await getAuthorizedClient();
      const sheets = google.sheets({ version: 'v4', auth });
      const expenses = await sheets.spreadsheets.values.get({
        spreadsheetId: ownerProfile.spreadsheetId,
        range: 'Sheet1!A:I'
      });
      const expenseData = (expenses.data.values || []).slice(1).filter(row => row[5] === 'expense' || row[5] === 'bill');
      const taxData = expenseData.map(row => ({
        date: row[0],
        item: row[1],
        amount: parseFloat(row[2].replace(/[^0-9.]/g, '') || 0),
        tax: parseFloat(row[2].replace(/[^0-9.]/g, '') || 0) * getTaxRate(userProfile.country, userProfile.province)
      }));
      reply = `📊 Tax Export:\n${taxData.slice(0, 3).map((entry, i) => `${i + 1}. ${entry.date} - ${entry.item}: ${entry.amount.toFixed(2)} (Tax: ${entry.tax.toFixed(2)})`).join('\n')}`;
      if (taxData.length > 3) reply += `\n...and ${taxData.length - 3} more. Check your spreadsheet for full details.`;
      await releaseLock(lockKey);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    reply = "⚠️ Invalid tax command. Try: 'tax rate' or 'export tax'";
    await releaseLock(lockKey);
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  } catch (error) {
    console.error(`Error in handleTax: ${error.message}`);
    await releaseLock(lockKey);
    throw error;
  }
}

module.exports = { handleTax };