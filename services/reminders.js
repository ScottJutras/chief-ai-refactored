// services/reminders.js
// ------------------------------------------------------------
// Reminders CRUD – create, fetch due, mark sent, cancel.
// Works for task reminders + lunch reminders.
// Schema-aware + idempotent with (owner_id, source_msg_id) unique index.
// ------------------------------------------------------------
//
// ✅ Alignment fix: DO NOT strip digits from ownerId (your system may use UUID/text owner_id now).
// We keep ownerId as String().trim() everywhere.

const pg = require('./postgres');
const query = pg.query || pg.pool?.query || pg.db?.query;

function OWNER(x) {
  const s = String(x ?? '').trim();
  return s || null;
}

function USER(x) {
  const s = String(x ?? '').trim();
  return s || null;
}

function toIsoOrNull(dt) {
  if (!dt) return null;
  const d = dt instanceof Date ? dt : new Date(dt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

let _caps = null;

async function hasColumn(table, col) {
  const r = await query(
    `select 1
       from information_schema.columns
      where table_schema='public'
        and table_name=$1
        and column_name=$2
      limit 1`,
    [table, col]
  );
  return (r?.rows?.length || 0) > 0;
}

async function detectReminderCaps() {
  if (_caps) return _caps;

  const table = 'reminders';
  const caps = {
    hasSourceMsgId: false,
    hasCanceled: false,
    hasCanceledAt: false,
    hasKind: false,
    hasTaskNo: false,
    hasTaskTitle: false,
    hasShiftId: false,
    hasStatus: false,
    hasSent: false,
    hasSentAt: false,
  };

  try {
    caps.hasSourceMsgId = await hasColumn(table, 'source_msg_id');
    caps.hasCanceled = await hasColumn(table, 'canceled');
    caps.hasCanceledAt = await hasColumn(table, 'canceled_at');
    caps.hasKind = await hasColumn(table, 'kind');
    caps.hasTaskNo = await hasColumn(table, 'task_no');
    caps.hasTaskTitle = await hasColumn(table, 'task_title');
    caps.hasShiftId = await hasColumn(table, 'shift_id');
    caps.hasStatus = await hasColumn(table, 'status');
    caps.hasSent = await hasColumn(table, 'sent');
    caps.hasSentAt = await hasColumn(table, 'sent_at');
  } catch {
    // fail-open
  }

  _caps = caps;
  return caps;
}

async function createReminder({
  ownerId,
  userId,
  taskNo = null,
  taskTitle = null,
  remindAt,
  kind = 'task',
  sourceMsgId = null,
}) {
  const caps = await detectReminderCaps();

  const owner = OWNER(ownerId);
  const user = USER(userId);
  const atIso = toIsoOrNull(remindAt);

  if (!owner) throw new Error('Missing ownerId');
  if (!user) throw new Error('Missing userId');
  if (!atIso) throw new Error('Invalid remindAt');

  const cols = ['owner_id', 'user_id', 'remind_at'];
  const vals = [owner, user, atIso];

  if (caps.hasStatus) { cols.push('status'); vals.push('pending'); }
  if (caps.hasSent) { cols.push('sent'); vals.push(false); }
  if (caps.hasKind) { cols.push('kind'); vals.push(String(kind || 'task').trim() || 'task'); }
  if (caps.hasTaskNo) { cols.push('task_no'); vals.push(taskNo != null ? Number(taskNo) : null); }
  if (caps.hasTaskTitle) { cols.push('task_title'); vals.push(taskTitle ? String(taskTitle).trim() : null); }

  const sm = caps.hasSourceMsgId ? (String(sourceMsgId || '').trim() || null) : null;
  if (caps.hasSourceMsgId) { cols.push('source_msg_id'); vals.push(sm); }

  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
  const smProvided = caps.hasSourceMsgId && !!sm;

  const sql = smProvided
    ? `
      insert into public.reminders (${cols.join(', ')})
      values (${placeholders})
      on conflict (owner_id, source_msg_id) where source_msg_id is not null
      do nothing
      returning id
    `
    : `
      insert into public.reminders (${cols.join(', ')})
      values (${placeholders})
      returning id
    `;

  const res = await query(sql, vals);
  if (res?.rowCount) return { inserted: true, id: res.rows[0].id };
  return { inserted: false, id: null };
}

async function getDueReminders({ now = new Date(), limit = 500 } = {}) {
  const caps = await detectReminderCaps();
  const nowIso = toIsoOrNull(now) || new Date().toISOString();
  const lim = Math.max(1, Math.min(Number(limit) || 500, 2000));

  const whereCanceled = caps.hasCanceled ? `and canceled = false` : ``;
  const whereStatus = caps.hasStatus ? `and status = 'pending'` : ``;
  const whereKind = caps.hasKind ? `and (kind is null or kind <> 'lunch_reminder')` : ``;

  const { rows } = await query(
    `
    select
      id,
      owner_id,
      user_id,
      ${caps.hasKind ? 'kind,' : `null as kind,`}
      ${caps.hasTaskNo ? 'task_no,' : 'null as task_no,'}
      ${caps.hasTaskTitle ? 'task_title,' : 'null as task_title,'}
      remind_at
    from public.reminders
    where ${caps.hasSent ? 'sent = false' : 'true'}
      ${whereCanceled}
      ${whereStatus}
      ${whereKind}
      and remind_at <= $1::timestamptz
    order by remind_at asc
    limit ${lim}
    `,
    [nowIso]
  );

  return rows || [];
}

async function markReminderSent(id) {
  const caps = await detectReminderCaps();

  const setStatus = caps.hasStatus ? `, status = 'sent'` : ``;
  const setSentAt = caps.hasSentAt ? `, sent_at = now()` : ``;
  const setSent = caps.hasSent ? `sent = true` : `status = coalesce(status, 'sent')`;

  await query(
    `
    update public.reminders
       set ${setSent}${setStatus}${setSentAt}
     where id = $1
    `,
    [id]
  );

  return true;
}

async function cancelReminder(id) {
  const caps = await detectReminderCaps();

  if (!caps.hasCanceled) {
    await markReminderSent(id);
    return { ok: true, mode: 'mark_sent' };
  }

  const setCanceledAt = caps.hasCanceledAt ? `, canceled_at = now()` : '';
  const setStatus = caps.hasStatus ? `, status = 'canceled'` : '';

  await query(
    `
    update public.reminders
       set canceled = true
           ${setCanceledAt}
           ${setStatus}
     where id = $1
    `,
    [id]
  );

  return { ok: true, mode: 'canceled' };
}

async function createLunchReminder({ ownerId, userId, shiftId, remindAt, sourceMsgId = null }) {
  const caps = await detectReminderCaps();

  const owner = OWNER(ownerId);
  const user = USER(userId);
  const atIso = toIsoOrNull(remindAt);

  if (!owner) throw new Error('Missing ownerId');
  if (!user) throw new Error('Missing userId');
  if (!atIso) throw new Error('Invalid remindAt');

  const cols = ['owner_id', 'user_id', 'remind_at'];
  const vals = [owner, user, atIso];

  if (caps.hasStatus) { cols.push('status'); vals.push('pending'); }
  if (caps.hasSent) { cols.push('sent'); vals.push(false); }
  if (caps.hasKind) { cols.push('kind'); vals.push('lunch_reminder'); }
  if (caps.hasShiftId) { cols.push('shift_id'); vals.push(shiftId != null ? String(shiftId) : null); }

  const sm = caps.hasSourceMsgId ? (String(sourceMsgId || '').trim() || null) : null;
  if (caps.hasSourceMsgId) { cols.push('source_msg_id'); vals.push(sm); }

  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
  const smProvided = caps.hasSourceMsgId && !!sm;

  const sql = smProvided
    ? `
      insert into public.reminders (${cols.join(', ')})
      values (${placeholders})
      on conflict (owner_id, source_msg_id) where source_msg_id is not null
      do nothing
      returning id
    `
    : `
      insert into public.reminders (${cols.join(', ')})
      values (${placeholders})
      returning id
    `;

  const res = await query(sql, vals);
  if (res?.rowCount) return { inserted: true, id: res.rows[0].id };
  return { inserted: false, id: null };
}

async function getDueLunchReminders({ now = new Date(), limit = 500 } = {}) {
  const caps = await detectReminderCaps();
  const nowIso = toIsoOrNull(now) || new Date().toISOString();
  const lim = Math.max(1, Math.min(Number(limit) || 500, 2000));

  const whereCanceled = caps.hasCanceled ? `and canceled = false` : ``;
  const whereStatus = caps.hasStatus ? `and status = 'pending'` : ``;
  const whereKind = caps.hasKind ? `and kind = 'lunch_reminder'` : ``;

  const { rows } = await query(
    `
    select
      id,
      owner_id,
      user_id,
      ${caps.hasShiftId ? 'shift_id,' : 'null as shift_id,'}
      remind_at
    from public.reminders
    where ${caps.hasSent ? 'sent = false' : 'true'}
      ${whereCanceled}
      ${whereStatus}
      ${whereKind}
      and remind_at <= $1::timestamptz
    order by remind_at asc
    limit ${lim}
    `,
    [nowIso]
  );

  return rows || [];
}

module.exports = {
  createReminder,
  getDueReminders,
  markReminderSent,
  cancelReminder,
  createLunchReminder,
  getDueLunchReminders,
};
