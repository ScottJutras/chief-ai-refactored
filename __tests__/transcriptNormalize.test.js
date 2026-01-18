const { normalizeTranscriptMoney } = require('../utils/transcriptNormalize');

describe('transcript money normalization', () => {
  test('ten dollars -> $10', () => {
    expect(normalizeTranscriptMoney('picked up nails for ten dollars today'))
      .toContain('$10');
  });

  test('eighteen hundred dollars -> $1800', () => {
    expect(normalizeTranscriptMoney('lumber for eighteen hundred dollars today'))
      .toContain('$1800');
  });
  test('eighteen hundred and fifty dollars -> $1850', () => {
  expect(
    normalizeTranscriptMoney('paid eighteen hundred and fifty dollars for shingles')
  ).toContain('$1850');
});
});
