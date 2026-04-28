// scripts/_phase_a_session3_constants.js
// Phase A Session 3 LockQuote ceremony identity — frozen inputs for all
// ceremony scripts. Idempotency depends on these being fixed across reruns.
//
// Namespace: 'c5c5-c5c5-c5c5' hex group distinguishes Phase A Session 3
// ceremony rows from Phase A Session 2's 'c4c4-c4c4-c4c4' and Phase 3's
// 'c3c3-c3c3-c3c3'.
//
// LockQuote ceremony does not customer-serve (LockQuote is system-only in
// Phase A per `src/cil/quotes.js` LockQuoteActorZ z.literal('system')); the
// share_token here anchors the pre-existing lifecycle.sent synthetic event
// chain — it is NOT presented to a recipient during the ceremony.

const { deriveDeterministicShareToken } = require('./_ceremony_shared');

const CEREMONY_TENANT_ID        = '00000000-c5c5-c5c5-c5c5-000000000001';
const CEREMONY_OWNER_ID         = '00000000003';  // distinct from §27's 001 and §28's 002
const CEREMONY_QUOTE_ID         = '00000000-c5c5-c5c5-c5c5-000000000002';
const CEREMONY_VERSION_ID       = '00000000-c5c5-c5c5-c5c5-000000000003';
const CEREMONY_SHARE_TOKEN_ID   = '00000000-c5c5-c5c5-c5c5-000000000005';
const CEREMONY_SENT_EVENT_ID    = '00000000-c5c5-c5c5-c5c5-000000000007';
const CEREMONY_SIGNED_EVENT_ID  = '00000000-c5c5-c5c5-c5c5-000000000008';
const CEREMONY_SIGNATURE_ID     = '00000000-c5c5-c5c5-c5c5-000000000009';
const CEREMONY_LINE_ITEM_ID    = '00000000-c5c5-c5c5-c5c5-0000000000a1';

const CEREMONY_HUMAN_ID        = 'QT-CEREMONY-2026-04-24-PHASE-A-S3';
const CEREMONY_PROJECT_TITLE   = 'Phase A Session 3 LockQuote Ceremony';
const CEREMONY_CUSTOMER_NAME   = 'Phase A Session 3 Ceremony Customer';
const CEREMONY_RECIPIENT_EMAIL = 'phase-a-s3-ceremony@chiefos.invalid';

// Deterministic share_token via shared ceremony helper. Bounded retry
// closes the §17.22 short-output footgun (Session 2 v2 iteration lesson).
const CEREMONY_SHARE_TOKEN = deriveDeterministicShareToken(
  'chiefos-phase-a-session-3-lockquote-ceremony-share-token-seed'
);

// Synthetic signature-image metadata. Ceremony does NOT exercise the storage
// pipeline (that's §26/§27 scope) — the signature row anchors the signed
// state's existence. storage_key matches chiefos_qs_png_storage_key_format
// CHECK (Migration 6) — byte-identical with SIGNATURE_STORAGE_KEY_RE in
// src/cil/quoteSignatureStorage.js. Shape:
//   chiefos-signatures/{tenant_uuid}/{quote_uuid}/{version_uuid}/{signature_uuid}.png
// No bucket upload performed — this is schema-satisfying text only.
const CEREMONY_SIGNATURE_STORAGE_KEY =
  `chiefos-signatures/${CEREMONY_TENANT_ID}/${CEREMONY_QUOTE_ID}/${CEREMONY_VERSION_ID}/${CEREMONY_SIGNATURE_ID}.png`;
// 64-char lowercase hex — must match ^[0-9a-f]{64}$
// (non-hex chars like 'r','m','y' in "ceremony" fail chiefos_qs_sha256_format).
const CEREMONY_SIGNATURE_SHA256 =
  'c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5';

module.exports = {
  CEREMONY_TENANT_ID,
  CEREMONY_OWNER_ID,
  CEREMONY_QUOTE_ID,
  CEREMONY_VERSION_ID,
  CEREMONY_SHARE_TOKEN_ID,
  CEREMONY_SENT_EVENT_ID,
  CEREMONY_SIGNED_EVENT_ID,
  CEREMONY_SIGNATURE_ID,
  CEREMONY_LINE_ITEM_ID,
  CEREMONY_HUMAN_ID,
  CEREMONY_PROJECT_TITLE,
  CEREMONY_CUSTOMER_NAME,
  CEREMONY_RECIPIENT_EMAIL,
  CEREMONY_SHARE_TOKEN,
  CEREMONY_SIGNATURE_STORAGE_KEY,
  CEREMONY_SIGNATURE_SHA256,
};
