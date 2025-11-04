// handlers/commands/timeclock.js
// ---------------------------------------------------------------
// Timeclock – clock in/out, break/drive, undo, move‑last, batch.
// All DB calls via services/postgres (RLS‑guarded).
// ---------------------------------------------------------------
const pg = require('../../services/postgres');
const { formatInTimeZone, zonedTimeToUtc } = require('date-fns-tz');
const { releaseLock } = require('../../middleware/lock');

const RESP = (text) => `<Response><Message>${text}</Message></Response>`;

async function handleTimeclock(from, text, userProfile, ownerId, ownerProfile, isOwner, res) {
  const lc = String(text || '').toLowerCase().trim();
  const tz = userProfile?.timezone || 'America/Toronto';
  const extras = { requester_id: from };

  try {
    // -------------------------------------------------
    // 1. APPROVAL GATE
    // -------------------------------------------------
    const role = (userProfile?.role || 'team').toLowerCase();
    if (!isOwner && !['owner', 'board', 'team'].includes(role)) {
      await pg.createTimeEditRequestTask({
        ownerId,
        requesterId: from,
        title: `Role approval needed for ${userProfile?.name || from}`,
        body: `Please approve the user before they can log time.`,
      });
      res.status(200).type('application/xml').send(RESP(`You’re not approved yet. Owner notified.`));
      return true;
    }

    // -------------------------------------------------
    // 2. SUBSCRIPTION & ACTOR LIMITS
    // -------------------------------------------------
    const tier = (userProfile?.subscription_tier || 'starter').toLowerCase();
    const { ok: limitOk } = await pg.checkTimeEntryLimit(ownerId, tier);
    if (!limitOk) {
      res.status(200).type('application/xml').send(RESP(`Time‑entry limit reached for ${tier} tier. Upgrade or try tomorrow.`));
      return true;
    }
    const actorOk = await pg.checkActorLimit(ownerId, from);
    if (!actorOk) {
      res.status(200).type('application/xml').send(RESP(`Daily action limit reached. Try again tomorrow.`));
      return true;
    }

    // -------------------------------------------------
    // 3. JOB CONTEXT
    // -------------------------------------------------
    const jobHint = lc.match(/@\s*([^\s]+)$/i)?.[1] || null;
    const job = jobHint ? await pg.ensureJobByName(ownerId, jobHint) : await pg.resolveJobContext(ownerId, { require: false });
    const jobName = job?.name || null;

    // -------------------------------------------------
    // 4. CLOCK IN
    // -------------------------------------------------
    if (/^clock\s+in\b/.test(lc)) {
      const open = await pg.getOpenShift(ownerId, from);
      if (open) {
        await pg.createTimePrompt(ownerId, from, 'need_clock_out_time', { shiftStartUtc: open.timestamp });
        const local = formatInTimeZone(new Date(open.timestamp), tz, 'h:mm a');
        res.status(200).type('application/xml').send(RESP(`You’re already clocked in (started ${local}). Reply with clock‑out time.`));
        return true;
      }
      const now = new Date();
      await pg.logTimeEntryWithJob(ownerId, from, 'punch_in', now, jobName, tz, extras);
      const local = formatInTimeZone(now, tz, 'h:mm a');
      res.status(200).type('application/xml').send(RESP(`Clocked **in** at ${local}${jobName ? ` on ${jobName}` : ''}.`));
      return true;
    }

    // -------------------------------------------------
    // 5. CLOCK OUT
    // -------------------------------------------------
    if (/^clock\s+out\b/.test(lc)) {
      const open = await pg.getOpenShift(ownerId, from);
      if (!open) {
        res.status(200).type('application/xml').send(RESP(`You’re not clocked in. Clock in first.`));
        return true;
      }
      const now = new Date();
      await pg.closeOpenBreakIfAny(ownerId, from, open.timestamp, now.toISOString(), tz);
      await pg.logTimeEntryWithJob(ownerId, from, 'punch_out', now, null, tz, extras);
      const local = formatInTimeZone(now, tz, 'h:mm a');
      const entries = await pg.getEntriesBetween(ownerId, from, open.timestamp, now.toISOString());
      const { shiftHours, breakMinutes } = pg.computeEmployeeSummary(entries);
      res.status(200).type('application/xml').send(RESP(`Clocked **out** at ${local}.\nWorked ${shiftHours}h, ${breakMinutes}m paid breaks.`));
      return true;
    }

    // -------------------------------------------------
    // 6. BREAK / DRIVE START|END
    // -------------------------------------------------
    {
      const m = lc.match(/^(start|end)\s+(break|drive)$/i);
      if (m) {
        const [action, kind] = m.slice(1);
        const type = action === 'start' ? `${kind}_start` : `${kind}_end`;
        const openShift = await pg.getOpenShift(ownerId, from);
        if (!openShift) {
          res.status(200).type('application/xml').send(RESP(`You’re not clocked in. Clock in first.`));
          return true;
        }
        if (type.includes('start')) {
          const existing = await pg.getOpenBreakSince(ownerId, from, openShift.timestamp);
          if (existing) {
            res.status(200).type('application/xml').send(RESP(`You already have an open ${kind}. End it first.`));
            return true;
          }
        }
        const now = new Date();
        await pg.logTimeEntryWithJob(ownerId, from, type, now, null, tz, extras);
        const verb = action === 'start' ? 'Started' : 'Ended';
        res.status(200).type('application/xml').send(RESP(`${verb} **${kind}**.`));
        return true;
      }
    }

    // -------------------------------------------------
    // 7. UNDO LAST
    // -------------------------------------------------
    if (/^undo\s+last$/i.test(lc)) {
      const del = await pg.query(
        `DELETE FROM public.time_entries
          WHERE owner_id=$1 AND employee_name=$2
          ORDER BY timestamp DESC
          LIMIT 1
          RETURNING type`,
        [ownerId, from]
      );
      if (!del.rowCount) {
        res.status(200).type('application/xml').send(RESP(`Nothing to undo.`));
        return true;
      }
      res.status(200).type('application/xml').send(RESP(`Undid last **${del.rows[0].type.replace('_', ' ')}**.`));
      return true;
    }

    // -------------------------------------------------
    // 8. TIMESHEET WEEK
    // -------------------------------------------------
    if (/^timesheet\s+week$/i.test(lc)) {
      const report = await pg.generateTimesheet({ ownerId, person: from, period: 'week', tz });
      res.status(200).type('application/xml').send(RESP(`${report.message}\n(Week of ${report.startUtc.slice(0,10)})`));
      return true;
    }

    return false; // fall through
  } catch (e) {
    console.error('[timeclock] error:', e?.message);
    res.status(200).type('application/xml').send(RESP(`Timeclock error. Try again.`));
    return true;
  } finally {
    await releaseLock(`lock:${ownerId || from}`);
  }
}

module.exports = { handleTimeclock };