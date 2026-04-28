'use strict';

/**
 * Regression tests for services/integrity.js field-set + serializer parity
 * with the chiefos_integrity_chain_stamp PG trigger.
 *
 * The trigger lives in migrations/2026_04_21_rebuild_*.sql. It builds a
 * canonical jsonb via jsonb_build_object, casts it to text, and sha256s
 * the bytes. JS verifier MUST produce byte-identical text → identical hash.
 *
 * Two test types:
 *
 * 1. Field-set fixture parity: assert builders produce exactly the keys
 *    listed in services/integrity.fixtures.js, in canonical order. Catches
 *    drift when either the trigger or the JS builder adds/removes a field.
 *
 * 2. Byte-equivalence vs production: take a real (hash_input_snapshot,
 *    record_hash) pair pulled from the production DB on 2026-04-28 and
 *    assert that JS pgJsonbCanonicalize + sha256 reproduces the stored
 *    record_hash exactly. Catches serialization drift (key order,
 *    separators, timestamp format, integer/string handling).
 */

const {
  TRANSACTION_HASH_FIELDS,
  TIME_ENTRY_HASH_FIELDS,
  pgJsonbCanonicalize,
  buildTransactionHashInput,
  buildTimeEntryHashInput,
  computeHash,
  verifyRecord,
} = require('../services/integrity');

// ─── Fixture: known production rows (pulled 2026-04-28) ──────────────────
// These match the hash_input_snapshot column on the seed rows in tenant
// 00000000-0000-4000-8000-000000000001 of project tctohnzqxzrfijdufrss.

const PROD_TXN_SNAPSHOT = {
  id:            '20000000-0000-4000-8000-000000000001',
  date:          '2026-04-15',
  kind:          'expense',
  source:        'whatsapp',
  currency:      'CAD',
  owner_id:      '14165550100',
  tenant_id:     '00000000-0000-4000-8000-000000000001',
  created_at:    '2026-04-26T12:00:01+00:00',
  amount_cents:  12500,
  previous_hash: '',
  source_msg_id: 'wa:msg:001',
};
const PROD_TXN_RECORD_HASH = 'd9122308655f5a6663200f2aaec0c941cd7189a4571a2f70b1f989be753ebac4';

const PROD_TE_SNAPSHOT = {
  id:            1,
  kind:          'shift',
  user_id:       '14165550102',
  owner_id:      '14165550100',
  tenant_id:     '00000000-0000-4000-8000-000000000001',
  created_at:    '2026-04-26T12:30:01+00:00',
  end_at_utc:    '2026-04-15T21:00:00+00:00',
  start_at_utc:  '2026-04-15T12:00:00+00:00',
  previous_hash: '',
  source_msg_id: 'wa:te:001',
};
const PROD_TE_RECORD_HASH = 'b831d8d17a7c95e79349ec7af431225925299b6618fb8a632e0be01955b6c191';

// ─── Field-set parity tests ──────────────────────────────────────────────

describe('integrity field-set parity vs chiefos_integrity_chain_stamp trigger', () => {
  test('TRANSACTION_HASH_FIELDS matches trigger jsonb_build_object call', () => {
    expect(TRANSACTION_HASH_FIELDS).toEqual([
      'id', 'date', 'kind', 'source', 'currency', 'owner_id', 'tenant_id',
      'created_at', 'amount_cents', 'previous_hash', 'source_msg_id',
    ]);
  });

  test('TIME_ENTRY_HASH_FIELDS matches trigger jsonb_build_object call', () => {
    expect(TIME_ENTRY_HASH_FIELDS).toEqual([
      'id', 'kind', 'user_id', 'owner_id', 'tenant_id',
      'created_at', 'end_at_utc', 'start_at_utc',
      'previous_hash', 'source_msg_id',
    ]);
  });

  test('buildTransactionHashInput emits exactly TRANSACTION_HASH_FIELDS', () => {
    const text = buildTransactionHashInput(PROD_TXN_SNAPSHOT, PROD_TXN_SNAPSHOT.previous_hash);
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed).sort()).toEqual([...TRANSACTION_HASH_FIELDS].sort());
  });

  test('buildTimeEntryHashInput emits exactly TIME_ENTRY_HASH_FIELDS', () => {
    const text = buildTimeEntryHashInput(PROD_TE_SNAPSHOT, PROD_TE_SNAPSHOT.previous_hash);
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed).sort()).toEqual([...TIME_ENTRY_HASH_FIELDS].sort());
  });
});

// ─── Byte-equivalence tests ──────────────────────────────────────────────

describe('integrity byte-equivalence vs PG jsonb::text', () => {
  test('pgJsonbCanonicalize uses length-asc-alpha key order with PG separators', () => {
    const out = pgJsonbCanonicalize({ kk: 1, k: 2, kkk: 3 });
    // Order: 'k' (1) < 'kk' (2) < 'kkk' (3). Separators: ': ' and ', '.
    expect(out).toBe('{"k": 2, "kk": 1, "kkk": 3}');
  });

  test('pgJsonbCanonicalize ties broken alphabetically within length bucket', () => {
    const out = pgJsonbCanonicalize({ kind: 'x', date: 'y' });
    // Both 4 chars; 'date' (d) < 'kind' (k) alpha.
    expect(out).toBe('{"date": "y", "kind": "x"}');
  });

  test('pgJsonbCanonicalize handles strings, numbers, null', () => {
    const out = pgJsonbCanonicalize({ a: 'x', b: 7, c: null });
    expect(out).toBe('{"a": "x", "b": 7, "c": null}');
  });

  test('production transaction snapshot rehash matches stored record_hash', () => {
    // Round-trip test: serialize the known production hash_input_snapshot,
    // sha256 it, assert byte-identical to record_hash from PG.
    const text = pgJsonbCanonicalize(PROD_TXN_SNAPSHOT);
    const hash = computeHash(text);
    expect(hash).toBe(PROD_TXN_RECORD_HASH);
  });

  test('production time_entries_v2 snapshot rehash matches stored record_hash', () => {
    const text = pgJsonbCanonicalize(PROD_TE_SNAPSHOT);
    const hash = computeHash(text);
    expect(hash).toBe(PROD_TE_RECORD_HASH);
  });

  test('buildTransactionHashInput produces byte-identical canonical text vs production', () => {
    // Stronger check: not only does the snapshot rehash, the builder (which
    // any caller would invoke on a fresh row) produces the same canonical
    // text byte-for-byte.
    const text = buildTransactionHashInput(PROD_TXN_SNAPSHOT, PROD_TXN_SNAPSHOT.previous_hash);
    const hash = computeHash(text);
    expect(hash).toBe(PROD_TXN_RECORD_HASH);
  });

  test('buildTimeEntryHashInput produces byte-identical canonical text vs production', () => {
    const text = buildTimeEntryHashInput(PROD_TE_SNAPSHOT, PROD_TE_SNAPSHOT.previous_hash);
    const hash = computeHash(text);
    expect(hash).toBe(PROD_TE_RECORD_HASH);
  });
});

// ─── verifyRecord integration ─────────────────────────────────────────────

describe('verifyRecord integration', () => {
  test('verifyRecord returns hash_valid + content_matches for a clean transaction', () => {
    const record = {
      ...PROD_TXN_SNAPSHOT,
      record_hash: PROD_TXN_RECORD_HASH,
      hash_input_snapshot: PROD_TXN_SNAPSHOT,
      previous_hash: PROD_TXN_SNAPSHOT.previous_hash,
    };
    const out = verifyRecord(record);
    expect(out.unhashed).toBe(false);
    expect(out.hash_valid).toBe(true);
    expect(out.content_matches_snapshot).toBe(true);
  });

  test('verifyRecord returns hash_valid + content_matches for a clean time_entry', () => {
    const record = {
      ...PROD_TE_SNAPSHOT,
      record_hash: PROD_TE_RECORD_HASH,
      hash_input_snapshot: PROD_TE_SNAPSHOT,
      previous_hash: PROD_TE_SNAPSHOT.previous_hash,
    };
    const out = verifyRecord(record);
    expect(out.unhashed).toBe(false);
    expect(out.hash_valid).toBe(true);
    expect(out.content_matches_snapshot).toBe(true);
  });

  test('verifyRecord catches snapshot tampering', () => {
    const record = {
      ...PROD_TXN_SNAPSHOT,
      record_hash: PROD_TXN_RECORD_HASH,
      hash_input_snapshot: { ...PROD_TXN_SNAPSHOT, amount_cents: 99999 }, // mutated
      previous_hash: PROD_TXN_SNAPSHOT.previous_hash,
    };
    const out = verifyRecord(record);
    expect(out.hash_valid).toBe(false);
  });

  test('verifyRecord catches content drift from snapshot', () => {
    const record = {
      ...PROD_TXN_SNAPSHOT,
      amount_cents: 99999, // drifted from original
      record_hash: PROD_TXN_RECORD_HASH,
      hash_input_snapshot: PROD_TXN_SNAPSHOT,
      previous_hash: PROD_TXN_SNAPSHOT.previous_hash,
    };
    const out = verifyRecord(record);
    expect(out.hash_valid).toBe(true);                 // snapshot still rehashes
    expect(out.content_matches_snapshot).toBe(false);  // current state diverged
  });

  test('verifyRecord returns unhashed for missing snapshot', () => {
    const out = verifyRecord({ id: 'x', record_hash: null, hash_input_snapshot: null });
    expect(out.unhashed).toBe(true);
    expect(out.hash_valid).toBeNull();
  });
});
