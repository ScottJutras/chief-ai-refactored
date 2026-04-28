// services/reminders.js
// ============================================================================
// Reminders CRUD against the rebuild schema.
//
// Rebuild target: public.reminders (P1A-1 amendment — see
// migrations/2026_04_22_amendment_reminders_and_insight_log.sql).
//
// Identity model (Engineering Constitution §2):
//   - tenant_id (uuid, REQUIRED on every write)   — portal/RLS boundary
//   - owner_id  (digit string, REQUIRED)          — ingestion/audit boundary
//   - user_id   (digit string, OPTIONAL)          — actor scope
//
// Schema delta from pre-rebuild (R4 migration):
//   remind_at         → due_at                       (renamed)
//   sent + canceled   → sent_at + cancelled_at       (NULLs encode pending)
//   status enum       → derived from sent_at/cancelled_at NULL state
//   task_no/title/shift_id → payload jsonb           (no dedicated columns)
//   kind 'lunch_reminder' → kind 'lunch'             (renamed enum value)
//   id bigserial      → uuid (gen_random_uuid)
//   ADDED tenant_id (uuid NOT NULL)
//   ADDED correlation_id (uuid NOT NULL, §17.21)
//
// Worker (workers/reminder_dispatch.js) reads task_no/task_title/shift_id at
// row-top-level; this module unpacks payload jsonb so the worker's call shape
// is preserved.
// ============================================================================

const crypto = require('crypto');
const { query } = require('./postgres');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_KINDS = new Set(['task', 'lunch', 'custom']);

function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }

function normOwner(x) {
  const s = String(x ?? '').trim();
  return s || null;
}

function normUserId(x) {
  const raw = String(x ?? '').trim();
  if (!raw) return null;
  const digits = raw.replace(/^whatsapp:/i, '').replace(/^\+/, '').replace(/\D/g, '');
  if (digits && digits.length >= 8) return digits;
  return raw;
}

function toIso(dt) {
  if (!dt) return null;
  const d = dt instanceof Date ? dt : new Date(dt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function ensureTenantId(tenantId) {
  if (!isUuid(tenantId)) {
    throw new Error('[reminders] tenantId is required and must be a uuid');
  }
  return tenantId;
}

function ensureOwnerId(ownerId) {
  const owner = normOwner(ownerId);
  if (!owner) throw new Error('[reminders] ownerId is required');
  return owner;
}

function ensureCorrelationId(id) {
  return isUuid(id) ? id : crypto.randomUUID();
}

// Decompose row.payload jsonb back into worker-expected top-level keys.
function shapeWorkerRow(row) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    owner_id: row.owner_id,
    user_id: row.user_id,
    kind: row.kind,
    due_at: row.due_at,
    task_no: payload.task_no ?? null,
    task_title: payload.task_title ?? null,
    shift_id: payload.shift_id ?? null,
    correlation_id: row.correlation_id,
  };
}

async function insertReminder({ tenantId, ownerId, userId, kind, remindAt, payload, sourceMsgId, correlationId }) {
  const tenant = ensureTenantId(tenantId);
  const owner = ensureOwnerId(ownerId);
  const user = normUserId(userId);
  const dueIso = toIso(remindAt);
  if (!dueIso) throw new Error('[reminders] Invalid remindAt');

  const safeKind = String(kind || 'task').trim() || 'task';
  if (!VALID_KINDS.has(safeKind)) {
    throw new Error(`[reminders] kind must be one of task|lunch|custom (got ${safeKind})`);
  }

  const sm = String(sourceMsgId || '').trim() || null;
  const corr = ensureCorrelationId(correlationId);
  const safePayload = payload && typeof payload === 'object' ? payload : {};

  // ON CONFLICT uses the partial unique index reminders_owner_source_msg_unique_idx
  // (owner_id, source_msg_id) WHERE source_msg_id IS NOT NULL — only fires when
  // sm is non-null because NULL never conflicts under that predicate.
  const sql = `
    insert into public.reminders
      (tenant_id, owner_id, user_id, kind, due_at, payload, source_msg_id, correlation_id)
    values
      ($1::uuid, $2, $3, $4, $5::timestamptz, $6::jsonb, $7, $8::uuid)
    on conflict (owner_id, source_msg_id) where source_msg_id is not null
    do nothing
    returning id, tenant_id, owner_id, correlation_id
  `;

  const res = await query(sql, [tenant, owner, user, safeKind, dueIso, safePayload, sm, corr]);
  if (res?.rowCount) {
    const row = res.rows[0];
    return { inserted: true, id: row.id, tenantId: row.tenant_id, ownerId: row.owner_id, correlationId: row.correlation_id };
  }
  return { inserted: false, id: null, tenantId: null, ownerId: null, correlationId: null };
}

async function createReminder({
  tenantId,
  ownerId,
  userId,
  taskNo = null,
  taskTitle = null,
  jobNo = null,
  remindAt,
  kind = 'task',
  sourceMsgId = null,
  correlationId = null,
}) {
  const payload = {};
  if (taskNo != null) payload.task_no = Number(taskNo);
  if (taskTitle) payload.task_title = String(taskTitle).trim();
  if (jobNo != null) payload.job_no = Number(jobNo);

  return insertReminder({
    tenantId, ownerId, userId, kind, remindAt, payload, sourceMsgId, correlationId,
  });
}

async function createLunchReminder({
  tenantId,
  ownerId,
  userId,
  shiftId,
  remindAt,
  sourceMsgId = null,
  correlationId = null,
}) {
  const payload = {};
  if (shiftId != null) payload.shift_id = String(shiftId);

  return insertReminder({
    tenantId, ownerId, userId,
    kind: 'lunch',
    remindAt, payload, sourceMsgId, correlationId,
  });
}

async function getDueReminders({ now = new Date(), limit = 500 } = {}) {
  const nowIso = toIso(now) || new Date().toISOString();
  const lim = Math.max(1, Math.min(Number(limit) || 500, 2000));

  const { rows } = await query(
    `
    select id, tenant_id, owner_id, user_id, kind, due_at, payload, correlation_id
      from public.reminders
     where due_at <= $1::timestamptz
       and sent_at is null
       and cancelled_at is null
       and kind in ('task','custom')
     order by due_at asc
     limit ${lim}
    `,
    [nowIso]
  );

  return (rows || []).map(shapeWorkerRow);
}

async function getDueLunchReminders({ now = new Date(), limit = 500 } = {}) {
  const nowIso = toIso(now) || new Date().toISOString();
  const lim = Math.max(1, Math.min(Number(limit) || 500, 2000));

  const { rows } = await query(
    `
    select id, tenant_id, owner_id, user_id, kind, due_at, payload, correlation_id
      from public.reminders
     where due_at <= $1::timestamptz
       and sent_at is null
       and cancelled_at is null
       and kind = 'lunch'
     order by due_at asc
     limit ${lim}
    `,
    [nowIso]
  );

  return (rows || []).map(shapeWorkerRow);
}

async function markReminderSent(id, { tenantId, ownerId } = {}) {
  if (!isUuid(id)) throw new Error('[reminders] markReminderSent: id must be a uuid');
  const tenant = ensureTenantId(tenantId);
  const owner = ensureOwnerId(ownerId);

  await query(
    `update public.reminders
        set sent_at = now(), updated_at = now()
      where id = $1::uuid
        and tenant_id = $2::uuid
        and owner_id = $3
        and sent_at is null
        and cancelled_at is null`,
    [id, tenant, owner]
  );
  return true;
}

async function cancelReminder(id, { tenantId, ownerId } = {}) {
  if (!isUuid(id)) throw new Error('[reminders] cancelReminder: id must be a uuid');
  const tenant = ensureTenantId(tenantId);
  const owner = ensureOwnerId(ownerId);

  await query(
    `update public.reminders
        set cancelled_at = now(), updated_at = now()
      where id = $1::uuid
        and tenant_id = $2::uuid
        and owner_id = $3
        and sent_at is null
        and cancelled_at is null`,
    [id, tenant, owner]
  );
  return { ok: true };
}

module.exports = {
  createReminder,
  createLunchReminder,
  getDueReminders,
  getDueLunchReminders,
  markReminderSent,
  cancelReminder,
  normalizeUserId: normUserId,
};
