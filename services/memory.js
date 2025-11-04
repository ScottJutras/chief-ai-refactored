// services/memory.js
const { query } = require('./postgres');

async function logEvent(tenantId, userId, kind, payload) {
  await query(
    `INSERT INTO assistant_events (tenant_id, user_id, kind, payload)
     VALUES ($1,$2,$3,$4)`,
    [tenantId, userId, kind, payload]
  );
}
async function getMemory(tenantId, userId, keys = []) {
  if (!keys.length) return {};
  const { rows } = await query(
    `SELECT key, value FROM user_memory WHERE tenant_id=$1 AND user_id=$2 AND key=ANY($3)`,
    [tenantId, userId, keys]
  );
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}
async function upsertMemory(tenantId, userId, key, value) {
  await query(
    `INSERT INTO user_memory (tenant_id, user_id, key, value, updated_at)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (tenant_id,user_id,key)
     DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
    [tenantId, userId, key, value]
  );
}
async function getConvoState(tenantId, userId) {
  const { rows } = await query(
    `SELECT active_job, active_job_id, aliases, last_intent, last_args, history
       FROM convo_state WHERE tenant_id=$1 AND user_id=$2`,
    [tenantId, userId]
  );
  return rows[0] || {
    active_job: null, active_job_id: null, aliases: {}, last_intent: null, last_args: {}, history: []
  };
}
async function saveConvoState(tenantId, userId, patch = {}) {
  const current = await getConvoState(tenantId, userId);
  const next = {
    ...current,
    ...patch,
    aliases: { ...(current.aliases||{}), ...(patch.aliases||{}) },
    history: Array.isArray(patch.history) ? patch.history.slice(-5) : (current.history||[]).slice(-5)
  };
  await query(
    `INSERT INTO convo_state (tenant_id,user_id,active_job,active_job_id,aliases,last_intent,last_args,history,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT (tenant_id,user_id)
     DO UPDATE SET
       active_job=EXCLUDED.active_job,
       active_job_id=EXCLUDED.active_job_id,
       aliases=EXCLUDED.aliases,
       last_intent=EXCLUDED.last_intent,
       last_args=EXCLUDED.last_args,
       history=EXCLUDED.history,
       updated_at=NOW()`,
    [
      tenantId, userId,
      next.active_job, next.active_job_id, next.aliases,
      next.last_intent, next.last_args, JSON.stringify(next.history||[])
    ]
  );
  return next;
}
async function getEntitySummary(tenantId, entityType, entityId) {
  const { rows } = await query(
    `SELECT summary FROM entity_summary WHERE tenant_id=$1 AND entity_type=$2 AND entity_id=$3`,
    [tenantId, entityType, entityId]
  );
  return rows[0]?.summary || null;
}
async function upsertEntitySummary(tenantId, entityType, entityId, summary) {
  await query(
    `INSERT INTO entity_summary (tenant_id, entity_type, entity_id, summary, updated_at)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (tenant_id, entity_type, entity_id)
     DO UPDATE SET summary=EXCLUDED.summary, updated_at=NOW()`,
    [tenantId, entityType, entityId, summary]
  );
}
module.exports = {
  logEvent, getMemory, upsertMemory,
  getConvoState, saveConvoState,
  getEntitySummary, upsertEntitySummary
};