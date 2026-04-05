'use strict';

/**
 * ChiefOS Cryptographic Record Integrity Service
 *
 * Implements SHA-256 hash chains on financial records.
 * Each record's hash includes the previous record's hash,
 * creating a tamper-evident chain per tenant.
 *
 * No external services. No ongoing cost. Pure Node crypto.
 */

const crypto = require('crypto');

// ─── Hash input builders ──────────────────────────────────────────────────────

/**
 * Build deterministic hash input for a transaction record.
 * Field set is FIXED at hash_version=1. Never reorder or add fields —
 * that would break verification of existing records.
 */
function buildTransactionHashInput(record, previousHash) {
  const fields = {
    amount_cents: record.amount_cents ?? 0,
    created_at: record.created_at ? String(record.created_at) : '',
    description: record.description ?? record.memo ?? '',
    job_id: record.job_id ? String(record.job_id) : '',
    kind: record.kind ?? '',
    owner_id: String(record.owner_id ?? ''),
    previous_hash: previousHash ?? 'GENESIS',
    source: record.source ?? '',
    source_msg_id: record.source_msg_id ?? '',
    tenant_id: String(record.tenant_id ?? ''),
    user_id: record.user_id ? String(record.user_id) : '',
  };

  // Keys must be sorted for determinism — always alphabetical
  return JSON.stringify(fields, Object.keys(fields).sort());
}

/**
 * Build deterministic hash input for a time entry record.
 * hash_version=1 field set.
 */
function buildTimeEntryHashInput(record, previousHash) {
  const fields = {
    clock_in: record.clock_in ? String(record.clock_in) : '',
    clock_out: record.clock_out ? String(record.clock_out) : '',
    created_at: record.created_at ? String(record.created_at) : '',
    job_id: record.job_id ? String(record.job_id) : '',
    owner_id: String(record.owner_id ?? ''),
    previous_hash: previousHash ?? 'GENESIS',
    total_work_minutes: record.total_work_minutes ?? 0,
    user_id: record.user_id ? String(record.user_id) : '',
  };

  return JSON.stringify(fields, Object.keys(fields).sort());
}

// ─── Core hash computation ────────────────────────────────────────────────────

function computeHash(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

// ─── Chain interaction (requires a pg client with an open transaction) ────────

/**
 * Get the most recent record_hash in a tenant's chain.
 * Uses FOR UPDATE to serialize concurrent inserts.
 * Must be called within an open DB transaction.
 *
 * For transactions table: keyed by tenant_id.
 * For time_entries_v2: keyed by owner_id (tenant_id may not exist on that table).
 */
async function getLatestChainHash(client, tableName, tenantKey, tenantValue) {
  const res = await client.query(
    `SELECT record_hash FROM public.${tableName}
     WHERE ${tenantKey} = $1 AND record_hash IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 1
     FOR UPDATE SKIP LOCKED`,
    [tenantValue]
  );
  return res.rows[0]?.record_hash ?? null;
}

/**
 * Generate full hash data for a record.
 * Must be called within an open DB transaction.
 *
 * @param {object} record - The record about to be inserted
 * @param {'transactions'|'time_entries_v2'} tableName
 * @param {object} client - pg client with open transaction
 * @returns {{ record_hash, previous_hash, hash_version, hash_input_snapshot }}
 */
async function generateHashData(record, tableName, client) {
  let tenantKey, tenantValue, buildInput;

  if (tableName === 'transactions') {
    tenantKey = 'tenant_id';
    tenantValue = record.tenant_id;
    buildInput = buildTransactionHashInput;
  } else if (tableName === 'time_entries_v2') {
    tenantKey = 'owner_id';
    tenantValue = record.owner_id;
    buildInput = buildTimeEntryHashInput;
  } else {
    throw new Error(`integrity: unsupported table: ${tableName}`);
  }

  const previousHash = await getLatestChainHash(client, tableName, tenantKey, tenantValue);
  const hashInput = buildInput(record, previousHash);
  const recordHash = computeHash(hashInput);

  return {
    record_hash: recordHash,
    previous_hash: previousHash,
    hash_version: 1,
    hash_input_snapshot: JSON.parse(hashInput),
  };
}

// ─── Verification ─────────────────────────────────────────────────────────────

/**
 * Verify a single record's hash integrity.
 * Returns details about validity — does not throw on mismatch.
 */
function verifyRecord(record) {
  if (!record.record_hash || !record.hash_input_snapshot) {
    return { hash_valid: null, content_matches_snapshot: null, unhashed: true };
  }

  // Re-derive hash from the stored snapshot
  const snapshotInput = JSON.stringify(
    record.hash_input_snapshot,
    Object.keys(record.hash_input_snapshot).sort()
  );
  const expectedHash = computeHash(snapshotInput);
  const hashValid = record.record_hash === expectedHash;

  // Also check current field values match the snapshot (detects field-level tampering)
  let currentInput;
  if (record.kind !== undefined) {
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
 * Walks all hashed records in created_at ASC order, validates:
 *   1. Each record's hash matches its stored snapshot
 *   2. Each record's previous_hash links to the prior record
 *
 * Writes a verification log entry and returns a summary.
 *
 * @param {object} db - pg Pool
 * @param {string} tenantId - UUID
 * @param {'transactions'|'time_entries_v2'} tableName
 * @param {'scheduled'|'on_demand'|'on_export'} verificationType
 */
async function verifyTenantChain(db, tenantId, tableName = 'transactions', verificationType = 'on_demand') {
  const startTime = new Date();

  const tenantKey = tableName === 'transactions' ? 'tenant_id' : 'owner_id';

  // For time_entries_v2 we need to resolve owner_id from tenant_id
  let filterValue = tenantId;
  if (tableName === 'time_entries_v2') {
    const ownerRes = await db.query(
      `SELECT owner_id FROM public.chiefos_tenants WHERE id = $1 LIMIT 1`,
      [tenantId]
    );
    filterValue = ownerRes.rows[0]?.owner_id ?? tenantId;
  }

  const selectCols = tableName === 'transactions'
    ? 'id, record_hash, previous_hash, hash_version, hash_input_snapshot, tenant_id, owner_id, user_id, kind, amount_cents, description, memo, job_id, source, source_msg_id, created_at'
    : 'id, record_hash, previous_hash, hash_version, hash_input_snapshot, owner_id, user_id, clock_in, clock_out, job_id, total_work_minutes, created_at';

  const records = await db.query(
    `SELECT ${selectCols}
     FROM public.${tableName}
     WHERE ${tenantKey} = $1
     ORDER BY created_at ASC`,
    [filterValue]
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

    // Verify chain linkage
    const chainValid =
      record.previous_hash === expectedPreviousHash ||
      (record.previous_hash === null && expectedPreviousHash === null);

    // Verify hash matches snapshot
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

  // Write verification log — best effort, don't fail the verification if logging fails
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

/**
 * Backfill hash chains for pre-feature records (those with record_hash IS NULL).
 * Processes in created_at ASC order, per tenant. Safe to re-run.
 *
 * @param {object} db - pg Pool
 * @param {string} tenantId - UUID
 * @param {'transactions'|'time_entries_v2'} tableName
 * @returns {{ processed, skipped }}
 */
async function backfillTenantHashes(db, tenantId, tableName = 'transactions') {
  const tenantKey = tableName === 'transactions' ? 'tenant_id' : 'owner_id';
  const buildInput = tableName === 'transactions'
    ? buildTransactionHashInput
    : buildTimeEntryHashInput;

  let filterValue = tenantId;
  if (tableName === 'time_entries_v2') {
    const ownerRes = await db.query(
      `SELECT owner_id FROM public.chiefos_tenants WHERE id = $1 LIMIT 1`,
      [tenantId]
    );
    filterValue = ownerRes.rows[0]?.owner_id ?? tenantId;
  }

  // Find the latest existing hash in the chain to anchor to
  const anchorRes = await db.query(
    `SELECT record_hash FROM public.${tableName}
     WHERE ${tenantKey} = $1 AND record_hash IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [filterValue]
  );
  let previousHash = anchorRes.rows[0]?.record_hash ?? null;

  // Fetch unhashed records in order
  const records = await db.query(
    `SELECT * FROM public.${tableName}
     WHERE ${tenantKey} = $1 AND record_hash IS NULL
     ORDER BY created_at ASC`,
    [filterValue]
  );

  let processed = 0;
  let skipped = 0;

  for (const record of records.rows) {
    try {
      const hashInput = buildInput(record, previousHash);
      const recordHash = computeHash(hashInput);
      const hashInputSnapshot = JSON.parse(hashInput);

      await db.query(
        `UPDATE public.${tableName}
         SET record_hash = $1, previous_hash = $2, hash_version = 1, hash_input_snapshot = $3
         WHERE id = $4 AND ${tenantKey} = $5`,
        [recordHash, previousHash, hashInputSnapshot, record.id, filterValue]
      );

      previousHash = recordHash;
      processed++;
    } catch (err) {
      console.error(`[integrity] backfill error on record ${record.id}:`, err.message);
      skipped++;
    }
  }

  return { processed, skipped };
}

module.exports = {
  buildTransactionHashInput,
  buildTimeEntryHashInput,
  computeHash,
  getLatestChainHash,
  generateHashData,
  verifyRecord,
  verifyTenantChain,
  backfillTenantHashes,
};
