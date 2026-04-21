// scripts/real_sign_quote_ceremony.js
// Ceremonial first real SignQuote against the Phase 3 synthetic tenant.
//
// Invokes handleSignQuote directly (bypassing router) to exercise the
// full 23-step sequence against production Supabase Storage + Postgres.
// Mirrors Phase 2C's ceremony posture: direct handler invocation keeps
// the ceremony focused on handler behavior, not router plumbing.
//
// Match-path only (per Section 6 decision): signer_name matches
// share_token.recipient_name → name_match_at_sign=true → no
// integrity.name_mismatch_signed event. Mismatch path is thoroughly
// covered by Section 5 unit tests.
//
// Idempotent via source_msg_id: re-runs hit lookupPriorSignature at
// step 5 and return prior state without re-emitting events or
// re-uploading.
//
// Exit codes:
//   0 — ceremony succeeded (or idempotent retry returned prior state)
//   1 — handler returned ok:false (state-machine rejection; details in envelope)
//   2 — uncaught exception (integration gap; diagnostic in stderr)

require('dotenv').config();
const { handleSignQuote } = require('../src/cil/quotes');

const {
  CEREMONY_TENANT_ID, CEREMONY_OWNER_ID,
  CEREMONY_SHARE_TOKEN_ID, CEREMONY_SHARE_TOKEN,
  CEREMONY_SIGNER_NAME,
  CEREMONY_PNG_DATA_URL, CEREMONY_PNG_SHA256, CEREMONY_PNG_BUFFER,
} = require('./_phase3_constants');

const CEREMONY_SOURCE_MSG_ID = 'ceremony-phase3-signquote-run-1';

(async () => {
  try {
    console.log('─── Phase 3 ceremony — SignQuote against production ─────────');
    console.log(`tenant_id:      ${CEREMONY_TENANT_ID}`);
    console.log(`owner_id:       ${CEREMONY_OWNER_ID}`);
    console.log(`share_token:    ${CEREMONY_SHARE_TOKEN}`);
    console.log(`signer_name:    ${CEREMONY_SIGNER_NAME} (match path)`);
    console.log(`source_msg_id:  ${CEREMONY_SOURCE_MSG_ID}`);
    console.log(`fixture size:   ${CEREMONY_PNG_BUFFER.length} bytes`);
    console.log(`fixture sha256: ${CEREMONY_PNG_SHA256}`);
    console.log('');

    const cil = {
      cil_version: '1.0',
      type: 'SignQuote',
      tenant_id: CEREMONY_TENANT_ID,
      source: 'web',
      source_msg_id: CEREMONY_SOURCE_MSG_ID,
      actor: {
        role: 'customer',
        actor_id: CEREMONY_SHARE_TOKEN_ID,  // share_token_id per DB1 Q4
      },
      occurred_at: new Date().toISOString(),
      job: null,
      needs_job_resolution: false,
      share_token: CEREMONY_SHARE_TOKEN,
      signer_name: CEREMONY_SIGNER_NAME,
      signature_png_data_url: CEREMONY_PNG_DATA_URL,
    };

    const ctx = {
      owner_id: CEREMONY_OWNER_ID,
      traceId: `ceremony-sign-phase3-${Date.now()}`,
      signer_ip: '127.0.0.1',
      signer_user_agent: 'Phase3Ceremony/1.0',
    };

    console.log('[CEREMONY] invoking handleSignQuote...');
    const result = await handleSignQuote(cil, ctx);
    console.log('');
    console.log('─── handleSignQuote result ─────────────────────────────────');
    console.log(JSON.stringify(result, null, 2));
    console.log('');

    if (!result.ok) {
      console.error('[CEREMONY] ✗ handler returned ok:false');
      console.error(`  code:    ${result.error.code}`);
      console.error(`  message: ${result.error.message}`);
      console.error(`  hint:    ${result.error.hint}`);
      process.exit(1);
    }

    console.log('[CEREMONY] ✓ ceremony succeeded');
    console.log('');
    console.log('─── Captured §27 artifact values ───────────────────────────');
    console.log(`signature_id:       ${result.signature.id}`);
    console.log(`signed_at:          ${result.signature.signed_at}`);
    console.log(`name_match_at_sign: ${result.signature.name_match_at_sign}`);
    console.log(`sha256:             ${result.signature.sha256}`);
    console.log(`storage_key:        ${result.signature.storage_key}`);
    console.log(`server_hash:        ${result.version.server_hash}`);
    console.log(`locked_at:          ${result.version.locked_at}`);
    console.log(`quote.status:       ${result.quote.status}`);
    console.log(`correlation_id:     ${result.meta.correlation_id}`);
    console.log(`events_emitted:     ${JSON.stringify(result.meta.events_emitted)}`);
    console.log(`already_existed:    ${result.meta.already_existed}`);
    console.log('');
    console.log('Verify via Supabase MCP per §27 checklist;');
    console.log('then: node scripts/ceremony_retrieve_portal_phase3.js');
    console.log('then: node scripts/ceremony_retrieve_public_phase3.js');
    process.exit(0);
  } catch (err) {
    console.error('[CEREMONY] ✗ uncaught exception during handler invocation:');
    console.error(err && err.stack ? err.stack : err);
    process.exit(2);
  }
})();
