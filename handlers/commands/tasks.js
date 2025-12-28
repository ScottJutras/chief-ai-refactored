// handlers/commands/tasks.js
// ---------------------------------------------------------------
// Tasks: create, list (my/team/inbox), done/assign/delete, due dates.
// Idempotent on Twilio MessageSid when tasks.source_msg_id exists.
// COMPLETE DROP-IN (aligned w/ expense.js + revenue.js + timeclock.js patterns)
// ---------------------------------------------------------------

const pg = require('../../services/postgres');
const { formatInTimeZone } = require('date-fns-tz');
const chrono = require('chrono-node');

const state = require('../../utils/stateManager');
const getPendingTransactionState =
  state.getPendingTransactionState ||
  (async () => null);
const deletePendingTransactionState =
  state.deletePendingTransactionState ||
  state.deletePendingState ||
  state.clearPendingTransactionState ||
  (async () => null);

const mergePendingTransactionState =
  state.mergePendingTransactionState ||
  (async (userId, patch) => state.setPendingTransactionState(userId, patch, { merge: true }));

/* ---------------- TwiML helpers ---------------- */

function xmlEsc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function twimlText(msg) {
  return `<Response><Message>${xmlEsc(String(msg || '').trim())}</Message></Response>`;
}

/* ---------------- schema capability cache (serverless-safe) ---------------- */

let _tasksHasSourceMsgIdCol = null;

async function hasColumn(table, col) {
  const r = await pg.query(
    `select 1
       from information_schema.columns
      where table_schema='public'
        and table_name = $1
        and column_name = $2
      limit 1`,
    [table, col]
  );
  return (r?.rows?.length || 0) > 0;
}

async function tasksHasSourceMsgIdColumn() {
  if (_tasksHasSourceMsgIdCol !== null) return _tasksHasSourceMsgIdCol;
  try {
    _tasksHasSourceMsgIdCol = await hasColumn('tasks', 'source_msg_id');
  } catch {
    _tasksHasSourceMsgIdCol = false;
  }
  return _tasksHasSourceMsgIdCol;
}

/* ---------------- small utils ---------------- */

function normalizeUserId(x) {
  // Your system often uses phone digits as user_id; keep digits when possible.
  const digits = String(x || '').replace(/\D/g, '');
  return digits || String(x || '').trim() || null;
}

function normalizeTaskText(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function parseTaskNo(s) {
  const m = String(s || '').match(/#?(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function safeTitle(s) {
  const t = normalizeTaskText(s);
  return t || 'Untitled';
}

function formatDue(dueAt, tz) {
  try {
    return dueAt ? formatInTimeZone(dueAt, tz, 'MMM d') : '';
  } catch {
    return '';
  }
}

function getTwilioMessageSidFromRes(res) {
  try {
    const b = res?.req?.body || {};
    return String(b.MessageSid || b.SmsMessageSid || '').trim() || null;
  } catch {
    return null;
  }
}

function stripTaskPrefixes(input) {
  let s = String(input || '').trim();
  s = s.replace(/^tasks?\s*:\s*/i, '');
  s = s.replace(/^task\s*:\s*/i, '');
  return s.trim();
}

/* ---------------- idempotent create ---------------- */

async function createTaskIdempotent({
  ownerId,
  createdBy,
  assignedTo,
  title,
  body,
  type = 'general',
  dueAt,
  jobName,
  sourceMsgId
}) {
  // Resolve jobNo using your existing resolver (best-effort)
  let jobNo = null;
  try {
    if (typeof pg.resolveJobContext === 'function') {
      const job = await pg.resolveJobContext(ownerId, { explicitJobName: jobName, require: false });
      jobNo = job?.job_no || null;
    }
  } catch {}

  const owner = String(ownerId || '').trim();
  const createdByNorm = normalizeUserId(createdBy);

  // If source_msg_id column exists, use idempotent INSERT
  const canMsg = await tasksHasSourceMsgIdColumn();
  const sid = String(sourceMsgId || '').trim() || null;

  if (canMsg && sid) {
    // IMPORTANT: needs a unique constraint/index to truly dedupe.
    // We "fail open": if there's no unique constraint, insert will work normally.
    const sql = `
      insert into public.tasks
        (owner_id, created_by, assigned_to, title, body, type, due_at, job_no, source_msg_id, created_at, updated_at)
      values
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())
      on conflict do nothing
      returning *
    `;
    const params = [
      owner,
      createdByNorm,
      assignedTo ? normalizeUserId(assignedTo) : null,
      safeTitle(title),
      body ? String(body) : null,
      String(type || 'general'),
      dueAt ? new Date(dueAt) : null,
      jobNo,
      sid
    ];

    const res = await pg.query(sql, params);

    // Duplicate message -> no row returned
    if (!res?.rows?.length) return { inserted: false, task: null };

    return { inserted: true, task: res.rows[0] };
  }

  // Fallback (non-idempotent) - prefer postgres.js helper if present
  if (typeof pg.createTaskWithJob === 'function') {
    const task = await pg.createTaskWithJob({
      ownerId,
      createdBy,
      assignedTo,
      title: safeTitle(title),
      body: body ? String(body) : null,
      type,
      dueAt: dueAt ? new Date(dueAt) : null,
      jobName
    });
    return { inserted: true, task };
  }

  // Last-resort raw insert (keeps feature alive even if helper missing)
  const { rows } = await pg.query(
    `insert into public.tasks (owner_id, created_by, assigned_to, title, body, type, due_at, job_no, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, now(), now())
     returning *`,
    [
      owner,
      createdByNorm,
      assignedTo ? normalizeUserId(assignedTo) : null,
      safeTitle(title),
      body ? String(body) : null,
      String(type || 'general'),
      dueAt ? new Date(dueAt) : null,
      jobNo
    ]
  );
  return { inserted: true, task: rows?.[0] || null };
}

/* ---------------- parsing: create syntax ----------------
  Supported:
    - "task <title>"
    - "task - <title>"
    - "task <title> due <when>"
    - "task <title> assign @name"
    - "task <title> job <job name>"
    - combinations in any order
---------------------------------------------------------- */

function parseCreateArgs(rawText, tz) {
  const rest = stripTaskPrefixes(rawText);

  // due: capture "due ..." until next keyword boundary (assign|job) if present
  let dueAt = null;
  const dueMatch = rest.match(/\bdue\s+(.+?)(?=\s+\b(assign|job)\b|$)/i);
  if (dueMatch?.[1]) {
    // chrono in local timezone-ish; acceptable for MVP
    dueAt = chrono.parseDate(dueMatch[1].trim(), new Date(), { forwardDate: true }) || null;
  }

  // assign: single token or @token (name with spaces isn't handled here; we accept the remainder after "assign")
  let assigneeName = null;
  const assignMatch = rest.match(/\bassign\s+@?(.+?)(?=\s+\b(due|job)\b|$)/i);
  if (assignMatch?.[1]) assigneeName = normalizeTaskText(assignMatch[1]);

  // job: remainder after "job" until next keyword boundary
  let jobName = null;
  const jobMatch = rest.match(/\bjob\s+(.+?)(?=\s+\b(due|assign)\b|$)/i);
  if (jobMatch?.[1]) jobName = normalizeTaskText(jobMatch[1]);

  // title = rest with segments removed
  const title = normalizeTaskText(
    rest
      .replace(/\bdue\s+.+?(?=\s+\b(assign|job)\b|$)/i, '')
      .replace(/\bassign\s+@?.+?(?=\s+\b(due|job)\b|$)/i, '')
      .replace(/\bjob\s+.+?(?=\s+\b(due|assign)\b|$)/i, '')
      .trim()
  );

  return { title: title || 'Untitled', dueAt, assigneeName, jobName, tz };
}

/* ---------------- list formatting ---------------- */

function formatTaskLine(t, tz) {
  const due = t?.due_at ? ` (due ${formatDue(t.due_at, tz)})` : '';
  const who =
    t?.assignee_name ? ` — ${t.assignee_name}` :
    t?.assigned_to ? ` — ${t.assigned_to}` :
    '';
  return `• #${t.task_no} ${t.title}${due}${who}`;
}

/* ---------------- main handler ---------------- */

/**
 * Signature expected by router (matches your other command handlers):
 *   tasksHandler(from, text, userProfile, ownerId, ownerProfile, isOwner, res, sourceMsgId)
 *
 * NOTE: sourceMsgId is optional; if not passed, we can try to extract Twilio MessageSid from res.
 */
async function tasksHandler(from, text, userProfile, ownerId, _ownerProfile, isOwner, res, sourceMsgId) {
  const tz = userProfile?.timezone || userProfile?.tz || 'America/Toronto';
  const raw = String(text || '').trim();
  const lc = raw.toLowerCase();

  const lockKey = `lock:${from}`;
  const safeMsgId = String(sourceMsgId || getTwilioMessageSidFromRes(res) || `${from}:${Date.now()}`).trim();

  try {
    let pending = await getPendingTransactionState(from);

    // Clear stale edit-mode for tasks (mirrors expense/revenue behavior)
    if (pending?.isEditing && pending?.type === 'tasks') {
      await deletePendingTransactionState(from);
      pending = null;
    }

    // -------------------------------------------------
    // HELP
    // -------------------------------------------------
    if (/^(tasks|help tasks|task help)$/i.test(lc)) {
      res.status(200).type('application/xml').send(
        twimlText(
          `Tasks — quick guide:
• task <title> (optional: due <when>, assign <name>, job <job>)
• my tasks
• inbox tasks
• team tasks
• done #N
• assign #N to <name>
• delete #N`
        )
      );
      return true;
    }

    // -------------------------------------------------
    // CREATE
    // Examples:
    //   "task fix gutter leak due tomorrow assign Mike job 1556 Medway"
    //   "task - send invoice due Friday"
    // -------------------------------------------------
    if (/^task\b/i.test(lc)) {
      const { title, dueAt, assigneeName, jobName } = parseCreateArgs(raw, tz);

      let assignedTo = null;
      if (assigneeName) {
        try {
          if (typeof pg.getUserByName === 'function') {
            const user = await pg.getUserByName(ownerId, assigneeName);
            assignedTo = user?.user_id || user?.id || null;
          }
        } catch {}
      }

      const { inserted, task } = await createTaskIdempotent({
        ownerId,
        createdBy: from,
        assignedTo,
        title,
        body: null,
        type: 'general',
        dueAt: dueAt ? new Date(dueAt) : null,
        jobName,
        sourceMsgId: safeMsgId
      });

      if (inserted === false) {
        res.status(200).type('application/xml').send(twimlText('✅ Already got that task (duplicate message).'));
        return true;
      }

      const due = task?.due_at ? ` (due ${formatDue(task.due_at, tz)})` : '';
      const who = assignedTo ? ` — assigned` : '';
      res
        .status(200)
        .type('application/xml')
        .send(twimlText(`✅ Task #${task?.task_no || ''} created: ${task?.title || title}${due}${who}`));
      return true;
    }

    // -------------------------------------------------
    // MY TASKS
    // -------------------------------------------------
    if (/^my\s+tasks$/i.test(lc)) {
      const userId = normalizeUserId(from);
      const rows =
        (typeof pg.listMyTasks === 'function'
          ? await pg.listMyTasks({ ownerId, userId, status: 'open', limit: 10 })
          : []);

      if (!rows?.length) {
        res.status(200).type('application/xml').send(twimlText('No open tasks.'));
        return true;
      }

      const lines = rows.map((t) => formatTaskLine(t, tz));
      res.status(200).type('application/xml').send(twimlText(`Your open tasks:\n${lines.join('\n')}`));
      return true;
    }

    // -------------------------------------------------
    // INBOX TASKS (unassigned)
    // -------------------------------------------------
    if (/^(inbox\s+tasks|tasks\s+inbox)$/i.test(lc)) {
      let rows = [];
      try {
        if (typeof pg.listInboxTasks === 'function') {
          rows = await pg.listInboxTasks({ ownerId, status: 'open', limit: 10 });
        } else {
          const r = await pg.query(
            `select task_no, title, due_at, assigned_to
               from public.tasks
              where owner_id=$1
                and status='open'
                and (assigned_to is null or assigned_to = '' )
              order by coalesce(due_at, created_at) asc
              limit 10`,
            [String(ownerId)]
          );
          rows = r?.rows || [];
        }
      } catch {}

      if (!rows?.length) {
        res.status(200).type('application/xml').send(twimlText('Inbox has no open tasks.'));
        return true;
      }

      const lines = rows.map((t) => `• #${t.task_no} ${t.title}${t.due_at ? ` (due ${formatDue(t.due_at, tz)})` : ''}`);
      res.status(200).type('application/xml').send(twimlText(`Inbox open tasks:\n${lines.join('\n')}`));
      return true;
    }

    // -------------------------------------------------
    // TEAM TASKS
    // -------------------------------------------------
    if (/^team\s+tasks$/i.test(lc)) {
      const rows =
        (typeof pg.listAllOpenTasksByAssignee === 'function'
          ? await pg.listAllOpenTasksByAssignee({ ownerId })
          : []);

      if (!rows?.length) {
        res.status(200).type('application/xml').send(twimlText('Team has no open tasks.'));
        return true;
      }

      const groups = {};
      for (const r of rows) {
        const k = r.assignee_name || r.assigned_to || 'Inbox';
        (groups[k] ||= []).push(`#${r.task_no} ${r.title}${r.due_at ? ` (due ${formatDue(r.due_at, tz)})` : ''}`);
      }

      const msg =
        'Team open tasks:\n' +
        Object.entries(groups)
          .map(([k, v]) => `**${k}**\n${v.join('\n')}`)
          .join('\n\n');

      res.status(200).type('application/xml').send(twimlText(msg));
      return true;
    }

    // -------------------------------------------------
    // DONE #N
    // -------------------------------------------------
    {
      const m = lc.match(/^done\s*#?\s*(\d+)$/i);
      if (m) {
        const taskNo = parseInt(m[1], 10);

        try {
          if (typeof pg.markTaskDone === 'function') {
            const updated = await pg.markTaskDone({ ownerId, taskNo, actorId: from, isOwner });
            if (!updated) throw new Error('not found');
            res.status(200).type('application/xml').send(twimlText(`✅ Task #${updated.task_no} marked done.`));
            return true;
          }

          // fallback raw update with light permissions:
          const task = (typeof pg.getTaskByNo === 'function') ? await pg.getTaskByNo(ownerId, taskNo) : null;
          if (!task) throw new Error('not found');
          const can = isOwner || String(task.created_by) === String(from) || String(task.assigned_to) === String(from);
          if (!can) throw new Error('permission denied');

          const r = await pg.query(
            `update public.tasks
                set status='done', done_at=now(), updated_at=now()
              where owner_id=$1 and task_no=$2
              returning task_no`,
            [String(ownerId), taskNo]
          );

          if (!r?.rows?.length) throw new Error('not updated');
          res.status(200).type('application/xml').send(twimlText(`✅ Task #${taskNo} marked done.`));
          return true;
        } catch (e) {
          console.warn('[tasks] done failed:', e?.message);
          res.status(200).type('application/xml').send(twimlText(`⚠️ Couldn’t mark task #${taskNo} done.`));
          return true;
        }
      }
    }

    // -------------------------------------------------
    // ASSIGN #N TO NAME
    // -------------------------------------------------
    {
      const m = lc.match(/^assign\s*#?\s*(\d+)\s+(?:to|@)\s*(.+)$/i);
      if (m) {
        const taskNo = parseInt(m[1], 10);
        const name = normalizeTaskText(m[2]);

        try {
          const assignee =
            (typeof pg.getUserByName === 'function') ? await pg.getUserByName(ownerId, name) : null;
          if (!assignee) throw new Error('user not found');

          const task =
            (typeof pg.getTaskByNo === 'function') ? await pg.getTaskByNo(ownerId, taskNo) : null;
          if (!task) throw new Error('task not found');

          const can = isOwner || String(task.created_by) === String(from) || String(task.assigned_to) === String(from);
          if (!can) throw new Error('permission denied');

          const assigneeId = assignee.user_id || assignee.id || null;
          await pg.query(`UPDATE public.tasks SET assigned_to=$1, updated_at=NOW() WHERE owner_id=$2 AND task_no=$3`, [
            assigneeId,
            String(ownerId),
            taskNo
          ]);

          res
            .status(200)
            .type('application/xml')
            .send(twimlText(`✅ Task #${taskNo} assigned to ${assignee.name || assignee.user_id || assignee.id}.`));
          return true;
        } catch (e) {
          console.warn('[tasks] assign failed:', e?.message);
          res.status(200).type('application/xml').send(twimlText(`⚠️ Couldn’t assign task #${taskNo}.`));
          return true;
        }
      }
    }

    // -------------------------------------------------
    // DELETE #N  (soft delete)
    // -------------------------------------------------
    {
      const m = lc.match(/^delete\s*#?\s*(\d+)$/i);
      if (m) {
        const taskNo = parseInt(m[1], 10);

        try {
          const task = (typeof pg.getTaskByNo === 'function') ? await pg.getTaskByNo(ownerId, taskNo) : null;
          if (!task) throw new Error('not found');

          const can = isOwner || String(task.created_by) === String(from);
          if (!can) throw new Error('permission denied');

          await pg.query(`UPDATE public.tasks SET status='deleted', updated_at=NOW() WHERE owner_id=$1 AND task_no=$2`, [
            String(ownerId),
            taskNo
          ]);

          res.status(200).type('application/xml').send(twimlText(`🗑️ Task #${taskNo} deleted.`));
          return true;
        } catch (e) {
          console.warn('[tasks] delete failed:', e?.message);
          res.status(200).type('application/xml').send(twimlText(`⚠️ Couldn’t delete task #${taskNo}.`));
          return true;
        }
      }
    }

    return false; // fall through
  } catch (e) {
    console.error('[tasks] error:', e?.message);
    res.status(200).type('application/xml').send(twimlText('⚠️ Task error. Try again.'));
    return true;
  } finally {
    // align with other handlers
    try {
      await require('../../middleware/lock').releaseLock(lockKey);
    } catch {}
  }
}

module.exports = { tasksHandler };
