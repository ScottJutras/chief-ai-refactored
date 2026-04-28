// scripts/_phase2c_constants.js
// Phase 2C ceremony identity — frozen inputs for all ceremony scripts.
// Idempotency depends on these being fixed across reruns.

const crypto = require('crypto');
let bs58;
try {
  bs58 = require('bs58').default || require('bs58');
} catch (_) {
  bs58 = null;
}

// Synthetic ceremony IDs — clearly-marked with repeated 'c2c2' hex group so
// they're greppable as Phase 2C artifacts vs real tenant data.
const CEREMONY_TENANT_ID       = '00000000-c2c2-c2c2-c2c2-000000000001';
const CEREMONY_OWNER_ID        = '00000000000';
const CEREMONY_QUOTE_ID        = '00000000-c2c2-c2c2-c2c2-000000000002';
const CEREMONY_VERSION_ID      = '00000000-c2c2-c2c2-c2c2-000000000003';
const CEREMONY_SIGNATURE_ID    = '00000000-c2c2-c2c2-c2c2-000000000004';
const CEREMONY_SHARE_TOKEN_ID  = '00000000-c2c2-c2c2-c2c2-000000000005';
const CEREMONY_SIGNED_EVENT_ID = '00000000-c2c2-c2c2-c2c2-000000000006';

const CEREMONY_HUMAN_ID        = 'QT-CEREMONY-2026-04-20-PHASE2C';
const CEREMONY_PROJECT_TITLE   = 'Phase 2C Ceremony';
const CEREMONY_CUSTOMER_NAME   = 'Ceremony Customer';
const CEREMONY_SIGNER_NAME     = 'Ceremony Signer';
const CEREMONY_RECIPIENT_EMAIL = 'ceremony@chiefos-phase2c.invalid';

// Deterministic 22-char base58 share-token. Computed from SHA-256 of a
// fixed seed → truncate to 16 bytes → bs58.encode. 16 bytes of entropy
// typically yield 22 base58 chars.
function deriveShareToken() {
  if (!bs58) return null;
  const seed = crypto.createHash('sha256')
    .update('chiefos-phase2c-ceremony-share-token-seed-v1')
    .digest()
    .subarray(0, 16);
  return bs58.encode(seed);
}
const CEREMONY_SHARE_TOKEN = deriveShareToken();

if (!CEREMONY_SHARE_TOKEN || CEREMONY_SHARE_TOKEN.length !== 22) {
  throw new Error(
    `[ceremony-constants] share_token wrong length: ${
      CEREMONY_SHARE_TOKEN && CEREMONY_SHARE_TOKEN.length
    }. bs58 not installed?`
  );
}

// Deterministic version_hash_at_sign — 64-hex, matches Migration 4 format
// CHECK on chiefos_quote_signatures.version_hash_at_sign and the
// chiefos_qe_payload_signed event payload check.
const CEREMONY_VERSION_HASH = crypto.createHash('sha256')
  .update('chiefos-phase2c-ceremony-version-hash-v1')
  .digest('hex');

// ─── PNG fixture generation (deterministic real 1×1 grayscale with tEXt) ────

const PNG_FILE_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

// CRC-32 per RFC 1952 / PNG spec (polynomial 0xEDB88320). No deps; ~10 lines.
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = crc ^ buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ ((crc & 1) * 0xEDB88320);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makePngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

/**
 * Build the ceremony fixture PNG: real 1×1 grayscale PNG with a tEXt
 * chunk carrying ceremony metadata. Deterministic byte-for-byte across
 * runs — SHA-256 is pinnable in §26.
 *
 * Why real PNG: viewable in Supabase dashboard as a forensic artifact
 * (tEXt "Description" self-labels the file). Size comes out to ~130 B,
 * comfortably above PNG_MIN_BYTES = 100.
 */
function buildCeremonyPng() {
  // Uses zlib from Node's stdlib.
  // eslint-disable-next-line global-require
  const zlib = require('zlib');

  // IHDR: 1×1, 8-bit, grayscale (color type 0), no interlace
  const ihdr = makePngChunk('IHDR', Buffer.from([
    0x00, 0x00, 0x00, 0x01,  // width = 1
    0x00, 0x00, 0x00, 0x01,  // height = 1
    0x08,                    // bit depth = 8
    0x00,                    // color type = grayscale
    0x00,                    // compression = deflate
    0x00,                    // filter method = default
    0x00,                    // interlace = none
  ]));

  // tEXt: "Description\0ChiefOS Phase 2C Ceremony fixture — 2026-04-20"
  // (en-dash — intentional; PNG tEXt allows any Latin-1 char)
  const textDescription = 'ChiefOS Phase 2C Ceremony fixture - 2026-04-20';
  const tExt = makePngChunk(
    'tEXt',
    Buffer.concat([
      Buffer.from('Description', 'ascii'),
      Buffer.from([0x00]),
      Buffer.from(textDescription, 'latin1'),
    ])
  );

  // IDAT: filter byte 0x00 + single white pixel 0xFF, zlib-deflated
  const idat = makePngChunk('IDAT', zlib.deflateSync(Buffer.from([0x00, 0xFF])));

  const iend = makePngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([PNG_FILE_SIGNATURE, ihdr, tExt, idat, iend]);
}

const CEREMONY_PNG_BUFFER = buildCeremonyPng();
const CEREMONY_PNG_SHA256 = crypto.createHash('sha256')
  .update(CEREMONY_PNG_BUFFER)
  .digest('hex');
const CEREMONY_PNG_DATA_URL = `data:image/png;base64,${CEREMONY_PNG_BUFFER.toString('base64')}`;

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  // Identity
  CEREMONY_TENANT_ID,
  CEREMONY_OWNER_ID,
  CEREMONY_QUOTE_ID,
  CEREMONY_VERSION_ID,
  CEREMONY_SIGNATURE_ID,
  CEREMONY_SHARE_TOKEN_ID,
  CEREMONY_SIGNED_EVENT_ID,
  CEREMONY_HUMAN_ID,
  CEREMONY_PROJECT_TITLE,
  CEREMONY_CUSTOMER_NAME,
  CEREMONY_SIGNER_NAME,
  CEREMONY_RECIPIENT_EMAIL,
  CEREMONY_SHARE_TOKEN,
  CEREMONY_VERSION_HASH,

  // Fixture
  CEREMONY_PNG_BUFFER,
  CEREMONY_PNG_SHA256,
  CEREMONY_PNG_DATA_URL,

  // Utilities (exported in case scripts want to rebuild fixture for comparison)
  buildCeremonyPng,
};
