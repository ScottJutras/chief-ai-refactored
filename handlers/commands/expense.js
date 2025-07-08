// handlers/commands/expense.js

const {
  getActiveJob,
  saveExpense,
  deleteExpense,       // <- you’ll need to add this to services/postgres.js
  saveUserProfile
} = require('../../services/postgres.js');
const {
  parseExpenseMessage,
  handleInputWithAI,
  detectErrors,
  correctErrorsWithAI
} = require('../../utils/aiErrorHandler');
const { categorizeEntry, parseDeleteRequest } = require('../../services/openAI');
const {
  getPendingTransactionState,
  setPendingTransactionState,
  deletePendingTransactionState
} = require('../../utils/stateManager');
const { sendTemplateMessage } = require('../../services/twilio');
const { db } = require('../../services/firebase');
const { confirmationTemplates } = require('../../config');

/**
 * Handles incoming “expense” commands.
 */
async function handleExpense(from, input, userProfile, ownerId, ownerProfile, isOwner, res) {
  const lockKey = `lock:${from}`;
  let reply;

  try {
    const defaultData = {
      date: new Date().toISOString().split('T')[0],
      item: 'Unknown',
      amount: '$0.00',
      store: 'Unknown Store'
    };

    // 1️⃣  Pending confirm/delete flow
    const pending = await getPendingTransactionState(from);
    if (pending?.pendingExpense || pending?.pendingDelete?.type === 'expense') {
      if (!isOwner) {
        await deletePendingTransactionState(from);
        reply = '⚠️ Only the owner can manage expenses.';
        await db.collection('locks').doc(lockKey).delete();
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      const lc = input.toLowerCase();

      // ✅ Confirm add
      if (lc === 'yes' && pending.pendingExpense) {
        const data = pending.pendingExpense;
        const category = data.suggestedCategory
          || await categorizeEntry('expense', data, ownerProfile);

        // Persist in Postgres
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

        reply = confirmationTemplates.expenseSaved(data);
        await deletePendingTransactionState(from);
        await db.collection('locks').doc(lockKey).delete();
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      // 🗑️ Confirm delete
      if (lc === 'yes' && pending.pendingDelete?.type === 'expense') {
        const criteria = pending.pendingDelete;
        const success = await deleteExpense(ownerId, criteria);
        reply = success
          ? `✅ Deleted expense ${criteria.amount} for ${criteria.item} from ${criteria.store}.`
          : `⚠️ Expense not found or deletion failed.`;

        await deletePendingTransactionState(from);
        await db.collection('locks').doc(lockKey).delete();
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      // ❌ Cancel
      if (['no','cancel'].includes(lc)) {
        await deletePendingTransactionState(from);
        reply = '❌ Operation cancelled.';
        await db.collection('locks').doc(lockKey).delete();
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      // ✏️ Edit
      if (lc === 'edit') {
        await setPendingTransactionState(from, { isEditing: true, type: 'expense' });
        reply = '✏️ Okay, please resend the correct expense details.';
        await db.collection('locks').doc(lockKey).delete();
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      // Otherwise re‐prompt with error corrections
      const target = pending.pendingExpense || pending.pendingDelete;
      const errors = detectErrors(target, 'expense');
      const category = pending.pendingExpense
        ? await categorizeEntry('expense', pending.pendingExpense, ownerProfile)
        : 'N/A';

      let prompt = '⚠️ Please reply "yes", "no", or "edit".';
      if (errors && pending.pendingExpense) {
        const corrections = await correctErrorsWithAI(errors);
        if (corrections) {
          await setPendingTransactionState(from, {
            pendingExpense: pending.pendingExpense,
            pendingCorrection: true,
            suggestedCorrections: corrections,
            type: 'expense'
          });
          const text = Object.entries(corrections)
            .map(([k,v]) => `${k}: ${pending.pendingExpense[k] || 'missing'} → ${v}`)
            .join('\n');
          prompt = `🤔 Issues detected:\n${text}\n${prompt}\nSuggested Category: ${category}`;
        }
      }

      await sendTemplateMessage(
        from,
        confirmationTemplates.expense,
        { '1': pending.pendingExpense
            ? `Expense: ${pending.pendingExpense.amount} for ${pending.pendingExpense.item}`
            : `Delete expense: ${pending.pendingDelete.amount} for ${pending.pendingDelete.item}` }
      );
      await db.collection('locks').doc(lockKey).delete();
      return res.send(`<Response><Message>${prompt}</Message></Response>`);
    }

    // 2️⃣  Delete‐expense command
    if (input.toLowerCase().startsWith('delete expense')) {
      if (!isOwner) {
        reply = '⚠️ Only the owner can delete expense entries.';
        await db.collection('locks').doc(lockKey).delete();
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
      const req = await parseDeleteRequest(input);
      if (req.type !== 'expense') {
        reply = `⚠️ Invalid delete request. Try "delete expense $100 tools from Home Depot".`;
        await db.collection('locks').doc(lockKey).delete();
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      await setPendingTransactionState(from, { pendingDelete: { type: 'expense', ...req.criteria } });
      await sendTemplateMessage(from, confirmationTemplates.deleteConfirmation, [
        { type: 'text', text: `Delete expense ${req.criteria.amount} for ${req.criteria.item}? Reply yes/no.` }
      ]);
      await db.collection('locks').doc(lockKey).delete();
      return res.send(`<Response></Response>`);
    }

    // 3️⃣  Industry onboarding
    if (!userProfile.industry) {
      await setPendingTransactionState(from, { pendingIndustry: true });
      reply = 'Please provide your industry (e.g., Construction, Freelancer).';
      await db.collection('locks').doc(lockKey).delete();
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }
    if (pending?.pendingIndustry) {
      userProfile.industry = input;
      await saveUserProfile(userProfile);
      reply = `Got it, ${userProfile.name}! Industry set to ${input}. Now, let's log that expense.`;
      await deletePendingTransactionState(from);
      await db.collection('locks').doc(lockKey).delete();
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // 4️⃣  Quick $match
    const m = input.match(/^(?:expense\s+)?\$?(\d+(?:\.\d{1,2})?)\s+(.+?)(?:\s+from\s+(.+))?$/i);
    if (m) {
      const [, amount, item, store] = m;
      const date = new Date().toISOString().split('T')[0];
      const jobName = await getActiveJob(ownerId) || 'Uncategorized';
      const data = { date, item, amount: `$${parseFloat(amount).toFixed(2)}`, store: store || 'Unknown Store' };
      const category = await categorizeEntry('expense', data, ownerProfile);

      await saveExpense({ ownerId, ...data, jobName, category, user: userProfile.name });
      reply = confirmationTemplates.expenseSaved(data);
      await db.collection('locks').doc(lockKey).delete();
      return res.send(`<Response><Message>${reply}</Message></Response>`);
    }

    // 5️⃣  AI‐parsed expense
    const { data, reply: aiReply, confirmed } = await handleInputWithAI(
      from,
      input,
      'expense',
      parseExpenseMessage,
      defaultData
    );
    if (aiReply) {
      await db.collection('locks').doc(lockKey).delete();
      return res.send(`<Response><Message>${aiReply}</Message></Response>`);
    }

    if (data && data.amount && data.amount !== '$0.00' && data.item && data.store) {
      const errors = detectErrors(data, 'expense');
      const category = await categorizeEntry('expense', data, ownerProfile);
      data.suggestedCategory = category;

      if (errors) {
        const corrections = await correctErrorsWithAI(errors);
        if (corrections) {
          await setPendingTransactionState(from, {
            pendingExpense: data,
            pendingCorrection: true,
            suggestedCorrections: corrections,
            type: 'expense'
          });
          const text = Object.entries(corrections)
            .map(([k,v]) => `${k}: ${data[k] || 'missing'} → ${v}`)
            .join('\n');
          const prompt = `🤔 Issues detected:\n${text}\nReply yes/no/edit.\nSuggested Category: ${category}`;
          await db.collection('locks').doc(lockKey).delete();
          return res.send(`<Response><Message>${prompt}</Message></Response>`);
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
          user: userProfile.name
        });
        reply = confirmationTemplates.expenseSaved(data);
        await db.collection('locks').doc(lockKey).delete();
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }
    }

    // 6️⃣  Fallback
    reply = `🤔 Couldn’t parse an expense from "${input}". Try "expense $100 tools from Home Depot".`;
    await db.collection('locks').doc(lockKey).delete();
    return res.send(`<Response><Message>${reply}</Message></Response>`);
  } catch (err) {
    console.error(`Error in handleExpense: ${err.message}`);
    await db.collection('locks').doc(lockKey).delete();
    return res.send(`<Response><Message>⚠️ Failed: ${err.message}</Message></Response>`);
  }
}

module.exports = { handleExpense };
