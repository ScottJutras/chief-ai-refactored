// handlers/commands/timeclock.js
// -------------------------------------------------------------------
// Timeclock — State Machine Enforced (North Star §4.2)
// - Prevents invalid states: clock out without in, break/drive without shift
// - Pauses shift during break/lunch; drive time runs in parallel
// - Auto-closes break/drive on clock_out
// - Clear confirmations with ✅ and local time
// - Backfill-safe with Ask → Confirm → Execute, tolerant NLP
// -------------------------------------------------------------------

const pg = require('../../services/postgres');
const chrono = require('chrono-node');
const { formatInTimeZone, zonedTimeToUtc } = require('date-fns-tz');
const { sendBackfillConfirm, sendQuickReply } = require('../../services/twilio');

// What counts as "in" vs "out" when checking latest event
const IN_TYPES  = new Set(['in','clock_in','punch_in']);
const OUT_TYPES = new Set(['out','clock_out','punch_out','end','finish']);

const TIME_WORDS = new Set([
  'today','yesterday','tomorrow','tonight','this morning','this afternoon','this evening',
  'morning','afternoon','evening','night','now','later'
]);

const RESP = (text) => `<Response><Message>${text}</Message></Response>`;

// ---- helpers -------------------------------------------------------

function toHumanTime(ts, tz) {
  // e.g., "6:15am" (lowercase am/pm)
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
  return f.format(new Date(ts)).replace(' AM','am').replace(' PM','pm');
}
function toHumanDate(ts, tz) {
  // e.g., "11-08-2025" (dd-MM-yyyy)
  const d = new Date(ts);
  const dd = formatInTimeZone(d, tz, 'dd');
  const MM = formatInTimeZone(d, tz, 'MM');
  const yyyy = formatInTimeZone(d, tz, 'yyyy');
  return `${dd}-${MM}-${yyyy}`;
}
function humanVerb(type) {
  switch (type) {
    case 'clock_in':    return 'clocked in';
    case 'clock_out':   return 'clocked out';
    case 'break_start': return 'started their break';   // ← was "his"
    case 'break_stop':  return 'ended their break';     // ← was "his"
    case 'drive_start': return 'started driving';
    case 'drive_stop':  return 'stopped driving';
    default:            return type.replace('_',' ');
  }
}

function humanLine(type, target, ts, tz) {
  // "Justin ended his break 6:15am on 11-08-2025"
  return `${target} ${humanVerb(type)} ${toHumanTime(ts, tz)} on ${toHumanDate(ts, tz)}`;
}


function extractJobHint(text = '') {
  const m = String(text).match(/@\s*([^\n\r]+)/);
  return m ? m[1].trim() : null;
}

// Extract a target employee name from commands like:
// "clock in justin", "clock out Justin @ Roof", "force clock in Scott"
function extractTargetName(lc) {
  // strip any trailing "@ Job …" so it doesn't get captured as part of the name
  const noJob = lc.replace(/\s*@\s*[^\n\r]+$/, '');
  let m = noJob.match(/^(?:clock|start|punch)\s+in\s+(.+)$/i);
  if (!m) m = noJob.match(/^(?:clock|end|punch)\s+out\s+(.+)$/i);
  if (!m) m = noJob.match(/^force\s+clock\s+(?:in|out)\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// Natural language narrative: "<name> forgot/didn't/needs to clock in/out ..."
function extractNarrative(text) {
  // Unicode-aware and case-insensitive
  const m = String(text).match(
    /^([\p{L}\p{M}.'-]+(?:\s+[\p{L}\p{M}.'-]+){0,2})\s+(?:forgot|did\s*not|didn't|needs?|need)\s+to\s+clock\s+(in|out)\b/iu
  );
  if (!m) return null;
  return { name: m[1].trim(), action: m[2].toLowerCase() }; // 'in' | 'out'
}

// Narrative for break/drive: "<name> forgot to start/stop (his|her|their) break/drive ..."
function extractSegmentNarrative(text) {
  const m = String(text).match(
    /^([\p{L}\p{M}.'-]+(?:\s+[\p{L}\p{M}.'-]+){0,2})\s+(?:forgot|did\s*not|didn't|needs?|need)\s+to\s+(start|stop|end)\s+(?:his|her|their|the)?\s*(break|drive)\b/iu
  );
  if (!m) return null;
  const name = m[1].trim();
  const act  = m[2].toLowerCase();           // start | stop | end
  const seg  = m[3].toLowerCase();           // break | drive
  const action = (act === 'end' || act === 'stop') ? 'stop' : 'start';
  return { name, seg, action };              // e.g., { name:"Justin", seg:"break", action:"start" }
}

// Pull a trailing "at <when>" phrase; keep it tight to end or punctuation
function extractAtWhen(text) {
  const matches = [...text.matchAll(/\bat\s+([^.,;!?]+)(?:[.,;!?]|$)/ig)];
  if (!matches.length) return null;
  return matches[matches.length - 1][1].trim();
}

// Build a UTC ISO timestamp by interpreting the phrase IN tz (not server TZ)
function parseLocalWhenToIso(whenText, tz, refDate = new Date()) {
  if (!whenText) return null;

  // Use chrono.parse for components (so "today", "yesterday", etc. work)
  const results = chrono.parse(whenText, refDate);
  if (!results.length) return null;
  const start = results[0].start;

  // Reference Y-M-D in the user's timezone (e.g., "today" should be today in tz)
  const refY = Number(formatInTimeZone(refDate, tz, 'yyyy'));
  const refM = Number(formatInTimeZone(refDate, tz, 'MM'));
  const refD = Number(formatInTimeZone(refDate, tz, 'dd'));

  // Use parsed components when certain; otherwise fall back to ref Y/M/D
  const year  = start.isCertain('year')  ? start.get('year')  : refY;
  const month = start.isCertain('month') ? start.get('month') : refM; // 1..12
  const day   = start.isCertain('day')   ? start.get('day')   : refD;

  const hour   = start.isCertain('hour')   ? start.get('hour')   : 0;
  const minute = start.isCertain('minute') ? start.get('minute') : 0;
  const second = start.isCertain('second') ? start.get('second') : 0;

  const pad = n => String(n).padStart(2, '0');
  const localStamp = `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;

  // Convert "localStamp in tz" -> UTC ISO
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
  const now = new Date();

  try {
    // Help
    if (lc === 'timeclock' || lc === 'help timeclock') {
      return twiml(res, `Timeclock — Quick guide:
• clock in / clock out
• break start / break stop
• drive start / drive stop
• undo last
• timesheet week
Tip: add @ Job Name for context (e.g., “clock in @ Roof Repair”).`);
    }

    // Rate limit (fail-open if limiter has an internal error)
    const limit = await pg.checkTimeEntryLimit(ownerId, actorId, { max: 8, windowSec: 30 });
    if (limit && limit.ok === false) {
      return twiml(res, 'Too many actions — slow down for a few seconds.');
    }

    const jobName = extractJobHint(text) || null;

    // intents (tolerant to "start his/her/their break", "stop the break", etc.)
    let isClockIn   = /\b(clock ?in|start shift)\b/i.test(text);
    let isClockOut  = /\b(clock ?out|end shift)\b/i.test(text);

    let isBreakStart =
      /\bbreak\s*(start|on)\b/i.test(text) ||
      /\bstart(?:ing)?\s+(?:his|her|their|the)?\s*break\b/i.test(text);

    let isBreakStop =
      /\bbreak\s*(stop|off|end)\b/i.test(text) ||
      /\bend(?:ing)?\s+(?:his|her|their|the)?\s*break\b/i.test(text) ||
      /\bstop(?:ping)?\s+(?:his|her|their|the)?\s*break\b/i.test(text);

    let isDriveStart =
      /\bdrive\s*(start|on)\b/i.test(text) ||
      /\bstart(?:ing)?\s+(?:his|her|their|the)?\s*drive\b/i.test(text);

    let isDriveStop =
      /\bdrive\s*(stop|off|end)\b/i.test(text) ||
      /\bend(?:ing)?\s+(?:his|her|their|the)?\s*drive\b/i.test(text) ||
      /\bstop(?:ping)?\s+(?:his|her|their|the)?\s*drive\b/i.test(text);

    const isUndo = /^undo(\s+last)?$/i.test(lc);

    // Derive target (explicit > narrative > caller’s profile > phone)
    const explicitTarget = extractTargetName(lc);
    const narrative = extractNarrative(text);
    let target = explicitTarget || (narrative?.name) || (userProfile?.name) || from;

    // Segment narrative (e.g., "Justin forgot to start his break ...")
    const segNarr = extractSegmentNarrative(text);
    if (segNarr) {
      target = explicitTarget || segNarr.name || target;
      if (segNarr.seg === 'break') {
        if (segNarr.action === 'start') { isBreakStart = true; isBreakStop = false; }
        else                            { isBreakStop  = true; isBreakStart = false; }
      } else if (segNarr.seg === 'drive') {
        if (segNarr.action === 'start') { isDriveStart = true; isDriveStop = false; }
        else                            { isDriveStop  = true; isDriveStart = false; }
      }
    }

    // Guard against time words/pronouns being mistaken for names
    if (TIME_WORDS.has(String(target).toLowerCase()) || /^me|myself|my$/i.test(target)) {
      target = userProfile?.name || from;
    }

    // If narrative defined a clock in/out action, adopt it unless already explicit
    if (narrative && !isClockIn && !isClockOut) {
      if (narrative.action === 'in')  isClockIn = true;
      if (narrative.action === 'out') isClockOut = true;
    }

    // Optional "at <when>" override (Toronto-aware)
    const whenTxt = extractAtWhen(text);
    const tsOverride = whenTxt ? parseLocalWhenToIso(whenTxt, tz, now) : null;

    // Resolve a type if already clear
    let resolvedType =
      isClockIn ? 'clock_in' :
      isClockOut ? 'clock_out' :
      isBreakStart ? 'break_start' :
      isBreakStop ? 'break_stop' :
      isDriveStart ? 'drive_start' :
      isDriveStop ? 'drive_stop' : null;

    // Repair: If we see 'break' or 'drive' but not the direction, ask Start/Stop
    if (!resolvedType) {
      const hasBreak = /\bbreak\b/i.test(text);
      const hasDrive = /\bdrive\b/i.test(text);
      if (hasBreak || hasDrive) {
        const seg = hasBreak ? 'Break' : 'Drive';
        // Ask user to choose start/stop via quick replies (labels match our detectors)
        await sendQuickReply(
          from,
          `Do you want me to ${seg.toLowerCase()} **start** or **stop** for ${target}${tsOverride ? ' at ' + formatLocal(tsOverride, tz) : ''}?`,
          [`${seg} Start`, `${seg} Stop`, 'Cancel']
        );
        return twiml(res, 'Choose an option above.');
      }
    }

    // Log resolved command (pre-confirm)
    console.info('[timeclock cmd]', {
      ownerId,
      actor: from,
      target,
      action: resolvedType || (isUndo ? 'undo' : 'unknown'),
      whenTxt,
      tsOverride,
      tz
    });

    // If we have a backfill timestamp (> 2 minutes from now), require confirmation
  if (tsOverride) {
    const diffMin = Math.abs((new Date(tsOverride).getTime() - now.getTime()) / 60000);
    if (diffMin > 2) {
      const type = resolvedType;
      if (type) {
        await pg.savePendingAction({
          ownerId: String(ownerId).replace(/\D/g,''),
          userId: from,
          kind: 'backfill_time',
          payload: { target, type, tsOverride, jobName }  // jsonb object
        });

        const line = humanLine(type, target, tsOverride, tz);

        try {
          await sendBackfillConfirm(
            from,
            line,
            { preferTemplate: true } // template first, fallback to quick replies
          );
        } catch (_) { /* no-op */ }

        return twiml(res, 'I sent a confirmation — reply **Confirm** or **Cancel**.');
      }
    }
  }


    // we need state for the *target* employee
    const state = await getCurrentState(ownerId, target);

    // ---- FORCE CLOCK IN
    const mForceIn = lc.match(/^force\s+clock\s+in\s+(.+)$/i);
    if (mForceIn) {
      const forced = mForceIn[1].trim();
      await pg.logTimeEntryWithJob(ownerId, forced, 'clock_in', tsOverride || now, jobName, tz, { requester_id: actorId });
      return twiml(res, `✅ Forced clock-in recorded for ${forced} at ${formatLocal(tsOverride || now, tz)}.`);
    }

    // ---- FORCE CLOCK OUT
    const mForceOut = lc.match(/^force\s+clock\s+out\s+(.+)$/i);
    if (mForceOut) {
      const forced = mForceOut[1].trim();
      await pg.logTimeEntryWithJob(ownerId, forced, 'clock_out', tsOverride || now, jobName, tz, { requester_id: actorId });
      return twiml(res, `✅ Forced clock-out recorded for ${forced} at ${formatLocal(tsOverride || now, tz)}.`);
    }

    // Normalize booleans from resolvedType (so the rest of code paths still work)
    isClockIn     = resolvedType === 'clock_in';
    isClockOut    = resolvedType === 'clock_out';
    isBreakStart  = resolvedType === 'break_start';
    isBreakStop   = resolvedType === 'break_stop';
    isDriveStart  = resolvedType === 'drive_start';
    isDriveStop   = resolvedType === 'drive_stop';

    // ---- CLOCK IN
    if (isClockIn) {
      const latest = await pg.getLatestTimeEvent(ownerId, target);
      const latestType = String(latest?.type || '').toLowerCase();
      if (!tsOverride && latest && IN_TYPES.has(latestType)) {
        const when = latest?.timestamp ? formatLocal(latest.timestamp, tz) : 'earlier';
        return twiml(res, `${target} is already clocked in since ${when}. Reply "force clock in ${target}" to override.`);
      }
      await pg.logTimeEntryWithJob(ownerId, target, 'clock_in', tsOverride || now, jobName, tz, { requester_id: actorId });
      return twiml(res, `✅ ${target} is clocked in at ${formatLocal(tsOverride || now, tz)}`);
    }

    // ---- CLOCK OUT
    if (isClockOut) {
      const latest = await pg.getLatestTimeEvent(ownerId, target);
      const latestType = String(latest?.type || '').toLowerCase();
      if (!tsOverride && latest && OUT_TYPES.has(latestType)) {
        const when = latest?.timestamp ? formatLocal(latest.timestamp, tz) : 'earlier';
        return twiml(res, `${target} is already clocked out since ${when}. (Use "force clock out ${target}" to override.)`);
      }
      await pg.logTimeEntryWithJob(ownerId, target, 'clock_out', tsOverride || now, jobName, tz, { requester_id: actorId });
      return twiml(res, `✅ ${target} is clocked out at ${formatLocal(tsOverride || now, tz)}`);
    }

    // ---- BREAK START
    if (isBreakStart) {
      if (!state.hasOpenShift) return twiml(res, `Can't start a break — no open shift for ${target}.`);
      if (!tsOverride && state.openBreak)     return twiml(res, `${target} is already on break.`);
      await pg.logTimeEntryWithJob(ownerId, target, 'break_start', tsOverride || now, jobName, tz, { requester_id: actorId });
      return twiml(res, `⏸️ Break started for ${target} at ${formatLocal(tsOverride || now, tz)}.`);
    }

    // ---- BREAK STOP
    if (isBreakStop) {
      if (!state.hasOpenShift) return twiml(res, `Can't end break — no open shift for ${target}.`);
      if (!tsOverride && !state.openBreak)    return twiml(res, `No active break for ${target}.`);
      await pg.logTimeEntryWithJob(ownerId, target, 'break_stop', tsOverride || now, jobName, tz, { requester_id: actorId });
      return twiml(res, `▶️ Break ended for ${target} at ${formatLocal(tsOverride || now, tz)}.`);
    }

    // ---- DRIVE START
    if (isDriveStart) {
      if (!state.hasOpenShift) return twiml(res, `Can't start drive — no open shift for ${target}.`);
      if (!tsOverride && state.openDrive)     return twiml(res, `${target} is already driving.`);
      await pg.logTimeEntryWithJob(ownerId, target, 'drive_start', tsOverride || now, jobName, tz, { requester_id: actorId });
      return twiml(res, `🚚 Drive started for ${target} at ${formatLocal(tsOverride || now, tz)}.`);
    }

    // ---- DRIVE STOP
    if (isDriveStop) {
      if (!state.hasOpenShift) return twiml(res, `Can't stop drive — no open shift for ${target}.`);
      if (!tsOverride && !state.openDrive)    return twiml(res, `No active drive for ${target}.`);
      await pg.logTimeEntryWithJob(ownerId, target, 'drive_stop', tsOverride || now, jobName, tz, { requester_id: actorId });
      return twiml(res, `🅿️ Drive stopped for ${target} at ${formatLocal(tsOverride || now, tz)}.`);
    }

    // ---- UNDO LAST (targeted)
    if (isUndo) {
      const del = await pg.query(
        `DELETE FROM public.time_entries
           WHERE id = (
             SELECT id FROM public.time_entries
              WHERE owner_id=$1 AND lower(employee_name)=lower($2)
              ORDER BY timestamp DESC
              LIMIT 1
           )
           RETURNING type, timestamp`,
        [String(ownerId).replace(/\D/g, ''), target]
      );
      if (!del.rowCount) return twiml(res, `Nothing to undo for ${target}.`);
      const type = del.rows[0].type.replace('_', ' ');
      const at = formatLocal(del.rows[0].timestamp, tz);
      return twiml(res, `Undid ${type} at ${at} for ${target}.`);
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

module.exports = { handleTimeclock };
