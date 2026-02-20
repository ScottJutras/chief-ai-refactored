function normalizePlanKey(x) {
  const p = String(x || "").toLowerCase().trim();
  if (p === "free" || p === "starter" || p === "pro") return p;

  // common variants
  if (p === "professional") return "pro";
  if (p === "starter_monthly" || p === "starter_yearly") return "starter";
  if (p === "pro_monthly" || p === "pro_yearly") return "pro";

  return "";
}

function normalizeStatus(x) {
  return String(x || "").toLowerCase().trim();
}

function isEntitledStatus(status) {
  const s = normalizeStatus(status);
  return s === "active" || s === "trialing";
}

/**
 * Canonical "effective plan" used for gating.
 *
 * Priority:
 * 1) If we have an entitled status (sub_status / plan_status / stripe_status), use plan_key if present.
 * 2) If status fields are missing/null (common during migration), fall back to legacy plan fields:
 *    subscription_tier / tier / stripe_plan-like fields.
 *
 * Never trust random strings; only accept free/starter/pro after normalization.
 */
function getEffectivePlanKey(ownerRow) {
  if (!ownerRow) return "free";

  const planKey = normalizePlanKey(ownerRow.plan_key);

  const subStatus = normalizeStatus(ownerRow.sub_status);
  const planStatus = normalizeStatus(ownerRow.plan_status);
  const stripeStatus = normalizeStatus(ownerRow.stripe_status);

  const entitled =
    isEntitledStatus(subStatus) ||
    isEntitledStatus(planStatus) ||
    isEntitledStatus(stripeStatus);

  // 1) Best case: entitled + explicit plan_key
  if (entitled && planKey) return planKey;

  // 2) Migration case: we may have plan_key but no status yet — treat it as authoritative if set
  if (planKey) return planKey;

  // 3) Legacy fallback fields (your logs show these exist / used)
  const legacy =
    normalizePlanKey(ownerRow.subscription_tier) ||
    normalizePlanKey(ownerRow.tier) ||
    normalizePlanKey(ownerRow.stripe_plan) ||
    "";

  if (legacy) return legacy;

  return "free";
}

module.exports = { getEffectivePlanKey, normalizePlanKey, isEntitledStatus };