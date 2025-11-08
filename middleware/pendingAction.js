// middleware/pendingAction.js
// Handles simple "Confirm"/"Cancel" replies for pending actions BEFORE command routing.
// North Star: clear confirmations, local-time echo, tolerant fallbacks, auditability.

const pg = require('../services/postgres');

function xmlMsg(s = '') {
  const esc = String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<Response><Message>${esc}</Message></Response>`;
}
function digits(s = '') { return String(s || '').replace(/\D/g, ''); }

const ALLOWED_TYPES = new Set([
  'clock_in','clock_out','break_start','break_stop','drive_start','drive_stop',
]);

function toHumanTime(ts, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
  return f.format(new Date(ts)).replace(' AM','am').replace(' PM','pm');
}
function toHumanDate(ts, tz) {
  const d = new Date(ts);
  // dd-MM-yyyy
  const { formatInTimeZone } = require('date-fns-tz');
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

    const from    = req.profile?.from || req.userProfile?.from || req.from;
    const ownerId = digits(req.profile?.ownerId || req.userProfile?.ownerId || req.ownerId || '');
    const tz      = req.profile?.tz || req.userProfile?.tz || 'America/Toronto';
    if (!from || !ownerId) return next();

    const pending = await pg.getPendingAction({ ownerId, userId: from });
    if (!pending) return next();

    const isCancel = /^(cancel|no)$/i.test(text);
    if (isCancel) {
      await pg.deletePendingAction(pending.id).catch(() => {});
      console.info('[pending] cancelled', { id: pending.id, ownerId, from });
      return res.status(200).type('application/xml').send(xmlMsg('Backfill cancelled.'));
    }

    // Confirm path
    let raw = pending.payload;
    if (raw == null) raw = {};
    const payload = (typeof raw === 'string') ? JSON.parse(raw || '{}') : raw;
    const { target, type, tsOverride, jobName } = payload;

    if (!ALLOWED_TYPES.has(type) || !target || !tsOverride) {
      await pg.deletePendingAction(pending.id).catch(() => {});
      return res.status(200).type('application/xml').send(xmlMsg('This confirmation is no longer valid.'));
    }

    await pg.logTimeEntryWithJob(
      ownerId, target, type, tsOverride, jobName || null, tz, { requester_id: from }
    );

    await pg.deletePendingAction(pending.id).catch(() => {});
    console.info('[pending] applied', { id: pending.id, ownerId, from, type, target, tsOverride, jobName });

    const line = humanLine(type, target, tsOverride, tz);
    return res.status(200).type('application/xml').send(xmlMsg(`✅ ${line} (backfilled).`));
  } catch (e) {
    console.error('[pending] error', e?.message);
    return res.status(200).type('application/xml').send(xmlMsg('Couldn’t apply the backfill. Try again.'));
  }
}

module.exports = { pendingActionMiddleware };
