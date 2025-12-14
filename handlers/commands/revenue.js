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

// Cache whether transactions.source_msg_id exists (you confirmed it does, but keep safe)
let _hasSourceMsgIdCol = null;
async function hasSourceMsgIdColumn() {
  if (_hasSourceMsgIdCol !== null) return _hasSourceMsgIdCol;
  try {
    const r = await query(
      `select 1
         from information_schema.columns
        where table_name = 'transactions'
          and column_name = 'source_msg_id'
        limit 1`
    );
    _hasSourceMsgIdCol = (r?.rows?.length || 0) > 0;
  } catch {
    _hasSourceMsgIdCol = false;
  }
  return _hasSourceMsgIdCol;
}

function toCents(amountStr) {
  const n = Number(String(amountStr || '').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
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
    validateCIL(cil); // payment is now supported in schema.js
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
 */
async function saveRevenue({ ownerId, date, description, amount, source, jobName, category, user, sourceMsgId }) {
  const amountCents = toCents(amount);
  if (!amountCents || amountCents <= 0) throw new Error('Invalid amount');

  const canUseMsgId = await hasSourceMsgIdColumn();

  if (canUseMsgId) {
    // Requires a partial unique index like:
    // ON transactions(owner_id, source_msg_id) WHERE kind='revenue'
    const res = await query(
      `
      insert into transactions
        (owner_id, kind, date, description, amount_cents, source, job_name, category, user_name, source_msg_id, created_at)
      values
        ($1, 'revenue', $2::date, $3, $4, $5, $6, $7, $8, $9, now())
      on conflict do nothing
      returning id
      `,
      [
        ownerId,
        date,
        String(description || '').trim() || 'Unknown',
        amountCents,
        String(source || '').trim() || 'Unknown',
        String(jobName || '').trim() || null,
        String(category || '').trim() || null,
        String(user || '').trim() || null,
        String(sourceMsgId || '').trim()
      ]
    );

    if (!res.rows.length) return { inserted: false };
    return { inserted: true, id: res.rows[0].id };
  }

  await query(
    `
    insert into transactions
      (owner_id, kind, date, description, amount_cents, source, job_name, category, user_name, created_at)
    values
      ($1, 'revenue', $2::date, $3, $4, $5, $6, $7, $8, now())
    `,
    [
      ownerId,
      date,
      String(description || '').trim() || 'Unknown',
      amountCents,
      String(source || '').trim() || 'Unknown',
      String(jobName || '').trim() || null,
      String(category || '').trim() || null,
      String(user || '').trim() || null
    ]
  );

  return { inserted: true };
}

async function handleRevenue(from, input, userProfile, ownerId, ownerProfile, isOwner, sourceMsgId) {
  const lockKey = `lock:${from}`;
  const msgId = String(sourceMsgId || '').trim() || `${from}:${Date.now()}`;

  let reply;

  try {
    const defaultData = {
      date: new Date().toISOString().split('T')[0],
      description: 'Unknown',
      amount: '$0.00',
      source: 'Unknown'
    };

    const pending = await getPendingTransactionState(from);

    // CONFIRM FLOW
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
          : `✅ Payment logged: ${data.amount} from ${data.source} (Category: ${category})`;

        await deletePendingTransactionState(from);
        return `<Response><Message>${reply}</Message></Response>`;
      }

      if (lcInput === 'edit' || lcInput === 'no') {
  await setPendingTransactionState(from, {
    pendingRevenue: pending.pendingRevenue,
    isEditing: true,
    type: 'revenue'
  });
  reply = '✏️ Okay — resend the revenue in one line (e.g., "revenue $100 from John").';
  return `<Response><Message>${reply}</Message></Response>`;
}



      if (lcInput === 'cancel') {
        await deletePendingTransactionState(from);
        reply = '❌ Payment cancelled.';
        return `<Response><Message>${reply}</Message></Response>`;
      }

      reply = `⚠️ Please respond with 'yes', 'edit', or 'cancel'.`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    // AI PARSE PATH
    const { data, reply: aiReply, confirmed } = await handleInputWithAI(
      from,
      input,
      'revenue',
      parseRevenueMessage,
      defaultData
    );
    if (aiReply) return `<Response><Message>${aiReply}</Message></Response>`;

    if (data && data.amount && data.amount !== '$0.00' && data.description && data.source) {
      const errors = await detectErrors(data, 'revenue');
      const category = await categorizeEntry('revenue', data, ownerProfile);
      data.suggestedCategory = category;

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

      // If not confirmed or errors exist, ask confirm (optional — keep simple)
      await setPendingTransactionState(from, { pendingRevenue: data });
      reply = `Please confirm: Payment ${data.amount} from ${data.source} (${data.description}). Reply yes/edit/cancel.`;
      return `<Response><Message>${reply}</Message></Response>`;
    }

    reply = `🤔 Couldn’t parse a payment from "${input}". Try "revenue $100 from Client".`;
    return `<Response><Message>${reply}</Message></Response>`;
  } catch (error) {
    console.error(`[ERROR] handleRevenue failed for ${from}:`, error.message);
    reply = '⚠️ Error logging payment. Please try again.';
    return `<Response><Message>${reply}</Message></Response>`;
  } finally {
  try {
    // handlers/commands/* -> ../../middleware/lock
    await require('../../middleware/lock').releaseLock(lockKey);
  } catch {
    // If lock middleware isn't available in serverless bundle, never hard-fail
  }
}
}

module.exports = { handleRevenue };
