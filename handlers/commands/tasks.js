// handlers/commands/tasks.js
// ---------------------------------------------------------------
// Tasks: create, list (my/team/inbox), done/assign/delete, due dates.
// Idempotent on Twilio MessageSid when tasks.source_msg_id exists.
// ---------------------------------------------------------------
const pg = require('../../services/postgres');
const { formatInTimeZone } = require('date-fns-tz');
const chrono = require('chrono-node');

const RESP = (text) => `<Response><Message>${text}</Message></Response>`;

// ---- capability cache (serverless-safe) ----
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

function normalizeUserId(x) {
  // your system often uses phone digits as user_id
  return String(x || '').replace(/\D/g, '') || String(x || '').trim() || null;
}

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
  // Resolve jobNo using your existing resolver
  let jobNo = null;
  try {
    const job = await pg.resolveJobContext(ownerId, { explicitJobName: jobName, require: false });
    jobNo = job?.job_no || null;
  } catch {}

  const owner = String(ownerId);
  const createdByNorm = normalizeUserId(createdBy);

  // If source_msg_id column exists, use idempotent INSERT
  const canMsg = await tasksHasSourceMsgIdColumn();
  if (canMsg && sourceMsgId) {
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
      String(title || '').trim() || 'Untitled',
      body ? String(body) : null,
      String(type || 'general'),
      dueAt ? new Date(dueAt) : null,
      jobNo,
      String(sourceMsgId).trim()
    ];

    const res = await pg.query(sql, params);

    // Duplicate message -> no row returned
    if (!res?.rows?.length) return { inserted: false, task: null };

    return { inserted: true, task: res.rows[0] };
  }

  // Fallback (non-idempotent)
  const task = await pg.createTaskWithJob({
    ownerId,
    createdBy,
    assignedTo,
    title,
    body,
    type,
    dueAt: dueAt ? new Date(dueAt) : null,
    jobName
  });
  return { inserted: true, task };
}

/**
 * NOTE: accept sourceMsgId as optional 8th arg (webhook passes MessageSid)
 */
async function tasksHandler(from, text, userProfile, ownerId, _ownerProfile, isOwner, res, sourceMsgId) {
  const lc = String(text || '').toLowerCase().trim();
  const tz = userProfile?.timezone || 'America/Toronto';

  try {
    // -------------------------------------------------
    // 1. CREATE: "task - <title> [due <date>] [assign @name] [job <name>]"
    // -------------------------------------------------
    if (/^task\s*[-:]?\s*/i.test(lc)) {
      const rest = String(text).replace(/^task\s*[-:]?\s*/i, '').trim();

      // Parse due (best-effort)
      const dueMatch = rest.match(/due\s+(.+?)(?:\s+|$)/i);
      const dueAt = dueMatch ? chrono.parseDate(dueMatch[1].trim()) : null;

      // Parse assign
      const assignMatch = rest.match(/assign\s+@?([^\s]+)(?:\s+|$)/i);
      const assigneeName = assignMatch ? assignMatch[1].trim() : null;

      // Parse job
      const jobMatch = rest.match(/job\s+(.+?)(?:\s+|$)/i);
      const jobName = jobMatch ? jobMatch[1].trim() : null;

      // Title (cleaned)
      const title = rest
        .replace(/due\s+.+/i, '')
        .replace(/assign\s+@?[^\s]+/i, '')
        .replace(/job\s+.+/i, '')
        .trim() || 'Untitled';

      let assignedTo = null;
      if (assigneeName) {
        const user = await pg.getUserByName(ownerId, assigneeName);
        assignedTo = user?.user_id || null;
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
        sourceMsgId
      });

      // If duplicate Twilio retry, avoid creating another and just respond nicely
      if (inserted === false) {
        res.status(200).type('application/xml').send(RESP('✅ Already got that task (duplicate message).'));
        return true;
      }

      const due = task?.due_at ? formatInTimeZone(task.due_at, tz, 'MMM d') : '';
      const msg = `Task #${task.task_no} created: **${task.title}**${due ? ` (due ${due})` : ''}`;
      res.status(200).type('application/xml').send(RESP(msg));
      return true;
    }

    // -------------------------------------------------
    // 2. MY TASKS
    // -------------------------------------------------
    if (/^my\s+tasks$/i.test(lc)) {
      const rows = await pg.listMyTasks({ ownerId, userId: from, status: 'open', limit: 10 });
      if (!rows.length) {
        res.status(200).type('application/xml').send(RESP('No open tasks.'));
        return true;
      }
      const lines = rows.map(t =>
        `• #${t.task_no} ${t.title}${t.due_at ? ` (due ${formatInTimeZone(t.due_at, tz, 'MMM d')})` : ''}`
      );
      res.status(200).type('application/xml').send(RESP(`Your open tasks:\n${lines.join('\n')}`));
      return true;
    }

    // -------------------------------------------------
    // 3. TEAM TASKS
    // -------------------------------------------------
    if (/^team\s+tasks$/i.test(lc)) {
      const rows = await pg.listAllOpenTasksByAssignee({ ownerId });
      if (!rows.length) {
        res.status(200).type('application/xml').send(RESP('Team has no open tasks.'));
        return true;
      }
      const groups = {};
      for (const r of rows) (groups[r.assignee_name || 'Inbox'] ||= []).push(`#${r.task_no} ${r.title}`);
      const msg =
        'Team open tasks:\n' +
        Object.entries(groups).map(([k, v]) => `**${k}**\n${v.join('\n')}`).join('\n\n');
      res.status(200).type('application/xml').send(RESP(msg));
      return true;
    }

    // -------------------------------------------------
    // 4. DONE #N
    // -------------------------------------------------
    {
      const m = lc.match(/^done\s*#?(\d+)$/i);
      if (m) {
        const taskNo = parseInt(m[1], 10);
        try {
          const updated = await pg.markTaskDone({ ownerId, taskNo, actorId: from, isOwner });
          if (!updated) throw new Error('not found');
          res.status(200).type('application/xml').send(RESP(`Task #${updated.task_no} marked **done**.`));
          return true;
        } catch (e) {
          console.warn('[tasks] done failed:', e?.message);
          res.status(200).type('application/xml').send(RESP(`Couldn’t mark task #${taskNo} done.`));
          return true;
        }
      }
    }

    // -------------------------------------------------
    // 5. ASSIGN #N TO NAME
    // -------------------------------------------------
    {
      const m = lc.match(/^assign\s*#?(\d+)\s+(?:to|@)\s*(.+)$/i);
      if (m) {
        const taskNo = parseInt(m[1], 10);
        const name = m[2].trim();
        try {
          const assignee = await pg.getUserByName(ownerId, name);
          if (!assignee) throw new Error('user not found');
          const task = await pg.getTaskByNo(ownerId, taskNo);
          if (!task) throw new Error('task not found');
          const can = isOwner || task.created_by === from || task.assigned_to === from;
          if (!can) throw new Error('permission denied');

          await pg.query(
            `UPDATE public.tasks SET assigned_to=$1, updated_at=NOW() WHERE owner_id=$2 AND task_no=$3`,
            [assignee.user_id, ownerId, taskNo]
          );
          res.status(200).type('application/xml').send(RESP(`Task #${taskNo} assigned to **${assignee.name || assignee.user_id}**.`));
          return true;
        } catch (e) {
          console.warn('[tasks] assign failed:', e?.message);
          res.status(200).type('application/xml').send(RESP(`Couldn’t assign task #${taskNo}.`));
          return true;
        }
      }
    }

    // -------------------------------------------------
    // 6. DELETE #N
    // -------------------------------------------------
    {
      const m = lc.match(/^delete\s*#?(\d+)$/i);
      if (m) {
        const taskNo = parseInt(m[1], 10);
        try {
          const task = await pg.getTaskByNo(ownerId, taskNo);
          if (!task) throw new Error('not found');
          const can = isOwner || task.created_by === from;
          if (!can) throw new Error('permission denied');

          await pg.query(
            `UPDATE public.tasks SET status='deleted', updated_at=NOW() WHERE owner_id=$1 AND task_no=$2`,
            [ownerId, taskNo]
          );
          res.status(200).type('application/xml').send(RESP(`Task #${taskNo} deleted.`));
          return true;
        } catch (e) {
          console.warn('[tasks] delete failed:', e?.message);
          res.status(200).type('application/xml').send(RESP(`Couldn’t delete task #${taskNo}.`));
          return true;
        }
      }
    }

    return false; // fall through
  } catch (e) {
    console.error('[tasks] error:', e?.message);
    res.status(200).type('application/xml').send(RESP('Task error. Try again.'));
    return true;
  }
}

module.exports = { tasksHandler };
