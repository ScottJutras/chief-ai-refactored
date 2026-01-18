const { parseExpenseMessage } = require('../utils/aiErrorHandler');
const { todayInTimeZone } = require('../utils/dateUtils');

function isoYesterday(tz) {
  const today = todayInTimeZone(tz);
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

describe('date parsing matrix (expense)', () => {
  const cases = [
    // Group 1: today
    { name: 'text today Toronto', tz: 'America/Toronto', input: 'expense 10 nails from Home Depot today', expectDate: (tz) => todayInTimeZone(tz) },
    { name: 'voice today Toronto', tz: 'America/Toronto', input: 'Picked up nails at Home Depot for $10 today.', expectDate: (tz) => todayInTimeZone(tz) },
    { name: 'text today Vancouver', tz: 'America/Vancouver', input: 'expense 10 nails from Home Depot today', expectDate: (tz) => todayInTimeZone(tz) },
    { name: 'voice today Vancouver', tz: 'America/Vancouver', input: 'Picked up nails at Home Depot for $10 today.', expectDate: (tz) => todayInTimeZone(tz) },
    { name: 'text on today', tz: 'America/Toronto', input: 'expense $10 nails from Home Depot on today', expectDate: (tz) => todayInTimeZone(tz) },
    { name: 'text today trailing period', tz: 'America/Toronto', input: 'expense $10 nails from Home Depot today.', expectDate: (tz) => todayInTimeZone(tz) },

    // Group 2: yesterday
    { name: 'text yesterday Toronto', tz: 'America/Toronto', input: 'expense 10 nails from Home Depot yesterday', expectDate: (tz) => isoYesterday(tz) },
    { name: 'voice yesterday Toronto', tz: 'America/Toronto', input: 'Picked up nails at Home Depot for $10 yesterday.', expectDate: (tz) => isoYesterday(tz) },
    { name: 'text on yesterday', tz: 'America/Toronto', input: 'expense 10 nails from Home Depot on yesterday', expectDate: (tz) => isoYesterday(tz) },
    { name: 'text yesterday trailing period', tz: 'America/Toronto', input: 'expense 10 nails from Home Depot yesterday.', expectDate: (tz) => isoYesterday(tz) },

    // Group 3: explicit
    { name: 'explicit ISO', tz: 'America/Toronto', input: 'expense 10 nails from Home Depot on 2026-01-17', expectDate: () => '2026-01-17' },
    { name: 'explicit month-name', tz: 'America/Toronto', input: 'expense 10 nails from Home Depot on Jan 17 2026', expectDate: () => '2026-01-17' },
  ];

  test.each(cases)('$name', ({ tz, input, expectDate }) => {
    const out = parseExpenseMessage(input, { tz });
    expect(out).toBeTruthy();
    expect(out.date).toBe(expectDate(tz));
  });
});

describe('TZ edge: todayInTimeZone midnight boundary', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('America/Toronto flips date at local midnight (EST)', () => {
    jest.setSystemTime(new Date('2026-01-18T04:59:59.000Z'));
    expect(todayInTimeZone('America/Toronto')).toBe('2026-01-17');

    jest.setSystemTime(new Date('2026-01-18T05:00:00.000Z'));
    expect(todayInTimeZone('America/Toronto')).toBe('2026-01-18');
  });

  describe('job name parsing (expense): "<name> job" normalization', () => {
  test('parses "for the Oak Street job" as jobName="Oak Street"', () => {
    const out = parseExpenseMessage(
      'expense $10 nails from Home Depot today for the Oak Street job',
      { tz: 'America/Toronto' }
    );
    expect(out).toBeTruthy();
    expect(out.jobName).toBe('Oak Street');
  });

  test('parses "for the Medway Park Job" as jobName="Medway Park"', () => {
    const out = parseExpenseMessage(
      'expense $10 lumber from Home Depot today for the Medway Park Job',
      { tz: 'America/Toronto' }
    );
    expect(out).toBeTruthy();
    expect(out.jobName).toBe('Medway Park');
  });
});



});
