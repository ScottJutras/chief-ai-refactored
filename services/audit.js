// services/audit.js
const { getOne, query } = require('./db');

function safeStr(x) {
  const s = String(x ?? '').trim();
  return s || null;
}

async function ensureNotDuplicate(owner_id, idempotency_key) {
  const owner = safeStr(owner_id);
  const key = safeStr(idempotency_key);
  if (!owner || !key) return;

  const existing = await getOne(
    'SELECT id FROM public.audit WHERE owner_id = $1 AND key = $2',
    [owner, key]
  );

  if (existing) {
    const err = new Error('Duplicate operation');
    err.code = 'CONFLICT';
    throw err;
  }
}

async function recordAudit({ owner_id, key, action, details }) {
  const owner = safeStr(owner_id);
  if (!owner) throw new Error('Missing owner_id');

  await query(
    'INSERT INTO public.audit (owner_id, key, action, details) VALUES ($1, $2, $3, $4)',
    [owner, safeStr(key), safeStr(action), details || {}]
  );
}

module.exports = { ensureNotDuplicate, recordAudit };
