// scripts/ceremony_seed_phase_a_session4.js
// Idempotent seed for Phase A Session 4 VoidQuote ceremony. Creates a
// SENT-state quote at c6c6 deterministic identity, mirroring §28's seed
// posture (sent state, unlocked version, no signature). VoidQuote can fire
// from any of 5 prior states; this ceremony picks 'sent' as the
// representative path (most operationally common void source; avoids the
// signed/locked locked_at-NOT-NULL invariant chain).
//
// Inserts:
//   0. public.users           (FK target for jobs)
//   1. chiefos_tenants        (FK target for quotes)
//   2. jobs                   (FK target for quotes)
//   3. chiefos_quotes         (status='sent')
//   4. chiefos_quote_versions (status='sent', locked_at=NULL — pre-sign)
//   5. UPDATE quotes.current_version_id
//   6. chiefos_quote_line_items (1 item; pre-locked version → INSERT allowed)
//   7. chiefos_quote_share_tokens (anchor for synthetic event chain)
//   8. chiefos_quote_events kind=lifecycle.sent (synthetic;
//      payload.ceremony_synthetic=true)
//
// Does NOT insert: lifecycle.voided event — that's emitted by the ceremony's
// real handleVoidQuote invocation. Does NOT insert: signature row, signed
// event — sent state has neither.

require('dotenv').config();
const pg = require('../services/postgres');

const {
  CEREMONY_TENANT_ID, CEREMONY_OWNER_ID,
  CEREMONY_QUOTE_ID, CEREMONY_VERSION_ID,
  CEREMONY_SHARE_TOKEN_ID, CEREMONY_SENT_EVENT_ID,
  CEREMONY_LINE_ITEM_ID,
  CEREMONY_SHARE_TOKEN, CEREMONY_HUMAN_ID,
  CEREMONY_PROJECT_TITLE, CEREMONY_CUSTOMER_NAME,
  CEREMONY_RECIPIENT_EMAIL,
} = require('./_phase_a_session4_constants');

async function main() {
  console.log('─── Phase A Session 4 VoidQuote ceremony seed ─────────────');
  console.log(`tenant_id:       ${CEREMONY_TENANT_ID}`);
  console.log(`owner_id:        ${CEREMONY_OWNER_ID}`);
  console.log(`quote_id:        ${CEREMONY_QUOTE_ID}  (status='sent')`);
  console.log(`version_id:      ${CEREMONY_VERSION_ID}  (status='sent', locked_at=NULL)`);
  console.log(`share_token_id:  ${CEREMONY_SHARE_TOKEN_ID}`);
  console.log(`share_token:     ${CEREMONY_SHARE_TOKEN}`);
  console.log(`sent_event_id:   ${CEREMONY_SENT_EVENT_ID}  (synthetic)`);
  console.log(`human_id:        ${CEREMONY_HUMAN_ID}`);
  console.log('');

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
      pg.query(`SELECT 1 FROM public.chiefos_quote_line_items   WHERE id = $1`, [CEREMONY_LINE_ITEM_ID]),
    ]);
    const allPresent = checks.every((r) => r.rows.length > 0);
    if (allPresent) {
      console.log('[SEED] ✓ all prerequisite rows present — no-op');
      process.exit(0);
    } else {
      console.error('[SEED] ✗ partial ceremony state detected:');
      console.error(`  tenant:      ${checks[0].rows.length > 0 ? 'present' : 'MISSING'}`);
      console.error(`  version:     ${checks[1].rows.length > 0 ? 'present' : 'MISSING'}`);
      console.error(`  share_token: ${checks[2].rows.length > 0 ? 'present' : 'MISSING'}`);
      console.error(`  sent_event:  ${checks[3].rows.length > 0 ? 'present' : 'MISSING'}`);
      console.error(`  line_item:   ${checks[4].rows.length > 0 ? 'present' : 'MISSING'}`);
      console.error('Manual cleanup required before re-seeding. Halting.');
      process.exit(1);
    }
  }

  const client = await pg.pool.connect();
  try {
    await client.query('BEGIN');

    // ─── 0. users ──────────────────────────────────────────────────────
    console.log('[SEED] inserting public.users...');
    await client.query(
      `INSERT INTO public.users (user_id, created_at)
       VALUES ($1, NOW())
       ON CONFLICT (user_id) DO NOTHING`,
      [CEREMONY_OWNER_ID]
    );

    // ─── 1. chiefos_tenants ────────────────────────────────────────────
    console.log('[SEED] inserting chiefos_tenants...');
    await client.query(
      `INSERT INTO public.chiefos_tenants (id, name, owner_id, currency)
       VALUES ($1, $2, $3, 'CAD')
       ON CONFLICT (id) DO NOTHING`,
      [CEREMONY_TENANT_ID, 'Phase A Session 4 Ceremony Tenant', CEREMONY_OWNER_ID]
    );

    // ─── 2. jobs ───────────────────────────────────────────────────────
    console.log('[SEED] inserting jobs row...');
    const jobLookup = await client.query(
      `SELECT id FROM public.jobs
        WHERE owner_id = $1 AND job_name = $2
        LIMIT 1`,
      [CEREMONY_OWNER_ID, 'Phase A Session 4 Ceremony Job']
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
        [CEREMONY_OWNER_ID, 'Phase A Session 4 Ceremony Job', nextJobNo, 'Phase A Session 4 Ceremony Job']
      );
      jobId = jobInsert.rows[0].id;
      console.log(`[SEED]   new ceremony job: id=${jobId}, job_no=${nextJobNo}`);
    }

    // ─── 3. chiefos_quotes (status='sent') ─────────────────────────────
    console.log('[SEED] inserting chiefos_quotes header (status=sent)...');
    await client.query(
      `INSERT INTO public.chiefos_quotes (
         id, tenant_id, owner_id, job_id,
         human_id, status, source, current_version_id
       )
       VALUES ($1, $2, $3, $4, $5, 'sent', 'system', NULL)`,
      [CEREMONY_QUOTE_ID, CEREMONY_TENANT_ID, CEREMONY_OWNER_ID, jobId, CEREMONY_HUMAN_ID]
    );

    // ─── 4. chiefos_quote_versions (status='sent', unlocked) ───────────
    console.log('[SEED] inserting chiefos_quote_versions (sent, unlocked)...');
    const customerSnapshot = {
      name: CEREMONY_CUSTOMER_NAME,
      email: CEREMONY_RECIPIENT_EMAIL,
      phone_e164: null,
      address: null,
    };
    const tenantSnapshot = {
      legal_name: 'Phase A Session 4 Ceremony Tenant',
      brand_name: 'Phase A Session 4 VoidQuote Ceremony',
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
         1, 'sent', $5,
         'CAD', 10000, 0, 10000, 0,
         0,
         $6::jsonb, $7::jsonb,
         NOW(), NOW(),
         NULL, NULL, NULL, NULL
       )`,
      [
        CEREMONY_VERSION_ID, CEREMONY_QUOTE_ID,
        CEREMONY_TENANT_ID, CEREMONY_OWNER_ID,
        CEREMONY_PROJECT_TITLE,
        JSON.stringify(customerSnapshot), JSON.stringify(tenantSnapshot),
      ]
    );

    // ─── 5. Point quote.current_version_id at version ──────────────────
    console.log('[SEED] updating chiefos_quotes.current_version_id...');
    await client.query(
      `UPDATE public.chiefos_quotes SET current_version_id = $1 WHERE id = $2`,
      [CEREMONY_VERSION_ID, CEREMONY_QUOTE_ID]
    );

    // ─── 6. chiefos_quote_line_items ───────────────────────────────────
    console.log('[SEED] inserting chiefos_quote_line_items (1 item)...');
    await client.query(
      `INSERT INTO public.chiefos_quote_line_items (
         id, quote_version_id, tenant_id, owner_id,
         sort_order, description, category,
         qty, unit_price_cents, line_subtotal_cents, line_tax_cents,
         tax_code, catalog_product_id, catalog_snapshot
       )
       VALUES (
         $1, $2, $3, $4,
         0, 'Phase A Session 4 Ceremony Line Item', 'other',
         1, 10000, 10000, 0,
         NULL, NULL, '{}'::jsonb
       )`,
      [CEREMONY_LINE_ITEM_ID, CEREMONY_VERSION_ID, CEREMONY_TENANT_ID, CEREMONY_OWNER_ID]
    );

    // ─── 7. chiefos_quote_share_tokens ─────────────────────────────────
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
         NOW(), NOW() + INTERVAL '30 days'
       )`,
      [
        CEREMONY_SHARE_TOKEN_ID, CEREMONY_TENANT_ID, CEREMONY_OWNER_ID,
        CEREMONY_VERSION_ID, CEREMONY_SHARE_TOKEN,
        CEREMONY_CUSTOMER_NAME, CEREMONY_RECIPIENT_EMAIL,
      ]
    );

    // ─── 8. Synthetic lifecycle.sent event ─────────────────────────────
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
         'lifecycle.sent', 'system', $3, NOW(),
         $6, $7::jsonb
       )`,
      [
        CEREMONY_SENT_EVENT_ID, CEREMONY_TENANT_ID, CEREMONY_OWNER_ID,
        CEREMONY_QUOTE_ID, CEREMONY_VERSION_ID,
        CEREMONY_SHARE_TOKEN_ID, JSON.stringify(sentPayload),
      ]
    );

    await client.query('COMMIT');
    console.log('');
    console.log('[SEED] ✓ all ceremony prerequisite rows inserted:');
    console.log(`       tenant:      ${CEREMONY_TENANT_ID}`);
    console.log(`       job:         id=${jobId}`);
    console.log(`       quote:       ${CEREMONY_QUOTE_ID} (sent)`);
    console.log(`       version:     ${CEREMONY_VERSION_ID} (sent, unlocked)`);
    console.log(`       line_item:   ${CEREMONY_LINE_ITEM_ID}`);
    console.log(`       share_token: ${CEREMONY_SHARE_TOKEN_ID}`);
    console.log(`       sent_event:  ${CEREMONY_SENT_EVENT_ID}`);
    console.log('');
    console.log('Next: node scripts/real_void_quote_ceremony.js');
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
