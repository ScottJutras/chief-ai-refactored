// src/cil/utils.test.js
// Unit tests for classifyUniqueViolation (§17.10).

const { classifyUniqueViolation } = require('./utils');

describe('classifyUniqueViolation', () => {
  const opts = { expectedSourceMsgConstraint: 'chiefos_quotes_source_msg_unique' };

  test('null err returns not_unique_violation', () => {
    expect(classifyUniqueViolation(null, opts)).toEqual({ kind: 'not_unique_violation' });
  });

  test('undefined err returns not_unique_violation', () => {
    expect(classifyUniqueViolation(undefined, opts)).toEqual({ kind: 'not_unique_violation' });
  });

  test('err with non-23505 code returns not_unique_violation', () => {
    expect(classifyUniqueViolation({ code: '23502' }, opts)).toEqual({ kind: 'not_unique_violation' });
    expect(classifyUniqueViolation({ code: '23503' }, opts)).toEqual({ kind: 'not_unique_violation' });
    expect(classifyUniqueViolation({ code: '23514' }, opts)).toEqual({ kind: 'not_unique_violation' });
  });

  test('err with no code returns not_unique_violation', () => {
    expect(classifyUniqueViolation({ message: 'some other error' }, opts))
      .toEqual({ kind: 'not_unique_violation' });
  });

  test('23505 with matching constraint returns idempotent_retry', () => {
    expect(classifyUniqueViolation(
      { code: '23505', constraint: 'chiefos_quotes_source_msg_unique' },
      opts
    )).toEqual({ kind: 'idempotent_retry' });
  });

  test('23505 with different constraint returns integrity_error with name', () => {
    expect(classifyUniqueViolation(
      { code: '23505', constraint: 'chiefos_quotes_human_id_unique' },
      opts
    )).toEqual({ kind: 'integrity_error', constraint: 'chiefos_quotes_human_id_unique' });
  });

  test('23505 with no constraint name returns integrity_error with null', () => {
    expect(classifyUniqueViolation({ code: '23505' }, opts))
      .toEqual({ kind: 'integrity_error', constraint: null });
  });

  test('handlers pass their own expected constraint name (exact match)', () => {
    // CreateQuote will guard chiefos_quotes_source_msg_unique
    expect(classifyUniqueViolation(
      { code: '23505', constraint: 'chiefos_quotes_source_msg_unique' },
      { expectedSourceMsgConstraint: 'chiefos_quotes_source_msg_unique' }
    )).toEqual({ kind: 'idempotent_retry' });

    // SendQuote will guard chiefos_qst_source_msg_unique
    expect(classifyUniqueViolation(
      { code: '23505', constraint: 'chiefos_qst_source_msg_unique' },
      { expectedSourceMsgConstraint: 'chiefos_qst_source_msg_unique' }
    )).toEqual({ kind: 'idempotent_retry' });

    // Mismatch (wrong handler) = integrity_error
    expect(classifyUniqueViolation(
      { code: '23505', constraint: 'chiefos_qst_source_msg_unique' },
      { expectedSourceMsgConstraint: 'chiefos_quotes_source_msg_unique' }
    )).toEqual({ kind: 'integrity_error', constraint: 'chiefos_qst_source_msg_unique' });
  });

  test('missing opts object does not throw', () => {
    // Defensive: if a caller forgets the opts arg, we still classify the 23505/non-23505 distinction.
    expect(classifyUniqueViolation({ code: '23505', constraint: 'some_constraint' }))
      .toEqual({ kind: 'integrity_error', constraint: 'some_constraint' });
    expect(classifyUniqueViolation({ code: '23502' }))
      .toEqual({ kind: 'not_unique_violation' });
  });
});
