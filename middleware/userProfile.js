const { db, admin } = require('../services/firebase');
const { getUserProfile, saveUserProfile } = require('../legacy/googleSheetsnewer');
const { getOwnerFromTeamMember } = require('../services/team');

/**
 * Normalizes a phone number by removing 'whatsapp:' and leading '+'.
 * @param {string} phone - The raw phone number.
 * @returns {string} The normalized phone number.
 */
function normalizePhoneNumber(phone) {
  return phone
    .replace(/^whatsapp:/i, '')
    .replace(/^\+/, '')
    .trim();
}

/**
 * Fetches a user profile with retry logic to handle transient failures.
 * @param {string} from - The normalized phone number.
 * @param {number} [retries=3] - Number of retries.
 * @param {number} [delay=100] - Delay between retries in milliseconds.
 * @returns {Promise<Object|null>} The user profile or null if not found.
 */
async function getUserProfileWithRetry(from, retries = 3, delay = 100) {
  for (let i = 0; i < retries; i++) {
    const profile = await getUserProfile(from);
    if (profile) return profile;
    console.log(`[RETRY] Attempt ${i + 1} to fetch profile for ${from}`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  return null;
}

/**
 * Middleware to load user and owner profiles, creating new profiles if needed.
 * @param {Object} req - The Express request object.
 * @param {Object} res - The Express response object.
 * @param {Function} next - The next middleware function.
 */
async function userProfileMiddleware(req, res, next) {
  const rawPhone = req.body.From || 'UNKNOWN_FROM';
  const from = normalizePhoneNumber(rawPhone);
  const lockKey = `lock:${from}`;

  try {
    let userProfile = await getUserProfileWithRetry(from);
    const ownerInfo = await getOwnerFromTeamMember(from);
    let ownerId = userProfile?.ownerId || from;
    const isOwner = !ownerInfo || ownerId === from;
    const ownerProfile = isOwner ? userProfile : await getUserProfileWithRetry(ownerId);

    // Handle new users or team members
    if (!userProfile && !ownerInfo) {
      const countryCode = from.slice(0, 2);
      const areaCode = from.slice(2, 5);
      const areaCodeMap = { '416': { country: 'Canada', province: 'Ontario' } };
      const location = countryCode === '+1' && areaCodeMap[areaCode] ? areaCodeMap[areaCode] : { country: 'Canada', province: 'Ontario' };
      await db.runTransaction(async (transaction) => {
        const userRef = db.collection('users').doc(from);
        transaction.set(userRef, {
          user_id: from,
          created_at: new Date().toISOString(),
          onboarding_in_progress: true,
          teamMembers: [],
          country: location.country,
          province: location.province,
          subscription_tier: 'basic'
        }, { merge: true });
      });
      console.log(`[✅] Initial user profile created for ${from} with auto-detected ${location.country}/${location.province}`);
      userProfile = await getUserProfileWithRetry(from);
      if (!userProfile) {
        console.error(`[ERROR] Failed to fetch profile for ${from} after creation`);
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (profile creation failure)`);
        return res.send(`<Response><Message>⚠️ Failed to create user profile. Please try again.</Message></Response>`);
      }
      ownerId = from;
    } else if (ownerInfo && !userProfile) {
      await db.runTransaction(async (transaction) => {
        const userRef = db.collection('users').doc(from);
        transaction.set(userRef, {
          user_id: from,
          created_at: new Date().toISOString(),
          onboarding_in_progress: true,
          isTeamMember: true,
          ownerId: ownerInfo.ownerId
        }, { merge: true });
      });
      userProfile = await getUserProfileWithRetry(from);
      if (!userProfile) {
        console.error(`[ERROR] Failed to fetch user profile for team member ${from} after creation`);
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Released lock for ${from} (team member profile fetch failure)`);
        return res.send(`<Response><Message>⚠️ Failed to create team member profile. Please try again.</Message></Response>`);
      }
    }

    // Set request properties for downstream handlers
    req.from = from;
    req.userProfile = userProfile;
    req.ownerId = ownerId;
    req.isOwner = isOwner;
    req.ownerProfile = ownerProfile;

    next();
  } catch (error) {
    console.error(`[ERROR] User profile middleware failed for ${from}:`, error.message);
    await db.collection('locks').doc(lockKey).delete();
    console.log(`[LOCK] Released lock for ${from} (error)`);
    return res.send(`<Response><Message>⚠️ An error occurred. Please try again later.</Message></Response>`);
  }
}

module.exports = { userProfileMiddleware, normalizePhoneNumber, getUserProfileWithRetry };