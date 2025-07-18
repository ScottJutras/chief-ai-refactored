const { getUserProfile, getOwnerProfile, createUserProfile } = require('../services/postgres');

// normalize and fetch/create user in Postgres
async function userProfileMiddleware(req, res, next) {
  let phone;
  if (req.body.From) {
    const rawFrom = req.body.From || '';
    phone = rawFrom.replace(/\D/g, '');
  } else if (req.params.userId) {
    phone = req.params.userId;
  } else {
    console.error('[ERROR] Missing sender in request');
    return res.status(400).send('Invalid Request: missing sender');
  }

  // Fetch existing profile
  let profile = await getUserProfile(phone);

  // If none, create and start onboarding
  if (!profile) {
    profile = await createUserProfile({
      user_id: phone,
      ownerId: process.env.DEFAULT_OWNER_ID || phone,
      onboarding_in_progress: true
    });
    console.log(`[INFO] Created new user profile for ${phone}`);
  }

  req.userProfile = profile;
  req.ownerId = profile.owner_id;
  req.ownerProfile = await getOwnerProfile(profile.owner_id);
  req.isOwner = req.ownerProfile.owner_id === profile.owner_id;

  next();
}

module.exports = { userProfileMiddleware };