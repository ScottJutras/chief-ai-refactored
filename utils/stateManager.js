// utils/stateManager.js
const { query } = require('../services/postgres');

function normalizePhoneNumber(userId = '') {
  const val = String(userId || '');
  const noWa = val.startsWith('whatsapp:') ? val.slice('whatsapp:'.length) : val;
  return noWa.replace(/^\+/, '').replace(/\D/g, '').trim();
}

// Ensure we always work with plain objects for jsonb state
function safeObject(x) {
  if (!x) return null;
  if (typeof x === 'object' && !Array.isArray(x)) return x;
  if (typeof x === 'string') {
    try {
      const parsed = JSON.parse(x);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return null;
}

// Shallow merge at root, merge known nested buckets
function mergeState(prev, patch) {
  const a = safeObject(prev) || {};
  const b = safeObject(patch) || {};

  const out = { ...a, ...b };

  // Special handling for legacy pendingMedia boolean
  const aPendingMedia = a.pendingMedia;
  const bPendingMedia = b.pendingMedia;

  if (aPendingMedia === true && bPendingMedia && typeof bPendingMedia === 'object' && !Array.isArray(bPendingMedia)) {
    out.pendingMedia = { ...bPendingMedia };
  } else if (
    bPendingMedia === true &&
    aPendingMedia &&
    typeof aPendingMedia === 'object' &&
    !Array.isArray(aPendingMedia)
  ) {
    out.pendingMedia = { ...aPendingMedia };
  }

  const nestedKeys = [
    'pendingRevenue',
    'pendingExpense',
    'pendingTimeEntry',
    'pendingHours',
    'pendingMedia',
    'pendingMediaMeta',
    'pendingDelete',
    'pendingCorrection',
  ];

  for (const k of nestedKeys) {
    const av = a[k];
    const bv = b[k];
    if (av && bv && typeof av === 'object' && typeof bv === 'object' && !Array.isArray(av) && !Array.isArray(bv)) {
      out[k] = { ...av, ...bv };
    }
  }

  return out;
}

async function getPendingTransactionState(userId) {
  const normalizedId = normalizePhoneNumber(userId);
  const res = await query(`SELECT state FROM public.states WHERE user_id = $1`, [normalizedId]);
  const raw = res.rows[0]?.state || null;
  return safeObject(raw) || raw || null;
}

async function setPendingTransactionState(userId, state, options = null) {
  const normalizedId = normalizePhoneNumber(userId);
  const merge = !!options?.merge;

  if (!merge) {
    await query(
      `
      INSERT INTO public.states (user_id, state, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (user_id) DO UPDATE
        SET state = EXCLUDED.state,
            updated_at = NOW()
      `,
      [normalizedId, state]
    );
    return;
  }

  const prev = await getPendingTransactionState(normalizedId);
  const merged = mergeState(prev, state);

  await query(
    `
    INSERT INTO public.states (user_id, state, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (user_id) DO UPDATE
      SET state = EXCLUDED.state,
          updated_at = NOW()
    `,
    [normalizedId, merged]
  );
}

async function mergePendingTransactionState(userId, patch) {
  return setPendingTransactionState(userId, patch, { merge: true });
}

async function deletePendingTransactionState(userId) {
  const normalizedId = normalizePhoneNumber(userId);
  await query(`DELETE FROM public.states WHERE user_id = $1`, [normalizedId]);
}

async function clearUserState(userId) {
  await deletePendingTransactionState(userId);
}

async function clearPendingMediaMeta(userId) {
  const normalizedId = normalizePhoneNumber(userId);
  const prev = await getPendingTransactionState(normalizedId);
  const obj = safeObject(prev) || {};
  obj.pendingMediaMeta = null;
  await setPendingTransactionState(normalizedId, obj);
}

async function clearStateKeys(userId, keys = []) {
  const normalizedId = normalizePhoneNumber(userId);
  const prev = await getPendingTransactionState(normalizedId);
  const obj = safeObject(prev) || {};
  for (const k of keys) obj[k] = null;
  await setPendingTransactionState(normalizedId, obj);
}

async function clearFinanceFlow(userId) {
  return clearStateKeys(userId, [
    'pendingRevenue',
    'pendingExpense',
    'awaitingRevenueJob',
    'awaitingExpenseJob',
    'awaitingRevenueClarification',
    'awaitingExpenseClarification',
    'revenueClarificationPrompt',
    'expenseClarificationPrompt',
    'revenueDraftText',
    'expenseDraftText',
    'revenueSourceMsgId',
    'expenseSourceMsgId',
    'pendingMedia',
    'pendingMediaMeta',
    'type',
    'kind',
  ]);
}

// ✅ Compatibility aliases (older files may call these)
const deletePendingState = deletePendingTransactionState;
const clearPendingTransactionState = deletePendingTransactionState;

module.exports = {
  normalizePhoneNumber,
  safeObject,
  mergeState,

  getPendingTransactionState,
  setPendingTransactionState,
  mergePendingTransactionState,
  deletePendingTransactionState,
  deletePendingState,
  clearPendingTransactionState,

  clearUserState,
  clearPendingMediaMeta,
  clearStateKeys,
  clearFinanceFlow,
};
