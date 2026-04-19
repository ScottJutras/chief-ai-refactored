// scripts/real_create_quote_mission.js
// Ceremonial first real CreateQuote against the Mission Exteriors tenant.
// Run once. Produces QT-YYYY-MM-DD-NNNN in production data.
//
// Usage:   node scripts/real_create_quote_mission.js
//
// This is NOT a test — it's a one-shot real write. Outputs the return
// shape and a SELECT dump of what was persisted.

require('dotenv').config();
const { randomUUID } = require('crypto');
const { handleCreateQuote } = require('../src/cil/quotes');
const pg = require('../services/postgres');

const MISSION_TENANT_UUID = '86907c28-a9ea-4318-819d-5a012192119b';
const MISSION_OWNER_ID = '19053279955'; // Scott's WhatsApp digits

(async () => {
  console.log('─── Ceremonial first real CreateQuote against Mission Exteriors ───');
  console.log(`tenant_id: ${MISSION_TENANT_UUID}`);
  console.log(`owner_id:  ${MISSION_OWNER_ID}`);
  console.log();

  const sourceMsgId = `first-real-createquote-${randomUUID()}`;
  const cil = {
    cil_version: '1.0',
    type: 'CreateQuote',
    tenant_id: MISSION_TENANT_UUID,
    source: 'whatsapp',
    source_msg_id: sourceMsgId,
    actor: { actor_id: MISSION_OWNER_ID, role: 'owner' },
    occurred_at: new Date().toISOString(),
    job: {
      job_name: 'ChiefOS First Real Quote (ceremonial)',
      create_if_missing: true,
    },
    needs_job_resolution: false,
    customer: {
      name: 'ChiefOS Internal Test',
      email: 'test@chiefos.internal',
      phone_e164: '+15195550000',
      address: '1 Test Way, London, ON',
    },
    project: {
      title: 'ChiefOS First Real CreateQuote',
      scope:
        'Ceremonial first quote produced by the new-idiom CreateQuote handler. ' +
        'Validates end-to-end flow against live production data: counter allocation, ' +
        'tenant snapshot resolution, event emission, plan gating.',
    },
    currency: 'CAD',
    tax_rate_bps: 1300,
    tax_code: 'HST-ON',
    line_items: [
      {
        sort_order: 0,
        description: 'First real CreateQuote — labour line',
        category: 'labour',
        qty: 1,
        unit_price_cents: 10000, // $100
      },
    ],
    deposit_cents: 0,
    payment_terms: {},
    warranty_snapshot: {},
    clauses_snapshot: {},
  };

  const ctx = {
    owner_id: MISSION_OWNER_ID,
    traceId: `ceremony-${Date.now()}`,
  };

  let result;
  try {
    result = await handleCreateQuote(cil, ctx);
  } catch (err) {
    console.error('handleCreateQuote threw:', err);
    process.exit(1);
  }

  console.log('─── handleCreateQuote result ──────────────────────────────────────');
  console.log(JSON.stringify(result, null, 2));
  console.log();

  if (!result.ok) {
    console.error('Handler returned ok: false — ceremony did not complete.');
    process.exit(1);
  }

  const quoteId = result.quote.id;
  const versionId = result.quote.version_id;

  console.log('─── SELECT verification ────────────────────────────────────────────');

  const quoteRow = await pg.query(
    `SELECT id, tenant_id, owner_id, job_id, customer_id, human_id,
            status, current_version_id, source, source_msg_id, created_at
       FROM public.chiefos_quotes WHERE id = $1`,
    [quoteId]
  );
  console.log('\nchiefos_quotes:');
  console.log(JSON.stringify(quoteRow.rows[0], null, 2));

  const versionRow = await pg.query(
    `SELECT id, quote_id, version_no, status, project_title,
            currency, subtotal_cents, tax_cents, total_cents, tax_rate_bps,
            locked_at, server_hash, created_at
       FROM public.chiefos_quote_versions WHERE id = $1`,
    [versionId]
  );
  console.log('\nchiefos_quote_versions:');
  console.log(JSON.stringify(versionRow.rows[0], null, 2));

  const lineItems = await pg.query(
    `SELECT sort_order, description, category,
            qty::text, unit_price_cents, line_subtotal_cents, line_tax_cents
       FROM public.chiefos_quote_line_items
      WHERE quote_version_id = $1
      ORDER BY sort_order ASC`,
    [versionId]
  );
  console.log('\nchiefos_quote_line_items:');
  console.log(JSON.stringify(lineItems.rows, null, 2));

  const events = await pg.query(
    `SELECT kind, quote_version_id, actor_source, actor_user_id,
            payload, emitted_at, global_seq
       FROM public.chiefos_quote_events
      WHERE quote_id = $1
      ORDER BY global_seq ASC`,
    [quoteId]
  );
  console.log('\nchiefos_quote_events:');
  console.log(JSON.stringify(events.rows, null, 2));

  const monthKey = new Date().toISOString().slice(0, 7);
  const usage = await pg.query(
    `SELECT owner_id, month_key, kind, units
       FROM public.usage_monthly_v2
      WHERE owner_id = $1 AND kind = 'quote_created' AND month_key = $2`,
    [MISSION_OWNER_ID, monthKey]
  );
  console.log('\nusage_monthly_v2 (quote_created):');
  console.log(JSON.stringify(usage.rows, null, 2));

  console.log('\n─── Ceremony complete ─────────────────────────────────────────────');
  console.log(`human_id: ${result.quote.human_id}`);
  console.log(`Quote row persists in production data. Leave as draft OR`);
  console.log(`manually void via: UPDATE public.chiefos_quotes SET`);
  console.log(`  status='voided', voided_at=NOW(), voided_reason='ceremony'`);
  console.log(`  WHERE id='${quoteId}';`);

  process.exit(0);
})();
