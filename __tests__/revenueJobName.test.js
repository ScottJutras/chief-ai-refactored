const { parseRevenueMessage } = require('../utils/aiErrorHandler');

describe('job name parsing (revenue): "<name> job" normalization', () => {
  test('parses "for the Oak Street job" as jobName="Oak Street"', () => {
    const out = parseRevenueMessage('revenue 500 for the Oak Street job today', { tz: 'America/Toronto' });
    expect(out).toBeTruthy();
    expect(out.jobName).toBe('Oak Street');
  });

  test('parses "for the Medway Park Job" as jobName="Medway Park"', () => {
    const out = parseRevenueMessage('received 1200 for the Medway Park Job today', { tz: 'America/Toronto' });
    expect(out).toBeTruthy();
    expect(out.jobName).toBe('Medway Park');
  });
});
