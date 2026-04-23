// scripts/_phase_a_session2_constants.js
// Phase A Session 2 ViewQuote ceremony identity — frozen inputs for all
// ceremony scripts. Idempotency depends on these being fixed across reruns.
//
// Namespace: 'c4c4-c4c4-c4c4' hex group distinguishes Phase A Session 2
// ceremony rows from Phase 3's 'c3c3-c3c3-c3c3' and Phase 2C's 'c2c2-c2c2-c2c2'.

const crypto = require('crypto');
let bs58;
try {
  bs58 = require('bs58').default || require('bs58');
} catch (_) {
  bs58 = null;
}

const CEREMONY_TENANT_ID      = '00000000-c4c4-c4c4-c4c4-000000000001';
const CEREMONY_OWNER_ID       = '00000000002';  // distinct from §27's 00000000001
const CEREMONY_QUOTE_ID       = '00000000-c4c4-c4c4-c4c4-000000000002';
const CEREMONY_VERSION_ID     = '00000000-c4c4-c4c4-c4c4-000000000003';
const CEREMONY_SHARE_TOKEN_ID = '00000000-c4c4-c4c4-c4c4-000000000005';
const CEREMONY_SENT_EVENT_ID  = '00000000-c4c4-c4c4-c4c4-000000000007';
const CEREMONY_LINE_ITEM_ID   = '00000000-c4c4-c4c4-c4c4-0000000000a1';

const CEREMONY_HUMAN_ID        = 'QT-CEREMONY-2026-04-23-PHASE-A-S2';
const CEREMONY_PROJECT_TITLE   = 'Phase A Session 2 ViewQuote Ceremony';
const CEREMONY_CUSTOMER_NAME   = 'Phase A Session 2 Ceremony Customer';
const CEREMONY_RECIPIENT_EMAIL = 'phase-a-s2-ceremony@chiefos.invalid';

// Deterministic share_token: bs58-encoded SHA-256 of a versioned seed string,
// truncated to 16 bytes. bs58 produces 22 chars ≥97.2% of the time and 21
// chars ~2.83% (the §3.7 / §17.22 short-output case). Seed version iterated
// until output is exactly 22 chars — first valid seed becomes the frozen
// ceremony token. v1 was a 21-char short-output; v2 derives to 22.
function deriveShareToken() {
  if (!bs58) return null;
  const seed = crypto.createHash('sha256')
    .update('chiefos-phase-a-session-2-viewquote-ceremony-share-token-seed-v2')
    .digest()
    .subarray(0, 16);
  return bs58.encode(seed);
}
const CEREMONY_SHARE_TOKEN = deriveShareToken();

if (!CEREMONY_SHARE_TOKEN || CEREMONY_SHARE_TOKEN.length !== 22) {
  throw new Error(
    `[phase-a-s2-constants] share_token wrong length: ${
      CEREMONY_SHARE_TOKEN && CEREMONY_SHARE_TOKEN.length
    } (expected 22). bs58 not installed?`
  );
}

module.exports = {
  CEREMONY_TENANT_ID,
  CEREMONY_OWNER_ID,
  CEREMONY_QUOTE_ID,
  CEREMONY_VERSION_ID,
  CEREMONY_SHARE_TOKEN_ID,
  CEREMONY_SENT_EVENT_ID,
  CEREMONY_LINE_ITEM_ID,
  CEREMONY_HUMAN_ID,
  CEREMONY_PROJECT_TITLE,
  CEREMONY_CUSTOMER_NAME,
  CEREMONY_RECIPIENT_EMAIL,
  CEREMONY_SHARE_TOKEN,
};
