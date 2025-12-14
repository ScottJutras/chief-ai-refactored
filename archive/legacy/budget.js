const { getActiveJob } = require('../../services/postgres');
const { logEvent, saveConvoState } = require('../../services/memory');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function saveBudget(ownerId, jobName, amount) {
  console.log(`[DEBUG] saveBudget called for ownerId: ${ownerId}, jobName: ${jobName}, amount: ${amount}`);
  try {
    const res = await query(
      `INSERT INTO budgets (owner_id, job_name, amount, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (owner_id, job_name)
       DO UPDATE SET amount = $3, updated_at = NOW()
       RETURNING id`,
      [ownerId, jobName, amount]
    );
    console.log(`[DEBUG] saveBudget success, budget ID: ${res.rows[0].id}`);
    return res.rows[0].id;
  } catch (error) {
    console.error(`[ERROR] saveBudget failed for ${ownerId}:`, error.message);
    throw error;
  }
}

async function handleBudget(from, input, userProfile, ownerId, ownerProfile, isOwner, res, convoState) {
  const lockKey = `lock:${from}`;
  const tenantId = ownerId;
  const userId = from;
  let reply;
  try {
    if (!isOwner) {
      reply = `⚠️ Only the owner can set budgets.`;
      await logEvent(tenantId, userId, 'budget.unauthorized', { input });
      return `<Response><Message>${reply}</Message></Response>`;
    }

    const match = input.match(/^budget set\s+([a-z][\w\s'-]{1,50})\s+\$?(\d+(?:\.\d{2})?)$/i);
    if (!match) {
      reply = `⚠️ Invalid budget format. Try: "budget set Kitchen Reno $15000"`;
      await logEvent(tenantId, userId, 'budget.invalid', { input });
      return `<Response><Message>${reply}</Message></Response>`;
    }

    const [, jobName, amount] = match;
    const budgetId = await saveBudget(ownerId, jobName, parseFloat(amount));
    const activeJob = convoState.active_job || await getActiveJob(ownerId);
    reply = `✅ Set budget of $${parseFloat(amount).toFixed(2)} for ${jobName}. Want a spending breakdown?`;
    await logEvent(tenantId, userId, 'budget.set', { budgetId, jobName, amount });
    await saveConvoState(tenantId, userId, {
      history: [...convoState.history, { input, response: reply, intent: 'budget.set' }],
      last_intent: 'budget.set',
      last_args: { job: jobName, amount }
    });
    return `<Response><Message>${reply}</Message></Response>`;
  } catch (error) {
    console.error(`[ERROR] handleBudget failed for ${from}:`, error.message);
    reply = `⚠️ Failed to set budget: ${error.message}`;
    await logEvent(tenantId, userId, 'budget.error', { input, error: error.message });
    return `<Response><Message>${reply}</Message></Response>`;
  } finally {
    await require('../../middleware/lock').releaseLock(lockKey);
  }
}

module.exports = { handleBudget };
