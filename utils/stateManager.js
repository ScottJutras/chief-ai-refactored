// utils/stateManager.js
const { query } = require('../services/postgres');

function normalizePhoneNumber(userId = '') {
  const val = String(userId || '');
  const noWa = val.startsWith('whatsapp:') ? val.slice('whatsapp:'.length) : val;
  return noWa.replace(/^\+/, '').replace(/\D/g, '').trim();
}

async function getPendingTransactionState(userId) {
  const normalizedId = normalizePhoneNumber(userId);
  const res = await query(`SELECT state FROM public.states WHERE user_id = $1`, [normalizedId]);
  return res.rows[0]?.state || null;
}

async function setPendingTransactionState(userId, state) {
  const normalizedId = normalizePhoneNumber(userId);
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
}

async function deletePendingTransactionState(userId) {
  const normalizedId = normalizePhoneNumber(userId);
  await query(`DELETE FROM public.states WHERE user_id = $1`, [normalizedId]);
}

async function clearUserState(userId) {
  await deletePendingTransactionState(userId);
}

module.exports = {
  getPendingTransactionState,
  setPendingTransactionState,
  deletePendingTransactionState,
  clearUserState,
};
