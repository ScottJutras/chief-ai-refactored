// handlers/commands/timeclock.js
// -------------------------------------------------------------------
// Timeclock — State Machine Enforced (North Star §4.2)
// - Prevents invalid states: clock out without in, break/drive without shift
// - Pauses shift during break/lunch; drive time runs in parallel
// - Auto-closes break/drive on clock_out
// - Clear confirmations with ✅ and local time
// -------------------------------------------------------------------

const pg = require('../../services/postgres');

// What counts as "in" vs "out" when checking latest event
const IN_TYPES  = new Set(['in','clock_in','punch_in']);
const OUT_TYPES = new Set(['out','clock_out','punch_out','end','finish']);

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

// ---- helpers -------------------------------------------------------

function extractJobHint(text = '') {
  const m = String(text).match(/@\s*([^\n\r]+)/);
  return m ? m[1].trim() : null;
}

// Extract a target employee for ANY of our intents.
// Supports:
//   "clock in justin", "clock out justin",
//   "start break for justin", "break start justin",
//   "drive stop Justin", "end drive for Justin",
//   "force clock in Scott", "undo last for Justin"
function extractTargetName(lc) {
  // strip any trailing "@ Job …" so it doesn't get captured as part of the name
  const noJob = lc.replace(/\s*@\s*[^\n\r]+$/, '');

  const patterns = [
    /\bforce\s+clock\s+(?:in|out)\s+(?:for\s+)?(.+)$/i,
    /\bclock\s+in\s+(?:for\s+)?(.+)$/i,
    /\bclock\s+out\s+(?:for\s+)?(.+)$/i,

    // break start
    /\bbreak\s+(?:start|on)\s+(?:for\s+)?(.+)$/i,
    /\bstart\s+break\s+(?:for\s+)?(.+)$/i,

    // break stop
    /\bbreak\s+(?:stop|off|end)\s+(?:for\s+)?(.+)$/i,
    /\bend\s+break\s+(?:for\s+)?(.+)$/i,

    // drive start
    /\bdrive\s+(?:start|on)\s+(?:for\s+)?(.+)$/i,
    /\bstart\s+drive\s+(?:for\s+)?(.+)$/i,

    // drive stop
    /\bdrive\s+(?:stop|off|end)\s+(?:for\s+)?(.+)$/i,
    /\bend\s+drive\s+(?:for\s+)?(.+)$/i,

    // undo last for <name>
    /^undo(?:\s+last)?\s+(?:for\s+)?(.+)$/i,
  ];

  for (const re of patterns) {
    const m = noJob.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

function formatLocal(ts, tz) {
  try {
    return new Date(ts).toLocaleString('en-CA', { timeZone: tz, hour12: false });
  } catch {
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
  }
}

function twiml(res, body) {
  res.status(200).type('application/xml')
    .send(`<Response><Message>${String(body || '').trim() || 'Timeclock error. Try again.'}</Message></Response>`);
  return true;
}

// --- Get current state (use case-insensitive match on employee name) ---
async function getCurrentState(ownerId, employeeName) {
  const { rows } = await pg.query(
    `SELECT type, timestamp
       FROM public.time_entries
      WHERE owner_id = $1 AND lower(employee_name) = lower($2)
      ORDER BY timestamp ASC
      LIMIT 200`,
    [String(ownerId).replace(/\D/g, ''), employeeName]
  );

  let hasOpenShift = false, openBreak = false, openDrive = false, lastShiftStart = null;
  for (const r of rows) {
    switch (r.type) {
      case 'clock_in':    hasOpenShift = true;  lastShiftStart = r.timestamp; break;
      case 'clock_out':   hasOpenShift = false; openBreak=false; openDrive=false; lastShiftStart=null; break;
      case 'break_start': if (hasOpenShift) openBreak = true; break;
      case 'break_stop':  openBreak = false; break;
      case 'drive_start': if (hasOpenShift) openDrive = true; break;
      case 'drive_stop':  openDrive = false; break;
    }
  }
  return { hasOpenShift, openBreak, openDrive, lastShiftStart };
}

// ---- handler -------------------------------------------------------

async function handleTimeclock(from, text, userProfile, ownerId, ownerProfile, isOwner, res) {
  const lc = String(text || '').toLowerCase().trim();
  const tz = userProfile?.tz || 'America/Toronto';
  const actorId = from;

  try {
    // simple help hook
    if (lc === 'timeclock' || lc === 'help timeclock') {
      return twiml(res, SOP_TIMECLOCK);
    }

    // rate limit (fail-open if limiter has an internal error)
    const limit = await pg.checkTimeEntryLimit(ownerId, actorId, { max: 8, windowSec: 30 });
    if (limit && limit.ok === false) {
      return twiml(res, 'Too many actions — slow down for a few seconds.');
    }

    const jobName = extractJobHint(lc) || null;
    const now = new Date();

    // intents
    const isClockIn     = /\b(clock ?in|start shift)\b/.test(lc);
    const isClockOut    = /\b(clock ?out|end shift)\b/.test(lc);
    const isBreakStart  = /\bbreak (start|on)\b/.test(lc) || /\bstart break\b/.test(lc);
    const isBreakStop   = /\bbreak (stop|off|end)\b/.test(lc) || /\bend break\b/.test(lc);
    const isDriveStart  = /\bdrive (start|on)\b/.test(lc) || /\bstart drive\b/.test(lc);
    const isDriveStop   = /\bdrive (stop|off|end)\b/.test(lc) || /\bend drive\b/.test(lc);
    const isUndo        = /^undo(\s+last)?(\s|$)/.test(lc);

    // derive target (explicit name > caller’s profile > phone)
    const explicitTarget = extractTargetName(lc);
    const callerName     = userProfile?.name || from;
    const target         = explicitTarget || callerName;

    // we need state for the *target* employee
    const state = await getCurrentState(ownerId, target);

    // ---- FORCE CLOCK IN
    const mForceIn = lc.match(/^force\s+clock\s+in\s+(.+)$/i);
    if (mForceIn) {
      const forced = mForceIn[1].trim();
      await pg.logTimeEntryWithJob(ownerId, forced, 'clock_in', now, jobName, tz, { requester_id: actorId });
      return twiml(res, `✅ Forced clock-in recorded for ${forced} at ${formatLocal(now, tz)}.`);
    }

    // ---- FORCE CLOCK OUT
    const mForceOut = lc.match(/^force\s+clock\s+out\s+(.+)$/i);
    if (mForceOut) {
      const forced = mForceOut[1].trim();
      await pg.logTimeEntryWithJob(ownerId, forced, 'clock_out', now, jobName, tz, { requester_id: actorId });
      return twiml(res, `✅ Forced clock-out recorded for ${forced} at ${formatLocal(now, tz)}.`);
    }

    // ---- CLOCK IN
    if (isClockIn) {
      const latest = await pg.getLatestTimeEvent(ownerId, target);
      const latestType = String(latest?.type || '').toLowerCase();
      if (latest && IN_TYPES.has(latestType)) {
        const when = latest?.timestamp ? formatLocal(latest.timestamp, tz) : 'earlier';
        return twiml(res, `${target} is already clocked in since ${when}. Reply "force clock in ${target}" to override.`);
      }
      await pg.logTimeEntryWithJob(ownerId, target, 'clock_in', now, jobName, tz, { requester_id: actorId });
      return twiml(res, `✅ ${target} is clocked in at ${formatLocal(now, tz)}`);
    }

    // ---- CLOCK OUT
    if (isClockOut) {
      const latest = await pg.getLatestTimeEvent(ownerId, target);
      const latestType = String(latest?.type || '').toLowerCase();
      if (latest && OUT_TYPES.has(latestType)) {
        const when = latest?.timestamp ? formatLocal(latest.timestamp, tz) : 'earlier';
        return twiml(res, `${target} is already clocked out since ${when}. (Use "force clock out ${target}" to override.)`);
      }
      await pg.logTimeEntryWithJob(ownerId, target, 'clock_out', now, jobName, tz, { requester_id: actorId });
      return twiml(res, `✅ ${target} is clocked out at ${formatLocal(now, tz)}`);
    }

    // ---- BREAK START
    if (isBreakStart) {
      if (!state.hasOpenShift) return twiml(res, `Can't start a break — no open shift for ${target}.`);
      if (state.openBreak)     return twiml(res, `${target} is already on break.`);
      await pg.logTimeEntryWithJob(ownerId, target, 'break_start', now, jobName, tz, { requester_id: actorId });
      return twiml(res, `⏸️ Break started for ${target} at ${formatLocal(now, tz)}.`);
    }

    // ---- BREAK STOP
    if (isBreakStop) {
      if (!state.hasOpenShift) return twiml(res, `Can't end break — no open shift for ${target}.`);
      if (!state.openBreak)    return twiml(res, `No active break for ${target}.`);
      await pg.logTimeEntryWithJob(ownerId, target, 'break_stop', now, jobName, tz, { requester_id: actorId });
      return twiml(res, `▶️ Break ended for ${target} at ${formatLocal(now, tz)}.`);
    }

    // ---- DRIVE START
    if (isDriveStart) {
      if (!state.hasOpenShift) return twiml(res, `Can't start drive — no open shift for ${target}.`);
      if (state.openDrive)     return twiml(res, `${target} is already driving.`);
      await pg.logTimeEntryWithJob(ownerId, target, 'drive_start', now, jobName, tz, { requester_id: actorId });
      return twiml(res, `🚚 Drive started for ${target} at ${formatLocal(now, tz)}.`);
    }

    // ---- DRIVE STOP
    if (isDriveStop) {
      if (!state.hasOpenShift) return twiml(res, `Can't stop drive — no open shift for ${target}.`);
      if (!state.openDrive)    return twiml(res, `No active drive for ${target}.`);
      await pg.logTimeEntryWithJob(ownerId, target, 'drive_stop', now, jobName, tz, { requester_id: actorId });
      return twiml(res, `🅿️ Drive stopped for ${target} at ${formatLocal(now, tz)}.`);
    }

    // ---- UNDO LAST (target-aware)
    if (isUndo) {
      const who = explicitTarget || callerName;
      const del = await pg.query(
        `DELETE FROM public.time_entries
           WHERE owner_id = $1 AND lower(employee_name) = lower($2)
           ORDER BY timestamp DESC
           LIMIT 1
           RETURNING type, timestamp`,
        [String(ownerId).replace(/\D/g, ''), who]
      );
      if (!del.rowCount) return twiml(res, `Nothing to undo for ${who}.`);
      const type = String(del.rows[0].type || '').replace('_', ' ');
      const at   = formatLocal(del.rows[0].timestamp, tz);
      return twiml(res, `Undid ${type} for ${who} at ${at}.`);
    }

    // not handled here
    return false;
  } catch (e) {
    console.error('[timeclock] error:', e?.message);
    return twiml(res, 'Timeclock error. Try again.');
  }
}

module.exports = { handleTimeclock, SOP_TIMECLOCK };
