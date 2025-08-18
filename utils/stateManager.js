const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function normalizePhoneNumber(userId = '') {
  const val = String(userId || '');
  const noWa = val.startsWith('whatsapp:') ? val.slice('whatsapp:'.length) : val;
  return noWa.replace(/^\+/, '').trim();
}

async function getPendingTransactionState(userId) {
  const normalizedId = normalizePhoneNumber(userId);
  const res = await pool.query(`SELECT * FROM states WHERE user_id = $1`, [normalizedId]);
  return res.rows[0]?.state || null;
}

async function setPendingTransactionState(userId, state) {
  const normalizedId = normalizePhoneNumber(userId);
  await pool.query(
    `INSERT INTO states (user_id, state, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE
     SET state = $2, updated_at = NOW()`,
    [normalizedId, state]
  );
}

async function deletePendingTransactionState(userId) {
  const normalizedId = normalizePhoneNumber(userId);
  await pool.query(`DELETE FROM states WHERE user_id = $1`, [normalizedId]);
}

async function clearUserState(userId) {
  await deletePendingTransactionState(userId);
}

module.exports = {
  getPendingTransactionState,
  setPendingTransactionState,
  deletePendingTransactionState,
  clearUserState
};