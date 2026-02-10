// services/gateLog.js
function logGateDenied({ ownerId, actorId = null, gate, plan, used = null, cap = null, route = null, note = null }) {
  console.warn('[GATE_DENY]', {
    ownerId: String(ownerId || ''),
    actorId: actorId ? String(actorId) : null,
    gate: String(gate || ''),
    plan: String(plan || ''),
    used: used == null ? null : Number(used),
    cap: cap == null ? null : Number(cap),
    route: route || null,
    note: note || null,
    ts: new Date().toISOString(),
  });
}

module.exports = { logGateDenied };
