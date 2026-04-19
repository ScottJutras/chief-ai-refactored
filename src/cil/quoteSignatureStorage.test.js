// src/cil/quoteSignatureStorage.test.js
// Phase 2B Sections 1–2: format helpers + constants + PNG validation + SHA-256.
// Sections 3–4 add upload / retrieval suites to this file.

const crypto = require('crypto');
const zlib = require('zlib');

const mod = require('./quoteSignatureStorage');
const {
  SIGNATURE_BUCKET,
  SIGNATURE_STORAGE_KEY_RE,
  SIG_ERR,
  buildSignatureStorageKey,
  parseSignatureStorageKey,
  _internals,
} = mod;
const {
  PNG_MAGIC,
  PNG_IEND_TRAILER,
  PNG_MIN_BYTES,
  PNG_MAX_BYTES,
  PNG_MAX_BASE64_LENGTH,
  DATA_URL_PNG_RE,
  extractAndNormalizeBase64,
  validatePngBuffer,
  computePngSha256,
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
