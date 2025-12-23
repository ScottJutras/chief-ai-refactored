// handlers/commands/expense.js
const { query } = require('../../services/postgres');
const {
  getPendingTransactionState,
  setPendingTransactionState,
  deletePendingTransactionState
} = require('../../utils/stateManager');
const {
  handleInputWithAI,
  parseExpenseMessage,
  detectErrors,
  categorizeEntry
} = require('../../utils/aiErrorHandler');
const { validateCIL } = require('../../cil');

// ---- column presence caches ----
let _hasSourceMsgIdCol = null;
let _hasAmountCol = null;

async function hasColumn(table, col) {
  const r = await query(
    `select 1
       from information_schema.columns
      where table_name = $1
        and column_name = $2
      limit 1`,
    [table, col]
  );
  return (r?.rows?.length || 0) > 0;
}

async function hasSourceMsgIdColumn() {
  if (_hasSourceMsgIdCol !== null) return _hasSourceMsgIdCol;
  try {
    _hasSourceMsgIdCol = await hasColumn('transactions', 'source_msg_id');
  } catch {
    _hasSourceMsgIdCol = false;
  }
  return _hasSourceMsgIdCol;
}

async function hasAmountColumn() {
  if (_hasAmountCol !== null) return _hasAmountCol;
  try {
    _hasAmountCol = await hasColumn('transactions', 'amount');
  } catch {
    _hasAmountCol = false;
  }
  return _hasAmountCol;
}

function toCents(amountStr) {
  const n = Number(String(amountStr || '').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function toDollars(amountStr) {
  const n = Number(String(amountStr || '').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return n;
}

function looksLikeUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(str || ''));
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
        `select job_name from jobs where owner_id = $1 and id = $2::uuid limit 1`,
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
        `select job_name from jobs where owner_id = $1 and job_no = $2::int limit 1`,
        [ownerParam, Number(s)]
      );
      if (r?.rows?.[0]?.job_name) return r.rows[0].job_name;
    } catch (e) {
      console.warn('[expense] resolveActiveJobName job_no failed:', e?.message);
    }
  }

  return null;
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
  } catch {
    return {
      ok: false,
      reply: `⚠️ Couldn't log that expense yet. Try: "expense 84.12 nails from Home Depot".`
    };
  }
}

async function saveExpense({ ownerId, date, item, amount, store, jobName, category, user, sourceMsgId }) {
  const amountCents = toCents(amount);
  if (!amountCents || amountCents <= 0) throw new Error('Invalid amount');

  const ownerParam = String(ownerId || '').trim();
  const msgParam = String(sourceMsgId || '').trim();

  const canUseMsgId = await hasSourceMsgIdColumn();
  const canUseAmount = await hasAmountColumn();
  const amountDollars = toDollars(amount);

  const description = String(item || '').trim() || 'Unknown';
  const source = String(store || '').trim() || 'Unknown';

  if (canUseMsgId) {
    const sql = canUseAmount
      ? `
        insert into transactions
          (owner_id, kind, date, description, amount_cents, amount, source, job_name, category, user_name, source_msg_id, created_at)
        values
          ($1::text, 'expense', $2::date, $3, $4, $5, $6, $7, $8, $9, $10, now())
        on conflict do nothing
        returning id
      `
      : `
        insert into transactions
          (owner_id, kind, date, description, amount_cents, source, job_name, category, user_name, source_msg_id, created_at)
        values
          ($1::text, 'expense', $2::date, $3, $4, $5, $6, $7, $8, $9, now())
        on conflict do nothing
        returning id
      `;

    const params = canUseAmount
      ? [
          ownerParam,
          date,
          description,
          amountCents,
          amountDollars,
          source,
          jobName ? String(jobName).trim() : null,
          category ? String(category).trim() : null,
          user ? String(user).trim() : null,
          msgParam
        ]
      : [
          ownerParam,
          date,
          description,
          amountCents,
          source,
          jobName ? String(jobName).trim() : null,
          category ? String(category).trim() : null,
          user ? String(user).trim() : null,
          msgParam
        ];

    const res = await query(sql, params);
    if (!res.rows.length) return { inserted: false };
    return { inserted: true, id: res.rows[0].id };
  }

  // non-idempotent fallback
  const sql = canUseAmount
    ? `
      insert into transactions
        (owner_id, kind, date, description, amount_cents, amount, source, job_name, category, user_name, created_at)
      values
        ($1::text, 'expense', $2::date, $3, $4, $5, $6, $7, $8, $9, now())
    `
    : `
      insert into transactions
        (owner_id, kind, date, description, amount_cents, source, job_name, category, user_name, created_at)
      values
        ($1::text, 'expense', $2::date, $3, $4, $5, $6, $7, $8, now())
    `;

  const params = canUseAmount
    ? [
        ownerParam,
        date,
        description,
        amountCents,
        amountDollars,
        source,
        jobName ? String(jobName).trim() : null,
        category ? String(category).trim() : null,
        user ? String(user).trim() : null
      ]
    : [
        ownerParam,
        date,
        description,
        amountCents,
        source,
        jobName ? String(jobName).trim() : null,
        category ? String(category).trim() : null,
        user ? String(user).trim() : null
      ];

  await query(sql, params);
  return { inserted: true };
}

async function deleteExpense(ownerId, criteria) {
  try {
    const ownerParam = String(ownerId || '').trim();
    const amountCents = toCents(criteria.amount);
    const description = String(criteria.item || '').trim();
    const source = String(criteria.store || '').trim();

    const res = await query(
      `
      delete from transactions
       where owner_id = $1::text
         and kind = 'expense'
         and description = $2
         and amount_cents = $3
         and source = $4
       returning id
      `,
      [ownerParam, description, amountCents, source]
    );
    return res.rows.length > 0;
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

  let reply;

  try {
    const defaultData = {
      date: todayIso(),
      item: 'Unknown',
      amount: '$0.00',
      store: 'Unknown Store'
    };

    let pending = await getPendingTransactionState(from);

    // Normalize aiErrorHandler pendingCorrection -> pendingExpense
    if (pending?.pendingCorrection && pending?.type === 'expense' && pending?.pendingData) {
      const data = pending.pendingData;
      await mergePendingTransactionState(from, {
        ...pending,
        pendingExpense: data,
        pendingCorrection: false,
        expenseSourceMsgId: pending.expenseSourceMsgId || msgId
      });
      pending = await getPendingTransactionState(from);
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

        reply = `Please confirm: Expense ${merged.amount} for ${merged.item} from ${merged.store} on ${merged.date}. Reply yes/edit/cancel.`;
        return `<Response><Message>${reply}</Message></Response>`;
      }

      reply = `What date was this expense? (e.g., 2025-12-12 or "today")`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    // Follow-up: job resolution (contractor-first)
    if (pending?.awaitingExpenseJob && pending?.pendingExpense) {
      const jobReply = String(input || '').trim();
      const merged = { ...pending.pendingExpense, jobName: jobReply };

      await mergePendingTransactionState(from, {
        ...pending,
        pendingExpense: merged,
        awaitingExpenseJob: false
      });

      reply = `Please confirm: Expense ${merged.amount} for ${merged.item} from ${merged.store} on ${merged.date} for ${merged.jobName}. Reply yes/edit/cancel.`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    // --- CONFIRM / DELETE FLOW ---
    if (pending?.pendingExpense || pending?.pendingDelete?.type === 'expense') {
      if (!isOwner) {
        await deletePendingTransactionState(from);
        reply = '⚠️ Only the owner can manage expenses.';
        return `<Response><Message>${reply}</Message></Response>`;
      }

      const lc = String(input || '').toLowerCase().trim();
      const stableMsgId = String(pending.expenseSourceMsgId || msgId).trim();

      // ✅ NEW: If user sends a fresh expense command while waiting for yes/edit/cancel,
      // treat it as a new command: clear pending and continue into parse flow below.
      if (/^(?:expense|exp)\b/.test(lc) && pending?.pendingExpense) {
        await deletePendingTransactionState(from);
        pending = null;
      } else {
        if (lc === 'yes' && pending?.pendingExpense) {
          const data = pending.pendingExpense;

          const category =
            data.suggestedCategory || (await categorizeEntry('expense', data, ownerProfile));

          // prefer job from pending (job resolution flow), else active job
          const jobName =
            (data.jobName && String(data.jobName).trim()) ||
            (await resolveActiveJobName({ ownerId, userProfile })) ||
            null;

          // ✅ enforce job (contractor-first)
          if (!jobName) {
            await mergePendingTransactionState(from, {
              ...pending,
              pendingExpense: data,
              awaitingExpenseJob: true,
              expenseSourceMsgId: stableMsgId
            });
            reply = `Which job is this expense for? Reply with the job name (or "Overhead").`;
            return `<Response><Message>${reply}</Message></Response>`;
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
          if (!gate.ok) return `<Response><Message>${gate.reply}</Message></Response>`;

          const result = await saveExpense({
            ownerId,
            date: data.date,
            item: data.item,
            amount: data.amount,
            store: data.store,
            jobName,
            category,
            user: userProfile?.name || 'Unknown User',
            sourceMsgId: stableMsgId
          });

          reply =
            result && result.inserted === false
              ? '✅ Already logged that expense (duplicate message).'
              : `✅ Expense logged: ${data.amount} for ${data.item} from ${data.store} on ${jobName} (Category: ${category})`;

          await deletePendingTransactionState(from);
          return `<Response><Message>${reply}</Message></Response>`;
        }

        if (lc === 'yes' && pending?.pendingDelete?.type === 'expense') {
          const criteria = pending.pendingDelete;
          const success = await deleteExpense(ownerId, criteria);
          reply = success
            ? `✅ Deleted expense ${criteria.amount} for ${criteria.item} from ${criteria.store}.`
            : `⚠️ Expense not found or deletion failed.`;
          await deletePendingTransactionState(from);
          return `<Response><Message>${reply}</Message></Response>`;
        }

        if (lc === 'edit') {
          await mergePendingTransactionState(from, { ...pending, isEditing: true, type: 'expense' });
          reply = '✏️ Okay — resend the expense in one line (e.g., "expense 84.12 nails from Home Depot").';
          return `<Response><Message>${reply}</Message></Response>`;
        }

        if (lc === 'cancel' || lc === 'no') {
          await deletePendingTransactionState(from);
          reply = '❌ Operation cancelled.';
          return `<Response><Message>${reply}</Message></Response>`;
        }

        reply = `⚠️ Please reply "yes", "edit", or "cancel".`;
        return `<Response><Message>${reply}</Message></Response>`;
      }
    }

    // DELETE EXPENSE REQUEST
    if (String(input || '').toLowerCase().startsWith('delete expense')) {
      if (!isOwner) {
        reply = '⚠️ Only the owner can delete expense entries.';
        return `<Response><Message>${reply}</Message></Response>`;
      }

      const req = parseDeleteRequest(input);
      if (req.type !== 'expense') {
        reply = `⚠️ Invalid delete request. Try "delete expense $100 tools from Home Depot".`;
        return `<Response><Message>${reply}</Message></Response>`;
      }

      await mergePendingTransactionState(from, { pendingDelete: { type: 'expense', ...req.criteria } });
      reply = `Please confirm: Delete expense ${req.criteria.amount} for ${req.criteria.item}? Reply yes/cancel.`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    // DIRECT PARSE PATH
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

      const category = await categorizeEntry('expense', data, ownerProfile);

      const jobName = (await resolveActiveJobName({ ownerId, userProfile })) || null;

      // ✅ enforce job (contractor-first)
      if (!jobName) {
        await mergePendingTransactionState(from, {
          pendingExpense: data,
          awaitingExpenseJob: true,
          expenseSourceMsgId: msgId,
          type: 'expense'
        });
        reply = `Which job is this expense for? Reply with the job name (or "Overhead").`;
        return `<Response><Message>${reply}</Message></Response>`;
      }

      const gate = assertExpenseCILOrClarify({ ownerId, from, userProfile, data, jobName, category, sourceMsgId: msgId });
      if (!gate.ok) return `<Response><Message>${gate.reply}</Message></Response>`;

      const result = await saveExpense({
        ownerId,
        date,
        item,
        amount: data.amount,
        store: data.store,
        jobName,
        category,
        user: userProfile?.name || 'Unknown User',
        sourceMsgId: msgId
      });

      reply =
        result && result.inserted === false
          ? '✅ Already logged that expense (duplicate message).'
          : `✅ Expense logged: ${data.amount} for ${item} from ${data.store} on ${jobName} (Category: ${category})`;

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
      await mergePendingTransactionState(from, {
        pendingExpense: null,
        awaitingExpenseClarification: true,
        expenseClarificationPrompt: aiReply,
        expenseDraftText: input,
        expenseSourceMsgId: msgId,
        type: 'expense'
      });
      return `<Response><Message>${aiReply}</Message></Response>`;
    }

    if (data && data.amount && data.amount !== '$0.00' && data.item && data.store) {
      const errors = await detectErrors(data, 'expense');
      const category = await categorizeEntry('expense', data, ownerProfile);
      data.suggestedCategory = category;

      const jobName = (await resolveActiveJobName({ ownerId, userProfile })) || null;

      // ✅ enforce job (contractor-first)
      if (!jobName) {
        await mergePendingTransactionState(from, {
          pendingExpense: data,
          awaitingExpenseJob: true,
          expenseSourceMsgId: msgId,
          type: 'expense'
        });
        reply = `Which job is this expense for? Reply with the job name (or "Overhead").`;
        return `<Response><Message>${reply}</Message></Response>`;
      }

      if (confirmed && !errors) {
        const gate = assertExpenseCILOrClarify({ ownerId, from, userProfile, data, jobName, category, sourceMsgId: msgId });
        if (!gate.ok) return `<Response><Message>${gate.reply}</Message></Response>`;

        const result = await saveExpense({
          ownerId,
          date: data.date,
          item: data.item,
          amount: data.amount,
          store: data.store,
          jobName,
          category,
          user: userProfile?.name || 'Unknown User',
          sourceMsgId: msgId
        });

        reply =
          result && result.inserted === false
            ? '✅ Already logged that expense (duplicate message).'
            : `✅ Expense logged: ${data.amount} for ${data.item} from ${data.store} on ${jobName} (Category: ${category})`;

        return `<Response><Message>${reply}</Message></Response>`;
      }

      await mergePendingTransactionState(from, {
        pendingExpense: data,
        expenseSourceMsgId: msgId,
        type: 'expense'
      });
      reply = `Please confirm: Expense ${data.amount} for ${data.item} from ${data.store} on ${data.date}. Reply yes/edit/cancel.`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    reply = `🤔 Couldn’t parse an expense from "${input}". Try "expense 84.12 nails from Home Depot".`;
    return `<Response><Message>${reply}</Message></Response>`;
  } catch (error) {
    console.error(`[ERROR] handleExpense failed for ${from}:`, error.message);
    reply = `⚠️ Failed to process expense: ${error.message}`;
    return `<Response><Message>${reply}</Message></Response>`;
  } finally {
    try {
      await require('../../middleware/lock').releaseLock(lockKey);
    } catch {
      // never hard-fail
    }
  }
}

module.exports = { handleExpense };
