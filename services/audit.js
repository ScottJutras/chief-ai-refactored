// services/audit.js
const { getOne, query } = require('./db');

async function ensureNotDuplicate(owner_id, idempotency_key) {
  if (!idempotency_key) return;
  const existing = await getOne(
    'SELECT id FROM audit WHERE owner_id = $1 AND key = $2',
    [owner_id, idempotency_key]
  );
  if (existing) {
    const err = new Error('Duplicate operation');
    err.code = 'CONFLICT';
    throw err;
  }
}

async function recordAudit({ owner_id, key, action, details }) {
  await query(
    'INSERT INTO audit (owner_id, key, action, details) VALUES ($1, $2, $3, $4)',
    [owner_id, key, action, details || {}]
  );
}

module.exports = { ensureNotDuplicate, recordAudit };
