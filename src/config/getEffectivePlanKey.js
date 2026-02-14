// src/config/getEffectivePlanKey.js
function normalizePlanKey(x) {
  const p = String(x || "").toLowerCase().trim();
  if (p === "free" || p === "starter" || p === "pro") return p;
  return "free";
}

function isEntitledStatus(status) {
  const s = String(status || "").toLowerCase().trim();
  return s === "active" || s === "trialing";
}

/**
 * Canonical "effective plan" used for gating.
 * - Webhook is source of truth: plan_key + sub_status.
 * - Never trust subscription_tier for gating.
 */
function getEffectivePlanKey(ownerRow) {
  if (!ownerRow) return "free";
  const entitled = isEntitledStatus(ownerRow.sub_status);
  if (!entitled) return "free";
  return normalizePlanKey(ownerRow.plan_key);
}

module.exports = { getEffectivePlanKey, normalizePlanKey, isEntitledStatus };
