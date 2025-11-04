// middleware/userProfile.js
const { getUserBasic, createUserProfile, getOwnerProfile } = require('../services/postgres');

function normalizeFrom(raw) {
  return String(raw || '').replace(/^whatsapp:/i, '').replace(/\D/g, '') || null;
}
function shapeProfile(p, from) {
  const user_id  = p?.user_id || p?.id || from;
  const owner_id = p?.owner_id || p?.ownerId || user_id;
  const plan = (p?.plan || p?.subscription_tier || 'free').toLowerCase();
  return {
    user_id,
    owner_id,
    ownerId: owner_id,
    phone: p?.phone || user_id,
    name: p?.name || p?.display_name || null,
    subscription_tier: plan,
    plan,
    onboarding_in_progress: Boolean(p?.onboarding_in_progress || p?.onboardingPending || false),
    ...p,
  };
}

async function userProfileMiddleware(req, _res, next) {
  try {
    const from = normalizeFrom(req.body?.From || req.from);
    req.from = from;
    req.ownerId = req.ownerId || from || 'GLOBAL';

    if (!from) {
      req.userProfile = null;
      req.ownerProfile = null;
      req.isOwner = false;
      return next();
    }

    // Load or create the user
    let profile = await getUserBasic(from);
    if (!profile) {
      profile = await createUserProfile({
        user_id: from,
        ownerId: from,
        onboarding_in_progress: true,
      });
      console.log('[userProfile] created new user', from);
    }
    profile = shapeProfile(profile, from);

    // Also fetch the owner profile (your handlers receive this)
    let ownerProfile = null;
    try { ownerProfile = await getOwnerProfile(req.ownerId); }
    catch (e) { console.warn('[userProfile] getOwnerProfile failed:', e?.message); }
    if (ownerProfile) ownerProfile = shapeProfile(ownerProfile, req.ownerId);

    req.userProfile = profile;
    req.ownerProfile = ownerProfile;
    req.isOwner = profile.user_id === req.ownerId;

    if (profile.onboarding_in_progress) {
      console.log('[userProfile] onboarding pending for', from);
      // (Optional) short-circuit to onboarding flow here
    }

    return next();
  } catch (e) {
    console.warn('[userProfile] failed:', e?.message);
    return next();
  }
}

module.exports = { userProfileMiddleware };
