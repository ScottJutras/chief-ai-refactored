// handlers/commands/timeclock.js
// -------------------------------------------------------------------
// Timeclock — State Machine Enforced (North Star §4.2)
// - Prevents invalid states: clock out without in, break/drive without shift
// - Pauses shift during break/lunch; drive time runs in parallel
// - Auto-closes break/drive on clock_out
// - Clear confirmations with ✅ and local time
// - Backfill-safe with quick-reply confirmation
// -------------------------------------------------------------------

const pg = require('../../services/postgres');
const chrono = require('chrono-node');
const { formatInTimeZone, zonedTimeToUtc } = require('date-fns-tz');
const { sendQuickReply } = require('../../services/twilio');

// What counts as "in" vs "out" when checking latest event
const IN_TYPES  = new Set(['in','clock_in','punch_in']);
const OUT_TYPES = new Set(['out','clock_out','punch_out','end','finish']);

const TIME_WORDS = new Set([
  'today','yesterday','tomorrow','tonight','this morning','this afternoon','this evening',
  'morning','afternoon','evening','night','now','later'
]);

const RESP = (text) => `<Response><Message>${text}</Message></Response>`;

// ---- helpers -------------------------------------------------------

function extractJobHint(text = '') {
  const m = String(text).match(/@\s*([^\n\r]+)/);
  return m ? m[1].trim() : null;
}

// Extract a target employee name from commands like:
// "clock in justin", "clock out Justin @ Roof", "force clock in Scott"
function extractTargetName(lc) {
  // strip any trailing "@ Job …" so it doesn't get captured as part of the name
  const noJob = lc.replace(/\s*@\s*[^\n\r]+$/, '');
  let m = noJob.match(/\bclock\s+in\s+(.+)$/i);
  if (!m) m = noJob.match(/\bclock\s+out\s+(.+)$/i);
  if (!m) m = noJob.match(/^force\s+clock\s+(?:in|out)\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// Natural language narrative: "<name> forgot/didn't/needs to clock in/out ..."
function extractNarrative(text) {
  // Unicode-aware and case-insensitive
  const m = String(text).match(
    /^([\p{L}\p{M}.'-]+(?:\s+[\p{L}\p{M}.'-]+){0,2})\s+(?:forgot|did\s*not|didn't|needs|need)\s+to\s+clock\s+(in|out)\b/iu
  );
  if (!m) return null;
  return { name: m[1].trim(), action: m[2].toLowerCase() }; // 'in' | 'out'
}

// Pull a trailing "at <when>" phrase; keep it tight to end or punctuation
function extractAtWhen(text) {
  const m = String(text).match(/\bat\s+([^.,;!?]+)$/i);
  return m ? m[1].trim() : null;
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

    // Check for pending backfill confirmation
    const pending = await pg.getPendingAction({ ownerId: String(ownerId).replace(/\D/g, ''), userId: from });
    if (pending && /^confirm$/i.test(lc)) {
      try {
        const payload = JSON.parse(pending.payload || '{}');
        await pg.logTimeEntryWithJob(
          ownerId,
          payload.target,
          payload.type,
          payload.tsOverride,
          payload.jobName || null,
          tz,
          { requester_id: actorId }
        );
        await pg.deletePendingAction(pending.id);
        return twiml(res, `✅ ${payload.target} ${payload.type.replace('_',' ')} at ${formatLocal(payload.tsOverride, tz)} (backfilled).`);
      } catch (e) {
        await pg.deletePendingAction(pending.id).catch(()=>{});
        return twiml(res, `Backfill failed. ${e?.message || ''}`.trim());
      }
    }
    if (pending && /^(cancel|no)$/i.test(lc)) {
      await pg.deletePendingAction(pending.id).catch(()=>{});
      return twiml(res, `Backfill cancelled.`);
    }

    // Rate limit (fail-open if limiter has an internal error)
    const limit = await pg.checkTimeEntryLimit(ownerId, actorId, { max: 8, windowSec: 30 });
    if (limit && limit.ok === false) {
      return twiml(res, 'Too many actions — slow down for a few seconds.');
    }

    const jobName = extractJobHint(text) || null;

    // intents
    let isClockIn     = /\b(clock ?in|start shift)\b/i.test(text);
    let isClockOut    = /\b(clock ?out|end shift)\b/i.test(text);
    const isBreakStart  = /\bbreak (start|on)\b/i.test(text) || /\bstart break\b/i.test(text);
    const isBreakStop   = /\bbreak (stop|off|end)\b/i.test(text) || /\bend break\b/i.test(text);
    const isDriveStart  = /\bdrive (start|on)\b/i.test(text) || /\bstart drive\b/i.test(text);
    const isDriveStop   = /\bdrive (stop|off|end)\b/i.test(text) || /\bend drive\b/i.test(text);
    const isUndo        = /^undo(\s+last)?$/i.test(lc);

    // Derive target (explicit > narrative > caller’s profile > phone)
    const explicitTarget = extractTargetName(lc);
    const narrative = extractNarrative(text);
    let target = explicitTarget || (narrative?.name) || (userProfile?.name) || from;

    // Guard against time words/pronouns being mistaken for names
    if (TIME_WORDS.has(String(target).toLowerCase()) || /^me|myself|my$/i.test(target)) {
      target = userProfile?.name || from;
    }

    // If narrative defined an action, adopt it unless already explicit
    if (narrative && !isClockIn && !isClockOut) {
      if (narrative.action === 'in')  isClockIn = true;
      if (narrative.action === 'out') isClockOut = true;
    }

    // Optional "at <when>" override (Toronto-aware)
    const whenTxt = extractAtWhen(text);
    const tsOverride = whenTxt ? parseLocalWhenToIso(whenTxt, tz, now) : null;

    // Log resolved command
    console.info('[timeclock cmd]', {
      ownerId,
      actor: from,
      target,
      action: isClockIn ? 'clock_in' : isClockOut ? 'clock_out'
            : isBreakStart ? 'break_start'
            : isBreakStop  ? 'break_stop'
            : isDriveStart ? 'drive_start'
            : isDriveStop  ? 'drive_stop'
            : isUndo       ? 'undo'
            : 'unknown',
      whenTxt,
      tsOverride,
      tz
    });

    // If we have a backfill timestamp (> 2 minutes from now), require confirmation
    if (tsOverride) {
      const diffMin = Math.abs((new Date(tsOverride).getTime() - now.getTime()) / 60000);
      if (diffMin > 2) {
        const type =
          isClockIn ? 'clock_in' :
          isClockOut ? 'clock_out' :
          isBreakStart ? 'break_start' :
          isBreakStop  ? 'break_stop'  :
          isDriveStart ? 'drive_start' :
          isDriveStop  ? 'drive_stop'  :
          null;

        if (type) {
          const id = await pg.savePendingAction({
            ownerId: String(ownerId).replace(/\D/g, ''),
            userId: from,
            kind: 'backfill_time',
            payload: JSON.stringify({ target, type, tsOverride, jobName })
          });
          await sendQuickReply(
            from,
            `Confirm backfill: **${target}** ${type.replace('_',' ')} at ${formatLocal(tsOverride, tz)}?`,
            ['Confirm', 'Cancel']
          );
          return twiml(res, 'I sent a confirmation — tap **Confirm** or **Cancel**.');
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
      // write out (auto-closes subordinate segments in reporting)
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
