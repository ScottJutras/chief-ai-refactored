// services/reminders.js
// Reminder CRUD – create, fetch due, mark sent.
const { query } = require('./postgres');

async function createReminder({ ownerId, userId, taskNo, taskTitle, remindAt }) {
  const { rows } = await query(
    `INSERT INTO public.reminders
       (owner_id, user_id, task_no, task_title, remind_at)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id`,
    [ownerId, userId, taskNo || null, taskTitle || null, remindAt]
  );
  return rows[0].id;
}
async function getDueReminders({ now = new Date() } = {}) {
  const { rows } = await query(
    `SELECT id, owner_id, user_id, task_no, task_title, remind_at
       FROM public.reminders
      WHERE sent = false
        AND remind_at <= $1
      ORDER BY remind_at ASC
      LIMIT 500`,
    [now.toISOString()]
  );
  return rows;
}
async function markReminderSent(id) {
  await query(
    `UPDATE public.reminders
        SET sent = true,
            sent_at = NOW() AT TIME ZONE 'UTC'
      WHERE id = $1`,
    [id]
  );
}
async function createLunchReminder({ ownerId, userId, shiftId, remindAt }) {
  const { rows } = await query(
    `INSERT INTO public.reminders
       (owner_id, user_id, shift_id, remind_at, kind)
     VALUES ($1,$2,$3,$4,'lunch_reminder')
     RETURNING id`,
    [ownerId, userId, shiftId, remindAt]
  );
  return rows[0].id;
}

async function getDueLunchReminders({ now = new Date() } = {}) {
  const { rows } = await query(
    `SELECT id, owner_id, user_id, shift_id, remind_at
       FROM public.reminders
      WHERE sent = false
        AND canceled = false
        AND kind = 'lunch_reminder'
        AND remind_at <= $1
      ORDER BY remind_at ASC
      LIMIT 500`,
    [now.toISOString()]
  );
  return rows;
}

module.exports = {
  createReminder, getDueReminders, markReminderSent,
  createLunchReminder, getDueLunchReminders
};