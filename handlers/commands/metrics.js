const { parseFinancialQuery } = require('../../services/openAI');
const { getAuthorizedClient } = require('../../services/postgres.js');
const { google } = require('googleapis');
const { db } = require('../../services/firebase');

async function handleMetrics(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  const lockKey = `lock:${from}`;
  let reply;

  try {
    // Parse the financial query using OpenAI
    const query = await parseFinancialQuery(input);
    if (query.intent === 'unknown' || query.response) {
      reply = query.response || `⚠️ Couldn’t understand the query "${input}". Try: "profit on Roof Repair for this month"`;
      await db.collection('locks').doc(lockKey).delete();
      console.log(`[LOCK] Released lock for ${from} (invalid query)`);
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // Fetch data from Google Sheets
    const auth = await getAuthorizedClient();
    const sheets = google.sheets({ version: 'v4', auth });
    const expenses = await sheets.spreadsheets.values.get({
      spreadsheetId: ownerProfile.spreadsheetId,
      range: 'Sheet1!A:I'
    });
    const revenues = await sheets.spreadsheets.values.get({
      spreadsheetId: ownerProfile.spreadsheetId,
      range: 'Revenue!A:I'
    });

    // Filter data by job and period
    let expenseData = (expenses.data.values || []).slice(1).filter(row => row[5] === 'expense' || row[5] === 'bill');
    let revenueData = (revenues.data.values || []).slice(1).filter(row => row[5] === 'revenue');

    if (query.job) {
      expenseData = expenseData.filter(row => row[4] === query.job);
      revenueData = revenueData.filter(row => row[4] === query.job);
    }

    if (query.period) {
      const now = new Date();
      const yearStart = new Date(now.getFullYear(), 0, 1);
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      let startDate, endDate;

      if (query.period === 'ytd') {
        startDate = yearStart;
        endDate = now;
      } else if (query.period === 'month') {
        startDate = monthStart;
        endDate = now;
      } else if (query.period === 'specific month') {
        const monthMatch = input.match(/(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/i);
        if (monthMatch) {
          const monthIndex = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].indexOf(monthMatch[1].toLowerCase());
          startDate = new Date(parseInt(monthMatch[2]), monthIndex, 1);
          endDate = new Date(parseInt(monthMatch[2]), monthIndex + 1, 0);
        }
      }

      if (startDate && endDate) {
        expenseData = expenseData.filter(row => {
          const rowDate = new Date(row[0]);
          return rowDate >= startDate && rowDate <= endDate;
        });
        revenueData = revenueData.filter(row => {
          const rowDate = new Date(row[0]);
          return rowDate >= startDate && rowDate <= endDate;
        });
      }
    }

    // Calculate metrics
    const totalExpenses = expenseData.reduce((sum, row) => sum + parseFloat(row[2].replace(/[^0-9.]/g, '') || 0), 0);
    const totalRevenue = revenueData.reduce((sum, row) => sum + parseFloat(row[2].replace(/[^0-9.]/g, '') || 0), 0);
    const profit = totalRevenue - totalExpenses;
    const margin = totalRevenue ? (profit / totalRevenue * 100).toFixed(2) : 0;
    const currency = userProfile.country === 'United States' ? 'USD' : 'CAD';

    // Format response based on intent
    let replyData;
    switch (query.intent) {
      case 'profit':
        replyData = `Profit: ${currency} ${profit.toFixed(2)}`;
        break;
      case 'spend':
        replyData = `Expenses: ${currency} ${totalExpenses.toFixed(2)}`;
        break;
      case 'revenue':
        replyData = `Revenue: ${currency} ${totalRevenue.toFixed(2)}`;
        break;
      case 'margin':
        replyData = `Profit Margin: ${margin}%`;
        break;
      default:
        replyData = `Revenue: ${currency} ${totalRevenue.toFixed(2)}\nExpenses: ${currency} ${totalExpenses.toFixed(2)}\nProfit: ${currency} ${profit.toFixed(2)}`;
    }

    reply = `📊 ${query.intent} for ${query.job || 'all jobs'} (${query.period || 'all time'}):\n${replyData}`;
    if (userProfile.goalProgress && query.intent !== 'margin') {
      reply += `\nGoal Progress: ${currency} ${userProfile.goalProgress.current.toFixed(2)} / ${currency} ${userProfile.goalProgress.target.toFixed(2)} (${((userProfile.goalProgress.current / userProfile.goalProgress.target) * 100).toFixed(1)}%)`;
    }

    await db.collection('locks').doc(lockKey).delete();
    console.log(`[LOCK] Released lock for ${from} (metrics)`);
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  } catch (error) {
    console.error(`Error in handleMetrics: ${error.message}`);
    await db.collection('locks').doc(lockKey).delete();
    console.log(`[LOCK] Released lock for ${from} (metrics error)`);
    return res.send(`<Response><Message>⚠️ Failed to fetch metrics: ${error.message}</Message></Response>`);
  }
}

module.exports = { handleMetrics };