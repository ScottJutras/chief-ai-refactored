// middleware/userProfile.js
const { getUserBasic, createUserProfile } = require('../services/postgres');

async function userProfileMiddleware(req, _res, next) {
  try {
    const raw = String(req.body?.From || req.from || '');
    const from = raw.replace(/^whatsapp:/i, '').replace(/\D/g, '');
    req.from = from || null;
    req.ownerId = req.ownerId || from || 'GLOBAL';

    if (!from) {
      req.userProfile = null;
      req.isOwner = false;
      return next();
    }

    let profile = await getUserBasic(from);
    if (!profile) {
      // First-time user → bootstrap
      profile = await createUserProfile({
        user_id: from,
        ownerId: from,
        onboarding_in_progress: true,
      });
      console.log('[userProfile] created new user', from);
    }

    req.userProfile = profile;
    req.isOwner = profile.user_id === req.ownerId;

    if (profile.onboarding_in_progress) {
      console.log('[userProfile] onboarding pending for', from);
      // Future: you can short-circuit to OTP flow here
    }

    next();
  } catch (e) {
    console.warn('[userProfile] failed:', e?.message);
    next();
  }
}
module.exports = { userProfileMiddleware };