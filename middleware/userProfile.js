const { getUserProfile, createUserProfile, getOwnerProfile } = require('../services/postgres');

async function userProfileMiddleware(req, res, next) {
  console.log('[DEBUG] userProfileMiddleware invoked:', { from: req.body.From, timestamp: new Date().toISOString() });
  try {
    const rawFrom = req.body.From || 'UNKNOWN_FROM';
    const phoneNumber = rawFrom.replace(/\D/g, '');
    let userProfile = await getUserProfile(phoneNumber);
    if (!userProfile) {
      userProfile = await createUserProfile({
        phone: phoneNumber,
        ownerId: process.env.DEFAULT_OWNER_ID || phoneNumber,
        onboarding_in_progress: true
      });
      console.log('[INFO] Created new user profile for', phoneNumber);
    }
    req.userProfile = userProfile || { onboarding_completed: false, name: 'Unknown', country: 'Canada' };
    req.ownerId = userProfile.ownerId || phoneNumber;
    req.ownerProfile = await getOwnerProfile(req.ownerId) || {};
    req.isOwner = req.ownerProfile.ownerId === userProfile.ownerId;
    console.log('[DEBUG] userProfileMiddleware result:', { userProfile: req.userProfile });
    next();
  } catch (error) {
    console.error('[ERROR] userProfileMiddleware failed:', error.message);
    const phoneNumber = req.body.From ? req.body.From.replace(/\D/g, '') : 'UNKNOWN_FROM';
    req.userProfile = { onboarding_completed: false, name: 'Unknown', country: 'Canada' };
    req.ownerId = phoneNumber;
    req.ownerProfile = {};
    req.isOwner = true;
    console.log('[DEBUG] userProfileMiddleware fallback applied');
    next();
  }
}

module.exports = { userProfileMiddleware };
