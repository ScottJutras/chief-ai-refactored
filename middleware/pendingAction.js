// middleware/pendingAction.js
// Handles simple "Confirm"/"Cancel" replies for pending actions BEFORE command routing.
// North Star: clear confirmations, local-time echo, tolerant fallbacks, auditability.

const pg = require('../services/postgres');

function xmlMsg(s = '') {
  const esc = String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<Response><Message>${esc}</Message></Response>`;
}
const digits = (s='') => String(s || '').replace(/\D/g, '');

const ALLOWED_TYPES = new Set([
  'clock_in','clock_out','break_start','break_stop','drive_start','drive_stop',
]);

// Optional: simple debounce — ignore duplicate confirm within 2 seconds
function maybeDebounce(req, res) {
  try {
    if (!req?.session) return false;
    const key = `pending:${digits(req.profile?.ownerId || req.ownerId)}:${req.profile?.from || req.from}`;
    const now = Date.now();
    if (req.session[key] && (now - req.session[key]) < 2000) {
      res.status(200).type('application/xml').send(xmlMsg('Processing…'));
      return true;
    }
    req.session[key] = now;
  } catch {}
  return false;
}

function toHumanTime(ts, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
  return f.format(new Date(ts)).replace(' AM','am').replace(' PM','pm');
}
function toHumanDate(ts, tz) {
  const { formatInTimeZone } = require('date-fns-tz');
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
    case 'break_start': return 'started his break';
    case 'break_stop':  return 'ended his break';
    case 'drive_start': return 'started driving';
    case 'drive_stop':  return 'stopped driving';
    default:            return type.replace('_',' ');
  }
}
function humanLine(type, target, ts, tz) {
  return `${target} ${humanVerb(type)} ${toHumanTime(ts, tz)} on ${toHumanDate(ts, tz)}`;
}

async function pendingActionMiddleware(req, res, next) {
  try {
    const text = (req.body?.Body || '').trim();
    if (!/^(confirm|cancel|no)$/i.test(text)) return next();

    if (maybeDebounce(req, res)) return; // fast exit on immediate dup

    const from    = req.profile?.from || req.userProfile?.from || req.from;
    const ownerId = digits(req.profile?.ownerId || req.userProfile?.ownerId || req.ownerId || '');
    const tz      = req.profile?.tz || req.userProfile?.tz || 'America/Toronto';
    if (!from || !ownerId) return next();

    const pending = await pg.getPendingAction({ ownerId, userId: from });
    if (!pending) return next();

    // Cancel
    if (/^(cancel|no)$/i.test(text)) {
      await pg.deletePendingAction(pending.id).catch(() => {});
      console.info('[pending] cancelled', { id: pending.id, ownerId, from });
      return res.status(200).type('application/xml').send(xmlMsg('Backfill cancelled.'));
    }

    // Confirm
    let raw = pending.payload;
    if (raw == null) raw = {};
    const payload = (typeof raw === 'string') ? JSON.parse(raw || '{}') : raw;

    // Branch: MOVE LAST LOG
    if (pending.kind === 'move_last_log') {
      const target  = payload?.target;   // employee name (e.g., "Justin")
      const jobName = payload?.jobName;
      if (!target || !jobName) {
        await pg.deletePendingAction(pending.id).catch(()=>{});
        return res.status(200).type('application/xml').send(xmlMsg('Move failed — missing data.'));
      }

      // Resolve/create target job by name against legacy jobs table (job_no)
      const j = await pg.ensureJobByName(ownerId, jobName); // returns { job_no, name, is_active }
      const jobNo = j?.job_no;

      // Update the employee's most recent time_entries row to that job_no
      const upd = await pg.query(
        `UPDATE public.time_entries t
            SET job_no = $1
          WHERE t.id = (
            SELECT id FROM public.time_entries
             WHERE owner_id=$2 AND lower(employee_name)=lower($3)
             ORDER BY timestamp DESC
             LIMIT 1
          )
          RETURNING id, type, timestamp`,
        [jobNo, ownerId, String(target)]
      );

      await pg.deletePendingAction(pending.id).catch(()=>{});

      if (!upd.rowCount) {
        return res.status(200).type('application/xml')
          .send(xmlMsg(`No recent entry found for ${target}.`));
      }

      const moved = upd.rows[0];
      const day = new Date(moved.timestamp).toISOString().slice(0,10);
      // Touch KPI day (job_id nullable in your table; day still helps worker)
      try { await pg.enqueueKpiTouch(ownerId, null, day); } catch {}

      return res.status(200).type('application/xml')
        .send(xmlMsg(`✅ Moved last ${String(moved.type).replace('_',' ')} (${day}) to "${j.name}".`));
    }

    // Branch: BACKFILL TIME
    if (pending.kind === 'backfill_time') {
      const target     = payload?.target;
      const type       = payload?.type;
      const tsOverride = payload?.tsOverride || null;
      const jobName    = payload?.jobName || null;

      if (!target || !type || !ALLOWED_TYPES.has(String(type)) || !tsOverride) {
        await pg.deletePendingAction(pending.id).catch(() => {});
        return res.status(200).type('application/xml').send(xmlMsg('This confirmation is no longer valid.'));
      }

      await pg.logTimeEntryWithJob(
        ownerId,
        target,
        type,
        tsOverride,
        jobName,
        tz,
        { requester_id: from }
      );

      await pg.deletePendingAction(pending.id).catch(() => {});
      console.info('[pending] applied', { id: pending.id, ownerId, from, type, target, tsOverride, jobName });

      const line = humanLine(type, target, tsOverride, tz);
      return res.status(200).type('application/xml').send(xmlMsg(`✅ ${line} (backfilled).`));
    }

    // Unknown kind → clear and move on
    await pg.deletePendingAction(pending.id).catch(() => {});
    return res.status(200).type('application/xml').send(xmlMsg('Confirmation cleared.'));

  } catch (e) {
    console.error('[pending] error', e?.message);
    return res.status(200).type('application/xml').send(xmlMsg('Couldn’t apply the action. Try again.'));
  }
}

module.exports = { pendingActionMiddleware };
