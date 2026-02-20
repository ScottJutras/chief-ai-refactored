// src/config/getEffectivePlanKey.js

function normalizePlanKey(x) {
  const p = String(x || "").toLowerCase().trim();

  // canonical
  if (p === "free" || p === "starter" || p === "pro") return p;

  // common variants / legacy
  if (p === "basic") return "starter";
  if (p === "professional") return "pro";
  if (p === "unlimited") return "pro";

  return "free";
}

function normalizeStatus(x) {
  return String(x || "").toLowerCase().trim();
}

/**
 * Treat these as "entitled" (allowed to use paid features).
 * Stripe + many internal systems use these.
 */
function isEntitledStatus(status) {
  const s = normalizeStatus(status);
  return (
    s === "active" ||
    s === "trialing" ||
    s === "paid" ||          // common internal alias
    s === "succeeded" ||     // sometimes stored from payment intents (not ideal but seen)
    s === "complete"         // sometimes used by onboarding/billing pipelines
  );
}

/**
 * Canonical "effective plan" used for gating.
 *
 * Goal: prevent plan drift by reading the best available canonical fields.
 * Fail-closed if we cannot prove entitlement.
 *
 * Priority:
 * 1) plan_key + sub_status (canonical)
 * 2) tenant_plan_key + tenant_sub_status (if ownerProfile is actually tenant row)
 * 3) plan_status/stripe_status only if paired with a usable plan key
 *
 * We do NOT use subscription_tier alone as a paid signal.
 */
function getEffectivePlanKey(ownerRow) {
  if (!ownerRow) return "free";

  // --- 1) canonical fields ---
  const planKey =
    ownerRow.plan_key ??
    ownerRow.tenant_plan_key ??
    ownerRow.plan ??                // allow if you stored it here historically
    null;

  const status =
    ownerRow.sub_status ??
    ownerRow.tenant_sub_status ??
    ownerRow.plan_status ??
    ownerRow.stripe_status ??
    null;

  // Fail-closed: must be entitled
  if (!isEntitledStatus(status)) return "free";

  return normalizePlanKey(planKey);
}

module.exports = { getEffectivePlanKey, normalizePlanKey, isEntitledStatus };