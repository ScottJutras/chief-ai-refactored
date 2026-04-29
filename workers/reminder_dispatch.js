// workers/reminder_dispatch.js
// ---------------------------------------------------------
// Polls due reminders every POLL_INTERVAL_MS and sends
// WhatsApp messages via Twilio, then marks them sent.
//
// Task reminders   → "⏰ Reminder: Task #N — {title} is due soon."
// Lunch reminders  → "🥪 Heads up — have you taken a lunch break yet?"
//
// Call startReminderDispatch() once at app boot (non-Vercel only).
//
// Rebuild schema (R4): markReminderSent now requires { tenantId, ownerId }
// per Engineering Constitution §3 (no `WHERE id = $1` alone). The row
// returned by getDueReminders / getDueLunchReminders carries both.
// ---------------------------------------------------------

const POLL_INTERVAL_MS = 60 * 1000; // 1 minute

let sendWhatsApp;
try {
  ({ sendWhatsApp } = require('../services/twilio'));
} catch {
  sendWhatsApp = null;
}

const {
  getDueReminders,
  getDueLunchReminders,
  markReminderSent,
} = require('../services/reminders');

function toWaNumber(userId) {
  // user_id stored as digits (e.g. "15551234567") → "whatsapp:+15551234567"
  const digits = String(userId || '').replace(/\D/g, '');
  if (!digits) return null;
  return `whatsapp:+${digits}`;
}

function rowBoundary(row) {
  return { tenantId: row.tenant_id, ownerId: row.owner_id };
}

async function dispatchTaskReminders() {
  let rows = [];
  try {
    rows = await getDueReminders({ limit: 100 });
  } catch (e) {
    console.warn('[REMINDER_DISPATCH] getDueReminders error:', e?.message);
    return;
  }

  for (const row of rows) {
    const to = toWaNumber(row.user_id);
    if (!to) {
      console.warn('[REMINDER_DISPATCH] Skipping task reminder — no valid user_id:', row.id);
      await markReminderSent(row.id, rowBoundary(row)).catch(() => {});
      continue;
    }

    const title = String(row.task_title || 'your task').trim();
    const taskRef = row.task_no ? `Task #${row.task_no}` : 'A task';
    const body = `⏰ Reminder: ${taskRef} — "${title}" is due soon.`;

    try {
      if (sendWhatsApp) {
        await sendWhatsApp(to, body);
      } else {
        console.log('[REMINDER_DISPATCH] (no Twilio) would send to', to, ':', body);
      }
      await markReminderSent(row.id, rowBoundary(row));
      console.info('[REMINDER_DISPATCH] Task reminder sent:', { id: row.id, to, task_no: row.task_no });
    } catch (e) {
      console.error('[REMINDER_DISPATCH] Failed to send task reminder:', row.id, e?.message);
      // Don't mark sent — will retry next poll
    }
  }
}

async function dispatchLunchReminders() {
  let rows = [];
  try {
    rows = await getDueLunchReminders({ limit: 100 });
  } catch (e) {
    console.warn('[REMINDER_DISPATCH] getDueLunchReminders error:', e?.message);
    return;
  }

  for (const row of rows) {
    const to = toWaNumber(row.user_id);
    if (!to) {
      console.warn('[REMINDER_DISPATCH] Skipping lunch reminder — no valid user_id:', row.id);
      await markReminderSent(row.id, rowBoundary(row)).catch(() => {});
      continue;
    }

    const body = `🥪 Heads up — have you taken a lunch break yet? Reply "lunch start" to log it.`;

    try {
      if (sendWhatsApp) {
        await sendWhatsApp(to, body);
      } else {
        console.log('[REMINDER_DISPATCH] (no Twilio) would send to', to, ':', body);
      }
      await markReminderSent(row.id, rowBoundary(row));
      console.info('[REMINDER_DISPATCH] Lunch reminder sent:', { id: row.id, to });
    } catch (e) {
      console.error('[REMINDER_DISPATCH] Failed to send lunch reminder:', row.id, e?.message);
    }
  }
}

async function poll() {
  await Promise.allSettled([
    dispatchTaskReminders(),
    dispatchLunchReminders(),
  ]);
}

let _started = false;

function startReminderDispatch() {
  if (_started) return;
  _started = true;

  console.info('[REMINDER_DISPATCH] Starting reminder dispatch loop (every', POLL_INTERVAL_MS / 1000, 's)');

  // Run once immediately on boot, then on interval
  poll().catch((e) => console.error('[REMINDER_DISPATCH] Initial poll error:', e?.message));
  setInterval(() => {
    poll().catch((e) => console.error('[REMINDER_DISPATCH] Poll error:', e?.message));
  }, POLL_INTERVAL_MS);
}

module.exports = { startReminderDispatch };
