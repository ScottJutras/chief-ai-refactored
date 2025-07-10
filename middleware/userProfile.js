const { getUserProfile, getOwnerProfile, createUserProfile } = require('../services/postgres');
const { logError } = require('./error');

async function userProfileMiddleware(req, res, next) {
  // Always pull the phone number from Twilio's 'From'
  const from = req.body.From ? req.body.From.replace(/\D/g, '') : '';
  console.log('[DEBUG] userProfileMiddleware invoked:', { from, timestamp: new Date().toISOString() });

  if (!from) {
    console.error('[ERROR] Missing From in request body');
    return res.status(400).send(`<Response><Message>⚠️ Invalid request: missing sender.</Message></Response>`);
  }

  try {
    let userProfile = await getUserProfile(from);
    let ownerId = from;

    if (!userProfile) {
      userProfile = await createUserProfile({ user_id: from, ownerId: from, onboarding_in_progress: true });
      console.log('[INFO] Created new user profile for', from);
    } else {
      ownerId = userProfile.owner_id || from;
    }

    const ownerProfile = await getOwnerProfile(ownerId);
    req.userProfile = userProfile;
    req.ownerId = ownerId;
    req.ownerProfile = ownerProfile;

    console.log('[DEBUG] userProfileMiddleware result:', { userProfile });
    next();
  } catch (error) {
    console.error('[ERROR] userProfileMiddleware failed:', error.message);
    await logError(from, error, 'userProfileMiddleware');
    res.status(500).send(`<Response><Message>⚠️ Failed to load your profile: ${error.message}</Message></Response>`);
  }
}

module.exports = { userProfileMiddleware };