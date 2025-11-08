// handlers/commands/timeclock.js
// -------------------------------------------------------------------
// Timeclock — State Machine Enforced (North Star §4.2)
// - Prevents invalid states: clock out without in, break/drive without shift
// - Supports natural language like "Justin forgot to clock in today at 4:00 am"
// - Backfill flow with Yes/No confirmation
// - Job hints via "@ Job Name", optional "at <time>" on commands
// - Clear confirmations with ✅ and local time
// -------------------------------------------------------------------

const pg = require('../../services/postgres');
const chrono = require('chrono-node');
const { formatInTimeZone, zonedTimeToUtc } = require('date-fns-tz');
const { sendQuickReply } = require('../../services/twilio');

const IN_TYPES  = new Set(['in','clock_in','punch_in']);
const OUT_TYPES = new Set(['out','clock_out','punch_out','end','finish']);
const TIME_WORDS = new Set(['today','yesterday','tomorrow','now','tonight','this morning','this afternoon','this evening']);

// Quick SOP reply
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

// ---------------------- helpers ----------------------

function extractJobHint(text = '') {
  const m = String(text).match(/@\s*([^\n\r]+)/);
  return m ? m[1].trim() : null;
}

// Prefer explicit "... for <name> ..." (works across many phrasings)
function extractForName(lc) {
  const m = lc.match(/\bfor\s+(.+?)(?=\s+(?:at|on)\b|[.?!]|$)/i);
  return m ? m[1].trim() : null;
}

// Natural language narrative: "<name> forgot/didn't/needs to clock in/out ..."
function extractNarrative(text) {
  // Use the original (not fully lowercased) so multi-word names stay readable; match case-insensitively
  const m = String(text).match(
    /^([\p{L}\p{M}.'-]+(?:\s+[\p{L}\p{M}.'-]+){0,2})\s+(?:forgot|did\s*not|didn't|needs|need)\s+to\s+clock\s+(in|out)\b/i
  );
  if (!m) return null;
  return { name: m[1].trim(), action: m[2].toLowerCase() }; // action: 'in'|'out'
}

// Strict command-style name extraction (only when the command STARTS with the verb)
function extractCommandTarget(lc) {
  // strip trailing "@ Job ..." then trailing " at <time> ..."
  let s = lc.replace(/\s*@\s*[^\n\r]+$/, '').replace(/\s+at\s+.+$/i, '');

  let m = s.match(/^\s*clock\s+in\s+(.+)$/i);
  if (!m) m = s.match(/^\s*clock\s+out\s+(.+)$/i);
  if (!m) m = s.match(/^\s*force\s+clock\s+(?:in|out)\s+(.+)$/i);
  if (!m) m = s.match(/^\s*(?:break|drive)\s+(?:start|stop|on|off|end)\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// Parse an "at <when>" phrase anywhere in the text (grabs the last one)
function extractAtWhen(text) {
  const m = String(text).match(/\b(?:at|@)\s+([^\.,;!?]+)\s*$/i) || String(text).match(/\b(?:at|@)\s+([^\.,;!?]+)/i);
  return m ? m[1].trim() : null;
}

// Parse local time phrase to UTC ISO
function parseLocalWhenToIso(whenText, tz, refDate = new Date()) {
  if (!whenText) return null;
  const parsed = chrono.parseDate(whenText, refDate);
  if (!parsed) return null;
  const ymd  = formatInTimeZone(parsed, tz, 'yyyy-MM-dd');
  const hm   = formatInTimeZone(parsed, tz, 'HH:mm:ss');
  const localStamp = `${ymd} ${hm}`;
  return zonedTimeToUtc(localStamp, tz).toISOString();
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

// Current state for a given employee
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

const TYPE_MAP = new Map([
  ['clock in',   'clock_in'],
  ['clock out',  'clock_out'],
  ['break start','break_start'],
  ['break stop', 'break_stop'],
  ['drive start','drive_start'],
  ['drive stop', 'drive_stop'],
]);

// ---------------------- handler ----------------------

async function handleTimeclock(from, text, userProfile, ownerId, ownerProfile, isOwner, res) {
  const lc = String(text || '').toLowerCase().trim();
  const tz = userProfile?.tz || 'America/Toronto';
  const actorId = from;
  const now = new Date();

  try {
    if (lc === 'timeclock' || lc === 'help timeclock') return twiml(res, SOP_TIMECLOCK);

    // Resolve any pending backfill first
    const pending = await pg.getPendingAction({ ownerId, userId: from });
    if (pending && pending.kind === 'backfill_time') {
      const payload = JSON.parse(pending.payload || '{}');
      if (/^(yes|y|confirm)$/i.test(lc)) {
        await pg.logTimeEntryWithJob(ownerId, payload.target, payload.type, payload.tsIso, payload.jobName || null, tz, { requester_id: actorId });
        await pg.deletePendingAction(pending.id);
        return twiml(res, `✅ Backfilled **${payload.human}** for ${payload.target} at ${formatLocal(payload.tsIso, tz)}.`);
      }
      if (/^(no|n|cancel)$/i.test(lc)) {
        await pg.deletePendingAction(pending.id);
        return twiml(res, 'Backfill cancelled.');
      }
      await sendQuickReply(from, `Backfill **${payload.human}** for ${payload.target} at ${formatLocal(payload.tsIso, tz)}?`, ['Yes','No']);
      return true;
    }

    // Rate-limit
    const limit = await pg.checkTimeEntryLimit(ownerId, actorId, { max: 8, windowSec: 30 });
    if (limit && limit.ok === false) return twiml(res, 'Too many actions — slow down for a few seconds.');

    const jobName = extractJobHint(text) || null; // use original text for nicer job-name capture
    const whenTxt = extractAtWhen(text);          // use original text to catch punctuation
    const tsOverride = whenTxt ? parseLocalWhenToIso(whenTxt, tz, now) : null;
    const tsToUse = tsOverride || now;

    // Intent detection (command verbs present anywhere)
    let isClockIn     = /\b(clock ?in|start shift)\b/i.test(text);
    let isClockOut    = /\b(clock ?out|end shift)\b/i.test(text);
    const isBreakStart  = /\bbreak (start|on)\b/i.test(text) || /\bstart break\b/i.test(text);
    const isBreakStop   = /\bbreak (stop|off|end)\b/i.test(text) || /\bend break\b/i.test(text);
    const isDriveStart  = /\bdrive (start|on)\b/i.test(text) || /\bstart drive\b/i.test(text);
    const isDriveStop   = /\bdrive (stop|off|end)\b/i.test(text) || /\bend drive\b/i.test(text);
    const isUndo        = /^undo(\s+last)?$/i.test(lc);

    // Backfill verb with confirmation
    const mBack = lc.match(/^backfill\s+(clock\s*in|clock\s*out|break start|break stop|drive start|drive stop)(?:\s+for)?\s+(.+?)\s+(?:at|on)\s+(.+)$/i);
    if (mBack) {
      const human = mBack[1].toLowerCase().replace(/\s+/, ' ');
      const rawTarget = mBack[2].trim();
      const when = mBack[3].trim();
      const type = TYPE_MAP.get(human);
      if (!type) return twiml(res, 'Sorry, I couldn’t understand that backfill action.');
      const tsIso = parseLocalWhenToIso(when, tz, now);
      if (!tsIso) return twiml(res, `Couldn't parse the time "${when}". Try “today 4:00 am”.`);
      const target = rawTarget;
      await pg.savePendingAction({
        ownerId, userId: from, kind: 'backfill_time',
        payload: JSON.stringify({ human, target, type, tsIso, jobName }),
      });
      await sendQuickReply(from, `Backfill **${human}** for ${target} at ${formatLocal(tsIso, tz)}?`, ['Yes','No']);
      return true;
    }

    // -------- Target & action resolution order --------
    // 1) 'for <name>' (most explicit)
    let target = extractForName(lc);

    // 2) narrative "<Name> forgot to clock in/out ..."
    const narrative = extractNarrative(text);
    if (!target && narrative) target = narrative.name;

    // 3) strict command-at-start "clock in/out <name>"
    if (!target) target = extractCommandTarget(lc);

    // 4) fallback: caller
    const callerName = userProfile?.name || from;
    target = (target || callerName || '').trim();

    // Guard against time words being mistaken for names
    if (TIME_WORDS.has(target)) {
      // try to recover from narrative (e.g., "Justin forgot to clock in today at ...")
      if (narrative?.name) {
        target = narrative.name;
      } else {
        target = callerName;
      }
    }

    // If the narrative specified the action, respect it
    if (narrative?.action === 'in')  isClockIn = true;
    if (narrative?.action === 'out') isClockOut = true;

    // ---- FORCE CLOCK IN/OUT ----
    const mForceIn = lc.match(/^\s*force\s+clock\s+in\s+(.+)$/i);
    if (mForceIn) {
      const forced = mForceIn[1].trim();
      await pg.logTimeEntryWithJob(ownerId, forced, 'clock_in', tsToUse, jobName, tz, { requester_id: actorId });
      return twiml(res, `✅ Forced clock-in recorded for ${forced} at ${formatLocal(tsToUse, tz)}.`);
    }
    const mForceOut = lc.match(/^\s*force\s+clock\s+out\s+(.+)$/i);
    if (mForceOut) {
      const forced = mForceOut[1].trim();
      await pg.logTimeEntryWithJob(ownerId, forced, 'clock_out', tsToUse, jobName, tz, { requester_id: actorId });
      return twiml(res, `✅ Forced clock-out recorded for ${forced} at ${formatLocal(tsToUse, tz)}.`);
    }

    // Need state only when not backdating
    const state = await getCurrentState(ownerId, target);

    // ---- CLOCK IN ----
    if (isClockIn) {
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

    // ---- CLOCK OUT ----
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

    // ---- BREAK START/STOP ----
    if (/\bbreak (start|on)\b/i.test(text) || /\bstart break\b/i.test(text)) {
      if (!tsOverride && !state.hasOpenShift) return twiml(res, `Can't start a break — no open shift for ${target}.`);
      await pg.logTimeEntryWithJob(ownerId, target, 'break_start', tsToUse, jobName, tz, { requester_id: actorId });
      return twiml(res, `⏸️ Break started for ${target} at ${formatLocal(tsToUse, tz)}.`);
    }
    if (/\bbreak (stop|off|end)\b/i.test(text) || /\bend break\b/i.test(text)) {
      if (!tsOverride && !state.hasOpenShift) return twiml(res, `Can't end break — no open shift for ${target}.`);
      await pg.logTimeEntryWithJob(ownerId, target, 'break_stop', tsToUse, jobName, tz, { requester_id: actorId });
      return twiml(res, `▶️ Break ended for ${target} at ${formatLocal(tsToUse, tz)}.`);
    }

    // ---- DRIVE START/STOP ----
    if (/\bdrive (start|on)\b/i.test(text) || /\bstart drive\b/i.test(text)) {
      if (!tsOverride && !state.hasOpenShift) return twiml(res, `Can't start drive — no open shift for ${target}.`);
      await pg.logTimeEntryWithJob(ownerId, target, 'drive_start', tsToUse, jobName, tz, { requester_id: actorId });
      return twiml(res, `🚚 Drive started for ${target} at ${formatLocal(tsToUse, tz)}.`);
    }
    if (/\bdrive (stop|off|end)\b/i.test(text) || /\bend drive\b/i.test(text)) {
      if (!tsOverride && !state.hasOpenShift) return twiml(res, `Can't stop drive — no open shift for ${target}.`);
      await pg.logTimeEntryWithJob(ownerId, target, 'drive_stop', tsToUse, jobName, tz, { requester_id: actorId });
      return twiml(res, `🅿️ Drive stopped for ${target} at ${formatLocal(tsToUse, tz)}.`);
    }

    // ---- UNDO LAST (placeholder) ----
    if (isUndo) return twiml(res, `Undo isn’t available here yet. Say what to undo and I’ll add it next.`);

    return false;
  } catch (e) {
    console.error('[timeclock] error:', e?.message);
    return twiml(res, 'Timeclock error. Try again.');
  } finally {
    try { res?.req?.releaseLock?.(); } catch {}
  }
}

module.exports = { handleTimeclock, SOP_TIMECLOCK };
