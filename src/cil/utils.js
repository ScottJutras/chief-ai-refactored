// src/cil/utils.js
// Shared utilities for new-idiom CIL handlers.
// See docs/QUOTES_SPINE_DECISIONS.md §17.10 (dedup + error classifier) and
// §17.16 (plan-gating helper for new-idiom handlers).

const { getEffectivePlanKey } = require('../config/getEffectivePlanKey');

/**
 * CilIntegrityError — handlers throw this from within a transaction to surface
 * a semantic (non-DB) integrity condition that should be rendered as a clean
 * CIL error envelope rather than a 500-class failure.
 *
 * Examples: customer UUID not found in tenant; job UUID doesn't belong to
 * the quoting owner; composite-FK precondition violated by upstream state.
 *
 * See §17.10 clarification (2026-04-20): sentinel-property patterns
 * (err._cil_code) were rejected as fragile against JavaScript's lack of type
 * enforcement. A typed throw (class + constructor contract) means handlers
 * cannot throw a semantic error without a `code` — contract over convention.
 *
 * Internal code vs. envelope code per §17.18:
 *   - CilIntegrityError.code is operator-facing (specific, e.g.
 *     CUSTOMER_NOT_FOUND_OR_CROSS_TENANT). Useful for logs and diagnostics.
 *   - Envelope code rendered to callers is CIL_INTEGRITY_ERROR (the §17.18
 *     CIL_-prefixed category code). The specific condition goes in `hint`.
 */
class CilIntegrityError extends Error {
  constructor({ code, message, hint } = {}) {
    super(message || 'CIL integrity error');
    this.name = 'CilIntegrityError';
    this.code = code;
    this.hint = hint || null;
  }
}

/**
 * classifyCilError — single-entry classifier for handler catch blocks.
 *
 * Previously named `classifyUniqueViolation`. Renamed 2026-04-20 to reflect
 * broader scope now that semantic (non-DB) errors flow through the same
 * classifier via `CilIntegrityError`. See §17.10 clarification.
 *
 * Four outcomes:
 *
 *   - { kind: 'semantic_error', error }
 *       err instanceof CilIntegrityError. Caller returns an envelope composed
 *       from error.code, error.message, error.hint. The envelope `code`
 *       rendered to the outside is CIL_INTEGRITY_ERROR per §17.18; the
 *       CilIntegrityError.code is operator-facing diagnosis in `hint`.
 *
 *   - { kind: 'idempotent_retry' }
 *       Postgres 23505 on the expected (owner_id, source_msg_id) dedup
 *       constraint. Caller looks up the prior entity and returns with
 *       `meta.already_existed: true` per §17.10 clarification (current
 *       entity state, not original-call state).
 *
 *   - { kind: 'integrity_error', constraint }
 *       Postgres 23505 on a constraint OTHER than the source_msg_id dedup
 *       one (human_id collision, composite-identity UNIQUE, etc.). Caller
 *       returns CIL_INTEGRITY_ERROR envelope with the constraint name in
 *       the hint for operator diagnosis.
 *
 *   - { kind: 'not_unique_violation' }
 *       Neither a CilIntegrityError nor a 23505. Caller rethrows — upstream
 *       (facade / transport) renders as 500-class failure.
 *
 * @param {Error | null | undefined} err
 * @param {Object} opts
 * @param {string} opts.expectedSourceMsgConstraint
 * @returns {{ kind: 'semantic_error', error: CilIntegrityError }
 *          | { kind: 'idempotent_retry' }
 *          | { kind: 'integrity_error', constraint: string | null }
 *          | { kind: 'not_unique_violation' }}
 */
function classifyCilError(err, { expectedSourceMsgConstraint } = {}) {
  // CilIntegrityError first — checked before Postgres codes because an
  // instanceof match is the strongest signal. A CilIntegrityError does NOT
  // have err.code === '23505'; without this check it would fall through to
  // not_unique_violation, which is not the handler's intent.
  if (err instanceof CilIntegrityError) {
    return { kind: 'semantic_error', error: err };
  }

  if (!err || err.code !== '23505') {
    return { kind: 'not_unique_violation' };
  }
  if (err.constraint === expectedSourceMsgConstraint) {
    return { kind: 'idempotent_retry' };
  }
  return { kind: 'integrity_error', constraint: err.constraint || null };
}

/**
 * Constitution §9 error envelope. Shared across the new-idiom facade and
 * every new-idiom handler so denials, validation failures, and gating
 * rejections emit the same shape.
 *
 * @param {Object} p
 * @param {string} p.code
 * @param {string} p.message
 * @param {string|null} [p.hint]
 * @param {string|null} [p.traceId]
 * @returns {{ ok: false, error: { code: string, message: string, hint: string|null, traceId: string|null } }}
 */
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
 * Resolve the effective plan key for a given owner_id. Queries
 * public.users (plan_key, sub_status) and runs the result through
 * getEffectivePlanKey so entitlement status (active/trialing) is honored.
 *
 * Fail-closed: missing ownerId, query failure, or empty row all resolve
 * to 'free'. Per CLAUDE.md: "If plan lookup fails → treat as Free, block
 * gated actions." Never infer plan from cached state.
 *
 * @param {string} ownerId
 * @returns {Promise<'free'|'starter'|'pro'>}
 */
async function resolvePlanForOwner(ownerId) {
  if (!ownerId) return 'free';
  try {
    // Runtime require (same idiom as router.js §17.5 legacy delegation): keeps
    // utils.js loadable in unit tests without a live pg connection. Tests can
    // inject `deps.resolvePlan` to bypass this entirely.
    // eslint-disable-next-line global-require
    const pg = require('../../services/postgres');
    const r = await pg.query(
      `select plan_key, sub_status from public.users where user_id = $1 limit 1`,
      [ownerId]
    );
    return getEffectivePlanKey(r?.rows?.[0] || null);
  } catch (_) {
    return 'free';
  }
}

/**
 * gateNewIdiomHandler — plan-gating helper for new-idiom CIL handlers (§17.16).
 *
 * Centralizes plan resolution, monthly usage lookup, and denial envelope
 * composition so every gated handler produces an identical denial envelope
 * shape. Called AFTER BaseCILZ schema validation and BEFORE the §17.14
 * transaction opens.
 *
 * Return shape:
 *   - { gated: false } when the capability check allows the action.
 *     Caller proceeds to the transaction.
 *   - { gated: true, envelope } when denied. Caller returns the envelope
 *     directly; no DB writes, no events emitted.
 *
 * Counter-increment is the caller's responsibility and happens AFTER
 * transaction commit (rollback must not burn counter; idempotent retry
 * must be caught by classifyCilError before the increment runs).
 *
 * @param {Object} ctx - handler context. Must include owner_id; optional traceId.
 * @param {Function} checkFn - capability check, e.g. canCreateQuote(plan, used)
 *                             returning { allowed, reason_code, message, upgrade_plan }.
 * @param {string} kindLiteral - usage_monthly_v2.kind value (e.g. 'quote_created').
 * @param {Object} [deps] - optional dependency overrides for testing.
 * @param {Function} [deps.resolvePlan] - (ownerId) => Promise<planKey>.
 * @param {Function} [deps.getMonthlyUsage] - ({ownerId, kind}) => Promise<number>.
 * @returns {Promise<{ gated: false } | { gated: true, envelope: Object }>}
 */
async function gateNewIdiomHandler(ctx, checkFn, kindLiteral, deps = {}) {
  const resolvePlanFn = deps.resolvePlan || resolvePlanForOwner;
  const getMonthlyUsageFn =
    deps.getMonthlyUsage ||
    // eslint-disable-next-line global-require
    ((args) => require('../../services/postgres').getMonthlyUsage(args));

  const ownerId = ctx && ctx.owner_id;
  const plan = await resolvePlanFn(ownerId);
  const used = await getMonthlyUsageFn({ ownerId, kind: kindLiteral });
  const gate = checkFn(plan, used);

  if (!gate || gate.allowed !== true) {
    return {
      gated: true,
      envelope: errEnvelope({
        code: gate && gate.reason_code,
        message: gate && gate.message,
        hint: gate && gate.upgrade_plan ? `Upgrade to ${gate.upgrade_plan}` : null,
        traceId: ctx && ctx.traceId,
      }),
    };
  }

  return { gated: false };
}

module.exports = {
  CilIntegrityError,
  classifyCilError,
  errEnvelope,
  resolvePlanForOwner,
  gateNewIdiomHandler,
};
