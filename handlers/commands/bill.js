const { saveBill, updateBill, deleteBill, getActiveJob } = require('../../services/postgres');
const { handleInputWithAI, parseBillMessage, categorizeEntry, handleError } = require('../../utils/aiErrorHandler');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('../../utils/stateManager');

async function handleBill(from, input, userProfile, ownerId, ownerProfile, isOwner) {
  try {
    const msg = input?.trim().toLowerCase() || '';
    const state = (await getPendingTransactionState(from)) || {};

    if (!isOwner) {
      return `<Response><Message>⚠️ Only the owner can manage bills.</Message></Response>`;
    }

    if (msg.includes('help')) {
      return `<Response><Message>I can help with bills. Try ‘bill Truck Payment $760 monthly’, ‘edit bill Truck Payment amount $800’, or ‘delete bill Truck Payment’. What would you like to do?</Message></Response>`;
    }

    // Two-step confirmation for bill creation or deletion
    if (state.pendingBill || (state.pendingDelete?.type === 'bill')) {
      if (msg === 'yes') {
        if (state.pendingBill) {
          const { date, billName, amount, recurrence, suggestedCategory } = state.pendingBill;
          const category = suggestedCategory || (await categorizeEntry('bill', state.pendingBill, ownerProfile));
          const jobName = await getActiveJob(ownerId) || 'Uncategorized';
          await saveBill(ownerId, { date, billName, amount, recurrence, category, jobName });
          await deletePendingTransactionState(from);
          return `<Response><Message>✅ Bill logged: ${amount} for ${billName} (${recurrence}, Category: ${category})${jobName !== 'Uncategorized' ? ` for job ${jobName}` : ''}.</Message></Response>`;
        } else if (state.pendingDelete?.type === 'bill') {
          const success = await deleteBill(ownerId, state.pendingDelete.billName);
          await deletePendingTransactionState(from);
          return `<Response><Message>${success ? `✅ Bill "${state.pendingDelete.billName}" deleted.` : `⚠️ Bill "${state.pendingDelete.billName}" not found or deletion failed.`}</Message></Response>`;
        }
      } else if (msg === 'no' || msg === 'cancel') {
        await deletePendingTransactionState(from);
        return `<Response><Message>❌ Operation cancelled.</Message></Response>`;
      } else if (msg === 'edit') {
        await deletePendingTransactionState(from);
        await setPendingTransactionState(from, { isEditing: true, type: 'bill' });
        return `<Response><Message>✏️ Okay, please resend the correct bill details (e.g., 'bill Truck Payment $760 monthly').</Message></Response>`;
      } else {
        const target = state.pendingBill || state.pendingDelete;
        const errors = await detectErrors(target, 'bill');
        let category = 'N/A';
        if (errors && state.pendingBill) {
          const corrections = await correctErrorsWithAI(`Error in bill input: ${input} - ${JSON.stringify(errors)}`);
          if (corrections) {
            await setPendingTransactionState(from, {
              pendingBill: { ...state.pendingBill, suggestedCategory: category },
              pendingCorrection: true,
              suggestedCorrections: corrections,
              type: 'bill'
            });
            const correctionText = Object.entries(corrections).map(([k, v]) => `${k}: ${target[k] || 'missing'} → ${v}`).join('\n');
            reply = `🤔 Issues detected:\n${correctionText}\nReply 'yes' to accept, 'no' to edit, or 'cancel' to discard.\nSuggested Category: ${category}`;
          } else {
            reply = `⚠️ Please respond with 'yes', 'no', 'edit', or 'cancel' to proceed.\nSuggested Category: ${category}`;
          }
        } else {
          reply = `⚠️ Please respond with 'yes', 'no', 'edit', or 'cancel' to proceed.`;
        }
        await setPendingTransactionState(from, state);
        const prefix = state.pendingBill
          ? `Please confirm: Bill "${state.pendingBill.billName}" for ${userProfile.country === 'United States' ? 'USD' : 'CAD'} ${state.pendingBill.amount} (${state.pendingBill.recurrence})`
          : `Please confirm: Delete bill "${state.pendingDelete.billName}"`;
        return `<Response><Message>${prefix}\n${reply}</Message></Response>`;
      }
    }

    // Edit bill
    if (msg.startsWith('edit bill ')) {
      const match = input.match(/edit bill\s+(.+?)(?:\s+amount\s+(\$?\d+\.?\d*))?(?:\s+due\s+(.+?))?(?:\s+(yearly|monthly|weekly|bi-weekly|one-time))?/i);
      if (!match) {
        return `<Response><Message>⚠️ Format: 'edit bill [name] amount $[X] due [date] [recurrence]' (e.g., 'edit bill Rent amount $600 due June 1st monthly')</Message></Response>`;
      }
      const [, billName, amount, dueDate, recurrence] = match;
      const billData = {
        billName,
        date: dueDate ? new Date(dueDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
        amount: amount ? `$${parseFloat(amount.replace('$', '')).toFixed(2)}` : null,
        recurrence: recurrence || null
      };
      const success = await updateBill(ownerId, billData);
      return `<Response><Message>${success ? `✅ Bill "${billName}" updated${amount ? ` to ${billData.amount}` : ''}${dueDate ? ` due ${dueDate}` : ''}${recurrence ? ` (${recurrence})` : ''}.` : `⚠️ Bill "${billName}" not found or update failed.`}</Message></Response>`;
    }

    // Delete bill
    if (msg.startsWith('delete bill ')) {
      const billName = input.replace(/^delete bill\s+/i, '').trim();
      if (!billName) {
        return `<Response><Message>⚠️ Please provide a bill name. Try: 'delete bill Truck Payment'</Message></Response>`;
      }
      await setPendingTransactionState(from, { pendingDelete: { type: 'bill', billName } });
      return `<Response><Message>Are you sure you want to delete bill '${billName}'? Reply 'yes' or 'no'.</Message></Response>`;
    }

    // Create bill
    if (msg.includes('bill')) {
      const defaultData = { date: new Date().toISOString().split('T')[0], billName: 'Unknown', amount: '$0.00', recurrence: 'one-time' };
      const { data, reply, confirmed } = await handleInputWithAI(from, input, 'bill', parseBillMessage, defaultData);
      if (!confirmed) {
        return `<Response><Message>${reply}</Message></Response>`;
      }
      const { date, billName, amount, recurrence } = data;
      const category = await categorizeEntry('bill', data, ownerProfile);
      await setPendingTransactionState(from, { pendingBill: { date, billName, amount, recurrence, suggestedCategory: category } });
      return `<Response><Message>Please confirm: Bill "${billName}" for ${userProfile.country === 'United States' ? 'USD' : 'CAD'} ${amount} (${recurrence})</Message></Response>`;
    }

    // Fallback handled by routes/webhook.js
    return null;
  } catch (error) {
    console.error(`[ERROR] handleBill failed for ${from}:`, error.message);
    return await handleError(from, error, 'handleBill', input);
  }
}

module.exports = { handleBill };