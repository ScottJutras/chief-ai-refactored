// scripts/real_reissue_quote_ceremony.js
// Ceremonial first real ReissueQuote against the Phase A Session 5 synthetic
// tenant. Invokes handleReissueQuote directly (bypassing router) to exercise
// the full Step 0-6 sequence against production Postgres. Parallels §31's
// real_void_quote_ceremony.js posture.
//
// §17.8 entity-table dedup: re-runs on this deterministic ceremony pass
// through chiefos_qv_source_msg_unique → idempotent_retry path
// (alreadyReissuedReturnShape — Step 6a), NOT the happy-path voided→draft
// transition. First run is the sole happy-path exercise. Seed teardown +
// re-seed required to re-run the happy path.
//
// §3A precondition: prior status MUST be 'voided'. The seed step builds the
// voided quote inline (header + version + line item + voided state). Without
// the seed, the ceremony fails with QUOTE_NOT_FOUND_OR_CROSS_OWNER on first
// run.
//
// Supersession invariant locked: after the happy-path run, the prior version
// row (CEREMONY_PRIOR_VERSION_ID) is no longer chiefos_quotes.current_
// version_id. The new constitutional immutability extension
// (Migration 2026_04_25) blocks UPDATE/DELETE on the prior version. Anomaly
// check #6 verifies a sentinel UPDATE attempt raises the supersession error.
//
// Exit codes:
//   0 — ceremony succeeded (first run happy-path OR idempotent already-reissued retry)
//   1 — handler returned ok:false (state-machine rejection; details in envelope)
//   2 — uncaught exception (integration gap; diagnostic in stderr)
//   3 — anomaly detected (post-state expectation drift; halt for investigation)

require('dotenv').config();
const pg = require('../services/postgres');
const { handleReissueQuote } = require('../src/cil/quotes');

const {
  CEREMONY_TENANT_ID, CEREMONY_OWNER_ID,
  CEREMONY_QUOTE_ID, CEREMONY_PRIOR_VERSION_ID, CEREMONY_LINE_ITEM_ID,
  CEREMONY_HUMAN_ID, CEREMONY_PROJECT_TITLE, CEREMONY_CUSTOMER_NAME,
  CEREMONY_REISSUE_SOURCE_MSG_ID,
} = require('./_phase_a_session5_constants');

async function ensureSeed() {
  // Idempotent seed: only inserts when rows don't already exist. Re-running
  // the ceremony past the first happy-path run leaves the seed alone (the
  // header is now status='draft' from the reissue, not 'voided' — but the
  // already-reissued retry path uses lookupPriorReissuedVersion which only
  // needs (owner_id, source_msg_id), not the header status).
  await pg.query(
    `INSERT INTO public.users (user_id, plan_key, sub_status, created_at)
     VALUES ($1, 'free', 'active', NOW())
     ON CONFLICT (user_id) DO NOTHING`,
    [CEREMONY_OWNER_ID]
  );

  // Customer
  const { rows: cRows } = await pg.query(
    `INSERT INTO public.customers (tenant_id, name, email, phone, address)
     SELECT $1, $2, 'phase-a-s5-ceremony@chiefos.invalid', '+15195550005', '5 Ceremony Way'
     WHERE NOT EXISTS (
       SELECT 1 FROM public.customers WHERE tenant_id=$1 AND name=$2 LIMIT 1
     )
     RETURNING id`,
    [CEREMONY_TENANT_ID, CEREMONY_CUSTOMER_NAME]
  );
  let customerId;
  if (cRows.length === 0) {
    const { rows } = await pg.query(
      `SELECT id FROM public.customers WHERE tenant_id=$1 AND name=$2 LIMIT 1`,
      [CEREMONY_TENANT_ID, CEREMONY_CUSTOMER_NAME]
    );
    customerId = rows[0].id;
  } else {
    customerId = cRows[0].id;
  }

  // Job
  const { rows: jRows } = await pg.query(
    `INSERT INTO public.jobs
       (owner_id, job_no, job_name, name, active, start_date, status, created_at, updated_at)
     SELECT $1, 1, $2, $2, true, NOW(), 'active', NOW(), NOW()
     WHERE NOT EXISTS (
       SELECT 1 FROM public.jobs WHERE owner_id=$1 AND job_name=$2 LIMIT 1
     )
     RETURNING id`,
    [CEREMONY_OWNER_ID, `${CEREMONY_PROJECT_TITLE} Job`]
  );
  let jobId;
  if (jRows.length === 0) {
    const { rows } = await pg.query(
      `SELECT id FROM public.jobs WHERE owner_id=$1 AND job_name=$2 LIMIT 1`,
      [CEREMONY_OWNER_ID, `${CEREMONY_PROJECT_TITLE} Job`]
    );
    jobId = rows[0].id;
  } else {
    jobId = jRows[0].id;
  }

  // Quote header (voided state)
  await pg.query(
    `INSERT INTO public.chiefos_quotes
        (id, tenant_id, owner_id, job_id, customer_id, human_id,
         status, current_version_id, source, source_msg_id,
         voided_at, voided_reason, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6,
             'voided', $7, 'whatsapp', 'ceremony-phase-a-s5-create-seed',
             NOW(), 'Phase A Session 5 ceremony seed — voided in fixture',
             NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [
      CEREMONY_QUOTE_ID, CEREMONY_TENANT_ID, CEREMONY_OWNER_ID,
      jobId, customerId, CEREMONY_HUMAN_ID, CEREMONY_PRIOR_VERSION_ID,
    ]
  );

  // Version 1
  await pg.query(
    `INSERT INTO public.chiefos_quote_versions
        (id, quote_id, tenant_id, owner_id, version_no, status,
         project_title, currency, subtotal_cents, tax_cents, total_cents,
         deposit_cents, tax_rate_bps,
         warranty_snapshot, clauses_snapshot, tenant_snapshot,
         customer_snapshot, payment_terms,
         created_at)
     VALUES ($1, $2, $3, $4, 1, 'sent',
             $5, 'CAD', 100000, 13000, 113000,
             0, 1300,
             '{}'::jsonb, '{}'::jsonb,
             '{"legal_name":"Ceremony Tenant","address":"5 Ceremony Way"}'::jsonb,
             $6, '{}'::jsonb,
             NOW())
     ON CONFLICT (id) DO NOTHING`,
    [
      CEREMONY_PRIOR_VERSION_ID, CEREMONY_QUOTE_ID, CEREMONY_TENANT_ID, CEREMONY_OWNER_ID,
      CEREMONY_PROJECT_TITLE,
      JSON.stringify({ name: CEREMONY_CUSTOMER_NAME, email: 'phase-a-s5-ceremony@chiefos.invalid' }),
    ]
  );

  // Line item
  await pg.query(
    `INSERT INTO public.chiefos_quote_line_items
        (id, quote_version_id, tenant_id, owner_id,
         sort_order, description, qty, unit_price_cents,
         line_subtotal_cents, line_tax_cents, created_at)
     VALUES ($1, $2, $3, $4, 0, 'Ceremony cabinet install', 1, 100000,
             100000, 13000, NOW())
     ON CONFLICT (id) DO NOTHING`,
    [
      CEREMONY_LINE_ITEM_ID, CEREMONY_PRIOR_VERSION_ID,
      CEREMONY_TENANT_ID, CEREMONY_OWNER_ID,
    ]
  );
}

async function captureState(label) {
  const r = await pg.query(
    `SELECT q.status        AS q_status,
            q.current_version_id,
            q.voided_at,
            q.voided_reason,
            q.updated_at
       FROM public.chiefos_quotes q
      WHERE q.id = $1`,
    [CEREMONY_QUOTE_ID]
  );
  const v = await pg.query(
    `SELECT id, version_no, status, source_msg_id, created_at
       FROM public.chiefos_quote_versions
      WHERE quote_id = $1
      ORDER BY version_no`,
    [CEREMONY_QUOTE_ID]
  );
  const e = await pg.query(
    `SELECT kind, payload, emitted_at
       FROM public.chiefos_quote_events
      WHERE quote_id = $1 AND kind = 'lifecycle.version_created'
      ORDER BY emitted_at`,
    [CEREMONY_QUOTE_ID]
  );
  console.log(`\n=== ${label} ===`);
  console.log('header:', r.rows[0]);
  console.log('versions:', v.rows);
  console.log('lifecycle.version_created events:', e.rows);
  return { header: r.rows[0], versions: v.rows, events: e.rows };
}

async function main() {
  console.log('Phase A Session 5 — ReissueQuote ceremony');
  console.log('CEREMONY_QUOTE_ID:', CEREMONY_QUOTE_ID);
  console.log('CEREMONY_REISSUE_SOURCE_MSG_ID:', CEREMONY_REISSUE_SOURCE_MSG_ID);

  await ensureSeed();
  const before = await captureState('PRE-REISSUE STATE');

  const cil = {
    cil_version: '1.0',
    type: 'ReissueQuote',
    source: 'whatsapp',
    source_msg_id: CEREMONY_REISSUE_SOURCE_MSG_ID,
    tenant_id: CEREMONY_TENANT_ID,
    occurred_at: new Date().toISOString(),
    actor: { role: 'owner', actor_id: CEREMONY_OWNER_ID },
    job: null,
    needs_job_resolution: false,
    quote_ref: { quote_id: CEREMONY_QUOTE_ID },
  };
  const ctx = {
    owner_id: CEREMONY_OWNER_ID,
    traceId: 'ceremony-phase-a-s5-reissuequote-trace',
  };

  let result;
  try {
    result = await handleReissueQuote(cil, ctx);
  } catch (e) {
    console.error('UNCAUGHT:', e);
    process.exit(2);
  }

  console.log('\nHANDLER RESULT:');
  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    console.error(`\nHandler returned ok:false (${result.error.code}) — see envelope above`);
    process.exit(1);
  }

  const after = await captureState('POST-REISSUE STATE');

  // Anomaly checks (§17.15 / §17.8 / supersession invariants)
  const anomalies = [];
  if (after.header.q_status !== 'draft') anomalies.push(`header.status expected 'draft', got '${after.header.q_status}'`);
  if (after.header.voided_at !== null) anomalies.push('header.voided_at must be NULL after reissue');
  if (after.header.voided_reason !== null) anomalies.push('header.voided_reason must be NULL after reissue');
  if (after.versions.length !== before.versions.length + (result.meta.already_existed ? 0 : 1)) {
    anomalies.push(`version count: expected ${before.versions.length + (result.meta.already_existed ? 0 : 1)}, got ${after.versions.length}`);
  }
  if (after.header.current_version_id !== result.version.id) {
    anomalies.push('header.current_version_id must equal result.version.id');
  }
  if (!result.meta.already_existed && result.meta.events_emitted[0] !== 'lifecycle.version_created') {
    anomalies.push('events_emitted[0] expected lifecycle.version_created on happy path');
  }
  // Supersession immutability sanity probe (only on happy path; the prior version is now superseded)
  if (!result.meta.already_existed) {
    try {
      await pg.query(
        `UPDATE public.chiefos_quote_versions SET project_title=project_title WHERE id=$1`,
        [CEREMONY_PRIOR_VERSION_ID]
      );
      anomalies.push('supersession immutability trigger DID NOT fire on prior version UPDATE');
    } catch (e) {
      if (!/superseded/i.test(e.message)) {
        anomalies.push(`unexpected error on supersession probe: ${e.message}`);
      }
    }
  }

  if (anomalies.length > 0) {
    console.error('\nANOMALIES DETECTED:');
    anomalies.forEach((a) => console.error('  -', a));
    process.exit(3);
  }

  console.log(
    `\nCEREMONY OK — ${result.meta.already_existed ? 'idempotent retry path' : 'happy-path reissue'}`
  );
  console.log(`new version_no: ${result.version.version_no}`);
  console.log(`prior_version: ${result.prior_version ? result.prior_version.id : '(null on retry path)'}`);
  console.log(`line_items_copied: ${result.meta.line_items_copied}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
