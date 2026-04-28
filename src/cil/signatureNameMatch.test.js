// src/cil/signatureNameMatch.test.js — §11a name-match rule test suite.

const {
  computeNameMatch,
  NAME_MATCH_RULE_ID,
  _internals,
} = require('./signatureNameMatch');
const { normalizeForNameMatch } = _internals;

// ─── Happy path — match expected ───────────────────────────────────────────

describe('computeNameMatch — match cases', () => {
  it('exact match (same case, same spelling)', () => {
    const r = computeNameMatch('Darlene MacDonald', 'Darlene MacDonald');
    expect(r.matches).toBe(true);
  });

  it('case variation — lowercase typed vs mixed-case recipient', () => {
    const r = computeNameMatch('Darlene MacDonald', 'darlene macdonald');
    expect(r.matches).toBe(true);
  });

  it('spouse sign — same surname, different given', () => {
    const r = computeNameMatch('Darlene MacDonald', 'Robert MacDonald');
    expect(r.matches).toBe(true);
    expect(r.recipientLastToken).toBe('macdonald');
    expect(r.typedLastToken).toBe('macdonald');
  });

  it('nickname in given name', () => {
    const r = computeNameMatch('Darlene MacDonald', 'Dar MacDonald');
    expect(r.matches).toBe(true);
  });

  it('initial in given name', () => {
    const r = computeNameMatch('Darlene MacDonald', 'D. MacDonald');
    expect(r.matches).toBe(true);
  });

  it('middle initial added', () => {
    const r = computeNameMatch('Darlene MacDonald', 'Darlene R. MacDonald');
    expect(r.matches).toBe(true);
  });

  it('middle name added', () => {
    const r = computeNameMatch('Darlene MacDonald', 'Darlene Rose MacDonald');
    expect(r.matches).toBe(true);
  });

  it('apostrophe in surname (both sides have same underlying letters)', () => {
    const r = computeNameMatch("Mac'Donald", 'MacDonald');
    expect(r.matches).toBe(true);
  });

  it('single-token both sides', () => {
    const r = computeNameMatch('MacDonald', 'MacDonald');
    expect(r.matches).toBe(true);
  });

  it('single-token recipient, multi-token typed', () => {
    const r = computeNameMatch('MacDonald', 'Robert MacDonald');
    expect(r.matches).toBe(true);
  });

  it('leading/trailing whitespace (trim)', () => {
    const r = computeNameMatch('  MacDonald  ', 'MacDonald');
    expect(r.matches).toBe(true);
  });

  it('multi-space collapse', () => {
    const r = computeNameMatch('Darlene   MacDonald', 'Darlene MacDonald');
    expect(r.matches).toBe(true);
  });

  it('matching diacritics', () => {
    const r = computeNameMatch('García', 'García');
    expect(r.matches).toBe(true);
    expect(r.recipientLastToken).toBe('garcía');
  });

  it('strips trailing punctuation from surname', () => {
    // Regex preserves letter-number-whitespace; period is stripped.
    const r = computeNameMatch('MacDonald.', 'MacDonald');
    expect(r.matches).toBe(true);
  });
});

// ─── Documented tradeoffs (mismatch expected by §11a design) ───────────────

describe('computeNameMatch — documented mismatch tradeoffs', () => {
  it('wrong surname mismatches', () => {
    const r = computeNameMatch('Darlene MacDonald', 'Robert Smith');
    expect(r.matches).toBe(false);
  });

  it('diacritic difference mismatches (§11a intentional: no diacritic folding)', () => {
    const r = computeNameMatch('García', 'Garcia');
    expect(r.matches).toBe(false);
    // Forensic payload captures both forms for contractor review.
    expect(r.recipientLastToken).toBe('garcía');
    expect(r.typedLastToken).toBe('garcia');
  });

  it('suffix false-negative (§11a intentional: no suffix table)', () => {
    const r = computeNameMatch('Robert MacDonald', 'Robert MacDonald Jr.');
    expect(r.matches).toBe(false);
    expect(r.recipientLastToken).toBe('macdonald');
    expect(r.typedLastToken).toBe('jr');
  });
});

// ─── Edge / null handling ──────────────────────────────────────────────────

describe('computeNameMatch — null / empty / non-string handling', () => {
  it('null recipient mismatches', () => {
    const r = computeNameMatch(null, 'MacDonald');
    expect(r.matches).toBe(false);
    expect(r.recipientLastToken).toBeNull();
    expect(r.typedLastToken).toBe('macdonald');
  });

  it('undefined typed mismatches', () => {
    const r = computeNameMatch('MacDonald', undefined);
    expect(r.matches).toBe(false);
  });

  it('non-string input (number) mismatches', () => {
    const r = computeNameMatch(42, 'MacDonald');
    expect(r.matches).toBe(false);
  });

  it('empty string mismatches', () => {
    const r = computeNameMatch('', 'MacDonald');
    expect(r.matches).toBe(false);
    expect(r.recipientLastToken).toBeNull();
    expect(r.recipientNormalized).toBe('');
  });

  it('whitespace-only input mismatches', () => {
    const r = computeNameMatch('   ', 'MacDonald');
    expect(r.matches).toBe(false);
    expect(r.recipientLastToken).toBeNull();
  });

  it('both empty mismatches (null-token on both sides never matches)', () => {
    const r = computeNameMatch('', '');
    expect(r.matches).toBe(false);
  });
});

// ─── Contract + regression ─────────────────────────────────────────────────

describe('computeNameMatch — contract + regression', () => {
  it("NAME_MATCH_RULE_ID is 'last_token_normalize_v1'", () => {
    expect(NAME_MATCH_RULE_ID).toBe('last_token_normalize_v1');
  });

  it('return shape has all 6 required keys for any input', () => {
    const inputs = [
      ['MacDonald', 'MacDonald'],
      [null, 'MacDonald'],
      ['', ''],
      [42, undefined],
    ];
    for (const [a, b] of inputs) {
      const r = computeNameMatch(a, b);
      expect(r).toHaveProperty('matches');
      expect(r).toHaveProperty('ruleId');
      expect(r).toHaveProperty('recipientLastToken');
      expect(r).toHaveProperty('typedLastToken');
      expect(r).toHaveProperty('recipientNormalized');
      expect(r).toHaveProperty('typedNormalized');
    }
  });

  it('cross-version regression lock — complete return shape pinned', () => {
    const result = computeNameMatch('Robert MacDonald', 'Darlene MacDonald');
    expect(result).toEqual({
      matches: true,
      ruleId: 'last_token_normalize_v1',
      recipientLastToken: 'macdonald',
      typedLastToken: 'macdonald',
      recipientNormalized: 'robert macdonald',
      typedNormalized: 'darlene macdonald',
    });
  });
});

// ─── _internals.normalizeForNameMatch direct coverage ──────────────────────

describe('normalizeForNameMatch — _internals', () => {
  it('returns { normalized, lastToken } for valid input', () => {
    const r = normalizeForNameMatch('Darlene MacDonald');
    expect(r.normalized).toBe('darlene macdonald');
    expect(r.lastToken).toBe('macdonald');
  });

  it('returns null lastToken for non-string', () => {
    const r = normalizeForNameMatch(42);
    expect(r.lastToken).toBeNull();
    expect(r.normalized).toBe('');
  });

  it('returns null lastToken for whitespace-only string', () => {
    const r = normalizeForNameMatch('   \t\n  ');
    expect(r.lastToken).toBeNull();
    expect(r.normalized).toBe('');
  });
});
