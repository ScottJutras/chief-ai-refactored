// utils/stateManager.js
const { query } = require('../services/postgres');

function normalizePhoneNumber(userId = '') {
  const val = String(userId || '');
  const noWa = val.startsWith('whatsapp:') ? val.slice('whatsapp:'.length) : val;
  return noWa.replace(/^\+/, '').replace(/\D/g, '').trim();
}

// Be tolerant: the JSONB column should return an object, but older rows or bugs
// might have strings/nulls.
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

// Merge strategy:
// - shallow merge at root
// - for known nested “buckets”, merge objects instead of overwrite
function mergeState(prev, patch) {
  const a = safeObject(prev) || {};
  const b = safeObject(patch) || {};

  const out = { ...a, ...b };

  // Common nested objects where we want object-merge (not replace)
  const nestedKeys = [
    'pendingRevenue',
    'pendingExpense',
    'pendingTimeEntry',
    'pendingHours',
    'pendingMedia',
    'pendingMediaMeta',
  ];

  for (const k of nestedKeys) {
    if (a[k] && b[k] && typeof a[k] === 'object' && typeof b[k] === 'object' && !Array.isArray(a[k]) && !Array.isArray(b[k])) {
      out[k] = { ...a[k], ...b[k] };
    }
  }

  return out;
}

async function getPendingTransactionState(userId) {
  const normalizedId = normalizePhoneNumber(userId);
  const res = await query(`SELECT state FROM public.states WHERE user_id = $1`, [normalizedId]);
  return res.rows[0]?.state || null;
}

/**
 * setPendingTransactionState(userId, state, options?)
 *
 * Backwards-compatible:
 * - default behavior is FULL REPLACE (same as your current implementation)
 *
 * New behavior:
 * - pass { merge: true } to merge into existing state rather than overwrite it.
 */
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

  // Merge path: read existing state and merge in JS (simple + predictable)
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

/**
 * Merge a patch into state (recommended for “surgical” updates).
 */
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

/**
 * Optional helper: clears pendingMediaMeta without wiping the rest of the state.
 */
async function clearPendingMediaMeta(userId) {
  const normalizedId = normalizePhoneNumber(userId);
  const prev = await getPendingTransactionState(normalizedId);
  const obj = safeObject(prev) || {};
  if (!obj || typeof obj !== 'object') return;

  obj.pendingMediaMeta = null;
  // also common: pendingMedia sometimes used as a “waiting” flag
  // leave pendingMedia alone unless you explicitly want it cleared elsewhere
  await setPendingTransactionState(normalizedId, obj);
}

module.exports = {
  getPendingTransactionState,
  setPendingTransactionState,
  mergePendingTransactionState,
  deletePendingTransactionState,
  clearUserState,
  clearPendingMediaMeta,
};
