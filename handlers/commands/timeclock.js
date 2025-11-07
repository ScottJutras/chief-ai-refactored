// handlers/commands/timeclock.js
// -------------------------------------------------------------------
// Timeclock — State Machine Enforced (North Star §4.2)
// - Prevents invalid states: clock out without in, break/drive without shift
// - Pauses shift during break/lunch; drive time runs in parallel
// - Auto-closes break/drive on clock_out
// - Clear confirmations with ✅ and local time
// -------------------------------------------------------------------

const pg = require('../../services/postgres');

// Quick SOP reply when user asks for help
const SOP_TIMECLOCK = `
Timeclock — Quick guide:
• clock in / clock out
• break start / break stop
• drive start / drive stop
• undo last
• timesheet week
Tip: add @ Job Name for context (e.g., “clock in @ Roof Repair”).
`.trim();

function extractJobHint(text = '') {
  const m = String(text).match(/@\s*([^\n\r]+)/);
  return m ? m[1].trim() : null;
}

function formatLocal(ts, tz) {
  try {
    return new Date(ts).toLocaleString('en-CA', { timeZone: tz, hour12: false });
  } catch {
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
  }
}

function reply(msg, fallback = 'Timeclock error. Try again.') {
  return String(msg || '').trim() || fallback;
}

// --- Get current state (robust: oldest -> newest) ---
async function getCurrentState(ownerId, employeeName) {
  const { rows } = await pg.query(
    `SELECT type, timestamp
       FROM public.time_entries
      WHERE owner_id = $1 AND employee_name = $2
      ORDER BY timestamp ASC
      LIMIT 200`,
    [String(ownerId).replace(/\D/g, ''), employeeName]
  );

  let hasOpenShift = false;
  let openBreak = false;
  let openDrive = false;
  let lastShiftStart = null;

  for (const r of rows) {
    switch (r.type) {
      case 'clock_in':
        hasOpenShift = true;
        lastShiftStart = r.timestamp;
        break;

      case 'clock_out':
        // Closing a shift also closes any subordinate segments
        hasOpenShift = false;
        openBreak = false;
        openDrive = false;
        lastShiftStart = null;
        break;

      case 'break_start':
        if (hasOpenShift) openBreak = true;
        break;

      case 'break_stop':
        openBreak = false;
        break;

      case 'drive_start':
        if (hasOpenShift) openDrive = true;
        break;

      case 'drive_stop':
        openDrive = false;
        break;

      default:
        break;
    }
  }

  return { hasOpenShift, openBreak, openDrive, lastShiftStart };
}

async function handleTimeclock(from, text, userProfile, ownerId, ownerProfile, isOwner, res) {
  const lc = String(text || '').toLowerCase().trim();
  const tz = userProfile?.tz || 'America/Toronto';
  const employeeName = userProfile?.name || from; // current user
  const actorId = from;

  try {
    // Rate limit (fail-open message if limiter fails internally)
    const limit = await pg.checkTimeEntryLimit(ownerId, actorId, { max: 8, windowSec: 30 });
    if (limit && limit.ok === false) {
      return reply('Too many actions — slow down for a few seconds.');
    }

    const jobName = extractJobHint(lc) || null;
    const now = new Date();
    const state = await getCurrentState(ownerId, employeeName);

    // Intents
    const isClockIn     = /\b(clock ?in|start shift)\b/.test(lc);
    const isClockOut    = /\b(clock ?out|end shift)\b/.test(lc);
    const isBreakStart  = /\bbreak (start|on)\b/.test(lc) || /\bstart break\b/.test(lc);
    const isBreakStop   = /\bbreak (stop|off|end)\b/.test(lc) || /\bend break\b/.test(lc);
    const isDriveStart  = /\bdrive (start|on)\b/.test(lc) || /\bstart drive\b/.test(lc);
    const isDriveStop   = /\bdrive (stop|off|end)\b/.test(lc) || /\bend drive\b/.test(lc);
    const isUndo        = /^undo\s+last$/.test(lc) || /^undo$/.test(lc);

    // CLOCK IN
    if (isClockIn) {
      if (state.hasOpenShift) {
        const since = state.lastShiftStart ? formatLocal(state.lastShiftStart, tz) : 'earlier';
        return reply(`Already clocked in since ${since}. If needed, you can start a break or drive.`);
      }
      await pg.logTimeEntryWithJob(ownerId, employeeName, 'clock_in', now, jobName, tz, { requester_id: actorId });
      const at = formatLocal(now, tz);
      return reply(`✅ ${employeeName} is clocked in at ${at}`);
    }

    // CLOCK OUT
    if (isClockOut) {
      if (!state.hasOpenShift) {
        return reply(`Not clocked in. Use "clock in" first.`);
      }

      // Auto-close any open segments before clock_out
      const autoClosed = [];
      if (state.openBreak) {
        await pg.logTimeEntry(ownerId, employeeName, 'break_stop', now, null, tz, { requester_id: actorId });
        autoClosed.push('break');
      }
      if (state.openDrive) {
        await pg.logTimeEntry(ownerId, employeeName, 'drive_stop', now, null, tz, { requester_id: actorId });
        autoClosed.push('drive');
      }

      await pg.logTimeEntryWithJob(ownerId, employeeName, 'clock_out', now, jobName, tz, { requester_id: actorId });
      const at = formatLocal(now, tz);
      const tail = autoClosed.length ? ` (auto-ended ${autoClosed.join(' & ')})` : '';
      return reply(`✅ ${employeeName} is clocked out at ${at}${tail}`);
    }

    // BREAK START
    if (isBreakStart) {
      if (!state.hasOpenShift) {
        return reply(`Cannot start break — you’re not clocked in.`);
      }
      if (state.openBreak) {
        return reply(`Break is already in progress.`);
      }
      await pg.logTimeEntry(ownerId, employeeName, 'break_start', now, null, tz, { requester_id: actorId });
      const at = formatLocal(now, tz);
      return reply(`✅ ${employeeName} started break at ${at}`);
    }

    // BREAK STOP
    if (isBreakStop) {
      if (!state.openBreak) {
        return reply(`No active break to stop.`);
      }
      await pg.logTimeEntry(ownerId, employeeName, 'break_stop', now, null, tz, { requester_id: actorId });
      const at = formatLocal(now, tz);
      return reply(`✅ ${employeeName} ended break at ${at}`);
    }

    // DRIVE START (does NOT pause shift)
    if (isDriveStart) {
      if (!state.hasOpenShift) {
        return reply(`Cannot start drive — you’re not clocked in.`);
      }
      if (state.openDrive) {
        return reply(`Drive is already in progress.`);
      }
      await pg.logTimeEntry(ownerId, employeeName, 'drive_start', now, null, tz, { requester_id: actorId });
      const at = formatLocal(now, tz);
      return reply(`✅ ${employeeName} started drive at ${at}`);
    }

    // DRIVE STOP
    if (isDriveStop) {
      if (!state.openDrive) {
        return reply(`No active drive to stop.`);
      }
      await pg.logTimeEntry(ownerId, employeeName, 'drive_stop', now, null, tz, { requester_id: actorId });
      const at = formatLocal(now, tz);
      return reply(`✅ ${employeeName} ended drive at ${at}`);
    }

    // UNDO LAST (simple safety tool)
    if (isUndo) {
      const del = await pg.query(
        `DELETE FROM public.time_entries
           WHERE owner_id = $1 AND employee_name = $2
           ORDER BY timestamp DESC
           LIMIT 1
           RETURNING type, timestamp`,
        [String(ownerId).replace(/\D/g, ''), employeeName]
      );
      if (!del.rowCount) return reply('Nothing to undo.');
      const type = del.rows[0].type.replace('_', ' ');
      const at = formatLocal(del.rows[0].timestamp, tz);
      return reply(`Undid ${type} at ${at}.`);
    }

    // Help / SOP fallback (never a dead end)
    if (/\b(help|how to|how do i|what can i do)\b/i.test(lc)) {
      return reply(SOP_TIMECLOCK);
    }

    // If no intent matched, nudge help
    return reply(SOP_TIMECLOCK);
  } catch (e) {
    console.error('[timeclock] error:', e?.message);
    // Never return a dead-end; offer SOP so user can proceed
    return reply(SOP_TIMECLOCK);
  } finally {
    try { res?.req?.releaseLock?.(); } catch {}
  }
}

module.exports = { handleTimeclock };
