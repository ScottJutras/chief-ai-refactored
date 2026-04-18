// src/cil/utils.test.js
// Unit tests for classifyUniqueViolation (§17.10), errEnvelope shape,
// and gateNewIdiomHandler (§17.16).

const { classifyUniqueViolation, errEnvelope, gateNewIdiomHandler } = require('./utils');

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

describe('gateNewIdiomHandler (§17.16)', () => {
  const ctx = { owner_id: '15551234567', traceId: 't-abc' };

  // Capability-check stubs returning the canUseOCR-shape decision object.
  const allowDecision = { allowed: true, reason_code: null, message: null, upgrade_plan: null };
  const denyRequiresStarter = {
    allowed: false,
    reason_code: 'QUOTES_REQUIRES_STARTER',
    message: 'Quote creation is available on Starter and Pro.',
    upgrade_plan: 'starter',
  };
  const denyCapacityReached = {
    allowed: false,
    reason_code: 'QUOTES_CAPACITY_REACHED',
    message: "You've reached your monthly quote limit.",
    upgrade_plan: 'pro',
  };

  test('allow-case: returns { gated: false } and forwards plan+usage to checkFn', async () => {
    const resolvePlan = jest.fn().mockResolvedValue('starter');
    const getMonthlyUsage = jest.fn().mockResolvedValue(3);
    const checkFn = jest.fn().mockReturnValue(allowDecision);

    const result = await gateNewIdiomHandler(
      ctx,
      checkFn,
      'quote_created',
      { resolvePlan, getMonthlyUsage }
    );

    expect(result).toEqual({ gated: false });
    expect(resolvePlan).toHaveBeenCalledWith('15551234567');
    expect(getMonthlyUsage).toHaveBeenCalledWith({ ownerId: '15551234567', kind: 'quote_created' });
    expect(checkFn).toHaveBeenCalledWith('starter', 3);
  });

  test('deny-case (requires-upgrade): returns gated envelope with reason_code + upgrade hint', async () => {
    const resolvePlan = jest.fn().mockResolvedValue('free');
    const getMonthlyUsage = jest.fn().mockResolvedValue(0);
    const checkFn = jest.fn().mockReturnValue(denyRequiresStarter);

    const result = await gateNewIdiomHandler(
      ctx,
      checkFn,
      'quote_created',
      { resolvePlan, getMonthlyUsage }
    );

    expect(result.gated).toBe(true);
    expect(result.envelope.ok).toBe(false);
    expect(result.envelope.error.code).toBe('QUOTES_REQUIRES_STARTER');
    expect(result.envelope.error.message).toBe('Quote creation is available on Starter and Pro.');
    expect(result.envelope.error.hint).toBe('Upgrade to starter');
    expect(checkFn).toHaveBeenCalledWith('free', 0);
  });

  test('deny-case (capacity-reached): returns gated envelope with capacity reason_code', async () => {
    const resolvePlan = jest.fn().mockResolvedValue('starter');
    const getMonthlyUsage = jest.fn().mockResolvedValue(50);
    const checkFn = jest.fn().mockReturnValue(denyCapacityReached);

    const result = await gateNewIdiomHandler(
      ctx,
      checkFn,
      'quote_created',
      { resolvePlan, getMonthlyUsage }
    );

    expect(result.gated).toBe(true);
    expect(result.envelope.error.code).toBe('QUOTES_CAPACITY_REACHED');
    expect(result.envelope.error.hint).toBe('Upgrade to pro');
    expect(checkFn).toHaveBeenCalledWith('starter', 50);
  });

  test('traceId propagation: ctx.traceId flows through to the denial envelope', async () => {
    const resolvePlan = jest.fn().mockResolvedValue('free');
    const getMonthlyUsage = jest.fn().mockResolvedValue(0);
    const checkFn = jest.fn().mockReturnValue(denyRequiresStarter);

    const result = await gateNewIdiomHandler(
      { owner_id: '15557654321', traceId: 'trace-xyz-123' },
      checkFn,
      'quote_created',
      { resolvePlan, getMonthlyUsage }
    );

    expect(result.envelope.error.traceId).toBe('trace-xyz-123');
  });

  test('null/missing upgrade_plan in decision: hint is null, not "Upgrade to null"', async () => {
    const resolvePlan = jest.fn().mockResolvedValue('free');
    const getMonthlyUsage = jest.fn().mockResolvedValue(0);
    const checkFn = jest.fn().mockReturnValue({
      allowed: false,
      reason_code: 'SOMETHING_ELSE',
      message: 'Not available',
      upgrade_plan: null,
    });

    const result = await gateNewIdiomHandler(
      ctx,
      checkFn,
      'quote_created',
      { resolvePlan, getMonthlyUsage }
    );

    expect(result.envelope.error.hint).toBeNull();
  });
});

describe('errEnvelope shape', () => {
  test('returns Constitution §9 envelope with all fields', () => {
    const env = errEnvelope({
      code: 'TEST_CODE',
      message: 'test message',
      hint: 'test hint',
      traceId: 't-1',
    });
    expect(env).toEqual({
      ok: false,
      error: { code: 'TEST_CODE', message: 'test message', hint: 'test hint', traceId: 't-1' },
    });
  });

  test('null-coerces missing hint and traceId', () => {
    const env = errEnvelope({ code: 'X', message: 'm' });
    expect(env.error.hint).toBeNull();
    expect(env.error.traceId).toBeNull();
  });
});
