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
const { applyCIL } = require('../../src/cil/router');
const confirmationTemplates = require('../../config').confirmationTemplates;
const { getEffectivePlanKey } = require("../../src/config/getEffectivePlanKey");


// Lazy-load per-file handlers
let tasksHandler, handleTimeclock, handleJob, handleExpense, handleRevenue, teamHandler;
let handleMileage, isMileageMessage;
let handlePhase, isPhaseMessage;
let handlePhotos, isPhotosCommand;
let handleSetRate, isSetRateCommand;
let handleRecurring, isRecurringCommand;
let handlePayroll, isPayrollCommand;
let handleCrewSelf, isCrewSelfCommand;
let handleDigestSettings, isDigestSettingsCommand;
let handleTimesheetApproval, isTimesheetApprovalCommand;
let batchReceiptsHandler;
try { ({ tasksHandler } = require('./tasks')); } catch {}
try { ({ handleTimeclock } = require('./timeclock')); } catch {}
try { ({ handleJob } = require('./job')); } catch {}
try { ({ handleExpense } = require('./expense')); } catch {}
try { ({ handleRevenue } = require('./revenue')); } catch {}
try { ({ teamHandler } = require('./team')); } catch {}
try { ({ handleMileage, isMileageMessage } = require('./mileage')); } catch {}
try { ({ handlePhase, isPhaseMessage } = require('./phase')); } catch {}
try { ({ handlePhotos, isPhotosCommand } = require('./photos')); } catch {}
try { ({ handleSetRate, isSetRateCommand } = require('./rates')); } catch {}
try { ({ handleRecurring, isRecurringCommand } = require('./recurring')); } catch {}
try { ({ handlePayroll, isPayrollCommand } = require('./payroll')); } catch {}
try { ({ handleCrewSelf, isCrewSelfCommand } = require('./crewSelf')); } catch {}
try { ({ handleDigestSettings, isDigestSettingsCommand } = require('./digestSettings')); } catch {}
try { ({ handleTimesheetApproval, isTimesheetApprovalCommand } = require('./timesheetApproval')); } catch {}
try { batchReceiptsHandler = require('./batchReceipts'); } catch {}



function xmlEsc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function twimlEmpty(res) {
  const xml = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  return res.status(200).type('application/xml; charset=utf-8').send(xml);
}

function twiml(res, body) {
  const t = String(body ?? '').trim();

  // ✅ Never emit empty <Message> (Twilio 14103)
  if (!t) return twimlEmpty(res);

  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEsc(t)}</Message></Response>`;
  return res.status(200).type('application/xml; charset=utf-8').send(xml);
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

function canonicalUserKey(from) {
  return String(from || '').replace(/^whatsapp:/i, '').replace(/^\+/, '').replace(/\D/g, '') || String(from || '').trim();
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

    // 1b) Pending job photo picker — user responding to "which job is this for?"
    {
      const jobnoMatch = raw.match(/^jobno_(\d+)/i);
      if (jobnoMatch) {
        const pending = await getPendingTransactionState(canonicalUserKey(from));
        if (pending?.pendingJobPhoto) {
          const photo = pending.pendingJobPhoto;
          const jobId = parseInt(jobnoMatch[1], 10);

          let saved = false;
          try {
            let pg = null;
            try { pg = require('../../services/postgres'); } catch {}
            if (pg && typeof pg.query === 'function' && Number.isFinite(jobId)) {
              // Verify the job belongs to this owner
              const jobRes = await pg.query(
                `SELECT id, job_name, name, job_no FROM public.jobs WHERE owner_id = $1 AND id = $2 AND deleted_at IS NULL LIMIT 1`,
                [ownerId, jobId]
              );
              const job = jobRes?.rows?.[0];
              if (job && photo.tenantId) {
                await pg.query(
                  `INSERT INTO public.job_photos (tenant_id, job_id, owner_id, storage_path, public_url, description, source, source_msg_id)
                   VALUES ($1, $2, $3, $4, $5, $6, 'whatsapp', $7)
                   ON CONFLICT (owner_id, source_msg_id) WHERE source_msg_id IS NOT NULL
                   DO UPDATE SET public_url = excluded.public_url`,
                  [photo.tenantId, jobId, ownerId, photo.storagePath, photo.publicUrl || null, photo.caption || null, photo.stableMediaMsgId || null]
                );
                const jobLabel = job.job_name || job.name || `Job #${job.job_no || job.id}`;
                // Clear pending photo state
                await deletePendingTransactionState(canonicalUserKey(from));
                twiml(res, `📷 Photo saved to ${jobLabel}${photo.caption ? ` — "${photo.caption}"` : ''}.`);
                await safeCleanup({ from, ownerId });
                saved = true;
                return true;
              }
            }
          } catch (e) {
            console.error('[commands] pendingJobPhoto confirm failed:', e?.message);
          }

          if (!saved) {
            twiml(res, `⚠️ Couldn't save the photo. Try again.`);
            await safeCleanup({ from, ownerId });
            return true;
          }
        }
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
            if (result && result.ok === false) {
              // Constitution §9 error envelope from router (§17.6). Surface as failure.
              console.warn('[commands] applyCIL envelope for pending:', result.error?.code, result.error?.message);
              twiml(res, `⚠️ I couldn't log that ${type}. Please try again.`);
            } else {
              twiml(res, result?.summary || `${type} logged.`);
            }
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

    // 3) Subscription gating (canonical: plan_key + sub_status)
const planKey = getEffectivePlanKey(ownerProfile);

// Decide what you want to gate here. (Keep your regex.)
const needsPro = /agent|quote|metrics|receipt|pricing/i.test(lc);

if (needsPro && planKey !== "pro") {
  const sent = await sendTemplateMessage(from, confirmationTemplates.upgradeNow, {
    "1": "This feature requires Pro.",
  });

  await safeCleanup({ from, ownerId });

  // If REST template send worked, don't also send TwiML
  return sent ? twimlEmpty(res) : twiml(res, "Upgrade to Pro to use this feature.");
}


    // 4) Expense + Revenue — run before tasks/timeclock/job so they consume confirmations and job pickers.
    // Decision tokens (yes/edit/cancel/change job/job pickers) are also routed here so pending confirms
    // reach the right handler instead of falling through to the agent.
    const isDecisionToken =
      /^(yes|y|yeah|yep|ok|okay|edit|cancel|skip|resume|change.?job)\b/i.test(lc) ||
      /^(jobno_|jobix_)\d+/i.test(lc);

    if (handleExpense && (/^expense\b/i.test(lc) || isDecisionToken)) {
      const result = await handleExpense(from, raw, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId);
      if (result?.sentOutOfBand) {
        twimlEmpty(res);
      } else {
        res.status(200).type('application/xml; charset=utf-8').send(result?.twiml || '<Response></Response>');
      }
      await safeCleanup({ from, ownerId });
      return true;
    }

    if (handleRevenue && (/^revenue\b/i.test(lc) || /^(received|got paid|payment)\b/i.test(lc) || isDecisionToken)) {
      const result = await handleRevenue(from, raw, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId);
      if (result?.sentOutOfBand) {
        twimlEmpty(res);
      } else {
        res.status(200).type('application/xml; charset=utf-8').send(result?.twiml || '<Response></Response>');
      }
      await safeCleanup({ from, ownerId });
      return true;
    }

    // 5) Remaining dedicated handlers (rates, team, tasks, timeclock, job)

// ✅ RATES — "set rate John $28/hour" / "set my rate $45/hour"
if (handleSetRate && isSetRateCommand && isSetRateCommand(raw)) {
  const handled = await handleSetRate(from, raw, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId);
  if (handled) {
    await safeCleanup({ from, ownerId });
    return true;
  }
}

// ✅ RECURRING EXPENSES — "recurring $200/month storage unit" / "list recurring"
if (handleRecurring && isRecurringCommand && isRecurringCommand(raw)) {
  const handled = await handleRecurring(from, raw, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId);
  if (handled) {
    await safeCleanup({ from, ownerId });
    return true;
  }
}

// ✅ PAYROLL SUMMARY — "payroll this week" / "payroll summary" / "overtime report"
if (handlePayroll && isPayrollCommand && isPayrollCommand(raw)) {
  const handled = await handlePayroll(from, raw, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId);
  if (handled) {
    await safeCleanup({ from, ownerId });
    return true;
  }
}

// ✅ CREW SELF-QUERY — "my hours", "my jobs", "my tasks", "crew settings" (Pro)
if (handleCrewSelf && isCrewSelfCommand && isCrewSelfCommand(raw)) {
  const handled = await handleCrewSelf(from, raw, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId);
  if (handled) {
    await safeCleanup({ from, ownerId });
    return true;
  }
}

// ✅ TIMESHEET APPROVAL — "submit timesheet", "pending timesheets", "approve/reject timesheet [name]"
if (handleTimesheetApproval && isTimesheetApprovalCommand && isTimesheetApprovalCommand(raw)) {
  const handled = await handleTimesheetApproval(from, raw, userProfile, ownerId, ownerProfile, isOwner, res);
  if (handled) {
    await safeCleanup({ from, ownerId });
    return true;
  }
}

// ✅ DIGEST SETTINGS — "digest settings", "digest day friday", "digest time 4pm", "digest on/off"
if (handleDigestSettings && isDigestSettingsCommand && isDigestSettingsCommand(raw)) {
  const handled = await handleDigestSettings(from, raw, userProfile, ownerId, ownerProfile, isOwner, res);
  if (handled) {
    await safeCleanup({ from, ownerId });
    return true;
  }
}

// ✅ BATCH RECEIPTS — "batch receipts", "done", "cancel batch", job assignment reply
if (batchReceiptsHandler) {
  const {
    isBatchStartCommand,
    isBatchDoneCommand,
    isBatchCancelCommand,
    handleBatchTextCommand,
    startBatchSession,
    isBatchActive,
  } = batchReceiptsHandler;

  // Start batch mode
  if (isBatchStartCommand && isBatchStartCommand(raw)) {
    const result = await startBatchSession(ownerId);
    await safeCleanup({ from, ownerId });
    return twiml(res, result.replyText);
  }

  // Done / cancel / job-name assignment (only if batch is active or these are batch commands)
  const isBatchCmd = (isBatchDoneCommand && isBatchDoneCommand(raw)) ||
                     (isBatchCancelCommand && isBatchCancelCommand(raw));
  const batchActive = !isBatchCmd && handleBatchTextCommand
    ? await isBatchActive(ownerId)
    : false;

  if (isBatchCmd || batchActive) {
    const result = await handleBatchTextCommand(raw, ownerId);
    if (result.handled) {
      // Job assignment confirmed — create all expense transactions
      if (result.batchConfirm) {
        const { items, jobName } = result.batchConfirm;
        let pg = null;
        try { pg = require('../../services/postgres'); } catch {}

        let jobRow = null;
        if (pg) {
          // Resolve job by name (fuzzy)
          const jobRes = await pg.query(
            `SELECT id, job_int_id, job_name, name FROM public.jobs
             WHERE owner_id = $1 AND deleted_at IS NULL
             AND (LOWER(job_name) ILIKE $2 OR LOWER(name) ILIKE $2)
             ORDER BY created_at DESC LIMIT 1`,
            [ownerId, `%${jobName.toLowerCase()}%`]
          );
          jobRow = jobRes?.rows?.[0] || null;
        }

        const created = [];
        const failed  = [];
        for (const item of items) {
          try {
            const amountCents = item.amount
              ? Math.round(parseFloat(String(item.amount).replace(/[^0-9.]/g, '')) * 100)
              : null;

            const dedupe = `batch:${ownerId}:${item.stable_media_msg_id || item.added_at}`;
            const { applyCIL: applyCilFn } = require('../../src/cil/router');
            const r = await applyCilFn({
              type: 'CreateExpense',
              owner_id: ownerId,
              amount_cents: amountCents || 0,
              vendor: item.vendor || 'Unknown',
              description: `Batch receipt — ${item.vendor || 'Unknown'}`,
              expense_date: item.date || new Date().toISOString().slice(0, 10),
              job_int_id: jobRow?.job_int_id || null,
              source_msg_id: dedupe,
              raw_text: item.raw_text || null,
            });
            // Constitution §9 error envelope from router (§17.6) — treat as failure.
            if (r && r.ok === false) {
              console.warn('[commands] batch applyCIL envelope:', r.error?.code, r.error?.message);
              failed.push(item);
            } else {
              created.push(item);
            }
          } catch (e) {
            failed.push(item);
          }
        }

        const jobLabel = jobRow?.job_name || jobRow?.name || jobName;
        const lines = [
          `✅ Logged ${created.length} receipt${created.length !== 1 ? 's' : ''} to *${jobLabel}*.`,
        ];
        if (failed.length) lines.push(`⚠️ ${failed.length} couldn't be saved — try logging them individually.`);
        if (created.length) {
          const total = created.reduce((sum, it) => {
            const v = parseFloat(String(it.amount || '0').replace(/[^0-9.]/g, ''));
            return sum + (isNaN(v) ? 0 : v);
          }, 0);
          if (total > 0) lines.push(`Total: $${total.toFixed(2)}`);
        }

        await safeCleanup({ from, ownerId });
        return twiml(res, lines.join('\n'));
      }

      // Done summary / cancel reply
      if (result.replyText) {
        await safeCleanup({ from, ownerId });
        return twiml(res, result.replyText);
      }
    }
  }
}

// ✅ TEAM (employees/crew) — Gate #3 lives inside team.js
if (teamHandler) {
  const teamHit =
    /^(team|crew|employees?)\b/i.test(raw) ||
    /^(add|new|create)\s+(employee|crew)\b/i.test(raw) ||
    /^invite\b/i.test(raw) ||
    /^remove\s+(employee|crew)\b/i.test(raw) ||
    /^list\s+(team|crew|employees?)\b/i.test(raw);

  if (teamHit) {
    const handled = await teamHandler(from, raw, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId);
    if (handled) {
      await safeCleanup({ from, ownerId });
      return true;
    }
  }
}



    if (tasksHandler) {
      const handled = await tasksHandler(from, raw, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId);
      if (handled) {
        await safeCleanup({ from, ownerId });
        return true;
      }
    }

    // Photos handler — "send me job pictures" / "send client job pictures"
    if (handlePhotos && isPhotosCommand && isPhotosCommand(raw)) {
      const handled = await handlePhotos(from, raw, userProfile, ownerId, ownerProfile, isOwner, res);
      if (handled) {
        await safeCleanup({ from, ownerId });
        return true;
      }
    }

    // Phase handler — runs before timeclock so "starting X" isn't mis-routed
    if (handlePhase && isPhaseMessage && isPhaseMessage(raw)) {
      const handled = await handlePhase(from, raw, userProfile, ownerId, ownerProfile, isOwner, res);
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

    // Mileage — check after timeclock to avoid ambiguity
    if (handleMileage && isMileageMessage && isMileageMessage(raw)) {
      const country = String(ownerProfile?.country || 'CA').toUpperCase();
      const tenantId = String(ownerProfile?.tenant_id || ownerId || '');
      const paUserIdMileage = canonicalUserKey(from);
      const reply = await handleMileage({
        text: raw,
        ownerId,
        tenantId,
        country,
        sourceMsgId,
        isOwner,
        ownerProfile,
        paUserId: paUserIdMileage,
      }).catch((e) => `⚠️ Mileage log failed: ${e?.message || 'unknown error'}`);
      twiml(res, reply);
      await safeCleanup({ from, ownerId });
      return true;
    }

    // 6) Bootstrap CIL (ONLY for areas without dedicated handlers)
    // If you ever add a handler for a command, keep it ahead of this.
    const cil = simpleTextToCIL(raw);
    if (cil) {
      const ctx = { owner_id: ownerId, source_msg_id: sourceMsgId, actor_phone: from };
      const result = await applyCIL(cil, ctx);
      if (result && result.ok === false) {
        // Constitution §9 error envelope (§17.6).
        console.warn('[commands] bootstrap applyCIL envelope:', result.error?.code, result.error?.message);
        twiml(res, `⚠️ ${result.error?.message || "I couldn't process that."}`);
      } else {
        twiml(res, result?.summary || 'Done.');
      }
      await safeCleanup({ from, ownerId });
      return true;
    }

    // 7) Agent fallback
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
