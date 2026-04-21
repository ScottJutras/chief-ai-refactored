// src/cil/router.js
// New-idiom CIL facade. Single forward entry point for all CIL dispatch.
// See docs/QUOTES_SPINE_DECISIONS.md §17 (CIL Architecture Principles).
//
// Callers import `applyCIL` from this module (NOT from services/cilRouter).
// The facade inspects `rawCil.type`, dispatches:
//   - registered new-idiom types    → handler from NEW_IDIOM_HANDLERS map
//   - everything else                → legacy router via runtime require (§17.5)
//
// When §17.3 fires (legacy handler count reaches zero), the legacy delegation
// branch is removed and services/cilRouter.js is deleted in the same PR.

// ── New-idiom handler registry ──────────────────────────────────────────────
// STATIC, FROZEN MAP per §17.12. New handlers land in two explicit steps:
//   (a) add `const { handleFooBar } = require('./foo');` below
//   (b) add `FooBar: handleFooBar,` to the map
// Both in this file. No runtime registration API — the map is the registry.
//
// Forgetting step (b) means the type falls through to legacy and returns
// CIL_TYPE_UNKNOWN on first call — loud at the call site, caught in review
// by the router.js diff. See §17.12 rejected alternatives.
//
// Freezing prevents future sessions from accidentally re-introducing a
// runtime-registration side channel. If you're tempted to mutate this map
// at runtime: don't. Add to the map literal and redeploy.

// Imports for registered handlers (populated as each handler ships).
const { handleCreateQuote, handleSendQuote, handleSignQuote } = require('./quotes');

const NEW_IDIOM_HANDLERS = Object.freeze({
  CreateQuote: handleCreateQuote,
  SendQuote: handleSendQuote,
  SignQuote: handleSignQuote,
  // LockQuote:   handleLockQuote,
  // VoidQuote:   handleVoidQuote,
  // ReissueQuote: handleReissueQuote,
});

// Constitution §9 error envelope lives in src/cil/utils.js so the facade
// and every new-idiom handler share one shape (§17.16).
const { errEnvelope } = require('./utils');

/**
 * applyCIL — single public CIL entry point (§17.5, §17.12).
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

  // New-idiom dispatch — lookup in the frozen map.
  const newHandler = NEW_IDIOM_HANDLERS[type];
  if (newHandler) {
    return newHandler(rawCil, ctx);
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

module.exports = { applyCIL };
