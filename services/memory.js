// services/memory.js
// ============================================================================
// TRANSITIONAL SHIM (R4 Foundation Rebuild).
//
// Status: ALL pre-rebuild target tables were DISCARDed in the rebuild schema:
//   - assistant_events       → DISCARD (folded into conversation_messages /
//                                       chiefos_activity_logs)
//   - user_memory            → DISCARD (no clean rebuild target — see Forward
//                                       Flag below)
//   - convo_state            → DISCARD (subsumed by conversation_sessions)
//   - entity_summary         → DISCARD (folded into
//                                       conversation_sessions.active_entities)
// References: FOUNDATION_P1_SCHEMA_DESIGN.md rows 1560–1562, 2861.
//
// Live caller surface at R4 cutover (V4 grep, excluding worktrees + archive):
//   - nlp/conversation.js calls getMemory / upsertMemory / forget — but
//     nlp/conversation.js itself is dead surface (its exported converseAndRoute
//     has zero callers in live code). Effectively no live-traffic surface.
//
// What this shim does:
//   - Exports the names nlp/conversation.js imports at module-load time so
//     `require('../services/memory')` does not throw if anything ever wires
//     converseAndRoute back in.
//   - All functions are no-ops returning benign defaults. No SQL is issued
//     against the DISCARDed tables (which do not exist in the rebuild schema).
//
// FORWARD FLAG (founder review): per-user persistent KV (the original
// user_memory use case — vendor aliases, default expense bucket, etc.) has no
// rebuild target. conversation_sessions.active_entities is session-scoped, not
// long-lived. Decision needed before this surface is reactivated:
//   (a) New Phase 1 amendment table (e.g., tenant_user_kv) for persistent KV
//   (b) Repurpose conversation_sessions.active_entities with TTL handling
//   (c) Drop the user-memory feature entirely
// Recorded in SESSION_R4_REMEDIATION_REPORT.md §14.
// ============================================================================

async function getMemory(_ownerId, _userId, _keys = []) {
  return {};
}

async function upsertMemory(_ownerId, _userId, _key, _value) {
  return;
}

async function forget(_ownerId, _userId, _key) {
  return;
}

module.exports = {
  getMemory,
  upsertMemory,
  forget,
};
