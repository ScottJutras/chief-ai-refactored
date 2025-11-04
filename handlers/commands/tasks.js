// handlers/commands/tasks.js
// ---------------------------------------------------------------
// Tasks: create, list (my/team/inbox), done/assign/delete, due dates.
// All DB calls via services/postgres (RLS-guarded).
// ---------------------------------------------------------------
const pg = require('../../services/postgres');
const { formatInTimeZone } = require('date-fns-tz');
const chrono = require('chrono-node');

const RESP = (text) => `<Response><Message>${text}</Message></Response>`;

async function tasksHandler(from, text, userProfile, ownerId, _ownerProfile, isOwner, res) {
  const lc = String(text || '').toLowerCase().trim();
  const tz = userProfile?.timezone || 'America/Toronto';

  try {
    // -------------------------------------------------
    // 1. CREATE: "task - <title> [due <date>] [assign @name] [job <name>]"
    // -------------------------------------------------
    if (/^task\s*[-:]?\s*/i.test(lc)) {
      const rest = text.replace(/^task\s*[-:]?\s*/i, '').trim();

      // Parse due
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

      const task = await pg.createTaskWithJob({
        ownerId,
        createdBy: from,
        assignedTo,
        title,
        dueAt: dueAt ? new Date(dueAt) : null,
        jobName,
      });

      const due = task.due_at ? formatInTimeZone(task.due_at, tz, 'MMM d') : '';
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
      const lines = rows.map(t => `• #${t.task_no} ${t.title}${t.due_at ? ` (due ${formatInTimeZone(t.due_at, tz, 'MMM d')})` : ''}`);
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
      const msg = 'Team open tasks:\n' + Object.entries(groups).map(([k, v]) => `**${k}**\n${v.join('\n')}`).join('\n\n');
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

    return false; // fall through to agent or next handler
  } catch (e) {
    console.error('[tasks] error:', e?.message);
    res.status(200).type('application/xml').send(RESP('Task error. Try again.'));
    return true;
  }
}

module.exports = { tasksHandler };