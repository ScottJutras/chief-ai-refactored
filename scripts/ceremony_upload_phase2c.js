// scripts/ceremony_upload_phase2c.js
// Phase 2C ceremony — upload fixture PNG via uploadSignaturePng, then INSERT
// the ceremony signature row referencing the fixture's storage_key + sha256.
//
// Idempotent: checks for existing ceremony signature row first. If present,
// reports existing storage_key/sha256 and exits 0 (safe to re-run; does NOT
// re-upload).

require('dotenv').config();
const pg = require('../services/postgres');
const supabaseAdmin = require('../services/supabaseAdmin');
const {
  buildSignatureStorageKey,
  uploadSignaturePng,
  cleanupOrphanPng,
} = require('../src/cil/quoteSignatureStorage');

const {
  CEREMONY_TENANT_ID, CEREMONY_OWNER_ID,
  CEREMONY_QUOTE_ID, CEREMONY_VERSION_ID,
  CEREMONY_SIGNATURE_ID, CEREMONY_SHARE_TOKEN_ID,
  CEREMONY_SIGNED_EVENT_ID,
  CEREMONY_SIGNER_NAME, CEREMONY_RECIPIENT_EMAIL,
  CEREMONY_CUSTOMER_NAME, CEREMONY_VERSION_HASH,
  CEREMONY_PNG_BUFFER, CEREMONY_PNG_SHA256, CEREMONY_PNG_DATA_URL,
} = require('./_phase2c_constants');

async function main() {
  console.log('─── Phase 2C ceremony upload ──────────────────────────────');
  console.log(`signature_id:   ${CEREMONY_SIGNATURE_ID}`);
  console.log(`fixture size:   ${CEREMONY_PNG_BUFFER.length} bytes`);
  console.log(`fixture sha256: ${CEREMONY_PNG_SHA256}`);
  console.log('');

  // ─── Idempotency check ───────────────────────────────────────────────────
  const existing = await pg.query(
    `SELECT id, signature_png_storage_key, signature_png_sha256, signed_at
       FROM public.chiefos_quote_signatures
      WHERE id = $1 AND tenant_id = $2 AND owner_id = $3`,
    [CEREMONY_SIGNATURE_ID, CEREMONY_TENANT_ID, CEREMONY_OWNER_ID]
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    console.log('[UPLOAD] ceremony signature row already exists:');
    console.log(`   storage_key: ${row.signature_png_storage_key}`);
    console.log(`   sha256:      ${row.signature_png_sha256}`);
    console.log(`   signed_at:   ${row.signed_at}`);
    if (row.signature_png_sha256 !== CEREMONY_PNG_SHA256) {
      console.error('[UPLOAD] ✗ stored sha256 differs from regenerated fixture sha256.');
      console.error(`   stored:      ${row.signature_png_sha256}`);
      console.error(`   regenerated: ${CEREMONY_PNG_SHA256}`);
      console.error('Either fixture bytes drifted or ceremony row corrupted. Halting.');
      process.exit(1);
    }
    console.log('[UPLOAD] ✓ already uploaded — no-op. Next: portal retrieve.');
    process.exit(0);
  }

  // ─── Build storage_key ───────────────────────────────────────────────────
  const storageKey = buildSignatureStorageKey({
    tenantId: CEREMONY_TENANT_ID,
    quoteId: CEREMONY_QUOTE_ID,
    quoteVersionId: CEREMONY_VERSION_ID,
    signatureId: CEREMONY_SIGNATURE_ID,
  });
  console.log(`[UPLOAD] storage_key: ${storageKey}`);
  console.log('');

  // ─── Upload PNG to bucket ────────────────────────────────────────────────
  console.log('[UPLOAD] calling uploadSignaturePng against production Supabase...');
  let uploadResult;
  try {
    uploadResult = await uploadSignaturePng({
      pngDataUrl: CEREMONY_PNG_DATA_URL,
      storageKey,
      supabaseAdmin,
    });
  } catch (err) {
    console.error('[UPLOAD] ✗ uploadSignaturePng threw:', err.code || err.name, err.message);
    if (err.hint) console.error('   hint:', err.hint);
    process.exit(1);
  }
  console.log(`[UPLOAD] ✓ upload succeeded`);
  console.log(`   bucket bytes len:  ${uploadResult.pngBuffer.length}`);
  console.log(`   computed sha256:   ${uploadResult.sha256}`);
  if (uploadResult.sha256 !== CEREMONY_PNG_SHA256) {
    console.error('[UPLOAD] ✗ upload sha256 differs from fixture sha256 — cleaning up and halting.');
    await cleanupOrphanPng({ supabaseAdmin, storageKey });
    process.exit(1);
  }

  // ─── INSERT signature row ────────────────────────────────────────────────
  // Migration 4 schema: strict-immutability trigger means every NOT NULL col
  // must be set in the single INSERT (no UPDATE after). share_token_id +
  // signed_event_id + quote_version_id all reference seed-inserted rows.
  console.log('');
  console.log('[UPLOAD] inserting chiefos_quote_signatures row...');
  try {
    await pg.query(
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
         NOW(),
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
        CEREMONY_SIGNER_NAME,
        CEREMONY_RECIPIENT_EMAIL,
        storageKey,
        uploadResult.sha256,
        CEREMONY_VERSION_HASH,
        CEREMONY_CUSTOMER_NAME,
      ]
    );
  } catch (insertErr) {
    console.error('[UPLOAD] ✗ signature INSERT failed:', insertErr.code, insertErr.message);
    if (insertErr.constraint) console.error('   constraint:', insertErr.constraint);
    if (insertErr.detail) console.error('   detail:    ', insertErr.detail);
    console.log('[UPLOAD] attempting orphan cleanup (§25.6 Direction A)...');
    await cleanupOrphanPng({ supabaseAdmin, storageKey });
    console.error('[UPLOAD] orphan cleanup attempted. Halting.');
    process.exit(1);
  }

  console.log('[UPLOAD] ✓ signature row INSERTed');
  console.log('');
  console.log('─── Ceremony upload artifact ────────────────────────────────');
  console.log(`storage_key:    ${storageKey}`);
  console.log(`sha256:         ${uploadResult.sha256}`);
  console.log(`signature_id:   ${CEREMONY_SIGNATURE_ID}`);
  console.log(`timestamp:      ${new Date().toISOString()}`);
  console.log('');
  console.log('Next: node scripts/ceremony_retrieve_portal_phase2c.js');
  process.exit(0);
}

main().catch((err) => {
  console.error('[UPLOAD] unexpected error:', err);
  process.exit(1);
});
