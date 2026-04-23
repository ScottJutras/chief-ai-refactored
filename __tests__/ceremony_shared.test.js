// __tests__/ceremony_shared.test.js
//
// Tests for scripts/_ceremony_shared.js — ceremony-only deterministic
// share_token derivation with bounded retry. Addresses §17.22 recurrence
// in ceremony infrastructure.
//
// Three test concerns:
//   1. Regression lock on landed ceremony tokens (SjBkxvAvPEx8CX3UFJ6mrT
//      for §27, HAstYeR6QB8VD9XF7zfRFN for §28). If either helper call
//      produces a different value, ceremony identity tables in the
//      decisions-log become stale.
//   2. Retry mechanism actually works when first attempt yields a 21-char
//      output (the §3.7/§17.22 short-output case). Both landed ceremonies
//      happen to succeed on attempt 0; without this test, the retry path
//      is dead code.
//   3. Bound is enforced — impossible-to-satisfy mock throws instead of
//      infinite-looping.

const { deriveDeterministicShareToken } = require('../scripts/_ceremony_shared');

describe('deriveDeterministicShareToken — ceremony-shared utility', () => {
  // ─── Test 1: regression lock on landed tokens ────────────────────────
  //
  // Both §27 and §28 identity tables in docs/QUOTES_SPINE_DECISIONS.md
  // cite specific share_token values by prose. If the helper ever
  // produces different output for these seeds, the decisions-log
  // drifts out of sync with the infrastructure. Lock this at test time.

  test('landed §27 seed produces SjBkxvAvPEx8CX3UFJ6mrT', () => {
    expect(deriveDeterministicShareToken(
      'chiefos-phase3-ceremony-share-token-seed-v1'
    )).toBe('SjBkxvAvPEx8CX3UFJ6mrT');
  });

  test('landed §28 seed produces HAstYeR6QB8VD9XF7zfRFN', () => {
    expect(deriveDeterministicShareToken(
      'chiefos-phase-a-session-2-viewquote-ceremony-share-token-seed-v2'
    )).toBe('HAstYeR6QB8VD9XF7zfRFN');
  });

  // ─── Test 2: retry-path exercise ─────────────────────────────────────
  //
  // Find a seed string whose attempt-0 hash produces a 21-char bs58
  // output (forcing the helper to try attempt 1). This test validates
  // that the retry iteration actually runs — neither landed ceremony
  // exercises this path because both succeeded on attempt 0.
  //
  // Seed 'chiefos-phase-a-session-2-viewquote-ceremony-share-token-seed-v1'
  // is a known short-output case (the original pre-iteration seed for
  // §28 that produced 21 chars — see §28 share-token derivation note).
  // The shared helper's retry path MUST turn this into a 22-char output
  // by iterating to `${seed}#retry1`, `#retry2`, etc.

  test('seed with attempt-0 short-output resolves via retry iteration', () => {
    const shortSeed = 'chiefos-phase-a-session-2-viewquote-ceremony-share-token-seed-v1';
    const result = deriveDeterministicShareToken(shortSeed);
    expect(result.length).toBe(22);
    // Validate deterministic: same seed produces same output across calls
    expect(deriveDeterministicShareToken(shortSeed)).toBe(result);
    // Sanity-check the retry took effect — if attempt 0 already produced
    // 22 chars, this test's premise is invalid. Verify by recomputing
    // attempt 0 inline and asserting it's the 21-char case.
    const crypto = require('crypto');
    let bs58;
    try { bs58 = require('bs58').default || require('bs58'); }
    catch (_) { bs58 = null; }
    const attempt0 = bs58.encode(
      crypto.createHash('sha256').update(shortSeed).digest().subarray(0, 16)
    );
    expect(attempt0.length).toBe(21);  // premise: attempt 0 is the short case
    expect(result).not.toBe(attempt0); // helper produced a different (retry) output
  });

  // ─── Test 3: iteration bound enforced ────────────────────────────────
  //
  // If the bs58 library ever returned short output for every attempt, the
  // helper must throw rather than loop forever. Mock bs58 to produce
  // consistently short output; assert throw at the bound.

  test('throws when no 22-char output within maxAttempts', () => {
    // jest.isolateModules lets us replace the bs58 require for one
    // module graph without affecting other tests.
    jest.isolateModules(() => {
      jest.doMock('bs58', () => ({
        encode: () => 'x'.repeat(21),  // always 21 chars — never satisfies
      }));
      const { deriveDeterministicShareToken: mocked } = require('../scripts/_ceremony_shared');
      expect(() => mocked('any-seed', 5)).toThrow(/no 22-char output within 5 attempts/);
      jest.dontMock('bs58');
    });
  });

  // ─── Edge cases ──────────────────────────────────────────────────────

  test('empty seed string throws', () => {
    expect(() => deriveDeterministicShareToken('')).toThrow(/non-empty string/);
  });

  test('non-string seed throws', () => {
    expect(() => deriveDeterministicShareToken(null)).toThrow(/non-empty string/);
    expect(() => deriveDeterministicShareToken(undefined)).toThrow(/non-empty string/);
    expect(() => deriveDeterministicShareToken(42)).toThrow(/non-empty string/);
  });
});
