// handlers/commands/timeclock.js
// -------------------------------------------------------------------
// Timeclock (MVP, North Star–aligned)
// - Tolerant: never hard-fail user flows
// - Role gate: create a task to notify owner if user not approved
// - Rate limit: uses pg.checkTimeEntryLimit (with alias) to avoid spam
// - Job context: supports "@ Job Name" hint; resolves active job fallback
// - Actions: clock in/out, break start/stop, drive start/stop, undo last
// - Returns strings; router is responsible for TwiML + sending
// -------------------------------------------------------------------

const pg = require('../../services/postgres');

// Compat alias: older code may call pg.checkActorLimit
const checkLimit =
  pg.checkActorLimit ||
  pg.checkTimeEntryLimit ||
  (async () => ({ ok: true, n: 0, limit: Infinity, windowSec: 0 })); // fail-open

// Utility: normalize small SOP text
const SOP_TIMECLOCK =
  'Timeclock — Quick guide:\n' +
  '• Clock in: clock in (uses active job) or clock in @ Roof Job\n' +
  '• Break/Drive: break start/stop; drive start/stop\n' +
  '• Clock out: clock out\n' +
  '• Timesheet: timesheet week';

// Parse an @Job hint at end or anywhere
function extractJobHint(lc) {
  // support '@ Roof Job', '@Roof', 'clock in @ Roof Repair'
  const m = lc.match(/@\s*([^\n\r]+)/);
  if (!m) return null;
  return m[1].trim();
}

// Friendly reply helper
function reply(msg, fallback = 'Timeclock error. Try again.') {
  try {
    const s = String(msg || '').trim();
    return s || fallback;
  } catch {
    return fallback;
  }
}

async function handleTimeclock(from, text, userProfile, ownerId, ownerProfile, isOwner, res) {
  const lc = String(text || '').toLowerCase().trim();

  try {
    // -------------------------------------------------
    // 0) Basic context
    // -------------------------------------------------
    const tz = userProfile?.tz || userProfile?.timezone || 'America/Toronto';
    const employeeName = userProfile?.name || from;
    const actorId = from;
    const plan = (userProfile?.plan || userProfile?.subscription_tier || 'free').toLowerCase();
    const role = (userProfile?.role || 'team').toLowerCase();

    // -------------------------------------------------
    // 1) Role / approval gate (tolerant)
    // If not owner and role is unknown, log a task to notify owner.
    // -------------------------------------------------
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

    // -------------------------------------------------
    // 2) Rate limit (anti-spam, tolerant)
    // Avoids bursts of writes; plan can be used to tune later.
    // -------------------------------------------------
    const limit = await checkLimit(ownerId, actorId, { windowSec: 30, maxInWindow: 8 });
    if (!limit?.ok) {
      return reply('Too many time actions — try again shortly.');
    }

    // -------------------------------------------------
    // 3) Job context
    // We’ll pass jobName into logTimeEntryWithJob (resolves active job internally).
    // -------------------------------------------------
    const jobHint = extractJobHint(lc);
    const jobName = jobHint || null;

    // -------------------------------------------------
    // 4) Intents
    // -------------------------------------------------
    const isClockIn   = /\b(clock ?in|start shift)\b/.test(lc);
    const isClockOut  = /\b(clock ?out|end shift)\b/.test(lc);
    const isBreakOn   = /\bbreak (start|on)\b/.test(lc);
    const isBreakOff  = /\bbreak (stop|off|end)\b/.test(lc);
    const isDriveOn   = /\bdrive (start|on)\b/.test(lc);
    const isDriveOff  = /\bdrive (stop|off|end)\b/.test(lc);
    const isUndoLast  = /^undo\s+last$/.test(lc);
    const isTimesheet = /^timesheet\s+week$/.test(lc);

    // -------------------------------------------------
    // 5) Actions (MVP writes)
    // Use logTimeEntryWithJob where we want job context,
    // otherwise logTimeEntry for generic markers.
    // -------------------------------------------------
    const now = new Date();

    if (isClockIn) {
      await pg.logTimeEntryWithJob(ownerId, employeeName, 'clock_in', now, jobName, tz, { requester_id: actorId });
      return reply('Clocked in.');
    }
    if (isClockOut) {
      await pg.logTimeEntryWithJob(ownerId, employeeName, 'clock_out', now, jobName, tz, { requester_id: actorId });
      return reply('Clocked out.');
    }
    if (isBreakOn) {
      await pg.logTimeEntry(ownerId, employeeName, 'break_start', now, null, tz, { requester_id: actorId });
      return reply('Break started.');
    }
    if (isBreakOff) {
      await pg.logTimeEntry(ownerId, employeeName, 'break_stop', now, null, tz, { requester_id: actorId });
      return reply('Break stopped.');
    }
    if (isDriveOn) {
      await pg.logTimeEntry(ownerId, employeeName, 'drive_start', now, null, tz, { requester_id: actorId });
      return reply('Drive started.');
    }
    if (isDriveOff) {
      await pg.logTimeEntry(ownerId, employeeName, 'drive_stop', now, null, tz, { requester_id: actorId });
      return reply('Drive stopped.');
    }

    // Undo last: delete most recent entry for this owner + employee
    if (isUndoLast) {
      try {
        const del = await pg.query(
          `DELETE FROM public.time_entries
            WHERE owner_id = $1 AND employee_name = $2
            ORDER BY timestamp DESC
            LIMIT 1
            RETURNING type`,
          [String(ownerId).replace(/\D/g, ''), employeeName]
        );
        if (!del.rowCount) return reply('Nothing to undo.');
        const type = (del.rows[0]?.type || '').replace('_', ' ');
        return reply(`Undid last ${type || 'entry'}.`);
      } catch (e) {
        console.warn('[timeclock] undo failed:', e?.message);
        return reply('Nothing to undo.');
      }
    }

    // Timesheet (MVP placeholder)
    if (isTimesheet) {
      // Future: generate link to XLSX/PDF export once UX finalized.
      return reply('Timesheet (week) is coming soon. For now, use: timesheet export in the dashboard.');
    }

    // Fallback SOP
    return reply(SOP_TIMECLOCK);
  } catch (e) {
    console.error('[timeclock] error:', e?.message || e);
    return reply('Timeclock error. Try again.');
  } finally {
    // Best-effort unlock if middleware attached it
    try { typeof res?.req?.releaseLock === 'function' && res.req.releaseLock(); } catch {}
  }
}

module.exports = { handleTimeclock };
