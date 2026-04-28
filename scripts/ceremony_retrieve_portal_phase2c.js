// scripts/ceremony_retrieve_portal_phase2c.js
// Phase 2C ceremony — portal-authenticated retrieval via getSignatureForOwner.
// Consumes returned stream, computes SHA-256 on downloaded bytes, asserts
// byte-identity with the fixture + with the DB row's sha256.

require('dotenv').config();
const crypto = require('crypto');
const supabaseAdmin = require('../services/supabaseAdmin');
const pg = require('../services/postgres');
const {
  getSignatureForOwner,
} = require('../src/cil/quoteSignatureStorage');

const {
  CEREMONY_TENANT_ID, CEREMONY_OWNER_ID,
  CEREMONY_SIGNATURE_ID,
  CEREMONY_PNG_BUFFER, CEREMONY_PNG_SHA256,
} = require('./_phase2c_constants');

async function consumeToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function main() {
  console.log('─── Phase 2C ceremony — portal retrieve ──────────────────');
  console.log(`signature_id: ${CEREMONY_SIGNATURE_ID}`);
  console.log(`tenant_id:    ${CEREMONY_TENANT_ID}`);
  console.log(`owner_id:     ${CEREMONY_OWNER_ID}`);
  console.log('');

  let result;
  try {
    result = await getSignatureForOwner({
      signatureId: CEREMONY_SIGNATURE_ID,
      tenantId: CEREMONY_TENANT_ID,
      ownerId: CEREMONY_OWNER_ID,
      pg,
      supabaseAdmin,
    });
  } catch (err) {
    console.error('[RETR/PORTAL] ✗ getSignatureForOwner threw:', err.code || err.name, err.message);
    if (err.hint) console.error('   hint:', err.hint);
    process.exit(1);
  }

  console.log('[RETR/PORTAL] helper returned:');
  console.log(`   contentType:   ${result.contentType}`);
  console.log(`   contentLength: ${result.contentLength}`);
  console.log(`   sha256 (row):  ${result.sha256}`);
  console.log(`   signatureId:   ${result.signatureId}`);
  console.log(`   signedAt:      ${result.signedAt}`);
  console.log('');

  console.log('[RETR/PORTAL] consuming stream...');
  let downloadedBuffer;
  try {
    downloadedBuffer = await consumeToBuffer(result.stream);
  } catch (streamErr) {
    console.error('[RETR/PORTAL] ✗ stream consumption failed:', streamErr.message);
    process.exit(1);
  }
  const downloadedSha = crypto.createHash('sha256').update(downloadedBuffer).digest('hex');

  console.log(`   downloaded size:   ${downloadedBuffer.length}`);
  console.log(`   downloaded sha256: ${downloadedSha}`);
  console.log('');

  // ─── Assertions ──────────────────────────────────────────────────────────
  const fails = [];

  if (downloadedSha !== CEREMONY_PNG_SHA256) {
    fails.push(`downloaded sha !== fixture sha (downloaded=${downloadedSha}, fixture=${CEREMONY_PNG_SHA256})`);
  }
  if (downloadedSha !== result.sha256) {
    fails.push(`downloaded sha !== row.sha256 (downloaded=${downloadedSha}, row=${result.sha256})`);
  }
  if (result.sha256 !== CEREMONY_PNG_SHA256) {
    fails.push(`row.sha256 !== fixture sha (row=${result.sha256}, fixture=${CEREMONY_PNG_SHA256})`);
  }
  if (!downloadedBuffer.equals(CEREMONY_PNG_BUFFER)) {
    fails.push(`downloaded buffer !== fixture buffer (byte-identity failure even though SHAs match? impossible — investigate)`);
  }
  if (result.signatureId !== CEREMONY_SIGNATURE_ID) {
    fails.push(`result.signatureId !== CEREMONY_SIGNATURE_ID`);
  }

  if (fails.length > 0) {
    console.error('[RETR/PORTAL] ✗ assertion failures:');
    for (const f of fails) console.error(`   ${f}`);
    process.exit(1);
  }

  console.log('─── Portal retrieve result ───────────────────────────────');
  console.log('✓ downloaded sha === fixture sha === row.sha256');
  console.log('✓ downloaded buffer byte-equal to fixture buffer');
  console.log('✓ result.signatureId === ceremony signatureId');
  console.log('');
  console.log('Next: node scripts/ceremony_retrieve_public_phase2c.js');
  process.exit(0);
}

main().catch((err) => {
  console.error('[RETR/PORTAL] unexpected error:', err);
  process.exit(1);
});
