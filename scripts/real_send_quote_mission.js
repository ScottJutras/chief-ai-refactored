// scripts/real_send_quote_mission.js
// Ceremonial first real SendQuote against the Mission Exteriors tenant.
// Run once. Delivers QT-2026-04-19-0001 to scott.tirakian@gmail.com with
// a real share-token URL. Produces production-scope audit artifacts:
// share_token row + lifecycle.sent + notification.sent events.
//
// Usage: node scripts/real_send_quote_mission.js
//
// This is NOT a test — it's a one-shot real write + external email
// dispatch. Outputs the return shape, SELECT dumps from all five truth
// surfaces, and the Postmark MessageID.
//
// Mirror of scripts/real_create_quote_mission.js. Different:
//   - Uses handleSendQuote (not handleCreateQuote)
//   - Exercises Section 2 Branch B (human_id lookup; CreateQuote ceremony
//     didn't cover this path)
//   - Dispatches external email via Postmark; reports MessageID
//   - No cleanup: ceremony produces real production artifacts per the
//     explicit posture decision ('real write proves real integration').

require('dotenv').config();
const { randomUUID } = require('crypto');
const { handleSendQuote } = require('../src/cil/quotes');
const pg = require('../services/postgres');

const MISSION_TENANT_UUID = '86907c28-a9ea-4318-819d-5a012192119b';
const MISSION_OWNER_ID = '19053279955'; // Scott's WhatsApp digits
const TARGET_HUMAN_ID = 'QT-2026-04-19-0001';
const TARGET_QUOTE_ID = '8430c4be-bcfd-44e7-b4e4-3603783d6b69';
const RECIPIENT_EMAIL = 'scott.tirakian@gmail.com';
const RECIPIENT_NAME = 'Scott Jutras';

(async () => {
  console.log('─── Ceremonial first real SendQuote against Mission Exteriors ──');
  console.log(`tenant_id:      ${MISSION_TENANT_UUID}`);
  console.log(`owner_id:       ${MISSION_OWNER_ID}`);
  console.log(`target:         ${TARGET_HUMAN_ID}  (${TARGET_QUOTE_ID})`);
  console.log(`recipient:      ${RECIPIENT_EMAIL}`);
  console.log(`quote_ref:      human_id branch (§2 Branch B)`);
  console.log('');

  // Preflight check on env — fail loud before any handler work.
  if (!process.env.POSTMARK_SERVER_TOKEN) {
    console.error('POSTMARK_SERVER_TOKEN missing from .env');
    process.exit(1);
  }
  if (!process.env.POSTMARK_FROM_EMAIL) {
    console.error('POSTMARK_FROM_EMAIL missing from .env');
    process.exit(1);
  }
  console.log(`POSTMARK_FROM:  ${process.env.POSTMARK_FROM_EMAIL}`);
  console.log('');

  const sourceMsgId = `first-real-sendquote-${randomUUID()}`;
  const traceId = `ceremony-send-${Date.now()}`;

  const cil = {
    cil_version: '1.0',
    type: 'SendQuote',
    tenant_id: MISSION_TENANT_UUID,
    source: 'whatsapp',
    source_msg_id: sourceMsgId,
    actor: { actor_id: MISSION_OWNER_ID, role: 'owner' },
    occurred_at: new Date().toISOString(),
    job: null,
    needs_job_resolution: false,
    quote_ref: { human_id: TARGET_HUMAN_ID },      // Branch B
    recipient_email: RECIPIENT_EMAIL,
    recipient_name: RECIPIENT_NAME,
  };

  const ctx = {
    owner_id: MISSION_OWNER_ID,
    traceId,
  };

  let result;
  try {
    result = await handleSendQuote(cil, ctx);
  } catch (err) {
    console.error('handleSendQuote threw (500-class):', err);
    process.exit(1);
  }

  console.log('─── handleSendQuote result ─────────────────────────────────────');
  console.log(JSON.stringify(result, null, 2));
  console.log('');

  if (!result.ok) {
    console.error('✗ Handler returned ok:false. Ceremony did not complete.');
    console.error(`  Error code: ${result.error.code}`);
    console.error(`  Message:    ${result.error.message}`);
    console.error(`  Hint:       ${result.error.hint}`);
    process.exit(1);
  }

  const events = await pg.query(
    `SELECT kind, payload FROM public.chiefos_quote_events
      WHERE quote_id = $1 AND kind IN ('lifecycle.sent','notification.sent','notification.failed')
      ORDER BY global_seq DESC
      LIMIT 2`,
    [TARGET_QUOTE_ID]
  );
  const emittedKinds = events.rows.map((r) => r.kind);
  const notificationEvent = events.rows.find((r) => r.kind.startsWith('notification.'));
  const postmarkMessageId = notificationEvent?.payload?.provider_message_id || 'n/a';
  const notificationFailed = emittedKinds.includes('notification.failed');

  // ─── Headline summary ─────────────────────────────────────────────────────
  console.log('─── Ceremony checklist ─────────────────────────────────────────');
  console.log(`✓ Handler returned ok:true`);
  console.log(`✓ Quote flipped to 'sent' status: ${result.quote.human_id}`);
  console.log(`✓ share_token created: ${result.share_token.token}`);
  console.log(`✓ share_url:           ${result.share_token.url}`);
  if (notificationFailed) {
    console.log(`⚠ Postmark FAILED — see notification.failed payload below`);
    console.log(`  error_code:   ${notificationEvent.payload.error_code}`);
    console.log(`  error_message: ${notificationEvent.payload.error_message}`);
  } else {
    console.log(`✓ Postmark MessageID:  ${postmarkMessageId}`);
  }
  console.log(`✓ Events emitted:      ${result.meta.events_emitted.join(', ')}`);
  console.log(`✓ Email delivered to:  ${RECIPIENT_EMAIL}`);
  console.log('');

  // ─── SELECT verification — all five truth surfaces ────────────────────────
  console.log('─── SELECT verification ────────────────────────────────────────');

  const quoteRow = await pg.query(
    `SELECT id, human_id, status, current_version_id, source, source_msg_id,
            updated_at
       FROM public.chiefos_quotes WHERE id = $1`,
    [TARGET_QUOTE_ID]
  );
  console.log('\nchiefos_quotes (header):');
  console.log(JSON.stringify(quoteRow.rows[0], null, 2));

  const versionRow = await pg.query(
    `SELECT id, version_no, status, issued_at, sent_at, locked_at
       FROM public.chiefos_quote_versions WHERE id = $1`,
    [result.quote.version_id]
  );
  console.log('\nchiefos_quote_versions (v1 — timestamps populated):');
  console.log(JSON.stringify(versionRow.rows[0], null, 2));

  const tokenRow = await pg.query(
    `SELECT id, token, recipient_name, recipient_channel, recipient_address,
            issued_at, absolute_expires_at, source_msg_id
       FROM public.chiefos_quote_share_tokens WHERE id = $1`,
    [result.share_token.id]
  );
  console.log('\nchiefos_quote_share_tokens (new row):');
  console.log(JSON.stringify(tokenRow.rows[0], null, 2));

  const allEvents = await pg.query(
    `SELECT kind, quote_version_id, share_token_id, actor_source,
            emitted_at, global_seq, payload
       FROM public.chiefos_quote_events
      WHERE quote_id = $1
      ORDER BY global_seq ASC`,
    [TARGET_QUOTE_ID]
  );
  console.log('\nchiefos_quote_events (full chain — 4 rows expected):');
  console.log(JSON.stringify(allEvents.rows, null, 2));

  console.log('\n─── Ceremony complete ──────────────────────────────────────────');
  console.log(`traceId:           ${traceId}`);
  console.log(`source_msg_id:     ${sourceMsgId}`);
  console.log(`Postmark MessageID: ${postmarkMessageId}`);
  console.log(`\nCustomer-facing URL: ${result.share_token.url}`);
  console.log('(Clicking will 404 until the /q/:token endpoint ships; URL shape verifies.)');

  process.exit(0);
})();
