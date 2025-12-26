// handlers/commands/expense.js
const {
  query,
  insertTransaction,
} = require('../../services/postgres');

const state = require('../../utils/stateManager');
const getPendingTransactionState = state.getPendingTransactionState;
const deletePendingTransactionState = state.deletePendingTransactionState;

// Prefer mergePendingTransactionState; fall back to setPendingTransactionState with merge:true
const mergePendingTransactionState =
  state.mergePendingTransactionState ||
  (async (userId, patch) => state.setPendingTransactionState(userId, patch, { merge: true }));

const ai = require('../../utils/aiErrorHandler');

// Serverless-safe / backwards-compatible imports
const handleInputWithAI = ai.handleInputWithAI;
const parseExpenseMessage = ai.parseExpenseMessage;

const detectErrors =
  (typeof ai.detectErrors === 'function' && ai.detectErrors) ||
  (typeof ai.detectError === 'function' && ai.detectError) ||
  (async () => null); // fail-open

const categorizeEntry =
  (typeof ai.categorizeEntry === 'function' && ai.categorizeEntry) ||
  (async () => null); // fail-open

// ---- CIL validator (fail-open) ----
const cilMod = require('../../cil');
const validateCIL =
  (cilMod && typeof cilMod.validateCIL === 'function' && cilMod.validateCIL) ||
  (cilMod && typeof cilMod.validateCil === 'function' && cilMod.validateCil) ||
  (cilMod && typeof cilMod.validate === 'function' && cilMod.validate) ||
  (typeof cilMod === 'function' && cilMod) ||
  null;

/* ---------------- Twilio Content Template (Quick Reply Buttons) ---------------- */

// Put the SID in Vercel env vars. This handler tries a few common names.
// Recommended: TWILIO_EXPENSE_CONFIRM_TEMPLATE_SID=HX...
function getExpenseConfirmTemplateSid() {
  return (
    process.env.TWILIO_EXPENSE_CONFIRM_TEMPLATE_SID ||
    process.env.EXPENSE_CONFIRM_TEMPLATE_SID ||
    process.env.TWILIO_TEMPLATE_EXPENSE_CONFIRM_SID ||
    null
  );
}

function xmlEsc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function twimlText(msg) {
  return `<Response><Message>${xmlEsc(msg)}</Message></Response>`;
}

function twimlConfirmExpense(summaryLine) {
  const sid = getExpenseConfirmTemplateSid();
  if (!sid) {
    return twimlText(`Please confirm this Expense:\n${summaryLine}\n\nReply yes/edit/cancel.`);
  }

  return (
    `<Response><Message>` +
      `<Content sid="${xmlEsc(sid)}">` +
        `<Parameter name="1">${xmlEsc(summaryLine)}</Parameter>` +
      `</Content>` +
    `</Message></Response>`
  );
}

function normalizeDecisionToken(input) {
  const s = String(input || '').trim().toLowerCase();

  if (s === 'yes' || s === 'y') return 'yes';
  if (s === 'edit') return 'edit';
  if (s === 'cancel' || s === 'stop' || s === 'no') return 'cancel';

  if (/\byes\b/.test(s) && s.length <= 12) return 'yes';
  if (/\bedit\b/.test(s) && s.length <= 12) return 'edit';
  if (/\bcancel\b/.test(s) && s.length <= 12) return 'cancel';

  return s;
}

// ---- Media limits (Option A truncation) ----
const MAX_MEDIA_TRANSCRIPT_CHARS = 8000;
function truncateText(str, maxChars) {
  if (!str) return null;
  const s = String(str);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars);
}

// ---- basic parsing helpers ----
function toCents(amountStr) {
  const n = Number(String(amountStr || '').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function todayIso() {
  return new Date().toISOString().split('T')[0];
}

function parseNaturalDate(s) {
  const t = String(s || '').trim().toLowerCase();
  const today = todayIso();

  if (!t || t === 'today') return today;

  if (t === 'yesterday') {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().split('T')[0];
  }

  if (t === 'tomorrow') {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().split('T')[0];
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;

  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().split('T')[0];

  return null;
}

function looksLikeUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(str || ''));
}

/**
 * Resolve active job name safely (avoid int=uuid comparisons).
 * Priority:
 *  1) userProfile.active_job_name
 *  2) userProfile.active_job_id (uuid) -> jobs.id
 *  3) userProfile.active_job_id numeric -> jobs.job_no
 */
async function resolveActiveJobName({ ownerId, userProfile }) {
  const ownerParam = String(ownerId || '').trim();
  const name = userProfile?.active_job_name || userProfile?.activeJobName || null;
  if (name && String(name).trim()) return String(name).trim();

  const ref = userProfile?.active_job_id ?? userProfile?.activeJobId ?? null;
  if (ref == null) return null;

  const s = String(ref).trim();

  // UUID jobs.id
  if (looksLikeUuid(s)) {
    try {
      const r = await query(
        `select coalesce(name, job_name) as job_name
           from public.jobs
          where owner_id = $1 and id = $2::uuid
          limit 1`,
        [ownerParam, s]
      );
      if (r?.rows?.[0]?.job_name) return r.rows[0].job_name;
    } catch (e) {
      console.warn('[expense] resolveActiveJobName uuid failed:', e?.message);
    }
  }

  // Integer jobs.job_no
  if (/^\d+$/.test(s)) {
    try {
      const r = await query(
        `select coalesce(name, job_name) as job_name
           from public.jobs
          where owner_id = $1 and job_no = $2::int
          limit 1`,
        [ownerParam, Number(s)]
      );
      if (r?.rows?.[0]?.job_name) return r.rows[0].job_name;
    } catch (e) {
      console.warn('[expense] resolveActiveJobName job_no failed:', e?.message);
    }
  }

  return null;
}

// Minimal CIL build (your current shape) — fail-open if validator missing
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

    // FAIL-OPEN if validator missing
    if (typeof validateCIL !== 'function') {
      console.warn('[EXPENSE] validateCIL missing; skipping CIL validation (fail-open).');
      return { ok: true, cil, skipped: true };
    }

    validateCIL(cil);
    return { ok: true, cil };
  } catch {
    return { ok: false, reply: `⚠️ Couldn't log that expense yet. Try: "expense 84.12 nails from Home Depot".` };
  }
}

// Clear ONLY media meta after successful write so it doesn't attach to next txn
async function clearPendingMediaMeta(from, pending) {
  try {
    if (!pending) return;
    if (!pending.pendingMediaMeta && !pending.pendingMedia) return;

    await mergePendingTransactionState(from, {
      ...(pending || {}),
      pendingMediaMeta: null,
      pendingMedia: false
    });
  } catch {}
}

async function deleteExpense(ownerId, criteria) {
  try {
    const ownerParam = String(ownerId || '').trim();
    const amountCents = toCents(criteria.amount);
    const description = String(criteria.item || '').trim();
    const source = String(criteria.store || '').trim();

    const res = await query(
      `
      delete from public.transactions
       where owner_id = $1::text
         and kind = 'expense'
         and description = $2
         and amount_cents = $3
         and source = $4
       returning id
      `,
      [ownerParam, description, amountCents, source]
    );
    return (res?.rows?.length || 0) > 0;
  } catch {
    return false;
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

async function handleExpense(from, input, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId) {
  const lockKey = `lock:${from}`;
  const msgId = String(sourceMsgId || '').trim() || `${from}:${Date.now()}`;
  const safeMsgId = String(sourceMsgId || msgId || '').trim();

  let reply;

  try {
    const defaultData = {
      date: todayIso(),
      item: 'Unknown',
      amount: '$0.00',
      store: 'Unknown Store'
    };

    let pending = await getPendingTransactionState(from);

    // If user previously hit "edit", treat next message as brand new
    if (pending?.isEditing && pending?.type === 'expense') {
      await deletePendingTransactionState(from);
      pending = null;
    }

    // Follow-up: expense clarification (date, etc.)
    if (pending?.awaitingExpenseClarification) {
      const maybeDate = parseNaturalDate(input);

      if (maybeDate) {
        const draft = pending.expenseDraftText || '';
        const parsed = parseExpenseMessage(draft) || {};
        const merged = { ...parsed, date: maybeDate };

        await mergePendingTransactionState(from, {
          ...pending,
          pendingExpense: merged,
          awaitingExpenseClarification: false
        });

        const summaryLine = `Expense: ${merged.amount} for ${merged.item} from ${merged.store} on ${merged.date}.`;
        return twimlConfirmExpense(summaryLine);
      }

      reply = `What date was this expense? (e.g., 2025-12-12 or "today")`;
      return twimlText(reply);
    }

    // Follow-up: job resolution (contractor-first)
    if (pending?.awaitingExpenseJob && pending?.pendingExpense) {
      const jobReply = String(input || '').trim();
      const finalJob = jobReply || null;

      const merged = { ...pending.pendingExpense, jobName: finalJob };

      await mergePendingTransactionState(from, {
        ...pending,
        pendingExpense: merged,
        awaitingExpenseJob: false
      });

      const summaryLine = `Expense: ${merged.amount} for ${merged.item} from ${merged.store} on ${merged.date} for ${merged.jobName}.`;
      return twimlConfirmExpense(summaryLine);
    }

    // --- CONFIRM / DELETE FLOW ---
    if (pending?.pendingExpense || pending?.pendingDelete?.type === 'expense') {
      if (!isOwner) {
        await deletePendingTransactionState(from);
        reply = '⚠️ Only the owner can manage expenses.';
        return twimlText(reply);
      }

      const token = normalizeDecisionToken(input);
      const stableMsgId = String(pending?.expenseSourceMsgId || safeMsgId).trim(); // always defined

      // If user sends a fresh expense command while waiting, treat as new command
      if (/^(?:expense|exp)\b/.test(String(input || '').toLowerCase()) && pending?.pendingExpense) {
        await deletePendingTransactionState(from);
        pending = null;
      } else {
        if (token === 'yes' && pending?.pendingExpense) {
          const data = pending.pendingExpense || {};
          const mediaMeta = pending?.pendingMediaMeta || null;

          const category =
            data.suggestedCategory ||
            (await Promise.resolve(categorizeEntry('expense', data, ownerProfile)).catch(() => null));

          const jobName =
            (data.jobName && String(data.jobName).trim()) ||
            (await resolveActiveJobName({ ownerId, userProfile })) ||
            null;

          if (!jobName) {
            await mergePendingTransactionState(from, {
              ...pending,
              pendingExpense: data,
              awaitingExpenseJob: true,
              expenseSourceMsgId: stableMsgId,
              type: 'expense'
            });
            reply = `Which job is this expense for? Reply with the job name (or "Overhead").`;
            return twimlText(reply);
          }

          const gate = assertExpenseCILOrClarify({
            ownerId,
            from,
            userProfile,
            data,
            jobName,
            category,
            sourceMsgId: stableMsgId
          });
          if (!gate.ok) return twimlText(gate.reply);

          const amountCents = toCents(data.amount);
          if (!amountCents || amountCents <= 0) throw new Error('Invalid amount');

          const result = await insertTransaction({
            ownerId,
            kind: 'expense',
            date: data.date || todayIso(),
            description: String(data.item || '').trim() || 'Unknown',
            amount_cents: amountCents,
            amount: null,
            source: String(data.store || '').trim() || 'Unknown',
            job: jobName,
            job_name: jobName,
            category: category ? String(category).trim() : null,
            user_name: userProfile?.name || 'Unknown User',
            source_msg_id: stableMsgId,
            mediaMeta: mediaMeta
              ? {
                  url: mediaMeta.url || null,
                  type: mediaMeta.type || null,
                  transcript: truncateText(mediaMeta.transcript, MAX_MEDIA_TRANSCRIPT_CHARS),
                  confidence: mediaMeta.confidence ?? null
                }
              : null
          });

          reply =
            result?.inserted === false
              ? '✅ Already logged that expense (duplicate message).'
              : `✅ Expense logged: ${data.amount} for ${data.item} from ${data.store} on ${jobName}${category ? ` (Category: ${category})` : ''}`;

          await deletePendingTransactionState(from);
          return twimlText(reply);
        }

        if (token === 'yes' && pending?.pendingDelete?.type === 'expense') {
          const criteria = pending.pendingDelete;
          const success = await deleteExpense(ownerId, criteria);
          reply = success
            ? `✅ Deleted expense ${criteria.amount} for ${criteria.item} from ${criteria.store}.`
            : `⚠️ Expense not found or deletion failed.`;
          await deletePendingTransactionState(from);
          return twimlText(reply);
        }

        if (token === 'edit') {
          await mergePendingTransactionState(from, {
            ...(pending || {}),
            isEditing: true,
            type: 'expense',
            awaitingExpenseClarification: false,
            awaitingExpenseJob: false
          });
          reply = '✏️ Okay — resend the expense in one line (e.g., "expense 84.12 nails from Home Depot").';
          return twimlText(reply);
        }

        if (token === 'cancel') {
          await deletePendingTransactionState(from);
          reply = '❌ Operation cancelled.';
          return twimlText(reply);
        }

        reply = `⚠️ Please choose Yes, Edit, or Cancel.`;
        return twimlText(reply);
      }
    }

    // DELETE EXPENSE REQUEST
    if (String(input || '').toLowerCase().startsWith('delete expense')) {
      if (!isOwner) {
        reply = '⚠️ Only the owner can delete expense entries.';
        return twimlText(reply);
      }

      const req = parseDeleteRequest(input);
      if (req.type !== 'expense') {
        reply = `⚠️ Invalid delete request. Try "delete expense $100 tools from Home Depot".`;
        return twimlText(reply);
      }

      await mergePendingTransactionState(from, { pendingDelete: { type: 'expense', ...req.criteria } });
      reply = `Please confirm: Delete expense ${req.criteria.amount} for ${req.criteria.item}? Reply yes/cancel.`;
      return twimlText(reply);
    }

    // DIRECT PARSE PATH (simple deterministic)
    const m = String(input || '').match(/^(?:expense\s+)?\$?(\d+(?:\.\d{1,2})?)\s+(.+?)(?:\s+from\s+(.+))?$/i);
    if (m) {
      const [, amount, item, store] = m;
      const date = todayIso();
      const data = {
        date,
        item,
        amount: `$${parseFloat(amount).toFixed(2)}`,
        store: store || 'Unknown Store'
      };

      const category =
        (await Promise.resolve(categorizeEntry('expense', data, ownerProfile)).catch(() => null)) || null;

      const jobName = (await resolveActiveJobName({ ownerId, userProfile })) || null;

      if (!jobName) {
        await mergePendingTransactionState(from, {
          ...(pending || {}),
          pendingExpense: data,
          awaitingExpenseJob: true,
          expenseSourceMsgId: safeMsgId,
          type: 'expense'
        });
        reply = `Which job is this expense for? Reply with the job name (or "Overhead").`;
        return twimlText(reply);
      }

      const gate = assertExpenseCILOrClarify({ ownerId, from, userProfile, data, jobName, category, sourceMsgId: safeMsgId });
      if (!gate.ok) return twimlText(gate.reply);

      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingExpense: { ...data, jobName, suggestedCategory: category },
        expenseSourceMsgId: safeMsgId,
        type: 'expense'
      });

      const summaryLine = `Expense: ${data.amount} for ${data.item} from ${data.store} on ${data.date} for ${jobName}.`;
      return twimlConfirmExpense(summaryLine);
    }

    // AI PATH
    const aiRes = await handleInputWithAI(from, input, 'expense', parseExpenseMessage, defaultData);
    const data = aiRes?.data || null;
    const aiReply = aiRes?.reply || null;
    const confirmed = !!aiRes?.confirmed;

    if (aiReply) {
      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingExpense: null,
        awaitingExpenseClarification: true,
        expenseClarificationPrompt: aiReply,
        expenseDraftText: input,
        expenseSourceMsgId: safeMsgId,
        type: 'expense'
      });
      return twimlText(aiReply);
    }

    if (data && data.amount && data.amount !== '$0.00' && data.item && data.store) {
      let errors = null;
      try {
        errors = await detectErrors(data, 'expense');
        if (errors == null) errors = await detectErrors('expense', data);
      } catch (e) {
        console.warn('[EXPENSE] detectErrors threw; ignoring (fail-open):', e?.message);
        errors = null;
      }

      const category =
        (await Promise.resolve(categorizeEntry('expense', data, ownerProfile)).catch(() => null)) || null;
      data.suggestedCategory = category;

      const jobName = (await resolveActiveJobName({ ownerId, userProfile })) || null;

      if (!jobName) {
        await mergePendingTransactionState(from, {
          ...(pending || {}),
          pendingExpense: data,
          awaitingExpenseJob: true,
          expenseSourceMsgId: safeMsgId,
          type: 'expense'
        });
        reply = `Which job is this expense for? Reply with the job name (or "Overhead").`;
        return twimlText(reply);
      }

      // Keep confirm step → now uses quick reply buttons
      await mergePendingTransactionState(from, {
        ...(pending || {}),
        pendingExpense: { ...data, jobName },
        expenseSourceMsgId: safeMsgId,
        type: 'expense'
      });

      const summaryLine = `Expense: ${data.amount} for ${data.item} from ${data.store} on ${data.date || todayIso()} for ${jobName}.`;
      return twimlConfirmExpense(summaryLine);
    }

    reply = `🤔 Couldn’t parse an expense from "${input}". Try "expense 84.12 nails from Home Depot".`;
    return twimlText(reply);
  } catch (error) {
    console.error(`[ERROR] handleExpense failed for ${from}:`, error?.message, {
      code: error?.code,
      detail: error?.detail,
      constraint: error?.constraint
    });
    reply = '⚠️ Error logging expense. Please try again.';
    return twimlText(reply);
  } finally {
    try {
      await require('../../middleware/lock').releaseLock(lockKey);
    } catch {
      // never hard-fail
    }
  }
}

module.exports = { handleExpense };
