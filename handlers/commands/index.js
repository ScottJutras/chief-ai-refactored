// handlers/commands/index.js
// ---------------------------------------------------------------
// Central command orchestrator – keeps the router fast & safe.
// Falls back to per-file handlers; handles onboarding, pending
// confirmations, subscription gates, lock release, and audit.
// ---------------------------------------------------------------
const pg = require('../../services/postgres');
const { releaseLock } = require('../../middleware/lock');
const { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState } = require('../../utils/stateManager');
const { sendTemplateMessage } = require('../../services/twilio');
const confirmationTemplates = require('../../config').confirmationTemplates;

// Lazy-load per-file handlers
let tasksHandler, handleTimeclock, handleJob;
try { ({ tasksHandler } = require('./tasks')); } catch {}
try { ({ handleTimeclock } = require('./timeclock')); } catch {}
try { handleJob = require('./job'); } catch {}

/** Helper – safe lock release */
async function safeCleanup(req) {
  const lockKey = `lock:${req.ownerId || req.from || 'GLOBAL'}`;
  try { await releaseLock(lockKey); } catch {}
}

/** Helper – friendly TwiML */
function twiml(res, body) {
  return res.status(200).type('application/xml')
    .send(`<Response><Message>${body}</Message></Response>`);
}

/** Main orchestrator – returns true when it fully responded */
module.exports = async function handleCommands(
  from, text, userProfile, ownerId, ownerProfile, isOwner, res
) {
  const lc = String(text || '').toLowerCase().trim();

  try {
    // -------------------------------------------------
    // 1. ONBOARDING INTERCEPT
    // -------------------------------------------------
    if (userProfile?.onboarding_in_progress) {
      const onboarding = require('./onboarding');
      const handled = await onboarding.handle(from, text, userProfile, ownerId, res);
      if (handled) {
        await safeCleanup({ ownerId: from });
        return true;
      }
    }

    // -------------------------------------------------
    // 2. PENDING CONFIRMATIONS (expense / revenue / bill)
    // -------------------------------------------------
    const pending = await getPendingTransactionState(from);
    if (pending?.pendingExpense || pending?.pendingRevenue || pending?.pendingBill) {
      const type = pending.pendingExpense ? 'expense' :
                   pending.pendingRevenue ? 'revenue' : 'bill';
      const data = pending[`pending${type.charAt(0).toUpperCase() + type.slice(1)}`];

      if (lc === 'yes') {
        const activeJob = await pg.getActiveJob(ownerId) || 'Uncategorized';
        const category = data.suggestedCategory || await pg.categorizeEntry?.(type, data) || 'Uncategorized';
        await pg.appendToUserSpreadsheet(ownerId, [
          data.date, data.item || data.description || data.billName,
          data.amount, data.store || data.source || '',
          activeJob, type, category, data.mediaUrl || '', userProfile.name || 'Unknown'
        ]);
        await deletePendingTransactionState(from);
        await twiml(res, `Expense logged: ${data.amount} for ${data.item || data.description} from ${data.store || data.source} (Category: ${category})`);
        await safeCleanup({ ownerId: from });
        return true;
      }
      if (lc === 'no' || lc === 'cancel') {
        await deletePendingTransactionState(from);
        await twiml(res, `${type.charAt(0).toUpperCase() + type.slice(1)} cancelled.`);
        await safeCleanup({ ownerId: from });
        return true;
      }
      if (lc === 'edit') {
        await deletePendingTransactionState(from);
        await twiml(res, `Please resend the ${type} details.`);
        await safeCleanup({ ownerId: from });
        return true;
      }
      await twiml(res, `Reply **yes**, **no**, or **edit** to confirm the ${type}.`);
      await safeCleanup({ ownerId: from });
      return true;
    }

    // -------------------------------------------------
    // 3. SUBSCRIPTION GATING (Agent / heavy media)
    // -------------------------------------------------
    const tier = (userProfile?.subscription_tier || 'basic').toLowerCase();
    const needsPro = /agent|deepdive|quote|metrics|receipt|team|pricing/i.test(lc);
    if (needsPro && !['pro', 'enterprise'].includes(tier)) {
      const sent = await sendTemplateMessage(from, confirmationTemplates.upgradeNow, {
        "1": `This feature requires Pro or Enterprise.`
      });
      await safeCleanup({ ownerId: from });
      return sent ? res.send('<Response></Response>') : twiml(res, `Upgrade to Pro to use this feature.`);
    }

    // -------------------------------------------------
    // 4. FALLBACK TO PER-FILE HANDLERS
    // -------------------------------------------------
    if (tasksHandler && await tasksHandler(from, text, userProfile, ownerId, ownerProfile, isOwner, res)) {
      await safeCleanup({ ownerId: from });
      return true;
    }
    if (handleTimeclock && await handleTimeclock(from, text, userProfile, ownerId, ownerProfile, isOwner, res)) {
      await safeCleanup({ ownerId: from });
      return true;
    }
    if (handleJob && await handleJob(from, text, userProfile, ownerId, ownerProfile, isOwner, res)) {
      await safeCleanup({ ownerId: from });
      return true;
    }

    // -------------------------------------------------
    // 5. FINAL HELP / AGENT FALLBACK
    // -------------------------------------------------
    const { ask } = require('../../services/agent');
    const answer = await ask({ from, ownerId, text, topicHints: ['tasks', 'timeclock', 'jobs'] });
    if (answer) {
      await twiml(res, answer);
      await safeCleanup({ ownerId: from });
      return true;
    }

    // Nothing matched
    await twiml(res, `PocketCFO – try "task …", "clock in", or "start job <name>".`);
    await safeCleanup({ ownerId: from });
    return true;
  } catch (err) {
    console.error(`[commands] error for ${from}:`, err?.message);
    await twiml(res, `Something went wrong. Try again.`);
    await safeCleanup({ ownerId: from });
    return true;
  }
};
