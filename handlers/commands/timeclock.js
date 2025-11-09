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

// ---- humanization helpers -------------------------------------------------------
function toHumanTime(ts, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
  return f.format(new Date(ts)).replace(' AM','am').replace(' PM','pm');
}
function toHumanDate(ts, tz) {
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
    case 'break_start': return 'started their break';
    case 'break_stop':  return 'ended their break';
    case 'drive_start': return 'started driving';
    case 'drive_stop':  return 'stopped driving';
    default:            return type.replace('_',' ');
  }
}
function humanLine(type, target, ts, tz) {
  // "Justin ended their break 6:15am on 11-08-2025"
  return `${target} ${humanVerb(type)} ${toHumanTime(ts, tz)} on ${toHumanDate(ts, tz)}`;
}

const RESP = (text) => `<Response><Message>${text}</Message></Response>`;

// ---- parsers -------------------------------------------------------------------

function extractJobHint(text = '') {
  const m = String(text).match(/@\s*([^\n\r]+)/);
  return m ? m[1].trim() : null;
}

// "clock in justin", "clock out Justin @ Roof", "force clock in Scott"
function extractTargetName(lc) {
  const noJob = lc.replace(/\s*@\s*[^\n\r]+$/, '');
  let m = noJob.match(/^(?:clock|start|punch)\s+in\s+(.+)$/i);
  if (!m) m = noJob.match(/^(?:clock|end|punch)\s+out\s+(.+)$/i);
  if (!m) m = noJob.match(/^force\s+clock\s+(?:in|out)\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// "<name> forgot/didn't/needs to clock in/out ..."
function extractNarrative(text) {
  const m = String(text).match(
    /^([\p{L}\p{M}.'-]+(?:\s+[\p{L}\p{M}.'-]+){0,2})\s+(?:forgot|did\s*not|didn't|needs?|need)\s+to\s+clock\s+(in|out)\b/iu
  );
  if (!m) return null;
  return { name: m[1].trim(), action: m[2].toLowerCase() };
}

// "<name> forgot to start/stop (their) 2nd/second/third/3rd break/drive ..."
function extractSegmentNarrative(text) {
  const ordinal = '(?:second|2nd|third|3rd|fourth|4th|fifth|5th)?'; // optional ordinal qualifier
  const re = new RegExp(
    `^([\\p{L}\\p{M}.'-]+(?:\\s+[\\p{L}\\p{M}.'-]+){0,2})\\s+(?:forgot|did\\s*not|didn't|needs?|need)\\s+to\\s+(start|stop|end)\\s+(?:his|her|their|the)?\\s*(?:${ordinal}\\s*)?(break|drive)\\b`,
    'iu'
  );
  const m = String(text).match(re);
  if (!m) return null;
  const name = m[1].trim();
  const act  = m[2].toLowerCase();              // start | stop | end
  const seg  = m[3].toLowerCase();              // break | drive
  const action = (act === 'end' || act === 'stop') ? 'stop' : 'start';
  return { name, seg, action };
}

// Pull trailing "at <when>"
function extractAtWhen(text) {
  const matches = [...text.matchAll(/\bat\s+([^.,;!?]+)(?:[.,;!?]|$)/ig)];
  if (!matches.length) return null;
  return matches[matches.length - 1][1].trim();
}

function parseLocalWhenToIso(whenText, tz, refDate = new Date()) {
  if (!whenText) return null;
  const results = chrono.parse(whenText, refDate);
  if (!results.length) return null;
  const start = results[0].start;

  const refY = Number(formatInTimeZone(refDate, tz, 'yyyy'));
  const refM = Number(formatInTimeZone(refDate, tz, 'MM'));
  const refD = Number(formatInTimeZone(refDate, tz, 'dd'));

  const year  = start.isCertain('year')  ? start.get('year')  : refY;
  const month = start.isCertain('month') ? start.get('month') : refM;
  const day   = start.isCertain('day')   ? start.get('day')   : refD;
  const hour   = start.isCertain('hour')   ? start.get('hour')   : 0;
  const minute = start.isCertain('minute') ? start.get('minute') : 0;
  const second = start.isCertain('second') ? start.get('second') : 0;

  const pad = n => String(n).padStart(2, '0');
  const localStamp = `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
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

// --- Get current state ----------------------------------------------------------
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

// ---- handler -------------------------------------------------------------------
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

    // intents (tolerant)
    let isClockIn   = /\b(clock ?in|start shift)\b/i.test(text);
    let isClockOut  = /\b(clock ?out|end shift)\b/i.test(text);

    let isBreakStart =
      /\bbreak\s*(start|on)\b/i.test(text) ||
      /\bstart(?:ing)?\s+(?:his|her|their|the)?\s*(?:second|2nd|third|3rd|fourth|4th|fifth|5th)?\s*break\b/i.test(text);

    let isBreakStop =
      /\bbreak\s*(stop|off|end)\b/i.test(text) ||
      /\b(end(?:ing)?|stop(?:ping)?)\s+(?:his|her|their|the)?\s*(?:second|2nd|third|3rd|fourth|4th|fifth|5th)?\s*break\b/i.test(text);

    let isDriveStart =
      /\bdrive\s*(start|on)\b/i.test(text) ||
      /\bstart(?:ing)?\s+(?:his|her|their|the)?\s*(?:second|2nd|third|3rd|fourth|4th|fifth|5th)?\s*drive\b/i.test(text);

    let isDriveStop =
      /\bdrive\s*(stop|off|end)\b/i.test(text) ||
      /\b(end(?:ing)?|stop(?:ping)?)\s+(?:his|her|their|the)?\s*(?:second|2nd|third|3rd|fourth|4th|fifth|5th)?\s*drive\b/i.test(text);

    const isUndo = /^undo(\s+last)?$/i.test(lc);

    // Derive target
    const explicitTarget = extractTargetName(lc);
    const narrative = extractNarrative(text);
    let target = explicitTarget || (narrative?.name) || (userProfile?.name) || from;

    // Segment narrative (now supports "2nd/second/3rd/… break/drive")
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

    // time/pronoun guard
    if (TIME_WORDS.has(String(target).toLowerCase()) || /^me|myself|my$/i.test(target)) {
      target = userProfile?.name || from;
    }

    if (narrative && !isClockIn && !isClockOut) {
      if (narrative.action === 'in')  isClockIn = true;
      if (narrative.action === 'out') isClockOut = true;
    }

    // "at <when>"
    const whenTxt = extractAtWhen(text);
    const tsOverride = whenTxt ? parseLocalWhenToIso(whenTxt, tz, now) : null;

    // Resolve type
    let resolvedType =
      isClockIn ? 'clock_in' :
      isClockOut ? 'clock_out' :
      isBreakStart ? 'break_start' :
      isBreakStop ? 'break_stop' :
      isDriveStart ? 'drive_start' :
      isDriveStop ? 'drive_stop' : null;

    // Disambiguate if user said “break/drive” but not start/stop
    if (!resolvedType) {
      const hasBreak = /\bbreak\b/i.test(text);
      const hasDrive = /\bdrive\b/i.test(text);
      if (hasBreak || hasDrive) {
        const seg = hasBreak ? 'Break' : 'Drive';
        // Buttons + explicit typed fallback
        await sendQuickReply(
          from,
          `Do you want me to ${seg.toLowerCase()} **start** or **stop** for ${target}${tsOverride ? ' at ' + formatLocal(tsOverride, tz) : ''}?\nReply: "${seg} Start" | "${seg} Stop" | "Cancel"`,
          [`${seg} Start`, `${seg} Stop`, 'Cancel']
        );
        return twiml(res, 'Choose an option above.');
      }
    }

    // Log (pre-confirm)
    console.info('[timeclock cmd]', {
      ownerId,
      actor: from,
      target,
      action: resolvedType || (isUndo ? 'undo' : 'unknown'),
      whenTxt,
      tsOverride,
      tz
    });

    // Backfill confirm (>2 min in past/future)
    if (tsOverride) {
      const diffMin = Math.abs((new Date(tsOverride).getTime() - now.getTime()) / 60000);
      if (diffMin > 2) {
        const type = resolvedType;
        if (type) {
          await pg.savePendingAction({
            ownerId: String(ownerId).replace(/\D/g,''),
            userId: from,
            kind: 'backfill_time',
            payload: { target, type, tsOverride, jobName }
          });

          const line = humanLine(type, target, tsOverride, tz);
          try {
            await sendBackfillConfirm(from, line, { preferTemplate: true });
          } catch (_) { /* final fallback handled inside sendBackfillConfirm now */ }

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

    // Normalize booleans from resolvedType
    const isClockIn2     = resolvedType === 'clock_in';
    const isClockOut2    = resolvedType === 'clock_out';
    const isBreakStart2  = resolvedType === 'break_start';
    const isBreakStop2   = resolvedType === 'break_stop';
    const isDriveStart2  = resolvedType === 'drive_start';
    const isDriveStop2   = resolvedType === 'drive_stop';

    // ---- CLOCK IN
    if (isClockIn2) {
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
    if (isClockOut2) {
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
    if (isBreakStart2) {
      const state2 = state;
      if (!state2.hasOpenShift) return twiml(res, `Can't start a break — no open shift for ${target}.`);
      if (!tsOverride && state2.openBreak)     return twiml(res, `${target} is already on break.`);
      await pg.logTimeEntryWithJob(ownerId, target, 'break_start', tsOverride || now, jobName, tz, { requester_id: actorId });
      return twiml(res, `⏸️ Break started for ${target} at ${formatLocal(tsOverride || now, tz)}.`);
    }

    // ---- BREAK STOP
    if (isBreakStop2) {
      const state2 = state;
      if (!state2.hasOpenShift) return twiml(res, `Can't end break — no open shift for ${target}.`);
      if (!tsOverride && !state2.openBreak)    return twiml(res, `No active break for ${target}.`);
      await pg.logTimeEntryWithJob(ownerId, target, 'break_stop', tsOverride || now, jobName, tz, { requester_id: actorId });
      return twiml(res, `▶️ Break ended for ${target} at ${formatLocal(tsOverride || now, tz)}.`);
    }

    // ---- DRIVE START
    if (isDriveStart2) {
      if (!state.hasOpenShift) return twiml(res, `Can't start drive — no open shift for ${target}.`);
      if (!tsOverride && state.openDrive)     return twiml(res, `${target} is already driving.`);
      await pg.logTimeEntryWithJob(ownerId, target, 'drive_start', tsOverride || now, jobName, tz, { requester_id: actorId });
      return twiml(res, `🚚 Drive started for ${target} at ${formatLocal(tsOverride || now, tz)}.`);
    }

    // ---- DRIVE STOP
    if (isDriveStop2) {
      if (!state.hasOpenShift) return twiml(res, `Can't stop drive — no open shift for ${target}.`);
      if (!tsOverride && !state.openDrive)    return twiml(res, `No active drive for ${target}.`);
      await pg.logTimeEntryWithJob(ownerId, target, 'drive_stop', tsOverride || now, jobName, tz, { requester_id: actorId });
      return twiml(res, `🅿️ Drive stopped for ${target} at ${formatLocal(tsOverride || now, tz)}.`);
    }

    // ---- UNDO LAST
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
