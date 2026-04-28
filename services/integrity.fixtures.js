'use strict';

/**
 * services/integrity.fixtures.js
 *
 * Canonical hash-field contract for the chiefos_integrity_chain_stamp trigger.
 * The arrays below are the SOURCE OF TRUTH for which fields participate in
 * each table's record_hash chain. The trigger's jsonb_build_object call list
 * MUST match these exactly. The JS verifier in services/integrity.js MUST
 * include exactly these fields when rebuilding canonical input.
 *
 * If you change either the trigger SQL or the JS verifier, update this file
 * AND the regression test in __tests__/integrity.fieldsets.test.js.
 *
 * Trigger source (current canonical):
 *   migrations/2026_04_21_rebuild_*.sql — function chiefos_integrity_chain_stamp
 *
 * PG jsonb canonical key order: length ascending, then alphabetical within
 * each length bucket. The arrays below are listed in that canonical order
 * so the test asserts both presence and order.
 */

const TRANSACTION_HASH_FIELDS = Object.freeze([
  // 2 chars
  'id',
  // 4 chars (alpha: date < kind)
  'date',
  'kind',
  // 6 chars
  'source',
  // 8 chars (alpha: currency < owner_id)
  'currency',
  'owner_id',
  // 9 chars
  'tenant_id',
  // 10 chars
  'created_at',
  // 12 chars
  'amount_cents',
  // 13 chars (alpha: previous_hash < source_msg_id)
  'previous_hash',
  'source_msg_id',
]);

const TIME_ENTRY_HASH_FIELDS = Object.freeze([
  // 2 chars
  'id',
  // 4 chars
  'kind',
  // 7 chars
  'user_id',
  // 8 chars
  'owner_id',
  // 9 chars
  'tenant_id',
  // 10 chars (alpha: created_at < end_at_utc)
  'created_at',
  'end_at_utc',
  // 12 chars
  'start_at_utc',
  // 13 chars (alpha: previous_hash < source_msg_id)
  'previous_hash',
  'source_msg_id',
]);

module.exports = {
  TRANSACTION_HASH_FIELDS,
  TIME_ENTRY_HASH_FIELDS,
};
