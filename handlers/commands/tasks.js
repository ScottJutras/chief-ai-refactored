// handlers/commands/tasks.js
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
const chrono = require('chrono-node');
const { sendMessage } = require('../../services/twilio');

const RESP = (text) => `<Response><Message>${text}</Message></Response>`;
const isOwnerOrBoard = (p) => (p?.role === 'owner' || p?.role === 'board');

// Subscription tier limits to prevent DB spam
const TASK_LIMITS = {
  starter: { maxTasksPerDay: 50 },
  pro: { maxTasksPerDay: 200 },
  enterprise: { maxTasksPerDay: 1000 },
};

// Sanitize input to prevent injection and ensure reasonable length
function sanitizeInput(text) {
  return String(text || '')
    .replace(/[<>"'&]/g, '') // strip HTML-ish chars
    .trim()
    .slice(0, 140); // cap title length
}

function parseStatus(s = '') {
  s = String(s || '').toLowerCase();
  if (/\b(done|closed|complete[d]?)\b/.test(s)) return 'done';
  return 'open';
}

// Check daily task creation limit
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

// Parse task command for title, assignee, and due date
function parseTaskCommand(input) {
  let title = input;
  let assignedTo = null;
  let dueAt = null;

  // Extract assignee (e.g., "for Jon" or "for +15551234567" or "for 15551234567")
  const assigneeMatch = input.match(
    /\bfor\s+([a-z][\w\s.'-]{1,50}?|\+?\d{10,15})\b/i
  );
  if (assigneeMatch) {
    assignedTo = assigneeMatch[1].trim();
    title = input.replace(assigneeMatch[0], '').trim();
  }

  // Extract due date (e.g., "due tomorrow", "due 2025-10-01", "due next friday")
  const dueMatch = title.match(/\bdue\s+(.+)$/i);
  if (dueMatch) {
    const dueText = dueMatch[1].trim();
    const parsed = chrono.parseDate(dueText);
    if (parsed) {
      dueAt = new Date(parsed).toISOString();
    }
    title = title.replace(dueMatch[0], '').trim();
  }

  return { title: sanitizeInput(title), assignedTo, dueAt };
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
    const body = String(input || '').trim();
    const tier = userProfile?.subscription_tier || 'starter';

    // Only gate *creation* by daily limit (not done/close/reopen)
    if (/^task\b/i.test(body)) {
      const canCreate = await checkTaskLimit(ownerId, from, tier);
      if (!canCreate) {
        return res.send(
          RESP(
            `⚠️ Task limit reached for ${tier} tier (${TASK_LIMITS[tier.toLowerCase()].maxTasksPerDay}/day). Upgrade or try tomorrow.`
          )
        );
      }
    }

    // CREATE: "task - buy tape", "task: order nails for Jon due tomorrow"
    let m = body.match(/^task(?:\s*[:\-])?\s+(.+)$/i);
    if (m) {
      const { title, assignedTo, dueAt } = parseTaskCommand(m[1]);
      if (!title) {
        return res.send(RESP('⚠️ Task title is required. Try "task - buy tape".'));
      }

      let resolvedAssignee = null;
      if (assignedTo) {
        if (/^\+?\d{10,15}$/.test(assignedTo)) {
          const user = await getUserBasic(assignedTo);
          resolvedAssignee = user?.user_id || null;
        } else {
          const user = await getUserByName(ownerId, assignedTo);
          resolvedAssignee = user?.user_id || null;
        }
        if (!resolvedAssignee) {
          return res.send(
            RESP(`⚠️ User "${assignedTo}" not found. Try their phone number or exact name.`)
          );
        }
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
        reply += `\nAssigned to: ${assignedTo}`;
        // Notify assignee (best-effort)
        try {
          await sendMessage(
            resolvedAssignee,
            `New task assigned to you: ${task.title} (#${task.id})${
              dueAt ? `, due ${new Date(dueAt).toLocaleDateString()}` : ''
            }`
          );
        } catch (e) {
          console.warn('[tasks] Assignee notification failed:', e.message);
        }
      } else {
        reply += '\n(Unassigned: Owner/Board will see it in Inbox)';
      }
      if (dueAt) {
        reply += `\nDue: ${new Date(dueAt).toLocaleDateString()}`;
      }
      return res.send(RESP(reply));
    }

    // "my tasks" / "my tasks done"
    m = body.match(/^my\s+tasks(?:\s+(open|done))?$/i);
    if (m) {
      const status = parseStatus(m[1] || 'open');
      const rows = await listMyTasks({ ownerId, userId: from, status });
      if (!rows.length) {
        return res.send(RESP(`No ${status} tasks assigned to you.`));
      }
      const lines = rows.slice(0, 12).map((r) => {
        const due = r.due_at ? ` (due ${new Date(r.due_at).toLocaleDateString()})` : '';
        return `• #${r.id} ${r.title}${due}`;
      });
      return res.send(RESP(`${status.toUpperCase()} tasks for you:\n${lines.join('\n')}`));
    }

    // "inbox tasks" / "inbox tasks done" (owner/board only)
    if (/^inbox\s+tasks(?:\s+(open|done))?$/i.test(body)) {
      if (!isOwnerOrBoard(userProfile)) {
        return res.send(RESP('⚠️ You don’t have permission for Inbox tasks.'));
      }
      const statusMatch = body.match(/inbox\s+tasks(?:\s+(open|done))?/i);
      const status = parseStatus(statusMatch?.[1] || 'open');
      const rows = await listInboxTasks({ ownerId, status });
      if (!rows.length) {
        return res.send(RESP(`No ${status} tasks in Inbox.`));
      }
      const lines = rows.slice(0, 12).map((r) => {
        const due = r.due_at ? ` (due ${new Date(r.due_at).toLocaleDateString()})` : '';
        return `• #${r.id} ${r.title} (from ${r.creator_name || r.created_by})${due}`;
      });
      return res.send(RESP(`INBOX (${status.toUpperCase()}):\n${lines.join('\n')}`));
    }

    // "tasks for Jon" (owner/board only)
    m = body.match(/^tasks?\s+for\s+(.+)$/i);
    if (m) {
      if (!isOwnerOrBoard(userProfile)) {
        return res.send(RESP('⚠️ You don’t have permission to view others’ tasks.'));
      }
      const who = m[1].trim();
      const rows = await listTasksForUser({ ownerId, nameOrId: who, status: 'open' });
      if (!rows.length) {
        return res.send(RESP(`No open tasks for "${who}".`));
      }
      const lines = rows.slice(0, 12).map((r) => {
        const due = r.due_at ? ` (due ${new Date(r.due_at).toLocaleDateString()})` : '';
        return `• #${r.id} ${r.title}${due}`;
      });
      return res.send(RESP(`Open tasks for ${who}:\n${lines.join('\n')}`));
    }

    // "done 12" / "close 12"
    m = body.match(/^(?:done|close)\s+#?(\d+)$/i);
    if (m) {
      const id = parseInt(m[1], 10);
      try {
        const t = await markTaskDone({ ownerId, taskId: id, actorId: from });
        return res.send(RESP(`✅ Task #${id} marked done: ${t.title}`));
      } catch (e) {
        if (e.message.includes('Task not found')) {
          return res.send(RESP(`⚠️ Task #${id} not found.`));
        }
        throw e;
      }
    }

    // "reopen 12"
    m = body.match(/^reopen\s+#?(\d+)$/i);
    if (m) {
      const id = parseInt(m[1], 10);
      try {
        const t = await reopenTask({ ownerId, taskId: id, actorId: from });
        return res.send(RESP(`↩️ Task #${id} reopened: ${t.title}`));
      } catch (e) {
        if (e.message.includes('Task not found')) {
          return res.send(RESP(`⚠️ Task #${id} not found.`));
        }
        throw e;
      }
    }

    // Looks like tasks but didn’t match a command → quick help
    if (/^task\b/i.test(body) || /\btasks?\b/i.test(body)) {
      return res.send(
        RESP(
          `Try:
- "task - buy tape" or "task - buy tape for Jon due tomorrow"
- "my tasks" or "my tasks done"
- "inbox tasks"
- "tasks for Jon"
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
