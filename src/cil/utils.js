// src/cil/utils.js
// Shared utilities for new-idiom CIL handlers.
// See docs/QUOTES_SPINE_DECISIONS.md §17.10 (dedup classifier) and
// §17.16 (plan-gating helper for new-idiom handlers).

const { getEffectivePlanKey } = require('../config/getEffectivePlanKey');

/**
 * Classify a Postgres error after a unique-constraint failure inside a CIL
 * transaction. Used by new-idiom handlers implementing the optimistic
 * INSERT-and-catch dedup pattern from §17.9.
 *
 * Three outcomes:
 *   - { kind: 'not_unique_violation' }
 *       err is not Postgres 23505 (or no err at all). Caller should treat
 *       as a generic error and rethrow (or no-op if err was null).
 *
 *   - { kind: 'idempotent_retry' }
 *       err.constraint matches the expected (owner_id, source_msg_id) dedup
 *       constraint. The INSERT was a retry of a prior successful operation.
 *       Caller should roll back its transaction, look up the prior row via
 *       (owner_id, source_msg_id), and return an idempotent success envelope
 *       with `already_existed: true`.
 *
 *   - { kind: 'integrity_error', constraint }
 *       A unique_violation fired, but on a constraint other than the dedup
 *       one (e.g., human_id collision, composite-identity UNIQUE). This is
 *       a genuine integrity error; the caller should rethrow with an
 *       explicit error code distinct from the idempotent case.
 *
 * Handlers pass the exact expected constraint name. Exact match, no regex.
 * This tolerates current naming drift (e.g., chiefos_quotes uses the full
 * form `chiefos_quotes_source_msg_unique` while others use the abbreviated
 * form `chiefos_<abbrev>_source_msg_unique`).
 *
 * @param {Error | null | undefined} err
 * @param {Object} opts
 * @param {string} opts.expectedSourceMsgConstraint
 * @returns {{ kind: 'not_unique_violation' }
 *          | { kind: 'idempotent_retry' }
 *          | { kind: 'integrity_error', constraint: string | null }}
 */
function classifyUniqueViolation(err, { expectedSourceMsgConstraint } = {}) {
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
 * must be caught by classifyUniqueViolation before the increment runs).
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
  classifyUniqueViolation,
  errEnvelope,
  resolvePlanForOwner,
  gateNewIdiomHandler,
};
