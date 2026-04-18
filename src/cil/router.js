// src/cil/router.js
// New-idiom CIL facade. Single forward entry point for all CIL dispatch.
// See docs/QUOTES_SPINE_DECISIONS.md §17 (CIL Architecture Principles).
//
// Callers import `applyCIL` from this module (NOT from services/cilRouter).
// The facade inspects `rawCil.type`, dispatches:
//   - registered new-idiom types    → handler from NEW_IDIOM_HANDLERS registry
//   - everything else                → legacy router via runtime require (§17.5)
//
// When §17.3 fires (legacy handler count reaches zero), the legacy delegation
// branch is removed and services/cilRouter.js is deleted in the same PR.

// ── New-idiom handler registry ──────────────────────────────────────────────
// Populated at handler-module load time via registerNewIdiomHandler() (§17.4).
// Empty at facade creation; first entries land when CreateQuote ships.
const NEW_IDIOM_HANDLERS = Object.create(null);

/**
 * Register a new-idiom CIL handler. Called from src/cil/<doctype>.js modules
 * (e.g., src/cil/quotes.js for CreateQuote / SendQuote / etc.).
 *
 * @param {string} type - CIL type literal, e.g. 'CreateQuote'.
 * @param {(cil: Object, ctx: Object) => Promise<Object>} handler
 * @throws if the type is missing, handler isn't a function, or the type is already registered.
 */
function registerNewIdiomHandler(type, handler) {
  if (!type || typeof type !== 'string') {
    throw new Error(`registerNewIdiomHandler: type must be a non-empty string (got ${type})`);
  }
  if (typeof handler !== 'function') {
    throw new Error(`registerNewIdiomHandler: handler must be a function for type='${type}'`);
  }
  if (NEW_IDIOM_HANDLERS[type]) {
    throw new Error(`registerNewIdiomHandler: duplicate registration for type='${type}'`);
  }
  NEW_IDIOM_HANDLERS[type] = handler;
}

/**
 * Test-only: deregister a previously-registered handler. NOT part of the
 * public API; handlers in production never deregister.
 *
 * @param {string} type
 */
function _deregisterNewIdiomHandlerForTesting(type) {
  delete NEW_IDIOM_HANDLERS[type];
}

function isNewIdiomType(type) {
  return !!(type && NEW_IDIOM_HANDLERS[type]);
}

// ── Constitution §9 error envelope ──────────────────────────────────────────
function errEnvelope({ code, message, hint, traceId }) {
  return {
    ok: false,
    error: {
      code,
      message,
      hint: hint || null,
      traceId: traceId || null,
    },
  };
}

/**
 * applyCIL — single public CIL entry point (§17.5).
 *
 * @param {Object} rawCil - CIL payload; must have a `type` field.
 * @param {Object} ctx - handler context (owner_id, tenant_id, source_msg_id, traceId, ...).
 * @returns {Promise<Object>} handler response or Constitution §9 error envelope.
 */
async function applyCIL(rawCil, ctx) {
  // Fast-path: payload shape validation. Produces the Constitution §9 envelope
  // for obviously-malformed calls so upstream callers see one error shape.
  if (!rawCil || typeof rawCil !== 'object') {
    return errEnvelope({
      code: 'CIL_PAYLOAD_INVALID',
      message: 'CIL payload must be an object',
      hint: 'Pass { type, ...fields } to applyCIL',
      traceId: ctx && ctx.traceId,
    });
  }

  const type = rawCil.type;
  if (!type || typeof type !== 'string') {
    return errEnvelope({
      code: 'CIL_TYPE_MISSING',
      message: 'CIL payload missing type field',
      hint: 'Every CIL call must include a non-empty string type',
      traceId: ctx && ctx.traceId,
    });
  }

  // New-idiom dispatch.
  if (isNewIdiomType(type)) {
    return NEW_IDIOM_HANDLERS[type](rawCil, ctx);
  }

  // Legacy delegation. Runtime require is load-bearing per §17.5 — do not
  // convert to a top-of-file import. The laziness:
  //   (a) avoids module-load-time circularity if legacy code ever imports
  //       from src/cil/;
  //   (b) isolates legacy as a delegate rather than a dependency, so when
  //       §17.3 fires we can delete services/cilRouter.js and this branch
  //       in the same PR without untangling import chains.
  // Future sessions: do not "optimize" this require.
  // eslint-disable-next-line global-require
  const legacyRouter = require('../../services/cilRouter');
  return legacyRouter.applyCIL(rawCil, ctx);
}

module.exports = {
  applyCIL,
  registerNewIdiomHandler,
  isNewIdiomType,
  // test-only:
  _deregisterNewIdiomHandlerForTesting,
};
