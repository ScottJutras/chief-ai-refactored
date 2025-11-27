// services/owners.js
// Helper to map a WhatsApp phone number to an owner UUID (or fallback to digits)

const {
  DIGITS,
  getUserProfile,
  createUserProfile,
} = require('./postgres');

/**
 * Given a phone number (string, e.g. "whatsapp:+1 905-327-9955"),
 * return an owner_id (UUID or legacy digits).
 *
 * For now this is "lazy": if no profile exists, we create a provisional one
 * with owner_id = user_id = digits(phone).
 */
async function getOwnerUuidForPhone(rawPhone) {
  const userId = DIGITS(rawPhone);
  if (!userId) return null;

  // 1) Try existing profile
  let profile = await getUserProfile(userId);

  // If we already have an owner_id, use it
  if (profile && profile.owner_id) {
    return profile.owner_id;
  }

  // 2) No profile or no owner_id → create a provisional one
  try {
    profile = await createUserProfile({
      user_id: userId,
      ownerId: userId,              // owner = self for now
      onboarding_in_progress: true, // so onboarding flow can pick up
    });
  } catch (e) {
    console.warn('[owners] createUserProfile failed:', e?.message);
    // last resort: just return digits
    return userId;
  }

  return profile?.owner_id || userId;
}

module.exports = {
  getOwnerUuidForPhone,
};
