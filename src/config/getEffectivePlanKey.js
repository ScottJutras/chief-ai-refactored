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
 * Accepts either:
 * - raw DB row (plan_key/sub_status/subscription_tier...)
 * - shaped middleware profile (plan)
 */
function getEffectivePlanKey(ownerRow) {
  if (!ownerRow) return "free";

  // ✅ IMPORTANT: shaped profile support (your middleware)
  // shapeMinimalProfile stores `plan` as the already-resolved effective plan.
  const shapedPlan = normalizePlanKey(ownerRow.plan);
  if (shapedPlan) return shapedPlan;

  // raw DB fields
  const planKey = normalizePlanKey(ownerRow.plan_key);

  const subStatus = normalizeStatus(ownerRow.sub_status);
  const planStatus = normalizeStatus(ownerRow.plan_status);
  const stripeStatus = normalizeStatus(ownerRow.stripe_status);

  const entitled =
    isEntitledStatus(subStatus) ||
    isEntitledStatus(planStatus) ||
    isEntitledStatus(stripeStatus);

  // best: entitled + explicit plan_key
  if (entitled && planKey) return planKey;

  // migration case: plan_key present but status missing
  if (planKey) return planKey;

  // legacy fallbacks
  const legacy =
    normalizePlanKey(ownerRow.subscription_tier) ||
    normalizePlanKey(ownerRow.paid_tier) ||
    normalizePlanKey(ownerRow.tier) ||
    normalizePlanKey(ownerRow.stripe_plan) ||
    "";

  if (legacy) return legacy;

  return "free";
}

module.exports = { getEffectivePlanKey, normalizePlanKey, isEntitledStatus };