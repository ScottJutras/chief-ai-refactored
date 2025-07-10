const { Pool } = require('pg');
const { getPendingTransactionState, deletePendingTransactionState } = require('../../utils/stateManager');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function parseFinancialQuery(input) {
  const lcInput = input.toLowerCase().trim();
  const intents = {
    profit: ['profit', 'earnings', 'net'],
    spend: ['spend', 'expenses', 'costs'],
    revenue: ['revenue', 'income', 'sales'],
    margin: ['margin', 'profit margin']
  };
  let intent = 'summary';
  for (const [key, keywords] of Object.entries(intents)) {
    if (keywords.some(k => lcInput.includes(k))) {
      intent = key;
      break;
    }
  }

  const jobMatch = lcInput.match(/(?:for|on)\s+([\w\s]+)/i);
  const periodMatch = lcInput.match(/(ytd|month|this month|last month|january|february|march|april|may|june|july|august|september|october|november|december)\s*(\d{4})?/i);

  return {
    intent,
    job: jobMatch ? jobMatch[1].trim() : null,
    period: periodMatch ? (periodMatch[1].toLowerCase() === 'ytd' ? 'ytd' : periodMatch[1].toLowerCase() === 'this month' ? 'month' : 'specific month') : null,
    specificMonth: periodMatch && periodMatch[1].toLowerCase() !== 'ytd' && periodMatch[1].toLowerCase() !== 'this month' ? periodMatch[1].toLowerCase() : null,
    year: periodMatch && periodMatch[2] ? parseInt(periodMatch[2]) : null
  };
}

async function handleMetrics(from, input, userProfile, ownerId) {
  const lockKey = `lock:${from}`;
  let reply;

  try {
    const query = await parseFinancialQuery(input);
    if (query.intent === 'unknown') {
      reply = `⚠️ Couldn’t understand the query "${input}". Try: "profit on Roof Repair for this month"`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    let sql = `SELECT type, amount, job_name, date FROM transactions WHERE owner_id = $1`;
    const params = [ownerId];
    if (query.job) {
      sql += ` AND job_name = $${params.length + 1}`;
      params.push(query.job);
    }
    if (query.period) {
      const now = new Date();
      let startDate, endDate;
      if (query.period === 'ytd') {
        startDate = new Date(now.getFullYear(), 0, 1);
        endDate = now;
      } else if (query.period === 'month') {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        endDate = now;
      } else if (query.period === 'specific month') {
        const monthIndex = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].indexOf(query.specificMonth);
        const year = query.year || now.getFullYear();
        startDate = new Date(year, monthIndex, 1);
        endDate = new Date(year, monthIndex + 1, 0);
      }
      sql += ` AND date >= $${params.length + 1} AND date <= $${params.length + 2}`;
      params.push(startDate.toISOString().split('T')[0], endDate.toISOString().split('T')[0]);
    }

    const res = await pool.query(sql, params);
    const expenseData = res.rows.filter(row => row.type === 'expense' || row.type === 'bill');
    const revenueData = res.rows.filter(row => row.type === 'revenue');

    const totalExpenses = expenseData.reduce((sum, row) => sum + parseFloat(row.amount || 0), 0);
    const totalRevenue = revenueData.reduce((sum, row) => sum + parseFloat(row.amount || 0), 0);
    const profit = totalRevenue - totalExpenses;
    const margin = totalRevenue ? (profit / totalRevenue * 100).toFixed(2) : 0;
    const currency = userProfile.country === 'United States' ? 'USD' : 'CAD';

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

    return `<Response><Message>${reply}</Message></Response>`;
  } catch (error) {
    console.error(`[ERROR] handleMetrics failed for ${from}:`, error.message);
    reply = `⚠️ Failed to fetch metrics: ${error.message}`;
    return `<Response><Message>${reply}</Message></Response>`;
  } finally {
    await deletePendingTransactionState(from);
    await require('../middleware/lock').releaseLock(lockKey);
  }
}

module.exports = { handleMetrics };