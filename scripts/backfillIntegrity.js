#!/usr/bin/env node
'use strict';

/**
 * scripts/backfillIntegrity.js
 *
 * Backfill cryptographic hash chains for pre-feature records.
 *
 * Run after deploying the integrity migration and services/integrity.js.
 * Safe to run multiple times — skips records that already have record_hash.
 *
 * Usage:
 *   node scripts/backfillIntegrity.js
 *   node scripts/backfillIntegrity.js --table=transactions
 *   node scripts/backfillIntegrity.js --tenant=<uuid>
 *   node scripts/backfillIntegrity.js --dry-run
 *
 * Options:
 *   --table      transactions (default) or time_entries_v2
 *   --tenant     Process a specific tenant UUID only
 *   --dry-run    Report what would be processed without writing
 */

require('../config/env');
const { Pool } = require('pg');
const integrity = require('../services/integrity');

const DB_URL =
  (process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim()) ||
  (process.env.POSTGRES_URL && String(process.env.POSTGRES_URL).trim()) ||
  '';

if (!DB_URL) {
  console.error('[backfill] ERROR: DATABASE_URL is not set.');
  process.exit(1);
}

const shouldSSL = /supabase\.co|render\.com|amazonaws|heroku/i.test(DB_URL);
const pool = new Pool({
  connectionString: DB_URL,
  ssl: shouldSSL ? { rejectUnauthorized: false } : false,
  max: 3,
});

// Parse CLI args
const args = process.argv.slice(2);
const tableName = args.find(a => a.startsWith('--table='))?.split('=')[1] || 'transactions';
const specificTenant = args.find(a => a.startsWith('--tenant='))?.split('=')[1] || null;
const dryRun = args.includes('--dry-run');

const VALID_TABLES = ['transactions', 'time_entries_v2'];
if (!VALID_TABLES.includes(tableName)) {
  console.error(`[backfill] ERROR: --table must be one of: ${VALID_TABLES.join(', ')}`);
  process.exit(1);
}

async function getTenantsToProcess() {
  if (specificTenant) {
    return [specificTenant];
  }

  // Get all tenants that have unprocessed records
  const tenantKey = tableName === 'transactions' ? 'tenant_id' : 'owner_id';

  if (tableName === 'time_entries_v2') {
    // time_entries_v2 is keyed by owner_id; resolve back to tenant_id via chiefos_tenants
    const res = await pool.query(
      `SELECT DISTINCT ct.id AS tenant_id
       FROM public.time_entries_v2 te
       JOIN public.chiefos_tenants ct ON ct.owner_id = te.owner_id::text
       WHERE te.record_hash IS NULL
       ORDER BY ct.id`
    );
    return res.rows.map(r => r.tenant_id);
  }

  const res = await pool.query(
    `SELECT DISTINCT ${tenantKey} AS tenant_id
     FROM public.${tableName}
     WHERE record_hash IS NULL AND ${tenantKey} IS NOT NULL
     ORDER BY ${tenantKey}`
  );
  return res.rows.map(r => r.tenant_id);
}

async function countUnhashed(tenantId) {
  const tenantKey = tableName === 'transactions' ? 'tenant_id' : 'owner_id';

  let filterValue = tenantId;
  if (tableName === 'time_entries_v2') {
    const ownerRes = await pool.query(
      `SELECT owner_id FROM public.chiefos_tenants WHERE id = $1 LIMIT 1`,
      [tenantId]
    );
    filterValue = ownerRes.rows[0]?.owner_id ?? tenantId;
  }

  const res = await pool.query(
    `SELECT COUNT(*) AS cnt FROM public.${tableName}
     WHERE ${tenantKey} = $1 AND record_hash IS NULL`,
    [filterValue]
  );
  return Number(res.rows[0]?.cnt || 0);
}

async function main() {
  console.log(`[backfill] Starting integrity backfill`);
  console.log(`[backfill] Table: ${tableName}`);
  if (specificTenant) console.log(`[backfill] Tenant: ${specificTenant}`);
  if (dryRun) console.log(`[backfill] DRY RUN — no writes`);
  console.log('');

  const tenants = await getTenantsToProcess();
  console.log(`[backfill] ${tenants.length} tenant(s) to process`);

  if (tenants.length === 0) {
    console.log('[backfill] Nothing to do. All records already hashed.');
    await pool.end();
    return;
  }

  let totalProcessed = 0;
  let totalSkipped = 0;
  let tenantsFailed = 0;

  for (let i = 0; i < tenants.length; i++) {
    const tenantId = tenants[i];
    const unhashed = await countUnhashed(tenantId);

    if (unhashed === 0) {
      console.log(`[backfill] [${i + 1}/${tenants.length}] tenant=${tenantId} — 0 unhashed, skipping`);
      continue;
    }

    if (dryRun) {
      console.log(`[backfill] [${i + 1}/${tenants.length}] tenant=${tenantId} — would process ${unhashed} record(s)`);
      totalProcessed += unhashed;
      continue;
    }

    try {
      console.log(`[backfill] [${i + 1}/${tenants.length}] tenant=${tenantId} — processing ${unhashed} record(s)...`);
      const result = await integrity.backfillTenantHashes(pool, tenantId, tableName);
      console.log(`[backfill]   done: ${result.processed} processed, ${result.skipped} skipped`);
      totalProcessed += result.processed;
      totalSkipped += result.skipped;
    } catch (err) {
      console.error(`[backfill]   FAILED for tenant ${tenantId}:`, err.message);
      tenantsFailed++;
    }
  }

  console.log('');
  console.log('[backfill] ─── Summary ───────────────────────────────');
  console.log(`[backfill] Tenants processed: ${tenants.length - tenantsFailed}`);
  console.log(`[backfill] Records hashed:    ${totalProcessed}`);
  console.log(`[backfill] Records skipped:   ${totalSkipped}`);
  if (tenantsFailed > 0) {
    console.log(`[backfill] Tenants failed:    ${tenantsFailed} ⚠️`);
  }
  if (dryRun) {
    console.log(`[backfill] (dry run — no writes made)`);
  }
  console.log('[backfill] ────────────────────────────────────────────');

  await pool.end();
  process.exit(tenantsFailed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[backfill] Fatal error:', err.message);
  process.exit(1);
});
