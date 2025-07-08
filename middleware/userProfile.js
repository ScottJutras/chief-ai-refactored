// middleware/userProfile.js

const { db } = require('../services/firebase')

/**
 * Loads the current user's Firestore document (based on their phone),
 * then also loads the "owner" doc (for teams), and stamps req.isOwner.
 */
async function userProfileMiddleware(req, res, next) {
  const from       = req.body.From || ''
  const phone      = from.replace(/\D/g, '')
  let userDoc, ownerDoc

  try {
    // 1) load this user’s doc
    userDoc = await db.collection('users').doc(phone).get()
    req.userProfile = userDoc.exists ? userDoc.data() : {}

    // 2) determine ownerId (for team members, it’ll be set on their doc)
    req.ownerId = req.userProfile.ownerId || phone

    // 3) load the owner’s profile
    ownerDoc = await db.collection('users').doc(req.ownerId).get()
    req.ownerProfile = ownerDoc.exists ? ownerDoc.data() : {}

    // 4) is this request coming from the owner phone or a team‐member phone?
    req.isOwner = phone === req.ownerId

    return next()
  } catch (err) {
    console.error('userProfileMiddleware error:', err)
    return res
      .status(500)
      .send('⚠️ Failed to load user profile. Please try again.')
  }
}

module.exports = { userProfileMiddleware }
