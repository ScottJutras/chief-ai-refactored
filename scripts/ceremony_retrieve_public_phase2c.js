// scripts/ceremony_retrieve_public_phase2c.js
// Phase 2C ceremony — public share-token retrieval via
// getSignatureViaShareToken. Consumes returned stream, computes SHA-256,
// asserts byte-identity + audit context populated.

require('dotenv').config();
const crypto = require('crypto');
const supabaseAdmin = require('../services/supabaseAdmin');
const pg = require('../services/postgres');
const {
  getSignatureViaShareToken,
} = require('../src/cil/quoteSignatureStorage');

const {
  CEREMONY_TENANT_ID, CEREMONY_OWNER_ID,
  CEREMONY_QUOTE_ID,
  CEREMONY_SIGNATURE_ID, CEREMONY_SHARE_TOKEN_ID,
  CEREMONY_SHARE_TOKEN,
  CEREMONY_PNG_BUFFER, CEREMONY_PNG_SHA256,
} = require('./_phase2c_constants');

async function consumeToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function main() {
  console.log('─── Phase 2C ceremony — public share-token retrieve ──────');
  console.log(`signature_id: ${CEREMONY_SIGNATURE_ID}`);
  console.log(`share_token:  ${CEREMONY_SHARE_TOKEN}`);
  console.log('');

  let result;
  try {
    result = await getSignatureViaShareToken({
      signatureId: CEREMONY_SIGNATURE_ID,
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
  let downloadedBuffer;
  try {
    downloadedBuffer = await consumeToBuffer(result.stream);
  } catch (streamErr) {
    console.error('[RETR/PUBLIC] ✗ stream consumption failed:', streamErr.message);
    process.exit(1);
  }
  const downloadedSha = crypto.createHash('sha256').update(downloadedBuffer).digest('hex');

  console.log(`   downloaded size:   ${downloadedBuffer.length}`);
  console.log(`   downloaded sha256: ${downloadedSha}`);
  console.log('');

  // ─── Assertions ──────────────────────────────────────────────────────────
  const fails = [];

  if (downloadedSha !== CEREMONY_PNG_SHA256) {
    fails.push(`downloaded sha !== fixture sha`);
  }
  if (downloadedSha !== result.sha256) {
    fails.push(`downloaded sha !== row.sha256`);
  }
  if (!downloadedBuffer.equals(CEREMONY_PNG_BUFFER)) {
    fails.push(`downloaded buffer !== fixture buffer`);
  }
  if (result.signatureId !== CEREMONY_SIGNATURE_ID) {
    fails.push(`result.signatureId !== CEREMONY_SIGNATURE_ID`);
  }
  if (result.shareTokenId !== CEREMONY_SHARE_TOKEN_ID) {
    fails.push(`result.shareTokenId !== CEREMONY_SHARE_TOKEN_ID (got ${result.shareTokenId})`);
  }
  if (result.quoteId !== CEREMONY_QUOTE_ID) {
    fails.push(`result.quoteId !== CEREMONY_QUOTE_ID (got ${result.quoteId})`);
  }
  if (result.tenantId !== CEREMONY_TENANT_ID) {
    fails.push(`result.tenantId !== CEREMONY_TENANT_ID`);
  }
  if (result.ownerId !== CEREMONY_OWNER_ID) {
    fails.push(`result.ownerId !== CEREMONY_OWNER_ID`);
  }

  if (fails.length > 0) {
    console.error('[RETR/PUBLIC] ✗ assertion failures:');
    for (const f of fails) console.error(`   ${f}`);
    process.exit(1);
  }

  console.log('─── Public retrieve result ───────────────────────────────');
  console.log('✓ downloaded sha === fixture sha === row.sha256');
  console.log('✓ downloaded buffer byte-equal to fixture buffer');
  console.log('✓ audit context fields match ceremony identity');
  console.log('');
  console.log('Phase 2C ceremony run complete. All four scripts exit 0.');
  console.log('Next: compose §26 decisions log entry + execution plan tick.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[RETR/PUBLIC] unexpected error:', err);
  process.exit(1);
});
