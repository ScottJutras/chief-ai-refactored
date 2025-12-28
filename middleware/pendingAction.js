// middleware/pendingAction.js
// Handles confirm/cancel replies + pending nudge BEFORE command routing.

const pg = require('../services/postgres');

function xmlMsg(s = '') {
  const esc = String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<Response><Message>${esc}</Message></Response>`;
}

const digits = (s = '') => String(s || '').replace(/\D/g, '');

// Allow hard commands while pending (but nudge)
function looksHardCommand(lc) {
  return (
    /^(create|new)\s+job\b/.test(lc) ||
    /^(jobs|list jobs|show jobs)\b/.test(lc) ||
    /^active\s+job\b/.test(lc) ||
    /^set\s+active\b/.test(lc) ||
    /^switch\s+job\b/.test(lc) ||
    /^task\b/.test(lc) ||
    /^my\s+tasks\b/.test(lc) ||
    /^team\s+tasks\b/.test(lc) ||
    /^done\s*#?\d+/.test(lc) ||
    /^clock\b/.test(lc) ||
    /^break\b/.test(lc) ||
    /^drive\b/.test(lc) ||
    /^expense\b/.test(lc) ||
    /^revenue\b/.test(lc)
  );
}

function pendingNudgeMessage(pending) {
  const kind = pending.kind || 'entry';

  let preview = '';
  try {
    const raw = pending.payload;
    const payload = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {};
    preview = payload?.preview || payload?.text || payload?.taskTitle || payload?.title || '';
  } catch {}

  const line = preview
    ? `It looks like you still have a pending ${kind}: ${preview}`
    : `It looks like you still have a pending ${kind}.`;

  return `${line}

Reply:
- "yes" to submit
- "edit" to change it
- "cancel" to discard

Or reply "skip" to leave it pending and continue.`;
}

// Serverless-ish debounce (best-effort)
const _debounce = new Map();
function maybeDebounce(ownerId, from, res) {
  const key = `pending:${digits(ownerId)}:${digits(from)}`;
  const now = Date.now();
  const last = _debounce.get(key) || 0;
  if (now - last < 2000) {
    res.status(200).type('application/xml').send(xmlMsg('Processing…'));
    return true;
  }
  _debounce.set(key, now);
  return false;
}

const ALLOWED_TYPES = new Set(['clock_in', 'clock_out', 'break_start', 'break_stop', 'drive_start', 'drive_stop']);

function toHumanTime(ts, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
  return f.format(new Date(ts)).replace(' AM', 'am').replace(' PM', 'pm');
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
    case 'clock_in':
      return 'clocked in';
    case 'clock_out':
      return 'clocked out';
    case 'break_start':
      return 'started his break';
    case 'break_stop':
      return 'ended his break';
    case 'drive_start':
      return 'started driving';
    case 'drive_stop':
      return 'stopped driving';
    default:
      return type.replace('_', ' ');
  }
}
function humanLine(type, target, ts, tz) {
  return `${target} ${humanVerb(type)} ${toHumanTime(ts, tz)} on ${toHumanDate(ts, tz)}`;
}

async function pendingActionMiddleware(req, res, next) {
  try {
    const textRaw = (req.body?.Body || '').trim();
    const lc = textRaw.toLowerCase();

    if (lc === 'skip') return next();

    const from = digits(req.from || req.userProfile?.from || req.userProfile?.user_id || '');
    const ownerId = digits(req.ownerId || req.userProfile?.ownerId || req.userProfile?.owner_id || '');
    const tz = req.userProfile?.tz || 'America/Toronto';
    if (!from || !ownerId) return next();

    const pending = await pg.getPendingAction({ ownerId, userId: from });
    if (!pending) return next();

    const isConfirm = /^(yes|confirm)$/i.test(textRaw);
    const isCancel = /^(cancel|no)$/i.test(textRaw);
    const isEdit = /^edit$/i.test(textRaw);

    if (!isConfirm && !isCancel && !isEdit && looksHardCommand(lc)) {
      return res.status(200).type('application/xml').send(xmlMsg(pendingNudgeMessage(pending)));
    }

    if (isEdit) return next();
    if (!isConfirm && !isCancel) return next();

    if (maybeDebounce(ownerId, from, res)) return;

    // Cancel
    if (isCancel) {
      await pg.deletePendingAction(pending.id).catch(() => {});
      return res.status(200).type('application/xml').send(xmlMsg('✅ Cancelled.'));
    }

    // Confirm
    let raw = pending.payload;
    if (raw == null) raw = {};
    const payload = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;

    // MOVE LAST LOG
    if (pending.kind === 'move_last_log') {
      const target = payload?.target;
      const jobName = payload?.jobName;
      if (!target || !jobName) {
        await pg.deletePendingAction(pending.id).catch(() => {});
        return res.status(200).type('application/xml').send(xmlMsg('Move failed — missing data.'));
      }

      // Keep logic centralized
      const moved = await pg.moveLastLogToJob(ownerId, target, jobName).catch(() => null);

      await pg.deletePendingAction(pending.id).catch(() => {});

      if (!moved) {
        return res.status(200).type('application/xml').send(xmlMsg(`No recent entry found for ${target}.`));
      }

      const day = new Date(moved.timestamp).toISOString().slice(0, 10);
      try {
        await pg.enqueueKpiTouch(ownerId, null, day);
      } catch {}

      return res
        .status(200)
        .type('application/xml')
        .send(xmlMsg(`✅ Moved last ${String(moved.type).replace('_', ' ')} (${day}) to "${jobName}".`));
    }

    // BACKFILL TIME
    if (pending.kind === 'backfill_time') {
      const target = payload?.target;
      const type = payload?.type;
      const tsOverride = payload?.tsOverride || null;
      const jobName = payload?.jobName || null;

      if (!target || !type || !ALLOWED_TYPES.has(String(type)) || !tsOverride) {
        await pg.deletePendingAction(pending.id).catch(() => {});
        return res.status(200).type('application/xml').send(xmlMsg('This confirmation is no longer valid.'));
      }

      await pg.logTimeEntryWithJob(ownerId, target, type, tsOverride, jobName, tz, { requester_id: from });

      await pg.deletePendingAction(pending.id).catch(() => {});
      const line = humanLine(type, target, tsOverride, tz);
      return res.status(200).type('application/xml').send(xmlMsg(`✅ ${line} (backfilled).`));
    }

    // Unknown kind
    await pg.deletePendingAction(pending.id).catch(() => {});
    return res.status(200).type('application/xml').send(xmlMsg('Confirmation cleared.'));
  } catch (e) {
    console.error('[pending] error', e?.message);
    return res.status(200).type('application/xml').send(xmlMsg('Couldn’t apply the action. Try again.'));
  }
}

module.exports = { pendingActionMiddleware };
