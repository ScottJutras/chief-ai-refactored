// handlers/commands/tasks.js
// Supports:
// • "tasks" / "my tasks" / "my tasks done" → list mine
// • "inbox tasks" / "inbox tasks done" (owner/board only)
// • "tasks for Jon" → list someone else’s (owner/board only)
// • "task - <title> [for <name|phone>] [due <time>]" → create (old behavior kept)
// • "task @everyone - <title>" → create one task per teammate + WhatsApp DM
// • "done 12" / "reopen 12"
//
// Keeps: daily creation limits by subscription tier

const chrono = require('chrono-node');
const {
  pool,
  normalizePhoneNumber,
  createTask,
  listMyTasks,
  listInboxTasks,
  listTasksForUser,
  markTaskDone,
  reopenTask,
  getUserBasic,
  getUserByName,
} = require('../../services/postgres');
const { sendMessage } = require('../../services/twilio');

const RESP = (text) => `<Response><Message>${text}</Message></Response>`;
const isOwnerOrBoard = (p) => (p?.role === 'owner' || p?.role === 'board');

// ---------- limits ----------
const TASK_LIMITS = {
  starter: { maxTasksPerDay: 50 },
  pro: { maxTasksPerDay: 200 },
  enterprise: { maxTasksPerDay: 1000 },
};

async function checkTaskLimit(ownerId, userId, tier) {
  const limit =
    TASK_LIMITS[String(tier || 'starter').toLowerCase()]?.maxTasksPerDay ||
    TASK_LIMITS.starter.maxTasksPerDay;

  const createdBy = normalizePhoneNumber(userId);
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS count
       FROM tasks
      WHERE owner_id = $1
        AND created_by = $2
        AND DATE(created_at AT TIME ZONE 'UTC') = CURRENT_DATE`,
    [ownerId, createdBy]
  );
  return parseInt(rows[0]?.count || '0', 10) < limit;
}

// ---------- helpers ----------
function sanitizeInput(text) {
  return String(text || '').replace(/[<>"'&]/g, '').trim().slice(0, 140);
}
function parseStatus(s = '') {
  s = String(s || '').toLowerCase();
  if (/\b(done|closed|complete[d]?)\b/.test(s)) return 'done';
  return 'open';
}
const norm = (s = '') =>
  String(s).normalize('NFKC').replace(/[\u00A0\u2007\u202F]/g, ' ').replace(/\s{2,}/g, ' ').trim();

// Parse task command for title, assignee, due date (old behavior)
function parseTaskCommand(input) {
  let title = input;
  let assignedTo = null;
  let dueAt = null;

  const assigneeMatch = input.match(/\bfor\s+([a-z][\w\s.'-]{1,50}?|\+?\d{10,15})\b/i);
  if (assigneeMatch) {
    assignedTo = assigneeMatch[1].trim();
    title = input.replace(assigneeMatch[0], '').trim();
  }

  const dueMatch = title.match(/\bdue\s+(.+)$/i);
  if (dueMatch) {
    const dueText = dueMatch[1].trim();
    const parsed = chrono.parseDate(dueText);
    if (parsed) dueAt = new Date(parsed).toISOString();
    title = title.replace(dueMatch[0], '').trim();
  }

  return { title: sanitizeInput(title), assignedTo, dueAt };
}

// New: detect @everyone broadcast
function parseEveryone(input) {
  const s = input.trim();
  const m =
    s.match(/^\s*task\s*@everyone\s*[-:]\s*(.+)$/i) ||
    s.match(/^\s*task\s*everyone\s*[-:]\s*(.+)$/i) ||
    s.match(/^\s*broadcast\s*task\s*[-:]\s*(.+)$/i) ||
    s.match(/^\s*send\s*task\s*to\s*everyone\s*[-:]\s*(.+)$/i) ||
    s.match(/^\s*assign\s*everyone\s*[-:]\s*(.+)$/i) ||
    s.match(/^\s*all\s*hands\s*task\s*[-:]\s*(.+)$/i);
  return m ? sanitizeInput(m[1]) : null;
}

// Team roster (uses same DB pool you already export)
async function getTeamMembers(ownerId) {
  const { rows } = await pool.query(
    `
    SELECT user_id, name, phone, role
      FROM users
     WHERE owner_id = $1
       AND phone IS NOT NULL
     ORDER BY (CASE WHEN role = 'owner' THEN 0 ELSE 1 END), name
    `,
    [ownerId]
  );
  return rows || [];
}

module.exports = async function tasksHandler(
  from,
  input,
  userProfile,
  ownerId,
  ownerProfile,
  isOwner,
  res
) {
  try {
    const body = norm(input);
    const tier = userProfile?.subscription_tier || 'starter';

    // --- LIST: "tasks" / "my tasks" / "my tasks done"
    {
      // exact "tasks" or "my tasks" → list mine (open)
      if (/^\s*(tasks|my\s+tasks)\s*$/i.test(body)) {
        const status = 'open';
        const rows = await listMyTasks({ ownerId, userId: from, status });
        if (!rows.length) return res.send(RESP(`✅ You’re all clear — no open tasks assigned to you.`));
        const lines = rows.slice(0, 12).map((r) => {
          const due = r.due_at ? ` (due ${new Date(r.due_at).toLocaleDateString()})` : '';
          return `• #${r.id} ${r.title}${due}`;
        });
        return res.send(RESP(`✅ Here’s what’s on your plate:\n${lines.join('\n')}\nWant to add due dates or reassign?`));
      }

      // "my tasks done"
      let m = body.match(/^my\s+tasks\s+(open|done)$/i);
      if (m) {
        const status = parseStatus(m[1]);
        const rows = await listMyTasks({ ownerId, userId: from, status });
        if (!rows.length) return res.send(RESP(`No ${status} tasks assigned to you.`));
        const lines = rows.slice(0, 12).map((r) => {
          const due = r.due_at ? ` (due ${new Date(r.due_at).toLocaleDateString()})` : '';
          return `• #${r.id} ${r.title}${due}`;
        });
        return res.send(RESP(`${status.toUpperCase()} tasks for you:\n${lines.join('\n')}`));
      }
    }

    // --- INBOX (owner/board): "inbox tasks" / "inbox tasks done"
    if (/^inbox\s+tasks(?:\s+(open|done))?$/i.test(body)) {
      if (!isOwnerOrBoard(userProfile)) {
        return res.send(RESP('⚠️ You don’t have permission for Inbox tasks.'));
      }
      const statusMatch = body.match(/inbox\s+tasks(?:\s+(open|done))?/i);
      const status = parseStatus(statusMatch?.[1] || 'open');
      const rows = await listInboxTasks({ ownerId, status });
      if (!rows.length) return res.send(RESP(`No ${status} tasks in Inbox.`));
      const lines = rows.slice(0, 12).map((r) => {
        const due = r.due_at ? ` (due ${new Date(r.due_at).toLocaleDateString()})` : '';
        return `• #${r.id} ${r.title} (from ${r.creator_name || r.created_by})${due}`;
      });
      return res.send(RESP(`INBOX (${status.toUpperCase()}):\n${lines.join('\n')}`));
    }

    // --- OTHERS’ TASKS (owner/board): "tasks for Jon"
    {
      const m = body.match(/^tasks?\s+for\s+(.+)$/i);
      if (m) {
        if (!isOwnerOrBoard(userProfile)) {
          return res.send(RESP('⚠️ You don’t have permission to view others’ tasks.'));
        }
        const who = m[1].trim();
        const rows = await listTasksForUser({ ownerId, nameOrId: who, status: 'open' });
        if (!rows.length) return res.send(RESP(`No open tasks for "${who}".`));
        const lines = rows.slice(0, 12).map((r) => {
          const due = r.due_at ? ` (due ${new Date(r.due_at).toLocaleDateString()})` : '';
          return `• #${r.id} ${r.title}${due}`;
        });
        return res.send(RESP(`Open tasks for ${who}:\n${lines.join('\n')}`));
      }
    }

    // --- DONE / REOPEN
    {
      let m = body.match(/^(?:done|close)\s+#?(\d+)$/i);
      if (m) {
        const id = parseInt(m[1], 10);
        try {
          const t = await markTaskDone({ ownerId, taskId: id, actorId: from });
          return res.send(RESP(`✅ Task #${id} marked done: ${t.title}`));
        } catch (e) {
          if (e.message.includes('Task not found')) return res.send(RESP(`⚠️ Task #${id} not found.`));
          throw e;
        }
      }
      m = body.match(/^reopen\s+#?(\d+)$/i);
      if (m) {
        const id = parseInt(m[1], 10);
        try {
          const t = await reopenTask({ ownerId, taskId: id, actorId: from });
          return res.send(RESP(`↩️ Task #${id} reopened: ${t.title}`));
        } catch (e) {
          if (e.message.includes('Task not found')) return res.send(RESP(`⚠️ Task #${id} not found.`));
          throw e;
        }
      }
    }

    // --- CREATE LIMIT (applies to "task ..." and "@everyone")
    if (/^task\b/i.test(body)) {
      const canCreate = await checkTaskLimit(ownerId, from, tier);
      if (!canCreate) {
        const lim = TASK_LIMITS[String(tier || 'starter').toLowerCase()].maxTasksPerDay;
        return res.send(
          RESP(`⚠️ Task creation limit reached for ${tier} tier (${lim}/day). Upgrade or try tomorrow.`)
        );
      }
    }

    // --- BROADCAST: "task @everyone - <title>"
    {
      const titleForAll = parseEveryone(body);
      if (titleForAll) {
        const team = await getTeamMembers(ownerId);
        const teammates = team.filter((u) => u.user_id && u.user_id !== from);
        if (!teammates.length) return res.send(RESP(`⚠️ I didn’t find any teammates to assign. Add team members first.`));

        let createdCount = 0;
        for (const tm of teammates) {
          const task = await createTask({
            ownerId,
            createdBy: from,
            assignedTo: tm.user_id, // services/postgres createTask expects a user_id here
            title: titleForAll,
            body: null,
            type: 'general',
            dueAt: null,
          });
          createdCount++;

          // Best-effort DM to each teammate
          try {
            await sendMessage(
              tm.user_id,
              `📝 New team task: ${task.title} (#${task.id})\nAssigned by ${userProfile?.name || 'Owner'}`
            );
          } catch (e) {
            console.warn('[tasks.assign_all] DM failed:', tm.user_id, e?.message);
          }
        }

        return res.send(RESP(`✅ Sent to everyone — “${titleForAll}”. (${createdCount} teammates notified)`));
      }
    }

    // --- CREATE: "task - <title> [for <name|phone>] [due <time>]"
    {
      const m = body.match(/^task(?:\s*[:\-])?\s+(.+)$/i);
      if (m) {
        const { title, assignedTo, dueAt } = parseTaskCommand(m[1]);
        if (!title) return res.send(RESP('⚠️ Task title is required. Try "task - buy tape".'));

        let resolvedAssignee = null;
        let assigneeLabel = null;

        if (assignedTo) {
          if (/^\+?\d{10,15}$/.test(assignedTo)) {
            const user = await getUserBasic(assignedTo);
            resolvedAssignee = user?.user_id || null;
            assigneeLabel = user?.name || assignedTo;
          } else {
            const user = await getUserByName(ownerId, assignedTo);
            resolvedAssignee = user?.user_id || null;
            assigneeLabel = assignedTo;
          }
          if (!resolvedAssignee) {
            return res.send(RESP(`⚠️ User "${assignedTo}" not found. Try their phone number or exact name.`));
          }
        } else {
          // default: assign to sender (old behavior)
          resolvedAssignee = from;
          assigneeLabel = userProfile?.name || from;
        }

        const task = await createTask({
          ownerId,
          createdBy: from,
          assignedTo: resolvedAssignee,
          title,
          body: null,
          type: 'general',
          dueAt,
        });

        let reply = `✅ Task #${task.id} created: ${task.title}`;
        if (resolvedAssignee) {
          reply += `\nAssigned to: ${assigneeLabel}`;
          // Notify assignee (best-effort)
          try {
            await sendMessage(
              resolvedAssignee,
              `New task assigned to you: ${task.title} (#${task.id})${dueAt ? `, due ${new Date(dueAt).toLocaleDateString()}` : ''}`
            );
          } catch (e) {
            console.warn('[tasks] Assignee notification failed:', e.message);
          }
        } else {
          reply += '\n(Unassigned: Owner/Board will see it in Inbox)';
        }
        if (dueAt) reply += `\nDue: ${new Date(dueAt).toLocaleDateString()}`;
        return res.send(RESP(reply));
      }
    }

    // --- Quick help for near-misses
    if (/^task\b/i.test(body) || /\btasks?\b/i.test(body)) {
      return res.send(
        RESP(
          `Try:
- "tasks" or "my tasks" or "my tasks done"
- "task - buy tape" or "task - buy tape for Jon due tomorrow"
- "task @everyone - be on time tomorrow"
- "inbox tasks" (owner/board)
- "tasks for Jon" (owner/board)
- "done 12" or "reopen 12"`
        )
      );
    }

    // Not handled
    return false;
  } catch (e) {
    console.error('[tasks] error:', e.message);
    return res.send(RESP('⚠️ Task error: ' + e.message + '. Please try again.'));
  }
};
