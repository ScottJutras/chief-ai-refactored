// scripts/_phase3_constants.js
// Phase 3 ceremony identity — frozen inputs for all ceremony scripts.
// Idempotency depends on these being fixed across reruns.
//
// Namespace: 'c3c3-c3c3-c3c3' hex group distinguishes Phase 3 ceremony
// rows from Phase 2C's 'c2c2-c2c2-c2c2'.

const crypto = require('crypto');
let bs58;
try {
  bs58 = require('bs58').default || require('bs58');
} catch (_) {
  bs58 = null;
}

const CEREMONY_TENANT_ID        = '00000000-c3c3-c3c3-c3c3-000000000001';
const CEREMONY_OWNER_ID         = '00000000001';
const CEREMONY_QUOTE_ID         = '00000000-c3c3-c3c3-c3c3-000000000002';
const CEREMONY_VERSION_ID       = '00000000-c3c3-c3c3-c3c3-000000000003';
const CEREMONY_SHARE_TOKEN_ID   = '00000000-c3c3-c3c3-c3c3-000000000005';
const CEREMONY_SENT_EVENT_ID    = '00000000-c3c3-c3c3-c3c3-000000000007';
const CEREMONY_LINE_ITEM_ID     = '00000000-c3c3-c3c3-c3c3-0000000000a1';

const CEREMONY_HUMAN_ID         = 'QT-CEREMONY-2026-04-21-PHASE3';
const CEREMONY_PROJECT_TITLE    = 'Phase 3 SignQuote Ceremony';
const CEREMONY_CUSTOMER_NAME    = 'Phase 3 Ceremony Customer';
const CEREMONY_RECIPIENT_EMAIL  = 'phase3-ceremony@chiefos.invalid';
const CEREMONY_SIGNER_NAME      = CEREMONY_CUSTOMER_NAME;  // match-path for ceremony
const CEREMONY_CONTRACTOR_EMAIL = 'scott.tirakian@gmail.com';  // Postmark target (Mission §22 parallel)

function deriveShareToken() {
  if (!bs58) return null;
  const seed = crypto.createHash('sha256')
    .update('chiefos-phase3-ceremony-share-token-seed-v1')
    .digest()
    .subarray(0, 16);
  return bs58.encode(seed);
}
const CEREMONY_SHARE_TOKEN = deriveShareToken();

if (!CEREMONY_SHARE_TOKEN || CEREMONY_SHARE_TOKEN.length !== 22) {
  throw new Error(
    `[phase3-constants] share_token wrong length: ${
      CEREMONY_SHARE_TOKEN && CEREMONY_SHARE_TOKEN.length
    }. bs58 not installed?`
  );
}

// ─── PNG fixture (real 1×1 grayscale + tEXt metadata) ──────────────────────

const PNG_FILE_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

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
 * Build the Phase 3 ceremony fixture PNG: real 1×1 grayscale PNG with a
 * tEXt chunk carrying Phase-3-specific ceremony metadata. Deterministic
 * byte-for-byte across runs — SHA-256 is pinnable in §27.
 */
function buildCeremonyPng() {
  // eslint-disable-next-line global-require
  const zlib = require('zlib');

  const ihdr = makePngChunk('IHDR', Buffer.from([
    0x00, 0x00, 0x00, 0x01,  // width = 1
    0x00, 0x00, 0x00, 0x01,  // height = 1
    0x08,                    // bit depth = 8
    0x00,                    // color type = grayscale
    0x00, 0x00, 0x00,        // compression, filter, interlace
  ]));

  const textDescription = 'ChiefOS Phase 3 SignQuote ceremony fixture - 2026-04-21';
  const tExt = makePngChunk(
    'tEXt',
    Buffer.concat([
      Buffer.from('Description', 'ascii'),
      Buffer.from([0x00]),
      Buffer.from(textDescription, 'latin1'),
    ])
  );

  const idat = makePngChunk('IDAT', zlib.deflateSync(Buffer.from([0x00, 0xFF])));
  const iend = makePngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([PNG_FILE_SIGNATURE, ihdr, tExt, idat, iend]);
}

const CEREMONY_PNG_BUFFER    = buildCeremonyPng();
const CEREMONY_PNG_SHA256    = crypto.createHash('sha256').update(CEREMONY_PNG_BUFFER).digest('hex');
const CEREMONY_PNG_DATA_URL  = `data:image/png;base64,${CEREMONY_PNG_BUFFER.toString('base64')}`;

module.exports = {
  // Identity
  CEREMONY_TENANT_ID,
  CEREMONY_OWNER_ID,
  CEREMONY_QUOTE_ID,
  CEREMONY_VERSION_ID,
  CEREMONY_SHARE_TOKEN_ID,
  CEREMONY_SENT_EVENT_ID,
  CEREMONY_LINE_ITEM_ID,
  CEREMONY_HUMAN_ID,
  CEREMONY_PROJECT_TITLE,
  CEREMONY_CUSTOMER_NAME,
  CEREMONY_RECIPIENT_EMAIL,
  CEREMONY_SIGNER_NAME,
  CEREMONY_CONTRACTOR_EMAIL,
  CEREMONY_SHARE_TOKEN,

  // Fixture
  CEREMONY_PNG_BUFFER,
  CEREMONY_PNG_SHA256,
  CEREMONY_PNG_DATA_URL,

  // Utility (exported for retrieval scripts to rebuild fixture for comparison)
  buildCeremonyPng,
};
