// routes/askChief.js
const express = require("express");
const router = express.Router();

const { requireDashboardOwner } = require("../middleware/requireDashboardOwner");
const { requirePortalUser } = require("../middleware/requirePortalUser");
const { answerChief } = require("../services/answerChief");
const { runAgent } = require("../services/agent");

/**
 * ✅ IMPORTANT:
 * Portal requests use Authorization: Bearer <supabase_jwt>
 * so Authorization header is NOT a valid dashboard signal.
 * Dashboard mode should be cookie-driven only.
 */
function hasDashboardToken(req) {
  const cookie = String(req.headers?.cookie || "");
  return (
    cookie.includes("chiefos_dashboard_token=") ||
    cookie.includes("dashboard_token=") ||
    cookie.includes("dashboardToken=")
  );
}

// ✅ One route, two auth modes:
// - Dashboard mode: requireDashboardOwner -> sets req.ownerId (digits)
// - Portal mode: requirePortalUser -> sets req.tenantId + req.portalUserId + req.ownerId (best-effort)
router.post("/api/ask-chief", express.json(), async (req, res) => {
  try {
    // ---------------- Auth ----------------
    if (hasDashboardToken(req)) {
      // dashboard auth sets req.ownerId
      await new Promise((resolve, reject) =>
        requireDashboardOwner(req, res, (err) => (err ? reject(err) : resolve()))
      );
      if (res.headersSent) return;
    } else {
      // portal auth sets req.tenantId, req.portalUserId, req.portalRole, req.tenant, maybe req.ownerId
      await new Promise((resolve, reject) =>
        requirePortalUser(req, res, (err) => (err ? reject(err) : resolve()))
      );
      if (res.headersSent) return;
    }

    // ---------------- Input normalization ----------------
    const ownerId = String(req.ownerId || "").trim(); // digits if known
    const tenantId = String(req.tenantId || "").trim() || null;

    // Accept both payload styles (backwards compatible)
    const prompt = String(req.body?.prompt || "").trim();
    const textLegacy = String(req.body?.text || "").trim();
    const text = prompt || textLegacy;

    const range = String(req.body?.range || "mtd").trim(); // portal expects "mtd|wtd|ytd|today|all"
    const tz = req.tenant?.tz || "America/Toronto";

    if (!text) return res.status(400).json({ ok: false, error: "missing_prompt" });

    // ---------------- Role gate (portal only) ----------------
    // Keep this tight until monetization day ships.
    if (req.portalRole) {
      const role = String(req.portalRole || "").toLowerCase();
      const allowed = new Set(["owner", "admin", "board", "board_member"]);
      if (role && !allowed.has(role)) {
        return res.status(403).json({ ok: false, error: "permission_denied" });
      }
    }

    // ---------------- Plan gate (Option A: tenant.owner_id digits -> public.users.user_id) ----------------
    // For monetization day: safest + fastest = bill/plan is on the legacy users row keyed by digits phone.
    // Portal UUIDs do NOT join to public.users directly.
    //
    // Rule:
    // - If tenant.owner_id digits is missing => treat as NOT_LINKED (must link WhatsApp / set tenant owner).
    // - Else fetch plan from public.users where user_id = ownerDigits.
    // - Decide paid via: stripe_subscription_id OR subscription_tier/plan_key OR active trial_end / current_period_end.
    const REQUIRE_PLAN = String(process.env.ASK_CHIEF_REQUIRE_PLAN || "1") === "1"; // default ON

    if (REQUIRE_PLAN) {
      try {
        // Dashboard mode: allow for now (tomorrow). Portal mode: enforce.
        if (!req.tenantId) {
          console.info("[ASK_CHIEF_PLAN_GATE] dashboard mode (no tenantId) -> allowing");
        } else {
          const ownerDigits = String(req.ownerId || "").trim(); // set by requirePortalUser from tenant.owner_id
          console.info("[ASK_CHIEF_OWNER_DIGITS]", {
            tenantId: req.tenantId,
            ownerDigits: ownerDigits || null,
          });

          // If tenant has no owner_id digits yet, we can't bill-gate safely (and ledger scope is unclear).
          if (!ownerDigits) {
            return res.status(200).json({
              ok: false,
              code: "NOT_LINKED",
              message: "Link WhatsApp to this business before using Ask Chief.",
              actions: [
                { label: "Generate link code", href: "https://app.usechiefos.com/app/link-phone", kind: "primary" },
                { label: "How linking works", href: "https://usechiefos.com/#faq", kind: "secondary" },
              ],
            });
          }

          // Load plan from legacy users table keyed by digits (public.users.user_id is varchar digits)
          const { createClient } = require("@supabase/supabase-js");

          const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
          const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
          if (!url || !serviceKey) {
            console.warn("[ASK_CHIEF_PLAN_GATE] missing supabase env in backend");
            return res.status(500).json({
              ok: false,
              code: "ERROR",
              message: "Server misconfigured (supabase).",
            });
          }

          const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

          const u = await supabase
            .from("users")
            .select(
              "user_id, plan_key, subscription_tier, stripe_subscription_id, stripe_price_id, current_period_end, trial_end, cancel_at_period_end, sub_status"
            )
            .eq("user_id", ownerDigits)
            .maybeSingle();

          const userRow = u?.data || null;

          // If we can't find the legacy user row for the owner digits, treat as NOT_LINKED (fail closed).
          if (!userRow?.user_id) {
            return res.status(200).json({
              ok: false,
              code: "NOT_LINKED",
              message:
                "This business isn’t fully linked to an owner phone yet. Link WhatsApp to continue.",
              actions: [
                { label: "Generate link code", href: "https://app.usechiefos.com/app/link-phone", kind: "primary" },
                { label: "How linking works", href: "https://usechiefos.com/#faq", kind: "secondary" },
              ],
            });
          }

          // Normalize plan signals
          const planKey = String(userRow.plan_key || "").toLowerCase().trim();
          const tier = String(userRow.subscription_tier || "").toLowerCase().trim();
          const subId = String(userRow.stripe_subscription_id || "").trim();
          const status = String(userRow.sub_status || "").toLowerCase().trim();

          const now = Date.now();

          // Trial support: treat trial_end in future as enabled
          const trialEnd = userRow.trial_end ? new Date(userRow.trial_end).getTime() : 0;
          const onTrial = trialEnd && trialEnd > now;

          // Period support: treat current_period_end in future as enabled
          const periodEnd = userRow.current_period_end ? new Date(userRow.current_period_end).getTime() : 0;
          const inPeriod = periodEnd && periodEnd > now;

          // Decide "enabled"
          const looksPaid =
            onTrial ||
            inPeriod ||
            (!!subId && status !== "canceled" && status !== "cancelled") ||
            ["starter", "pro", "beta", "paid"].includes(planKey) ||
            ["starter", "pro"].includes(tier);

          if (!looksPaid) {
            return res.status(200).json({
              ok: false,
              code: "PLAN_REQUIRED",
              message: "Ask Chief unlocks on Starter.",
              required_plan: "starter",
              upgrade_url: "https://app.usechiefos.com/app/settings/billing",
            });
          }
          // ✅ keep for agent plan gating
              req.ownerProfile = userRow;
              
          console.info("[ASK_CHIEF_PLAN_GATE]", {
            tenantId: req.tenantId,
            ownerDigits,
            planKey: planKey || null,
            tier: tier || null,
            hasSub: !!subId,
            onTrial: !!onTrial,
            inPeriod: !!inPeriod,
          });
        }
      } catch (e) {
        console.warn("[ASK_CHIEF_PLAN_GATE] failed:", e?.message);
        // Fail closed (monetization/security)
        return res.status(500).json({ ok: false, code: "ERROR", message: "Plan check failed." });
      }
    }

    // ---------------- Execute Brain ----------------
    const actorKey = String(req.portalUserId || "").trim() || ownerId || "portal";

// ✅ Conversational path: Agent (tool-aware)
// (This will still fall back to RAG/menu if LLM key missing.)
const agentReply = await runAgent({
  fromPhone: null,
  ownerId: ownerId || null,
  text,
  topicHints: ["portal", "askchief"],
  ownerProfile: req.ownerProfile || null,
});

// Keep response contract stable for portal UI
return res.json({
  ok: true,
  answer: String(agentReply || "").trim() || "Done.",
  meta: {
    channel: tenantId ? "portal" : "dashboard",
    tenantId,
    range,
    tz,
    actorKey,
  },
});
  } catch (e) {
    console.error("[ASK_CHIEF] failed:", e?.message);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

module.exports = router;
