// scripts/ceremony_retrieve_portal_phase3.js
// Phase 3 ceremony — portal-authenticated retrieval via getSignatureForOwner
// against the real signature row created by SignQuote handler. Consumes
// returned stream, computes SHA-256, asserts byte-identity with fixture
// + DB row sha256.
//
// Parallels Phase 2C's retrieve-portal script but operates against a
// handler-created signature (not a manually-seeded row).

require('dotenv').config();
const crypto = require('crypto');
const supabaseAdmin = require('../services/supabaseAdmin');
const pg = require('../services/postgres');
const {
  getSignatureForOwner,
} = require('../src/cil/quoteSignatureStorage');

const {
  CEREMONY_TENANT_ID, CEREMONY_OWNER_ID,
  CEREMONY_VERSION_ID,
  CEREMONY_PNG_SHA256, CEREMONY_PNG_BUFFER,
} = require('./_phase3_constants');

async function consumeToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

(async () => {
  try {
    console.log('─── Phase 3 — portal retrieve ─────────────────────────────');
    console.log(`tenant_id: ${CEREMONY_TENANT_ID}`);
    console.log(`owner_id:  ${CEREMONY_OWNER_ID}`);
    console.log('');

    // Resolve signatureId from ceremony version (handler-generated UUID
    // is not pre-known; look up via the version's unique signature).
    const { rows } = await pg.query(
      `SELECT id AS signature_id
         FROM public.chiefos_quote_signatures
        WHERE quote_version_id = $1 AND tenant_id = $2 AND owner_id = $3`,
      [CEREMONY_VERSION_ID, CEREMONY_TENANT_ID, CEREMONY_OWNER_ID]
    );
    if (rows.length === 0) {
      console.error('[RETR/PORTAL] ✗ no signature row found — run real_sign_quote_ceremony.js first');
      process.exit(1);
    }
    const signatureId = rows[0].signature_id;
    console.log(`signature_id: ${signatureId}`);
    console.log('');

    console.log('[RETR/PORTAL] calling getSignatureForOwner...');
    let result;
    try {
      result = await getSignatureForOwner({
        signatureId,
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
    const downloadedBuffer = await consumeToBuffer(result.stream);
    const downloadedSha = crypto.createHash('sha256').update(downloadedBuffer).digest('hex');
    console.log(`   downloaded size:   ${downloadedBuffer.length}`);
    console.log(`   downloaded sha256: ${downloadedSha}`);
    console.log('');

    const fails = [];
    if (downloadedSha !== CEREMONY_PNG_SHA256) {
      fails.push(`downloaded sha !== fixture sha (got ${downloadedSha}, want ${CEREMONY_PNG_SHA256})`);
    }
    if (downloadedSha !== result.sha256) {
      fails.push(`downloaded sha !== row.sha256 (got ${downloadedSha}, row ${result.sha256})`);
    }
    if (!downloadedBuffer.equals(CEREMONY_PNG_BUFFER)) {
      fails.push('downloaded buffer !== fixture buffer');
    }

    if (fails.length > 0) {
      console.error('[RETR/PORTAL] ✗ assertion failures:');
      for (const f of fails) console.error('   ' + f);
      process.exit(1);
    }

    console.log('─── Portal retrieve result ───────────────────────────────');
    console.log('✓ downloaded sha === fixture sha === row.sha256');
    console.log('✓ downloaded buffer byte-equal to fixture buffer');
    console.log('');
    console.log('Next: node scripts/ceremony_retrieve_public_phase3.js');
    process.exit(0);
  } catch (err) {
    console.error('[RETR/PORTAL] ✗ uncaught exception:');
    console.error(err && err.stack ? err.stack : err);
    process.exit(2);
  }
})();
