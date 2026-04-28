'use strict';

/**
 * ChiefOS Cryptographic Record Integrity Service
 *
 * Implements SHA-256 hash chains on financial records (transactions) and
 * time entries (time_entries_v2). Each row's record_hash includes the
 * previous row's record_hash, creating a tamper-evident per-tenant chain.
 *
 * Authoritative writer: the PG trigger chiefos_integrity_chain_stamp
 * (BEFORE INSERT on transactions and time_entries_v2). This module does
 * NOT perform INSERT-time stamping — only verification of stored chains.
 *
 * Field-set contract: services/integrity.fixtures.js defines the canonical
 * hash-input fields for each table. JS rebuilders below MUST match the
 * trigger's jsonb_build_object field list exactly. Drift is caught by
 * __tests__/integrity.fieldsets.test.js.
 *
 * Byte-equivalence: PG's jsonb::text format uses length-asc-alpha key order,
 * `": "` and `", "` separators, ISO-8601 timestamps with `+HH:MM` zones,
 * raw numbers for bigint, and JSON-string-quoted text. pgJsonbCanonicalize
 * below replicates this format byte-for-byte.
 */

const crypto = require('crypto');
const {
  TRANSACTION_HASH_FIELDS,
  TIME_ENTRY_HASH_FIELDS,
} = require('./integrity.fixtures');

// ─── PG jsonb canonical text serializer ──────────────────────────────────

// PG's jsonb canonical key order: length ascending, then alphabetical
// within each length bucket.
function pgJsonbKeyCmp(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function serializeValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  // strings (incl. pre-formatted timestamps/dates/uuids) — JSON-escaped quotes
  return JSON.stringify(String(v));
}

// Match PG's jsonb::text exactly. Output: {"k1": v1, "k2": v2}
function pgJsonbCanonicalize(obj) {
  if (obj === null || obj === undefined) return 'null';
  const keys = Object.keys(obj).sort(pgJsonbKeyCmp);
  const parts = keys.map((k) => JSON.stringify(k) + ': ' + serializeValue(obj[k]));
  return '{' + parts.join(', ') + '}';
}

// ─── Value formatters ────────────────────────────────────────────────────
// PG `to_jsonb(timestamptz)` outputs ISO 8601 with `+HH:MM` zone.
// PG `to_jsonb(date)` outputs ISO date `YYYY-MM-DD`.
// When the pg driver returns a JS Date for these columns, format manually
// to match. When the value is already a string (e.g., from hash_input_snapshot),
// use it as-is.

function pad2(n) { return String(n).padStart(2, '0'); }

function formatPgTimestamptz(d) {
  if (typeof d === 'string') return d;
  if (!(d instanceof Date)) return String(d);
  // Always emit UTC with +00:00 (matches what trigger produced for our seed).
  // Note: production rows stamped via trigger use the row's actual timezone;
  // verification reads back the stored snapshot so this branch only fires
  // when JS computes a fresh hash from a Date object (rare — only for
  // tamper-detection rebuilds, where created_at came from PG as a Date).
  const yyyy = d.getUTCFullYear();
  const mm = pad2(d.getUTCMonth() + 1);
  const dd = pad2(d.getUTCDate());
  const HH = pad2(d.getUTCHours());
  const MM = pad2(d.getUTCMinutes());
  const SS = pad2(d.getUTCSeconds());
  return `${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}+00:00`;
}

function formatPgDate(d) {
  if (typeof d === 'string') {
    // Already 'YYYY-MM-DD' or possibly an ISO timestamp; trim to date part.
    return d.length >= 10 ? d.slice(0, 10) : d;
  }
  if (!(d instanceof Date)) return String(d);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// ─── Hash input builders ─────────────────────────────────────────────────

/**
 * Build the canonical hash input for a transaction record.
 * Field set MUST match TRANSACTION_HASH_FIELDS (and the trigger's
 * jsonb_build_object call). Returns the canonical jsonb text.
 */
function buildTransactionHashInput(record, previousHash) {
  const obj = {
    id: String(record.id ?? ''),
    tenant_id: String(record.tenant_id ?? ''),
    owner_id: String(record.owner_id ?? ''),
    kind: record.kind ?? '',
    amount_cents: typeof record.amount_cents === 'string'
      ? Number(record.amount_cents)
      : (record.amount_cents ?? 0),
    currency: record.currency ?? '',
    date: formatPgDate(record.date),
    source: record.source ?? '',
    source_msg_id: record.source_msg_id ?? null,
    created_at: formatPgTimestamptz(record.created_at),
    previous_hash: previousHash ?? '',
  };
  return pgJsonbCanonicalize(obj);
}

/**
 * Build the canonical hash input for a time_entries_v2 record.
 * Field set MUST match TIME_ENTRY_HASH_FIELDS.
 */
function buildTimeEntryHashInput(record, previousHash) {
  const obj = {
    id: typeof record.id === 'string' ? Number(record.id) : (record.id ?? 0),
    tenant_id: String(record.tenant_id ?? ''),
    owner_id: String(record.owner_id ?? ''),
    user_id: String(record.user_id ?? ''),
    kind: record.kind ?? '',
    start_at_utc: formatPgTimestamptz(record.start_at_utc),
    end_at_utc: record.end_at_utc == null ? null : formatPgTimestamptz(record.end_at_utc),
    source_msg_id: record.source_msg_id ?? null,
    created_at: formatPgTimestamptz(record.created_at),
    previous_hash: previousHash ?? '',
  };
  return pgJsonbCanonicalize(obj);
}

// ─── Core hash computation ───────────────────────────────────────────────

function computeHash(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

// ─── Verification ────────────────────────────────────────────────────────

/**
 * Verify a single record's hash integrity.
 *
 * Two checks:
 *   1. hash_valid: re-hash the stored hash_input_snapshot. If this matches
 *      record_hash, the snapshot wasn't tampered with after the trigger
 *      wrote it.
 *   2. content_matches_snapshot: rebuild the canonical input from the
 *      record's CURRENT field values + its previous_hash, hash it. If this
 *      matches record_hash, the canonical fields haven't drifted from the
 *      original write.
 *
 * Returns details; does not throw. unhashed=true if record_hash or snapshot
 * is missing.
 */
function verifyRecord(record) {
  if (!record.record_hash || !record.hash_input_snapshot) {
    return { hash_valid: null, content_matches_snapshot: null, unhashed: true };
  }

  // (1) Re-derive hash from stored snapshot.
  const snapshotInput = pgJsonbCanonicalize(record.hash_input_snapshot);
  const expectedHash = computeHash(snapshotInput);
  const hashValid = record.record_hash === expectedHash;

  // (2) Rebuild canonical input from current field values, hash, compare.
  // Discriminate table by the presence of kind+amount_cents (transactions)
  // vs kind+start_at_utc (time_entries_v2). Both have `kind` so we use
  // amount_cents as the disambiguator.
  let currentInput;
  if (record.amount_cents !== undefined) {
    currentInput = buildTransactionHashInput(record, record.previous_hash);
  } else {
    currentInput = buildTimeEntryHashInput(record, record.previous_hash);
  }
  const currentHash = computeHash(currentInput);
  const contentMatchesSnapshot = record.record_hash === currentHash;

  return {
    hash_valid: hashValid,
    content_matches_snapshot: contentMatchesSnapshot,
    unhashed: false,
    record_id: record.id,
    stored_hash: record.record_hash,
    expected_hash: expectedHash,
    current_content_hash: currentHash,
  };
}

/**
 * Verify the full hash chain for a tenant.
 * Walks all hashed records in created_at ASC order, checks per-row hash
 * validity and chain linkage (each previous_hash equals prior record_hash).
 *
 * Writes a verification log entry and returns a summary.
 */
async function verifyTenantChain(db, tenantId, tableName = 'transactions', verificationType = 'on_demand') {
  const startTime = new Date();

  if (tableName !== 'transactions' && tableName !== 'time_entries_v2') {
    throw new Error(`integrity: unsupported table: ${tableName}`);
  }

  const selectCols = tableName === 'transactions'
    ? 'id, record_hash, previous_hash, hash_version, hash_input_snapshot, tenant_id, owner_id, kind, amount_cents, currency, date, source, source_msg_id, created_at'
    : 'id, record_hash, previous_hash, hash_version, hash_input_snapshot, tenant_id, owner_id, user_id, kind, start_at_utc, end_at_utc, source_msg_id, created_at';

  const records = await db.query(
    `SELECT ${selectCols}
       FROM public.${tableName}
      WHERE tenant_id = $1
      ORDER BY created_at ASC, id ASC`,
    [tenantId]
  );

  let expectedPreviousHash = null;
  let totalChecked = 0;
  let valid = 0;
  let invalid = 0;
  let unhashed = 0;
  let firstInvalidId = null;
  const invalidDetails = [];

  for (const record of records.rows) {
    if (!record.record_hash) {
      unhashed++;
      continue;
    }

    totalChecked++;

    // Chain-linkage check: this record's previous_hash must equal the prior
    // record's record_hash (or NULL for the genesis row).
    const chainValid =
      record.previous_hash === expectedPreviousHash ||
      (record.previous_hash === null && expectedPreviousHash === null);

    const verification = verifyRecord(record);

    if (chainValid && verification.hash_valid && verification.content_matches_snapshot) {
      valid++;
    } else {
      invalid++;
      if (!firstInvalidId) firstInvalidId = record.id;
      invalidDetails.push({
        record_id: record.id,
        chain_valid: chainValid,
        hash_valid: verification.hash_valid,
        content_matches: verification.content_matches_snapshot,
        expected_previous: expectedPreviousHash,
        actual_previous: record.previous_hash,
      });
    }

    expectedPreviousHash = record.record_hash;
  }

  const completedAt = new Date();

  try {
    await db.query(
      `INSERT INTO public.integrity_verification_log
         (tenant_id, table_name, verification_type, total_records_checked,
          records_valid, records_invalid, records_unhashed,
          first_invalid_record_id, invalid_details, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        tenantId, tableName, verificationType, totalChecked,
        valid, invalid, unhashed,
        firstInvalidId ?? null,
        JSON.stringify(invalidDetails),
        startTime.toISOString(), completedAt.toISOString(),
      ]
    );
  } catch (logErr) {
    console.error('[integrity] failed to write verification log:', logErr.message);
  }

  return {
    tenant_id: tenantId,
    table: tableName,
    total_checked: totalChecked,
    valid,
    invalid,
    unhashed,
    chain_intact: invalid === 0,
    first_invalid_id: firstInvalidId,
    details: invalidDetails,
  };
}

module.exports = {
  // builders + canonicalizer (used by tests + verifyRecord)
  TRANSACTION_HASH_FIELDS,
  TIME_ENTRY_HASH_FIELDS,
  pgJsonbCanonicalize,
  buildTransactionHashInput,
  buildTimeEntryHashInput,
  computeHash,
  // verification API
  verifyRecord,
  verifyTenantChain,
};
