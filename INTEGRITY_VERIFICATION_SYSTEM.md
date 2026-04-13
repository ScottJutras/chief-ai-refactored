# ChiefOS — Cryptographic Record Integrity System

## For: Claude Code Implementation
## Status: New Feature — Security Infrastructure
## Priority: Should be implemented before public monetized launch
## Author: Scott Jutras
## Date: 2026-04-04

---

## 1. PURPOSE

Build a cryptographic hash chain system that makes every financial record in ChiefOS
tamper-evident. If any record is modified outside the normal application workflow — by
anyone, including database administrators — the system detects and flags it.

This enables:
- "Integrity Verified" trust badge on the product (homepage, portal, exports)
- Tax audit defensibility for contractors
- Client dispute protection (quotes, invoices, change orders are provably unaltered)
- Insurance claim support (verified cost records)
- Enterprise-grade data integrity without blockchain complexity or cost

This system uses SHA-256 cryptographic hashing with per-tenant hash chains. No blockchain,
no external services, no ongoing costs.

---

## 2. ARCHITECTURAL PRINCIPLES

### Per-tenant hash chains.

Each tenant has its own independent hash chain. Tenant A's chain has no relationship to
Tenant B's chain. This is consistent with the dual-boundary identity model — tenant
isolation is preserved.

### Hash chain, not blockchain.

A hash chain is a sequence of records where each record's hash includes the previous
record's hash. This creates a linked chain — if any record in the middle is tampered with,
every subsequent hash becomes invalid. Same mathematical principle as blockchain, without
the distributed ledger, consensus mechanisms, or gas fees.

### Append-only integrity.

New records are appended to the chain. Legitimate edits create NEW versions (with new
hashes) while preserving the original version's hash. The chain never needs to be
rewritten.

### Verification is read-only.

Hash verification never modifies data. It reads records, recomputes expected hashes,
and compares. Safe to run at any time.

### No performance impact on critical paths.

SHA-256 hashing adds microseconds per record. The hash computation happens synchronously
during the write path but adds negligible latency. Chain verification (walking the full
chain) runs async — never on the hot path.

---

## 3. DATABASE SCHEMA CHANGES

### 3.1 Add columns to public.transactions

```sql
ALTER TABLE public.transactions
ADD COLUMN record_hash TEXT,
ADD COLUMN previous_hash TEXT,
ADD COLUMN hash_version INTEGER NOT NULL DEFAULT 1,
ADD COLUMN hash_input_snapshot JSONB;
```

**Column definitions:**

- `record_hash` — SHA-256 hash of this record's content + previous_hash. 64-character
  hex string. NULL for records created before this feature is deployed (backfill later).

- `previous_hash` — The record_hash of the immediately preceding record in this tenant's
  chain. NULL for the first record in a tenant's chain (genesis record). Used to link
  the chain.

- `hash_version` — Integer version of the hashing algorithm/field set. Starts at 1.
  If we ever change which fields are included in the hash, increment this so verification
  knows which algorithm to use. Prevents breaking the chain on schema evolution.

- `hash_input_snapshot` — JSONB snapshot of the exact fields used to compute the hash.
  This is the verification reference — if a field is later modified, comparing the snapshot
  to current values reveals what changed. Stored so verification doesn't depend on
  reconstructing the input from potentially-altered fields.

### 3.2 Add index for chain traversal

```sql
-- Index for finding the latest record in a tenant's chain
CREATE INDEX idx_transactions_tenant_chain 
ON public.transactions(tenant_id, created_at DESC)
WHERE record_hash IS NOT NULL;

-- Index for finding a record by its hash (for verification lookups)
CREATE INDEX idx_transactions_record_hash 
ON public.transactions(record_hash)
WHERE record_hash IS NOT NULL;
```

### 3.3 Add columns to other hashable tables

Apply the same pattern to any table that benefits from integrity verification.
Priority order:

```sql
-- Phase 1: Financial records (most critical)
-- public.transactions — covered above

-- Phase 2: Time records
ALTER TABLE public.time_entries_v2
ADD COLUMN record_hash TEXT,
ADD COLUMN previous_hash TEXT,
ADD COLUMN hash_version INTEGER NOT NULL DEFAULT 1,
ADD COLUMN hash_input_snapshot JSONB;

CREATE INDEX idx_time_entries_tenant_chain 
ON public.time_entries_v2(owner_id, created_at DESC)
WHERE record_hash IS NOT NULL;

-- Phase 3: Documents (quotes, invoices, contracts)
-- Apply to quote/invoice tables when they exist
-- Signed documents are already immutable per North Star — hash chain adds verification
```

### 3.4 Integrity verification log table

```sql
CREATE TABLE public.integrity_verification_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  table_name TEXT NOT NULL,                    -- 'transactions', 'time_entries_v2', etc.
  verification_type TEXT NOT NULL,             -- 'scheduled', 'on_demand', 'on_export'
  total_records_checked INTEGER NOT NULL,
  records_valid INTEGER NOT NULL,
  records_invalid INTEGER NOT NULL,
  records_unhashed INTEGER NOT NULL,           -- Pre-feature records without hashes
  first_invalid_record_id UUID,                -- If invalid, which record broke the chain
  invalid_details JSONB DEFAULT '[]',          -- Details of any mismatches
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_integrity_log_tenant 
ON public.integrity_verification_log(tenant_id);
```

---

## 4. HASH COMPUTATION

### 4.1 Hash input construction

The hash input must be DETERMINISTIC. Same record must always produce the same hash.

**For public.transactions (hash_version = 1):**

```javascript
function buildHashInput(record, previousHash) {
  // CRITICAL: Field order must be FIXED and ALPHABETICAL by key.
  // CRITICAL: All values must be stringified deterministically.
  // CRITICAL: Use raw values, not formatted/display values.
  
  const hashFields = {
    amount_cents: record.amount_cents,
    created_at: record.created_at,           // ISO 8601 string
    description: record.description || '',
    job_id: record.job_id || '',
    kind: record.kind,                       // 'expense', 'revenue', etc.
    owner_id: record.owner_id,
    previous_hash: previousHash || 'GENESIS', // 'GENESIS' for first record in chain
    source: record.source || '',
    source_msg_id: record.source_msg_id || '',
    tenant_id: record.tenant_id,
    user_id: record.user_id || '',
  };

  // Deterministic JSON serialization — sorted keys, no whitespace
  return JSON.stringify(hashFields, Object.keys(hashFields).sort());
}
```

**For public.time_entries_v2 (hash_version = 1):**

```javascript
function buildTimeEntryHashInput(record, previousHash) {
  const hashFields = {
    clock_in: record.clock_in,               // ISO 8601
    clock_out: record.clock_out || '',       // ISO 8601 or empty
    created_at: record.created_at,
    job_id: record.job_id || '',
    owner_id: record.owner_id,
    previous_hash: previousHash || 'GENESIS',
    total_work_minutes: record.total_work_minutes || 0,
    user_id: record.user_id,
  };

  return JSON.stringify(hashFields, Object.keys(hashFields).sort());
}
```

### 4.2 Hash computation

```javascript
const crypto = require('crypto');

function computeRecordHash(hashInput) {
  return crypto
    .createHash('sha256')
    .update(hashInput, 'utf8')
    .digest('hex');
}
```

### 4.3 Full hash generation flow

```javascript
async function generateRecordHash(record, tableName, tenantId) {
  // 1. Find the previous record's hash in this tenant's chain
  const previousRecord = await db.query(
    `SELECT record_hash FROM public.${tableName}
     WHERE tenant_id = $1 
       AND record_hash IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId]
  );

  const previousHash = previousRecord?.record_hash || null;

  // 2. Build deterministic hash input
  const hashInput = buildHashInput(record, previousHash);

  // 3. Compute SHA-256 hash
  const recordHash = computeRecordHash(hashInput);

  // 4. Store the hash input snapshot for verification
  const hashInputSnapshot = JSON.parse(hashInput);

  return {
    record_hash: recordHash,
    previous_hash: previousHash,
    hash_version: 1,
    hash_input_snapshot: hashInputSnapshot,
  };
}
```

### 4.4 Integration with write path

**IMPORTANT:** Hash generation happens WITHIN the same database transaction as the
record insert/update. This prevents race conditions where two concurrent writes could
grab the same previous_hash.

```javascript
async function insertTransaction(record) {
  return await db.transaction(async (trx) => {
    // 1. Get previous hash within the transaction (locked read)
    const prev = await trx.query(
      `SELECT record_hash FROM public.transactions
       WHERE tenant_id = $1 AND record_hash IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,  // Lock to prevent concurrent chain corruption
      [record.tenant_id]
    );

    const previousHash = prev?.rows?.[0]?.record_hash || null;

    // 2. Build hash
    const hashInput = buildHashInput(record, previousHash);
    const recordHash = computeRecordHash(hashInput);
    const hashInputSnapshot = JSON.parse(hashInput);

    // 3. Insert record with hash
    const result = await trx.query(
      `INSERT INTO public.transactions 
       (tenant_id, owner_id, user_id, kind, amount_cents, description, 
        job_id, source, source_msg_id, record_hash, previous_hash, 
        hash_version, hash_input_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [record.tenant_id, record.owner_id, record.user_id, record.kind,
       record.amount_cents, record.description, record.job_id, record.source,
       record.source_msg_id, recordHash, previousHash, 1, hashInputSnapshot]
    );

    return result.rows[0];
  });
}
```

---

## 5. HASH VERIFICATION

### 5.1 Single record verification

```javascript
async function verifyRecord(record) {
  // Recompute hash from the stored snapshot
  const recomputedInput = JSON.stringify(
    record.hash_input_snapshot,
    Object.keys(record.hash_input_snapshot).sort()
  );
  const expectedHash = computeRecordHash(recomputedInput);

  // Also verify snapshot matches current field values
  const currentInput = buildHashInput(record, record.previous_hash);
  const currentHash = computeRecordHash(currentInput);

  return {
    hash_valid: record.record_hash === expectedHash,
    content_matches_snapshot: record.record_hash === currentHash,
    record_id: record.id,
    stored_hash: record.record_hash,
    expected_hash: expectedHash,
    current_content_hash: currentHash,
  };
}
```

### 5.2 Chain verification (full tenant audit)

```javascript
async function verifyTenantChain(tenantId, tableName = 'transactions') {
  const startTime = Date.now();

  const records = await db.query(
    `SELECT id, record_hash, previous_hash, hash_version, hash_input_snapshot,
            tenant_id, owner_id, user_id, kind, amount_cents, description,
            job_id, source, source_msg_id, created_at
     FROM public.${tableName}
     WHERE tenant_id = $1
     ORDER BY created_at ASC`,
    [tenantId]
  );

  let expectedPreviousHash = null;  // First record should have null previous_hash
  let totalChecked = 0;
  let valid = 0;
  let invalid = 0;
  let unhashed = 0;
  let firstInvalidId = null;
  const invalidDetails = [];

  for (const record of records.rows) {
    // Skip pre-feature records
    if (!record.record_hash) {
      unhashed++;
      continue;
    }

    totalChecked++;

    // 1. Verify chain linkage
    const chainValid = record.previous_hash === expectedPreviousHash
      || (record.previous_hash === null && expectedPreviousHash === null);

    // 2. Verify record hash matches snapshot
    const verification = await verifyRecord(record);

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

    // Update expected previous hash for next record
    expectedPreviousHash = record.record_hash;
  }

  const completedAt = new Date().toISOString();

  // Log verification result
  await db.query(
    `INSERT INTO public.integrity_verification_log
     (tenant_id, table_name, verification_type, total_records_checked,
      records_valid, records_invalid, records_unhashed,
      first_invalid_record_id, invalid_details, started_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [tenantId, tableName, 'on_demand', totalChecked, valid, invalid,
     unhashed, firstInvalidId, JSON.stringify(invalidDetails),
     new Date(startTime).toISOString(), completedAt]
  );

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
```

### 5.3 Verification triggers

**On demand:** Owner can request verification from portal Settings.

**On export:** Before generating PDF/XLSX exports, run verification on the exported records.
If chain is intact, include "Integrity Verified" badge on export. If not, include warning.

**Scheduled:** Nightly job runs verification on all active tenants. Flags anomalies to
system admin. This catches issues before owners notice them.

**On Ask Chief financial queries:** When Chief returns financial summaries, it can note:
"These figures are based on 47 verified records." This reinforces trust passively.

---

## 6. HANDLING LEGITIMATE EDITS

When a record is legitimately edited through ChiefOS (owner corrects an amount, approves
a time edit), the system must NOT break the hash chain.

### Approach: Edit creates a new chain entry.

```javascript
async function editTransaction(recordId, updates, tenantId, actorUserId) {
  return await db.transaction(async (trx) => {
    // 1. Fetch original record
    const original = await trx.query(
      `SELECT * FROM public.transactions WHERE id = $1 AND tenant_id = $2`,
      [recordId, tenantId]
    );

    if (!original.rows[0]) throw new Error('RECORD_NOT_FOUND');

    // 2. Mark original as superseded (do NOT delete or modify its hash)
    await trx.query(
      `UPDATE public.transactions 
       SET superseded_by = $1, updated_at = now()
       WHERE id = $2 AND tenant_id = $3`,
      [newRecordId, recordId, tenantId]
    );

    // 3. Create new version with updates — this gets its own hash in the chain
    const newRecord = {
      ...original.rows[0],
      ...updates,
      id: newRecordId,  // New UUID
      source: 'portal_edit',
      edit_of: recordId,  // Reference to original
      edited_by: actorUserId,
    };

    // 4. Generate hash for new record (appended to chain normally)
    const hashData = await generateRecordHash(newRecord, 'transactions', tenantId);

    // 5. Insert new version with hash
    await trx.query(
      `INSERT INTO public.transactions (...) VALUES (...)`,
      [/* new record fields + hash fields */]
    );
  });
}
```

**Key principle:** The original record's hash remains valid forever. The edit creates a
new record in the chain. The chain grows — it never rewrites. This is consistent with
the North Star's "no silent mutation" principle.

### Schema additions for edit tracking:

```sql
ALTER TABLE public.transactions
ADD COLUMN superseded_by UUID,               -- Points to the new version if edited
ADD COLUMN edit_of UUID,                     -- Points to the original if this is an edit
ADD COLUMN edited_by TEXT;                   -- user_id of who made the edit
```

---

## 7. BACKFILLING EXISTING RECORDS

Records created before this feature is deployed won't have hashes. The backfill process:

```javascript
async function backfillTenantHashes(tenantId) {
  const records = await db.query(
    `SELECT * FROM public.transactions
     WHERE tenant_id = $1 AND record_hash IS NULL
     ORDER BY created_at ASC`,
    [tenantId]
  );

  let previousHash = null;

  for (const record of records.rows) {
    const hashInput = buildHashInput(record, previousHash);
    const recordHash = computeRecordHash(hashInput);
    const hashInputSnapshot = JSON.parse(hashInput);

    await db.query(
      `UPDATE public.transactions
       SET record_hash = $1, previous_hash = $2, hash_version = 1,
           hash_input_snapshot = $3
       WHERE id = $4 AND tenant_id = $5`,
      [recordHash, previousHash, hashInputSnapshot, record.id, tenantId]
    );

    previousHash = recordHash;
  }
}
```

**Run this per-tenant, not globally.** Each tenant gets their own chain starting from
their oldest record.

---

## 8. API ENDPOINTS

### 8.1 Verification endpoint (owner-only)

```
POST /api/integrity/verify
  Body: { table: 'transactions' }  // optional, defaults to transactions
  Auth: requires tenant_id via auth, owner role
  Returns: { chain_intact: true/false, total_checked, valid, invalid, unhashed }
```

### 8.2 Record integrity detail (owner-only)

```
GET /api/integrity/record/:recordId
  Auth: requires tenant_id via auth
  Returns: { hash_valid, content_matches_snapshot, chain_position, created_at }
```

### 8.3 Verification history (owner-only)

```
GET /api/integrity/history
  Auth: requires tenant_id via auth
  Returns: array of past verification results from integrity_verification_log
```

---

## 9. PORTAL UI

### 9.1 Settings → Data Integrity

Add a "Data Integrity" section to portal Settings:

```
┌──────────────────────────────────────────────┐
│  Data Integrity                              │
│                                              │
│  🛡️ Integrity Verified                       │
│  Last verified: April 3, 2026 at 11:42 PM   │
│  Records checked: 847                        │
│  Status: All records intact ✓                │
│                                              │
│  [Run Verification]                          │
│                                              │
│  Verification History                        │
│  Apr 3, 2026 — 847 records — All intact ✓   │
│  Apr 2, 2026 — 839 records — All intact ✓   │
│  Apr 1, 2026 — 831 records — All intact ✓   │
└──────────────────────────────────────────────┘
```

### 9.2 Badge on exports

When generating PDF or XLSX exports, if verification passes, include a footer line:

"Records integrity verified — [date] — ChiefOS Integrity Verification"

### 9.3 Badge in portal header

Small shield icon with "Integrity Verified" text in the portal header or footer.
Only shows if the tenant's most recent verification passed. If verification has never
run or last run failed, show nothing (don't show a negative badge).

---

## 10. ASK CHIEF INTEGRATION

When Chief returns financial summaries, include a passive integrity note:

"Your total expenses for March were $12,847 across 6 jobs — based on 23 verified records."

This reinforces trust without being heavy-handed. Chief doesn't need to explain
cryptographic hashing — it just notes that the data is verified.

If verification fails (rare), Chief should flag it:

"I found an integrity issue with one of your expense records. Your data is safe,
but I'd recommend running a verification check in Settings. This usually means a
record was modified outside the normal workflow."

---

## 11. PLAN GATING

| Feature                        | Free | Builder | Boss |
|--------------------------------|------|---------|------|
| Hash chain on new records      | ✓    | ✓       | ✓    |
| Automatic nightly verification | ✗    | ✓       | ✓    |
| On-demand verification         | ✗    | ✓       | ✓    |
| Integrity badge on exports     | ✗    | ✓       | ✓    |
| Verification history           | ✗    | ✗       | ✓    |

**IMPORTANT:** Hash generation happens on ALL tiers, including Free. This is a security
feature, not a monetization feature. The hashes are always computed and stored.
What's gated is the VERIFICATION UI and export badges — the ability to prove integrity
to others.

---

## 12. MIGRATION PLAN

### Phase 1: Schema
1. Add record_hash, previous_hash, hash_version, hash_input_snapshot to transactions
2. Add same columns to time_entries_v2
3. Add superseded_by, edit_of, edited_by to transactions (if not already present)
4. Create integrity_verification_log table
5. Create indexes

### Phase 2: Write Path Integration
1. Build hash computation module (buildHashInput, computeRecordHash, generateRecordHash)
2. Integrate into transaction insert path (within same DB transaction)
3. Integrate into time entry insert path
4. Test: every new record gets a valid hash

### Phase 3: Backfill
1. Build backfill script
2. Run per-tenant in order of created_at
3. Verify backfilled chains

### Phase 4: Verification
1. Build single-record verification function
2. Build full-chain verification function
3. Build verification logging
4. Build nightly scheduled verification job

### Phase 5: Edit Handling
1. Modify transaction edit path to create new chain entries
2. Preserve original record hash on edits
3. Test: edit a record, verify chain still intact

### Phase 6: API & Portal
1. Build verification API endpoints
2. Build Settings → Data Integrity UI
3. Build export integrity badge
4. Wire plan gating

### Phase 7: Ask Chief Integration
1. Add integrity note to financial summary responses
2. Add integrity warning for failed verification

---

## 13. SECURITY NOTES

- The hash computation uses SHA-256 which is cryptographically secure
- Hash input snapshots are stored in JSONB — this is intentional for auditability
- The hashing secret is the chain itself (previous_hash linkage), not a separate key
- If an attacker has database write access, they could theoretically recompute the entire
  chain — to prevent this, consider periodically anchoring chain head hashes to an external
  timestamping service (e.g., RFC 3161) in a future phase. This is NOT required for launch.
- Hash verification logs should be retained indefinitely (they're small and audit-critical)

---

## 14. TESTING REQUIREMENTS

1. **Basic hash generation:** Insert 10 records, verify each has a valid hash chain
2. **Chain integrity:** Walk chain for a tenant, confirm all hashes link correctly
3. **Tamper detection:** Manually alter a record's amount_cents in the DB, run verification,
   confirm it detects the tampering
4. **Edit handling:** Edit a record through the application, verify chain remains intact
5. **Concurrent writes:** Insert 2 records simultaneously for same tenant, verify no chain
   corruption (the FOR UPDATE lock prevents this)
6. **Backfill:** Create records without hashes, run backfill, verify chain is valid
7. **Cross-tenant isolation:** Verify tenant A's chain is independent of tenant B's chain
8. **Performance:** Measure insert latency with and without hash generation, confirm
   difference is < 5ms

---

End of Document — Cryptographic Record Integrity System
