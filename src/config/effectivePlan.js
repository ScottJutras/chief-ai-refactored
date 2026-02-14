// src/config/effectivePlan.js
// Canonical, status-aware plan resolver for ALL runtime gating (CommonJS).

const { getEffectivePlanKey } = require("./capabilities");

function getEffectivePlanFromOwner(ownerProfile) {
  // Preferred: plan_key + sub_status (billing truth)
  try {
    if (ownerProfile && (ownerProfile.plan_key || ownerProfile.sub_status)) {
      return getEffectivePlanKey(ownerProfile);
    }
  } catch {}

  // Fallback (legacy fields) — safe default
  const rawFallback = String(
    ownerProfile?.plan ||
      ownerProfile?.tier ||
      ownerProfile?.pricing_plan ||
      ownerProfile?.subscription_tier ||
      ownerProfile?.paid_tier ||
      "free"
  )
    .toLowerCase()
    .trim();

  return rawFallback === "free" || rawFallback === "starter" || rawFallback === "pro"
    ? rawFallback
    : "free";
}

module.exports = { getEffectivePlanFromOwner };
