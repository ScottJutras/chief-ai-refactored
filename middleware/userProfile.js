const { getUserProfile, createUserProfile } = require('../services/postgres');
const { getOwnerProfile } = require('../services/postgres');

// normalize and fetch/create user in Postgres
async function userProfileMiddleware(req, res, next) {
  // 1) Normalize WhatsApp “From” to digits-only
  const rawFrom = req.body.From || '';
  const phone   = rawFrom.replace(/\D/g, '');

  // 2) Fetch existing profile
  let profile = await getUserProfile(phone);

  // 3) If none, create and start onboarding
  if (!profile) {
    profile = await createUserProfile({
      phone,
      ownerId: process.env.DEFAULT_OWNER_ID,
      onboarding_in_progress: true
    });
    console.log(`[INFO] Created new user profile for ${phone}`);
  }

  // 4) Attach to request
  req.userProfile   = profile;
  req.ownerId       = profile.ownerId;
  req.ownerProfile  = await getOwnerProfile(profile.ownerId);
  req.isOwner       = req.ownerProfile.ownerId === profile.ownerId;

  next();
}

module.exports = { userProfileMiddleware };
