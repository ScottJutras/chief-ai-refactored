// middleware/pendingAction.js
// Handles simple "Confirm"/"Cancel" replies for pending actions BEFORE command routing.
// North Star: clear confirmations, local-time echo, tolerant fallbacks, auditability.

const pg = require('../services/postgres');

function xmlMsg(s = '') {
  const esc = String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<Response><Message>${esc}</Message></Response>`;
}

function digits(s = '') {
  return String(s || '').replace(/\D/g, '');
}

const ALLOWED_TYPES = new Set([
  'clock_in',
  'clock_out',
  'break_start',
  'break_stop',
  'drive_start',
  'drive_stop',
]);

async function pendingActionMiddleware(req, res, next) {
  try {
    const text = (req.body?.Body || '').trim();

    // Only handle trivial confirms/cancels so we don't swallow real commands.
    if (!/^(confirm|cancel|no)$/i.test(text)) return next();

    // Normalize identity (support both older req.profile and current router fields)
    const fromRaw = req.profile?.from || req.userProfile?.from || req.from || null; // userId as-is
    const ownerId = digits(req.profile?.ownerId || req.userProfile?.ownerId || req.ownerId || '');
    const tz      = req.profile?.tz || req.userProfile?.tz || 'America/Toronto';

    if (!fromRaw || !ownerId) return next();

    const pending = await pg.getPendingAction({ ownerId, userId: fromRaw });
    if (!pending) return next(); // nothing to apply

    const isCancel = /^(cancel|no)$/i.test(text);
    if (isCancel) {
      await pg.deletePendingAction(pending.id).catch(() => {});
      console.info('[pending] cancelled', { id: pending.id, ownerId, from: fromRaw });
      return res.status(200).type('application/xml').send(xmlMsg('Backfill cancelled.'));
    }

    // ---- CONFIRM path ----
    // payload may come from jsonb (object) OR text (string). Handle both.
    let raw = pending.payload;
    if (raw == null) raw = {};
    const payload = (typeof raw === 'string') ? JSON.parse(raw || '{}') : raw;

    const target     = payload?.target;
    const type       = payload?.type;
    const tsOverride = payload?.tsOverride || null;
    const jobName    = payload?.jobName || null;

    // Validate payload
    if (!target || !type || !ALLOWED_TYPES.has(String(type))) {
      console.warn('[pending] invalid payload', { id: pending.id, ownerId, from: fromRaw, payload });
      await pg.deletePendingAction(pending.id).catch(() => {});
      console.info('[pending] invalid -> cleared', { id: pending.id });
      return res.status(200).type('application/xml')
        .send(xmlMsg('Backfill failed — invalid confirmation payload.'));
    }

    // Apply the backfill entry
    await pg.logTimeEntryWithJob(
      ownerId,
      target,
      type,
      tsOverride,
      jobName,
      tz,
      { requester_id: fromRaw }
    );

    await pg.deletePendingAction(pending.id).catch(() => {});
    console.info('[pending] applied', { id: pending.id, ownerId, from: fromRaw, type, target, tsOverride, jobName });

    const whenLocal = tsOverride
      ? new Date(tsOverride).toLocaleString('en-CA', { timeZone: tz, hour12: false })
      : new Date().toLocaleString('en-CA', { timeZone: tz, hour12: false });

    return res
      .status(200)
      .type('application/xml')
      .send(xmlMsg(`✅ ${target} ${String(type).replace('_', ' ')} at ${whenLocal} (backfilled).`));
  } catch (e) {
    console.error('[pending] error', e?.message);
    return res
      .status(200)
      .type('application/xml')
      .send(xmlMsg('Couldn’t apply the backfill. Try again.'));
  }
}

module.exports = { pendingActionMiddleware };
