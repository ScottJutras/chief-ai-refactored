// middleware/requirePhonePaired.js
//
// Gate requiring the portal user's WhatsApp phone is paired. Depends on
// req.isPhonePaired populated by middleware/requirePortalUser.js. Mount AFTER
// requirePortalUser on any route that needs an ingestion-capable caller.
//
// Returns 403 PHONE_LINK_REQUIRED with a copy hint per Engineering
// Constitution §9 error envelope. Not mounted globally — per-route product
// decision.

module.exports = function requirePhonePaired(req, res, next) {
  if (!req.isPhonePaired) {
    return res.status(403).json({
      ok: false,
      error: {
        code: 'PHONE_LINK_REQUIRED',
        message: 'This action requires a linked WhatsApp number.',
        hint: 'Open the portal and tap "Link my WhatsApp" to generate a pairing code.',
        traceId: req.traceId || null,
      },
    });
  }
  return next();
};
