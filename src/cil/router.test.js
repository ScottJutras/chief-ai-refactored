// src/cil/router.test.js
// Facade tests: dispatch paths that exist in the current state (empty new-idiom
// map + legacy delegation + error envelopes). See docs/QUOTES_SPINE_DECISIONS.md
// §17 (CIL Architecture Principles) — specifically §17.12 (static frozen map,
// no runtime registration).
//
// New-idiom dispatch coverage lands with the first handler (CreateQuote):
// its own integration test suite will exercise the NEW_IDIOM_HANDLERS[type]
// path once the map includes a real entry. No way to test the branch here
// without runtime registration (rejected by §17.12).

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

  // ── Payload validation (handled in-facade, no legacy touched) ────────────
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

  // ── Legacy delegation path (map is empty until CreateQuote ships) ────────
  test('type with no new-idiom entry delegates to legacy router (runtime require is load-bearing)', async () => {
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
});
