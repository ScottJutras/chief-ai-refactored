// handlers/commands/revenue.js
const { query, getActiveJob } = require('../../services/postgres');
const {
  getPendingTransactionState,
  setPendingTransactionState,
  deletePendingTransactionState
} = require('../../utils/stateManager');
const {
  handleInputWithAI,
  parseRevenueMessage,
  detectErrors,
  categorizeEntry
} = require('../../utils/aiErrorHandler');
const { validateCIL } = require('../../cil');

// ---- column presence caches (safe in serverless) ----
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

function todayInTimeZone(tz) {
  try {
    const dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    return dtf.format(new Date()); // YYYY-MM-DD
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

function parseNaturalDate(s, tz) {
  const t = String(s || '').trim().toLowerCase();
  const today = todayInTimeZone(tz);

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
 * CIL: revenue is "payment" received
 */
function buildRevenueCIL({ ownerId, from, userProfile, data, jobName, category, sourceMsgId }) {
  const cents = toCents(data.amount);
  return {
    cil_version: "1.0",
    type: "payment",
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

    amount_cents: cents,
    currency: "CAD",

    payer: data.source && data.source !== 'Unknown' ? String(data.source) : undefined,
    memo: data.description && data.description !== 'Unknown' ? String(data.description) : undefined,
    category: category ? String(category) : undefined,
  };
}

function assertRevenueCILOrClarify({ ownerId, from, userProfile, data, jobName, category, sourceMsgId }) {
  try {
    const cil = buildRevenueCIL({ ownerId, from, userProfile, data, jobName, category, sourceMsgId });
    validateCIL(cil);
    return { ok: true, cil };
  } catch {
    return {
      ok: false,
      reply: `⚠️ Couldn't log that payment yet. Try: "revenue 2500 from Client".`
    };
  }
}

/**
 * Persist to your actual transactions table:
 * columns: owner_id, kind, date, description, amount_cents, source, job_name, category, user_name, source_msg_id, created_at
 * (and amount, if present)
 */
async function saveRevenue({ ownerId, date, description, amount, source, jobName, category, user, sourceMsgId }) {
  const amountCents = toCents(amount);
  if (!amountCents || amountCents <= 0) throw new Error('Invalid amount');

  const canUseMsgId = await hasSourceMsgIdColumn();
  const canUseAmount = await hasAmountColumn();
  const amountDollars = toDollars(amount);

  if (canUseMsgId) {
    const sql = canUseAmount
      ? `
        insert into transactions
          (owner_id, kind, date, description, amount_cents, amount, source, job_name, category, user_name, source_msg_id, created_at)
        values
          ($1, 'revenue', $2::date, $3, $4, $5, $6, $7, $8, $9, $10, now())
        on conflict do nothing
        returning id
      `
      : `
        insert into transactions
          (owner_id, kind, date, description, amount_cents, source, job_name, category, user_name, source_msg_id, created_at)
        values
          ($1, 'revenue', $2::date, $3, $4, $5, $6, $7, $8, $9, now())
        on conflict do nothing
        returning id
      `;

    const params = canUseAmount
      ? [
          ownerId,
          date,
          String(description || '').trim() || 'Unknown',
          amountCents,
          amountDollars,
          String(source || '').trim() || 'Unknown',
          String(jobName || '').trim() || null,
          String(category || '').trim() || null,
          String(user || '').trim() || null,
          String(sourceMsgId || '').trim()
        ]
      : [
          ownerId,
          date,
          String(description || '').trim() || 'Unknown',
          amountCents,
          String(source || '').trim() || 'Unknown',
          String(jobName || '').trim() || null,
          String(category || '').trim() || null,
          String(user || '').trim() || null,
          String(sourceMsgId || '').trim()
        ];

    const res = await query(sql, params);
    if (!res.rows.length) return { inserted: false };
    return { inserted: true, id: res.rows[0].id };
  }

  const sql = canUseAmount
    ? `
      insert into transactions
        (owner_id, kind, date, description, amount_cents, amount, source, job_name, category, user_name, created_at)
      values
        ($1, 'revenue', $2::date, $3, $4, $5, $6, $7, $8, $9, now())
    `
    : `
      insert into transactions
        (owner_id, kind, date, description, amount_cents, source, job_name, category, user_name, created_at)
      values
        ($1, 'revenue', $2::date, $3, $4, $5, $6, $7, $8, now())
    `;

  const params = canUseAmount
    ? [
        ownerId,
        date,
        String(description || '').trim() || 'Unknown',
        amountCents,
        amountDollars,
        String(source || '').trim() || 'Unknown',
        String(jobName || '').trim() || null,
        String(category || '').trim() || null,
        String(user || '').trim() || null
      ]
    : [
        ownerId,
        date,
        String(description || '').trim() || 'Unknown',
        amountCents,
        String(source || '').trim() || 'Unknown',
        String(jobName || '').trim() || null,
        String(category || '').trim() || null,
        String(user || '').trim() || null
      ];

  await query(sql, params);
  return { inserted: true };
}

async function handleRevenue(from, input, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId) {
  const lockKey = `lock:${from}`;
  const msgId = String(sourceMsgId || '').trim() || `${from}:${Date.now()}`;

  let reply;

  try {
    const defaultData = {
      date: todayInTimeZone(userProfile?.timezone || userProfile?.tz || 'UTC'),
      description: 'Unknown',
      amount: '$0.00',
      source: 'Unknown'
    };

    let pending = await getPendingTransactionState(from);

    // --- Normalize aiErrorHandler pendingCorrection -> pendingRevenue ---
    if (pending?.pendingCorrection && pending?.type === 'revenue' && pending?.pendingData) {
      const data = pending.pendingData;
      await setPendingTransactionState(from, {
        ...pending,
        pendingRevenue: data,
        pendingCorrection: false
      });
      pending = await getPendingTransactionState(from);
    }

    // --- Follow-up for "AI asked a question" (date, etc.) ---
    if (pending?.awaitingRevenueClarification) {
      const tz = userProfile?.timezone || userProfile?.tz || 'UTC';
      const maybeDate = parseNaturalDate(input, tz);

      if (maybeDate) {
        const draft = pending.revenueDraftText || '';
        const parsed = parseRevenueMessage(draft) || {};
        const merged = {
          ...parsed,
          date: maybeDate
        };

        await setPendingTransactionState(from, {
          ...pending,
          pendingRevenue: merged,
          awaitingRevenueClarification: false
        });

        reply = `Please confirm: Payment ${merged.amount} from ${merged.source} on ${merged.date}. Reply yes/edit/cancel.`;
        return `<Response><Message>${reply}</Message></Response>`;
      }

      reply = `What date was this payment? (e.g., 2025-12-12 or "today")`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    // --- CONFIRM FLOW ---
    if (pending?.pendingRevenue) {
      if (!isOwner) {
        await deletePendingTransactionState(from);
        reply = '⚠️ Only the owner can manage revenue.';
        return `<Response><Message>${reply}</Message></Response>`;
      }

      const lcInput = input.toLowerCase().trim();

      if (lcInput === 'yes') {
        const data = pending.pendingRevenue;
        const category = data.suggestedCategory || await categorizeEntry('revenue', data, ownerProfile);
        const jobName = await getActiveJob(ownerId) || 'Uncategorized';

        const gate = assertRevenueCILOrClarify({ ownerId, from, userProfile, data, jobName, category, sourceMsgId: (pending.revenueSourceMsgId || msgId) });
        if (!gate.ok) return `<Response><Message>${gate.reply}</Message></Response>`;

        const result = await saveRevenue({
          ownerId,
          date: data.date,
          description: data.description,
          amount: data.amount,
          source: data.source,
          jobName,
          category,
          user: userProfile.name || 'Unknown User',
          sourceMsgId: (pending.revenueSourceMsgId || msgId)
        });

        reply = (result.inserted === false)
          ? '✅ Already logged that payment (duplicate message).'
          : `✅ Payment logged: ${data.amount} from ${data.source} (Category: ${category})`;

        await deletePendingTransactionState(from);
        return `<Response><Message>${reply}</Message></Response>`;
      }

      if (lcInput === 'edit') {
        await setPendingTransactionState(from, {
          ...pending,
          isEditing: true,
          type: 'revenue'
        });
        reply = '✏️ Okay — resend the revenue in one line (e.g., "revenue $100 from John today").';
        return `<Response><Message>${reply}</Message></Response>`;
      }

      if (lcInput === 'cancel' || lcInput === 'no') {
        await deletePendingTransactionState(from);
        reply = '❌ Payment cancelled.';
        return `<Response><Message>${reply}</Message></Response>`;
      }

      reply = `⚠️ Please respond with 'yes', 'edit', or 'cancel'.`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    // --- AI PARSE PATH ---
    const { data, reply: aiReply, confirmed } = await handleInputWithAI(
      from,
      input,
      'revenue',
      parseRevenueMessage,
      defaultData
    );

    if (aiReply) {
      await setPendingTransactionState(from, {
        pendingRevenue: null,
        awaitingRevenueClarification: true,
        revenueClarificationPrompt: aiReply,
        revenueDraftText: input,
        revenueSourceMsgId: msgId,
        type: 'revenue'
      });
      return `<Response><Message>${aiReply}</Message></Response>`;
    }

    if (data && data.amount && data.amount !== '$0.00' && data.description && data.source) {
      const errors = await detectErrors(data, 'revenue');
      const category = await categorizeEntry('revenue', data, ownerProfile);
      data.suggestedCategory = category;

      // If clean + confirmed => write
      if (confirmed && !errors) {
        const jobName = await getActiveJob(ownerId) || 'Uncategorized';

        const gate = assertRevenueCILOrClarify({ ownerId, from, userProfile, data, jobName, category, sourceMsgId: msgId });
        if (!gate.ok) return `<Response><Message>${gate.reply}</Message></Response>`;

        const result = await saveRevenue({
          ownerId,
          date: data.date,
          description: data.description,
          amount: data.amount,
          source: data.source,
          jobName,
          category,
          user: userProfile.name || 'Unknown User',
          sourceMsgId: msgId
        });

        reply = (result.inserted === false)
          ? '✅ Already logged that payment (duplicate message).'
          : `✅ Payment logged: ${data.amount} from ${data.source} on ${jobName} (Category: ${category})`;

        return `<Response><Message>${reply}</Message></Response>`;
      }

      // Otherwise ask confirm
      await setPendingTransactionState(from, {
        pendingRevenue: data,
        revenueSourceMsgId: msgId,
        type: 'revenue'
      });
      reply = `Please confirm: Payment ${data.amount} from ${data.source} on ${data.date}. Reply yes/edit/cancel.`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    reply = `🤔 Couldn’t parse a payment from "${input}". Try "revenue $100 from John today".`;
    return `<Response><Message>${reply}</Message></Response>`;
  } catch (error) {
    console.error(`[ERROR] handleRevenue failed for ${from}:`, error.message);
    reply = '⚠️ Error logging payment. Please try again.';
    return `<Response><Message>${reply}</Message></Response>`;
  } finally {
    try {
      await require('../../middleware/lock').releaseLock(lockKey);
    } catch {
      // never hard-fail
    }
  }
}

module.exports = { handleRevenue };
