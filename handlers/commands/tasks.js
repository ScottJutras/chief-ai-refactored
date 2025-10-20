// handlers/commands/tasks.js
// Supports:
// • "tasks" / "my tasks" / "my tasks done" → list mine
// • "inbox tasks" / "inbox tasks done" (owner/board only)
// • "tasks for Jon" → list someone else’s (owner/board only)
// • "task - <title> [for|to|@ <name|phone>] [due <time>|tonight|tomorrow|by <time>]" → create
// • "task @everyone - <title>" → create one task per teammate + DM
// • "done 12" / "reopen 12"
// • "assign task #12 to Justin" / "assign last task to Justin" / "assign this to Justin"
// Keeps: daily creation limits by subscription tier

const chrono = require('chrono-node');
const {
  query,
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
const {
  setPendingTransactionState,
  getPendingTransactionState
} = require('../../utils/stateManager');

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
  const { rows } = await query(
    `
    SELECT COUNT(*) AS count
      FROM public.tasks
     WHERE owner_id = $1
       AND created_by = $2
       AND DATE(created_at AT TIME ZONE 'UTC') = CURRENT_DATE
    `,
    [ownerId, createdBy]
  );
  return parseInt(rows[0]?.count || '0', 10) < limit;
}

// ---------- helpers ----------
const fmtDate = (iso) => new Date(iso).toISOString().split('T')[0];

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

function cap(s = '') {
  return String(s)
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// Natural due parsing to catch “tonight/tomorrow/by 5pm”
function parseNaturalDue(source) {
  const txt = String(source || '');
  let dueAt = null;

  // “tonight” → today 9pm
  if (/\btonight\b/i.test(txt)) {
    const d = new Date();
    d.setHours(21, 0, 0, 0);
    dueAt = d.toISOString();
  }

  // “tomorrow” → tomorrow 9am
  if (!dueAt && /\btomorrow\b/i.test(txt)) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    dueAt = d.toISOString();
  }

  // let chrono try anything else (incl. “by 5pm”)
  const chronoDate = chrono.parseDate(txt);
  if (chronoDate) {
    dueAt = new Date(chronoDate).toISOString();
  }

  return dueAt;
}

// Re-add "to Dylan" (or "for Dylan") back into title if assignee isn't a teammate
function reinstateAssigneeInTitle(title, preposition, token) {
  const t = String(title || '').trim();
  const name = String(token || '').trim();
  if (!t || !name) return t || name;

  // if already present, avoid duplication
  const already = new RegExp(`\\b(to|for|@)\\s+${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'i');
  if (already.test(t)) return sanitizeInput(t);

  // prefer "to <name>" for readability, even if user used "@"
  const prep = preposition && preposition.toLowerCase() === 'for' ? 'for' : 'to';
  return sanitizeInput(`${t} ${prep} ${name}`.replace(/\s{2,}/g, ' ').trim());
}

// Parse task command for title, assignee, due date
function parseTaskCommand(input) {
  let title = input;
  let assignedTo = null;
  let dueAt = null;
  let assigneeToken = null;
  let assigneePreposition = null;

  // assignee: "for|to|@ <name|+15551234567>"
  const assigneeMatch = input.match(/\b(for|to|@)\s+([a-z][\w\s.'-]{1,50}|\+?\d{10,15})\b/i);
  if (assigneeMatch) {
    assigneePreposition = assigneeMatch[1];
    assigneeToken = assigneeMatch[2].trim();
    assignedTo = assigneeToken;
    title = input.replace(assigneeMatch[0], '').trim();
  }

  // due date explicit: "due <...>"
  const dueMatch = title.match(/\bdue\s+(.+)$/i);
  if (dueMatch) {
    const dueText = dueMatch[1].trim();
    const parsed = chrono.parseDate(dueText);
    if (parsed) dueAt = new Date(parsed).toISOString();
    title = title.replace(dueMatch[0], '').trim();
  }

  // natural due hints anywhere in the remaining title
  if (!dueAt) {
    const natural = parseNaturalDue(title);
    if (natural) {
      dueAt = natural;
      // strip common words so they don't bloat the title
      title = title
        .replace(/\b(tonight|tomorrow)\b/ig, '')
        .replace(/\bby\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/ig, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }
  }

  return {
    title: sanitizeInput(title),
    assignedTo,
    dueAt,
    assigneeToken,
    assigneePreposition,
  };
}

// Detect @everyone broadcast
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

// Team roster
async function getTeamMembers(ownerId) {
  const { rows } = await query(
    `
    SELECT user_id, name, phone, role
      FROM public.users
     WHERE owner_id = $1
       AND phone IS NOT NULL
     ORDER BY (CASE WHEN role = 'owner' THEN 0 ELSE 1 END), name
    `,
    [ownerId]
  );
  return rows || [];
}

// ---------- DB HELPERS (inline; no external "services/tasks") ----------
async function dbGetTaskByNo(ownerId, taskNo) {
  const sql = `
    SELECT task_no, title, assigned_to
      FROM public.tasks
     WHERE owner_id = $1 AND task_no = $2
     LIMIT 1
  `;
  const { rows } = await query(sql, [ownerId, Number(taskNo)]);
  return rows[0] || null;
}
async function dbUpdateTaskAssignee(ownerId, taskNo, newUserId) {
  const sql = `
    UPDATE public.tasks
       SET assigned_to = $3,
           updated_at = NOW()
     WHERE owner_id = $1 AND task_no = $2
     RETURNING task_no, title, assigned_to
  `;
  const { rows } = await query(sql, [ownerId, Number(taskNo), newUserId]);
  return rows[0] || null;
}

// ---------- ASSIGN PARSERS ----------
function _looksLikeAssign(body = '') {
  return /^\s*assign\b/i.test(String(body || ''));
}
function _parseAssignUtterance(body = '') {
  // "assign task #24 to Justin" | "assign #24 to +1905..."
  // "assign last task to Justin" | "assign this to Justin"
  const t = String(body || '').trim();

  let m = t.match(/^\s*assign\s+(?:task\s*)?#?(\d+)\s+(?:to|for)\s+(.+?)\s*$/i);
  if (m) return { taskNo: parseInt(m[1], 10), assignee: m[2].trim() };

  m = t.match(/^\s*assign\s+(?:last\s+task|last)\s+(?:to|for)\s+(.+?)\s*$/i);
  if (m) return { taskNo: 'last', assignee: m[1].trim() };

  m = t.match(/^\s*assign\s+this\s+(?:to|for)\s+(.+?)\s*$/i);
  if (m) return { taskNo: 'last', assignee: m[1].trim() };

  return null;
}

// ---------- ASSIGN FAST-PATH (MUST RUN BEFORE CREATION PATHS) ----------
async function maybeHandleAssignmentFastPath({ ownerId, from, body, res }) {
  // 1) Sentinel from webhook fast-path (preferred)
  if (res.locals?.intentArgs?.assignTaskNo && res.locals?.intentArgs?.assigneeName) {
    let taskNo = res.locals.intentArgs.assignTaskNo;
    const assigneeName = res.locals.intentArgs.assigneeName;

    if (taskNo === 'last') {
      try {
        const prev = await getPendingTransactionState(from).catch(() => ({}));
        if (prev?.lastTaskNo != null) taskNo = prev.lastTaskNo;
      } catch (_) {}
    }
    if (!taskNo || Number.isNaN(Number(taskNo))) {
      res.send(RESP(`⚠️ I couldn’t tell which task to assign. Try “assign task #12 to Justin”.`));
      return true;
    }

    const task = await dbGetTaskByNo(ownerId, Number(taskNo));
    if (!task) {
      res.send(RESP(`⚠️ I can’t find task #${taskNo}.`));
      return true;
    }

    // Resolve teammate
    let assignee = null;
    if (/^\+?\d{10,15}$/.test(assigneeName)) assignee = await getUserBasic(assigneeName);
    else assignee = await getUserByName(ownerId, assigneeName);

    if (!assignee?.user_id) {
      res.send(RESP(`⚠️ I couldn’t find a teammate named “${assigneeName}”. Add them to your team first.`));
      return true;
    }

    const updated = await dbUpdateTaskAssignee(ownerId, Number(taskNo), assignee.user_id);

    // Best-effort DM
    try {
      await sendMessage(
        assignee.user_id,
        `📝 Task assigned to you: ${cap(updated?.title || task.title)} (#${taskNo})`
      );
    } catch (e) {
      console.warn('[tasks.assign] assignee DM failed:', assignee.user_id, e?.message);
    }

    // Save lastTaskNo for “assign this …”
    try {
      const prev = await getPendingTransactionState(from).catch(() => ({}));
      await setPendingTransactionState(from, { ...prev, lastTaskNo: Number(taskNo) });
      console.log('[tasks.assign] lastTaskNo saved for', from, 'task #', taskNo);
    } catch (e) {
      console.warn('[tasks.assign] lastTaskNo state set failed:', e?.message);
    }

    res.send(RESP(`✅ Assigned task #${taskNo} to ${cap(assignee.name || assigneeName)}.`));
    return true;
  }

  // 2) Text path: “assign …”
  if (_looksLikeAssign(body)) {
    const parsed = _parseAssignUtterance(body);
    if (!parsed) {
      res.send(RESP(`⚠️ I couldn’t parse that. Try “assign task #12 to Justin”.`));
      return true;
    }

    let { taskNo, assignee } = parsed;

    if (taskNo === 'last') {
      try {
        const prev = await getPendingTransactionState(from).catch(() => ({}));
        if (prev?.lastTaskNo != null) taskNo = prev.lastTaskNo;
      } catch (_) {}
    }
    if (!taskNo || Number.isNaN(Number(taskNo))) {
      res.send(RESP(`⚠️ I couldn’t tell which task to assign. Try “assign task #12 to Justin”.`));
      return true;
    }

    const task = await dbGetTaskByNo(ownerId, Number(taskNo));
    if (!task) {
      res.send(RESP(`⚠️ I can’t find task #${taskNo}.`));
      return true;
    }

    let assigneeUser = null;
    if (/^\+?\d{10,15}$/.test(assignee)) assigneeUser = await getUserBasic(assignee);
    else assigneeUser = await getUserByName(ownerId, assignee);

    if (!assigneeUser?.user_id) {
      res.send(RESP(`⚠️ I couldn’t find a teammate named “${assignee}”. Add them to your team first.`));
      return true;
    }

    const updated = await dbUpdateTaskAssignee(ownerId, Number(taskNo), assigneeUser.user_id);

    try {
      await sendMessage(
        assigneeUser.user_id,
        `📝 Task assigned to you: ${cap(updated?.title || task.title)} (#${taskNo})`
      );
    } catch (e) {
      console.warn('[tasks.assign.text] assignee DM failed:', assigneeUser.user_id, e?.message);
    }

    try {
      const prev = await getPendingTransactionState(from).catch(() => ({}));
      await setPendingTransactionState(from, { ...prev, lastTaskNo: Number(taskNo) });
      console.log('[tasks.assign.text] lastTaskNo saved for', from, 'task #', taskNo);
    } catch (e) {
      console.warn('[tasks.assign.text] lastTaskNo state set failed:', e?.message);
    }

    res.send(RESP(`✅ Assigned task #${taskNo} to ${cap(assigneeUser.name || assignee)}.`));
    return true;
  }

  return false;
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

    // OPTIONAL: structured args from router (e.g., conversation.js)
    const routed = res?.locals?.intentArgs || null;

    // --- LIST: "tasks" / "my tasks" / "my tasks done"
    {
      if (/^\s*(tasks|my\s+tasks)\s*$/i.test(body)) {
        const status = 'open';
        const rows = await listMyTasks({ ownerId, userId: from, status });
        if (!rows.length) return res.send(RESP(`✅ You're all clear — no open tasks assigned to you.`));
        const lines = rows.slice(0, 12).map((r) => {
          const due = r.due_at ? ` (due ${fmtDate(r.due_at)})` : '';
          return `• #${r.task_no} ${cap(r.title)}${due}`;
        });
        return res.send(
          RESP(`✅ Here's what's on your plate:\n${lines.join('\n')}\nWant to add due dates or reassign?`)
        );
      }
      const m = body.match(/^my\s+tasks\s+(open|done)$/i);
      if (m) {
        const status = parseStatus(m[1]);
        const rows = await listMyTasks({ ownerId, userId: from, status });
        if (!rows.length) return res.send(RESP(`No ${status} tasks assigned to you.`));
        const lines = rows.slice(0, 12).map((r) => {
          const due = r.due_at ? ` (due ${fmtDate(r.due_at)})` : '';
          return `• #${r.task_no} ${cap(r.title)}${due}`;
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
        const due = r.due_at ? ` (due ${fmtDate(r.due_at)})` : '';
        return `• #${r.task_no} ${cap(r.title)} (from ${r.creator_name || r.created_by})${due}`;
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
          const due = r.due_at ? ` (due ${fmtDate(r.due_at)})` : '';
          return `• #${r.task_no} ${cap(r.title)}${due}`;
        });
        return res.send(RESP(`Open tasks for ${who}:\n${lines.join('\n')}`));
      }
    }

    // --- DONE / REOPEN
    {
      let m = body.match(/^(?:done|close)\s+#?(\d+)$/i);
      if (m) {
        const taskNo = parseInt(m[1], 10);
        try {
          const t = await markTaskDone({ ownerId, taskNo, actorId: from });
          return res.send(RESP(`✅ Task #${taskNo} marked done: ${cap(t.title)}`));
        } catch (e) {
          if (e.message?.includes('Task not found')) return res.send(RESP(`⚠️ Task #${taskNo} not found.`));
          throw e;
        }
      }
      m = body.match(/^reopen\s+#?(\d+)$/i);
      if (m) {
        const taskNo = parseInt(m[1], 10);
        try {
          const t = await reopenTask({ ownerId, taskNo, actorId: from });
          return res.send(RESP(`↩️ Task #${taskNo} reopened: ${cap(t.title)}`));
        } catch (e) {
          if (e.message?.includes('Task not found')) return res.send(RESP(`⚠️ Task #${taskNo} not found.`));
          throw e;
        }
      }
    }

    // --- ASSIGN EXISTING TASK (fast-path & text) — must be BEFORE any create paths
    {
      const consumed = await maybeHandleAssignmentFastPath({ ownerId, from, body, res });
      if (consumed) return;
    }

    // --- CREATE LIMIT (applies to all create paths)
    const isTasky = /^task\b/i.test(body) || !!routed?.title;
    if (isTasky) {
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
        if (!teammates.length)
try {
  const prev = await getPendingTransactionState(from).catch(() => ({}));
  await setPendingTransactionState(from, {
    ...prev,
    helpTopic: {
      key: 'team_add_member',
      context: { name: assigneeName }  // e.g., "Justin"
    }
  });
  // give a *helpful* answer right now too:
  return res.send(RESP(
`I don’t see “${assigneeName}” on your team yet.

Add a teammate by texting:
• "add teammate Justin +19055551234"
• or "invite Justin +19055551234"

Once they’re added, say:
• "assign task #24 to Justin"`
  ));
} catch (e) {
  console.warn('[tasks.assign] helpTopic state set failed:', e?.message);
  return res.send(RESP(
`I don’t see “${assigneeName}” on your team yet.
Add them with "add teammate <Name> <Phone>", then try assigning again.`
  ));
}
      

        let createdCount = 0;
        const taskNos = [];
        for (const tm of teammates) {
          const task = await createTask({
            ownerId,
            createdBy: from,
            assignedTo: tm.user_id,
            title: titleForAll,
            body: null,
            type: 'general',
            dueAt: null,
          });
          createdCount++;
          taskNos.push(task.task_no);
          // DM teammate (best-effort)
          try {
            await sendMessage(
              tm.user_id,
              `📝 New team task: ${cap(task.title)} (#${task.task_no})\nAssigned by ${userProfile?.name || 'Owner'}`
            );
          } catch (e) {
            console.warn('[tasks.assign_all] DM failed:', tm.user_id, e?.message);
          }
        }

        // Save lastTaskNo for quick follow-ups (“assign last …”)
        try {
          const last = taskNos[taskNos.length - 1];
          if (last != null) {
            const prev = await getPendingTransactionState(from).catch(() => ({}));
            await setPendingTransactionState(from, { ...prev, lastTaskNo: last });
            console.log('[tasks.assign_all] lastTaskNo saved for', from, 'task #', last);
          }
        } catch (e) {
          console.warn('[tasks.assign_all] lastTaskNo state set failed:', e?.message);
        }

        return res.send(
          RESP(
            `✅ Sent task #${taskNos.join(', #')} to everyone — “${cap(titleForAll)}”. (${createdCount} teammates notified)`
          )
        );
      }
    }

    // --- Preferred path when conversation.js routed intent with args:
    if (routed?.title) {
      let title = sanitizeInput(routed.title);
      let resolvedAssignee = from;
      let assigneeLabel = userProfile?.name || from;

      if (routed.assigneeName) {
        // Try to resolve teammate; if not found, keep "to <name>" in title and assign to sender
        let found = null;
        if (/^\+?\d{10,15}$/.test(routed.assigneeName)) {
          const user = await getUserBasic(routed.assigneeName);
          if (user?.user_id) found = user;
        } else {
          const user = await getUserByName(ownerId, routed.assigneeName);
          if (user?.user_id) found = user;
        }

        if (found) {
          resolvedAssignee = found.user_id;
          assigneeLabel = found?.name || routed.assigneeName;
        } else {
          title = reinstateAssigneeInTitle(title, 'to', routed.assigneeName);
        }
      }

      const task = await createTask({
        ownerId,
        createdBy: from,
        assignedTo: resolvedAssignee,
        title,
        body: null,
        type: 'general',
        dueAt: routed.dueAt || null,
      });

      let reply = `✅ Task #${task.task_no} created: ${cap(task.title)}`;
      if (resolvedAssignee !== from) {
        reply += `\nAssigned to: ${cap(assigneeLabel)}`;
        try {
          await sendMessage(
            resolvedAssignee,
            `📝 New task assigned to you: ${cap(task.title)} (#${task.task_no})${
              routed.dueAt ? `, due ${fmtDate(routed.dueAt)}` : ''
            }`
          );
        } catch (e) {
          console.warn('[tasks] Assignee notification failed:', e.message);
        }
      }
      if (routed.dueAt) reply += `\nDue: ${fmtDate(routed.dueAt)}`;

      // Save lastTaskNo + reminder prompt
      try {
        const prev = await getPendingTransactionState(from).catch(() => ({}));
        await setPendingTransactionState(from, {
          ...prev,
          lastTaskNo: task.task_no,
          pendingReminder: {
            ownerId,
            userId: from,
            taskNo: task.task_no,
            taskTitle: task.title
          }
        });
        console.log('[tasks] pendingReminder set & lastTaskNo saved for', from, 'task #', task.task_no);
        reply += `\nDo you want me to send you a reminder?`;
      } catch (e) {
        console.warn('[tasks] pendingReminder/lastTaskNo state set failed:', e?.message);
      }

      return res.send(RESP(reply));
    }

    // --- Text command path: "task - ..." or "task ..."
    {
      const m = body.match(/^task(?:\s*[:\-])?\s+(.+)$/i);
      if (m) {
        const { title: rawTitle, assignedTo, dueAt, assigneeToken, assigneePreposition } = parseTaskCommand(m[1]);
        if (!rawTitle) return res.send(RESP('⚠️ Task title is required. Try "task - buy tape".'));

        let title = rawTitle;
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
            // Not a teammate → keep the mention in the title and assign to sender
            title = reinstateAssigneeInTitle(title, assigneePreposition || 'to', assigneeToken || assignedTo);
            resolvedAssignee = from;
            assigneeLabel = userProfile?.name || from;
          }
        } else {
          // default: assign to sender
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

        if (!task || task.task_no == null) {
          console.error('[tasks] createTask failed: missing task_no');
          return res.send(RESP('⚠️ Failed to create task. Please try again.'));
        }

        // Single confirmation; DM only if assigning to someone else
        let reply = `✅ Task #${task.task_no} created: ${cap(task.title)}`;
        if (resolvedAssignee !== from) {
          reply += `\nAssigned to: ${cap(assigneeLabel)}`;
          try {
            await sendMessage(
              resolvedAssignee,
              `📝 New task assigned to you: ${cap(task.title)} (#${task.task_no})${
                dueAt ? `, due ${fmtDate(dueAt)}` : ''
              }`
            );
          } catch (e) {
            console.warn('[tasks] Assignee notification failed:', e.message);
          }
        }
        if (dueAt) reply += `\nDue: ${fmtDate(dueAt)}`;

        // Save lastTaskNo + reminder prompt
        try {
          const prev = await getPendingTransactionState(from).catch(() => ({}));
          await setPendingTransactionState(from, {
            ...prev,
            lastTaskNo: task.task_no,
            pendingReminder: {
              ownerId,
              userId: from,
              taskNo: task.task_no,
              taskTitle: task.title
            }
          });
          console.log('[tasks] pendingReminder set & lastTaskNo saved for', from, 'task #', task.task_no);
          reply += `\nDo you want me to send you a reminder?`;
        } catch (e) {
          console.warn('[tasks] pendingReminder/lastTaskNo state set failed:', e?.message);
        }

        return res.send(RESP(reply));
      }
    }

    // --- Quick help for near-misses
    if (/^task\b/i.test(body) || /\btasks?\b/i.test(body)) {
      return res.send(
        RESP(
`Try:
- "tasks" or "my tasks" or "my tasks done"
- "task - buy tape" or "task buy tape for Jon due tomorrow"
- "task email quote to Dylan tonight"
- "task @everyone - be on time tomorrow"
- "assign task #12 to Justin" or "assign last task to Justin"
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
