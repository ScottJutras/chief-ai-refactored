const { db, admin } = require('../services/firebase');

/**
 * Middleware to acquire a lock for a user to prevent concurrent WhatsApp requests.
 * @param {Object} req - The Express request object.
 * @param {Object} res - The Express response object.
 * @param {Function} next - The next middleware function.
 */
async function lockMiddleware(req, res, next) {
  const from = req.body.From ? req.body.From.replace(/\D/g, "") : 'unknown';
  const lockKey = `lock:${from}`;
  const retries = 5;
  const delay = 750;
  const ttlSeconds = 5;

  try {
    for (let i = 0; i < retries; i++) {
      const lockDoc = await db.collection('locks').doc(lockKey).get();
      if (!lockDoc.exists) {
        console.log(`[LOCK] Acquired lock for ${from}`);
        await db.collection('locks').doc(lockKey).set({
          locked: true,
          timestamp: new Date().toISOString(),
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        req.lockKey = lockKey; // Store lockKey for release
        return next();
      }

      const lockData = lockDoc.data();
      const lockTimestamp = new Date(lockData.timestamp);
      const ageSeconds = (Date.now() - lockTimestamp.getTime()) / 1000;
      if (ageSeconds > ttlSeconds) {
        console.log(`[LOCK] Deleting stale lock for ${from} (age: ${ageSeconds.toFixed(2)}s)`);
        await db.collection('locks').doc(lockKey).delete();
        console.log(`[LOCK] Acquired lock for ${from} after deleting stale lock`);
        await db.collection('locks').doc(lockKey).set({
          locked: true,
          timestamp: new Date().toISOString(),
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        req.lockKey = lockKey;
        return next();
      }

      console.log(`[LOCK] Retry ${i + 1} for ${from}: lock still held (age: ${ageSeconds.toFixed(2)}s)`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    console.log(`[LOCK] Failed to acquire lock for ${from} after ${retries} retries`);
    return res.send(`<Response><Message>I'm busy processing your previous request. Please try again in a moment!</Message></Response>`);
  } catch (error) {
    console.error(`[ERROR] Failed to acquire lock for ${from}:`, error.message);
    return res.send(`<Response><Message>⚠️ An error occurred. Please try again later.</Message></Response>`);
  }
}

/**
 * Releases a lock for a user after processing a request.
 * @param {string} lockKey - The lock key (e.g., 'lock:phoneNumber').
 */
async function releaseLock(lockKey) {
  try {
    await db.collection('locks').doc(lockKey).delete();
    console.log(`[LOCK] Released lock for ${lockKey}`);
  } catch (error) {
    console.error(`[ERROR] Failed to release lock for ${lockKey}:`, error.message);
  }
}

module.exports = { lockMiddleware, releaseLock };
