// middleware/requireCrewControlPro.js
const pg = require("../services/postgres");
const { getEffectivePlanKey } = require("../src/config/getEffectivePlanKey");

function jsonErr(res, status, code, message, extra = {}) {
  return res.status(status).json({ ok: false, code, message, ...extra });
}

/**
 * Fail-closed plan gate for Crew+Control (Approvals / Board).
 * - Resolve by owner_id (never tenant_id alone).
 * - If lookup fails -> treat as free (block).
 * - Uses canonical getEffectivePlanKey() so it matches your whole system.
 */
function requireCrewControlPro() {
  return async (req, res, next) => {
    try {
      const tenantId = String(req.tenantId || "").trim();
      const ownerId = String(req.ownerId || "").trim();

      if (!tenantId || !ownerId) {
        return jsonErr(res, 403, "TENANT_CTX_MISSING", "Access not resolved. Please re-authenticate.");
      }

      // Feature flag should only ever restrict, never grant access.
      if (String(process.env.FEATURE_CREW_CONTROL || "1") !== "1") {
        return jsonErr(res, 403, "FEATURE_DISABLED", "Crew+Control is not enabled.");
      }

      // ✅ If upstream middleware already shaped a profile with plan, use it.
      // (Your getEffectivePlanKey supports shaped { plan } too.)
      const shaped = req.profile || req.userProfile || null;
      const shapedPlan = getEffectivePlanKey(shaped);

      if (shapedPlan && shapedPlan !== "free") {
        if (shapedPlan === "pro") return next();
        return jsonErr(res, 402, "NOT_INCLUDED", "Crew+Control approvals require Pro. Upgrade to enable.");
      }

      // Otherwise, fetch owner row and compute effective plan.
      const out = await pg.withClient(async (client) => {
        const r = await client.query(
          `
          select *
            from public.users
           where owner_id = $1
           limit 1
          `,
          [ownerId]
        );
        return r?.rows?.[0] || null;
      });

      const effective = getEffectivePlanKey(out); // ✅ canonical (fails to "free" if missing)
      if (effective !== "pro") {
        return jsonErr(res, 402, "NOT_INCLUDED", "Crew+Control approvals require Pro. Upgrade to enable.");
      }

      req.planKey = effective;
      return next();
    } catch (e) {
      console.error("[MONETIZATION][CREW_CONTROL] gate error (fail-closed)", e?.message || e);
      // ✅ Fail closed: treat as free.
      return jsonErr(res, 402, "NOT_INCLUDED", "Crew+Control approvals require Pro. Upgrade to enable.");
    }
  };
}

module.exports = { requireCrewControlPro };