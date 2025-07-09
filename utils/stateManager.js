const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function getPendingTransactionState(userId) {
  console.log(`[DEBUG] getPendingTransactionState called for userId: ${userId}`);
  try {
    const res = await pool.query(
      `SELECT state FROM states WHERE user_id = $1`,
      [userId]
    );
    console.log(`[DEBUG] getPendingTransactionState result:`, res.rows[0]?.state || null);
    return res.rows[0]?.state || null;
  } catch (error) {
    console.error(`[ERROR] getPendingTransactionState failed for ${userId}:`, error.message);
    throw error;
  }
}

async function setPendingTransactionState(userId, state) {
  console.log(`[DEBUG] setPendingTransactionState called for userId: ${userId}, state:`, state);
  try {
    await pool.query(
      `INSERT INTO states (user_id, state, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET state = $2, updated_at = NOW()`,
      [userId, state]
    );
    console.log(`[DEBUG] setPendingTransactionState success for ${userId}`);
  } catch (error) {
    console.error(`[ERROR] setPendingTransactionState failed for ${userId}:`, error.message);
    throw error;
  }
}

async function deletePendingTransactionState(userId) {
  console.log(`[DEBUG] deletePendingTransactionState called for userId: ${userId}`);
  try {
    await pool.query(
      `DELETE FROM states WHERE user_id = $1`,
      [userId]
    );
    console.log(`[DEBUG] deletePendingTransactionState success for ${userId}`);
  } catch (error) {
    console.error(`[ERROR] deletePendingTransactionState failed for ${userId}:`, error.message);
    throw error;
  }
}

module.exports = {
  getPendingTransactionState,
  setPendingTransactionState,
  deletePendingTransactionState
};