// src/cil/router.test.js
// Facade tests: new-idiom dispatch, legacy delegation, error envelope consistency.
// See docs/QUOTES_SPINE_DECISIONS.md §17.

// Mock the legacy router so tests don't depend on the DB.
// The runtime require in src/cil/router.js picks up this mock on each call.
jest.mock('../../services/cilRouter', () => ({
  applyCIL: jest.fn(async (rawCil, ctx) => ({
    ok: false,
    error: {
      code: 'CIL_TYPE_UNKNOWN',
      message: `No handler registered for type '${rawCil.type}'`,
      hint: 'Verify the CIL type name; check src/cil/router.js registrations and services/cilRouter.js schemaMap',
      traceId: (ctx && ctx.traceId) || null,
    },
  })),
}));

const router = require('./router');
const legacyRouter = require('../../services/cilRouter');

describe('src/cil/router applyCIL facade', () => {
  beforeEach(() => {
    legacyRouter.applyCIL.mockClear();
  });

  // ── Payload validation ────────────────────────────────────────────────────
  test('null payload returns CIL_PAYLOAD_INVALID envelope; does not touch legacy', async () => {
    const result = await router.applyCIL(null, { traceId: 't-null' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CIL_PAYLOAD_INVALID');
    expect(result.error.traceId).toBe('t-null');
    expect(legacyRouter.applyCIL).not.toHaveBeenCalled();
  });

  test('non-object payload returns CIL_PAYLOAD_INVALID envelope', async () => {
    const result = await router.applyCIL('not an object', { traceId: 't-str' });
    expect(result.error.code).toBe('CIL_PAYLOAD_INVALID');
    expect(legacyRouter.applyCIL).not.toHaveBeenCalled();
  });

  test('missing type returns CIL_TYPE_MISSING envelope', async () => {
    const result = await router.applyCIL({ foo: 'bar' }, { traceId: 't-missing' });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CIL_TYPE_MISSING');
    expect(result.error.traceId).toBe('t-missing');
    expect(legacyRouter.applyCIL).not.toHaveBeenCalled();
  });

  test('empty-string type returns CIL_TYPE_MISSING envelope', async () => {
    const result = await router.applyCIL({ type: '' }, { traceId: 't-empty' });
    expect(result.error.code).toBe('CIL_TYPE_MISSING');
    expect(legacyRouter.applyCIL).not.toHaveBeenCalled();
  });

  // ── Legacy delegation path ────────────────────────────────────────────────
  test('unknown type delegates to legacy router (runtime require is load-bearing)', async () => {
    const result = await router.applyCIL(
      { type: 'DefinitelyNotARealType' },
      { traceId: 't-unknown' }
    );
    expect(legacyRouter.applyCIL).toHaveBeenCalledTimes(1);
    expect(legacyRouter.applyCIL).toHaveBeenCalledWith(
      { type: 'DefinitelyNotARealType' },
      { traceId: 't-unknown' }
    );
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CIL_TYPE_UNKNOWN');
  });

  test('legacy-type dispatch returns whatever the legacy router returns', async () => {
    legacyRouter.applyCIL.mockResolvedValueOnce({ ok: true, lead_id: 'abc' });
    const result = await router.applyCIL({ type: 'CreateLead' }, { traceId: 't-legacy' });
    expect(legacyRouter.applyCIL).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, lead_id: 'abc' });
  });

  // ── New-idiom dispatch ────────────────────────────────────────────────────
  test('registered new-idiom type dispatches to handler and skips legacy', async () => {
    const handler = jest.fn(async () => ({ ok: true, handled: true }));
    router.registerNewIdiomHandler('TestNewType_A', handler);
    try {
      const result = await router.applyCIL(
        { type: 'TestNewType_A', foo: 'bar' },
        { traceId: 't-new' }
      );
      expect(handler).toHaveBeenCalledWith(
        { type: 'TestNewType_A', foo: 'bar' },
        { traceId: 't-new' }
      );
      expect(legacyRouter.applyCIL).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true, handled: true });
    } finally {
      router._deregisterNewIdiomHandlerForTesting('TestNewType_A');
    }
  });

  test('new-idiom handler errors propagate (not enveloped by facade)', async () => {
    router.registerNewIdiomHandler('TestNewType_Err', async () => {
      const e = new Error('handler exploded');
      e.code = 'HANDLER_EXPLODED';
      throw e;
    });
    try {
      await expect(router.applyCIL({ type: 'TestNewType_Err' }, {})).rejects.toThrow('handler exploded');
    } finally {
      router._deregisterNewIdiomHandlerForTesting('TestNewType_Err');
    }
  });

  // ── Registration edge cases ──────────────────────────────────────────────
  test('registerNewIdiomHandler rejects missing type', () => {
    expect(() => router.registerNewIdiomHandler('', async () => ({ ok: true }))).toThrow(
      /type must be a non-empty string/
    );
    expect(() => router.registerNewIdiomHandler(null, async () => ({ ok: true }))).toThrow();
  });

  test('registerNewIdiomHandler rejects non-function handler', () => {
    expect(() => router.registerNewIdiomHandler('X', null)).toThrow(/handler must be a function/);
    expect(() => router.registerNewIdiomHandler('X', 'not a fn')).toThrow();
  });

  test('registerNewIdiomHandler rejects duplicate type', () => {
    router.registerNewIdiomHandler('DuplicateCheck', async () => ({ ok: true }));
    try {
      expect(() =>
        router.registerNewIdiomHandler('DuplicateCheck', async () => ({ ok: true }))
      ).toThrow(/duplicate registration/);
    } finally {
      router._deregisterNewIdiomHandlerForTesting('DuplicateCheck');
    }
  });

  test('isNewIdiomType reflects the registry', () => {
    expect(router.isNewIdiomType('NotRegistered')).toBe(false);
    router.registerNewIdiomHandler('IsRegisteredCheck', async () => ({ ok: true }));
    try {
      expect(router.isNewIdiomType('IsRegisteredCheck')).toBe(true);
    } finally {
      router._deregisterNewIdiomHandlerForTesting('IsRegisteredCheck');
    }
  });
});
