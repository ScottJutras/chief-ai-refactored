// handlers/commands/index.js
const { releaseLock } = require('../../middleware/lock');
const { getPendingTransactionState, deletePendingTransactionState } = require('../../utils/stateManager');
const { sendTemplateMessage } = require('../../services/twilio');
const { applyCIL } = require('../../services/cilRouter');
const confirmationTemplates = require('../../config').confirmationTemplates;

// Lazy-load per-file handlers
let tasksHandler, handleTimeclock, handleJob;
try { ({ tasksHandler } = require('./tasks')); } catch {}
try { ({ handleTimeclock } = require('./timeclock')); } catch {}
try { ({ handleJob } = require('./job')); } catch {}

function twiml(res, body) {
  return res
    .status(200)
    .type('application/xml')
    .send(`<Response><Message>${body}</Message></Response>`);
}

async function safeCleanup(req) {
  try {
    await releaseLock(`lock:${req.ownerId || req.from || 'GLOBAL'}`);
  } catch {}
}

// Tiny bootstrap mapper → CIL
function simpleTextToCIL(raw) {
  const lc = String(raw || '').toLowerCase().trim();

  // new lead (very simple)
  if (lc === 'new lead' || /^lead(?:\s|$)/.test(lc)) {
    return { type: 'CreateLead', customer: { name: 'Unknown' } };
  }

  // expense: "expense $100 nails from Home Depot"
  {
    const m = raw.match(/^expense\s+\$?(\d+(?:\.\d{1,2})?)\s+(.+?)(?:\s+from\s+(.+))?$/i);
    if (m) {
      return {
        type: 'LogExpense',
        item: m[2].trim(),
        amount_cents: Math.round(parseFloat(m[1]) * 100),
        store: (m[3] || '').trim() || undefined,
      };
    }
  }

  // revenue: "revenue $500 deposit from Lauren"
  {
    const m = raw.match(/^revenue\s+\$?(\d+(?:\.\d{1,2})?)\s+(.+?)(?:\s+from\s+(.+))?$/i);
    if (m) {
      return {
        type: 'LogRevenue',
        description: m[2].trim(),
        source: (m[3] || '').trim() || undefined,
        amount_cents: Math.round(parseFloat(m[1]) * 100),
      };
    }
  }

  // pricing
  {
    let m = raw.match(/^add material\s+(.+)\s+at\s+\$(\d+(?:\.\d{1,2})?)$/i);
    if (m) {
      return {
        type: 'AddPricingItem',
        item_name: m[1].trim(),
        unit: 'each',
        unit_cost_cents: Math.round(parseFloat(m[2]) * 100),
      };
    }
    m = raw.match(/^update material\s+(.+)\s+to\s+\$(\d+(?:\.\d{1,2})?)$/i);
    if (m) {
      return {
        type: 'UpdatePricingItem',
        item_name: m[1].trim(),
        unit_cost_cents: Math.round(parseFloat(m[2]) * 100),
      };
    }
    m = raw.match(/^delete material\s+(.+)$/i);
    if (m) {
      return {
        type: 'DeletePricingItem',
        item_name: m[1].trim(),
      };
    }
  }

  return null;
}

function toCents(amt) {
  if (amt == null) return 0;
  const n = parseFloat(String(amt).replace(/[^\d.]/g, ''));
  if (!isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

module.exports = async function handleCommands(
  from,
  text,
  userProfile,
  ownerId,
  ownerProfile,
  isOwner,
  res
) {
  const lc = String(text || '').toLowerCase().trim();

  try {
    // 1) Onboarding intercept
    if (userProfile?.onboarding_in_progress) {
      const onboarding = require('./onboarding');
      const handled = await onboarding(from, text, userProfile, ownerId, res);
      if (handled) {
        await safeCleanup({ ownerId: from });
        return true;
      }
    }

    // 2) Pending confirmations (now write into transactions via CIL)
    const pending = await getPendingTransactionState(from);
    if (pending?.pendingExpense || pending?.pendingRevenue || pending?.pendingBill) {
      const type = pending.pendingExpense
        ? 'expense'
        : pending.pendingRevenue
        ? 'revenue'
        : 'bill';

      const yes = lc === 'yes' || lc === 'y';
      const no = lc === 'no' || lc === 'n' || lc === 'cancel';
      const edit = lc === 'edit';

      if (yes) {
        const ctx = {
          owner_id: ownerId,
          actor_phone: from,
          source_msg_id:
            res?.locals?.MessageSid ||
            res?.locals?.SmsMessageSid ||
            `${from}:${Date.now()}`,
        };

        let cil = null;

        if (type === 'expense' && pending.pendingExpense) {
          const d = pending.pendingExpense;
          cil = {
            type: 'LogExpense',
            item: d.item || d.description || d.billName || 'Expense',
            amount_cents: toCents(d.amount),
            store: d.store || d.vendor || undefined,
            date: d.date || undefined,
            category: d.category || undefined,
            media_url: d.mediaUrl || undefined,
          };
        } else if (type === 'revenue' && pending.pendingRevenue) {
          const d = pending.pendingRevenue;
          cil = {
            type: 'LogRevenue',
            description: d.description || 'Revenue',
            amount_cents: toCents(d.amount),
            source: d.source || undefined,
            date: d.date || undefined,
            category: d.category || undefined,
            media_url: d.mediaUrl || undefined,
          };
        } else if (type === 'bill' && pending.pendingBill) {
          const d = pending.pendingBill;
          cil = {
            type: 'LogExpense',
            item: d.billName || d.item || d.description || 'Bill',
            amount_cents: toCents(d.amount),
            store: d.vendor || d.store || undefined,
            date: d.date || undefined,
            category: d.category || 'Bill',
            media_url: d.mediaUrl || undefined,
          };
        }

        if (!cil) {
          await deletePendingTransactionState(from);
          await twiml(res, `I lost the details. Please resend the ${type}.`);
          await safeCleanup({ ownerId: from });
          return true;
        }

        try {
          const result = await applyCIL(cil, ctx);
          await deletePendingTransactionState(from);
          await twiml(res, result?.summary || `${type} logged.`);
        } catch (e) {
          console.error('[commands] applyCIL failed for pending:', e?.message);
          await deletePendingTransactionState(from);
          await twiml(res, `⚠️ I couldn't log that ${type}. Please try again.`);
        }

        await safeCleanup({ ownerId: from });
        return true;
      }

      if (no) {
        await deletePendingTransactionState(from);
        await twiml(
          res,
          `${type.charAt(0).toUpperCase() + type.slice(1)} cancelled.`
        );
        await safeCleanup({ ownerId: from });
        return true;
      }

      if (edit) {
        await deletePendingTransactionState(from);
        await twiml(
          res,
          `${type.charAt(0).toUpperCase() + type.slice(1)} — please resend details.`
        );
        await safeCleanup({ ownerId: from });
        return true;
      }

      await twiml(
        res,
        `Reply yes / no / edit to confirm the ${type}.`
      );
      await safeCleanup({ ownerId: from });
      return true;
    }

    // 3) Subscription gating (unchanged)
    const tier = (userProfile?.subscription_tier || 'basic').toLowerCase();
    const needsPro = /agent|deepdive|quote|metrics|receipt|team|pricing/i.test(lc);
    if (needsPro && !['pro', 'enterprise'].includes(tier)) {
      const sent = await sendTemplateMessage(
        from,
        confirmationTemplates.upgradeNow,
        { '1': `This feature requires Pro or Enterprise.` }
      );
      await safeCleanup({ ownerId: from });
      return sent
        ? res.send('<Response></Response>')
        : twiml(res, `Upgrade to Pro to use this feature.`);
    }

    // 4) CIL first-pass
    const cil = simpleTextToCIL(text);
    if (cil) {
      const ctx = {
        owner_id: ownerId,
        source_msg_id:
          res?.locals?.MessageSid ||
          res?.locals?.SmsMessageSid ||
          `${from}:${Date.now()}`,
        actor_phone: from,
      };
      const result = await applyCIL(cil, ctx);
      await twiml(res, result.summary);
      await safeCleanup({ ownerId: from });
      return true;
    }

    // 5) Fallback to per-file handlers
    if (
      tasksHandler &&
      (await tasksHandler(from, text, userProfile, ownerId, ownerProfile, isOwner, res))
    ) {
      await safeCleanup({ ownerId: from });
      return true;
    }
    if (
      handleTimeclock &&
      (await handleTimeclock(from, text, userProfile, ownerId, ownerProfile, isOwner, res))
    ) {
      await safeCleanup({ ownerId: from });
      return true;
    }
    if (
      handleJob &&
      (await handleJob(from, text, userProfile, ownerId, ownerProfile, isOwner, res))
    ) {
      await safeCleanup({ ownerId: from });
      return true;
    }

    // 6) Agent fallback
    const { ask } = require('../../services/agent');
    const answer = await ask({
      from,
      ownerId,
      text,
      topicHints: ['tasks', 'timeclock', 'jobs'],
    });
    await twiml(
      res,
      answer || `Try "new lead", "expense $100 tools", or "clock in".`
    );
    await safeCleanup({ ownerId: from });
    return true;
  } catch (err) {
    console.error(`[commands] error for ${from}:`, err?.message);
    await twiml(res, `Something went wrong. Try again.`);
    await safeCleanup({ ownerId: from });
    return true;
  }
};
