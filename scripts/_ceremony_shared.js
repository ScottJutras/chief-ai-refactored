/**
 * Ceremony-only shared utility for deterministic share_token derivation.
 *
 * DO NOT import from production code. Production share_tokens use
 * crypto.randomBytes (see generateShareToken in src/cil/quotes.js) because
 * production tokens must be unpredictable (security property). Ceremony
 * tokens use deterministic hash derivation because ceremonies must be
 * reproducible (forensic property — §27/§28 identity tables cite exact
 * share_token values).
 *
 * Addresses §17.22 recurrence in ceremony infrastructure: hand-rolled
 * bs58-encoded SHA-256 output has ~2.83% probability of producing 21
 * chars instead of 22. This helper mirrors production's bounded-retry
 * discipline, but uses deterministic seed iteration (seedString,
 * seedString#retry1, seedString#retry2, ...) instead of random bytes.
 */

const crypto = require('crypto');
let bs58;
try {
  bs58 = require('bs58').default || require('bs58');
} catch (_) {
  bs58 = null;
}

/**
 * Derive a deterministic 22-char base58 share_token from a seed string.
 *
 * Iterates deterministically: hashes `seedString`; if the encoded output
 * isn't 22 chars (the ~2.83% short-output case), hashes
 * `${seedString}#retry1`, then `${seedString}#retry2`, ... up to
 * `maxAttempts`. First 22-char output wins.
 *
 * Same `seedString` always produces the same output — ceremony artifacts
 * can cite specific token values with confidence.
 *
 * @param {string} seedString — non-empty seed string (ceremony identifier)
 * @param {number} [maxAttempts=20] — retry bound, mirrors production's
 *                                    generateShareToken 20-iteration bound
 * @returns {string} 22-char base58 token
 * @throws if bs58 is not installed, or seedString is empty, or no 22-char
 *         output found within maxAttempts iterations
 */
function deriveDeterministicShareToken(seedString, maxAttempts = 20) {
  if (!bs58) {
    throw new Error('[ceremony-shared] bs58 module not available');
  }
  if (typeof seedString !== 'string' || seedString.length === 0) {
    throw new Error('[ceremony-shared] seedString must be a non-empty string');
  }
  for (let i = 0; i < maxAttempts; i++) {
    const input = i === 0 ? seedString : `${seedString}#retry${i}`;
    const digest = crypto.createHash('sha256').update(input).digest().subarray(0, 16);
    const encoded = bs58.encode(digest);
    if (encoded.length === 22) return encoded;
  }
  throw new Error(
    `[ceremony-shared] deriveDeterministicShareToken: no 22-char output within ${maxAttempts} attempts for seed ${JSON.stringify(seedString)}`
  );
}

module.exports = {
  deriveDeterministicShareToken,
};
