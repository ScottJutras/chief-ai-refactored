// scripts/_phase_a_session4_constants.js
// Phase A Session 4 VoidQuote ceremony identity — frozen inputs for all
// ceremony scripts. Idempotency depends on these being fixed across reruns.
//
// Namespace: 'c6c6-c6c6-c6c6' hex group distinguishes Phase A Session 4
// ceremony rows from Phase A Session 3's 'c5c5-c5c5-c5c5', Phase A Session 2's
// 'c4c4-c4c4-c4c4', and Phase 3's 'c3c3-c3c3-c3c3'.
//
// Source state for the ceremony: 'sent'.
// VoidQuote can fire from any of 5 prior states {draft, sent, viewed, signed,
// locked}; the ceremony picks ONE representative state. 'sent' is chosen
// because it is the most operationally common void source (a quote was sent
// to a customer and rejected/superseded), exercises the §17.23 single-event
// happy path without needing synthetic signature/lifecycle.signed seeding,
// and avoids the §17.22 signed/locked locked_at-not-null invariant chain.
// Already-voided idempotent retry path is exercised by re-running the
// ceremony script after the first happy-path run lands.
//
// VoidQuote is system-only in Phase A (per VoidQuoteCILZ.source =
// z.literal('system')); the share_token here anchors the synthetic
// lifecycle.sent event chain — it is NOT presented to a recipient during
// the ceremony.

const { deriveDeterministicShareToken } = require('./_ceremony_shared');

const CEREMONY_TENANT_ID        = '00000000-c6c6-c6c6-c6c6-000000000001';
const CEREMONY_OWNER_ID         = '00000000004';  // distinct from §27/§28/§30
const CEREMONY_QUOTE_ID         = '00000000-c6c6-c6c6-c6c6-000000000002';
const CEREMONY_VERSION_ID       = '00000000-c6c6-c6c6-c6c6-000000000003';
const CEREMONY_SHARE_TOKEN_ID   = '00000000-c6c6-c6c6-c6c6-000000000005';
const CEREMONY_SENT_EVENT_ID    = '00000000-c6c6-c6c6-c6c6-000000000007';
const CEREMONY_LINE_ITEM_ID     = '00000000-c6c6-c6c6-c6c6-0000000000a1';

const CEREMONY_HUMAN_ID         = 'QT-CEREMONY-2026-04-25-PHASE-A-S4';
const CEREMONY_PROJECT_TITLE    = 'Phase A Session 4 VoidQuote Ceremony';
const CEREMONY_CUSTOMER_NAME    = 'Phase A Session 4 Ceremony Customer';
const CEREMONY_RECIPIENT_EMAIL  = 'phase-a-s4-ceremony@chiefos.invalid';

// Deterministic share_token via shared ceremony helper. Bounded retry closes
// the §17.22 short-output footgun (Session 2 v2-iteration lesson; Session 3
// confirmed bounded retry resolves it without manual seed iteration).
const CEREMONY_SHARE_TOKEN = deriveDeterministicShareToken(
  'chiefos-phase-a-session-4-voidquote-ceremony-share-token-seed'
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
