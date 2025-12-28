// handlers/commands/index.js
// COMPLETE DROP-IN (aligned with latest expense.js + revenue.js + timeclock.js + tasks.js patterns)
//
// Key alignments:
// - Stop double-handling confirmations here when per-file handlers own their own pending state
//   (expense/revenue already do confirm/edit/cancel + job picker, and they use Twilio templates).
// - Pass sourceMsgId into handlers when supported (tasks.js already supports it; revenue/expense do too in your versions).
// - More robust TwiML escaping.
// - Keep "simpleTextToCIL" as an optional bootstrap ONLY for commands you *don't* have handlers for.
//   (If you keep it for expense/revenue, you can bypass richer flows — so we gate it behind "no handler present").
// - Centralized source_msg_id extraction (Twilio MessageSid).
// - safeCleanup always releases the from-lock (matches other handlers).

const { releaseLock } = require('../../middleware/lock');
const state = require('../../utils/stateManager');
const getPendingTransactionState =
  state.getPendingTransactionState ||
  (async () => null);
const deletePendingTransactionState =
  state.deletePendingTransactionState ||
  state.deletePendingState ||
  state.clearPendingTransactionState ||
  (async () => null);

const { sendTemplateMessage } = require('../../services/twilio');
const { applyCIL } = require('../../services/cilRouter');
const confirmationTemplates = require('../../config').confirmationTemplates;

// Lazy-load per-file handlers
let tasksHandler, handleTimeclock, handleJob, handleExpense, handleRevenue;
try { ({ tasksHandler } = require('./tasks')); } catch {}
try { ({ handleTimeclock } = require('./timeclock')); } catch {}
try { ({ handleJob } = require('./job')); } catch {}
try { ({ handleExpense } = require('./expense')); } catch {}
try { ({ handleRevenue } = require('./revenue')); } catch {}

function xmlEsc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function twiml(res, body) {
  return res
    .status(200)
    .type('application/xml')
    .send(`<Response><Message>${xmlEsc(String(body || '').trim())}</Message></Response>`);
}

function twimlEmpty(res) {
  return res.status(200).type('application/xml').send('<Response></Response>');
}

function getSourceMsgId(from, res) {
  // Prefer res.locals (if you set it in webhook middleware), else fall back to body fields
  const a = String(res?.locals?.MessageSid || res?.locals?.SmsMessageSid || '').trim();
  if (a) return a;

  const b = res?.req?.body || {};
  const c = String(b.MessageSid || b.SmsMessageSid || b.SmsSid || '').trim();
  if (c) return c;

  return `${String(from || '').trim()}:${Date.now()}`;
}

async function safeCleanup({ from, ownerId }) {
  try {
    await releaseLock(`lock:${from || ownerId || 'GLOBAL'}`);
  } catch {}
}

// Tiny bootstrap mapper → CIL (only for things without dedicated handlers)
function simpleTextToCIL(raw) {
  const lc = String(raw || '').toLowerCase().trim();

  // new lead (very simple)
  if (lc === 'new lead' || /^lead(?:\s|$)/.test(lc)) {
    return { type: 'CreateLead', customer: { name: 'Unknown' } };
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

module.exports = async function handleCommands(from, text, userProfile, ownerId, ownerProfile, isOwner, res) {
  const raw = String(text || '').trim();
  const lc = raw.toLowerCase();

  const sourceMsgId = getSourceMsgId(from, res);

  try {
    // 1) Onboarding intercept
    if (userProfile?.onboarding_in_progress) {
      const onboarding = require('./onboarding');
      const handled = await onboarding(from, raw, userProfile, ownerId, res);
      if (handled) {
        await safeCleanup({ from, ownerId });
        return true;
      }
    }

    // 2) IMPORTANT: If expense/revenue handlers exist, let them own confirm/edit/cancel flows.
    //    We only keep legacy pending confirmation routing if those handlers are missing.
    if (!handleExpense && !handleRevenue) {
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
          const ctx = { owner_id: ownerId, actor_phone: from, source_msg_id: sourceMsgId };
          let cil = null;

          // NOTE: These are minimal legacy CILs.
          // If you still want richer job selection + templates, keep the dedicated handlers enabled.
          const toCents = (amt) => {
            const n = parseFloat(String(amt || '').replace(/[^\d.]/g, ''));
            if (!isFinite(n) || n < 0) return 0;
            return Math.round(n * 100);
          };

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
            twiml(res, `I lost the details. Please resend the ${type}.`);
            await safeCleanup({ from, ownerId });
            return true;
          }

          try {
            const result = await applyCIL(cil, ctx);
            await deletePendingTransactionState(from);
            twiml(res, result?.summary || `${type} logged.`);
          } catch (e) {
            console.error('[commands] applyCIL failed for pending:', e?.message);
            await deletePendingTransactionState(from);
            twiml(res, `⚠️ I couldn't log that ${type}. Please try again.`);
          }

          await safeCleanup({ from, ownerId });
          return true;
        }

        if (no) {
          await deletePendingTransactionState(from);
          twiml(res, `${type.charAt(0).toUpperCase() + type.slice(1)} cancelled.`);
          await safeCleanup({ from, ownerId });
          return true;
        }

        if (edit) {
          await deletePendingTransactionState(from);
          twiml(res, `${type.charAt(0).toUpperCase() + type.slice(1)} — please resend details.`);
          await safeCleanup({ from, ownerId });
          return true;
        }

        twiml(res, `Reply yes / no / edit to confirm the ${type}.`);
        await safeCleanup({ from, ownerId });
        return true;
      }
    }

    // 3) Subscription gating (unchanged)
    const tier = String(userProfile?.subscription_tier || 'basic').toLowerCase();
    const needsPro = /agent|deepdive|quote|metrics|receipt|team|pricing/i.test(lc);
    if (needsPro && !['pro', 'enterprise'].includes(tier)) {
      const sent = await sendTemplateMessage(from, confirmationTemplates.upgradeNow, {
        '1': `This feature requires Pro or Enterprise.`,
      });

      await safeCleanup({ from, ownerId });

      // If REST template send worked, don't also send TwiML
      return sent ? twimlEmpty(res) : twiml(res, `Upgrade to Pro to use this feature.`);
    }

    // 4) Dedicated handlers first (so they can manage stateful flows cleanly)
    // Expense + Revenue should run before task/timeclock/job so they can consume confirmations, job pickers, etc.
    if (handleExpense && /^expense\b/i.test(lc)) {
      const out = await handleExpense(from, raw, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId);
      // expense handler returns TwiML string (in your drop-in), so send it here.
      res.status(200).type('application/xml').send(out);
      await safeCleanup({ from, ownerId });
      return true;
    }

    if (handleRevenue && /^revenue\b/i.test(lc) || (handleRevenue && /^(received|got paid|payment)\b/i.test(lc))) {
      // NOTE: your revenue handler expects to return TwiML string (in your drop-in)
      const out = await handleRevenue(from, raw, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId);
      res.status(200).type('application/xml').send(out);
      await safeCleanup({ from, ownerId });
      return true;
    }

    // If the user is replying "yes/edit/cancel" and we have expense/revenue handlers enabled,
    // DO NOT intercept here — let those handlers pick it up based on pending state.
    // We'll just fall through to them below.

    if (tasksHandler) {
      const handled = await tasksHandler(from, raw, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId);
      if (handled) {
        await safeCleanup({ from, ownerId });
        return true;
      }
    }

    if (handleTimeclock) {
      const handled = await handleTimeclock(from, raw, userProfile, ownerId, ownerProfile, isOwner, res);
      if (handled) {
        await safeCleanup({ from, ownerId });
        return true;
      }
    }

    if (handleJob) {
      const handled = await handleJob(from, raw, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId);
      if (handled) {
        await safeCleanup({ from, ownerId });
        return true;
      }
    }

    // 5) Bootstrap CIL (ONLY for areas without dedicated handlers)
    // If you ever add a handler for a command, keep it ahead of this.
    const cil = simpleTextToCIL(raw);
    if (cil) {
      const ctx = { owner_id: ownerId, source_msg_id: sourceMsgId, actor_phone: from };
      const result = await applyCIL(cil, ctx);
      twiml(res, result?.summary || 'Done.');
      await safeCleanup({ from, ownerId });
      return true;
    }

    // 6) Agent fallback
    const { ask } = require('../../services/agent');
    const answer = await ask({
      from,
      ownerId,
      text: raw,
      topicHints: ['tasks', 'timeclock', 'jobs', 'expense', 'revenue'],
    });

    twiml(res, answer || `Try "task fix leak due tomorrow", "expense $100 tools", or "clock in".`);
    await safeCleanup({ from, ownerId });
    return true;
  } catch (err) {
    console.error(`[commands] error for ${from}:`, err?.message);
    twiml(res, `Something went wrong. Try again.`);
    await safeCleanup({ from, ownerId });
    return true;
  }
};
