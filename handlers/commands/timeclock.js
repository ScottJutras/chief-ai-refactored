// handlers/commands/timeclock.js
// -------------------------------------------------------------------
// Timeclock — State Machine (North Star §4.2)
// Prevents invalid states (e.g., clock out without clock in; break without shift).
// Break/lunch pauses shift; drive runs in parallel (does not pause shift).
// Auto-closes open break/drive on clock_out (with nudge).
// Always sends helpful replies (no generic dead-ends).
// -------------------------------------------------------------------

const pg = require('../../services/postgres');

// --- mini helpers ---------------------------------------------------
const DIGITS = (x) => String(x || '').replace(/\D/g, '');
const fmtLocal = (ts, tz) =>
  new Date(ts).toLocaleString('en-CA', { timeZone: tz || 'America/Toronto', hour12: false });

function reply(text) {
  // Single place to format "friendly" answers.
  return String(text || '').trim();
}

function pickJobHint(text = '') {
  const m = String(text).match(/@\s*([^\n\r]+)/);
  return m ? m[1].trim() : null;
}

// --- current state snapshot ----------------------------------------
/**
 * Reads the last relevant events for this employee to infer open/closed states.
 * We look at more than one record to properly flip flags.
 */
async function getCurrentState(ownerId, employeeName) {
  const { rows } = await pg.query(
    `SELECT type, timestamp
       FROM public.time_entries
      WHERE owner_id = $1 AND employee_name = $2
      ORDER BY timestamp DESC
      LIMIT 50`,
    [DIGITS(ownerId), employeeName]
  );

  let hasOpenShift = false;
  let openBreak = false;
  let openDrive = false;
  let lastShiftStart = null;
  let lastBreakStart = null;
  let lastDriveStart = null;

  for (const r of rows) {
    // Walk newest → oldest and flip flags on first unmatched opener
    if (r.type === 'clock_in' && !hasOpenShift) {
      hasOpenShift = true;
      lastShiftStart = r.timestamp;
    } else if (r.type === 'clock_out' && hasOpenShift) {
      hasOpenShift = false;
      lastShiftStart = null;
    } else if (r.type === 'break_start' && hasOpenShift && !openBreak) {
      openBreak = true;
      lastBreakStart = r.timestamp;
    } else if (r.type === 'break_stop' && openBreak) {
      openBreak = false;
      lastBreakStart = null;
    } else if (r.type === 'drive_start' && hasOpenShift && !openDrive) {
      openDrive = true;
      lastDriveStart = r.timestamp;
    } else if (r.type === 'drive_stop' && openDrive) {
      openDrive = false;
      lastDriveStart = null;
    }
  }

  return { hasOpenShift, openBreak, openDrive, lastShiftStart, lastBreakStart, lastDriveStart };
}

// --- intent detection ----------------------------------------------
function detectIntent(lc) {
  return {
    clockIn:     /\b(clock ?in|start shift|punch ?in)\b/.test(lc),
    clockOut:    /\b(clock ?out|end shift|punch ?out)\b/.test(lc),
    breakStart:  /\b(break|lunch)\s*(start|on|begin)\b/.test(lc) || /\b(start|begin)\s*(break|lunch)\b/.test(lc),
    breakStop:   /\b(break|lunch)\s*(stop|off|end)\b/.test(lc)   || /\b(end|stop)\s*(break|lunch)\b/.test(lc),
    driveStart:  /\bdrive\s*(start|on|begin)\b/.test(lc) || /\b(start|begin)\s*drive\b/.test(lc),
    driveStop:   /\bdrive\s*(stop|off|end)\b/.test(lc)   || /\b(end|stop)\s*drive\b/.test(lc),
    undo:        /^\s*undo\s+last\s*$/i.test(lc),
    help:        /\b(what can i do|help|how to|how do i|what now)\b/i.test(lc),
  };
}

// --- main handler ---------------------------------------------------
async function handleTimeclock(from, text, userProfile, ownerId, ownerProfile, isOwner, res) {
  const lc = String(text || '').toLowerCase().trim();
  const tz = userProfile?.tz || 'America/Toronto';
  const employeeName = userProfile?.name || from;
  const actorId = from;
  const now = new Date();

  try {
    // Rate-limit (North Star: abuse/cost guard)
    const limit = await pg.checkTimeEntryLimit(ownerId, actorId, { max: 8, windowSec: 30 });
    if (!limit.ok) {
      return reply('Too many actions in a short time — please wait a moment and try again.');
    }

    // Quick SOP help
    const intent = detectIntent(lc);
    if (intent.help) {
      return reply([
        'PocketCFO — Timeclock:',
        '• clock in / clock out',
        '• break start / break stop',
        '• drive start / drive stop',
        '• undo last',
        'Tip: add job context with @ Job Name (e.g., "clock in @ Jane Roof").'
      ].join('\n'));
    }

    const jobName = pickJobHint(text);
    const state = await getCurrentState(ownerId, employeeName);

    // ------------- CLOCK IN -------------
    if (intent.clockIn) {
      if (state.hasOpenShift) {
        const since = state.lastShiftStart ? fmtLocal(state.lastShiftStart, tz) : 'earlier';
        return reply(`Already clocked in since ${since}. If needed, you can start a break or drive.`);
      }
      await pg.logTimeEntryWithJob(ownerId, employeeName, 'clock_in', now, jobName, tz, { requester_id: actorId });
      return reply(`✅ ${employeeName} is clocked in at ${fmtLocal(now, tz)}${jobName ? ` @ ${jobName}` : ''}`);
    }

    // ------------- CLOCK OUT -------------
    if (intent.clockOut) {
      if (!state.hasOpenShift) {
        return reply(`Not clocked in — use "clock in" first.`);
      }

      // Auto-close open break/drive BEFORE shift closes
      let autocloseNotes = [];
      if (state.openBreak) {
        await pg.logTimeEntry(ownerId, employeeName, 'break_stop', now, null, tz, { requester_id: actorId });
        autocloseNotes.push('ended break');
      }
      if (state.openDrive) {
        await pg.logTimeEntry(ownerId, employeeName, 'drive_stop', now, null, tz, { requester_id: actorId });
        autocloseNotes.push('ended drive');
      }

      await pg.logTimeEntryWithJob(ownerId, employeeName, 'clock_out', now, jobName, tz, { requester_id: actorId });

      const suffix = autocloseNotes.length ? ` (auto-${autocloseNotes.join(' & ')})` : '';
      return reply(`✅ ${employeeName} is clocked out at ${fmtLocal(now, tz)}${suffix}`);
    }

    // ------------- BREAK START -------------
    if (intent.breakStart) {
      if (!state.hasOpenShift) {
        return reply(`Cannot start break — you are not clocked in.`);
      }
      if (state.openBreak) {
        const since = state.lastBreakStart ? fmtLocal(state.lastBreakStart, tz) : 'already';
        return reply(`Break already started (${since}).`);
      }
      await pg.logTimeEntry(ownerId, employeeName, 'break_start', now, null, tz, { requester_id: actorId });
      return reply(`✅ ${employeeName} started break at ${fmtLocal(now, tz)} (shift is paused).`);
    }

    // ------------- BREAK STOP -------------
    if (intent.breakStop) {
      if (!state.hasOpenShift) {
        return reply(`Cannot end break — you are not clocked in.`);
      }
      if (!state.openBreak) {
        return reply(`No active break to stop.`);
      }
      await pg.logTimeEntry(ownerId, employeeName, 'break_stop', now, null, tz, { requester_id: actorId });
      return reply(`✅ ${employeeName} ended break at ${fmtLocal(now, tz)} (shift resumed).`);
    }

    // ------------- DRIVE START -------------
    if (intent.driveStart) {
      if (!state.hasOpenShift) {
        return reply(`Cannot start drive — you are not clocked in.`);
      }
      if (state.openDrive) {
        const since = state.lastDriveStart ? fmtLocal(state.lastDriveStart, tz) : 'already';
        return reply(`Drive already started (${since}).`);
      }
      await pg.logTimeEntry(ownerId, employeeName, 'drive_start', now, null, tz, { requester_id: actorId });
      return reply(`✅ ${employeeName} started drive at ${fmtLocal(now, tz)} (shift continues; drive is tracked separately).`);
    }

    // ------------- DRIVE STOP -------------
    if (intent.driveStop) {
      if (!state.openDrive) {
        return reply(`No active drive to stop.`);
      }
      await pg.logTimeEntry(ownerId, employeeName, 'drive_stop', now, null, tz, { requester_id: actorId });
      return reply(`✅ ${employeeName} ended drive at ${fmtLocal(now, tz)}.`);
    }

    // ------------- UNDO LAST -------------
    if (intent.undo) {
      const del = await pg.query(
        `DELETE FROM public.time_entries
          WHERE id IN (
            SELECT id FROM public.time_entries
             WHERE owner_id = $1 AND employee_name = $2
             ORDER BY timestamp DESC
             LIMIT 1
          )
          RETURNING type, timestamp`,
        [DIGITS(ownerId), employeeName]
      );
      if (!del.rowCount) return reply('Nothing to undo.');
      const at = fmtLocal(del.rows[0].timestamp, tz);
      return reply(`Undid "${del.rows[0].type.replace('_',' ')}" at ${at}.`);
    }

    // If we reach here, we didn’t match a concrete action — give smart SOPs
    return reply([
      'Timeclock — I can help with:',
      '• clock in / clock out',
      '• break start / break stop',
      '• drive start / drive stop',
      '• undo last',
      'Add @ Job Name for context (e.g., "clock in @ Jane Roof").'
    ].join('\n'));
  } catch (e) {
    // We still avoid dead-ends: we explain what to try instead of a generic error.
    console.error('[timeclock] error:', e?.message);
    return reply([
      'I hit a hiccup saving that time entry.',
      'Try again in a moment, or send "undo last" if you think a duplicate was added.'
    ].join(' '));
  } finally {
    // release lock if your middleware attached one
    try { res?.req?.releaseLock?.(); } catch {}
  }
}

module.exports = { handleTimeclock };
