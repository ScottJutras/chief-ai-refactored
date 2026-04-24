// scripts/ceremony_seed_phase_a_session3.js
// Idempotent seed for Phase A Session 3 LockQuote ceremony. Creates a
// SIGNED-state quote (+ version with locked_at set per §3A post-sign
// immutability + signature row + lifecycle.sent + lifecycle.signed events)
// at c5c5 deterministic identity, matching §27/§28 seed-via-explicit-INSERT
// posture (not handler chain — handlers allocate fresh UUIDs internally).
//
// LockQuote's loadLockContext requires the pre-state to be `quote.status='signed'`
// with `version.status='signed'` and `version.locked_at IS NOT NULL` (§17.22
// invariant enforced by loadLockContext lines ~4000-4070). This seed produces
// exactly that state so `handleLockQuote` exercises the happy-path
// signed→locked header transition.
//
// Inserts:
//   0. public.users           (FK target for jobs)
//   1. chiefos_tenants        (FK target for quotes)
//   2. jobs                   (FK target for quotes)
//   3. chiefos_quotes         (status='signed')
//   4. chiefos_quote_versions (status='signed', locked_at set, server_hash set;
//      totals 0/0/0 — matches §27 Phase 2C posture; line_items omitted because
//      a locked version's line_item INSERT is forbidden by
//      chiefos_qli_parent_locked trigger)
//   5. UPDATE quotes.current_version_id
//   6. chiefos_quote_share_tokens (anchor for synthetic event chain)
//   7. chiefos_quote_events kind=lifecycle.sent   (synthetic; payload.ceremony_synthetic=true)
//   8. chiefos_quote_events kind=lifecycle.signed (synthetic; payload.version_hash_at_sign + ceremony_synthetic=true)
//   9. chiefos_quote_signatures (references signed_event_id from #8; Phase 2C precedent)
//
// Does NOT insert: lifecycle.locked event — that's emitted by the ceremony's
// real handleLockQuote invocation.
//
// Signature-row note: §27/§28 ceremonies omit the PNG-upload path (that's
// Phase 2C scope). This seed inserts a schema-satisfying signature row with
// synthetic storage_key + sha256; no bucket upload. LockQuote's
// loadLockContext does NOT read chiefos_quote_signatures, so the signature
// row's role here is solely FK-anchor for the lifecycle.signed event's
// signed_event_id reverse pointer consistency.

require('dotenv').config();
const pg = require('../services/postgres');

const {
  CEREMONY_TENANT_ID, CEREMONY_OWNER_ID,
  CEREMONY_QUOTE_ID, CEREMONY_VERSION_ID,
  CEREMONY_SHARE_TOKEN_ID,
  CEREMONY_SENT_EVENT_ID, CEREMONY_SIGNED_EVENT_ID,
  CEREMONY_SIGNATURE_ID,
  CEREMONY_SHARE_TOKEN, CEREMONY_HUMAN_ID,
  CEREMONY_PROJECT_TITLE, CEREMONY_CUSTOMER_NAME,
  CEREMONY_RECIPIENT_EMAIL,
  CEREMONY_SIGNATURE_STORAGE_KEY, CEREMONY_SIGNATURE_SHA256,
} = require('./_phase_a_session3_constants');

// 64-char lowercase-hex synthetic version_hash (satisfies chiefos_qv_hash_format
// and chiefos_qe_payload_signed CHECK regex ^[0-9a-f]{64}$). Matches the
// signature row's version_hash_at_sign.
const CEREMONY_VERSION_HASH =
  'c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5';

async function main() {
  console.log('─── Phase A Session 3 LockQuote ceremony seed ──────────────');
  console.log(`tenant_id:        ${CEREMONY_TENANT_ID}`);
  console.log(`owner_id:         ${CEREMONY_OWNER_ID}`);
  console.log(`quote_id:         ${CEREMONY_QUOTE_ID}  (status='signed')`);
  console.log(`version_id:       ${CEREMONY_VERSION_ID}  (status='signed', locked_at set)`);
  console.log(`share_token_id:   ${CEREMONY_SHARE_TOKEN_ID}`);
  console.log(`share_token:      ${CEREMONY_SHARE_TOKEN}`);
  console.log(`sent_event_id:    ${CEREMONY_SENT_EVENT_ID}  (synthetic)`);
  console.log(`signed_event_id:  ${CEREMONY_SIGNED_EVENT_ID}  (synthetic)`);
  console.log(`signature_id:     ${CEREMONY_SIGNATURE_ID}  (synthetic; no bucket upload)`);
  console.log(`human_id:         ${CEREMONY_HUMAN_ID}`);
  console.log(`version_hash:     ${CEREMONY_VERSION_HASH}  (synthetic)`);
  console.log('');

  // Idempotency — if the c5c5 quote already exists with all prerequisites,
  // exit 0. If partial state, halt loudly (manual cleanup required).
  const existing = await pg.query(
    `SELECT id, status FROM public.chiefos_quotes WHERE id = $1`,
    [CEREMONY_QUOTE_ID]
  );
  if (existing.rows.length > 0) {
    console.log(`[SEED] ceremony quote already present (status='${existing.rows[0].status}')`);
    const checks = await Promise.all([
      pg.query(`SELECT 1 FROM public.chiefos_tenants            WHERE id = $1`, [CEREMONY_TENANT_ID]),
      pg.query(`SELECT 1 FROM public.chiefos_quote_versions     WHERE id = $1`, [CEREMONY_VERSION_ID]),
      pg.query(`SELECT 1 FROM public.chiefos_quote_share_tokens WHERE id = $1`, [CEREMONY_SHARE_TOKEN_ID]),
      pg.query(`SELECT 1 FROM public.chiefos_quote_events       WHERE id = $1`, [CEREMONY_SENT_EVENT_ID]),
      pg.query(`SELECT 1 FROM public.chiefos_quote_events       WHERE id = $1`, [CEREMONY_SIGNED_EVENT_ID]),
      pg.query(`SELECT 1 FROM public.chiefos_quote_signatures   WHERE id = $1`, [CEREMONY_SIGNATURE_ID]),
    ]);
    const allPresent = checks.every((r) => r.rows.length > 0);
    if (allPresent) {
      console.log('[SEED] ✓ all prerequisite rows present — no-op');
      process.exit(0);
    }
    console.error('[SEED] ✗ partial ceremony state detected:');
    console.error(`  tenant:       ${checks[0].rows.length > 0 ? 'present' : 'MISSING'}`);
    console.error(`  version:      ${checks[1].rows.length > 0 ? 'present' : 'MISSING'}`);
    console.error(`  share_token:  ${checks[2].rows.length > 0 ? 'present' : 'MISSING'}`);
    console.error(`  sent_event:   ${checks[3].rows.length > 0 ? 'present' : 'MISSING'}`);
    console.error(`  signed_event: ${checks[4].rows.length > 0 ? 'present' : 'MISSING'}`);
    console.error(`  signature:    ${checks[5].rows.length > 0 ? 'present' : 'MISSING'}`);
    console.error('Manual cleanup required before re-seeding. Halting.');
    process.exit(1);
  }

  const client = await pg.pool.connect();
  try {
    await client.query('BEGIN');

    // ─── 0. users ──────────────────────────────────────────────────────────
    console.log('[SEED] inserting public.users...');
    await client.query(
      `INSERT INTO public.users (user_id, created_at)
       VALUES ($1, NOW())
       ON CONFLICT (user_id) DO NOTHING`,
      [CEREMONY_OWNER_ID]
    );

    // ─── 1. chiefos_tenants ────────────────────────────────────────────────
    console.log('[SEED] inserting chiefos_tenants...');
    await client.query(
      `INSERT INTO public.chiefos_tenants (id, name, owner_id, currency)
       VALUES ($1, $2, $3, 'CAD')
       ON CONFLICT (id) DO NOTHING`,
      [CEREMONY_TENANT_ID, 'Phase A Session 3 Ceremony Tenant', CEREMONY_OWNER_ID]
    );

    // ─── 2. jobs ───────────────────────────────────────────────────────────
    console.log('[SEED] inserting jobs row...');
    const jobLookup = await client.query(
      `SELECT id FROM public.jobs
        WHERE owner_id = $1 AND job_name = $2
        LIMIT 1`,
      [CEREMONY_OWNER_ID, 'Phase A Session 3 Ceremony Job']
    );
    let jobId;
    if (jobLookup.rows.length > 0) {
      jobId = jobLookup.rows[0].id;
      console.log(`[SEED]   existing ceremony job found: id=${jobId}`);
    } else {
      const jobNoRes = await client.query(
        `SELECT COALESCE(MAX(job_no), 0) + 1 AS next_no FROM public.jobs WHERE owner_id = $1`,
        [CEREMONY_OWNER_ID]
      );
      const nextJobNo = jobNoRes.rows[0].next_no;
      const jobInsert = await client.query(
        `INSERT INTO public.jobs (owner_id, job_name, job_no, status, name)
         VALUES ($1, $2, $3, 'active', $4)
         RETURNING id`,
        [CEREMONY_OWNER_ID, 'Phase A Session 3 Ceremony Job', nextJobNo, 'Phase A Session 3 Ceremony Job']
      );
      jobId = jobInsert.rows[0].id;
      console.log(`[SEED]   new ceremony job: id=${jobId}, job_no=${nextJobNo}`);
    }

    // ─── 3. chiefos_quotes (status='signed') ───────────────────────────────
    console.log('[SEED] inserting chiefos_quotes header (status=signed)...');
    await client.query(
      `INSERT INTO public.chiefos_quotes (
         id, tenant_id, owner_id, job_id,
         human_id, status, source, current_version_id
       )
       VALUES ($1, $2, $3, $4, $5, 'signed', 'system', NULL)`,
      [CEREMONY_QUOTE_ID, CEREMONY_TENANT_ID, CEREMONY_OWNER_ID, jobId, CEREMONY_HUMAN_ID]
    );

    // ─── 4. chiefos_quote_versions (status='signed', locked_at set) ────────
    // §17.22 invariant: `status='signed'` implies `locked_at IS NOT NULL`.
    // §3A: post-sign version row is immutable — LockQuote does NOT touch it,
    // so locked_at here is the version's final value (pass-through through
    // the ceremony).
    console.log('[SEED] inserting chiefos_quote_versions (signed, locked)...');
    const customerSnapshot = {
      name: CEREMONY_CUSTOMER_NAME,
      email: CEREMONY_RECIPIENT_EMAIL,
      phone_e164: null,
      address: null,
    };
    const tenantSnapshot = {
      legal_name: 'Phase A Session 3 Ceremony Tenant',
      brand_name: 'Phase A Session 3 LockQuote Ceremony',
      email: 'scott.tirakian@gmail.com',
      phone_e164: null,
    };
    await client.query(
      `INSERT INTO public.chiefos_quote_versions (
         id, quote_id, tenant_id, owner_id,
         version_no, status, project_title,
         currency, subtotal_cents, tax_cents, total_cents, deposit_cents,
         tax_rate_bps,
         customer_snapshot, tenant_snapshot,
         issued_at, sent_at,
         viewed_at, signed_at, locked_at, server_hash
       )
       VALUES (
         $1, $2, $3, $4,
         1, 'signed', $5,
         'CAD', 0, 0, 0, 0,
         0,
         $6::jsonb, $7::jsonb,
         NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '2 minutes',
         NOW() - INTERVAL '90 seconds', NOW() - INTERVAL '60 seconds',
         NOW() - INTERVAL '60 seconds', $8
       )`,
      [
        CEREMONY_VERSION_ID, CEREMONY_QUOTE_ID,
        CEREMONY_TENANT_ID, CEREMONY_OWNER_ID,
        CEREMONY_PROJECT_TITLE,
        JSON.stringify(customerSnapshot), JSON.stringify(tenantSnapshot),
        CEREMONY_VERSION_HASH,
      ]
    );

    // ─── 5. Point quote.current_version_id at version ──────────────────────
    console.log('[SEED] updating chiefos_quotes.current_version_id...');
    await client.query(
      `UPDATE public.chiefos_quotes SET current_version_id = $1 WHERE id = $2`,
      [CEREMONY_VERSION_ID, CEREMONY_QUOTE_ID]
    );

    // ─── (line_items omitted) ───────────────────────────────────────────────
    // Phase 2C precedent: signed-state seed skips line_items because
    // chiefos_qli_parent_locked trigger forbids INSERTs on a locked version.
    // Totals zeroed above to satisfy chiefos_qv_totals_balance
    // (total = subtotal + tax).

    // ─── 6. chiefos_quote_share_tokens ─────────────────────────────────────
    console.log('[SEED] inserting chiefos_quote_share_tokens...');
    await client.query(
      `INSERT INTO public.chiefos_quote_share_tokens (
         id, tenant_id, owner_id, quote_version_id,
         token, recipient_name, recipient_channel, recipient_address,
         issued_at, absolute_expires_at
       )
       VALUES (
         $1, $2, $3, $4,
         $5, $6, 'email', $7,
         NOW() - INTERVAL '3 minutes', NOW() + INTERVAL '30 days'
       )`,
      [
        CEREMONY_SHARE_TOKEN_ID, CEREMONY_TENANT_ID, CEREMONY_OWNER_ID,
        CEREMONY_VERSION_ID, CEREMONY_SHARE_TOKEN,
        CEREMONY_CUSTOMER_NAME, CEREMONY_RECIPIENT_EMAIL,
      ]
    );

    // ─── 7. Synthetic lifecycle.sent event ─────────────────────────────────
    console.log('[SEED] inserting synthetic lifecycle.sent event...');
    const sentPayload = {
      recipient_channel: 'email',
      recipient_address: CEREMONY_RECIPIENT_EMAIL,
      recipient_name: CEREMONY_CUSTOMER_NAME,
      ceremony_synthetic: true,
    };
    await client.query(
      `INSERT INTO public.chiefos_quote_events (
         id, tenant_id, owner_id, quote_id, quote_version_id,
         kind, actor_source, actor_user_id, emitted_at,
         share_token_id, payload
       )
       VALUES (
         $1, $2, $3, $4, $5,
         'lifecycle.sent', 'system', $3, NOW() - INTERVAL '2 minutes',
         $6, $7::jsonb
       )`,
      [
        CEREMONY_SENT_EVENT_ID, CEREMONY_TENANT_ID, CEREMONY_OWNER_ID,
        CEREMONY_QUOTE_ID, CEREMONY_VERSION_ID,
        CEREMONY_SHARE_TOKEN_ID, JSON.stringify(sentPayload),
      ]
    );

    // ─── 8. Synthetic lifecycle.signed event ───────────────────────────────
    // chiefos_qe_payload_signed CHECK requires payload.version_hash_at_sign
    // matching ^[0-9a-f]{64}$. Phase 2C precedent (ceremony_seed_phase2c.js)
    // inserts without signature_id populated; same pattern here.
    console.log('[SEED] inserting synthetic lifecycle.signed event...');
    const signedPayload = {
      version_hash_at_sign: CEREMONY_VERSION_HASH,
      ceremony_synthetic: true,
    };
    await client.query(
      `INSERT INTO public.chiefos_quote_events (
         id, tenant_id, owner_id, quote_id, quote_version_id,
         kind, actor_source, actor_user_id, emitted_at,
         share_token_id, payload
       )
       VALUES (
         $1, $2, $3, $4, $5,
         'lifecycle.signed', 'system', $3, NOW() - INTERVAL '60 seconds',
         $6, $7::jsonb
       )`,
      [
        CEREMONY_SIGNED_EVENT_ID, CEREMONY_TENANT_ID, CEREMONY_OWNER_ID,
        CEREMONY_QUOTE_ID, CEREMONY_VERSION_ID,
        CEREMONY_SHARE_TOKEN_ID, JSON.stringify(signedPayload),
      ]
    );

    // ─── 9. Synthetic signature row ───────────────────────────────────────
    // Schema-satisfying; no bucket upload. LockQuote's loadLockContext does
    // NOT read chiefos_quote_signatures — this row exists for event-chain
    // coherence (lifecycle.signed's signed_event_id reverse anchor) and for
    // future post-Phase-A auditors that cross-reference signatures against
    // locked quotes.
    console.log('[SEED] inserting synthetic chiefos_quote_signatures row...');
    await client.query(
      `INSERT INTO public.chiefos_quote_signatures (
         id, quote_version_id, tenant_id, owner_id,
         signed_event_id, share_token_id,
         signer_name, signer_email,
         signed_at,
         signature_png_storage_key, signature_png_sha256,
         version_hash_at_sign,
         name_match_at_sign, recipient_name_at_sign
       )
       VALUES (
         $1, $2, $3, $4,
         $5, $6,
         $7, $8,
         NOW() - INTERVAL '60 seconds',
         $9, $10,
         $11,
         true, $12
       )`,
      [
        CEREMONY_SIGNATURE_ID,
        CEREMONY_VERSION_ID,
        CEREMONY_TENANT_ID,
        CEREMONY_OWNER_ID,
        CEREMONY_SIGNED_EVENT_ID,
        CEREMONY_SHARE_TOKEN_ID,
        CEREMONY_CUSTOMER_NAME,
        CEREMONY_RECIPIENT_EMAIL,
        CEREMONY_SIGNATURE_STORAGE_KEY,
        CEREMONY_SIGNATURE_SHA256,
        CEREMONY_VERSION_HASH,
        CEREMONY_CUSTOMER_NAME,
      ]
    );

    await client.query('COMMIT');
    console.log('');
    console.log('[SEED] ✓ all ceremony prerequisite rows inserted:');
    console.log(`       tenant:       ${CEREMONY_TENANT_ID}`);
    console.log(`       job:          id=${jobId}`);
    console.log(`       quote:        ${CEREMONY_QUOTE_ID} (signed)`);
    console.log(`       version:      ${CEREMONY_VERSION_ID} (signed, locked)`);
    console.log(`       share_token:  ${CEREMONY_SHARE_TOKEN_ID}`);
    console.log(`       sent_event:   ${CEREMONY_SENT_EVENT_ID}`);
    console.log(`       signed_event: ${CEREMONY_SIGNED_EVENT_ID}`);
    console.log(`       signature:    ${CEREMONY_SIGNATURE_ID}`);
    console.log('');
    console.log('Next: node scripts/real_lock_quote_ceremony.js');
    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('');
    console.error('[SEED] ✗ seed failed:', err.code, err.message);
    if (err.constraint) console.error('  constraint:', err.constraint);
    if (err.detail)     console.error('  detail:    ', err.detail);
    process.exit(1);
  } finally {
    client.release();
  }
}

main().catch((err) => {
  console.error('[SEED] unexpected error:', err);
  process.exit(2);
});
