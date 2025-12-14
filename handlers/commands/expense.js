const { query, getActiveJob } = require('../../services/postgres');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('../../utils/stateManager');
const { handleInputWithAI, parseExpenseMessage, detectErrors, categorizeEntry } = require('../../utils/aiErrorHandler');
const { validateCIL } = require('../../cil'); // src/cil/index.js -> exports validateCIL

/**
 * --- Step 3.4 (DB idempotency) ---
 * We'll attempt to write source_msg_id if the column exists.
 * If it doesn't exist, we fall back to the legacy insert.
 *
 * You SHOULD still add:
 *  - ALTER TABLE transactions ADD COLUMN source_msg_id text;
 *  - CREATE UNIQUE INDEX ... ON transactions(owner_id, source_msg_id) WHERE type='expense';
 */

// Cache whether transactions.source_msg_id exists
let _hasSourceMsgIdCol = null;
async function hasSourceMsgIdColumn() {
  if (_hasSourceMsgIdCol !== null) return _hasSourceMsgIdCol;
  try {
    const r = await query(
      `select 1
         from information_schema.columns
        where table_name = 'transactions'
          and column_name = 'source_msg_id'
        limit 1`
    );
    _hasSourceMsgIdCol = r?.rows?.length > 0;
  } catch {
    _hasSourceMsgIdCol = false;
  }
  return _hasSourceMsgIdCol;
}

async function saveExpense({ ownerId, date, item, amount, store, jobName, category, user, sourceMsgId }) {
  console.log(`[DEBUG] saveExpense called for ownerId: ${ownerId}`);
  const amt = parseFloat(String(amount).replace('$', ''));

  try {
    const canUseMsgId = await hasSourceMsgIdColumn();

    if (canUseMsgId) {
      // Idempotent insert (no dupes if Twilio retries)
      // Requires unique index on (owner_id, source_msg_id) for type='expense'
      const res = await query(
        `INSERT INTO transactions (owner_id, type, date, item, amount, store, job_name, category, user_name, source_msg_id, created_at)
         VALUES ($1, 'expense', $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [ownerId, date, item, amt, store, jobName, category, user, String(sourceMsgId || '')]
      );

      // If conflict happened, rows will be empty (already processed)
      if (!res.rows.length) {
        console.log(`[DEBUG] saveExpense idempotent no-op (duplicate msg): ${sourceMsgId}`);
        return { inserted: false };
      }

      console.log(`[DEBUG] saveExpense success for ${ownerId} id=${res.rows[0].id}`);
      return { inserted: true, id: res.rows[0].id };
    }

    // Legacy insert (non-idempotent)
    await query(
      `INSERT INTO transactions (owner_id, type, date, item, amount, store, job_name, category, user_name, created_at)
       VALUES ($1, 'expense', $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [ownerId, date, item, amt, store, jobName, category, user]
    );
    console.log(`[DEBUG] saveExpense success for ${ownerId} (legacy insert)`);
    return { inserted: true };
  } catch (error) {
    console.error(`[ERROR] saveExpense failed for ${ownerId}:`, error.message);
    throw error;
  }
}

async function deleteExpense(ownerId, criteria) {
  console.log(`[DEBUG] deleteExpense called for ownerId: ${ownerId}, criteria:`, criteria);
  try {
    const res = await query(
      `DELETE FROM transactions
       WHERE owner_id = $1 AND type = 'expense' AND item = $2 AND amount = $3 AND store = $4
       RETURNING *`,
      [ownerId, criteria.item, parseFloat(String(criteria.amount).replace('$', '')), criteria.store]
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
    await query(
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

/**
 * CIL helpers (Step 2.3 gate)
 */
function toCents(amountStr) {
  const n = Number(String(amountStr || '').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function buildExpenseCIL({ ownerId, from, userProfile, data, jobName, category, sourceMsgId }) {
  const cents = toCents(data.amount);

  return {
    cil_version: "1.0",
    type: "expense",
    tenant_id: String(ownerId),
    source: "whatsapp",
    source_msg_id: String(sourceMsgId),

    actor: {
      actor_id: String(userProfile?.user_id || from || "unknown"),
      role: "owner",
      phone_e164: from && String(from).startsWith("+") ? String(from) : undefined,
    },

    occurred_at: new Date().toISOString(),
    job: jobName ? { job_name: String(jobName) } : null,
    needs_job_resolution: !jobName,

    total_cents: cents,
    currency: "CAD",

    vendor: data.store && data.store !== 'Unknown Store' ? String(data.store) : undefined,
    memo: data.item && data.item !== 'Unknown' ? String(data.item) : undefined,
    category: category ? String(category) : undefined,
  };
}

function assertExpenseCILOrClarify({ ownerId, from, userProfile, data, jobName, category, sourceMsgId }) {
  try {
    const cil = buildExpenseCIL({ ownerId, from, userProfile, data, jobName, category, sourceMsgId });
    validateCIL(cil);
    return { ok: true, cil };
  } catch (e) {
    return {
      ok: false,
      reply: `⚠️ Couldn't log that expense yet. Try: "expense 84.12 nails from Home Depot".`
    };
  }
}

/**
 * NOTE: handleExpense returns TwiML string.
 * Webhook must res.send() it (which you already fixed).
 */
async function handleExpense(from, input, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId) {
  const lockKey = `lock:${from}`;

  // Step 3.3: canonical msgId used everywhere
  const msgId = String(sourceMsgId || '').trim() || `${from}:${Date.now()}`;

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

      // CONFIRM EXPENSE
      if (lc === 'yes' && pending.pendingExpense) {
        const data = pending.pendingExpense;
        const category = data.suggestedCategory || await categorizeEntry('expense', data, ownerProfile);
        const jobName = await getActiveJob(ownerId) || 'Uncategorized';

        const gate = assertExpenseCILOrClarify({ ownerId, from, userProfile, data, jobName, category, sourceMsgId: msgId });
        if (!gate.ok) {
          return `<Response><Message>${gate.reply}</Message></Response>`;
        }

        const result = await saveExpense({
          ownerId,
          date: data.date,
          item: data.item,
          amount: data.amount,
          store: data.store,
          jobName,
          category,
          user: userProfile.name || 'Unknown User',
          sourceMsgId: msgId
        });

        // If duplicate, treat as already logged
        if (result && result.inserted === false) {
          reply = `✅ Already logged that expense (duplicate message).`;
        } else {
          reply = `✅ Expense logged: ${data.amount} for ${data.item} from ${data.store} (Category: ${category})`;
        }

        await deletePendingTransactionState(from);
        return `<Response><Message>${reply}</Message></Response>`;
      }

      // CONFIRM DELETE
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

      // fallback confirm prompt
      reply = pending.pendingExpense
        ? `Please confirm: Expense ${pending.pendingExpense.amount} for ${pending.pendingExpense.item}\n⚠️ Please reply "yes", "no", or "edit".`
        : `Please confirm: Delete expense ${pending.pendingDelete.amount} for ${pending.pendingDelete.item}\n⚠️ Please reply "yes", "no", or "edit".`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    // DELETE EXPENSE REQUEST
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

    // INDUSTRY GATE
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

    // DIRECT PARSE PATH
    const m = input.match(/^(?:expense\s+)?\$?(\d+(?:\.\d{1,2})?)\s+(.+?)(?:\s+from\s+(.+))?$/i);
    if (m) {
      const [, amount, item, store] = m;
      const date = new Date().toISOString().split('T')[0];
      const jobName = await getActiveJob(ownerId) || 'Uncategorized';
      const data = { date, item, amount: `$${parseFloat(amount).toFixed(2)}`, store: store || 'Unknown Store' };
      const category = await categorizeEntry('expense', data, ownerProfile);

      const gate = assertExpenseCILOrClarify({ ownerId, from, userProfile, data, jobName, category, sourceMsgId: msgId });
      if (!gate.ok) {
        return `<Response><Message>${gate.reply}</Message></Response>`;
      }

      const result = await saveExpense({
        ownerId,
        date,
        item,
        amount: data.amount,
        store: store || 'Unknown Store',
        jobName,
        category,
        user: userProfile.name || 'Unknown User',
        sourceMsgId: msgId
      });

      if (result && result.inserted === false) {
        reply = `✅ Already logged that expense (duplicate message).`;
      } else {
        reply = `✅ Expense logged: ${data.amount} for ${item} from ${store || 'Unknown Store'} on ${jobName} (Category: ${category})`;
      }

      return `<Response><Message>${reply}</Message></Response>`;
    }

    // AI PATH
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
      const category = await categorizeEntry('expense', data, ownerProfile);

      if (confirmed) {
        const jobName = await getActiveJob(ownerId) || 'Uncategorized';

        const gate = assertExpenseCILOrClarify({ ownerId, from, userProfile, data, jobName, category, sourceMsgId: msgId });
        if (!gate.ok) {
          return `<Response><Message>${gate.reply}</Message></Response>`;
        }

        const result = await saveExpense({
          ownerId,
          date: data.date,
          item: data.item,
          amount: data.amount,
          store: data.store,
          jobName,
          category,
          user: userProfile.name || 'Unknown User',
          sourceMsgId: msgId
        });

        if (result && result.inserted === false) {
          reply = `✅ Already logged that expense (duplicate message).`;
        } else {
          reply = `✅ Expense logged: ${data.amount} for ${data.item} from ${data.store} on ${jobName} (Category: ${category})`;
        }

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
  try {
    await require('../../middleware/lock').releaseLock(lockKey);
  } catch {
    // If lock middleware isn't available in serverless bundle, never hard-fail
  }
}

}

module.exports = { handleExpense };
