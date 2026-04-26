// scripts/_phase_a_session5_constants.js
// Phase A Session 5 ReissueQuote ceremony identity — frozen inputs for all
// ceremony scripts. Idempotency depends on these being fixed across reruns.
//
// Namespace: 'c7c7-c7c7-c7c7' hex group distinguishes Phase A Session 5
// ceremony rows from Phase A Session 4's 'c6c6-c6c6-c6c6'.
//
// Source state for the ceremony: 'voided' (the strict precondition for
// ReissueQuote per §3A). The seed step builds a voided quote inline; the
// ceremony then reissues it. Re-runs land on the §17.10 idempotent-retry
// path via chiefos_qv_source_msg_unique partial UNIQUE — same source_msg_id
// returns the prior reissued version with meta.already_existed=true.

const CEREMONY_TENANT_ID        = '00000000-c7c7-c7c7-c7c7-000000000001';
const CEREMONY_OWNER_ID         = '00000000005';  // distinct from §27/§28/§30/§31
const CEREMONY_QUOTE_ID         = '00000000-c7c7-c7c7-c7c7-000000000002';
const CEREMONY_PRIOR_VERSION_ID = '00000000-c7c7-c7c7-c7c7-000000000003';
const CEREMONY_LINE_ITEM_ID     = '00000000-c7c7-c7c7-c7c7-0000000000a1';

const CEREMONY_HUMAN_ID         = 'QT-CEREMONY-2026-04-25-PHASE-A-S5';
const CEREMONY_PROJECT_TITLE    = 'Phase A Session 5 ReissueQuote Ceremony';
const CEREMONY_CUSTOMER_NAME    = 'Phase A Session 5 Ceremony Customer';

const CEREMONY_REISSUE_SOURCE_MSG_ID = 'ceremony-phase-a-s5-reissue-run-1';

module.exports = {
  CEREMONY_TENANT_ID,
  CEREMONY_OWNER_ID,
  CEREMONY_QUOTE_ID,
  CEREMONY_PRIOR_VERSION_ID,
  CEREMONY_LINE_ITEM_ID,
  CEREMONY_HUMAN_ID,
  CEREMONY_PROJECT_TITLE,
  CEREMONY_CUSTOMER_NAME,
  CEREMONY_REISSUE_SOURCE_MSG_ID,
};
