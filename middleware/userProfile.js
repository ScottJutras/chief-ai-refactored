const { getUserProfile, getOwnerProfile, createUserProfile, saveUserProfile } = require('../services/postgres');
const { clearUserState } = require('../utils/stateManager');
const { logError } = require('./error');

// Treat the profile as "incomplete" if any of these are empty/null/undefined
// Adjust the field names to match your schema if needed.
const REQUIRED_PROFILE_FIELDS = ['user_id', 'phone']; // Add/adjust keys you consider mandatory

function isBlank(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

function isProfileIncomplete(profile) {
  if (!profile) return true;
  return REQUIRED_PROFILE_FIELDS.some(k => k in profile ? isBlank(profile[k]) : true);
}

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
    } else if (isProfileIncomplete(userProfile)) {
      // Force reset onboarding if profile is incomplete (e.g., phone deleted)
      userProfile.onboarding_in_progress = true;
      userProfile.onboarding_completed = false;
      await saveUserProfile(userProfile);
      await clearUserState(from).catch(() => {}); // Clear any lingering state, ignore errors
      console.log('[INFO] Reset onboarding for incomplete profile', from);
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