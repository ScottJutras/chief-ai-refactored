// handlers/middleware/lock.js
// Shim to satisfy handlers that import "../middleware/lock".
// We already enforce per-user locking in routes/webhook.js,
// so these become safe no-ops.

async function acquireLock(/* lockKey, userId, token, ttlMs */) {
  // no-op: router already holds the lock
  return true;
}

async function releaseLock(/* lockKey, token */) {
  // no-op
  return true;
}

function lockMiddleware(req, res, next) {
  // no-op (router-level lockMiddleware is the real one)
  return next();
}

module.exports = { acquireLock, releaseLock, lockMiddleware };
