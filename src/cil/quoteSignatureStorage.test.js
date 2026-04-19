// src/cil/quoteSignatureStorage.test.js
// Phase 2B Section 1: format helpers + constants.
// Sections 2–4 add validation / upload / retrieval suites to this file.

const {
  SIGNATURE_BUCKET,
  SIGNATURE_STORAGE_KEY_RE,
  SIG_ERR,
  buildSignatureStorageKey,
  parseSignatureStorageKey,
} = require('./quoteSignatureStorage');

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
