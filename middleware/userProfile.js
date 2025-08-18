// middleware/userProfile.js
const {
  getUserProfile,
  getOwnerProfile,
  createUserProfile,
} = require('../services/postgres');

/**
 * Normalize a Twilio "From" into digits-only.
 * Handles values like "whatsapp:+19051234567" or "+19051234567".
 */
function normalizePhoneNumber(raw = '') {
  const v = String(raw || '');
  const withoutWa = v.startsWith('whatsapp:') ? v.slice('whatsapp:'.length) : v;
  return withoutWa.replace(/\D/g, ''); // strip all non-digits
}

function maskPhone(p) {
  return p ? p.replace(/^(\d{4})\d+(\d{2})$/, '$1…$2') : '';
}

async function userProfileMiddleware(req, res, next) {
  try {
    const { From } = req.body || {};
    const rawFrom = req.from || From;

    if (!rawFrom) {
      console.error('[userProfile] Missing From');
      return res
        .status(200)
        .send('<Response><Message>⚠️ Invalid request: missing sender.</Message></Response>');
    }

    // Keep req.from normalized for all downstream code (and consistent with lock key)
    const from = normalizePhoneNumber(rawFrom);
    req.from = from;

    // Fetch or create the user profile
    let user = await getUserProfile(from);
    if (!user) {
      user = await createUserProfile(from);
    }

    // Derive owner context
    const ownerId = user.owner_id || user.user_id || from;
    const ownerProfile = await getOwnerProfile(ownerId).catch(() => null);
    const isOwner = user.user_id === ownerId;

    // Attach to request for all handlers
    req.userProfile = user;
    req.ownerId = ownerId;
    req.ownerProfile = ownerProfile;
    req.isOwner = isOwner;

    console.log('[userProfile] OK for', maskPhone(from));
    return next();
  } catch (err) {
    console.error('[userProfile] failed:', err?.message);
    return next(err);
  }
}

module.exports = {
  userProfileMiddleware,
  normalizePhoneNumber, // exported in case other modules want it
};
