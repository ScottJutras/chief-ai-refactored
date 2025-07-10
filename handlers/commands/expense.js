const { Pool } = require('pg');
const { getActiveJob } = require('../../services/postgres');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('../../utils/stateManager');
const { handleInputWithAI, parseExpenseMessage, detectErrors, categorizeEntry } = require('../utils/aiErrorHandler');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function saveExpense({ ownerId, date, item, amount, store, jobName, category, user }) {
  console.log(`[DEBUG] saveExpense called for ownerId: ${ownerId}`);
  try {
    await pool.query(
      `INSERT INTO transactions (owner_id, type, date, item, amount, store, job_name, category, user_name, created_at)
       VALUES ($1, 'expense', $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [ownerId, date, item, parseFloat(amount.replace('$', '')), store, jobName, category, user]
    );
    console.log(`[DEBUG] saveExpense success for ${ownerId}`);
  } catch (error) {
    console.error(`[ERROR] saveExpense failed for ${ownerId}:`, error.message);
    throw error;
  }
}

async function deleteExpense(ownerId, criteria) {
  console.log(`[DEBUG] deleteExpense called for ownerId: ${ownerId}, criteria:`, criteria);
  try {
    const res = await pool.query(
      `DELETE FROM transactions
       WHERE owner_id = $1 AND type = 'expense' AND item = $2 AND amount = $3 AND store = $4
       RETURNING *`,
      [ownerId, criteria.item, parseFloat(criteria.amount.replace('$', '')), criteria.store]
    );
    console.log(`[DEBUG] deleteExpense result:`, res.rows[0]);
    return res.rows.length > 0;
  } catch (error) {
    console.error(`[ERROR] deleteExpense failed for ${ownerId}:`, error.message);
    return false;
  }
}

async function saveUserProfile(userProfile) {
  console.log(`[DEBUG] saveUserProfile called for userId: ${userProfile.user_id}`);
  try {
    await pool.query(
      `UPDATE users
       SET industry = $1, updated_at = NOW()
       WHERE user_id = $2`,
      [userProfile.industry, userProfile.user_id]
    );
    console.log(`[DEBUG] saveUserProfile success for ${userProfile.user_id}`);
  } catch (error) {
    console.error(`[ERROR] saveUserProfile failed for ${userProfile.user_id}:`, error.message);
    throw error;
  }
}

function parseDeleteRequest(input) {
  const match = input.match(/^delete expense\s+\$?(\d+(?:\.\d{1,2})?)\s+(.+?)(?:\s+from\s+(.+))?$/i);
  if (!match) return { type: null, criteria: null };
  return {
    type: 'expense',
    criteria: {
      amount: `$${parseFloat(match[1]).toFixed(2)}`,
      item: match[2].trim(),
      store: match[3]?.trim() || 'Unknown Store'
    }
  };
}

async function handleExpense(from, input, userProfile, ownerId, ownerProfile, isOwner) {
  const lockKey = `lock:${from}`;
  let reply;

  try {
    const defaultData = {
      date: new Date().toISOString().split('T')[0],
      item: 'Unknown',
      amount: '$0.00',
      store: 'Unknown Store'
    };

    const pending = await getPendingTransactionState(from);
    if (pending?.pendingExpense || pending?.pendingDelete?.type === 'expense') {
      if (!isOwner) {
        await deletePendingTransactionState(from);
        reply = '⚠️ Only the owner can manage expenses.';
        return `<Response><Message>${reply}</Message></Response>`;
      }

      const lc = input.toLowerCase().trim();
      if (lc === 'yes' && pending.pendingExpense) {
        const data = pending.pendingExpense;
        const category = data.suggestedCategory || await categorizeEntry('expense', data, ownerProfile);
        await saveExpense({
          ownerId,
          date: data.date,
          item: data.item,
          amount: data.amount,
          store: data.store,
          jobName: await getActiveJob(ownerId) || 'Uncategorized',
          category,
          user: userProfile.name || 'Unknown User'
        });
        reply = `✅ Expense logged: ${data.amount} for ${data.item} from ${data.store} (Category: ${category})`;
        await deletePendingTransactionState(from);
        return `<Response><Message>${reply}</Message></Response>`;
      }

      if (lc === 'yes' && pending.pendingDelete?.type === 'expense') {
        const criteria = pending.pendingDelete;
        const success = await deleteExpense(ownerId, criteria);
        reply = success
          ? `✅ Deleted expense ${criteria.amount} for ${criteria.item} from ${criteria.store}.`
          : `⚠️ Expense not found or deletion failed.`;
        await deletePendingTransactionState(from);
        return `<Response><Message>${reply}</Message></Response>`;
      }

      if (['no', 'cancel'].includes(lc)) {
        await deletePendingTransactionState(from);
        reply = '❌ Operation cancelled.';
        return `<Response><Message>${reply}</Message></Response>`;
      }

      if (lc === 'edit') {
        await setPendingTransactionState(from, { isEditing: true, type: 'expense' });
        reply = '✏️ Okay, please resend the correct expense details.';
        return `<Response><Message>${reply}</Message></Response>`;
      }

      const target = pending.pendingExpense || pending.pendingDelete;
      const errors = await detectErrors(target, 'expense');
      const category = pending.pendingExpense ? await categorizeEntry('expense', pending.pendingExpense, ownerProfile) : 'N/A';
      let prompt = '⚠️ Please reply "yes", "no", or "edit".';
      if (errors && pending.pendingExpense) {
        const corrections = await correctErrorsWithAI(`Error in expense input: ${input} - ${JSON.stringify(errors)}`);
        if (corrections) {
          await setPendingTransactionState(from, {
            pendingExpense: pending.pendingExpense,
            pendingCorrection: true,
            suggestedCorrections: corrections,
            type: 'expense'
          });
          const text = Object.entries(corrections).map(([k, v]) => `${k}: ${pending.pendingExpense[k] || 'missing'} → ${v}`).join('\n');
          prompt = `🤔 Issues detected:\n${text}\n${prompt}\nSuggested Category: ${category}`;
        }
      }
      reply = pending.pendingExpense
        ? `Please confirm: Expense ${pending.pendingExpense.amount} for ${pending.pendingExpense.item}\n${prompt}`
        : `Please confirm: Delete expense ${pending.pendingDelete.amount} for ${pending.pendingDelete.item}\n${prompt}`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    if (input.toLowerCase().startsWith('delete expense')) {
      if (!isOwner) {
        reply = '⚠️ Only the owner can delete expense entries.';
        return `<Response><Message>${reply}</Message></Response>`;
      }
      const req = parseDeleteRequest(input);
      if (req.type !== 'expense') {
        reply = `⚠️ Invalid delete request. Try "delete expense $100 tools from Home Depot".`;
        return `<Response><Message>${reply}</Message></Response>`;
      }

      await setPendingTransactionState(from, { pendingDelete: { type: 'expense', ...req.criteria } });
      reply = `Please confirm: Delete expense ${req.criteria.amount} for ${req.criteria.item}? Reply yes/no.`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    if (!userProfile.industry) {
      await setPendingTransactionState(from, { pendingIndustry: true });
      reply = 'Please provide your industry (e.g., Construction, Freelancer).';
      return `<Response><Message>${reply}</Message></Response>`;
    }
    if (pending?.pendingIndustry) {
      userProfile.industry = input;
      await saveUserProfile(userProfile);
      reply = `Got it, ${userProfile.name}! Industry set to ${input}. Now, let's log that expense.`;
      await deletePendingTransactionState(from);
      return `<Response><Message>${reply}</Message></Response>`;
    }

    const m = input.match(/^(?:expense\s+)?\$?(\d+(?:\.\d{1,2})?)\s+(.+?)(?:\s+from\s+(.+))?$/i);
    if (m) {
      const [, amount, item, store] = m;
      const date = new Date().toISOString().split('T')[0];
      const jobName = await getActiveJob(ownerId) || 'Uncategorized';
      const data = { date, item, amount: `$${parseFloat(amount).toFixed(2)}`, store: store || 'Unknown Store' };
      const category = await categorizeEntry('expense', data, ownerProfile);

      await saveExpense({ ownerId, date, item, amount: data.amount, store, jobName, category, user: userProfile.name || 'Unknown User' });
      reply = `✅ Expense logged: ${data.amount} for ${item} from ${store || 'Unknown Store'} on ${jobName} (Category: ${category})`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    const { data, reply: aiReply, confirmed } = await handleInputWithAI(
      from,
      input,
      'expense',
      parseExpenseMessage,
      defaultData
    );
    if (aiReply) {
      return `<Response><Message>${aiReply}</Message></Response>`;
    }

    if (data && data.amount && data.amount !== '$0.00' && data.item && data.store) {
      const errors = await detectErrors(data, 'expense');
      const category = await categorizeEntry('expense', data, ownerProfile);
      data.suggestedCategory = category;

      if (errors) {
        const corrections = await correctErrorsWithAI(`Error in expense input: ${input} - ${JSON.stringify(errors)}`);
        if (corrections) {
          await setPendingTransactionState(from, {
            pendingExpense: data,
            pendingCorrection: true,
            suggestedCorrections: corrections,
            type: 'expense'
          });
          const text = Object.entries(corrections).map(([k, v]) => `${k}: ${data[k] || 'missing'} → ${v}`).join('\n');
          reply = `🤔 Issues detected:\n${text}\nReply yes/no/edit.\nSuggested Category: ${category}`;
          return `<Response><Message>${reply}</Message></Response>`;
        }
      }

      if (confirmed) {
        await saveExpense({
          ownerId,
          date: data.date,
          item: data.item,
          amount: data.amount,
          store: data.store,
          jobName: await getActiveJob(ownerId) || 'Uncategorized',
          category,
          user: userProfile.name || 'Unknown User'
        });
        reply = `✅ Expense logged: ${data.amount} for ${data.item} from ${data.store} on ${await getActiveJob(ownerId) || 'Uncategorized'} (Category: ${category})`;
        return `<Response><Message>${reply}</Message></Response>`;
      }
    }

    reply = `🤔 Couldn’t parse an expense from "${input}". Try "expense $100 tools from Home Depot".`;
    return `<Response><Message>${reply}</Message></Response>`;
  } catch (error) {
    console.error(`[ERROR] handleExpense failed for ${from}:`, error.message);
    reply = `⚠️ Failed to process expense: ${error.message}`;
    return `<Response><Message>${reply}</Message></Response>`;
  } finally {
    await require('../middleware/lock').releaseLock(lockKey);
  }
}

module.exports = { handleExpense };