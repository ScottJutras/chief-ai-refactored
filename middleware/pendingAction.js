// middleware/pendingAction.js
// Handles simple "Confirm"/"Cancel" replies for pending actions BEFORE command routing.
// North Star: clear confirmations, local-time echo, tolerant fallbacks, auditability.

const pg = require('../services/postgres');

function xmlMsg(s = '') {
  const esc = String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<Response><Message>${esc}</Message></Response>`;
}

async function pendingActionMiddleware(req, res, next) {
  try {
    const text = (req.body?.Body || '').trim();

    // Only handle trivial confirms/cancels so we don't swallow real commands.
    if (!/^(confirm|cancel|no)$/i.test(text)) return next();

    // Normalize identity (support both older req.profile and current router fields)
    const from    = req.profile?.from || req.userProfile?.from || req.from;
    const ownerId = req.profile?.ownerId || req.userProfile?.ownerId || req.ownerId;
    const tz      = req.profile?.tz || req.userProfile?.tz || 'America/Toronto';

    if (!from || !ownerId) return next();

    const pending = await pg.getPendingAction({ ownerId, userId: from });
    if (!pending) return next(); // nothing to apply

    const isCancel = /^(cancel|no)$/i.test(text);
    if (isCancel) {
      await pg.deletePendingAction(pending.id).catch(() => {});
      console.info('[pending] cancelled', { id: pending.id, ownerId, from });
      return res.status(200).type('application/xml').send(xmlMsg('Backfill cancelled.'));
    }

    // Confirm path
    const payload = JSON.parse(pending.payload || '{}');
    const { target, type, tsOverride, jobName } = payload;

    await pg.logTimeEntryWithJob(
      ownerId,
      target,
      type,
      tsOverride,
      jobName || null,
      tz,
      { requester_id: from }
    );

    await pg.deletePendingAction(pending.id).catch(() => {});
    console.info('[pending] applied', { id: pending.id, ownerId, from, type, target, tsOverride, jobName });

    const whenLocal = new Date(tsOverride).toLocaleString('en-CA', { timeZone: tz, hour12: false });
    return res.status(200).type('application/xml')
      .send(xmlMsg(`✅ ${target} ${String(type || '').replace('_',' ')} at ${whenLocal} (backfilled).`));
  } catch (e) {
    console.error('[pending] error', e?.message);
    return res.status(200).type('application/xml')
      .send(xmlMsg('Couldn’t apply the backfill. Try again.'));
  }
}

module.exports = { pendingActionMiddleware };
