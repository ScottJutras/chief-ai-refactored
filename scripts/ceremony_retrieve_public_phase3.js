// scripts/ceremony_retrieve_public_phase3.js
// Phase 3 ceremony — public share-token retrieval via
// getSignatureViaShareToken against the real signature row created by
// SignQuote handler. Consumes returned stream, computes SHA-256, asserts
// byte-identity + audit context populated.

require('dotenv').config();
const crypto = require('crypto');
const supabaseAdmin = require('../services/supabaseAdmin');
const pg = require('../services/postgres');
const {
  getSignatureViaShareToken,
} = require('../src/cil/quoteSignatureStorage');

const {
  CEREMONY_TENANT_ID, CEREMONY_OWNER_ID,
  CEREMONY_QUOTE_ID, CEREMONY_VERSION_ID,
  CEREMONY_SHARE_TOKEN_ID, CEREMONY_SHARE_TOKEN,
  CEREMONY_PNG_SHA256, CEREMONY_PNG_BUFFER,
} = require('./_phase3_constants');

async function consumeToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

(async () => {
  try {
    console.log('─── Phase 3 — public share-token retrieve ─────────────────');
    console.log(`share_token: ${CEREMONY_SHARE_TOKEN}`);
    console.log('');

    // Resolve signatureId from ceremony version.
    const { rows } = await pg.query(
      `SELECT id AS signature_id
         FROM public.chiefos_quote_signatures
        WHERE quote_version_id = $1 AND tenant_id = $2`,
      [CEREMONY_VERSION_ID, CEREMONY_TENANT_ID]
    );
    if (rows.length === 0) {
      console.error('[RETR/PUBLIC] ✗ no signature row found — run real_sign_quote_ceremony.js first');
      process.exit(1);
    }
    const signatureId = rows[0].signature_id;
    console.log(`signature_id: ${signatureId}`);
    console.log('');

    console.log('[RETR/PUBLIC] calling getSignatureViaShareToken...');
    let result;
    try {
      result = await getSignatureViaShareToken({
        signatureId,
        shareToken: CEREMONY_SHARE_TOKEN,
        pg,
        supabaseAdmin,
      });
    } catch (err) {
      console.error('[RETR/PUBLIC] ✗ getSignatureViaShareToken threw:', err.code || err.name, err.message);
      if (err.hint) console.error('   hint:', err.hint);
      process.exit(1);
    }

    console.log('[RETR/PUBLIC] helper returned:');
    console.log(`   contentType:   ${result.contentType}`);
    console.log(`   contentLength: ${result.contentLength}`);
    console.log(`   sha256 (row):  ${result.sha256}`);
    console.log(`   signatureId:   ${result.signatureId}`);
    console.log(`   signedAt:      ${result.signedAt}`);
    console.log('   audit context:');
    console.log(`     shareTokenId: ${result.shareTokenId}`);
    console.log(`     quoteId:      ${result.quoteId}`);
    console.log(`     tenantId:     ${result.tenantId}`);
    console.log(`     ownerId:      ${result.ownerId}`);
    console.log('');

    console.log('[RETR/PUBLIC] consuming stream...');
    const downloadedBuffer = await consumeToBuffer(result.stream);
    const downloadedSha = crypto.createHash('sha256').update(downloadedBuffer).digest('hex');
    console.log(`   downloaded size:   ${downloadedBuffer.length}`);
    console.log(`   downloaded sha256: ${downloadedSha}`);
    console.log('');

    const fails = [];
    if (downloadedSha !== CEREMONY_PNG_SHA256)    fails.push('downloaded sha !== fixture sha');
    if (downloadedSha !== result.sha256)          fails.push('downloaded sha !== row.sha256');
    if (!downloadedBuffer.equals(CEREMONY_PNG_BUFFER)) fails.push('downloaded buffer !== fixture buffer');
    if (result.shareTokenId !== CEREMONY_SHARE_TOKEN_ID)
      fails.push(`shareTokenId mismatch: got ${result.shareTokenId}`);
    if (result.quoteId !== CEREMONY_QUOTE_ID)     fails.push('quoteId mismatch');
    if (result.tenantId !== CEREMONY_TENANT_ID)   fails.push('tenantId mismatch');
    if (result.ownerId !== CEREMONY_OWNER_ID)     fails.push('ownerId mismatch');

    if (fails.length > 0) {
      console.error('[RETR/PUBLIC] ✗ assertion failures:');
      for (const f of fails) console.error('   ' + f);
      process.exit(1);
    }

    console.log('─── Public retrieve result ───────────────────────────────');
    console.log('✓ downloaded sha === fixture sha === row.sha256');
    console.log('✓ downloaded buffer byte-equal to fixture buffer');
    console.log('✓ audit context fields match ceremony identity');
    console.log('');
    console.log('Phase 3 ceremony run complete. All scripts exit 0.');
    console.log('Next: Supabase MCP verification queries + §27 composition.');
    process.exit(0);
  } catch (err) {
    console.error('[RETR/PUBLIC] ✗ uncaught exception:');
    console.error(err && err.stack ? err.stack : err);
    process.exit(2);
  }
})();
