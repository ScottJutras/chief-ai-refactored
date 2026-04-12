// routes/chiefQuota.js
// GET /api/chief-quota — returns the current user's Ask Chief usage for the month.
// Used by the portal pull-tab to show dots (free) or X/250 / X/2,000 (paid).

const express = require("express");
const router  = express.Router();
const { createClient } = require("@supabase/supabase-js");
const { requirePortalUser }       = require("../middleware/requirePortalUser");
const pg                          = require("../services/postgres");
const { getEffectivePlanFromOwner } = require("../src/config/effectivePlan");

const PLAN_LIMITS = { free: 3, starter: 250, pro: 2000 };

let _admin = null;
function getAdminSupabase() {
  if (_admin) return _admin;
  const url        = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Missing Supabase env vars");
  _admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _admin;
}

function ymNow(tz = "America/Toronto") {
  if (typeof pg.ymInTZ === "function") return pg.ymInTZ(tz);
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

router.get("/api/chief-quota", requirePortalUser(), async (req, res) => {
  const ownerId  = String(req.ownerId  || "").trim();
  const tz       = req.tenant?.tz || "America/Toronto";

  // If no owner is linked, return free defaults — no error
  if (!ownerId) {
    return res.status(200).json({ ok: true, used: 0, limit: 3, planKey: "free" });
  }

  try {
    const supabase = getAdminSupabase();
    const { data: userRow } = await supabase
      .from("users")
      .select("user_id, plan_key, subscription_tier, stripe_subscription_id, sub_status, trial_end, current_period_end")
      .eq("user_id", ownerId)
      .maybeSingle();

    const planKey = String(getEffectivePlanFromOwner(userRow) || "free").toLowerCase().trim();
    const limit   = PLAN_LIMITS[planKey] ?? 3;

    const ym    = ymNow(tz);
    const usage = await pg.getUsageMonthly(ownerId, ym, { createIfMissing: false });
    const used  = Number(usage?.ask_chief_questions || 0);

    return res.status(200).json({ ok: true, used, limit, planKey });
  } catch {
    // Fail open — worst case shows 0/3
    return res.status(200).json({ ok: true, used: 0, limit: 3, planKey: "free" });
  }
});

module.exports = router;
