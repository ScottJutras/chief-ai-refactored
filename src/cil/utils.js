// src/cil/utils.js
// Shared utilities for new-idiom CIL handlers.
// See docs/QUOTES_SPINE_DECISIONS.md §17.10.

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

module.exports = { classifyUniqueViolation };
