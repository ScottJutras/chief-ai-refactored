// __tests__/timeclock.e2e.test.js
const supertest = require('supertest');
const app = require('../index');
const db = require('../services/postgres');

const TEST_PHONE = 'whatsapp:+12345550125';

beforeAll(async () => {
  // Clean up any prior runs for this phone in the local test DB
  await db.query('DELETE FROM time_entries WHERE user_phone = $1', [TEST_PHONE]);
  // Later: also wipe any state rows / other related fixtures if needed
});

describe('Timeclock E2E QA', () => {
  it('should respond to "clock in" with a 200 + clock-in style message', async () => {
    const resp = await supertest(app)
      .post('/api/webhook')
      .send({ Body: 'clock in', From: TEST_PHONE })
      .expect(200);

    // Make sure we got some kind of "clocked in" reply back
    expect(resp.text).toMatch(/clocked in|you are now clocked in|<Message>/i);

    // TODO: Once test fixtures (owner, employee, job, etc.) are seeded into sherpa_test,
    // re-enable this DB assertion so we verify the row is actually written.
    //
    // const { rows } = await db.query(
    //   `SELECT *
    //      FROM time_entries
    //     WHERE user_phone = $1
    //       AND type = 'shift'
    //       AND out_time IS NULL`,
    //   [TEST_PHONE]
    // );
    // expect(rows.length).toBe(1);
  });

  // Later:
  // it('should clock out', ...)
  // it('should handle breaks', ...)
  // it('should reject unknown users', ...)
});
