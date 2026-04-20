// src/cil/quoteSignatureStorage.test.js
// Phase 2B Sections 1–3: format helpers + PNG validation + upload pipeline.
// Section 4 adds retrieval suite.

const crypto = require('crypto');
const zlib = require('zlib');
const { Readable } = require('stream');

const mod = require('./quoteSignatureStorage');
const {
  SIGNATURE_BUCKET,
  SIGNATURE_STORAGE_KEY_RE,
  SIG_ERR,
  PNG_MIN_BYTES,
  PNG_MAX_BYTES,
  PNG_MAX_BASE64_LENGTH,
  buildSignatureStorageKey,
  parseSignatureStorageKey,
  uploadSignaturePng,
  cleanupOrphanPng,
  getSignatureForOwner,
  getSignatureViaShareToken,
  _internals,
} = mod;
const {
  PNG_MAGIC,
  PNG_IEND_TRAILER,
  DATA_URL_PNG_RE,
  extractAndNormalizeBase64,
  validatePngBuffer,
  computePngSha256,
  requireAdmin,
  classifySupabaseUploadError,
  SIG_LOAD_COLUMNS,
  SIG_TOKEN_RESOLVE_COLUMNS,
  UUID_LOWERCASE_RE,
  SHARE_TOKEN_RE,
  assertUuid,
  assertOwnerId,
  assertShareToken,
  fetchSignatureStream,
} = _internals;

// ─── Section 2 test fixtures ────────────────────────────────────────────────
//
// MINIMAL_VALID_PNG — a real, spec-conformant 1×1 grayscale PNG built at
// test-load time via zlib + hand-rolled CRC-32 (~67 bytes). Used for hash-
// determinism tests where real PNG content matters.
//
// synthetic100BytePng — Buffer.concat([PNG_MAGIC, zero-padding, PNG_IEND_TRAILER]).
// Deliberately NOT a spec-conformant PNG (body is zero-padding, not real
// chunks). Passes V2 validation by design — V2 specifies "magic + IEND +
// size bounds" per §25.4 invariant 1, NOT full PNG spec conformance. Tests
// match the contract, not exceed it.

// CRC-32 per RFC 1952 / PNG spec (polynomial 0xEDB88320). Used once at
// test-load to construct MINIMAL_VALID_PNG; not shipped in the module.
function testCrc32(buf) {
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
  crcBuf.writeUInt32BE(testCrc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

const MINIMAL_VALID_PNG = (() => {
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  // IHDR: 1×1, 8-bit, grayscale, no interlace
  const ihdr = makePngChunk('IHDR', Buffer.from([
    0x00, 0x00, 0x00, 0x01,  // width = 1
    0x00, 0x00, 0x00, 0x01,  // height = 1
    0x08,                    // bit depth = 8
    0x00,                    // color type = grayscale
    0x00,                    // compression = deflate
    0x00,                    // filter method = default
    0x00,                    // interlace = none
  ]));
  // IDAT: filter byte 0x00 + single white pixel 0xFF, zlib-compressed
  const idat = makePngChunk('IDAT', zlib.deflateSync(Buffer.from([0x00, 0xFF])));
  const iend = makePngChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, idat, iend]);
})();

// Synthetic buffer exactly 100 bytes: 8 magic + 80 zero pad + 12 IEND.
// Structural passes V2; not a real PNG by spec.
function makeSynthetic(totalBytes) {
  if (totalBytes < 20) throw new Error('synthetic PNG needs >= 20 bytes');
  const padLength = totalBytes - PNG_MAGIC.length - PNG_IEND_TRAILER.length;
  return Buffer.concat([PNG_MAGIC, Buffer.alloc(padLength, 0), PNG_IEND_TRAILER]);
}
const synthetic100BytePng = makeSynthetic(100);

// ─── Pinned inputs for cross-version regression lock (Q7 Addition 1) ────────
const PINNED_INPUTS = Object.freeze({
  tenantId:       '86907c28-a9ea-4318-819d-5a012192119b',
  quoteId:        '7f3e9b44-8c21-4a7d-b5f2-1e4c9d8a7b60',
  quoteVersionId: '1a2b3c4d-5e6f-7a8b-9c0d-ef1234567890',
  signatureId:    '9f8e7d6c-5b4a-3928-1706-fedcba987654',
});
const PINNED_STORAGE_KEY =
  'chiefos-signatures/86907c28-a9ea-4318-819d-5a012192119b/' +
  '7f3e9b44-8c21-4a7d-b5f2-1e4c9d8a7b60/' +
  '1a2b3c4d-5e6f-7a8b-9c0d-ef1234567890/' +
  '9f8e7d6c-5b4a-3928-1706-fedcba987654.png';

// Convenience builder for mutated keys in rejection tests.
function makeKey(overrides = {}) {
  const i = { ...PINNED_INPUTS, ...overrides };
  return `${SIGNATURE_BUCKET}/${i.tenantId}/${i.quoteId}/${i.quoteVersionId}/${i.signatureId}.png`;
}

// ─── SIGNATURE_BUCKET constant ──────────────────────────────────────────────

describe('SIGNATURE_BUCKET', () => {
  it('is chiefos-signatures', () => {
    expect(SIGNATURE_BUCKET).toBe('chiefos-signatures');
  });
});

// ─── SIGNATURE_STORAGE_KEY_RE format ────────────────────────────────────────

describe('SIGNATURE_STORAGE_KEY_RE', () => {
  it('accepts well-formed pinned key', () => {
    expect(SIGNATURE_STORAGE_KEY_RE.test(PINNED_STORAGE_KEY)).toBe(true);
  });

  it('rejects key with wrong bucket name', () => {
    const bad = PINNED_STORAGE_KEY.replace('chiefos-signatures', 'chiefos-media');
    expect(SIGNATURE_STORAGE_KEY_RE.test(bad)).toBe(false);
  });

  it('rejects key with uppercase UUID', () => {
    const bad = PINNED_STORAGE_KEY.replace(
      '86907c28-a9ea-4318-819d-5a012192119b',
      '86907C28-A9EA-4318-819D-5A012192119B'
    );
    expect(SIGNATURE_STORAGE_KEY_RE.test(bad)).toBe(false);
  });

  it('rejects key missing .png extension', () => {
    const bad = PINNED_STORAGE_KEY.replace(/\.png$/, '');
    expect(SIGNATURE_STORAGE_KEY_RE.test(bad)).toBe(false);
  });

  it('rejects key with .jpg extension', () => {
    const bad = PINNED_STORAGE_KEY.replace(/\.png$/, '.jpg');
    expect(SIGNATURE_STORAGE_KEY_RE.test(bad)).toBe(false);
  });

  it('rejects key with extra path segment', () => {
    const bad = PINNED_STORAGE_KEY.replace(/\.png$/, '/extra.png');
    expect(SIGNATURE_STORAGE_KEY_RE.test(bad)).toBe(false);
  });

  it('rejects key with missing path segment', () => {
    const bad = PINNED_STORAGE_KEY.replace(
      `/${PINNED_INPUTS.quoteVersionId}/${PINNED_INPUTS.signatureId}.png`,
      `/${PINNED_INPUTS.signatureId}.png`
    );
    expect(SIGNATURE_STORAGE_KEY_RE.test(bad)).toBe(false);
  });

  it('rejects leading slash', () => {
    expect(SIGNATURE_STORAGE_KEY_RE.test(`/${PINNED_STORAGE_KEY}`)).toBe(false);
  });

  it('rejects trailing slash', () => {
    expect(SIGNATURE_STORAGE_KEY_RE.test(`${PINNED_STORAGE_KEY}/`)).toBe(false);
  });

  it('rejects non-UUID tenant segment', () => {
    const bad = PINNED_STORAGE_KEY.replace(PINNED_INPUTS.tenantId, 'not-a-uuid');
    expect(SIGNATURE_STORAGE_KEY_RE.test(bad)).toBe(false);
  });
});

// ─── SIG_ERR constants ──────────────────────────────────────────────────────

describe('SIG_ERR', () => {
  const expected = {
    SIGNATURE_NOT_FOUND:   { code: 'SIGNATURE_NOT_FOUND',   status: 404 },
    SHARE_TOKEN_NOT_FOUND: { code: 'SHARE_TOKEN_NOT_FOUND', status: 404 },
    SHARE_TOKEN_EXPIRED:   { code: 'SHARE_TOKEN_EXPIRED',   status: 410 },
    SHARE_TOKEN_REVOKED:   { code: 'SHARE_TOKEN_REVOKED',   status: 410 },
    STORAGE_KEY_MALFORMED: { code: 'STORAGE_KEY_MALFORMED', status: 500 },
    STORAGE_FETCH_FAILED:  { code: 'STORAGE_FETCH_FAILED',  status: 502 },
    PNG_MALFORMED:         { code: 'PNG_MALFORMED',         status: 400 },
    PNG_TOO_LARGE:         { code: 'PNG_TOO_LARGE',         status: 400 },
    PNG_TOO_SMALL:         { code: 'PNG_TOO_SMALL',         status: 400 },
    PNG_UPLOAD_FAILED:     { code: 'PNG_UPLOAD_FAILED',     status: 500 },
    PNG_UPLOAD_DUPLICATE:  { code: 'PNG_UPLOAD_DUPLICATE',  status: 500 },
    PNG_BUCKET_MISSING:    { code: 'PNG_BUCKET_MISSING',    status: 500 },
    BAD_REQUEST:           { code: 'BAD_REQUEST',           status: 400 },
  };

  it.each(Object.entries(expected))('SIG_ERR.%s has correct code + status', (key, spec) => {
    expect(SIG_ERR[key]).toBeDefined();
    expect(SIG_ERR[key].code).toBe(spec.code);
    expect(SIG_ERR[key].status).toBe(spec.status);
  });

  it('has no SHARE_TOKEN_MISMATCH entry (collapsed per §25.5 enumeration tightening)', () => {
    expect(SIG_ERR.SHARE_TOKEN_MISMATCH).toBeUndefined();
  });

  it('SIG_ERR is deeply frozen — modifications throw in strict mode', () => {
    'use strict';
    // Outer freeze: can't add new keys
    expect(() => { SIG_ERR.NEW_KEY = { code: 'NEW', status: 999 }; })
      .toThrow(TypeError);
    // Inner freeze: can't mutate existing entries
    expect(() => { SIG_ERR.SIGNATURE_NOT_FOUND.status = 999; })
      .toThrow(TypeError);
    // State unchanged
    expect(SIG_ERR.SIGNATURE_NOT_FOUND.status).toBe(404);
    expect(SIG_ERR.SIGNATURE_NOT_FOUND.code).toBe('SIGNATURE_NOT_FOUND');
  });
});

// ─── buildSignatureStorageKey ───────────────────────────────────────────────

describe('buildSignatureStorageKey', () => {
  it('happy path produces length-170 regex-matching string', () => {
    const key = buildSignatureStorageKey(PINNED_INPUTS);
    expect(key.length).toBe(170);
    expect(SIGNATURE_STORAGE_KEY_RE.test(key)).toBe(true);
  });

  // Helper: assert the thrown error carries code STORAGE_KEY_MALFORMED.
  // We check err.code directly rather than regex-matching err.message because
  // the code is the stable contract — message text may be refined later.
  function expectStorageKeyMalformed(fn) {
    try {
      fn();
      throw new Error('expected throw');
    } catch (e) {
      expect(e.name).toBe('CilIntegrityError');
      expect(e.code).toBe(SIG_ERR.STORAGE_KEY_MALFORMED.code);
    }
  }

  it('rejects uppercase UUID input', () => {
    expectStorageKeyMalformed(() => buildSignatureStorageKey({
      ...PINNED_INPUTS,
      tenantId: '86907C28-A9EA-4318-819D-5A012192119B',
    }));
  });

  it('rejects missing field (undefined tenantId)', () => {
    expectStorageKeyMalformed(() => buildSignatureStorageKey({
      ...PINNED_INPUTS,
      tenantId: undefined,
    }));
  });

  it('rejects non-UUID tenantId string', () => {
    expectStorageKeyMalformed(() => buildSignatureStorageKey({
      ...PINNED_INPUTS,
      tenantId: 'not-a-uuid',
    }));
  });

  it('rejects non-UUID quoteId string', () => {
    expectStorageKeyMalformed(() => buildSignatureStorageKey({
      ...PINNED_INPUTS,
      quoteId: '12345',
    }));
  });

  it('rejects UUID with bad group length', () => {
    expectStorageKeyMalformed(() => buildSignatureStorageKey({
      ...PINNED_INPUTS,
      // One char short in the final group.
      signatureId: '9f8e7d6c-5b4a-3928-1706-fedcba98765',
    }));
  });

  it('throws CilIntegrityError with STORAGE_KEY_MALFORMED code', () => {
    try {
      buildSignatureStorageKey({ ...PINNED_INPUTS, tenantId: 'bad' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e.name).toBe('CilIntegrityError');
      expect(e.code).toBe(SIG_ERR.STORAGE_KEY_MALFORMED.code);
      expect(typeof e.hint).toBe('string');
    }
  });
});

// ─── parseSignatureStorageKey ───────────────────────────────────────────────

describe('parseSignatureStorageKey', () => {
  // Helper: assert the thrown error carries code STORAGE_KEY_MALFORMED.
  function expectStorageKeyMalformed(fn) {
    try {
      fn();
      throw new Error('expected throw');
    } catch (e) {
      expect(e.name).toBe('CilIntegrityError');
      expect(e.code).toBe(SIG_ERR.STORAGE_KEY_MALFORMED.code);
    }
  }

  it('happy path decomposes into correct five-tuple', () => {
    const parsed = parseSignatureStorageKey(PINNED_STORAGE_KEY);
    expect(parsed).toEqual({
      bucket: SIGNATURE_BUCKET,
      ...PINNED_INPUTS,
    });
  });

  it('rejects malformed key (missing extension)', () => {
    const bad = PINNED_STORAGE_KEY.replace(/\.png$/, '');
    expectStorageKeyMalformed(() => parseSignatureStorageKey(bad));
  });

  it('rejects non-string input (null)', () => {
    expectStorageKeyMalformed(() => parseSignatureStorageKey(null));
  });

  it('rejects non-string input (undefined)', () => {
    expectStorageKeyMalformed(() => parseSignatureStorageKey(undefined));
  });

  it('rejects non-string input (number)', () => {
    expectStorageKeyMalformed(() => parseSignatureStorageKey(42));
  });

  it('rejects empty string', () => {
    expectStorageKeyMalformed(() => parseSignatureStorageKey(''));
  });

  it('rejects key with wrong bucket via regex (bucket-constant check is unreachable but documented)', () => {
    // Regex hardcodes 'chiefos-signatures'; substituting another bucket name
    // fails at the regex layer before reaching the bucket-constant check.
    // The defensive bucket check in parseSignatureStorageKey is documented
    // as unreachable-under-current-regex per §25.3 rule 3.
    const bad = PINNED_STORAGE_KEY.replace('chiefos-signatures', 'chiefos-media');
    expectStorageKeyMalformed(() => parseSignatureStorageKey(bad));
  });
});

// ─── Round-trip invariant ───────────────────────────────────────────────────

describe('build ↔ parse round-trip', () => {
  it('build then parse returns original inputs', () => {
    const built = buildSignatureStorageKey(PINNED_INPUTS);
    const parsed = parseSignatureStorageKey(built);
    expect(parsed.tenantId).toBe(PINNED_INPUTS.tenantId);
    expect(parsed.quoteId).toBe(PINNED_INPUTS.quoteId);
    expect(parsed.quoteVersionId).toBe(PINNED_INPUTS.quoteVersionId);
    expect(parsed.signatureId).toBe(PINNED_INPUTS.signatureId);
    expect(parsed.bucket).toBe(SIGNATURE_BUCKET);
  });

  it('build is deterministic — same inputs produce same output', () => {
    const a = buildSignatureStorageKey(PINNED_INPUTS);
    const b = buildSignatureStorageKey(PINNED_INPUTS);
    expect(a).toBe(b);
  });
});

// ─── Cross-version regression lock (Q7 Addition 1) ──────────────────────────
//
// Pins deterministic construction AND parser round-trip against known
// tuple. Failure signals a format-convention bump that requires:
//   1. §25.1 / §25.3 update in docs/QUOTES_SPINE_DECISIONS.md
//   2. DB CHECK constraint migration for chiefos-signatures bucket
//   3. Storage-key rewrite migration for all existing signature rows
//   4. Regression lock updated to new pinned value
//
// Do NOT simply update the pin without steps 1–3. Storage keys in
// production are immutable (Migration 4 strict-immutability trigger);
// convention changes require an explicit migration path.

describe('cross-version regression lock', () => {
  it('pinned inputs produce pinned storage_key — format is frozen', () => {
    const built = buildSignatureStorageKey(PINNED_INPUTS);
    if (built !== PINNED_STORAGE_KEY) {
      throw new Error(
        'Storage key format changed; this is a §25 convention bump and ' +
        'requires migration for existing signatures.\n' +
        `  expected: ${PINNED_STORAGE_KEY}\n` +
        `  got:      ${built}`
      );
    }
    expect(built).toBe(PINNED_STORAGE_KEY);
    expect(built.length).toBe(170);
  });

  it('pinned storage_key parses to pinned input tuple', () => {
    const parsed = parseSignatureStorageKey(PINNED_STORAGE_KEY);
    expect(parsed).toEqual({
      bucket: SIGNATURE_BUCKET,
      ...PINNED_INPUTS,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 2 tests: PNG validation constants + helpers
// ═══════════════════════════════════════════════════════════════════════════

// Helper: assert thrown error carries a specific SIG_ERR code.
function expectCilError(fn, expectedCode) {
  try {
    fn();
    throw new Error('expected throw');
  } catch (e) {
    expect(e.name).toBe('CilIntegrityError');
    expect(e.code).toBe(expectedCode);
  }
}

// ─── PNG constants ──────────────────────────────────────────────────────────

describe('PNG constants', () => {
  it('PNG_MAGIC is the 8-byte PNG signature per RFC 2083 §3.1', () => {
    expect(PNG_MAGIC.length).toBe(8);
    expect(Array.from(PNG_MAGIC)).toEqual([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  });

  it('PNG_IEND_TRAILER is the 12-byte IEND chunk per RFC 2083 §11.2.5', () => {
    expect(PNG_IEND_TRAILER.length).toBe(12);
    expect(Array.from(PNG_IEND_TRAILER)).toEqual([
      0x00, 0x00, 0x00, 0x00,  // length
      0x49, 0x45, 0x4E, 0x44,  // 'IEND'
      0xAE, 0x42, 0x60, 0x82,  // CRC
    ]);
  });

  it('PNG_MIN_BYTES = 100', () => {
    expect(PNG_MIN_BYTES).toBe(100);
  });

  it('PNG_MAX_BYTES = 2 MB', () => {
    expect(PNG_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(PNG_MAX_BYTES).toBe(2097152);
  });

  it('PNG_MAX_BASE64_LENGTH computed from PNG_MAX_BYTES', () => {
    expect(PNG_MAX_BASE64_LENGTH).toBe(Math.ceil(PNG_MAX_BYTES / 3) * 4 + 16);
    // 2097152 / 3 = 699050.666... → ceil = 699051
    // 699051 * 4 = 2796204, + 16 slack = 2796220
    expect(PNG_MAX_BASE64_LENGTH).toBe(2796220);
  });

  it('DATA_URL_PNG_RE accepts typical PNG data URL', () => {
    expect(DATA_URL_PNG_RE.test('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
  });

  it('DATA_URL_PNG_RE rejects non-PNG MIME type', () => {
    expect(DATA_URL_PNG_RE.test('data:image/jpeg;base64,/9j/4A==')).toBe(false);
  });

  it('DATA_URL_PNG_RE rejects non-base64 characters', () => {
    expect(DATA_URL_PNG_RE.test('data:image/png;base64,!@#$%^')).toBe(false);
  });

  it('DATA_URL_PNG_RE is case-sensitive on prefix', () => {
    expect(DATA_URL_PNG_RE.test('Data:Image/PNG;Base64,iVBORw0KGgo=')).toBe(false);
  });

  it('DATA_URL_PNG_RE requires non-empty base64 body', () => {
    // Regex uses + (one or more); empty body fails.
    expect(DATA_URL_PNG_RE.test('data:image/png;base64,')).toBe(false);
  });
});

// ─── extractAndNormalizeBase64 ─────────────────────────────────────────────

describe('extractAndNormalizeBase64', () => {
  it('happy path: valid data URL returns extracted base64', () => {
    const out = extractAndNormalizeBase64('data:image/png;base64,iVBORw0KGgo=');
    expect(out).toBe('iVBORw0KGgo=');
  });

  it('normalizes MIME-style line-wrapped base64 (strips \\n, \\r\\n, \\t, spaces)', () => {
    const wrapped = 'data:image/png;base64,iV\nBOR\r\nw0\tKG go=';
    const out = extractAndNormalizeBase64(wrapped);
    expect(out).toBe('iVBORw0KGgo=');
  });

  it('rejects non-string input', () => {
    expectCilError(() => extractAndNormalizeBase64(null), SIG_ERR.PNG_MALFORMED.code);
    expectCilError(() => extractAndNormalizeBase64(undefined), SIG_ERR.PNG_MALFORMED.code);
    expectCilError(() => extractAndNormalizeBase64(42), SIG_ERR.PNG_MALFORMED.code);
  });

  it('rejects non-PNG MIME type (JPEG)', () => {
    expectCilError(
      () => extractAndNormalizeBase64('data:image/jpeg;base64,/9j/4A=='),
      SIG_ERR.PNG_MALFORMED.code
    );
  });

  it('rejects non-base64 characters in body', () => {
    expectCilError(
      () => extractAndNormalizeBase64('data:image/png;base64,!@#$'),
      SIG_ERR.PNG_MALFORMED.code
    );
  });

  it('rejects empty base64 body', () => {
    // Regex + quantifier rejects zero-length body outright.
    expectCilError(
      () => extractAndNormalizeBase64('data:image/png;base64,'),
      SIG_ERR.PNG_MALFORMED.code
    );
  });

  it('rejects whitespace-only base64 body (post-normalization empty)', () => {
    expectCilError(
      () => extractAndNormalizeBase64('data:image/png;base64,   \n  '),
      SIG_ERR.PNG_MALFORMED.code
    );
  });

  it('rejects case-mismatched prefix', () => {
    expectCilError(
      () => extractAndNormalizeBase64('Data:Image/PNG;Base64,iVBORw0KGgo='),
      SIG_ERR.PNG_MALFORMED.code
    );
  });

  it('rejects oversized base64 (PNG_TOO_LARGE precheck)', () => {
    const huge = 'A'.repeat(PNG_MAX_BASE64_LENGTH + 1);
    expectCilError(
      () => extractAndNormalizeBase64(`data:image/png;base64,${huge}`),
      SIG_ERR.PNG_TOO_LARGE.code
    );
  });

  it('accepts exactly PNG_MAX_BASE64_LENGTH (boundary)', () => {
    const atLimit = 'A'.repeat(PNG_MAX_BASE64_LENGTH);
    const out = extractAndNormalizeBase64(`data:image/png;base64,${atLimit}`);
    expect(out.length).toBe(PNG_MAX_BASE64_LENGTH);
  });
});

// ─── validatePngBuffer — magic + trailer + size ────────────────────────────

describe('validatePngBuffer', () => {
  it('accepts synthetic 100-byte buffer (magic + pad + IEND)', () => {
    // V2 contract: magic + trailer + size bounds. Synthetic body is not a
    // valid PNG per spec; V2 doesn't claim to detect that.
    expect(() => validatePngBuffer(synthetic100BytePng)).not.toThrow();
  });

  it('accepts real MINIMAL_VALID_PNG after padding to PNG_MIN_BYTES', () => {
    // Real PNG built via zlib + CRC; ~67 bytes, below MIN. Padding to 100
    // makes it pass size check while magic + trailer still valid.
    // We verify the real MINIMAL_VALID_PNG has correct magic and trailer:
    expect(MINIMAL_VALID_PNG.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect(MINIMAL_VALID_PNG.subarray(-12).equals(PNG_IEND_TRAILER)).toBe(true);
    expect(MINIMAL_VALID_PNG.length).toBeLessThan(PNG_MIN_BYTES);
    // And fails validation under-size:
    expectCilError(() => validatePngBuffer(MINIMAL_VALID_PNG), SIG_ERR.PNG_TOO_SMALL.code);
  });

  it('rejects non-Buffer input', () => {
    expectCilError(() => validatePngBuffer('not a buffer'), SIG_ERR.PNG_MALFORMED.code);
    expectCilError(() => validatePngBuffer(null), SIG_ERR.PNG_MALFORMED.code);
    expectCilError(() => validatePngBuffer(undefined), SIG_ERR.PNG_MALFORMED.code);
    expectCilError(() => validatePngBuffer({}), SIG_ERR.PNG_MALFORMED.code);
  });

  it('rejects empty Buffer with PNG_TOO_SMALL', () => {
    expectCilError(() => validatePngBuffer(Buffer.alloc(0)), SIG_ERR.PNG_TOO_SMALL.code);
  });

  it('rejects buffer at PNG_MIN_BYTES - 1 with PNG_TOO_SMALL', () => {
    const tooSmall = Buffer.alloc(PNG_MIN_BYTES - 1);
    expectCilError(() => validatePngBuffer(tooSmall), SIG_ERR.PNG_TOO_SMALL.code);
  });

  it('accepts buffer at exactly PNG_MIN_BYTES boundary', () => {
    const atMin = makeSynthetic(PNG_MIN_BYTES);
    expect(atMin.length).toBe(PNG_MIN_BYTES);
    expect(() => validatePngBuffer(atMin)).not.toThrow();
  });

  it('accepts buffer at exactly PNG_MAX_BYTES boundary', () => {
    const atMax = makeSynthetic(PNG_MAX_BYTES);
    expect(atMax.length).toBe(PNG_MAX_BYTES);
    expect(() => validatePngBuffer(atMax)).not.toThrow();
  });

  it('rejects buffer at PNG_MAX_BYTES + 1 with PNG_TOO_LARGE', () => {
    const tooLarge = makeSynthetic(PNG_MAX_BYTES + 1);
    expectCilError(() => validatePngBuffer(tooLarge), SIG_ERR.PNG_TOO_LARGE.code);
  });

  it('rejects buffer with wrong magic bytes', () => {
    // Replace first byte of magic with 0x00.
    const bad = Buffer.from(synthetic100BytePng);
    bad[0] = 0x00;
    expectCilError(() => validatePngBuffer(bad), SIG_ERR.PNG_MALFORMED.code);
  });

  it('rejects buffer with wrong IEND trailer', () => {
    // Replace last byte of trailer with 0xFF.
    const bad = Buffer.from(synthetic100BytePng);
    bad[bad.length - 1] = 0xFF;
    expectCilError(() => validatePngBuffer(bad), SIG_ERR.PNG_MALFORMED.code);
  });

  it('rejects truncated PNG (last byte removed destroys trailer)', () => {
    // Build a 200-byte fixture so truncating 1 byte still leaves a buffer
    // above PNG_MIN_BYTES; truncation destroys the IEND trailer alignment
    // (what the test is actually exercising — size check would fire first
    // on a sub-MIN buffer and mask the trailer-check contract).
    const big = makeSynthetic(200);
    const truncated = big.subarray(0, big.length - 1);
    expect(truncated.length).toBeGreaterThanOrEqual(PNG_MIN_BYTES);
    expectCilError(() => validatePngBuffer(truncated), SIG_ERR.PNG_MALFORMED.code);
  });

  it('rejects all-zero buffer of valid size', () => {
    // All zeros = no magic, no trailer.
    const zeros = Buffer.alloc(PNG_MIN_BYTES);
    expectCilError(() => validatePngBuffer(zeros), SIG_ERR.PNG_MALFORMED.code);
  });
});

// ─── computePngSha256 ──────────────────────────────────────────────────────

describe('computePngSha256', () => {
  it('handles empty buffer with known SHA-256', () => {
    // Known-value test: SHA-256 of empty input is a well-known constant.
    // In practice validatePngBuffer rejects empty buffers upstream; this
    // test validates the crypto wiring, not a real code path.
    expect(computePngSha256(Buffer.alloc(0)))
      .toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('produces 64-char lowercase hex output', () => {
    const hash = computePngSha256(synthetic100BytePng);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash.length).toBe(64);
  });

  it('is deterministic — same buffer twice yields same hash', () => {
    const a = computePngSha256(synthetic100BytePng);
    const b = computePngSha256(synthetic100BytePng);
    expect(a).toBe(b);
  });

  it('different buffers produce different hashes', () => {
    const a = computePngSha256(synthetic100BytePng);
    const b = computePngSha256(Buffer.concat([synthetic100BytePng, Buffer.from([0x00])]));
    expect(a).not.toBe(b);
  });

  it('matches Node crypto SHA-256 reference (MINIMAL_VALID_PNG)', () => {
    const ours = computePngSha256(MINIMAL_VALID_PNG);
    const ref = crypto.createHash('sha256').update(MINIMAL_VALID_PNG).digest('hex');
    expect(ours).toBe(ref);
  });

  it('rejects non-Buffer input with PNG_MALFORMED', () => {
    expectCilError(() => computePngSha256('string'), SIG_ERR.PNG_MALFORMED.code);
    expectCilError(() => computePngSha256(null), SIG_ERR.PNG_MALFORMED.code);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 3 tests: upload pipeline + orphan cleanup + error classifier
// ═══════════════════════════════════════════════════════════════════════════

// ─── Mock supabaseAdmin shape (shared with Section 4) ──────────────────────
//
// Minimum-viable mock matching services/supabaseAdmin.js's public surface.
// createSignedUrl is stubbed even though Section 3 doesn't use it — avoids
// mock-shape churn when Section 4 lands.

function createMockSupabaseAdmin({ uploadError, removeError, removeThrows, adminNull } = {}) {
  const uploadMock = jest.fn().mockResolvedValue(
    uploadError
      ? { data: null, error: uploadError }
      : { data: { path: 'mock-path' }, error: null }
  );
  const removeMock = removeThrows
    ? jest.fn().mockRejectedValue(new Error('simulated remove throw'))
    : jest.fn().mockResolvedValue(
        removeError
          ? { data: null, error: removeError }
          : { data: [], error: null }
      );
  const createSignedUrlMock = jest.fn().mockResolvedValue({
    data: { signedUrl: 'mock://signed-url' },
    error: null,
  });
  const fromMock = jest.fn().mockReturnValue({
    upload: uploadMock,
    remove: removeMock,
    createSignedUrl: createSignedUrlMock,
  });
  const getAdminClient = jest.fn().mockReturnValue(
    adminNull ? null : { storage: { from: fromMock } }
  );
  return {
    module: { getAdminClient },
    uploadMock,
    removeMock,
    createSignedUrlMock,
    fromMock,
    getAdminClient,
  };
}

// ─── Section 3 fixtures: valid data URL + storageKey for happy-path use ────

// Build a 100-byte synthetic PNG buffer and wrap it as a data URL.
// Used across Section 3 happy-path and storage-key-related tests.
const VALID_PNG_BUFFER_100 = makeSynthetic(100);
const VALID_PNG_DATA_URL = `data:image/png;base64,${VALID_PNG_BUFFER_100.toString('base64')}`;
const VALID_STORAGE_KEY = buildSignatureStorageKey(PINNED_INPUTS);

describe('Section 3 mock shape', () => {
  it('createMockSupabaseAdmin returns expected interface', () => {
    const mock = createMockSupabaseAdmin();
    expect(mock.module).toHaveProperty('getAdminClient');
    expect(typeof mock.module.getAdminClient).toBe('function');

    const admin = mock.module.getAdminClient();
    expect(admin).toHaveProperty('storage');
    expect(admin.storage).toHaveProperty('from');

    const bucket = admin.storage.from('any-bucket');
    expect(bucket).toHaveProperty('upload');
    expect(bucket).toHaveProperty('remove');
    expect(bucket).toHaveProperty('createSignedUrl');
  });
});

// ─── classifySupabaseUploadError ───────────────────────────────────────────

describe('classifySupabaseUploadError', () => {
  it('maps "The resource already exists" → PNG_UPLOAD_DUPLICATE', () => {
    const err = classifySupabaseUploadError({ message: 'The resource already exists' });
    expect(err.name).toBe('CilIntegrityError');
    expect(err.code).toBe(SIG_ERR.PNG_UPLOAD_DUPLICATE.code);
    expect(err.hint).toMatch(/orphan/i);
    expect(err.hint).toMatch(/reaper/i);
  });

  it('maps "Bucket not found" → PNG_BUCKET_MISSING', () => {
    const err = classifySupabaseUploadError({ message: 'Bucket not found' });
    expect(err.code).toBe(SIG_ERR.PNG_BUCKET_MISSING.code);
    expect(err.hint).toMatch(/chiefos-signatures/);
    expect(err.hint).toMatch(/provisioning/i);
  });

  it('maps "Bucket does not exist" → PNG_BUCKET_MISSING (alt phrasing)', () => {
    const err = classifySupabaseUploadError({ message: 'Bucket does not exist for project' });
    expect(err.code).toBe(SIG_ERR.PNG_BUCKET_MISSING.code);
  });

  it('maps auth failure with status 401 → PNG_UPLOAD_FAILED with status in hint', () => {
    const err = classifySupabaseUploadError({
      message: 'Not authorized',
      status: 401,
    });
    expect(err.code).toBe(SIG_ERR.PNG_UPLOAD_FAILED.code);
    expect(err.hint).toMatch(/not authorized/i);
    expect(err.hint).toMatch(/status 401/);
  });

  it('maps generic unknown error → PNG_UPLOAD_FAILED with raw message in hint', () => {
    const err = classifySupabaseUploadError({ message: 'Something unexpected' });
    expect(err.code).toBe(SIG_ERR.PNG_UPLOAD_FAILED.code);
    expect(err.hint).toMatch(/Something unexpected/);
  });

  it('defensively handles undefined input → PNG_UPLOAD_FAILED', () => {
    const err = classifySupabaseUploadError(undefined);
    expect(err.code).toBe(SIG_ERR.PNG_UPLOAD_FAILED.code);
    expect(err.hint).toMatch(/unknown supabase error/);
  });

  it('defensively handles plain string input → PNG_UPLOAD_FAILED', () => {
    const err = classifySupabaseUploadError('raw string error');
    expect(err.code).toBe(SIG_ERR.PNG_UPLOAD_FAILED.code);
    expect(err.hint).toMatch(/raw string error/);
  });

  it('defensively handles object without .message → PNG_UPLOAD_FAILED', () => {
    const err = classifySupabaseUploadError({ someRandomField: 'x' });
    expect(err.code).toBe(SIG_ERR.PNG_UPLOAD_FAILED.code);
    expect(err.hint).toMatch(/unknown supabase error/);
  });

  it('reads statusCode when status absent', () => {
    const err = classifySupabaseUploadError({
      message: 'Something failed',
      statusCode: 500,
    });
    expect(err.hint).toMatch(/status 500/);
  });
});

// ─── requireAdmin ──────────────────────────────────────────────────────────

describe('requireAdmin', () => {
  it('returns admin client when getAdminClient returns non-null', () => {
    const mock = createMockSupabaseAdmin();
    const admin = requireAdmin(mock.module, SIG_ERR.PNG_UPLOAD_FAILED.code);
    expect(admin).toBeTruthy();
    expect(admin).toHaveProperty('storage');
  });

  it('throws with passed error code when getAdminClient returns null', () => {
    const mock = createMockSupabaseAdmin({ adminNull: true });
    try {
      requireAdmin(mock.module, SIG_ERR.STORAGE_FETCH_FAILED.code);
      throw new Error('expected throw');
    } catch (e) {
      expect(e.name).toBe('CilIntegrityError');
      expect(e.code).toBe(SIG_ERR.STORAGE_FETCH_FAILED.code);
      expect(e.hint).toMatch(/SUPABASE_URL/);
      expect(e.hint).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    }
  });

  it('falls back to PNG_UPLOAD_FAILED when no errCode supplied', () => {
    const mock = createMockSupabaseAdmin({ adminNull: true });
    try {
      requireAdmin(mock.module, null);
      throw new Error('expected throw');
    } catch (e) {
      expect(e.code).toBe(SIG_ERR.PNG_UPLOAD_FAILED.code);
    }
  });

  it('throws when supabaseAdmin itself is null / missing getAdminClient', () => {
    try {
      requireAdmin(null, SIG_ERR.PNG_UPLOAD_FAILED.code);
      throw new Error('expected throw');
    } catch (e) {
      expect(e.code).toBe(SIG_ERR.PNG_UPLOAD_FAILED.code);
    }
    try {
      requireAdmin({}, SIG_ERR.PNG_UPLOAD_FAILED.code);
      throw new Error('expected throw');
    } catch (e) {
      expect(e.code).toBe(SIG_ERR.PNG_UPLOAD_FAILED.code);
    }
  });
});

// ─── uploadSignaturePng — happy path ──────────────────────────────────────

describe('uploadSignaturePng — happy path', () => {
  it('returns { pngBuffer, sha256 } with correct values', async () => {
    const mock = createMockSupabaseAdmin();
    const result = await uploadSignaturePng({
      pngDataUrl: VALID_PNG_DATA_URL,
      storageKey: VALID_STORAGE_KEY,
      supabaseAdmin: mock.module,
    });
    expect(Buffer.isBuffer(result.pngBuffer)).toBe(true);
    expect(result.pngBuffer.equals(VALID_PNG_BUFFER_100)).toBe(true);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);

    // Hash matches reference.
    const ref = crypto.createHash('sha256').update(VALID_PNG_BUFFER_100).digest('hex');
    expect(result.sha256).toBe(ref);
  });

  it('calls admin.storage.from with SIGNATURE_BUCKET literal', async () => {
    const mock = createMockSupabaseAdmin();
    await uploadSignaturePng({
      pngDataUrl: VALID_PNG_DATA_URL,
      storageKey: VALID_STORAGE_KEY,
      supabaseAdmin: mock.module,
    });
    expect(mock.fromMock).toHaveBeenCalledWith(SIGNATURE_BUCKET);
    expect(mock.fromMock).toHaveBeenCalledWith('chiefos-signatures');
  });

  it('calls upload with path stripped of bucket prefix + buffer + correct options', async () => {
    const mock = createMockSupabaseAdmin();
    await uploadSignaturePng({
      pngDataUrl: VALID_PNG_DATA_URL,
      storageKey: VALID_STORAGE_KEY,
      supabaseAdmin: mock.module,
    });
    expect(mock.uploadMock).toHaveBeenCalledTimes(1);
    const [pathArg, bufferArg, optionsArg] = mock.uploadMock.mock.calls[0];

    // Path is storageKey minus "chiefos-signatures/" prefix.
    expect(pathArg).toBe(VALID_STORAGE_KEY.slice(SIGNATURE_BUCKET.length + 1));
    // Buffer equals decoded PNG bytes.
    expect(Buffer.isBuffer(bufferArg)).toBe(true);
    expect(bufferArg.equals(VALID_PNG_BUFFER_100)).toBe(true);
    // Options include contentType.
    expect(optionsArg.contentType).toBe('image/png');
  });
});

// ─── uploadSignaturePng — §25.4 invariant checks ──────────────────────────

describe('uploadSignaturePng — invariants', () => {
  it('passes upsert: false explicitly (§25.4 invariant 4 non-negotiable)', async () => {
    const mock = createMockSupabaseAdmin();
    await uploadSignaturePng({
      pngDataUrl: VALID_PNG_DATA_URL,
      storageKey: VALID_STORAGE_KEY,
      supabaseAdmin: mock.module,
    });
    const uploadOptions = mock.uploadMock.mock.calls[0][2];
    // Presence: option key is set (catches "forgot to specify" bugs).
    expect(uploadOptions).toHaveProperty('upsert');
    // Strict value: must be exactly false (catches both missing-key and wrong-value bugs).
    expect(uploadOptions.upsert).toBe(false);
  });

  it('passes contentType: image/png explicitly (§25.7 bucket MIME restriction)', async () => {
    const mock = createMockSupabaseAdmin();
    await uploadSignaturePng({
      pngDataUrl: VALID_PNG_DATA_URL,
      storageKey: VALID_STORAGE_KEY,
      supabaseAdmin: mock.module,
    });
    const uploadOptions = mock.uploadMock.mock.calls[0][2];
    expect(uploadOptions.contentType).toBe('image/png');
  });
});

// ─── uploadSignaturePng — validation propagation ──────────────────────────

describe('uploadSignaturePng — validation propagation', () => {
  it('propagates PNG_MALFORMED from non-PNG data URL', async () => {
    const mock = createMockSupabaseAdmin();
    await expect(uploadSignaturePng({
      pngDataUrl: 'data:image/jpeg;base64,/9j/4A==',
      storageKey: VALID_STORAGE_KEY,
      supabaseAdmin: mock.module,
    })).rejects.toMatchObject({ code: SIG_ERR.PNG_MALFORMED.code });
    expect(mock.uploadMock).not.toHaveBeenCalled();
  });

  it('propagates PNG_TOO_LARGE from base64 precheck (hint mentions base64 length)', async () => {
    const mock = createMockSupabaseAdmin();
    const huge = 'A'.repeat(PNG_MAX_BASE64_LENGTH + 1);
    try {
      await uploadSignaturePng({
        pngDataUrl: `data:image/png;base64,${huge}`,
        storageKey: VALID_STORAGE_KEY,
        supabaseAdmin: mock.module,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect(e.code).toBe(SIG_ERR.PNG_TOO_LARGE.code);
      expect(e.hint).toMatch(/base64 length/);
    }
  });

  it('propagates PNG_TOO_SMALL from decoded size below MIN', async () => {
    const mock = createMockSupabaseAdmin();
    const tiny = Buffer.alloc(50).toString('base64');
    await expect(uploadSignaturePng({
      pngDataUrl: `data:image/png;base64,${tiny}`,
      storageKey: VALID_STORAGE_KEY,
      supabaseAdmin: mock.module,
    })).rejects.toMatchObject({ code: SIG_ERR.PNG_TOO_SMALL.code });
  });

  it('propagates PNG_TOO_LARGE from decoded size above MAX (hint mentions decoded size)', async () => {
    // Craft a buffer just above MAX but with base64 length still under precheck.
    // Decoded 2097153 bytes → base64 ~2796205 chars, below MAX_BASE64 (2796220).
    const mock = createMockSupabaseAdmin();
    const tooLargeBuffer = makeSynthetic(PNG_MAX_BYTES + 1);
    const b64 = tooLargeBuffer.toString('base64');
    try {
      await uploadSignaturePng({
        pngDataUrl: `data:image/png;base64,${b64}`,
        storageKey: VALID_STORAGE_KEY,
        supabaseAdmin: mock.module,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect(e.code).toBe(SIG_ERR.PNG_TOO_LARGE.code);
      expect(e.hint).toMatch(/decoded size/);
    }
  });

  it('propagates PNG_MALFORMED from wrong magic bytes', async () => {
    const mock = createMockSupabaseAdmin();
    const badBuf = Buffer.from(VALID_PNG_BUFFER_100);
    badBuf[0] = 0x00;
    await expect(uploadSignaturePng({
      pngDataUrl: `data:image/png;base64,${badBuf.toString('base64')}`,
      storageKey: VALID_STORAGE_KEY,
      supabaseAdmin: mock.module,
    })).rejects.toMatchObject({ code: SIG_ERR.PNG_MALFORMED.code });
  });

  it('propagates STORAGE_KEY_MALFORMED from bad storageKey', async () => {
    const mock = createMockSupabaseAdmin();
    await expect(uploadSignaturePng({
      pngDataUrl: VALID_PNG_DATA_URL,
      storageKey: 'not-a-valid-storage-key',
      supabaseAdmin: mock.module,
    })).rejects.toMatchObject({ code: SIG_ERR.STORAGE_KEY_MALFORMED.code });
    expect(mock.uploadMock).not.toHaveBeenCalled();
  });
});

// ─── uploadSignaturePng — Supabase error propagation ──────────────────────

describe('uploadSignaturePng — Supabase error propagation', () => {
  it('maps duplicate-key error to PNG_UPLOAD_DUPLICATE', async () => {
    const mock = createMockSupabaseAdmin({
      uploadError: { message: 'The resource already exists' },
    });
    await expect(uploadSignaturePng({
      pngDataUrl: VALID_PNG_DATA_URL,
      storageKey: VALID_STORAGE_KEY,
      supabaseAdmin: mock.module,
    })).rejects.toMatchObject({ code: SIG_ERR.PNG_UPLOAD_DUPLICATE.code });
  });

  it('maps bucket-missing error to PNG_BUCKET_MISSING', async () => {
    const mock = createMockSupabaseAdmin({
      uploadError: { message: 'Bucket not found' },
    });
    await expect(uploadSignaturePng({
      pngDataUrl: VALID_PNG_DATA_URL,
      storageKey: VALID_STORAGE_KEY,
      supabaseAdmin: mock.module,
    })).rejects.toMatchObject({ code: SIG_ERR.PNG_BUCKET_MISSING.code });
  });

  it('maps unknown error to PNG_UPLOAD_FAILED', async () => {
    const mock = createMockSupabaseAdmin({
      uploadError: { message: 'Network timeout', status: 504 },
    });
    await expect(uploadSignaturePng({
      pngDataUrl: VALID_PNG_DATA_URL,
      storageKey: VALID_STORAGE_KEY,
      supabaseAdmin: mock.module,
    })).rejects.toMatchObject({ code: SIG_ERR.PNG_UPLOAD_FAILED.code });
  });

  it('throws PNG_UPLOAD_FAILED when getAdminClient returns null (env missing)', async () => {
    const mock = createMockSupabaseAdmin({ adminNull: true });
    try {
      await uploadSignaturePng({
        pngDataUrl: VALID_PNG_DATA_URL,
        storageKey: VALID_STORAGE_KEY,
        supabaseAdmin: mock.module,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect(e.code).toBe(SIG_ERR.PNG_UPLOAD_FAILED.code);
      expect(e.hint).toMatch(/SUPABASE_URL/);
    }
    expect(mock.uploadMock).not.toHaveBeenCalled();
  });
});

// ─── cleanupOrphanPng ─────────────────────────────────────────────────────

describe('cleanupOrphanPng', () => {
  let warnSpy;
  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('happy path: calls remove([path]) with correct bucket + path', async () => {
    const mock = createMockSupabaseAdmin();
    await cleanupOrphanPng({
      supabaseAdmin: mock.module,
      storageKey: VALID_STORAGE_KEY,
    });
    expect(mock.fromMock).toHaveBeenCalledWith(SIGNATURE_BUCKET);
    const expectedPath = VALID_STORAGE_KEY.slice(SIGNATURE_BUCKET.length + 1);
    expect(mock.removeMock).toHaveBeenCalledWith([expectedPath]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not throw when Supabase remove returns error (logs warning)', async () => {
    const mock = createMockSupabaseAdmin({
      removeError: { message: 'Object not found' },
    });
    await expect(cleanupOrphanPng({
      supabaseAdmin: mock.module,
      storageKey: VALID_STORAGE_KEY,
    })).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toMatch(/SIG_CLEANUP/);
    expect(warnSpy.mock.calls[0][0]).toMatch(/remove failed/);
  });

  it('does not throw when getAdminClient returns null (logs warning)', async () => {
    const mock = createMockSupabaseAdmin({ adminNull: true });
    await expect(cleanupOrphanPng({
      supabaseAdmin: mock.module,
      storageKey: VALID_STORAGE_KEY,
    })).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toMatch(/unavailable/);
  });

  it('does not throw when storageKey is malformed (logs warning)', async () => {
    const mock = createMockSupabaseAdmin();
    await expect(cleanupOrphanPng({
      supabaseAdmin: mock.module,
      storageKey: 'not-a-valid-key',
    })).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toMatch(/threw/);
    // remove was never called.
    expect(mock.removeMock).not.toHaveBeenCalled();
  });

  it('does not throw when remove itself rejects (logs warning)', async () => {
    const mock = createMockSupabaseAdmin({ removeThrows: true });
    await expect(cleanupOrphanPng({
      supabaseAdmin: mock.module,
      storageKey: VALID_STORAGE_KEY,
    })).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toMatch(/threw/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 4 tests: retrieval helpers (portal P2 + public PU2)
// ═══════════════════════════════════════════════════════════════════════════

// ─── Section 4 mock helpers ────────────────────────────────────────────────

function createMockPg(queryResults = []) {
  let callIndex = 0;
  const query = jest.fn().mockImplementation(() =>
    Promise.resolve(queryResults[callIndex++] || { rows: [] })
  );
  return { query };
}

function createMockResponse(buffer, { status = 200, statusText = 'OK', contentLength = null } = {}) {
  const body = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(buffer);
      ctrl.close();
    },
  });
  const headers = new Map();
  if (contentLength !== null) headers.set('content-length', String(contentLength));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: { get: (k) => headers.get(k.toLowerCase()) || null },
    body,
  };
}

function installMockFetch(responses) {
  let callIndex = 0;
  global.fetch = jest.fn().mockImplementation(() => {
    const r = responses[callIndex++];
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(r || { ok: false, status: 500, statusText: 'Internal' });
  });
}

function installRejectingFetch(err) {
  global.fetch = jest.fn().mockRejectedValue(err);
}

async function consumeStreamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ─── Section 4 fixture data ────────────────────────────────────────────────

const VALID_SIG_BYTES = makeSynthetic(100);

function makeSigRow(overrides = {}) {
  return {
    signature_id: PINNED_INPUTS.signatureId,
    quote_version_id: PINNED_INPUTS.quoteVersionId,
    tenant_id: PINNED_INPUTS.tenantId,
    owner_id: '19053279955',
    signature_png_storage_key: VALID_STORAGE_KEY,
    signature_png_sha256: crypto.createHash('sha256').update(VALID_SIG_BYTES).digest('hex'),
    signed_at: new Date('2026-04-19T12:00:00.000Z'),
    quote_id: '0b1c2d3e-4f5a-6b7c-8d9e-0f1a2b3c4d5e',
    ...overrides,
  };
}

function makeTokenRow(overrides = {}) {
  return {
    share_token_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    tenant_id: PINNED_INPUTS.tenantId,
    owner_id: '19053279955',
    quote_version_id: PINNED_INPUTS.quoteVersionId,
    absolute_expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    revoked_at: null,
    ...overrides,
  };
}

const VALID_SHARE_TOKEN = 'XPtBaAPL5VAm7zRRJb9onA'; // 22 chars, base58

// ─── Mock shape validation ────────────────────────────────────────────────

describe('Section 4 mock shape', () => {
  it('createMockPg returns a query function', () => {
    const pg = createMockPg([{ rows: [{ foo: 'bar' }] }]);
    expect(typeof pg.query).toBe('function');
  });

  it('createMockResponse body yields original buffer when streamed', async () => {
    const buf = Buffer.from([1, 2, 3, 4, 5]);
    const res = createMockResponse(buf);
    const stream = Readable.fromWeb(res.body);
    const collected = await consumeStreamToBuffer(stream);
    expect(collected.equals(buf)).toBe(true);
  });
});

// ─── Section 4 internals: UUID + token regex + assert helpers ──────────────

describe('Section 4 input-validation regexes', () => {
  it('UUID_LOWERCASE_RE accepts canonical lowercase UUID', () => {
    expect(UUID_LOWERCASE_RE.test('86907c28-a9ea-4318-819d-5a012192119b')).toBe(true);
  });

  it('UUID_LOWERCASE_RE rejects uppercase UUID', () => {
    expect(UUID_LOWERCASE_RE.test('86907C28-A9EA-4318-819D-5A012192119B')).toBe(false);
  });

  it('SHARE_TOKEN_RE accepts 22-char base58', () => {
    expect(SHARE_TOKEN_RE.test(VALID_SHARE_TOKEN)).toBe(true);
  });

  it('SHARE_TOKEN_RE rejects 21-char token', () => {
    expect(SHARE_TOKEN_RE.test(VALID_SHARE_TOKEN.slice(0, 21))).toBe(false);
  });

  it('SHARE_TOKEN_RE rejects base58-forbidden chars (0, O, I, l)', () => {
    expect(SHARE_TOKEN_RE.test('0PtBaAPL5VAm7zRRJb9onA')).toBe(false); // has 0
    expect(SHARE_TOKEN_RE.test('OPtBaAPL5VAm7zRRJb9onA')).toBe(false); // has O
    expect(SHARE_TOKEN_RE.test('IPtBaAPL5VAm7zRRJb9onA')).toBe(false); // has I
    expect(SHARE_TOKEN_RE.test('lPtBaAPL5VAm7zRRJb9onA')).toBe(false); // has l
  });
});

// ─── getSignatureForOwner — happy path ─────────────────────────────────────

describe('getSignatureForOwner — happy path', () => {
  afterEach(() => { delete global.fetch; });

  it('returns stream + metadata; stream yields upstream bytes', async () => {
    const pg = createMockPg([{ rows: [makeSigRow()] }]);
    const supabaseMock = createMockSupabaseAdmin();
    installMockFetch([createMockResponse(VALID_SIG_BYTES, { contentLength: 100 })]);

    const result = await getSignatureForOwner({
      signatureId: PINNED_INPUTS.signatureId,
      tenantId: PINNED_INPUTS.tenantId,
      ownerId: '19053279955',
      pg,
      supabaseAdmin: supabaseMock.module,
    });

    expect(result.contentType).toBe('image/png');
    expect(result.contentLength).toBe(100);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.signatureId).toBe(PINNED_INPUTS.signatureId);
    expect(result.signedAt).toBeInstanceOf(Date);

    const consumed = await consumeStreamToBuffer(result.stream);
    expect(consumed.equals(VALID_SIG_BYTES)).toBe(true);
  });

  it('pg.query called with dual-boundary WHERE params', async () => {
    const pg = createMockPg([{ rows: [makeSigRow()] }]);
    const supabaseMock = createMockSupabaseAdmin();
    installMockFetch([createMockResponse(VALID_SIG_BYTES)]);

    await getSignatureForOwner({
      signatureId: PINNED_INPUTS.signatureId,
      tenantId: PINNED_INPUTS.tenantId,
      ownerId: '19053279955',
      pg,
      supabaseAdmin: supabaseMock.module,
    });

    expect(pg.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toMatch(/FROM public\.chiefos_quote_signatures/);
    expect(sql).toMatch(/WHERE qs\.id = \$1 AND qs\.tenant_id = \$2 AND qs\.owner_id = \$3/);
    expect(params).toEqual([
      PINNED_INPUTS.signatureId,
      PINNED_INPUTS.tenantId,
      '19053279955',
    ]);
  });

  it('createSignedUrl called with path + 60s TTL', async () => {
    const pg = createMockPg([{ rows: [makeSigRow()] }]);
    const supabaseMock = createMockSupabaseAdmin();
    installMockFetch([createMockResponse(VALID_SIG_BYTES)]);

    await getSignatureForOwner({
      signatureId: PINNED_INPUTS.signatureId,
      tenantId: PINNED_INPUTS.tenantId,
      ownerId: '19053279955',
      pg,
      supabaseAdmin: supabaseMock.module,
    });

    const [pathArg, ttlArg] = supabaseMock.createSignedUrlMock.mock.calls[0];
    expect(pathArg).toBe(VALID_STORAGE_KEY.slice(SIGNATURE_BUCKET.length + 1));
    expect(ttlArg).toBe(60);
  });
});

// ─── getSignatureForOwner — input validation ──────────────────────────────

describe('getSignatureForOwner — input validation', () => {
  afterEach(() => { delete global.fetch; });

  it('rejects non-UUID signatureId with BAD_REQUEST', async () => {
    const pg = createMockPg();
    await expect(getSignatureForOwner({
      signatureId: 'not-a-uuid',
      tenantId: PINNED_INPUTS.tenantId,
      ownerId: '19053279955',
      pg,
      supabaseAdmin: createMockSupabaseAdmin().module,
    })).rejects.toMatchObject({ code: SIG_ERR.BAD_REQUEST.code });
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('rejects non-UUID tenantId with BAD_REQUEST', async () => {
    const pg = createMockPg();
    await expect(getSignatureForOwner({
      signatureId: PINNED_INPUTS.signatureId,
      tenantId: 'bad',
      ownerId: '19053279955',
      pg,
      supabaseAdmin: createMockSupabaseAdmin().module,
    })).rejects.toMatchObject({ code: SIG_ERR.BAD_REQUEST.code });
  });

  it('rejects empty ownerId with BAD_REQUEST', async () => {
    const pg = createMockPg();
    await expect(getSignatureForOwner({
      signatureId: PINNED_INPUTS.signatureId,
      tenantId: PINNED_INPUTS.tenantId,
      ownerId: '',
      pg,
      supabaseAdmin: createMockSupabaseAdmin().module,
    })).rejects.toMatchObject({ code: SIG_ERR.BAD_REQUEST.code });
  });

  it('rejects non-string inputs with BAD_REQUEST', async () => {
    const pg = createMockPg();
    await expect(getSignatureForOwner({
      signatureId: 42,
      tenantId: PINNED_INPUTS.tenantId,
      ownerId: '19053279955',
      pg,
      supabaseAdmin: createMockSupabaseAdmin().module,
    })).rejects.toMatchObject({ code: SIG_ERR.BAD_REQUEST.code });
  });
});

// ─── getSignatureForOwner — DB / storage failures ─────────────────────────

describe('getSignatureForOwner — failure modes', () => {
  afterEach(() => { delete global.fetch; });

  it('throws SIGNATURE_NOT_FOUND when DB returns no rows', async () => {
    const pg = createMockPg([{ rows: [] }]);
    await expect(getSignatureForOwner({
      signatureId: PINNED_INPUTS.signatureId,
      tenantId: PINNED_INPUTS.tenantId,
      ownerId: '19053279955',
      pg,
      supabaseAdmin: createMockSupabaseAdmin().module,
    })).rejects.toMatchObject({ code: SIG_ERR.SIGNATURE_NOT_FOUND.code });
  });

  it('throws STORAGE_KEY_MALFORMED when row has corrupt storage_key', async () => {
    const pg = createMockPg([{ rows: [makeSigRow({ signature_png_storage_key: 'wrong-shape' })] }]);
    await expect(getSignatureForOwner({
      signatureId: PINNED_INPUTS.signatureId,
      tenantId: PINNED_INPUTS.tenantId,
      ownerId: '19053279955',
      pg,
      supabaseAdmin: createMockSupabaseAdmin().module,
    })).rejects.toMatchObject({ code: SIG_ERR.STORAGE_KEY_MALFORMED.code });
  });

  it('throws STORAGE_FETCH_FAILED when createSignedUrl errors', async () => {
    const pg = createMockPg([{ rows: [makeSigRow()] }]);
    const supabaseMock = createMockSupabaseAdmin();
    supabaseMock.createSignedUrlMock.mockResolvedValue({
      data: null,
      error: { message: 'Sign failed' },
    });
    await expect(getSignatureForOwner({
      signatureId: PINNED_INPUTS.signatureId,
      tenantId: PINNED_INPUTS.tenantId,
      ownerId: '19053279955',
      pg,
      supabaseAdmin: supabaseMock.module,
    })).rejects.toMatchObject({ code: SIG_ERR.STORAGE_FETCH_FAILED.code });
  });

  it('throws STORAGE_FETCH_FAILED when fetch returns non-200', async () => {
    const pg = createMockPg([{ rows: [makeSigRow()] }]);
    const supabaseMock = createMockSupabaseAdmin();
    installMockFetch([createMockResponse(Buffer.alloc(0), { status: 404, statusText: 'Not Found' })]);
    try {
      await getSignatureForOwner({
        signatureId: PINNED_INPUTS.signatureId,
        tenantId: PINNED_INPUTS.tenantId,
        ownerId: '19053279955',
        pg,
        supabaseAdmin: supabaseMock.module,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect(e.code).toBe(SIG_ERR.STORAGE_FETCH_FAILED.code);
      expect(e.hint).toMatch(/HTTP 404/);
    }
  });

  it('throws STORAGE_FETCH_FAILED when fetch rejects with network error', async () => {
    const pg = createMockPg([{ rows: [makeSigRow()] }]);
    const supabaseMock = createMockSupabaseAdmin();
    installRejectingFetch(new Error('ECONNREFUSED'));
    try {
      await getSignatureForOwner({
        signatureId: PINNED_INPUTS.signatureId,
        tenantId: PINNED_INPUTS.tenantId,
        ownerId: '19053279955',
        pg,
        supabaseAdmin: supabaseMock.module,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect(e.code).toBe(SIG_ERR.STORAGE_FETCH_FAILED.code);
      expect(e.hint).toMatch(/Network error/);
      expect(e.hint).toMatch(/ECONNREFUSED/);
    }
  });

  it('throws STORAGE_FETCH_FAILED (via requireAdmin override) when admin null', async () => {
    const pg = createMockPg([{ rows: [makeSigRow()] }]);
    const supabaseMock = createMockSupabaseAdmin({ adminNull: true });
    await expect(getSignatureForOwner({
      signatureId: PINNED_INPUTS.signatureId,
      tenantId: PINNED_INPUTS.tenantId,
      ownerId: '19053279955',
      pg,
      supabaseAdmin: supabaseMock.module,
    })).rejects.toMatchObject({ code: SIG_ERR.STORAGE_FETCH_FAILED.code });
  });
});

// ─── getSignatureViaShareToken — happy path ───────────────────────────────

describe('getSignatureViaShareToken — happy path', () => {
  afterEach(() => { delete global.fetch; });

  it('returns stream + metadata + full audit context', async () => {
    const tokenRow = makeTokenRow();
    const sigRow = makeSigRow();
    const pg = createMockPg([
      { rows: [tokenRow] },
      { rows: [sigRow] },
    ]);
    const supabaseMock = createMockSupabaseAdmin();
    installMockFetch([createMockResponse(VALID_SIG_BYTES, { contentLength: 100 })]);

    const result = await getSignatureViaShareToken({
      signatureId: PINNED_INPUTS.signatureId,
      shareToken: VALID_SHARE_TOKEN,
      pg,
      supabaseAdmin: supabaseMock.module,
    });

    expect(result.signatureId).toBe(PINNED_INPUTS.signatureId);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.shareTokenId).toBe(tokenRow.share_token_id);
    expect(result.quoteId).toBe(sigRow.quote_id);
    expect(result.tenantId).toBe(tokenRow.tenant_id);
    expect(result.ownerId).toBe(tokenRow.owner_id);
  });

  it('executes queries in correct order with correct params', async () => {
    const tokenRow = makeTokenRow();
    const pg = createMockPg([
      { rows: [tokenRow] },
      { rows: [makeSigRow()] },
    ]);
    installMockFetch([createMockResponse(VALID_SIG_BYTES)]);

    await getSignatureViaShareToken({
      signatureId: PINNED_INPUTS.signatureId,
      shareToken: VALID_SHARE_TOKEN,
      pg,
      supabaseAdmin: createMockSupabaseAdmin().module,
    });

    expect(pg.query).toHaveBeenCalledTimes(2);
    expect(pg.query.mock.calls[0][0]).toMatch(/chiefos_quote_share_tokens/);
    expect(pg.query.mock.calls[0][1]).toEqual([VALID_SHARE_TOKEN]);

    expect(pg.query.mock.calls[1][0]).toMatch(/chiefos_quote_signatures/);
    expect(pg.query.mock.calls[1][0]).toMatch(/chiefos_quote_versions/);
    expect(pg.query.mock.calls[1][1]).toEqual([
      PINNED_INPUTS.signatureId,
      tokenRow.quote_version_id,
      tokenRow.tenant_id,
    ]);
  });
});

// ─── getSignatureViaShareToken — input validation ─────────────────────────

describe('getSignatureViaShareToken — input validation', () => {
  afterEach(() => { delete global.fetch; });

  it('rejects non-UUID signatureId with BAD_REQUEST', async () => {
    const pg = createMockPg();
    await expect(getSignatureViaShareToken({
      signatureId: 'not-a-uuid',
      shareToken: VALID_SHARE_TOKEN,
      pg,
      supabaseAdmin: createMockSupabaseAdmin().module,
    })).rejects.toMatchObject({ code: SIG_ERR.BAD_REQUEST.code });
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('rejects non-base58 shareToken with BAD_REQUEST', async () => {
    const pg = createMockPg();
    await expect(getSignatureViaShareToken({
      signatureId: PINNED_INPUTS.signatureId,
      shareToken: 'has0OIl-invalid-chars!',
      pg,
      supabaseAdmin: createMockSupabaseAdmin().module,
    })).rejects.toMatchObject({ code: SIG_ERR.BAD_REQUEST.code });
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('rejects 21-char token with BAD_REQUEST', async () => {
    const pg = createMockPg();
    await expect(getSignatureViaShareToken({
      signatureId: PINNED_INPUTS.signatureId,
      shareToken: VALID_SHARE_TOKEN.slice(0, 21),
      pg,
      supabaseAdmin: createMockSupabaseAdmin().module,
    })).rejects.toMatchObject({ code: SIG_ERR.BAD_REQUEST.code });
  });
});

// ─── getSignatureViaShareToken — token state ──────────────────────────────

describe('getSignatureViaShareToken — token state', () => {
  afterEach(() => { delete global.fetch; });

  it('SHARE_TOKEN_NOT_FOUND when Q1 returns empty', async () => {
    const pg = createMockPg([{ rows: [] }]);
    await expect(getSignatureViaShareToken({
      signatureId: PINNED_INPUTS.signatureId,
      shareToken: VALID_SHARE_TOKEN,
      pg,
      supabaseAdmin: createMockSupabaseAdmin().module,
    })).rejects.toMatchObject({ code: SIG_ERR.SHARE_TOKEN_NOT_FOUND.code });
    expect(pg.query).toHaveBeenCalledTimes(1); // Q2 not executed
  });

  it('SHARE_TOKEN_REVOKED when Q1 returns revoked_at', async () => {
    const pg = createMockPg([
      { rows: [makeTokenRow({ revoked_at: new Date('2026-04-15T00:00:00Z') })] },
    ]);
    await expect(getSignatureViaShareToken({
      signatureId: PINNED_INPUTS.signatureId,
      shareToken: VALID_SHARE_TOKEN,
      pg,
      supabaseAdmin: createMockSupabaseAdmin().module,
    })).rejects.toMatchObject({ code: SIG_ERR.SHARE_TOKEN_REVOKED.code });
    expect(pg.query).toHaveBeenCalledTimes(1); // Q2 not executed
  });

  it('SHARE_TOKEN_EXPIRED when Q1 returns past absolute_expires_at', async () => {
    const pg = createMockPg([
      { rows: [makeTokenRow({ absolute_expires_at: new Date('2020-01-01T00:00:00Z') })] },
    ]);
    await expect(getSignatureViaShareToken({
      signatureId: PINNED_INPUTS.signatureId,
      shareToken: VALID_SHARE_TOKEN,
      pg,
      supabaseAdmin: createMockSupabaseAdmin().module,
    })).rejects.toMatchObject({ code: SIG_ERR.SHARE_TOKEN_EXPIRED.code });
    expect(pg.query).toHaveBeenCalledTimes(1);
  });

  it('SHARE_TOKEN_NOT_FOUND when Q2 misses (collapsed mismatch)', async () => {
    const pg = createMockPg([
      { rows: [makeTokenRow()] },
      { rows: [] },
    ]);
    await expect(getSignatureViaShareToken({
      signatureId: PINNED_INPUTS.signatureId,
      shareToken: VALID_SHARE_TOKEN,
      pg,
      supabaseAdmin: createMockSupabaseAdmin().module,
    })).rejects.toMatchObject({ code: SIG_ERR.SHARE_TOKEN_NOT_FOUND.code });
    expect(pg.query).toHaveBeenCalledTimes(2);
  });
});

// ─── getSignatureViaShareToken — query-order precedence ───────────────────

describe('getSignatureViaShareToken — query-order precedence', () => {
  afterEach(() => { delete global.fetch; });

  it('revoked token + wrong signatureId → SHARE_TOKEN_REVOKED (not NOT_FOUND)', async () => {
    // Q1 returns revoked; revoked-check fires BEFORE Q2 executes.
    const pg = createMockPg([
      { rows: [makeTokenRow({ revoked_at: new Date('2026-04-15T00:00:00Z') })] },
      // Q2 would return empty if called — but it shouldn't be called.
      { rows: [] },
    ]);
    await expect(getSignatureViaShareToken({
      signatureId: PINNED_INPUTS.signatureId,
      shareToken: VALID_SHARE_TOKEN,
      pg,
      supabaseAdmin: createMockSupabaseAdmin().module,
    })).rejects.toMatchObject({ code: SIG_ERR.SHARE_TOKEN_REVOKED.code });
    expect(pg.query).toHaveBeenCalledTimes(1);
  });

  it('expired token + wrong signatureId → SHARE_TOKEN_EXPIRED (not NOT_FOUND)', async () => {
    const pg = createMockPg([
      { rows: [makeTokenRow({ absolute_expires_at: new Date('2020-01-01T00:00:00Z') })] },
      { rows: [] },
    ]);
    await expect(getSignatureViaShareToken({
      signatureId: PINNED_INPUTS.signatureId,
      shareToken: VALID_SHARE_TOKEN,
      pg,
      supabaseAdmin: createMockSupabaseAdmin().module,
    })).rejects.toMatchObject({ code: SIG_ERR.SHARE_TOKEN_EXPIRED.code });
    expect(pg.query).toHaveBeenCalledTimes(1);
  });
});

// ─── getSignatureViaShareToken — defensive tenant_id mismatch ─────────────

describe('getSignatureViaShareToken — defensive tenant_id cross-source check', () => {
  afterEach(() => { delete global.fetch; });

  it('throws STORAGE_KEY_MALFORMED when token.tenant_id ≠ signature.tenant_id', async () => {
    // Unreachable under correct FK enforcement; synthetic mock exercises the branch.
    const tokenRow = makeTokenRow({ tenant_id: PINNED_INPUTS.tenantId });
    const sigRow = makeSigRow({ tenant_id: 'different-uuid-tenant-aaaa-bbbb-cccc-dddddddddd' });
    const pg = createMockPg([
      { rows: [tokenRow] },
      { rows: [sigRow] },
    ]);

    try {
      await getSignatureViaShareToken({
        signatureId: PINNED_INPUTS.signatureId,
        shareToken: VALID_SHARE_TOKEN,
        pg,
        supabaseAdmin: createMockSupabaseAdmin().module,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect(e.code).toBe(SIG_ERR.STORAGE_KEY_MALFORMED.code);
      expect(e.hint).toMatch(/tenant_id/);
      expect(e.hint).toMatch(/FK constraint violation/);
    }
  });
});

// ─── Cross-helper invariants ──────────────────────────────────────────────

describe('Cross-helper invariants', () => {
  afterEach(() => { delete global.fetch; });

  it('both helpers call createSignedUrl with 60s TTL (load-bearing §25.2)', async () => {
    // Portal
    const pgPortal = createMockPg([{ rows: [makeSigRow()] }]);
    const mockPortal = createMockSupabaseAdmin();
    installMockFetch([createMockResponse(VALID_SIG_BYTES)]);
    await getSignatureForOwner({
      signatureId: PINNED_INPUTS.signatureId,
      tenantId: PINNED_INPUTS.tenantId,
      ownerId: '19053279955',
      pg: pgPortal,
      supabaseAdmin: mockPortal.module,
    });
    expect(mockPortal.createSignedUrlMock.mock.calls[0][1]).toBe(60);

    // Public
    const pgPublic = createMockPg([
      { rows: [makeTokenRow()] },
      { rows: [makeSigRow()] },
    ]);
    const mockPublic = createMockSupabaseAdmin();
    installMockFetch([createMockResponse(VALID_SIG_BYTES)]);
    await getSignatureViaShareToken({
      signatureId: PINNED_INPUTS.signatureId,
      shareToken: VALID_SHARE_TOKEN,
      pg: pgPublic,
      supabaseAdmin: mockPublic.module,
    });
    expect(mockPublic.createSignedUrlMock.mock.calls[0][1]).toBe(60);
  });

  it('both helpers call admin.storage.from with SIGNATURE_BUCKET literal', async () => {
    const pgPortal = createMockPg([{ rows: [makeSigRow()] }]);
    const mockPortal = createMockSupabaseAdmin();
    installMockFetch([createMockResponse(VALID_SIG_BYTES)]);
    await getSignatureForOwner({
      signatureId: PINNED_INPUTS.signatureId,
      tenantId: PINNED_INPUTS.tenantId,
      ownerId: '19053279955',
      pg: pgPortal,
      supabaseAdmin: mockPortal.module,
    });
    expect(mockPortal.fromMock).toHaveBeenCalledWith(SIGNATURE_BUCKET);
    expect(mockPortal.fromMock).toHaveBeenCalledWith('chiefos-signatures');
  });
});

// ─── Content-Length header handling ───────────────────────────────────────

describe('Content-Length header handling', () => {
  afterEach(() => { delete global.fetch; });

  it('parses content-length header to number', async () => {
    const pg = createMockPg([{ rows: [makeSigRow()] }]);
    const supabaseMock = createMockSupabaseAdmin();
    installMockFetch([createMockResponse(VALID_SIG_BYTES, { contentLength: 100 })]);

    const result = await getSignatureForOwner({
      signatureId: PINNED_INPUTS.signatureId,
      tenantId: PINNED_INPUTS.tenantId,
      ownerId: '19053279955',
      pg,
      supabaseAdmin: supabaseMock.module,
    });
    expect(result.contentLength).toBe(100);
    expect(typeof result.contentLength).toBe('number');
  });

  it('returns null contentLength when header absent', async () => {
    const pg = createMockPg([{ rows: [makeSigRow()] }]);
    const supabaseMock = createMockSupabaseAdmin();
    installMockFetch([createMockResponse(VALID_SIG_BYTES)]); // no contentLength

    const result = await getSignatureForOwner({
      signatureId: PINNED_INPUTS.signatureId,
      tenantId: PINNED_INPUTS.tenantId,
      ownerId: '19053279955',
      pg,
      supabaseAdmin: supabaseMock.module,
    });
    expect(result.contentLength).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 5 tests: migration ↔ app regex byte-identity (drift detection)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * migration ↔ app regex byte-identity
 *
 * These tests catch source-level drift between the SQL migration regex
 * and SIGNATURE_STORAGE_KEY_RE.source. They do NOT catch PG-ARE-specific
 * parse errors (JS RegExp and PG ARE are functionally aligned only for
 * the POSIX subset we use — [0-9a-f], {N}, ^, $, \. — but the compilers
 * are distinct). PG-side regex compatibility is confirmed via the
 * preflight psql dry-run documented in the migration commit message.
 *
 * Both test-side drift detection AND preflight dry-run are needed;
 * together they cover the compatibility space.
 */
describe('migration ↔ app regex byte-identity', () => {
  const fs = require('fs');
  const path = require('path');

  const MIGRATION_PATH = path.join(
    __dirname, '..', '..', 'migrations',
    '2026_04_19_chiefos_qs_png_storage_key_format.sql'
  );

  it('migration SQL file exists at the expected path', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
  });

  it('migration regex matches SIGNATURE_STORAGE_KEY_RE.source (forward-slash-normalized)', () => {
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');

    // Extract the single-quoted regex body from the CHECK clause.
    // Pattern: signature_png_storage_key ~ '<REGEX>'
    //
    // The regex body contains no single quotes and no SQL escape sequences,
    // so a straightforward capture between ' delimiters is safe.
    const match = /signature_png_storage_key\s*~\s*'([^']+)'/.exec(sql);
    if (!match) {
      throw new Error(
        'Could not locate CHECK regex in migration SQL. ' +
        'Has the migration file been restructured? If so, update this test.'
      );
    }
    const sqlRegex = match[1];

    // Normalize forward-slash escaping: V8's .source serializer emits \/
    // (regex-literal-compat) even when the input string used bare /. PG's
    // ARE does not require escaping / (it's not a delimiter). Both forms
    // are semantically identical; normalize before comparing so the test
    // catches real content drift, not engine-serializer quirks.
    const appSourceNormalized = SIGNATURE_STORAGE_KEY_RE.source.replace(/\\\//g, '/');

    if (sqlRegex !== appSourceNormalized) {
      // Explicit diff rendering for debug.
      throw new Error(
        'Migration regex drifted from app regex.\n' +
        `  SQL (literal):         ${sqlRegex}\n` +
        `  App .source normalized: ${appSourceNormalized}\n` +
        `  App .source raw:       ${SIGNATURE_STORAGE_KEY_RE.source}\n` +
        'If this is an intentional convention bump, update both in the ' +
        'same commit and bump the pinned storage_key in the regression lock.'
      );
    }
    expect(sqlRegex).toBe(appSourceNormalized);
  });

  it('DB CHECK regex (compiled as JS RegExp) accepts the pinned storage_key', () => {
    // Belt-and-suspenders: the DB regex, extracted and compiled via JS
    // RegExp, must accept the known-good pinned key. If this fails while
    // the byte-identity test passes, something is wrong with our JS regex
    // or the pinned key.
    const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    const match = /signature_png_storage_key\s*~\s*'([^']+)'/.exec(sql);
    const sqlRegex = new RegExp(match[1]);
    expect(sqlRegex.test(PINNED_STORAGE_KEY)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Section 6 tests: module surface contract (Q7)
// ═══════════════════════════════════════════════════════════════════════════

describe('module surface contract (Q7)', () => {
  // These are the 12 exports Q7 committed to (see docs/QUOTES_SPINE_DECISIONS.md
  // §25.7 and Phase 2A Q7). Changes to this list require a §25 / Q7 amendment —
  // not a silent export reorganization. The list is hardcoded here verbatim,
  // NOT derived from the module's current state, so a future session that
  // silently adds or removes a top-level export fails this test with a clear
  // message about the Q7 contract.
  const Q7_TOP_LEVEL_EXPORTS = [
    'SIGNATURE_BUCKET',
    'SIGNATURE_STORAGE_KEY_RE',
    'PNG_MIN_BYTES',
    'PNG_MAX_BYTES',
    'PNG_MAX_BASE64_LENGTH',
    'SIG_ERR',
    'buildSignatureStorageKey',
    'parseSignatureStorageKey',
    'uploadSignaturePng',
    'cleanupOrphanPng',
    'getSignatureForOwner',
    'getSignatureViaShareToken',
  ];

  // _internals is allowed to evolve without Q7 amendment (it's the test
  // surface, not the public API). The check here is "required names are
  // present", not "exactly these names", to tolerate future additions.
  const REQUIRED_INTERNALS = [
    // Section 2
    'PNG_MAGIC', 'PNG_IEND_TRAILER', 'DATA_URL_PNG_RE',
    'extractAndNormalizeBase64', 'validatePngBuffer', 'computePngSha256',
    // Section 3
    'requireAdmin', 'classifySupabaseUploadError',
    // Section 4
    'SIG_LOAD_COLUMNS', 'SIG_TOKEN_RESOLVE_COLUMNS',
    'UUID_LOWERCASE_RE', 'SHARE_TOKEN_RE',
    'assertUuid', 'assertOwnerId', 'assertShareToken',
    'fetchSignatureStream',
  ];

  it('exports exactly the 12 Q7-planned top-level names', () => {
    const actualTopLevel = Object.keys(mod).filter((k) => k !== '_internals').sort();
    expect(actualTopLevel).toEqual([...Q7_TOP_LEVEL_EXPORTS].sort());
  });

  it('each top-level export resolves to the expected type', () => {
    // Strings
    expect(typeof mod.SIGNATURE_BUCKET).toBe('string');
    // RegExp
    expect(mod.SIGNATURE_STORAGE_KEY_RE).toBeInstanceOf(RegExp);
    // Numbers
    expect(typeof mod.PNG_MIN_BYTES).toBe('number');
    expect(typeof mod.PNG_MAX_BYTES).toBe('number');
    expect(typeof mod.PNG_MAX_BASE64_LENGTH).toBe('number');
    // Frozen object
    expect(typeof mod.SIG_ERR).toBe('object');
    expect(Object.isFrozen(mod.SIG_ERR)).toBe(true);
    // Functions
    for (const name of [
      'buildSignatureStorageKey',
      'parseSignatureStorageKey',
      'uploadSignaturePng',
      'cleanupOrphanPng',
      'getSignatureForOwner',
      'getSignatureViaShareToken',
    ]) {
      expect(typeof mod[name]).toBe('function');
    }
  });

  it('_internals includes the expected test-visible helpers', () => {
    expect(mod._internals).toBeDefined();
    expect(typeof mod._internals).toBe('object');
    for (const name of REQUIRED_INTERNALS) {
      if (mod._internals[name] === undefined) {
        throw new Error(`_internals missing required name: ${name}`);
      }
      expect(mod._internals[name]).toBeDefined();
    }
  });
});
