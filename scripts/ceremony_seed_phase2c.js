// scripts/ceremony_seed_phase2c.js
// Idempotent seed for Phase 2C ceremony. Inserts synthetic prerequisite
// rows required for the retrieval-helper exercise:
//   1. chiefos_tenants           (FK target for chiefos_quotes.tenant_id)
//   2. jobs                       (FK target for chiefos_quotes.job_id)
//   3. chiefos_quotes            (status='signed')
//   4. chiefos_quote_versions    (status='signed', locked_at, server_hash)
//   5. UPDATE chiefos_quotes.current_version_id → version
//   6. chiefos_quote_share_tokens (for public-path exercise)
//   7. chiefos_quote_events row of kind='lifecycle.signed'
//      (referenced by signature.signed_event_id at upload time)
//
// The signature row itself is NOT seeded here — it needs the storage_key
// + sha256 that only the upload script produces. Upload script inserts the
// signature row after uploadSignaturePng returns.
//
// Re-running is a no-op: checks for existing ceremony rows before inserting.

require('dotenv').config();
const pg = require('../services/postgres');

const {
  CEREMONY_TENANT_ID, CEREMONY_OWNER_ID,
  CEREMONY_QUOTE_ID, CEREMONY_VERSION_ID,
  CEREMONY_SHARE_TOKEN_ID, CEREMONY_SIGNED_EVENT_ID,
  CEREMONY_SHARE_TOKEN, CEREMONY_HUMAN_ID,
  CEREMONY_PROJECT_TITLE, CEREMONY_CUSTOMER_NAME,
  CEREMONY_RECIPIENT_EMAIL, CEREMONY_VERSION_HASH,
} = require('./_phase2c_constants');

// CRITICAL: share_token.quote_version_id MUST equal CEREMONY_VERSION_ID.
// This links the ceremony share_token to the ceremony signature via the
// signature's quote_version_id reference. Without this, Query 2 in
// getSignatureViaShareToken returns empty → ceremony public path fails
// with SHARE_TOKEN_NOT_FOUND despite everything else looking correct.

async function main() {
  console.log('─── Phase 2C ceremony seed ────────────────────────────────');
  console.log(`tenant_id:        ${CEREMONY_TENANT_ID}`);
  console.log(`owner_id:         ${CEREMONY_OWNER_ID}`);
  console.log(`quote_id:         ${CEREMONY_QUOTE_ID}`);
  console.log(`version_id:       ${CEREMONY_VERSION_ID}`);
  console.log(`share_token_id:   ${CEREMONY_SHARE_TOKEN_ID}`);
  console.log(`share_token:      ${CEREMONY_SHARE_TOKEN}`);
  console.log(`signed_event_id:  ${CEREMONY_SIGNED_EVENT_ID}`);
  console.log(`human_id:         ${CEREMONY_HUMAN_ID}`);
  console.log('');

  // ─── Idempotency check ───────────────────────────────────────────────────
  const existing = await pg.query(
    `SELECT id FROM public.chiefos_quotes WHERE id = $1`,
    [CEREMONY_QUOTE_ID]
  );
  if (existing.rows.length > 0) {
    console.log('[SEED] ceremony quote already present — checking completeness...');

    const checks = await Promise.all([
      pg.query(`SELECT 1 FROM public.chiefos_tenants WHERE id = $1`, [CEREMONY_TENANT_ID]),
      pg.query(`SELECT 1 FROM public.chiefos_quote_versions WHERE id = $1`, [CEREMONY_VERSION_ID]),
      pg.query(`SELECT 1 FROM public.chiefos_quote_share_tokens WHERE id = $1`, [CEREMONY_SHARE_TOKEN_ID]),
      pg.query(`SELECT 1 FROM public.chiefos_quote_events WHERE id = $1`, [CEREMONY_SIGNED_EVENT_ID]),
    ]);
    const allPresent = checks.every((r) => r.rows.length > 0);
    if (allPresent) {
      console.log('[SEED] ✓ all ceremony prerequisite rows present — no-op');
      process.exit(0);
    } else {
      console.error('[SEED] ✗ partial ceremony state detected. Some prerequisite rows missing:');
      console.error(`  tenant:      ${checks[0].rows.length > 0 ? 'present' : 'MISSING'}`);
      console.error(`  version:     ${checks[1].rows.length > 0 ? 'present' : 'MISSING'}`);
      console.error(`  share_token: ${checks[2].rows.length > 0 ? 'present' : 'MISSING'}`);
      console.error(`  event:       ${checks[3].rows.length > 0 ? 'present' : 'MISSING'}`);
      console.error('Manual cleanup required before re-seeding. Halting.');
      process.exit(1);
    }
  }

  const client = await pg.pool.connect();
  try {
    await client.query('BEGIN');

    // ─── 0. Users row (FK target for jobs.owner_id) ──────────────────────
    console.log('[SEED] inserting public.users row (FK target for jobs)...');
    await client.query(
      `INSERT INTO public.users (user_id, created_at)
       VALUES ($1, NOW())
       ON CONFLICT (user_id) DO NOTHING`,
      [CEREMONY_OWNER_ID]
    );

    // ─── 1. Tenant ────────────────────────────────────────────────────────
    console.log('[SEED] inserting chiefos_tenants row...');
    await client.query(
      `INSERT INTO public.chiefos_tenants (id, name, owner_id, currency)
       VALUES ($1, $2, $3, 'CAD')
       ON CONFLICT (id) DO NOTHING`,
      [CEREMONY_TENANT_ID, 'Phase 2C Ceremony Tenant', CEREMONY_OWNER_ID]
    );

    // ─── 2. Job ──────────────────────────────────────────────────────────
    // jobs.id is a serial; we allocate a synthetic job_no and let PG assign
    // the int id. We fetch it back via RETURNING for use in the quote.
    console.log('[SEED] inserting jobs row...');
    // Check if a ceremony-marked job already exists.
    const jobLookup = await client.query(
      `SELECT id FROM public.jobs
        WHERE owner_id = $1 AND job_name = $2
        LIMIT 1`,
      [CEREMONY_OWNER_ID, 'Phase 2C Ceremony Job']
    );
    let jobId;
    if (jobLookup.rows.length > 0) {
      jobId = jobLookup.rows[0].id;
      console.log(`[SEED]   existing ceremony job found: id=${jobId}`);
    } else {
      // Allocate job_no as max+1 for this owner (jobs.job_no NOT NULL, no
      // auto-serial on that column).
      const jobNoRes = await client.query(
        `SELECT COALESCE(MAX(job_no), 0) + 1 AS next_no FROM public.jobs WHERE owner_id = $1`,
        [CEREMONY_OWNER_ID]
      );
      const nextJobNo = jobNoRes.rows[0].next_no;
      const jobInsert = await client.query(
        // Separate params for job_name (varchar) vs name (text) — PG can't
        // deduce a single type for $2 used in both slots.
        `INSERT INTO public.jobs (owner_id, job_name, job_no, status, name)
         VALUES ($1, $2, $3, 'active', $4)
         RETURNING id`,
        [CEREMONY_OWNER_ID, 'Phase 2C Ceremony Job', nextJobNo, 'Phase 2C Ceremony Job']
      );
      jobId = jobInsert.rows[0].id;
      console.log(`[SEED]   new ceremony job: id=${jobId}, job_no=${nextJobNo}`);
    }

    // ─── 3. Quote header ─────────────────────────────────────────────────
    // chiefos_quotes deferred FK on current_version_id lets us insert
    // header-then-version-then-UPDATE within one transaction.
    console.log('[SEED] inserting chiefos_quotes header...');
    await client.query(
      `INSERT INTO public.chiefos_quotes (
         id, tenant_id, owner_id, job_id,
         human_id, status, source,
         current_version_id
       )
       VALUES ($1, $2, $3, $4, $5, 'signed', 'system', NULL)`,
      [
        CEREMONY_QUOTE_ID,
        CEREMONY_TENANT_ID,
        CEREMONY_OWNER_ID,
        jobId,
        CEREMONY_HUMAN_ID,
      ]
    );

    // ─── 4. Quote version (signed + locked) ──────────────────────────────
    // status='signed' + locked_at set satisfies chiefos_qv_status_locked_consistency.
    // server_hash matches chiefos_qv_hash_format ^[0-9a-f]{64}$.
    // totals = 0/0/0 satisfies chiefos_qv_totals_balance (total = subtotal + tax).
    console.log('[SEED] inserting chiefos_quote_versions row (signed + locked)...');
    const customerSnapshot = {
      name: CEREMONY_CUSTOMER_NAME,
      email: CEREMONY_RECIPIENT_EMAIL,
      phone_e164: null,
      address: null,
    };
    const tenantSnapshot = {
      legal_name: 'Phase 2C Ceremony Tenant',
      brand_name: 'Phase 2C Ceremony Tenant',
      email: null,
      phone_e164: null,
    };
    await client.query(
      `INSERT INTO public.chiefos_quote_versions (
         id, quote_id, tenant_id, owner_id,
         version_no, status, project_title,
         currency, subtotal_cents, tax_cents, total_cents, deposit_cents,
         tax_rate_bps,
         customer_snapshot, tenant_snapshot,
         issued_at, sent_at, signed_at, locked_at,
         server_hash
       )
       VALUES (
         $1, $2, $3, $4,
         1, 'signed', $5,
         'CAD', 0, 0, 0, 0,
         0,
         $6::jsonb, $7::jsonb,
         NOW(), NOW(), NOW(), NOW(),
         $8
       )`,
      [
        CEREMONY_VERSION_ID,
        CEREMONY_QUOTE_ID,
        CEREMONY_TENANT_ID,
        CEREMONY_OWNER_ID,
        CEREMONY_PROJECT_TITLE,
        JSON.stringify(customerSnapshot),
        JSON.stringify(tenantSnapshot),
        CEREMONY_VERSION_HASH,
      ]
    );

    // ─── 5. Point quote.current_version_id at the version ────────────────
    console.log('[SEED] updating chiefos_quotes.current_version_id...');
    await client.query(
      `UPDATE public.chiefos_quotes
          SET current_version_id = $1
        WHERE id = $2`,
      [CEREMONY_VERSION_ID, CEREMONY_QUOTE_ID]
    );

    // ─── 6. Share token ──────────────────────────────────────────────────
    // CRITICAL: quote_version_id = CEREMONY_VERSION_ID (see top-of-file note).
    console.log('[SEED] inserting chiefos_quote_share_tokens row...');
    await client.query(
      `INSERT INTO public.chiefos_quote_share_tokens (
         id, tenant_id, owner_id, quote_version_id,
         token, recipient_name, recipient_channel, recipient_address,
         issued_at, absolute_expires_at
       )
       VALUES (
         $1, $2, $3, $4,
         $5, $6, 'email', $7,
         NOW(), NOW() + INTERVAL '30 days'
       )`,
      [
        CEREMONY_SHARE_TOKEN_ID,
        CEREMONY_TENANT_ID,
        CEREMONY_OWNER_ID,
        CEREMONY_VERSION_ID,
        CEREMONY_SHARE_TOKEN,
        CEREMONY_CUSTOMER_NAME,
        CEREMONY_RECIPIENT_EMAIL,
      ]
    );

    // ─── 7. Lifecycle.signed event ───────────────────────────────────────
    // Referenced by signature.signed_event_id at upload time via composite
    // FK chiefos_qs_signed_event_identity_fk (id, tenant_id, owner_id).
    // chiefos_qe_payload_signed CHECK requires payload.version_hash_at_sign
    // matching ^[0-9a-f]{64}$.
    console.log('[SEED] inserting chiefos_quote_events row (lifecycle.signed)...');
    const payload = { version_hash_at_sign: CEREMONY_VERSION_HASH };
    await client.query(
      `INSERT INTO public.chiefos_quote_events (
         id, tenant_id, owner_id, quote_id, quote_version_id,
         kind, actor_source, actor_user_id, emitted_at,
         payload, share_token_id
       )
       VALUES (
         $1, $2, $3, $4, $5,
         'lifecycle.signed', 'system', $3, NOW(),
         $6::jsonb, $7
       )`,
      [
        CEREMONY_SIGNED_EVENT_ID,
        CEREMONY_TENANT_ID,
        CEREMONY_OWNER_ID,
        CEREMONY_QUOTE_ID,
        CEREMONY_VERSION_ID,
        JSON.stringify(payload),
        CEREMONY_SHARE_TOKEN_ID,
      ]
    );

    await client.query('COMMIT');
    console.log('');
    console.log('[SEED] ✓ all ceremony prerequisite rows inserted:');
    console.log(`       tenant:      ${CEREMONY_TENANT_ID}`);
    console.log(`       job:         id=${jobId}`);
    console.log(`       quote:       ${CEREMONY_QUOTE_ID}`);
    console.log(`       version:     ${CEREMONY_VERSION_ID}`);
    console.log(`       share_token: ${CEREMONY_SHARE_TOKEN_ID}`);
    console.log(`       signed_evt:  ${CEREMONY_SIGNED_EVENT_ID}`);
    console.log('');
    console.log('Next: node scripts/ceremony_upload_phase2c.js');
    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('');
    console.error('[SEED] ✗ seed failed:', err.code, err.message);
    if (err.constraint) console.error('  constraint:', err.constraint);
    if (err.detail) console.error('  detail:    ', err.detail);
    process.exit(1);
  } finally {
    client.release();
  }
}

main().catch((err) => {
  console.error('[SEED] unexpected error:', err);
  process.exit(1);
});
