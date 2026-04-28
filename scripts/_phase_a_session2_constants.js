// scripts/_phase_a_session2_constants.js
// Phase A Session 2 ViewQuote ceremony identity — frozen inputs for all
// ceremony scripts. Idempotency depends on these being fixed across reruns.
//
// Namespace: 'c4c4-c4c4-c4c4' hex group distinguishes Phase A Session 2
// ceremony rows from Phase 3's 'c3c3-c3c3-c3c3' and Phase 2C's 'c2c2-c2c2-c2c2'.

const { deriveDeterministicShareToken } = require('./_ceremony_shared');

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

// Deterministic share_token: via shared ceremony helper. Seed string `-v2`
// suffix is a historical marker (v1 derived to 21 chars — the §3.7 / §17.22
// short-output case — manually iterated during Section 6 implementation).
// With the shared helper's retry iteration, future ceremonies can use clean
// seed strings without the manual-iteration footgun.
const CEREMONY_SHARE_TOKEN = deriveDeterministicShareToken(
  'chiefos-phase-a-session-2-viewquote-ceremony-share-token-seed-v2'
);

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
