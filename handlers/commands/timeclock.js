// handlers/commands/timeclock.js
// -------------------------------------------------------------------
// Timeclock (MVP, North Star–aligned)
// - Tolerant: never hard-fail user flows
// - Role gate: create a task to notify owner if user not approved
// - Rate limit: uses pg.checkTimeEntryLimit (with alias) to avoid spam
// - Job context: supports "@ Job Name" hint; resolves active job fallback
// - Actions: clock in/out, break start/stop, drive start/stop, undo last
// - Timesheet week: returns a public XLSX link via /api/exports/:id
// - Returns strings; router is responsible for TwiML + sending
// -------------------------------------------------------------------

const pg = require('../../services/postgres');

// Compat alias: older code may call pg.checkActorLimit
const checkLimit =
  pg.checkActorLimit ||
  pg.checkTimeEntryLimit ||
  (async () => ({ ok: true, n: 0, limit: Infinity, windowSec: 0 })); // fail-open

const SOP_TIMECLOCK =
  'Timeclock — Quick guide:\n' +
  'Try: "clock in" or "clock out"\n' +
  '• Break/Drive: break start/stop; drive start/stop\n' +
  '• Clock out: clock out\n' +
  '• Timesheet: timesheet week';

function extractJobHint(lc) {
  const m = lc.match(/@\s*([^\n\r]+)/);
  return m ? m[1].trim() : null;
}
function reply(msg, fallback = 'Timeclock error. Try again.') {
  try { return String(msg || '').trim() || fallback; } catch { return fallback; }
}

async function handleTimeclock(from, text, userProfile, ownerId, ownerProfile, isOwner, res) {
  const lc = String(text || '').toLowerCase().trim();

  try {
    // --- Context ---
    const tz = userProfile?.tz || userProfile?.timezone || 'America/Toronto';
    const employeeName = userProfile?.name || from;
    const actorId = from;
    const plan = (userProfile?.plan || userProfile?.subscription_tier || 'free').toLowerCase();
    const role = (userProfile?.role || 'team').toLowerCase();

    // --- Role/approval gate ---
    if (!isOwner && !['owner', 'board', 'team', 'employee'].includes(role)) {
      try {
        await pg.createTask({
          ownerId,
          createdBy: actorId,
          assignedTo: ownerId,
          title: `Approval needed for ${employeeName}`,
          body: `Approve user ${employeeName} (${from}) to use timeclock.`,
          type: 'admin',
        });
      } catch (e) {
        console.warn('[timeclock] approval task create failed:', e?.message);
      }
      return reply('You’re not approved yet. I’ve notified the owner.');
    }

    // --- Rate limit (anti-spam) ---
    const limit = await checkLimit(ownerId, actorId, { windowSec: 30, maxInWindow: 8 });
    if (!limit?.ok) return reply('Too many time actions — try again shortly.');

    // --- Job context ---
    const jobName = extractJobHint(lc) || null;

    // --- Intents ---
    const isClockIn   = /\b(clock ?in|start shift)\b/.test(lc);
    const isClockOut  = /\b(clock ?out|end shift)\b/.test(lc);
    const isBreakOn   = /\bbreak (start|on)\b/.test(lc);
    const isBreakOff  = /\bbreak (stop|off|end)\b/.test(lc);
    const isDriveOn   = /\bdrive (start|on)\b/.test(lc);
    const isDriveOff  = /\bdrive (stop|off|end)\b/.test(lc);
    const isUndoLast  = /^undo\s+last$/.test(lc);
    const isTimesheet = /^timesheet\s+week$/.test(lc);

    // --- Actions ---
const now = new Date();

if (isClockIn) {
  console.info('[timeclock] write', { ownerId, employeeName, type: 'clock_in', jobName, tz, actorId });
  const id = await pg.logTimeEntryWithJob(ownerId, employeeName, 'clock_in', now, jobName, tz, { requester_id: actorId });
  console.info('[timeclock] ok', { type: 'clock_in', id });
  return reply('Clocked in.');
}

if (isClockOut) {
  console.info('[timeclock] write', { ownerId, employeeName, type: 'clock_out', jobName, tz, actorId });
  const id = await pg.logTimeEntryWithJob(ownerId, employeeName, 'clock_out', now, jobName, tz, { requester_id: actorId });
  console.info('[timeclock] ok', { type: 'clock_out', id });
  return reply('Clocked out.');
}

if (isBreakOn) {
  console.info('[timeclock] write', { ownerId, employeeName, type: 'break_start', jobName: null, tz, actorId });
  const id = await pg.logTimeEntry(ownerId, employeeName, 'break_start', now, null, tz, { requester_id: actorId });
  console.info('[timeclock] ok', { type: 'break_start', id });
  return reply('Break started.');
}

if (isBreakOff) {
  console.info('[timeclock] write', { ownerId, employeeName, type: 'break_stop', jobName: null, tz, actorId });
  const id = await pg.logTimeEntry(ownerId, employeeName, 'break_stop', now, null, tz, { requester_id: actorId });
  console.info('[timeclock] ok', { type: 'break_stop', id });
  return reply('Break stopped.');
}

if (isDriveOn) {
  console.info('[timeclock] write', { ownerId, employeeName, type: 'drive_start', jobName: null, tz, actorId });
  const id = await pg.logTimeEntry(ownerId, employeeName, 'drive_start', now, null, tz, { requester_id: actorId });
  console.info('[timeclock] ok', { type: 'drive_start', id });
  return reply('Drive started.');
}

if (isDriveOff) {
  console.info('[timeclock] write', { ownerId, employeeName, type: 'drive_stop', jobName: null, tz, actorId });
  const id = await pg.logTimeEntry(ownerId, employeeName, 'drive_stop', now, null, tz, { requester_id: actorId });
  console.info('[timeclock] ok', { type: 'drive_stop', id });
  return reply('Drive stopped.');
}

// Undo last
if (isUndoLast) {
  try {
    console.info('[timeclock] undo attempt', { ownerId, employeeName });
    const del = await pg.query(
      `DELETE FROM public.time_entries
         WHERE owner_id = $1 AND employee_name = $2
         ORDER BY timestamp DESC
         LIMIT 1
         RETURNING type`,
      [String(ownerId).replace(/\D/g, ''), employeeName]
    );
    if (!del.rowCount) {
      console.info('[timeclock] undo none', { ownerId, employeeName });
      return reply('Nothing to undo.');
    }
    const type = (del.rows[0]?.type || '').replace('_', ' ');
    console.info('[timeclock] undo ok', { ownerId, employeeName, type });
    return reply(`Undid last ${type || 'entry'}.`);
  } catch (e) {
    console.warn('[timeclock] undo failed:', e?.message);
    return reply('Nothing to undo.');
  }
}

// Timesheet (XLSX export link)
if (isTimesheet) {
  try {
    console.info('[timeclock] timesheet start', { ownerId, employeeName, tz });
    // Compute Mon–Sun window in user tz (simple MVP approach)
    const now = new Date();
    const local = new Date(now.toLocaleString('en-CA', { timeZone: tz }));
    const dow = (local.getDay() + 6) % 7; // Mon=0..Sun=6
    const monday = new Date(local); monday.setDate(local.getDate() - dow); monday.setHours(0,0,0,0);
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6); sunday.setHours(23,59,59,999);

    const startIso = new Date(monday).toISOString();
    const endIso   = new Date(sunday).toISOString();

    const { id, url, filename } = await pg.exportTimesheetXlsx({
      ownerId,
      startIso,
      endIso,
      employeeName,
      tz,
    });

    const base = process.env.PUBLIC_BASE_URL || '';
    const apiUrl = base ? `${base}/api/exports/${id}` : `/api/exports/${id}`;
    console.info('[timeclock] timesheet ok', { id, filename, apiUrl });

    return reply(`Timesheet ready: ${apiUrl}\n(${filename})`);
  } catch (e) {
    console.warn('[timeclock] timesheet export failed:', e?.message);
    return reply('Couldn’t build timesheet right now. Try again later.');
  }
}


    // Fallback SOP
    return reply(SOP_TIMECLOCK);
  } catch (e) {
    console.error('[timeclock] error:', e?.message || e);
    return reply('Timeclock error. Try again.');
  } finally {
    try { typeof res?.req?.releaseLock === 'function' && res.req.releaseLock(); } catch {}
  }
}

module.exports = { handleTimeclock };