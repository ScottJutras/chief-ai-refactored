// middleware/requireCrewControlStarter.js
const pg = require("../services/postgres");

function jsonErr(res, status, code, message, extra = {}) {
  return res.status(status).json({ ok: false, code, message, ...extra });
}

/**
 * requireCrewControlStarter()
 * Allows: starter, pro
 * Fail-closed: if plan lookup fails -> treat as free (deny).
 *
 * Assumes req.ownerId is resolved by requirePortalUser (or earlier middleware).
 */
function requireCrewControlStarter() {
  return async function (req, res, next) {
    try {
      const ownerId = String(req.ownerId || "").trim();
      if (!ownerId) {
        return jsonErr(res, 401, "AUTH_REQUIRED", "Authentication required.");
      }

      const planKey = await pg.withClient(async (client) => {
        // Detect which table exists for plan authority
        const reg = await client.query(
          `
          select
            to_regclass('public.users') as t_users,
            to_regclass('public.chiefos_users') as t_chiefos_users
          `
        );

        const tUsers = reg?.rows?.[0]?.t_users || null;
        const tChiefosUsers = reg?.rows?.[0]?.t_chiefos_users || null;

        // Fail closed by default
        let key = "free";

        if (tUsers) {
          const r = await client.query(
            `select plan_key from public.users where owner_id = $1 limit 1`,
            [ownerId]
          );
          key = String(r?.rows?.[0]?.plan_key || "free").trim().toLowerCase();
        } else if (tChiefosUsers) {
          const r = await client.query(
            `select plan_key from public.chiefos_users where owner_id = $1 limit 1`,
            [ownerId]
          );
          key = String(r?.rows?.[0]?.plan_key || "free").trim().toLowerCase();
        }

        return key || "free";
      });

      const allowed = planKey === "starter" || planKey === "pro";
      if (!allowed) {
        return jsonErr(res, 402, "NOT_INCLUDED", "Crew+Control requires Starter or Pro.", {
          plan_key: planKey,
          required: "starter",
        });
      }

      req.planKey = planKey; // optional: useful for logs
      return next();
    } catch (e) {
      // Fail closed
      return jsonErr(res, 402, "NOT_INCLUDED", "Crew+Control requires Starter or Pro.");
    }
  };
}

module.exports = { requireCrewControlStarter };