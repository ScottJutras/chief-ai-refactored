const { getActiveJob, appendToUserSpreadsheet } = require('../../services/postgres');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('../../utils/stateManager');
const { handleInputWithAI, parseRevenueMessage, detectErrors, categorizeEntry } = require('../../utils/aiErrorHandler');

async function handleRevenue(from, input, userProfile, ownerId) {
  const lockKey = `lock:${from}`;
  let reply;

  try {
    const defaultData = {
      date: new Date().toISOString().split('T')[0],
      description: 'Unknown',
      amount: '$0.00',
      source: 'Unknown'
    };

    const pending = await getPendingTransactionState(from);
    if (pending?.pendingRevenue) {
      const lcInput = input.toLowerCase().trim();
      if (lcInput === 'yes') {
        const data = pending.pendingRevenue;
        const category = data.suggestedCategory || await categorizeEntry('revenue', data, userProfile);
        await appendToUserSpreadsheet(ownerId, [
          data.date,
          data.description,
          data.amount,
          data.source,
          await getActiveJob(ownerId) || 'Uncategorized',
          'revenue',
          category,
          null,
          userProfile.name || 'Unknown'
        ]);
        reply = `✅ Revenue logged: ${data.amount} from ${data.source} (Category: ${category})`;
        await deletePendingTransactionState(from);
        return `<Response><Message>${reply}</Message></Response>`;
      } else if (lcInput === 'no' || lcInput === 'edit') {
        reply = '✏️ Okay, please resend the correct revenue details (e.g., "revenue $100 from Client").';
        await setPendingTransactionState(from, { isEditing: true, type: 'revenue' });
        await deletePendingTransactionState(from);
        return `<Response><Message>${reply}</Message></Response>`;
      } else if (lcInput === 'cancel') {
        await deletePendingTransactionState(from);
        reply = '❌ Revenue cancelled.';
        return `<Response><Message>${reply}</Message></Response>`;
      } else {
        const errors = await detectErrors(pending.pendingRevenue, 'revenue');
        const category = await categorizeEntry('revenue', pending.pendingRevenue, userProfile);
        pending.pendingRevenue.suggestedCategory = category;
        if (errors) {
          const corrections = await correctErrorsWithAI(`Error in revenue input: ${input} - ${JSON.stringify(errors)}`);
          if (corrections) {
            await setPendingTransactionState(from, {
              pendingRevenue: pending.pendingRevenue,
              pendingCorrection: true,
              suggestedCorrections: corrections,
              type: 'revenue'
            });
            const text = Object.entries(corrections).map(([k, v]) => `${k}: ${pending.pendingRevenue[k] || 'missing'} - ${v}`).join('\n');
            reply = `🤔 Issues detected:\n${text}\nReply 'yes' to accept, 'no' to edit, or 'cancel'. Suggested Category: ${category}`;
            return `<Response><Message>${reply}</Message></Response>`;
          }
        }
        reply = `⚠️ Please respond with 'yes', 'no', 'edit', or 'cancel' to proceed. Suggested Category: ${category}`;
        return `<Response><Message>${reply}</Message></Response>`;
      }
    }

    const { data, reply: aiReply, confirmed } = await handleInputWithAI(
      from,
      input,
      'revenue',
      parseRevenueMessage,
      defaultData
    );
    if (aiReply) {
      return `<Response><Message>${aiReply}</Message></Response>`;
    }

    if (data && data.amount && data.amount !== '$0.00' && data.description && data.source) {
      const errors = await detectErrors(data, 'revenue');
      const category = await categorizeEntry('revenue', data, userProfile);
      data.suggestedCategory = category;

      if (errors) {
        const corrections = await correctErrorsWithAI(`Error in revenue input: ${input} - ${JSON.stringify(errors)}`);
        if (corrections) {
          await setPendingTransactionState(from, {
            pendingRevenue: data,
            pendingCorrection: true,
            suggestedCorrections: corrections,
            type: 'revenue'
          });
          const text = Object.entries(corrections).map(([k, v]) => `${k}: ${data[k] || 'missing'} → ${v}`).join('\n');
          reply = `🤔 Issues detected:\n${text}\nReply 'yes' to accept, 'no' to edit, or 'cancel'. Suggested Category: ${category}`;
          return `<Response><Message>${reply}</Message></Response>`;
        }
      }

      if (confirmed) {
        await appendToUserSpreadsheet(ownerId, [
          data.date,
          data.description,
          data.amount,
          data.source,
          await getActiveJob(ownerId) || 'Uncategorized',
          'revenue',
          category,
          null,
          userProfile.name || 'Unknown'
        ]);
        reply = `✅ Revenue logged: ${data.amount} from ${data.source} on ${await getActiveJob(ownerId) || 'Uncategorized'} (Category: ${category})`;
        return `<Response><Message>${reply}</Message></Response>`;
      }
    }

    reply = `🤔 Couldn’t parse a revenue from "${input}". Try "revenue $100 from Client".`;
    return `<Response><Message>${reply}</Message></Response>`;
  } catch (error) {
    console.error(`[ERROR] handleRevenue failed for ${from}:`, error.message);
    reply = '⚠️ Error logging revenue. Please try again.';
    return `<Response><Message>${reply}</Message></Response>`;
  } finally {
    await require('../middleware/lock').releaseLock(lockKey);
  }
}

module.exports = { handleRevenue };
