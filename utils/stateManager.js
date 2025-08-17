const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Get pending transaction state
async function getPendingTransactionState(from) {
  const res = await pool.query(`SELECT state FROM states WHERE user_id = $1`, [from]);
  return res.rows[0]?.state || null;
}

// Set pending transaction state
async function setPendingTransactionState(from, state) {
  await pool.query(
    `INSERT INTO states (user_id, state) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET state = $2`,
    [from, state]
  );
}

// Delete pending transaction state
async function deletePendingTransactionState(from) {
  await pool.query(`DELETE FROM states WHERE user_id = $1`, [from]);
}

// Clear all state for user (call on delete/restart)
async function clearUserState(from) {
  await deletePendingTransactionState(from);
  // Add locks if needed
  await pool.query(`DELETE FROM locks WHERE user_id = $1`, [from]);
}

module.exports = { getPendingTransactionState, setPendingTransactionState, deletePendingTransactionState, clearUserState };