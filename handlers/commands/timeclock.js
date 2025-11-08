// handlers/commands/timeclock.js
// -------------------------------------------------------------------
// Timeclock — State Machine Enforced (North Star §4.2)
// - Prevents invalid states: clock out without in, break/drive without shift
// - Supports "clock in/out <name> at <time>" and backfill commands
// - Adds confirmation for backfill to avoid accidental edits
// - Pauses shift during break/lunch; drive time runs in parallel
// - Auto-closes break/drive on clock_out
// - Clear confirmations with ✅ and local time
// -------------------------------------------------------------------

const pg = require('../../services/postgres');
const chrono = require('chrono-node');
const { formatInTimeZone, zonedTimeToUtc } = require('date-fns-tz');
const { sendQuickReply } = require('../../services/twilio');

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
Tips:
• Target a person: “clock in Justin”
• With time: “clock in Justin at today 4:00 am”
• Backfill: “backfill clock in for Justin at yesterday 7:45 am”
• Add a job: “@ Kitchen Reno”
`.trim();

// ---- helpers -------------------------------------------------------

function extractJobHint(text = '') {
  const m = String(text).match(/@\s*([^\n\r]+)/);
  return m ? m[1].trim() : null;
}

// Extract a target employee name safely.
// Handles: "clock in justin", "clock out Justin @ Roof", "force clock in Scott",
// and trims any trailing "at <time>" or "@ Job".
function extractTargetName(lc) {
  // remove trailing "@ Job …"
  let s = lc.replace(/\s*@\s*[^\n\r]+$/, '');
  // remove trailing " at <...>" (common for time)
  s = s.replace(/\s+at\s+.+$/i, '');

  let m = s.match(/\bclock\s+in\s+(.+)$/i);
  if (!m) m = s.match(/\bclock\s+out\s+(.+)$/i);
  if (!m) m = s.match(/^force\s+clock\s+(?:in|out)\s+(.+)$/i);
  if (!m) m = s.match(/\b(break|drive)\s+(?:start|stop|on|off|end)\s+(.+)$/i); // "break start Justin"
  return m ? m[1].trim() : null;
}

// Parse a local-time phrase ("today 4:00 am", "yesterday 19:15") to ISO UTC.
function parseLocalWhenToIso(whenText, tz, refDate = new Date()) {
  if (!whenText) return null;
  const parsed = chrono.parseDate(whenText, refDate);
  if (!parsed) return null;
  const ymd  = formatInTimeZone(parsed, tz, 'yyyy-MM-dd');
  const hm   = formatInTimeZone(parsed, tz, 'HH:mm:ss');
  const localStamp = `${ymd} ${hm}`;
  return zonedTimeToUtc(localStamp, tz).toISOString();
}

// Try to pull an explicit "at <time>" from the command.
function extractAtWhen(lc) {
  const m = lc.match(/\s+at\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function formatLocal(ts, tz) {
  try {
    return new Date(ts).toLocaleString('en-CA', { timeZone: tz, hour12: false });
  } catch {
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
  }
}

function twiml(res, body) {
  res
    .status(200)
    .type('application/xml')
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

// Map human verbs to event types
const TYPE_MAP = new Map([
  ['clock in',   'clock_in'],
  ['clock out',  'clock_out'],
  ['break start','break_start'],
  ['break stop', 'break_stop'],
  ['drive start','drive_start'],
  ['drive stop', 'drive_stop'],
]);

// ---- handler -------------------------------------------------------

async function handleTimeclock(from, text, userProfile, ownerId, ownerProfile, isOwner, res) {
  const lc = String(text || '').toLowerCase().trim();
  const tz = userProfile?.tz || 'America/Toronto';
  const actorId = from;
  const now = new Date();

  try {
    // Help hooks
    if (lc === 'timeclock' || lc === 'help timeclock') {
      return twiml(res, SOP_TIMECLOCK);
    }

    // If there is a pending BACKFILL confirmation, resolve it first
    const pending = await pg.getPendingAction({ ownerId, userId: from });
    if (pending && pending.kind === 'backfill_time') {
      const payload = JSON.parse(pending.payload || '{}');
      if (/^(yes|y|confirm)$/i.test(lc)) {
        await pg.logTimeEntryWithJob(
          ownerId,
          payload.target,
          payload.type,
          payload.tsIso,
          payload.jobName || null,
          tz,
          { requester_id: actorId }
        );
        await pg.deletePendingAction(pending.id);
        return twiml(res, `✅ Backfilled **${payload.human}** for ${payload.target} at ${formatLocal(payload.tsIso, tz)}.`);
      }
      if (/^(no|n|cancel)$/i.test(lc)) {
        await pg.deletePendingAction(pending.id);
        return twiml(res, 'Backfill cancelled.');
      }
      // Re-prompt if they replied something else
      await sendQuickReply(
        from,
        `Backfill **${payload.human}** for ${payload.target} at ${formatLocal(payload.tsIso, tz)}?`,
        ['Yes', 'No']
      );
      return true;
    }

    // Rate limit (fail-open if limiter errs)
    const limit = await pg.checkTimeEntryLimit(ownerId, actorId, { max: 8, windowSec: 30 });
    if (limit && limit.ok === false) {
      return twiml(res, 'Too many actions — slow down for a few seconds.');
    }

    const jobName = extractJobHint(lc) || null;

    // Intents
    const isClockIn     = /\b(clock ?in|start shift)\b/.test(lc);
    const isClockOut    = /\b(clock ?out|end shift)\b/.test(lc);
    const isBreakStart  = /\bbreak (start|on)\b/.test(lc) || /\bstart break\b/.test(lc);
    const isBreakStop   = /\bbreak (stop|off|end)\b/.test(lc) || /\bend break\b/.test(lc);
    const isDriveStart  = /\bdrive (start|on)\b/.test(lc) || /\bstart drive\b/.test(lc);
    const isDriveStop   = /\bdrive (stop|off|end)\b/.test(lc) || /\bend drive\b/.test(lc);
    const isUndo        = /^undo(\s+last)?$/.test(lc);

    // Backfill pattern: "backfill clock in for Justin at today 4:00 am"
    const mBack = lc.match(/^backfill\s+(clock\s*in|clock\s*out|break start|break stop|drive start|drive stop)(?:\s+for)?\s+(.+?)\s+(?:at|on)\s+(.+)$/i);
    if (mBack) {
      const human = mBack[1].toLowerCase().replace(/\s+/, ' ');
      const target = mBack[2].trim();
      const whenTxt = mBack[3].trim();
      const type = TYPE_MAP.get(human);
      if (!type) return twiml(res, 'Sorry, I couldn’t understand that backfill action.');

      const tsIso = parseLocalWhenToIso(whenTxt, tz, now);
      if (!tsIso) return twiml(res, `Couldn't parse the time "${whenTxt}". Try “today 4:00 am”.`);

      // Save a pending action and ask for confirmation
      await pg.savePendingAction({
        ownerId,
        userId: from,
        kind: 'backfill_time',
        payload: JSON.stringify({ human, target, type, tsIso, jobName }),
      });

      await sendQuickReply(
        from,
        `Backfill **${human}** for ${target} at ${formatLocal(tsIso, tz)}?`,
        ['Yes', 'No']
      );
      // We sent an outbound message with buttons; don't TwiML a duplicate
      return true;
    }

    // Derive target (explicit name > caller’s profile > phone)
    const explicitTarget = extractTargetName(lc);
    const callerName     = userProfile?.name || from;
    const target         = explicitTarget || callerName;

    // Optional “at <time>” on normal commands (no confirm for non-`backfill`)
    const whenTxt = extractAtWhen(lc);
    const tsOverride = whenTxt ? parseLocalWhenToIso(whenTxt, tz, now) : null;
    const tsToUse = tsOverride || now;

    // we need state for the *target* employee (only for “now” operations)
    const state = await getCurrentState(ownerId, target);

    // ---- FORCE CLOCK IN
    const mForceIn = lc.match(/^force\s+clock\s+in\s+(.+)$/i);
    if (mForceIn) {
      const forced = mForceIn[1].trim();
      await pg.logTimeEntryWithJob(ownerId, forced, 'clock_in', tsToUse, jobName, tz, { requester_id: actorId });
      return twiml(res, `✅ Forced clock-in recorded for ${forced} at ${formatLocal(tsToUse, tz)}.`);
    }

    // ---- FORCE CLOCK OUT
    const mForceOut = lc.match(/^force\s+clock\s+out\s+(.+)$/i);
    if (mForceOut) {
      const forced = mForceOut[1].trim();
      await pg.logTimeEntryWithJob(ownerId, forced, 'clock_out', tsToUse, jobName, tz, { requester_id: actorId });
      return twiml(res, `✅ Forced clock-out recorded for ${forced} at ${formatLocal(tsToUse, tz)}.`);
    }

    // ---- CLOCK IN
    if (isClockIn) {
      // If backdated (tsOverride), we don’t block on “already in” checks
      if (!tsOverride) {
        const latest = await pg.getLatestTimeEvent(ownerId, target);
        const latestType = String(latest?.type || '').toLowerCase();
        if (latest && IN_TYPES.has(latestType)) {
          const when = latest?.timestamp ? formatLocal(latest.timestamp, tz) : 'earlier';
          return twiml(res, `${target} is already clocked in since ${when}. Reply "force clock in ${target}" to override.`);
        }
      }
      await pg.logTimeEntryWithJob(ownerId, target, 'clock_in', tsToUse, jobName, tz, { requester_id: actorId });
      return twiml(res, `✅ ${target} is clocked in at ${formatLocal(tsToUse, tz)}`);
    }

    // ---- CLOCK OUT
    if (isClockOut) {
      if (!tsOverride) {
        const latest = await pg.getLatestTimeEvent(ownerId, target);
        const latestType = String(latest?.type || '').toLowerCase();
        if (latest && OUT_TYPES.has(latestType)) {
          const when = latest?.timestamp ? formatLocal(latest.timestamp, tz) : 'earlier';
          return twiml(res, `${target} is already clocked out since ${when}. (Use "force clock out ${target}" to override.)`);
        }
      }
      await pg.logTimeEntryWithJob(ownerId, target, 'clock_out', tsToUse, jobName, tz, { requester_id: actorId });
      return twiml(res, `✅ ${target} is clocked out at ${formatLocal(tsToUse, tz)}`);
    }

    // ---- BREAK START
    if (isBreakStart) {
      if (!tsOverride && !state.hasOpenShift) return twiml(res, `Can't start a break — no open shift for ${target}.`);
      await pg.logTimeEntryWithJob(ownerId, target, 'break_start', tsToUse, jobName, tz, { requester_id: actorId });
      return twiml(res, `⏸️ Break started for ${target} at ${formatLocal(tsToUse, tz)}.`);
    }

    // ---- BREAK STOP
    if (isBreakStop) {
      if (!tsOverride && !state.hasOpenShift) return twiml(res, `Can't end break — no open shift for ${target}.`);
      await pg.logTimeEntryWithJob(ownerId, target, 'break_stop', tsToUse, jobName, tz, { requester_id: actorId });
      return twiml(res, `▶️ Break ended for ${target} at ${formatLocal(tsToUse, tz)}.`);
    }

    // ---- DRIVE START
    if (isDriveStart) {
      if (!tsOverride && !state.hasOpenShift) return twiml(res, `Can't start drive — no open shift for ${target}.`);
      await pg.logTimeEntryWithJob(ownerId, target, 'drive_start', tsToUse, jobName, tz, { requester_id: actorId });
      return twiml(res, `🚚 Drive started for ${target} at ${formatLocal(tsToUse, tz)}.`);
    }

    // ---- DRIVE STOP
    if (isDriveStop) {
      if (!tsOverride && !state.hasOpenShift) return twiml(res, `Can't stop drive — no open shift for ${target}.`);
      await pg.logTimeEntryWithJob(ownerId, target, 'drive_stop', tsToUse, jobName, tz, { requester_id: actorId });
      return twiml(res, `🅿️ Drive stopped for ${target} at ${formatLocal(tsToUse, tz)}.`);
    }

    // ---- UNDO LAST (simple placeholder; safe)
    if (isUndo) {
      return twiml(res, `Undo isn’t available here yet. Say what to undo and I’ll add it next.`);
    }

    // not handled
    return false;
  } catch (e) {
    console.error('[timeclock] error:', e?.message);
    return twiml(res, 'Timeclock error. Try again.');
  } finally {
    try { res?.req?.releaseLock?.(); } catch {}
  }
}

module.exports = { handleTimeclock, SOP_TIMECLOCK };
