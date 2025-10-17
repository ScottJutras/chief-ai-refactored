// services/reminders.js
const { query } = require('./postgres');

// OPTIONAL: run once to create the table (or add via a migration)
// CREATE TABLE IF NOT EXISTS public.reminders (
//   id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
//   owner_id      text NOT NULL,
//   user_id       text NOT NULL,           -- phone (E.164) or internal user id
//   task_no       integer,                  -- optional: our friendly task number
//   task_title    text NOT NULL,
//   remind_at     timestamptz NOT NULL,
//   sent_at       timestamptz,
//   created_at    timestamptz NOT NULL DEFAULT now()
// );
// CREATE INDEX ON public.reminders (remind_at);
// CREATE INDEX ON public.reminders (sent_at);

async function createReminder({ ownerId, userId, taskNo, taskTitle, remindAt }) {
  const { rows } = await query(
    `INSERT INTO reminders (owner_id, user_id, task_no, task_title, remind_at, sent)
     VALUES ($1,$2,$3,$4,$5,false)
     RETURNING id`,
    [ownerId, userId, taskNo || null, taskTitle || null, remindAt]
  );
  return rows[0];
}

async function getDueReminders({ now = new Date() } = {}) {
  const { rows } = await query(
    `SELECT id, owner_id, user_id, task_no, task_title, remind_at
       FROM reminders
      WHERE sent = false
        AND remind_at <= $1
      ORDER BY remind_at ASC
      LIMIT 500`,
    [now.toISOString()]
  );
  return rows;
}

async function markReminderSent(id) {
  await query(`UPDATE reminders SET sent = true, sent_at = NOW() AT TIME ZONE 'UTC' WHERE id = $1`, [id]);
}

module.exports = { createReminder, getDueReminders, markReminderSent };